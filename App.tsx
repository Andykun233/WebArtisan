import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Square, Bluetooth, Thermometer, Clock, AlertCircle, Sparkles, Terminal, RotateCcw } from 'lucide-react';
import RoastChart from './components/RoastChart';
import StatCard from './components/StatCard';
import { TC4BluetoothService } from './services/bluetoothService';
import { DataPoint, RoastStatus, RoastEvent } from './types';
import { analyzeRoast } from './services/geminiService';

const bluetoothService = new TC4BluetoothService();

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

      // RoR Calculation (30s window)
      const lookbackSeconds = 30;
      let calculatedRoR = 0;
      
      const lookbackPoint = dataRef.current.find(d => d.time >= currentTime - lookbackSeconds);
      if (lookbackPoint) {
        const deltaTemp = currentBTVal - lookbackPoint.bt;
        const deltaTime = (currentTime - lookbackPoint.time) / 60; // minutes
        if (deltaTime > 0.1) {
            calculatedRoR = deltaTemp / deltaTime;
        }
      }
      
      // Update RoR UI
      setCurrentRoR(parseFloat(calculatedRoR.toFixed(1)));

      // Create new DataPoint
      const newDataPoint: DataPoint = { 
        time: currentTime, 
        bt: currentBTVal, 
        et: currentETVal, 
        ror: calculatedRoR 
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
  // Logic: 
  // 1. Buttons can be toggled (Undo/Redo).
  // 2. Strict prerequisites for ENABLING the button, but loosely coupled for unchecking.
  // 3. Visuals: Outlined = Available, Filled = Active/Done.
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
      
      {/* 1. TOP TOOLBAR */}
      <div className="h-14 bg-[#2a2a2a] border-b border-[#333] flex items-center justify-between px-4 shadow-md z-10">
         <div className="flex items-center gap-4">
            <span className="font-bold text-xl tracking-tighter text-gray-300 flex items-center gap-2">
                <Thermometer className="text-orange-500" />
                WEB<span className="text-orange-500">ARTISAN</span>
            </span>
            <div className="h-6 w-px bg-[#444] mx-2"></div>
            
            {/* Connection Status */}
            <div className="flex items-center gap-2 text-xs font-mono uppercase">
               <span className={`w-3 h-3 rounded-full ${status !== RoastStatus.IDLE ? 'bg-[#39ff14] shadow-[0_0_8px_#39ff14]' : 'bg-red-500'}`}></span>
               {status === RoastStatus.IDLE ? '未连接' : '设备在线'}
            </div>
         </div>

         <div className="flex gap-2">
            {status === RoastStatus.IDLE && (
                 <>
                 <button onClick={toggleSimulation} className="px-3 py-1 bg-[#333] hover:bg-[#444] border border-[#555] rounded text-xs text-gray-300 font-mono">
                   {isSimulating ? '停止模拟' : '模拟模式'}
                 </button>
                 <button onClick={handleBluetoothConnect} className="px-4 py-1.5 bg-[#005fb8] hover:bg-[#0070d8] text-white rounded font-bold text-sm flex items-center gap-2 border border-blue-400/20">
                    <Bluetooth size={16} /> 连接设备
                </button>
                </>
            )}

            {status === RoastStatus.CONNECTED && (
                 <button onClick={handleStartRoast} className="px-6 py-1.5 bg-[#2da44e] hover:bg-[#2c974b] text-white rounded font-bold text-sm flex items-center gap-2 border border-green-400/20 shadow-[0_0_10px_rgba(45,164,78,0.4)]">
                   <Play size={16} /> 开始烘焙
               </button>
            )}

            {status === RoastStatus.ROASTING && (
                 <button onClick={handleStopRoast} className="px-6 py-1.5 bg-[#cf222e] hover:bg-[#a40e26] text-white rounded font-bold text-sm flex items-center gap-2 border border-red-400/20 shadow-[0_0_10px_rgba(207,34,46,0.4)]">
                   <Square size={16} /> 下豆 (Drop)
               </button>
            )}

            {status === RoastStatus.FINISHED && (
                 <button onClick={handleReset} className="px-4 py-1.5 bg-[#333] hover:bg-[#444] text-white rounded font-bold text-sm flex items-center gap-2 border border-[#555]">
                   <RotateCcw size={16} /> 重置
               </button>
            )}
        </div>
      </div>

      {/* ERROR MESSAGE */}
      {errorMsg && (
        <div className="bg-red-900/80 text-white px-4 py-2 text-sm flex items-center gap-2 border-b border-red-500">
            <AlertCircle size={16} /> {errorMsg}
        </div>
      )}

      {/* 2. MAIN WORKSPACE */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* LEFT COLUMN: LCD Displays */}
        <div className="w-64 bg-[#222] border-r border-[#333] p-3 flex flex-col gap-1 overflow-y-auto">
            <div className="mb-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">实时温度</div>
            <StatCard label="Bean Temp 豆温" value={currentBT.toFixed(1)} unit="°C" color="red" />
            <StatCard label="Env Temp 炉温" value={currentET.toFixed(1)} unit="°C" color="blue" />
            
            <div className="my-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">温升率 (RoR)</div>
            <StatCard label="BT RoR" value={currentRoR.toFixed(1)} unit="°C/min" color="yellow" />
            
            <div className="my-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">烘焙进程</div>
            <StatCard label="烘焙时间" value={getDuration()} color="green" />

             {/* AI Panel Small */}
             {(status === RoastStatus.FINISHED || status === RoastStatus.ROASTING) && (
                <div className="mt-auto pt-4 border-t border-[#333]">
                     <button 
                        onClick={handleGeminiAnalysis}
                        disabled={isAnalyzing || data.length < 10}
                        className="w-full py-2 bg-indigo-900/50 hover:bg-indigo-900 border border-indigo-700 text-indigo-200 text-xs font-bold rounded flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        <Sparkles size={14} /> {isAnalyzing ? '分析中...' : 'AI 智能分析'}
                    </button>
                </div>
            )}
        </div>

        {/* CENTER COLUMN: Chart */}
        <div className="flex-1 bg-[#1a1a1a] p-1 flex flex-col relative">
            <RoastChart 
                data={data} 
                events={events} 
                currentBT={currentBT}
                currentET={currentET}
                currentRoR={currentRoR}
            />
            
            {/* Analysis Overlay */}
            {analysisResult && (
                <div className="absolute bottom-4 left-4 right-4 bg-[#222]/95 border border-[#444] rounded shadow-2xl p-4 max-h-[30vh] overflow-y-auto z-20 backdrop-blur-sm">
                    <div className="flex justify-between items-center mb-2 border-b border-[#444] pb-2">
                        <h4 className="text-indigo-400 font-bold flex items-center gap-2"><Sparkles size={16}/> 烘焙分析报告</h4>
                        <button onClick={() => setAnalysisResult(null)} className="text-gray-500 hover:text-white">✕</button>
                    </div>
                    <pre className="font-sans text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                        {analysisResult}
                    </pre>
                </div>
            )}
        </div>

        {/* RIGHT COLUMN: Controls & Events */}
        <div className="w-48 bg-[#222] border-l border-[#333] p-2 flex flex-col gap-2">
             <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 text-center">事件标记</div>
             {eventButtons.map((btn, idx) => {
                 const isActive = hasEvent(btn.label);
                 
                 return (
                    <button
                        key={idx}
                        onClick={btn.action}
                        disabled={status !== RoastStatus.ROASTING || btn.disabled}
                        className={`
                            w-full py-3 font-bold text-xs rounded-sm transition-all border
                            ${status !== RoastStatus.ROASTING || btn.disabled 
                                ? 'bg-[#2a2a2a] text-gray-600 border-transparent cursor-not-allowed' 
                                : isActive 
                                    ? `${btn.bgClass} text-white border-transparent shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)]` // Active State
                                    : `bg-transparent ${btn.borderClass} hover:bg-white/5` // Available State
                            }
                        `}
                    >
                        {btn.label}
                    </button>
                 );
             })}

             <div className="mt-auto border-t border-[#333] pt-2">
                 <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                    <Terminal size={12}/> 事件日志
                 </div>
                 <div className="h-48 bg-black border border-[#333] p-2 overflow-y-auto font-mono text-[10px] text-green-500/80 rounded-sm">
                    {events.length === 0 && <span className="opacity-50">等待事件...</span>}
                    {events.map((e, i) => (
                        <div key={i} className="mb-1 border-b border-[#222] pb-1 last:border-0">
                            <span className="text-gray-500">[{formatTime(e.time * 1000)}]</span>
                            <span className="text-white ml-1">{e.label}</span>
                            <span className="text-gray-400 ml-1">@ {e.temp.toFixed(1)}°</span>
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