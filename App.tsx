
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Square, Bluetooth, Thermometer, AlertCircle, Terminal, RotateCcw, Loader2, Signal, Undo2, X, Download, Upload, FileInput, Usb, Bug, Wifi } from 'lucide-react';
import RoastChart from './components/RoastChart';
import StatCard from './components/StatCard';
import { TC4BluetoothService } from './services/bluetoothService';
import { TC4SerialService } from './services/serialService';
import { WebSocketService } from './services/websocketService';
import { DataPoint, RoastStatus, RoastEvent } from './types';

const bluetoothService = new TC4BluetoothService();
const serialService = new TC4SerialService();
const websocketService = new WebSocketService();

const ROR_CONFIG = {
  earlyWindowSeconds: 30,
  stableWindowSeconds: 50,
  minSpanSeconds: 8,
  minPoints: 5,
  smoothingAlpha: 0.35,
  deadband: 0.15,
  clampMin: -40,
  clampMax: 90,
};

type TimeValuePoint = { time: number; value: number };

// --- Utility: Linear Regression for Slope Calculation (Artisan Algorithm) ---
// Calculates the slope of the best-fit line through the data points using Least Squares.
// Returns slope (rate of change per unit time).
function calculateSlope(data: {time: number, value: number}[]): number {
  const n = data.length;
  if (n < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (const point of data) {
    sumX += point.time;
    sumY += point.value;
    sumXY += point.time * point.value;
    sumXX += point.time * point.time;
  }

  const denominator = (n * sumXX - sumX * sumX);
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

function getRoRLookbackWindow(currentTime: number): number {
  return currentTime < 120 ? ROR_CONFIG.earlyWindowSeconds : ROR_CONFIG.stableWindowSeconds;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeRawRoR(points: TimeValuePoint[]): number {
  if (points.length < ROR_CONFIG.minPoints) return 0;

  const span = points[points.length - 1].time - points[0].time;
  if (span < ROR_CONFIG.minSpanSeconds) return 0;

  const slope = calculateSlope(points);
  return slope * 60;
}

function smoothRoR(previous: number, raw: number): number {
  if (previous === 0) return raw;
  return previous * (1 - ROR_CONFIG.smoothingAlpha) + raw * ROR_CONFIG.smoothingAlpha;
}

function normalizeRoR(value: number): number {
  const clipped = clamp(value, ROR_CONFIG.clampMin, ROR_CONFIG.clampMax);
  const withDeadband = Math.abs(clipped) < ROR_CONFIG.deadband ? 0 : clipped;
  return parseFloat(withDeadband.toFixed(1));
}

// --- Utility: Batch Calculate RoR for Imported Data ---
// Uses dynamic lookback + EMA smoothing for better stability.
function recalculateRoR(data: DataPoint[]): DataPoint[] {
    let smoothedBT = 0;
    let smoothedET = 0;

    return data.map((point, index) => {
        const currentTime = point.time;
        const lookbackWindow = getRoRLookbackWindow(currentTime);

        const windowData = data
          .slice(Math.max(0, index - 180), index + 1)
          .filter(d => d.time > currentTime - lookbackWindow && d.time <= currentTime);

        const rawBT = computeRawRoR(windowData.map(d => ({ time: d.time, value: d.bt })));
        const rawET = computeRawRoR(windowData.map(d => ({ time: d.time, value: d.et })));

        smoothedBT = smoothRoR(smoothedBT, rawBT);
        smoothedET = smoothRoR(smoothedET, rawET);

        return {
          ...point,
          ror: normalizeRoR(smoothedBT),
          et_ror: normalizeRoR(smoothedET)
        };
    });
}

// --- Utility: Parse Roast Log (Shared Logic) ---
const parseRoastLog = (content: string, fileName: string): { data: DataPoint[], events: RoastEvent[] } => {
    let parsedData: DataPoint[] = [];
    let parsedEvents: RoastEvent[] = [];

    if (fileName.endsWith('.json') || fileName.endsWith('.alog')) {
        // JSON / ALOG Parsing
        const json = JSON.parse(content);
        
        // Support standard Artisan "timex", "temp1" (ET/BT), "temp2" (BT) structure
        let btArray: number[] = [];
        let etArray: number[] = [];
        let timeArray: number[] = [];

        // 1. Try to extract Temperature Arrays
        if (json.temps) {
            // Older or detailed format
            btArray = json.temps.Bean || json.temps.bean || [];
            etArray = json.temps.Environment || json.temps.environment || [];
            if (json.temps.x) timeArray = json.temps.x;
        } else {
            // Root level structure (Common in newer Artisan exports)
            btArray = json.temp2 || json.Bean || [];
            etArray = json.temp1 || json.Environment || [];
        }

        // 2. Try to extract Time Array
        if (json.timex && Array.isArray(json.timex)) {
            timeArray = json.timex;
        } else if (json.time && Array.isArray(json.time)) {
            timeArray = json.time;
        }

        // 3. Fallback: If no time, generate from index
        if (!timeArray || timeArray.length === 0) {
            if (btArray.length > 0) {
                const interval = json.samplinginterval || 3.0;
                timeArray = btArray.map((_: any, i: number) => i * interval);
            } else if (json.data && Array.isArray(json.data)) {
                // Legacy format support
                parsedData = json.data;
                parsedEvents = json.events || [];
            }
        }

        // 4. Construct DataPoints if we parsed arrays
        if (parsedData.length === 0 && btArray.length > 0) {
            const len = Math.min(btArray.length, timeArray.length);
            for(let i = 0; i < len; i++) {
                parsedData.push({
                    time: timeArray[i],
                    bt: btArray[i],
                    et: etArray[i] || 0,
                    ror: 0,
                    et_ror: 0
                });
            }
        }

        // 5. Extract Events (Try 'computed' first for standard events)
        if (json.computed) {
            const c = json.computed;
            const eventMapping: {[key:string]: string} = {
                'CHARGE_BT': '入豆',
                'TP_time': '回温点',
                'DRY_time': '脱水结束',
                'FCs_time': '一爆开始',
                'FCe_time': '一爆结束',
                'SCs_time': '二爆开始',
                'SCe_time': '二爆结束',
                'DROP_time': '下豆'
            };

            for (const [key, label] of Object.entries(eventMapping)) {
                    if (c[key] !== undefined && c[key] > 0) {
                        if (key.endsWith('_time')) {
                            const t = c[key];
                            const closest = parsedData.reduce((prev, curr) => 
                                Math.abs(curr.time - t) < Math.abs(prev.time - t) ? curr : prev
                            , parsedData[0]);
                            
                            parsedEvents.push({ time: t, label: label, temp: closest.bt });
                        }
                        else if (key === 'CHARGE_BT') {
                            parsedEvents.push({ time: 0, label: label, temp: c[key] });
                        }
                    }
            }
        }

    } else if (fileName.endsWith('.csv')) {
        // CSV Parsing
        const lines = content.split(/\r?\n/);
        
        // 1. Detect Header Line (Look for 'Time' or 'BT')
        let headerIdx = -1;
        for (let i = 0; i < Math.min(lines.length, 20); i++) {
            const lower = lines[i].toLowerCase();
            if (lower.includes('time') && (lower.includes('bt') || lower.includes('bean') || lower.includes('temp'))) {
                headerIdx = i;
                break;
            }
        }
        if (headerIdx === -1) throw new Error("CSV 中未找到表头 (Time/BT)");

        // 2. Detect Delimiter (comma, semicolon, tab)
        const headerLine = lines[headerIdx];
        const commaCount = (headerLine.match(/,/g) || []).length;
        const semiCount = (headerLine.match(/;/g) || []).length;
        const tabCount = (headerLine.match(/\t/g) || []).length;
        
        let delimiter = ',';
        if (tabCount > commaCount && tabCount > semiCount) delimiter = '\t';
        else if (semiCount > commaCount) delimiter = ';';

        const headers = headerLine.split(delimiter).map(h => h.trim().toLowerCase());
        
        const timeIdx = headers.findIndex(h => h.startsWith('time'));
        // BT usually 'BT', 'Bean', 'Temp2'
        const btIdx = headers.findIndex(h => h === 'bt' || h.includes('bean') || h === 'temp2');
        // ET usually 'ET', 'Env', 'Temp1'
        const etIdx = headers.findIndex(h => h === 'et' || h.includes('env') || h === 'temp1');
        const eventIdx = headers.findIndex(h => h.includes('event') || h.includes('事件'));

        if (btIdx === -1) throw new Error("CSV 中未找到豆温(BT)列");

        for(let i = headerIdx + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(delimiter);
            
            // Handle Time
            let timeVal = 0;
            if (timeIdx !== -1) {
                const tStr = parts[timeIdx].trim();
                if (tStr.includes(':')) {
                    // mm:ss format
                    const [m, s] = tStr.split(':').map(Number);
                    timeVal = (m * 60) + (s || 0);
                } else {
                    timeVal = parseFloat(tStr);
                }
            } else {
                // Fallback time if no column
                timeVal = i - headerIdx; 
            }

            const btVal = parseFloat(parts[btIdx]);
            const etVal = etIdx !== -1 ? parseFloat(parts[etIdx]) : 0;

            if (!isNaN(btVal)) {
                parsedData.push({
                    time: isNaN(timeVal) ? 0 : timeVal,
                    bt: btVal,
                    et: isNaN(etVal) ? 0 : etVal,
                    ror: 0, 
                    et_ror: 0
                });

                // Handle Event
                if (eventIdx !== -1 && parts[eventIdx]) {
                    const evtLabel = parts[eventIdx].trim();
                    if (evtLabel) {
                        // Map English labels to Chinese if needed
                        const labelMap: any = { 'CHARGE': '入豆', 'DRY END': '脱水结束', 'FC START': '一爆开始', 'FC END': '一爆结束', 'DROP': '下豆', 'TP': '回温点' };
                        const finalLabel = labelMap[evtLabel.toUpperCase()] || evtLabel;
                        parsedEvents.push({
                            time: timeVal,
                            label: finalLabel,
                            temp: btVal
                        });
                    }
                }
            }
        }
    } else {
        throw new Error("不支持的文件格式");
    }

    if (parsedData.length === 0) throw new Error("文件为空或解析失败");

    // Post-process: Recalculate RoR
    const processedData = recalculateRoR(parsedData);
    return { data: processedData, events: parsedEvents };
}


const App: React.FC = () => {
  const [status, setStatus] = useState<RoastStatus>(RoastStatus.IDLE);
  const [data, setData] = useState<DataPoint[]>([]);
  const [events, setEvents] = useState<RoastEvent[]>([]);
  
  // Background Data (Reference Curve)
  const [backgroundData, setBackgroundData] = useState<DataPoint[]>([]);
  const [backgroundEvents, setBackgroundEvents] = useState<RoastEvent[]>([]);

  const [startTime, setStartTime] = useState<number | null>(null);
  
  // Instant values for display. Initialized to 0.
  const [currentBT, setCurrentBT] = useState<number>(0);
  const [currentET, setCurrentET] = useState<number>(0);
  const [currentRoR, setCurrentRoR] = useState<number>(0.0);
  const [currentETRoR, setCurrentETRoR] = useState<number>(0.0);

  // New State: Track if we have received real data to prevent false positives on logic
  const [hasReceivedFirstData, setHasReceivedFirstData] = useState(false);

  // Debugging
  const [showRawLog, setShowRawLog] = useState(false);
  const [rawLogs, setRawLogs] = useState<string[]>([]);
  const rawLogsRef = useRef<string[]>([]);

  // Refs for stable access inside intervals without triggering re-renders. Initialized to 0.
  const btRef = useRef(0);
  const etRef = useRef(0);
  const dataRef = useRef<DataPoint[]>([]);
  const recentBtHistoryRef = useRef<TimeValuePoint[]>([]);
  const recentEtHistoryRef = useRef<TimeValuePoint[]>([]);
  const smoothedRoRRef = useRef<{ bt: number; et: number }>({ bt: 0, et: 0 });
  const lastSensorUpdateRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);

  // Connection State
  const [isConnecting, setIsConnecting] = useState(false);
  const [activeService, setActiveService] = useState<'bluetooth' | 'serial' | 'websocket' | 'simulation' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  // Simulation
  const [isSimulating, setIsSimulating] = useState(false);
  const simulationIntervalRef = useRef<number | null>(null);

  // Undo Drop State
  const [showUndoDrop, setShowUndoDrop] = useState(false);
  const undoTimerRef = useRef<number | null>(null);

  // Export Modal State
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportFileName, setExportFileName] = useState("");
  
  // Mobile Event Panel State
  const [isMobileEventsExpanded, setIsMobileEventsExpanded] = useState(false);

  const handleDataUpdate = useCallback((bt: number, et: number) => {
    // Update Refs for logic
    btRef.current = bt;
    etRef.current = et;
    lastSensorUpdateRef.current = Date.now();
    // Update State for UI
    setCurrentBT(bt);
    setCurrentET(et);
    setHasReceivedFirstData(true);
  }, []);

  const handleRawData = useCallback((raw: string) => {
      // Append to raw logs for debugging
      const timestamp = new Date().toLocaleTimeString().split(' ')[0];
      const logLine = `[${timestamp}] ${raw.trim()}`;
      
      // Limit log size to last 50 lines to prevent memory issues
      rawLogsRef.current = [logLine, ...rawLogsRef.current].slice(0, 50);
      setRawLogs([...rawLogsRef.current]);
  }, []);

  const handleDisconnect = useCallback(() => {
     setStatus(RoastStatus.IDLE);
     setIsSimulating(false);
     setDeviceName(null);
     setActiveService(null);
     setErrorMsg("设备连接已断开");
     setHasReceivedFirstData(false);
     
     // Reset values to 0 on disconnect
     setCurrentBT(0);
     setCurrentET(0);
     setCurrentRoR(0);
     setCurrentETRoR(0);
     btRef.current = 0;
     etRef.current = 0;
     recentBtHistoryRef.current = [];
     recentEtHistoryRef.current = [];
     smoothedRoRRef.current = { bt: 0, et: 0 };
     lastSensorUpdateRef.current = 0;
  }, []);

  // Handlers
  const handleBluetoothConnect = async () => {
    setIsConnecting(true);
    setRawLogs([]);
    rawLogsRef.current = [];
    
    try {
      setErrorMsg(null);
      // Now passing handleRawData to service
      const name = await bluetoothService.connect(handleDataUpdate, handleDisconnect, handleRawData);
      setDeviceName(name);
      setActiveService('bluetooth');
      setStatus(RoastStatus.CONNECTED);
    } catch (err: any) {
      setErrorMsg(err.message || "蓝牙连接失败。请检查设备电源和配对状态。");
      console.error(err);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleSerialConnect = async () => {
      setIsConnecting(true);
      setRawLogs([]);
      rawLogsRef.current = [];
      
      // Prompt for Baud Rate
      let baudRate = 115200;
      const input = window.prompt("请输入波特率 (Baud Rate)\n默认: 115200 (TC4/Artisan)\nHC-05/06: 9600 \n其他: 57600, 38400", "115200");
      
      if (input === null) {
          setIsConnecting(false);
          return;
      }
      
      const parsed = parseInt(input.trim(), 10);
      if (!isNaN(parsed) && parsed > 0) {
          baudRate = parsed;
      } else {
          setErrorMsg("无效的波特率");
          setIsConnecting(false);
          return;
      }

      try {
        setErrorMsg(null);
        // Now passing handleRawData to service
        const name = await serialService.connect(handleDataUpdate, handleDisconnect, baudRate, handleRawData);
        setDeviceName(name);
        setActiveService('serial');
        setStatus(RoastStatus.CONNECTED); 
      } catch (err: any) {
        setErrorMsg(err.message || "串口连接失败。");
        console.error(err);
      } finally {
        setIsConnecting(false);
      }
  };

  const handleWebSocketConnect = async () => {
    setIsConnecting(true);
    setRawLogs([]);
    rawLogsRef.current = [];

    const defaultUrl = "localhost:8080";
    const input = window.prompt("请输入 WebSocket 地址\nArtisan 默认端口: 8080", defaultUrl);

    if (input === null) {
        setIsConnecting(false);
        return;
    }

    const url = input.trim();

    try {
        setErrorMsg(null);
        const name = await websocketService.connect(
            url, 
            handleDataUpdate, 
            handleDisconnect, 
            handleRawData,
            (msg) => setErrorMsg(msg)
        );
        setDeviceName(name);
        setActiveService('websocket');
        setStatus(RoastStatus.CONNECTED); 
    } catch (err: any) {
        setErrorMsg(err.message || "WebSocket 连接失败");
    } finally {
        setIsConnecting(false);
    }
  };

  const handleStartRoast = () => {
    if (status !== RoastStatus.CONNECTED) {
      setErrorMsg("请先连接设备，再开始烘焙");
      setTimeout(() => setErrorMsg(null), 2500);
      return;
    }

    const now = Date.now();
    setStartTime(now);
    lastSensorUpdateRef.current = now;
    
    // Reset Data but KEEP background data
    setData([]);
    dataRef.current = [];
    recentBtHistoryRef.current = [];
    recentEtHistoryRef.current = [];
    smoothedRoRRef.current = { bt: 0, et: 0 };
    
    setEvents([]);
    setStatus(RoastStatus.ROASTING);
    
    // Add START event manually since startTime state update is async
    const startEvent: RoastEvent = { time: 0, label: "开始", temp: btRef.current };
    setEvents([startEvent]);
  };

  const handleStopRoast = () => {
    setStatus(RoastStatus.FINISHED);
    handleEvent("下豆"); // Drop is a one-time final event

    // Trigger Undo UI
    setShowUndoDrop(true);
    
    // Auto hide undo after 5 seconds
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = window.setTimeout(() => {
        setShowUndoDrop(false);
    }, 5000);
  };

  const handleUndoDrop = () => {
    // 1. Clear timeout
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    
    // 2. Hide UI
    setShowUndoDrop(false);

    // 3. Revert Status (Resume Roasting)
    // The useEffect dependent on [status] will pick up where it left off
    setStatus(RoastStatus.ROASTING);

    // 4. Remove the "下豆" event
    setEvents(prev => {
        // Filter out the last event if it is "下豆"
        // Or strictly filter by label, but strictly speaking we just want to undo the last action
        const newEvents = [...prev];
        if (newEvents.length > 0 && newEvents[newEvents.length - 1].label === "下豆") {
            newEvents.pop();
        }
        return newEvents;
    });
  };

  const handleReset = async () => {
    // Clear any pending undo
    setShowUndoDrop(false);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);

    // If still connected (not IDLE), go to CONNECTED (was preheating). If IDLE, stay IDLE.
    if (status !== RoastStatus.IDLE) {
        setStatus(RoastStatus.CONNECTED);
    }
    
    setData([]);
    dataRef.current = [];
    recentBtHistoryRef.current = [];
    recentEtHistoryRef.current = [];
    smoothedRoRRef.current = { bt: 0, et: 0 };
    setEvents([]);
    setStartTime(null);
    setCurrentRoR(0);
    setCurrentETRoR(0);
    
    // Optional: Clear background on reset? Maybe keep it.
    // setBackgroundData([]); 
  };

  // Close connections on unmount (cleanup)
  useEffect(() => {
      return () => {
          bluetoothService.disconnect();
          serialService.disconnect();
          websocketService.disconnect();
      }
  }, []);

  // Keep mobile event panel compact outside roasting mode
  useEffect(() => {
    if (status !== RoastStatus.ROASTING) {
      setIsMobileEventsExpanded(false);
    }
  }, [status]);

  const handleEvent = (label: string) => {
    if (status !== RoastStatus.ROASTING || !startTime) return;
    const time = Math.max(0, (Date.now() - startTime) / 1000);
    setEvents(prev => [...prev, { time, label, temp: btRef.current }]);
  };

  // Toggle Event: If exists, remove it (Undo). If not, add it.
  const handleToggleEvent = (label: string) => {
    if (status !== RoastStatus.ROASTING || !startTime) return;

    const exists = events.some(e => e.label === label);

    if (exists) {
        // Remove (Undo)
        setEvents(prev => prev.filter(e => e.label !== label));
    } else {
        // Add
        const time = Math.max(0, (Date.now() - startTime) / 1000);
        setEvents(prev => [...prev, { time, label, temp: btRef.current }]);
    }
  };

  // --- Export Logic (CSV) ---
  const handleOpenExportModal = () => {
      if (data.length === 0) {
          setErrorMsg("没有数据可导出");
          setTimeout(() => setErrorMsg(null), 3000);
          return;
      }
      const now = new Date();
      // Default name: roast_YYYYMMDD_HHMM
      const defaultName = `roast_${now.toISOString().slice(0,10).replace(/-/g,'')}_${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}`;
      setExportFileName(defaultName);
      setIsExportModalOpen(true);
  };

  const handleConfirmExport = (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      setIsExportModalOpen(false);

      const now = new Date();
      const dateStr = now.toLocaleDateString('en-GB').replace(/\//g, '.'); // dd.mm.yyyy format

      // 1. Build Header Metadata
      // Artisan CSV often has header like: Date:.. Unit:C CHARGE:.. TP:..
      let headerLine = `Date:${dateStr}\tUnit:C`;
      
      const labelMap: {[key:string]: string} = { 
          '入豆': 'CHARGE', '脱水结束': 'DRYe', 
          '一爆开始': 'FCs', '一爆结束': 'FCe', 
          '二爆开始': 'SCs', '二爆结束': 'SCe', 
          '下豆': 'DROP', '回温点': 'TP'
      };

      // Find Charge Time for Time2 calculation
      const chargeEvent = events.find(e => e.label === '入豆');
      const chargeTime = chargeEvent ? chargeEvent.time : 0;

      // Add events to header
      events.forEach(e => {
          const key = labelMap[e.label];
          if (key) {
              headerLine += `\t${key}:${formatTime(e.time * 1000)}`;
          }
      });
      // Add Total Duration
      headerLine += `\tTime:${getDuration()}\n`;

      // 2. Column Headers
      // Artisan uses Time1 (total), Time2 (since charge), ET, BT, Event
      const columns = `Time1\tTime2\tET\tBT\tEvent\n`;

      // 3. Build Rows
      let rows = '';
      data.forEach(d => {
          const time1Str = formatTime(d.time * 1000);
          
          let time2Str = '';
          if (chargeEvent && d.time >= chargeTime) {
              time2Str = formatTime((d.time - chargeTime) * 1000);
          } else {
              time2Str = ''; // Or keep empty
          }

          // Check for event at this timestamp (fuzzy match < 0.5s)
          const matchingEvent = events.find(e => Math.abs(e.time - d.time) < 0.5);
          const eventLabel = matchingEvent 
              ? (labelMap[matchingEvent.label] || matchingEvent.label) 
              : '';

          // Format values (Artisan typically allows dots for decimals in CSV if tab separated)
          const etVal = d.et.toFixed(2);
          const btVal = d.bt.toFixed(2);

          rows += `${time1Str}\t${time2Str}\t${etVal}\t${btVal}\t${eventLabel}\n`;
      });

      const csvContent = headerLine + columns + rows;

      // 4. Trigger Download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      const finalName = exportFileName.trim() || `roast_${now.toISOString().slice(0,10).replace(/-/g,'')}`;
      link.setAttribute('download', `${finalName}.csv`);
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setSuccessMsg("导出成功");
      setTimeout(() => setSuccessMsg(null), 3000);
  };

  // --- Import Logic ---
  const handleImportClick = () => {
      if (fileInputRef.current) fileInputRef.current.click();
  };

  const handleBackgroundClick = () => {
      if (backgroundInputRef.current) backgroundInputRef.current.click();
  };

  const handleImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      processImport(file, false);
  };

  const handleBackgroundFile = (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      processImport(file, true);
  };

  const processImport = (file: File, isBackground: boolean) => {
      const reader = new FileReader();
      reader.onload = (e) => {
          const content = e.target?.result as string;
          try {
              const { data: parsedData, events: parsedEvents } = parseRoastLog(content, file.name);

              if (isBackground) {
                   setBackgroundData(parsedData);
                   setBackgroundEvents(parsedEvents);
                   setSuccessMsg(`已加载背景曲线: ${file.name}`);
              } else {
                   // Standard Import Mode
                   // 1. Stop simulations if any
                   if (isSimulating) toggleSimulation();
                   
                   // 2. Set State
                   setData(parsedData);
                   dataRef.current = parsedData; // Sync ref
                   recentBtHistoryRef.current = [];
                   recentEtHistoryRef.current = [];
                   setEvents(parsedEvents);
                   setStatus(RoastStatus.FINISHED); // View mode
                   setStartTime(null); // Static
                   
                   // 3. Update Display Values to end of roast
                   if (parsedData.length > 0) {
                       const last = parsedData[parsedData.length - 1];
                       setCurrentBT(last.bt);
                       setCurrentET(last.et);
                       setCurrentRoR(last.ror);
                       setCurrentETRoR(last.et_ror || 0);
                       smoothedRoRRef.current = { bt: last.ror, et: last.et_ror || 0 };
                       btRef.current = last.bt;
                       etRef.current = last.et;
                   }
                   setSuccessMsg(`成功导入: ${file.name}`);
              }

          } catch (err: any) {
              console.error("Import error", err);
              setErrorMsg((isBackground ? "背景加载失败: " : "导入失败: ") + (err.message || "文件格式错误"));
          } finally {
              // Reset inputs
              if (fileInputRef.current) fileInputRef.current.value = "";
              if (backgroundInputRef.current) backgroundInputRef.current.value = "";
          }
      };
      reader.readAsText(file);
  }

  // RoR Calculation and Data Recording
  useEffect(() => {
    if (status !== RoastStatus.ROASTING || !startTime) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const currentTime = (now - startTime) / 1000;
      const currentBTVal = btRef.current;
      const currentETVal = etRef.current;

      // Prevent stale points from distorting RoR if sensor stream pauses.
      if (!isSimulating && hasReceivedFirstData && lastSensorUpdateRef.current > 0) {
        const staleMs = now - lastSensorUpdateRef.current;
        if (staleMs > 4000) {
          return;
        }
      }

      // Wait for first real packet before recording live roast (except simulation).
      if (!isSimulating && !hasReceivedFirstData) {
        return;
      }

      const lookbackWindow = getRoRLookbackWindow(currentTime);

      recentBtHistoryRef.current.push({ time: currentTime, value: currentBTVal });
      recentEtHistoryRef.current.push({ time: currentTime, value: currentETVal });

      while (recentBtHistoryRef.current.length > 0 && recentBtHistoryRef.current[0].time < currentTime - lookbackWindow) {
        recentBtHistoryRef.current.shift();
      }
      while (recentEtHistoryRef.current.length > 0 && recentEtHistoryRef.current[0].time < currentTime - lookbackWindow) {
        recentEtHistoryRef.current.shift();
      }

      const rawRoR = computeRawRoR(recentBtHistoryRef.current);
      const rawETRoR = computeRawRoR(recentEtHistoryRef.current);

      const smoothedBT = smoothRoR(smoothedRoRRef.current.bt, rawRoR);
      const smoothedET = smoothRoR(smoothedRoRRef.current.et, rawETRoR);

      const finalRoR = normalizeRoR(smoothedBT);
      const finalETRoR = normalizeRoR(smoothedET);

      smoothedRoRRef.current = { bt: finalRoR, et: finalETRoR };

      // Update UI
      setCurrentRoR(finalRoR);
      setCurrentETRoR(finalETRoR);

      // Create new DataPoint
      const newDataPoint: DataPoint = { 
        time: currentTime, 
        bt: currentBTVal, 
        et: currentETVal, 
        ror: finalRoR,
        et_ror: finalETRoR
      };

      // Update Ref
      dataRef.current = [...dataRef.current, newDataPoint];
      
      // Update State (triggers chart re-render)
      setData(dataRef.current);

    }, 1000);

    return () => clearInterval(interval);
  }, [status, startTime, hasReceivedFirstData, isSimulating]);

  // Simulation Logic
  const toggleSimulation = () => {
    if (isSimulating) {
        setIsSimulating(false);
        if (simulationIntervalRef.current) clearInterval(simulationIntervalRef.current);
        setStatus(RoastStatus.IDLE);
        setActiveService(null);
        setDeviceName(null);
    } else {
        setIsSimulating(true);
        setActiveService('simulation');
        setStatus(RoastStatus.CONNECTED); // Start Connected
        setDeviceName("模拟烘焙机 (Demo)");
        
        // Init physics vars
        let simBt = 150;
        let simEt = 200;
        btRef.current = simBt;
        etRef.current = simEt;
        lastSensorUpdateRef.current = Date.now();
        setCurrentBT(simBt);
        setCurrentET(simEt);
        
        simulationIntervalRef.current = window.setInterval(() => {
            // Physics simulation
            const targetET = 240; 
            simEt += (targetET - simEt) * 0.05 + (Math.random() - 0.5);
            const delta = simEt - simBt;
            simBt += delta * 0.02; // Thermal mass

            // Update Refs
            btRef.current = parseFloat(simBt.toFixed(1));
            etRef.current = parseFloat(simEt.toFixed(1));
            lastSensorUpdateRef.current = Date.now();

            // Update UI
            setCurrentBT(btRef.current);
            setCurrentET(etRef.current);
        }, 1000);
    }
  };

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getDuration = () => {
     if (status === RoastStatus.ROASTING && startTime) return formatTime(Date.now() - startTime);
     if (startTime && data.length > 0) return formatTime(data[data.length-1].time * 1000);
     if (data.length > 0 && status === RoastStatus.FINISHED) return formatTime(data[data.length-1].time * 1000);
     return "00:00";
  }

  // Helper to check if event exists
  const hasEvent = (label: string) => events.some(e => e.label === label);

  // Define event buttons config
  const eventButtons = [
    { 
        label: "入豆", // Charge
        baseColor: "green",
        bgClass: "bg-emerald-600",
        borderClass: "border-emerald-500 text-emerald-400",
        action: () => handleToggleEvent("入豆"),
        disabled: false 
    },
    { 
        label: "脱水结束", // Dry End
        baseColor: "yellow",
        bgClass: "bg-amber-600",
        borderClass: "border-amber-500 text-amber-400",
        action: () => handleToggleEvent("脱水结束"),
        disabled: !hasEvent("入豆") 
    },
    { 
        label: "一爆开始", // FC Start
        baseColor: "red",
        bgClass: "bg-red-600",
        borderClass: "border-red-500 text-red-400",
        action: () => handleToggleEvent("一爆开始"),
        disabled: !hasEvent("入豆")
    },
    { 
        label: "一爆结束", // FC End
        baseColor: "red",
        bgClass: "bg-red-800",
        borderClass: "border-red-700 text-red-500",
        action: () => handleToggleEvent("一爆结束"),
        disabled: !hasEvent("一爆开始")
    },
    { 
        label: "二爆开始", // SC Start
        baseColor: "cyan",
        bgClass: "bg-cyan-700",
        borderClass: "border-cyan-600 text-cyan-400",
        action: () => handleToggleEvent("二爆开始"),
        disabled: !hasEvent("入豆")
    },
    { 
        label: "二爆结束", // SC End
        baseColor: "cyan",
        bgClass: "bg-cyan-900",
        borderClass: "border-cyan-800 text-cyan-600",
        action: () => handleToggleEvent("二爆结束"),
        disabled: !hasEvent("二爆开始")
    },
  ];

  const primaryMobileEventButtons = eventButtons.slice(0, 3);
  const secondaryMobileEventButtons = eventButtons.slice(3);
  const orderedEventLabels = ["入豆", "脱水结束", "一爆开始", "一爆结束", "二爆开始", "二爆结束"];
  const nextEventHint = orderedEventLabels.find(label => !hasEvent(label)) || "流程完成";

  // Logic for status color
  const getStatusColor = () => {
      if (isConnecting) return 'status-dot-connecting live-pulse';
      if (status !== RoastStatus.IDLE) return 'status-dot-online'; // Green for Connected/Roasting
      return 'status-dot-offline';
  };

  const getStatusText = () => {
      if (isConnecting) return '正在连接...';
      if (status === RoastStatus.IDLE) return '未连接';
      return '设备在线';
  };

  const getModeText = () => {
      if (activeService === 'bluetooth') return 'Bluetooth LE';
      if (activeService === 'serial') return 'Serial/SPP';
      if (activeService === 'websocket') return 'WebSocket';
      if (activeService === 'simulation') return 'Simulation';
      return '未知';
  };

  return (
    <div className="app-shell h-[100dvh] w-full flex flex-col text-[#e6edf3]">
      
      {/* Hidden File Inputs */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleImportFile} 
        className="hidden" 
        accept=".json,.alog,.csv"
      />
      <input 
        type="file" 
        ref={backgroundInputRef} 
        onChange={handleBackgroundFile} 
        className="hidden" 
        accept=".json,.alog,.csv"
      />

      {/* EXPORT MODAL */}
      {isExportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="panel-surface border rounded-lg shadow-2xl w-full max-w-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-[#2f3944] flex justify-between items-center bg-[#252f3a]/80">
                    <span className="font-bold text-gray-200 flex items-center gap-2">
                        <Download size={16} /> 导出记录
                    </span>
                    <button onClick={() => setIsExportModalOpen(false)} className="text-gray-500 hover:text-gray-300">
                        <X size={18} />
                    </button>
                </div>
                <form onSubmit={handleConfirmExport} className="p-4 flex flex-col gap-4">
                    <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1">文件名</label>
                        <div className="flex items-center">
                            <input 
                                type="text" 
                                value={exportFileName}
                                onChange={(e) => setExportFileName(e.target.value)}
                                className="flex-1 bg-[#111823] border border-[#3e4b5a] text-white px-3 py-2 text-sm rounded-l focus:outline-none focus:border-blue-500"
                                autoFocus
                            />
                            <div className="bg-[#28313d] border border-l-0 border-[#3e4b5a] text-gray-400 px-3 py-2 text-sm rounded-r">
                                .csv
                            </div>
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button 
                            type="button"
                            onClick={() => setIsExportModalOpen(false)}
                            className="toolbar-btn px-3 py-1.5 rounded text-sm font-bold text-gray-300"
                        >
                            取消
                        </button>
                        <button 
                            type="submit"
                            className="toolbar-btn toolbar-btn-primary px-4 py-1.5 rounded text-sm font-bold shadow-lg"
                        >
                            确认导出
                        </button>
                    </div>
                </form>
            </div>
        </div>
      )}

      {/* 1. TOP TOOLBAR */}
      <div className="top-toolbar z-10 shrink-0">
        <div className="hidden md:flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <span className="font-semibold text-lg tracking-[0.12em] text-gray-200 flex items-center gap-1.5 uppercase">
              <Thermometer className="text-orange-400 w-5 h-5" />
              <span>Web</span><span className="text-orange-400">Artisan</span>
            </span>
            <div className="h-6 w-px bg-[#445262] mx-2"></div>

            {/* Connection Status Indicator */}
            <div className="group relative flex items-center gap-1.5 text-xs font-mono tracking-[0.12em] uppercase cursor-help py-2">
              <span className={`w-3 h-3 rounded-full transition-colors duration-300 ${getStatusColor()}`}></span>
              <span className="text-[#9fb0c2] transition-colors group-hover:text-white">{getStatusText()}</span>

              {/* Tooltip Popup */}
              <div className="absolute top-full left-0 mt-1 w-52 p-2.5 bg-[#0a1119]/95 backdrop-blur border border-[#425161] rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 text-[10px] text-gray-300 transform origin-top-left">
                <div className="font-bold text-white mb-1 border-b border-[#2c3a48] pb-1 tracking-wider">系统状态</div>
                <div className="flex flex-col gap-1">
                  <div>
                    状态: <span className={status !== RoastStatus.IDLE ? 'text-green-400' : 'text-red-400'}>
                      {isConnecting ? '初始化中...' : status === RoastStatus.IDLE ? '等待连接' : '已就绪'}
                    </span>
                  </div>
                  {status !== RoastStatus.IDLE && (
                    <>
                      <div>设备: {deviceName || '未知'}</div>
                      <div>模式: {getModeText()}</div>
                      <div className="flex items-center gap-1">信号: <Signal size={10} className="text-green-500"/> 强</div>
                    </>
                  )}
                  {status === RoastStatus.IDLE && !isConnecting && (
                    <div className="text-gray-500 italic">请点击右侧按钮连接设备</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-2 items-center">
            {status === RoastStatus.ROASTING ? (
              <button
                onClick={handleStopRoast}
                className="toolbar-btn toolbar-btn-danger shrink-0 px-3 md:px-4 py-1.5 rounded font-bold text-xs md:text-sm flex items-center gap-1 shadow-[0_0_10px_rgba(207,34,46,0.35)]"
              >
                <Square size={14} className="md:w-4 md:h-4" /> 下豆
              </button>
            ) : status === RoastStatus.FINISHED ? (
              <button
                onClick={handleReset}
                className="toolbar-btn shrink-0 px-3 py-1.5 rounded font-bold text-xs md:text-sm flex items-center gap-1"
              >
                <RotateCcw size={14} className="md:w-4 md:h-4" /> 重置
              </button>
            ) : (
              <button
                onClick={handleStartRoast}
                disabled={status !== RoastStatus.CONNECTED || isConnecting}
                className={`toolbar-btn toolbar-btn-success shrink-0 px-3 md:px-4 py-1.5 rounded font-bold text-xs md:text-sm flex items-center gap-1 ${
                  status !== RoastStatus.CONNECTED || isConnecting
                    ? 'opacity-45 cursor-not-allowed shadow-none'
                    : 'shadow-[0_0_10px_rgba(45,164,78,0.35)]'
                }`}
                title={status === RoastStatus.CONNECTED ? "开始烘焙" : "连接设备后可开始"}
              >
                <Play size={14} className="md:w-4 md:h-4" /> 开始
              </button>
            )}

            <button onClick={handleOpenExportModal} className="toolbar-btn shrink-0 p-1.5 md:px-2 md:py-1.5 rounded flex items-center gap-1" title="导出 CSV">
              <Download size={14} className="md:w-4 md:h-4" />
              <span className="hidden md:inline text-xs">导出</span>
            </button>
            <button onClick={handleImportClick} className="toolbar-btn shrink-0 p-1.5 md:px-2 md:py-1.5 rounded flex items-center gap-1" title="导入 Artisan /CSV 文件查看">
              <Upload size={14} className="md:w-4 md:h-4" />
              <span className="hidden md:inline text-xs">导入</span>
            </button>
            <button onClick={handleBackgroundClick} className="toolbar-btn shrink-0 p-1.5 md:px-2 md:py-1.5 rounded flex items-center gap-1 mr-1 md:mr-2" title="加载背景曲线 (跟随烘焙)">
              <FileInput size={14} className="md:w-4 md:h-4" />
              <span className="hidden md:inline text-xs">背景</span>
            </button>

            {status === RoastStatus.IDLE && (
              <>
                <button
                  onClick={handleWebSocketConnect}
                  disabled={isConnecting}
                  className="toolbar-btn shrink-0 px-2 py-1.5 md:px-3 rounded font-bold text-xs md:text-sm flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
                  title="连接 Artisan WebSocket (WiFi)"
                >
                  {isConnecting ? (
                    <Loader2 size={14} className="animate-spin md:w-4 md:h-4" />
                  ) : (
                    <Wifi size={14} className="md:w-4 md:h-4" />
                  )}
                  <span className="hidden md:inline">{isConnecting ? '...' : 'WiFi'}</span>
                </button>

                <button
                  onClick={handleSerialConnect}
                  disabled={isConnecting}
                  className="toolbar-btn shrink-0 px-2 py-1.5 md:px-3 rounded font-bold text-xs md:text-sm flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
                  title="连接传统蓝牙(SPP)或USB串口"
                >
                  {isConnecting ? (
                    <Loader2 size={14} className="animate-spin md:w-4 md:h-4" />
                  ) : (
                    <Usb size={14} className="md:w-4 md:h-4" />
                  )}
                  <span className="hidden md:inline">{isConnecting ? '...' : '串口/SPP'}</span>
                </button>

                <button
                  onClick={handleBluetoothConnect}
                  disabled={isConnecting}
                  className="toolbar-btn toolbar-btn-primary shrink-0 px-2 py-1.5 md:px-3 rounded font-bold text-xs md:text-sm flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
                >
                  {isConnecting ? (
                    <Loader2 size={14} className="animate-spin md:w-4 md:h-4" />
                  ) : (
                    <Bluetooth size={14} className="md:w-4 md:h-4" />
                  )}
                  <span className="inline">{isConnecting ? '...' : 'BLE'}</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Mobile Toolbar */}
        <div className="md:hidden px-2 py-2 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Thermometer className="text-orange-400 w-4 h-4 shrink-0" />
              <div className="min-w-0">
                <div className="text-[11px] font-semibold tracking-[0.1em] uppercase text-gray-200 truncate">
                  Web<span className="text-orange-400">Artisan</span>
                </div>
                <div className="text-[9px] text-[#8ea0b3] font-mono truncate">
                  {status === RoastStatus.IDLE ? '设备未连接' : `${deviceName || '设备在线'} · ${getModeText()}`}
                </div>
              </div>
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${getStatusColor()}`}></span>
            </div>

            {status === RoastStatus.ROASTING ? (
              <button
                onClick={handleStopRoast}
                className="toolbar-btn toolbar-btn-danger shrink-0 px-3 py-1.5 rounded font-bold text-xs flex items-center gap-1 shadow-[0_0_8px_rgba(207,34,46,0.35)]"
              >
                <Square size={13} /> 下豆
              </button>
            ) : status === RoastStatus.FINISHED ? (
              <button
                onClick={handleReset}
                className="toolbar-btn shrink-0 px-3 py-1.5 rounded font-bold text-xs flex items-center gap-1"
              >
                <RotateCcw size={13} /> 重置
              </button>
            ) : (
              <button
                onClick={handleStartRoast}
                disabled={status !== RoastStatus.CONNECTED || isConnecting}
                className={`toolbar-btn toolbar-btn-success shrink-0 px-3 py-1.5 rounded font-bold text-xs flex items-center gap-1 ${
                  status !== RoastStatus.CONNECTED || isConnecting
                    ? 'opacity-45 cursor-not-allowed shadow-none'
                    : 'shadow-[0_0_8px_rgba(45,164,78,0.35)]'
                }`}
              >
                <Play size={13} /> 开始
              </button>
            )}
          </div>

          {status === RoastStatus.IDLE ? (
            <div className="grid grid-cols-3 gap-1.5">
              <button
                onClick={handleWebSocketConnect}
                disabled={isConnecting}
                className="toolbar-btn py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1 disabled:opacity-45"
              >
                {isConnecting ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />}
                WiFi
              </button>
              <button
                onClick={handleSerialConnect}
                disabled={isConnecting}
                className="toolbar-btn py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1 disabled:opacity-45"
              >
                {isConnecting ? <Loader2 size={12} className="animate-spin" /> : <Usb size={12} />}
                串口
              </button>
              <button
                onClick={handleBluetoothConnect}
                disabled={isConnecting}
                className="toolbar-btn toolbar-btn-primary py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1 disabled:opacity-45"
              >
                {isConnecting ? <Loader2 size={12} className="animate-spin" /> : <Bluetooth size={12} />}
                BLE
              </button>
            </div>
          ) : (
            <div className="px-2 py-1.5 rounded-md border border-[#31404f] bg-[#111823]/70 text-[10px] text-[#8ea0b3] font-mono flex items-center justify-between">
              <span className="truncate max-w-[62%]">设备: {deviceName || '未知设备'}</span>
              <span>{getStatusText()}</span>
            </div>
          )}

          <div className="grid grid-cols-3 gap-1.5">
            <button onClick={handleOpenExportModal} className="toolbar-btn py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1">
              <Download size={12} /> 导出
            </button>
            <button onClick={handleImportClick} className="toolbar-btn py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1">
              <Upload size={12} /> 导入
            </button>
            <button onClick={handleBackgroundClick} className="toolbar-btn py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1">
              <FileInput size={12} /> 背景
            </button>
          </div>
        </div>
      </div>

      {/* NOTIFICATIONS */}
      {errorMsg && (
        <div className="notice-error text-white px-4 py-2 text-xs md:text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
            <AlertCircle size={14} /> {errorMsg}
        </div>
      )}
      {successMsg && (
        <div className="notice-success text-white px-4 py-2 text-xs md:text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
            <Signal size={14} /> {successMsg}
        </div>
      )}

      {/* 2. MAIN WORKSPACE */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative min-h-0">
        
        {/* Undo Drop Toast */}
        {showUndoDrop && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-top-4 fade-in duration-300">
                <div className="panel-surface border border-[#cf4f59] rounded-md shadow-2xl p-3 flex items-center gap-3">
                    <div className="flex flex-col">
                        <span className="text-white font-bold text-sm">已下豆 (Roast Finished)</span>
                        <span className="text-gray-400 text-xs">烘焙已完成。误操作？</span>
                    </div>
                    <div className="h-6 w-px bg-gray-600/80"></div>
                    <button 
                        onClick={handleUndoDrop}
                        className="toolbar-btn toolbar-btn-danger flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded"
                    >
                        <Undo2 size={14} /> 撤销
                    </button>
                    <button 
                        onClick={() => setShowUndoDrop(false)}
                        className="text-gray-500 hover:text-gray-300"
                    >
                        <X size={16} />
                    </button>
                </div>
            </div>
        )}

        {/* DESKTOP LEFT SIDEBAR: Large LCD Displays - HIDDEN ON MOBILE */}
        <div className="
            hidden md:flex w-64 panel-surface border-r p-3 
            flex-col gap-2 overflow-y-auto shrink-0 no-scrollbar
        ">
            <div className="mb-2 pb-2 border-b border-[#31404f] text-[11px] font-semibold text-[#8ea0b3] uppercase tracking-[0.15em]">实时温度</div>
            <StatCard label="Bean Temp" value={currentBT.toFixed(1)} unit="°C" color="red" />
            <StatCard label="Env Temp" value={currentET.toFixed(1)} unit="°C" color="blue" />
            
            <div className="my-2 pb-2 border-b border-[#31404f] text-[11px] font-semibold text-[#8ea0b3] uppercase tracking-[0.15em]">温升率</div>
            <StatCard label="BT RoR" value={currentRoR.toFixed(1)} unit="°/min" color="yellow" />
            <StatCard label="ET RoR" value={currentETRoR.toFixed(1)} unit="°/min" color="cyan" />
            
            <div className="my-2 pb-2 border-b border-[#31404f] text-[11px] font-semibold text-[#8ea0b3] uppercase tracking-[0.15em]">时间</div>
            <StatCard label="TIME" value={getDuration()} color="green" />
        </div>

        {/* CENTER COLUMN: Chart + Mobile Ticker */}
        <div className="flex-1 bg-[#131920]/80 flex flex-col relative min-h-0">
            
            {/* MOBILE ONLY: Data Ticker */}
            <div className="md:hidden h-12 panel-surface border-b grid grid-cols-4 gap-1 px-1.5 py-1 shrink-0 z-10">
               <div className="rounded bg-[#0f151d]/70 border border-[#263444] flex flex-col items-center justify-center">
                  <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-wide">BT</span>
                  <span className="text-sm font-mono font-bold text-[#ff6b6b] leading-none">{currentBT.toFixed(1)}</span>
               </div>
               <div className="rounded bg-[#0f151d]/70 border border-[#263444] flex flex-col items-center justify-center">
                  <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-wide">ET</span>
                  <span className="text-sm font-mono font-bold text-[#58a6ff] leading-none">{currentET.toFixed(1)}</span>
               </div>
               <div className="rounded bg-[#0f151d]/70 border border-[#263444] flex flex-col items-center justify-center">
                  <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-wide">RoR</span>
                  <span className="text-sm font-mono font-bold text-[#ffd84d] leading-none">{currentRoR.toFixed(1)}</span>
               </div>
               <div className="rounded bg-[#0f151d]/70 border border-[#263444] flex flex-col items-center justify-center">
                  <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-wide">时间</span>
                  <span className="text-[11px] font-mono font-bold text-[#4adf8f] leading-none">{getDuration()}</span>
               </div>
            </div>

            <div className="flex-1 p-0 md:p-1 md:pb-0 relative min-h-0">
                <RoastChart 
                    data={data} 
                    events={events} 
                    currentBT={currentBT}
                    currentET={currentET}
                    currentRoR={currentRoR}
                    backgroundData={backgroundData}
                />
            </div>
        </div>

        {/* RIGHT COLUMN: Controls & Events */}
        {/* Mobile: Bottom Grid | Desktop: Right Sidebar */}
        <div className="
            w-full md:w-48 panel-surface border-t md:border-t-0 md:border-l p-2 
            flex flex-col md:flex-col gap-2 shrink-0 
            pb-safe md:pb-2 z-20
        ">
             {/* Mobile Event Layout: Primary events + expandable secondary events */}
             <div className="md:hidden flex flex-col gap-1.5 mb-safe-offset">
                 <div className="flex items-center justify-between px-0.5">
                     <div className="text-[10px] font-semibold text-[#8ea0b3] uppercase tracking-[0.14em]">事件快捷</div>
                     <div className="flex items-center gap-1.5">
                         <span className="text-[9px] text-[#6e8398] font-mono">
                           {status === RoastStatus.ROASTING ? `下一步: ${nextEventHint}` : "待机"}
                         </span>
                         <button
                           onClick={() => setIsMobileEventsExpanded(prev => !prev)}
                           className="toolbar-btn text-[9px] px-2 py-1 rounded text-gray-300"
                         >
                           {isMobileEventsExpanded ? "收起事件" : "更多事件"}
                         </button>
                     </div>
                 </div>

                 <div className="grid grid-cols-3 gap-1.5">
                     {primaryMobileEventButtons.map((btn) => {
                         const isActive = hasEvent(btn.label);

                         return (
                           <button
                             key={`${btn.label}-mobile-primary`}
                             onClick={btn.action}
                             disabled={status !== RoastStatus.ROASTING || btn.disabled}
                             className={`
                               w-full py-2.5 font-semibold text-[10px] rounded-md transition-all border select-none active:scale-95 touch-manipulation tracking-wide
                               ${status !== RoastStatus.ROASTING || btn.disabled
                                 ? 'bg-[#262e37] text-[#5d6a79] border-[#2e3844] shadow-none'
                                 : isActive
                                   ? `${btn.bgClass} text-white border-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_8px_14px_rgba(0,0,0,0.25)]`
                                   : `bg-[#1a2129]/70 ${btn.borderClass} hover:bg-[#23303d] active:bg-[#2a3644]`
                               }
                             `}
                           >
                             {btn.label}
                           </button>
                         );
                     })}
                 </div>

                 {isMobileEventsExpanded && (
                   <div className="grid grid-cols-3 gap-1.5 pt-0.5">
                     {secondaryMobileEventButtons.map((btn) => {
                       const isActive = hasEvent(btn.label);

                       return (
                         <button
                           key={`${btn.label}-mobile-secondary`}
                           onClick={btn.action}
                           disabled={status !== RoastStatus.ROASTING || btn.disabled}
                           className={`
                             w-full py-2.5 font-semibold text-[10px] rounded-md transition-all border select-none active:scale-95 touch-manipulation tracking-wide
                             ${status !== RoastStatus.ROASTING || btn.disabled
                               ? 'bg-[#262e37] text-[#5d6a79] border-[#2e3844] shadow-none'
                               : isActive
                                 ? `${btn.bgClass} text-white border-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_8px_14px_rgba(0,0,0,0.25)]`
                                 : `bg-[#1a2129]/70 ${btn.borderClass} hover:bg-[#23303d] active:bg-[#2a3644]`
                             }
                           `}
                         >
                           {btn.label}
                         </button>
                       );
                     })}
                   </div>
                 )}
             </div>

             <div className="hidden md:block text-[11px] font-semibold text-[#8ea0b3] uppercase tracking-[0.15em] mb-1 text-center">事件标记</div>
             <div className="hidden md:flex md:flex-col gap-2">
                 {eventButtons.map((btn) => {
                     const isActive = hasEvent(btn.label);

                     return (
                       <button
                         key={`${btn.label}-desktop`}
                         onClick={btn.action}
                         disabled={status !== RoastStatus.ROASTING || btn.disabled}
                         className={`
                           w-full py-3 font-semibold text-xs rounded-md transition-all border select-none active:scale-95 touch-manipulation tracking-wide
                           ${status !== RoastStatus.ROASTING || btn.disabled
                             ? 'bg-[#262e37] text-[#5d6a79] border-[#2e3844] shadow-none'
                             : isActive
                               ? `${btn.bgClass} text-white border-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_8px_14px_rgba(0,0,0,0.25)]`
                               : `bg-[#1a2129]/70 ${btn.borderClass} hover:bg-[#23303d] active:bg-[#2a3644]`
                           }
                         `}
                       >
                         {btn.label}
                       </button>
                     );
                 })}
             </div>

             {/* Event Log / Debug Terminal */}
             <div className="mt-auto border-t border-[#31404f] pt-3 hidden md:flex flex-col gap-2">
                 <div className="text-[10px] font-semibold text-[#7d8ea0] uppercase tracking-[0.12em] flex items-center justify-between px-1">
                    <span className="flex items-center gap-2">
                        {showRawLog ? <Bug size={10} className="text-orange-400" /> : <Terminal size={10} />}
                        {showRawLog ? "原始数据 (RAW)" : "事件日志 (LOG)"}
                    </span>
                    <button 
                        onClick={() => setShowRawLog(!showRawLog)} 
                        className="toolbar-btn text-[9px] px-1.5 py-0.5 rounded text-gray-300"
                        title="切换视图"
                    >
                        {showRawLog ? "查看事件" : "查看数据"}
                    </button>
                 </div>
                 
                 <div className="h-48 bg-[#0b1117]/85 border border-[#31404f] rounded-md overflow-y-auto custom-scrollbar shadow-inner relative">
                    
                    {/* View: Events List */}
                    {!showRawLog && (
                        <>
                        {events.length === 0 && (
                            <div className="absolute inset-0 flex items-center justify-center text-[#3d4b5a] text-[10px] italic">
                                等待记录...
                            </div>
                        )}
                        <div className="flex flex-col">
                            {events.map((e, i) => (
                                <div key={i} className="flex items-center justify-between p-2 border-b border-[#1a2530] hover:bg-[#122030] transition-colors group">
                                    <div className="flex flex-col">
                                        <span className="text-[#dde7f1] font-semibold text-[10px] group-hover:text-white transition-colors">
                                            {e.label}
                                        </span>
                                        <span className="text-[#5f7183] text-[9px] group-hover:text-[#8ca0b4] transition-colors font-mono">
                                            @ {e.temp.toFixed(1)}°C
                                        </span>
                                    </div>
                                    <span className="text-[#58a6ff] font-mono text-[10px] bg-[#58a6ff]/10 px-1.5 py-0.5 rounded border border-[#58a6ff]/25">
                                        {formatTime(e.time * 1000)}
                                    </span>
                                </div>
                            )).reverse()}
                        </div>
                        </>
                    )}

                    {/* View: Raw Data Log */}
                    {showRawLog && (
                        <div className="flex flex-col p-2 font-mono text-[10px] text-[#9badbf]">
                             {rawLogs.length === 0 && (
                                <div className="text-center italic text-[#3d4b5a] mt-10">暂无数据...<br/>请连接设备</div>
                            )}
                            {rawLogs.map((log, i) => (
                                <div key={i} className="border-b border-[#1a2530] py-0.5 break-all">
                                    {log}
                                </div>
                            ))}
                        </div>
                    )}

                 </div>
             </div>
        </div>
      </div>
    </div>
  );
};

export default App;
