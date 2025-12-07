import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Square, Bluetooth, Thermometer, Clock, AlertCircle, Sparkles, Terminal, RotateCcw, Activity } from 'lucide-react';
import RoastChart from './components/RoastChart';
import StatCard from './components/StatCard';
import { TC4BluetoothService } from './services/bluetoothService';
import { DataPoint, RoastStatus, RoastEvent } from './types';
import { analyzeRoast } from './services/geminiService';

const bluetoothService = new TC4BluetoothService();

// --- Utility: Linear Regression for Slope Calculation ---
// Returns slope (rate of change per unit time)
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

const App: React.FC = () => {
  const [status, setStatus] = useState<RoastStatus>(RoastStatus.IDLE);
  const [data, setData] = useState<DataPoint[]>([]);
  const [events, setEvents] = useState<RoastEvent[]>([]);
  const [startTime, setStartTime] = useState<number | null>(null);
  
  // Instant values for display
  const [currentBT, setCurrentBT] = useState<number>(20.0);
  const [currentET, setCurrentET] = useState<number>(20.0);
  const [currentRoR, setCurrentRoR] = useState<number>(0.0);

  // Refs for stable access inside intervals without triggering re-renders
  const btRef = useRef(20.0);
  const etRef = useRef(20.0);
  const dataRef = useRef<DataPoint[]>([]);

  // Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);

  // Error State
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Simulation
  const [isSimulating, setIsSimulating] = useState(false);
  const simulationIntervalRef = useRef<number | null>(null);

  // Handlers
  const handleBluetoothConnect = async () => {
    try {
      setErrorMsg(null);
      await bluetoothService.connect((bt, et) => {
        // Update Refs for logic
        btRef.current = bt;
        etRef.current = et;
        // Update State for UI
        setCurrentBT(bt);
        setCurrentET(et);
      });
      setStatus(RoastStatus.CONNECTED);
    } catch (err: any) {
      setErrorMsg(err.message || "连接失败。请检查设备电源和配对状态。");
      console.error(err);
    }
  };

  const handleStartRoast = () => {
    const now = Date.now();
    setStartTime(now);
    
    // Reset Data
    setData([]);
    dataRef.current = [];
    
    setEvents([]);
    setAnalysisResult(null);
    setStatus(RoastStatus.ROASTING);
    
    // Add START event manually since startTime state update is async
    const startEvent: RoastEvent = { time: 0, label: "开始", temp: btRef.current };
    setEvents([startEvent]);
  };

  const handleStopRoast = () => {
    setStatus(RoastStatus.FINISHED);
    handleEvent("下豆"); // Drop is a one-time final event
  };

  const handleReset = () => {
    setStatus(RoastStatus.CONNECTED);
    setData([]);
    dataRef.current = [];
    setEvents([]);
    setAnalysisResult(null);
    setStartTime(null);
    setCurrentRoR(0);
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

  // RoR Calculation and Data Recording
  useEffect(() => {
    if (status !== RoastStatus.ROASTING || !startTime) return;

    const interval = setInterval(() => {
      const currentTime = (Date.now() - startTime) / 1000;
      const currentBTVal = btRef.current;
      const currentETVal = etRef.current;

      // --- Advanced RoR Calculation ---
      // 1. Configuration
      const LOOKBACK_WINDOW = 45; // Increased to 45s for stability (Artisan style)
      const EWMA_ALPHA = 0.25;    // Smoothing factor (0.1 = very smooth/laggy, 1.0 = raw)
      
      // 2. Prepare Data for Regression
      // Filter history points within the lookback window
      const historyPoints = dataRef.current
        .filter(d => d.time > currentTime - LOOKBACK_WINDOW)
        .map(d => ({ time: d.time, value: d.bt }));
      
      // Include current point
      const regressionPoints = [...historyPoints, { time: currentTime, value: currentBTVal }];

      let calculatedRoR = 0;
      
      // Only calculate if we have enough data duration (> 10 seconds) to avoid initial noise
      if (regressionPoints.length >= 5 && (regressionPoints[regressionPoints.length - 1].time - regressionPoints[0].time > 10)) {
         // Calculate Slope via Linear Regression (deg/sec)
         const slope = calculateSlope(regressionPoints);
         // Convert to deg/min
         calculatedRoR = slope * 60;
      }

      // 3. Apply EWMA Smoothing (Exponential Weighted Moving Average)
      // Get previous RoR (from last recorded data point)
      const previousRoR = dataRef.current.length > 0 ? dataRef.current[dataRef.current.length - 1].ror : 0;
      
      let smoothedRoR = calculatedRoR;
      
      // Apply smoothing only if we have a history stream established
      if (dataRef.current.length > 10) {
          smoothedRoR = (EWMA_ALPHA * calculatedRoR) + ((1 - EWMA_ALPHA) * previousRoR);
      }

      // Cap extreme values/noise
      if (Math.abs(smoothedRoR) < 0.1) smoothedRoR = 0;
      // Also clamp unlikely values to prevent chart explosion
      if (smoothedRoR > 100) smoothedRoR = 100;
      if (smoothedRoR < -50) smoothedRoR = -50;
      
      // Round for display/storage
      smoothedRoR = parseFloat(smoothedRoR.toFixed(1));

      // Update UI
      setCurrentRoR(smoothedRoR);

      // Create new DataPoint
      const newDataPoint: DataPoint = { 
        time: currentTime, 
        bt: currentBTVal, 
        et: currentETVal, 
        ror: smoothedRoR 
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
    } else {
        setIsSimulating(true);
        setStatus(RoastStatus.CONNECTED);
        
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

  const handleGeminiAnalysis = async () => {
    if (data.length === 0) return;
    setIsAnalyzing(true);
    const result = await analyzeRoast(data);
    setAnalysisResult(result);
    setIsAnalyzing(false);
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

  return (
    <div className="h-screen w-full flex flex-col bg-[#1c1c1c] text-[#e0e0e0]">
      
      {/* 1. TOP TOOLBAR - Mobile Compact */}
      <div className="h-12 md:h-14 bg-[#2a2a2a] border-b border-[#333] flex items-center justify-between px-3 md:px-4 shadow-md z-10 shrink-0">
         <div className="flex items-center gap-2 md:gap-4">
            <span className="font-bold text-lg md:text-xl tracking-tighter text-gray-300 flex items-center gap-1.5">
                <Thermometer className="text-orange-500 w-4 h-4 md:w-6 md:h-6" />
                <span className="hidden xs:inline">WEB</span><span className="text-orange-500">ARTISAN</span>
            </span>
            <div className="h-4 md:h-6 w-px bg-[#444] mx-1 md:mx-2 hidden md:block"></div>
            
            {/* Connection Status */}
            <div className="flex items-center gap-1.5 text-[10px] md:text-xs font-mono uppercase">
               <span className={`w-2 h-2 md:w-3 md:h-3 rounded-full ${status !== RoastStatus.IDLE ? 'bg-[#39ff14] shadow-[0_0_8px_#39ff14]' : 'bg-red-500'}`}></span>
               <span className="hidden sm:inline">{status === RoastStatus.IDLE ? '未连接' : '设备在线'}</span>
            </div>
         </div>

         <div className="flex gap-2 items-center">
            {/* AI Analysis Button - Visible on Mobile if Roasting/Finished */}
            {(status === RoastStatus.FINISHED || status === RoastStatus.ROASTING) && (
               <button 
                  onClick={handleGeminiAnalysis}
                  disabled={isAnalyzing || data.length < 10}
                  className="p-1.5 md:px-3 md:py-1.5 bg-indigo-900/50 hover:bg-indigo-900 border border-indigo-700 text-indigo-200 rounded flex items-center justify-center gap-1 md:gap-2 disabled:opacity-50"
                  title="AI 分析"
              >
                  <Sparkles size={16} /> <span className="hidden md:inline">{isAnalyzing ? '分析中...' : 'AI 分析'}</span>
              </button>
            )}

            {status === RoastStatus.IDLE && (
                 <>
                 <button onClick={toggleSimulation} className="px-2 py-1 bg-[#333] hover:bg-[#444] border border-[#555] rounded text-[10px] md:text-xs text-gray-300 font-mono">
                   {isSimulating ? '停止' : '模拟'}
                 </button>
                 <button onClick={handleBluetoothConnect} className="px-3 py-1.5 bg-[#005fb8] hover:bg-[#0070d8] text-white rounded font-bold text-xs md:text-sm flex items-center gap-1 border border-blue-400/20">
                    <Bluetooth size={14} className="md:w-4 md:h-4" /> <span className="inline">连接</span>
                </button>
                </>
            )}

            {status === RoastStatus.CONNECTED && (
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

      {/* ERROR MESSAGE */}
      {errorMsg && (
        <div className="bg-red-900/80 text-white px-4 py-2 text-xs md:text-sm flex items-center gap-2 border-b border-red-500">
            <AlertCircle size={14} /> {errorMsg}
        </div>
      )}

      {/* 2. MAIN WORKSPACE */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        
        {/* LEFT COLUMN: LCD Displays */}
        {/* Mobile: Top Bar, scrollable | Desktop: Left Sidebar */}
        <div className="
            w-full md:w-64 bg-[#222] border-b md:border-b-0 md:border-r border-[#333] p-1.5 md:p-3 
            flex flex-row md:flex-col gap-1.5 md:gap-2 overflow-x-auto md:overflow-y-auto shrink-0 no-scrollbar
        ">
            <div className="hidden md:block mb-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">实时温度</div>
            
            {/* Mobile: use min-w to force scrolling if needed, but try to fit */}
            <div className="min-w-[30%] md:min-w-0 flex-1">
                <StatCard label="Bean Temp" value={currentBT.toFixed(1)} unit="°C" color="red" />
            </div>
            <div className="min-w-[30%] md:min-w-0 flex-1">
                <StatCard label="Env Temp" value={currentET.toFixed(1)} unit="°C" color="blue" />
            </div>
            
            <div className="hidden md:block my-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">温升率</div>
            <div className="min-w-[25%] md:min-w-0 flex-1">
                <StatCard label="BT RoR" value={currentRoR.toFixed(1)} unit="°/min" color="yellow" />
            </div>
            
            <div className="hidden md:block my-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">时间</div>
            <div className="min-w-[20%] md:min-w-0 flex-1">
                <StatCard label="TIME" value={getDuration()} color="green" />
            </div>
        </div>

        {/* CENTER COLUMN: Chart */}
        <div className="flex-1 bg-[#1a1a1a] flex flex-col relative min-h-0">
            <div className="flex-1 p-1 pb-0">
                <RoastChart 
                    data={data} 
                    events={events} 
                    currentBT={currentBT}
                    currentET={currentET}
                    currentRoR={currentRoR}
                />
            </div>
            
            {/* Analysis Overlay */}
            {analysisResult && (
                <div className="absolute inset-x-4 bottom-4 md:inset-auto md:top-4 md:right-4 md:w-96 bg-[#222]/95 border border-[#444] rounded shadow-2xl flex flex-col max-h-[50vh] z-30 backdrop-blur-md">
                    <div className="flex justify-between items-center p-3 border-b border-[#444]">
                        <h4 className="text-indigo-400 font-bold flex items-center gap-2 text-sm"><Sparkles size={14}/> 烘焙分析报告</h4>
                        <button onClick={() => setAnalysisResult(null)} className="text-gray-400 hover:text-white p-1">✕</button>
                    </div>
                    <div className="p-3 overflow-y-auto">
                        <pre className="font-sans text-xs md:text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                            {analysisResult}
                        </pre>
                    </div>
                </div>
            )}
        </div>

        {/* RIGHT COLUMN: Controls & Events */}
        {/* Mobile: Bottom Grid | Desktop: Right Sidebar */}
        <div className="
            w-full md:w-48 bg-[#222] border-t md:border-t-0 md:border-l border-[#333] p-2 
            flex flex-col md:flex-col gap-2 shrink-0 
            pb-safe md:pb-2
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
                                w-full py-2.5 md:py-3 font-bold text-[11px] md:text-xs rounded-sm transition-all border select-none active:scale-95
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

             <div className="mt-auto border-t border-[#333] pt-2 hidden md:block">
                 <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                    <Terminal size={12}/> 事件日志
                 </div>
                 <div className="h-48 bg-black border border-[#333] p-2 overflow-y-auto font-mono text-[10px] text-green-500/80 rounded-sm custom-scrollbar">
                    {events.length === 0 && <span className="opacity-50">等待事件...</span>}
                    {events.map((e, i) => (
                        <div key={i} className="mb-1 border-b border-[#222] pb-1 last:border-0">
                            <span className="text-gray-500">[{formatTime(e.time * 1000)}]</span>
                            <span className="text-white ml-1">{e.label}</span>
                        </div>
                    )).reverse()}
                 </div>
             </div>
        </div>
      </div>
    </div>
  );
};

export default App;