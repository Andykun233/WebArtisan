
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Square, Bluetooth, Thermometer, Clock, AlertCircle, Terminal, RotateCcw, Activity, Loader2, Signal, Undo2, X, Flame, Download, Upload } from 'lucide-react';
import RoastChart from './components/RoastChart';
import StatCard from './components/StatCard';
import { TC4BluetoothService } from './services/bluetoothService';
import { DataPoint, RoastStatus, RoastEvent } from './types';

const bluetoothService = new TC4BluetoothService();

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

// --- Utility: Batch Calculate RoR for Imported Data ---
// Replicates the Artisan logic: 60s Lookback Window using Least Squares.
function recalculateRoR(data: DataPoint[]): DataPoint[] {
    const LOOKBACK_WINDOW = 60; // Artisan Standard Span (often 30s or 60s)

    return data.map((point, index) => {
        const currentTime = point.time;
        
        // 1. Calculate BT RoR
        // Get points within the lookback window ending at current index
        const historyPointsBT = data
            .slice(Math.max(0, index - 120), index + 1) // Optimization: limit slice
            .filter(d => d.time > currentTime - LOOKBACK_WINDOW && d.time <= currentTime)
            .map(d => ({ time: d.time, value: d.bt }));

        let ror = 0;
        // Require at least a few seconds of data to calculate a slope
        if (historyPointsBT.length >= 3 && (historyPointsBT[historyPointsBT.length - 1].time - historyPointsBT[0].time > 5)) {
             ror = calculateSlope(historyPointsBT) * 60; // Convert slope (deg/sec) to RoR (deg/min)
        }

        // 2. Calculate ET RoR
        const historyPointsET = data
            .slice(Math.max(0, index - 120), index + 1)
            .filter(d => d.time > currentTime - LOOKBACK_WINDOW && d.time <= currentTime)
            .map(d => ({ time: d.time, value: d.et }));

        let et_ror = 0;
        if (historyPointsET.length >= 3 && (historyPointsET[historyPointsET.length - 1].time - historyPointsET[0].time > 5)) {
             et_ror = calculateSlope(historyPointsET) * 60;
        }
        
        // Cap extreme values (Artisan usually clips artifacts)
        if (ror > 100) ror = 100; if (ror < -50) ror = -50;
        if (et_ror > 100) et_ror = 100; if (et_ror < -50) et_ror = -50;

        return { 
            ...point, 
            ror: parseFloat(ror.toFixed(1)), 
            et_ror: parseFloat(et_ror.toFixed(1)) 
        };
    });
}

const App: React.FC = () => {
  const [status, setStatus] = useState<RoastStatus>(RoastStatus.IDLE);
  const [data, setData] = useState<DataPoint[]>([]);
  const [events, setEvents] = useState<RoastEvent[]>([]);
  const [startTime, setStartTime] = useState<number | null>(null);
  
  // Instant values for display
  const [currentBT, setCurrentBT] = useState<number>(20.0);
  const [currentET, setCurrentET] = useState<number>(20.0);
  const [currentRoR, setCurrentRoR] = useState<number>(0.0);
  const [currentETRoR, setCurrentETRoR] = useState<number>(0.0);

  // Refs for stable access inside intervals without triggering re-renders
  const btRef = useRef(20.0);
  const etRef = useRef(20.0);
  const dataRef = useRef<DataPoint[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Connection State
  const [isConnecting, setIsConnecting] = useState(false);
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

  // Handlers
  const handleBluetoothConnect = async () => {
    setIsConnecting(true);
    try {
      setErrorMsg(null);
      const name = await bluetoothService.connect(
        (bt, et) => {
          // Update Refs for logic
          btRef.current = bt;
          etRef.current = et;
          // Update State for UI
          setCurrentBT(bt);
          setCurrentET(et);
        },
        () => {
          // On Disconnect
          setStatus(RoastStatus.IDLE);
          setIsSimulating(false); // Stop sim if running
          setDeviceName(null);
          setErrorMsg("设备连接已断开");
        }
      );
      setDeviceName(name);
      setStatus(RoastStatus.PREHEATING); // Go directly to Preheating after connection
    } catch (err: any) {
      setErrorMsg(err.message || "连接失败。请检查设备电源和配对状态。");
      console.error(err);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleStartRoast = () => {
    const now = Date.now();
    setStartTime(now);
    
    // Reset Data
    setData([]);
    dataRef.current = [];
    
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

  const handleReset = () => {
    // Clear any pending undo
    setShowUndoDrop(false);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);

    // If still connected (not IDLE), go to PREHEATING. If IDLE, stay IDLE.
    if (status !== RoastStatus.IDLE) {
        setStatus(RoastStatus.PREHEATING);
    }
    
    setData([]);
    dataRef.current = [];
    setEvents([]);
    setStartTime(null);
    setCurrentRoR(0);
    setCurrentETRoR(0);
  };

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
          
          // Time2: If Charge exists, Time2 is time since Charge. If before charge, empty or negative.
          // In standard CSV, usually just empty if irrelevant, or 00:00.
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
      if (fileInputRef.current) {
          fileInputRef.current.click();
      }
  };

  const handleImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
          const content = e.target?.result as string;
          try {
              let parsedData: DataPoint[] = [];
              let parsedEvents: RoastEvent[] = [];

              if (file.name.endsWith('.json') || file.name.endsWith('.alog')) {
                  // JSON / ALOG Parsing
                  const json = JSON.parse(content);
                  
                  // Support standard Artisan "timex", "temp1" (ET/BT), "temp2" (BT) structure
                  // Or the "temps" object structure
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
                      // Usually temp2 is Bean, temp1 is Environment (or user configured)
                      // If temp2 has data, use it as BT.
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
                          // Our own export format (legacy)
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

                      // Special handling: 'computed' keys usually store the Value (Temp) or Time
                      // For times: DRY_time, TP_time, etc.
                      for (const [key, label] of Object.entries(eventMapping)) {
                           if (c[key] !== undefined && c[key] > 0) {
                               // Check if key implies time
                               if (key.endsWith('_time')) {
                                   // Find temp at this time
                                   const t = c[key];
                                   const closest = parsedData.reduce((prev, curr) => 
                                      Math.abs(curr.time - t) < Math.abs(prev.time - t) ? curr : prev
                                   , parsedData[0]);
                                   
                                   parsedEvents.push({ time: t, label: label, temp: closest.bt });
                               }
                               // CHARGE_BT is a temp, usually happens at time 0 or first index
                               else if (key === 'CHARGE_BT') {
                                   parsedEvents.push({ time: 0, label: label, temp: c[key] });
                               }
                           }
                      }
                  }

              } else if (file.name.endsWith('.csv')) {
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
                                  // Use mapped label or original (Title Case it maybe?)
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

              // Setup app state
              // 1. Stop simulations if any
              if (isSimulating) {
                toggleSimulation();
              }
              
              // 2. Set State
              setData(processedData);
              dataRef.current = processedData; // Sync ref
              setEvents(parsedEvents);
              setStatus(RoastStatus.FINISHED); // View mode
              setStartTime(null); // Static
              
              // 3. Update Display Values to end of roast
              if (processedData.length > 0) {
                  const last = processedData[processedData.length - 1];
                  setCurrentBT(last.bt);
                  setCurrentET(last.et);
                  setCurrentRoR(last.ror);
                  setCurrentETRoR(last.et_ror || 0);
                  btRef.current = last.bt;
                  etRef.current = last.et;
              }

              setSuccessMsg(`成功导入: ${file.name}`);

          } catch (err: any) {
              console.error("Import error", err);
              setErrorMsg("导入失败: " + (err.message || "文件格式错误"));
          } finally {
              // Reset input
              if (fileInputRef.current) fileInputRef.current.value = "";
          }
      };
      reader.readAsText(file);
  };


  // RoR Calculation and Data Recording
  useEffect(() => {
    if (status !== RoastStatus.ROASTING || !startTime) return;

    const interval = setInterval(() => {
      const currentTime = (Date.now() - startTime) / 1000;
      const currentBTVal = btRef.current;
      const currentETVal = etRef.current;

      // --- Artisan-Style RoR Calculation ---
      // Method: Least Squares Linear Regression over a fixed Time Span.
      // Artisan Default Span is often 30s or 60s. We use 60s for smoothness.
      const LOOKBACK_WINDOW = 60; 
      
      // 1. Prepare Data for Regression (BT)
      // Filter history points within the lookback window
      const historyPointsBT = dataRef.current
        .filter(d => d.time > currentTime - LOOKBACK_WINDOW)
        .map(d => ({ time: d.time, value: d.bt }));
      
      const regressionPointsBT = [...historyPointsBT, { time: currentTime, value: currentBTVal }];

      let calculatedRoR = 0;
      
      // Only calculate if we have enough data (at least 5 seconds of delta) to avoid noise
      if (regressionPointsBT.length >= 5 && (regressionPointsBT[regressionPointsBT.length - 1].time - regressionPointsBT[0].time > 5)) {
         // Calculate Slope via Linear Regression (deg/sec)
         const slope = calculateSlope(regressionPointsBT);
         // Convert to deg/min (RoR standard)
         calculatedRoR = slope * 60;
      }

      // 2. Prepare Data for Regression (ET)
      const historyPointsET = dataRef.current
        .filter(d => d.time > currentTime - LOOKBACK_WINDOW)
        .map(d => ({ time: d.time, value: d.et }));
      
      const regressionPointsET = [...historyPointsET, { time: currentTime, value: currentETVal }];

      let calculatedETRoR = 0;
      if (regressionPointsET.length >= 5 && (regressionPointsET[regressionPointsET.length - 1].time - regressionPointsET[0].time > 5)) {
          const slope = calculateSlope(regressionPointsET);
          calculatedETRoR = slope * 60;
      }

      // Note: Removed EWMA smoothing to match Artisan's pure LS approach. 
      // The 60s window provides sufficient smoothing.

      // Cap extreme values/noise
      if (Math.abs(calculatedRoR) < 0.1) calculatedRoR = 0;
      if (calculatedRoR > 100) calculatedRoR = 100;
      if (calculatedRoR < -50) calculatedRoR = -50;
      
      if (Math.abs(calculatedETRoR) < 0.1) calculatedETRoR = 0;
      if (calculatedETRoR > 100) calculatedETRoR = 100;
      if (calculatedETRoR < -50) calculatedETRoR = -50;

      // Round for display
      const finalRoR = parseFloat(calculatedRoR.toFixed(1));
      const finalETRoR = parseFloat(calculatedETRoR.toFixed(1));

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
  }, [status, startTime]); // Dependencies reduced to only status/start

  // Simulation Logic
  const toggleSimulation = () => {
    if (isSimulating) {
        setIsSimulating(false);
        if (simulationIntervalRef.current) clearInterval(simulationIntervalRef.current);
        setStatus(RoastStatus.IDLE);
        setDeviceName(null);
    } else {
        setIsSimulating(true);
        setStatus(RoastStatus.PREHEATING); // Start in Preheating mode
        setDeviceName("模拟烘焙机 (Demo)");
        
        // Init physics vars
        let simBt = 150;
        let simEt = 200;
        btRef.current = simBt;
        etRef.current = simEt;
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
        bgClass: "bg-green-600",
        borderClass: "border-green-600 text-green-500",
        action: () => handleToggleEvent("入豆"),
        disabled: false 
    },
    { 
        label: "脱水结束", // Dry End
        baseColor: "yellow",
        bgClass: "bg-yellow-600",
        borderClass: "border-yellow-600 text-yellow-500",
        action: () => handleToggleEvent("脱水结束"),
        disabled: !hasEvent("入豆") 
    },
    { 
        label: "一爆开始", // FC Start
        baseColor: "red",
        bgClass: "bg-red-600",
        borderClass: "border-red-600 text-red-500",
        action: () => handleToggleEvent("一爆开始"),
        disabled: !hasEvent("入豆")
    },
    { 
        label: "一爆结束", // FC End
        baseColor: "red",
        bgClass: "bg-red-800",
        borderClass: "border-red-800 text-red-700",
        action: () => handleToggleEvent("一爆结束"),
        disabled: !hasEvent("一爆开始")
    },
    { 
        label: "二爆开始", // SC Start
        baseColor: "purple",
        bgClass: "bg-purple-600",
        borderClass: "border-purple-600 text-purple-500",
        action: () => handleToggleEvent("二爆开始"),
        disabled: !hasEvent("入豆")
    },
    { 
        label: "二爆结束", // SC End
        baseColor: "purple",
        bgClass: "bg-purple-800",
        borderClass: "border-purple-800 text-purple-700",
        action: () => handleToggleEvent("二爆结束"),
        disabled: !hasEvent("二爆开始")
    },
  ];

  // Logic for status color
  const getStatusColor = () => {
      if (isConnecting) return 'bg-yellow-500 animate-pulse';
      if (status === RoastStatus.PREHEATING) return 'bg-orange-500 shadow-[0_0_8px_#f97316]'; // Orange for Preheating
      if (status !== RoastStatus.IDLE) return 'bg-[#39ff14] shadow-[0_0_8px_#39ff14]'; // Green for Connected/Roasting
      return 'bg-red-500';
  };

  const getStatusText = () => {
      if (isConnecting) return '正在连接...';
      if (status === RoastStatus.IDLE) return '未连接';
      if (status === RoastStatus.PREHEATING) return '预热中';
      return '设备在线';
  };

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-[#1c1c1c] text-[#e0e0e0]">
      
      {/* Hidden File Input for Import */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleImportFile} 
        className="hidden" 
        accept=".json,.alog,.csv"
      />

      {/* EXPORT MODAL */}
      {isExportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-[#222] border border-[#444] rounded-lg shadow-2xl w-full max-w-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-[#333] flex justify-between items-center bg-[#2a2a2a]">
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
                                className="flex-1 bg-[#111] border border-[#444] text-white px-3 py-2 text-sm rounded-l focus:outline-none focus:border-blue-500"
                                autoFocus
                            />
                            <div className="bg-[#333] border border-l-0 border-[#444] text-gray-400 px-3 py-2 text-sm rounded-r">
                                .csv
                            </div>
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button 
                            type="button"
                            onClick={() => setIsExportModalOpen(false)}
                            className="px-3 py-1.5 rounded text-sm font-bold text-gray-400 hover:bg-[#333] hover:text-white transition-colors"
                        >
                            取消
                        </button>
                        <button 
                            type="submit"
                            className="px-4 py-1.5 rounded text-sm font-bold bg-blue-600 hover:bg-blue-500 text-white shadow-lg transition-colors"
                        >
                            确认导出
                        </button>
                    </div>
                </form>
            </div>
        </div>
      )}

      {/* 1. TOP TOOLBAR - Mobile Compact */}
      <div className="h-10 md:h-14 bg-[#2a2a2a] border-b border-[#333] flex items-center justify-between px-3 md:px-4 shadow-md z-10 shrink-0">
         <div className="flex items-center gap-2 md:gap-4">
            <span className="font-bold text-lg md:text-xl tracking-tighter text-gray-300 flex items-center gap-1.5">
                <Thermometer className="text-orange-500 w-4 h-4 md:w-6 md:h-6" />
                <span className="hidden xs:inline">WEB</span><span className="text-orange-500">ARTISAN</span>
            </span>
            <div className="h-4 md:h-6 w-px bg-[#444] mx-1 md:mx-2 hidden md:block"></div>
            
            {/* Connection Status Indicator */}
            <div className="group relative flex items-center gap-1.5 text-[10px] md:text-xs font-mono uppercase cursor-help py-2">
               <span className={`w-2 h-2 md:w-3 md:h-3 rounded-full transition-colors duration-300 ${getStatusColor()}`}></span>
               <span className="hidden sm:inline transition-colors group-hover:text-white">
                  {getStatusText()}
               </span>
               
               {/* Tooltip Popup */}
               <div className="absolute top-full left-0 mt-1 w-48 p-2 bg-black/90 backdrop-blur border border-gray-600 rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 text-[10px] text-gray-300 transform origin-top-left">
                  <div className="font-bold text-white mb-1 border-b border-gray-700 pb-1">系统状态</div>
                  <div className="flex flex-col gap-1">
                      <div>
                        状态: <span className={status !== RoastStatus.IDLE ? 'text-green-400' : 'text-red-400'}>
                             {isConnecting ? '初始化中...' : status === RoastStatus.IDLE ? '等待连接' : status === RoastStatus.PREHEATING ? '正在预热' : '已就绪'}
                        </span>
                      </div>
                      {status !== RoastStatus.IDLE && (
                          <>
                            <div>设备: {deviceName || '未知'}</div>
                            <div>协议: TC4/Modbus</div>
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
            {/* File Operations */}
            <button onClick={handleOpenExportModal} className="p-1.5 md:px-2 md:py-1.5 bg-[#333] hover:bg-[#444] text-gray-300 hover:text-white border border-[#555] rounded flex items-center gap-1 transition-colors" title="导出 CSV">
                <Download size={14} className="md:w-4 md:h-4" />
                <span className="hidden md:inline text-xs">导出</span>
            </button>
            <button onClick={handleImportClick} className="p-1.5 md:px-2 md:py-1.5 bg-[#333] hover:bg-[#444] text-gray-300 hover:text-white border border-[#555] rounded flex items-center gap-1 transition-colors mr-2" title="导入 Artisan / CSV 文件">
                <Upload size={14} className="md:w-4 md:h-4" />
                <span className="hidden md:inline text-xs">导入</span>
            </button>

            {status === RoastStatus.IDLE && (
                 <>
                 <button onClick={toggleSimulation} className="px-2 py-1 bg-[#333] hover:bg-[#444] border border-[#555] rounded text-[10px] md:text-xs text-gray-300 font-mono">
                   {isSimulating ? '停止模拟' : '模拟'}
                 </button>
                 <button 
                    onClick={handleBluetoothConnect} 
                    disabled={isConnecting}
                    className="px-3 py-1.5 bg-[#005fb8] hover:bg-[#0070d8] disabled:bg-[#004080] text-white rounded font-bold text-xs md:text-sm flex items-center gap-1 border border-blue-400/20 transition-all"
                 >
                    {isConnecting ? (
                        <Loader2 size={14} className="animate-spin md:w-4 md:h-4" />
                    ) : (
                        <Bluetooth size={14} className="md:w-4 md:h-4" />
                    )}
                    <span className="inline">{isConnecting ? '连接中...' : '连接'}</span>
                </button>
                </>
            )}

            {/* Show START button when Connected or Preheating */}
            {(status === RoastStatus.CONNECTED || status === RoastStatus.PREHEATING) && (
                 <button onClick={handleStartRoast} className="px-4 py-1.5 bg-[#2da44e] hover:bg-[#2c974b] text-white rounded font-bold text-xs md:text-sm flex items-center gap-1 border border-green-400/20 shadow-[0_0_10px_rgba(45,164,78,0.4)]">
                   <Play size={14} className="md:w-4 md:h-4" /> 开始
               </button>
            )}

            {status === RoastStatus.ROASTING && (
                 <button onClick={handleStopRoast} className="px-4 py-1.5 bg-[#cf222e] hover:bg-[#a40e26] text-white rounded font-bold text-xs md:text-sm flex items-center gap-1 border border-red-400/20 shadow-[0_0_10px_rgba(207,34,46,0.4)]">
                   <Square size={14} className="md:w-4 md:h-4" /> 下豆
               </button>
            )}

            {status === RoastStatus.FINISHED && (
                 <button onClick={handleReset} className="px-3 py-1.5 bg-[#333] hover:bg-[#444] text-white rounded font-bold text-xs md:text-sm flex items-center gap-1 border border-[#555]">
                   <RotateCcw size={14} className="md:w-4 md:h-4" /> 重置
               </button>
            )}
        </div>
      </div>

      {/* NOTIFICATIONS */}
      {errorMsg && (
        <div className="bg-red-900/80 text-white px-4 py-2 text-xs md:text-sm flex items-center gap-2 border-b border-red-500 animate-in fade-in slide-in-from-top-2">
            <AlertCircle size={14} /> {errorMsg}
        </div>
      )}
      {successMsg && (
        <div className="bg-green-900/80 text-white px-4 py-2 text-xs md:text-sm flex items-center gap-2 border-b border-green-500 animate-in fade-in slide-in-from-top-2">
            <Signal size={14} /> {successMsg}
        </div>
      )}

      {/* 2. MAIN WORKSPACE */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        
        {/* Undo Drop Toast */}
        {showUndoDrop && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-top-4 fade-in duration-300">
                <div className="bg-[#222] border border-[#cf222e] rounded-md shadow-2xl p-3 flex items-center gap-3">
                    <div className="flex flex-col">
                        <span className="text-white font-bold text-sm">已下豆 (Roast Finished)</span>
                        <span className="text-gray-400 text-xs">烘焙已完成。误操作？</span>
                    </div>
                    <div className="h-6 w-px bg-gray-600"></div>
                    <button 
                        onClick={handleUndoDrop}
                        className="flex items-center gap-1 px-3 py-1.5 bg-[#cf222e] hover:bg-[#a40e26] text-white text-xs font-bold rounded transition-colors"
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
            hidden md:flex w-64 bg-[#222] border-r border-[#333] p-3 
            flex-col gap-2 overflow-y-auto shrink-0 no-scrollbar
        ">
            <div className="mb-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">实时温度</div>
            <StatCard label="Bean Temp" value={currentBT.toFixed(1)} unit="°C" color="red" />
            <StatCard label="Env Temp" value={currentET.toFixed(1)} unit="°C" color="blue" />
            
            <div className="my-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">温升率</div>
            <StatCard label="BT RoR" value={currentRoR.toFixed(1)} unit="°/min" color="yellow" />
            <StatCard label="ET RoR" value={currentETRoR.toFixed(1)} unit="°/min" color="cyan" />
            
            <div className="my-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">时间</div>
            <StatCard label="TIME" value={getDuration()} color="green" />
        </div>

        {/* CENTER COLUMN: Chart + Mobile Ticker */}
        <div className="flex-1 bg-[#1a1a1a] flex flex-col relative min-h-0">
            
            {/* MOBILE ONLY: Slim Data Ticker */}
            <div className="md:hidden h-10 bg-black border-b border-[#333] flex items-center justify-around px-2 shrink-0 shadow-lg z-10">
               <div className="flex flex-col items-center">
                  <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wide">BT 豆温</span>
                  <span className="text-lg font-mono font-bold text-[#ff4d4d] leading-none">{currentBT.toFixed(1)}</span>
               </div>
               <div className="w-px h-6 bg-[#333]"></div>
               <div className="flex flex-col items-center">
                  <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wide">ET 炉温</span>
                  <span className="text-lg font-mono font-bold text-[#4d94ff] leading-none">{currentET.toFixed(1)}</span>
               </div>
               <div className="w-px h-6 bg-[#333]"></div>
               <div className="flex flex-col items-center">
                  <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wide">RoR</span>
                  <span className="text-lg font-mono font-bold text-[#ffd700] leading-none">{currentRoR.toFixed(1)}</span>
               </div>
               <div className="w-px h-6 bg-[#333]"></div>
               <div className="flex flex-col items-center w-14">
                  <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wide">时间</span>
                  <span className="text-xs font-mono font-bold text-[#39ff14] leading-none mt-1">{getDuration()}</span>
               </div>
            </div>

            <div className="flex-1 p-0 md:p-1 md:pb-0 relative">
                <RoastChart 
                    data={data} 
                    events={events} 
                    currentBT={currentBT}
                    currentET={currentET}
                    currentRoR={currentRoR}
                />
            </div>
        </div>

        {/* RIGHT COLUMN: Controls & Events */}
        {/* Mobile: Bottom Grid | Desktop: Right Sidebar */}
        <div className="
            w-full md:w-48 bg-[#222] border-t md:border-t-0 md:border-l border-[#333] p-2 
            flex flex-col md:flex-col gap-2 shrink-0 
            pb-safe md:pb-2 z-20
        ">
             <div className="hidden md:block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 text-center">事件标记</div>
             
             {/* Mobile: Grid Layout for Buttons */}
             {/* Using grid-cols-3 is good, but let's make them slightly shorter vertically on mobile to save space */}
             <div className="grid grid-cols-3 md:flex md:flex-col gap-2 mb-safe-offset">
                 {eventButtons.map((btn, idx) => {
                     const isActive = hasEvent(btn.label);
                     
                     return (
                        <button
                            key={idx}
                            onClick={btn.action}
                            disabled={status !== RoastStatus.ROASTING || btn.disabled}
                            className={`
                                w-full py-2 md:py-3 font-bold text-[10px] md:text-xs rounded-sm transition-all border select-none active:scale-95 touch-manipulation
                                ${status !== RoastStatus.ROASTING || btn.disabled 
                                    ? 'bg-[#2a2a2a] text-gray-600 border-transparent' 
                                    : isActive 
                                        ? `${btn.bgClass} text-white border-transparent shadow-inner` // Active State
                                        : `bg-transparent ${btn.borderClass} hover:bg-white/5 active:bg-white/10` // Available State
                                }
                            `}
                        >
                            {btn.label}
                        </button>
                     );
                 })}
             </div>

             <div className="mt-auto border-t border-[#333] pt-3 hidden md:flex flex-col gap-2">
                 <div className="text-[10px] font-bold text-[#666] uppercase tracking-wider flex items-center gap-2 px-1">
                    <Terminal size={10} /> 事件日志 (LOG)
                 </div>
                 <div className="h-48 bg-[#0a0a0a] border border-[#333] rounded-sm overflow-y-auto custom-scrollbar shadow-inner relative">
                    {events.length === 0 && (
                        <div className="absolute inset-0 flex items-center justify-center text-[#333] text-[10px] italic">
                            等待记录...
                        </div>
                    )}
                    <div className="flex flex-col">
                        {events.map((e, i) => (
                            <div key={i} className="flex items-center justify-between p-2 border-b border-[#1c1c1c] hover:bg-[#111] transition-colors group">
                                <div className="flex flex-col">
                                    <span className="text-[#e0e0e0] font-bold text-[10px] group-hover:text-white transition-colors">
                                        {e.label}
                                    </span>
                                    <span className="text-[#444] text-[9px] group-hover:text-[#666] transition-colors font-mono">
                                        @ {e.temp.toFixed(1)}°C
                                    </span>
                                </div>
                                <span className="text-[#007acc] font-mono text-[10px] bg-[#007acc]/10 px-1.5 py-0.5 rounded border border-[#007acc]/20">
                                    {formatTime(e.time * 1000)}
                                </span>
                            </div>
                        )).reverse()}
                    </div>
                 </div>
             </div>
        </div>
      </div>
    </div>
  );
};

export default App;
