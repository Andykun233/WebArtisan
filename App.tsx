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

  // Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);

  // Error State
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Simulation
  const [isSimulating, setIsSimulating] = useState(false);
  const simulationIntervalRef = useRef<number | null>(null);
  const btRef = useRef(20.0);
  const etRef = useRef(20.0);

  // Handlers
  const handleBluetoothConnect = async () => {
    try {
      setErrorMsg(null);
      await bluetoothService.connect((bt, et) => {
        // Simple smoothing could happen here
        setCurrentBT(bt);
        setCurrentET(et);
      });
      setStatus(RoastStatus.CONNECTED);
    } catch (err) {
      setErrorMsg("Failed to connect. Check device power & pairing.");
      console.error(err);
    }
  };

  const handleStartRoast = () => {
    setStartTime(Date.now());
    setData([]);
    setEvents([]);
    setAnalysisResult(null);
    setStatus(RoastStatus.ROASTING);
    handleEvent("START");
  };

  const handleStopRoast = () => {
    setStatus(RoastStatus.FINISHED);
    handleEvent("DROP");
  };

  const handleReset = () => {
    setStatus(RoastStatus.CONNECTED);
    setData([]);
    setEvents([]);
    setAnalysisResult(null);
    setStartTime(null);
    setCurrentRoR(0);
  };

  const handleEvent = (label: string) => {
    if ((status !== RoastStatus.ROASTING && label !== 'START' && label !== 'DROP') || !startTime) return;
    
    // Allow start event even if triggered milliseconds after startTime
    const time = Math.max(0, (Date.now() - startTime) / 1000);
    setEvents(prev => [...prev, { time, label, temp: currentBT }]);
  };

  // RoR Calculation and Data Recording
  useEffect(() => {
    if (status !== RoastStatus.ROASTING || !startTime) return;

    const interval = setInterval(() => {
      const currentTime = (Date.now() - startTime) / 1000;

      // RoR Calculation (30s window)
      const lookbackSeconds = 30;
      let calculatedRoR = 0;
      
      const lookbackPoint = data.find(d => d.time >= currentTime - lookbackSeconds);
      if (lookbackPoint) {
        const deltaTemp = currentBT - lookbackPoint.bt;
        const deltaTime = (currentTime - lookbackPoint.time) / 60; // minutes
        if (deltaTime > 0.1) {
            calculatedRoR = deltaTemp / deltaTime;
        }
      }
      setCurrentRoR(parseFloat(calculatedRoR.toFixed(1)));

      // Record Data
      setData(prev => [
        ...prev, 
        { 
          time: currentTime, 
          bt: currentBT, 
          et: currentET, 
          ror: calculatedRoR 
        }
      ]);

    }, 1000);

    return () => clearInterval(interval);
  }, [status, startTime, currentBT, currentET, data]);

  // Simulation Logic
  const toggleSimulation = () => {
    if (isSimulating) {
        setIsSimulating(false);
        if (simulationIntervalRef.current) clearInterval(simulationIntervalRef.current);
        setStatus(RoastStatus.IDLE);
    } else {
        setIsSimulating(true);
        setStatus(RoastStatus.CONNECTED);
        btRef.current = 150;
        etRef.current = 200;
        
        simulationIntervalRef.current = window.setInterval(() => {
            // Physics simulation
            const targetET = 240; 
            etRef.current += (targetET - etRef.current) * 0.05 + (Math.random() - 0.5);
            const delta = etRef.current - btRef.current;
            btRef.current += delta * 0.02; // Thermal mass

            setCurrentBT(parseFloat(btRef.current.toFixed(1)));
            setCurrentET(parseFloat(etRef.current.toFixed(1)));
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

  // Define event buttons
  const eventButtons = [
    { label: "CHARGE", color: "bg-green-700 hover:bg-green-600", action: () => handleEvent("Charge") },
    { label: "DRY END", color: "bg-yellow-700 hover:bg-yellow-600", action: () => handleEvent("Dry End") },
    { label: "FC START", color: "bg-red-800 hover:bg-red-700", action: () => handleEvent("FC Start") },
    { label: "FC END", color: "bg-red-900 hover:bg-red-800", action: () => handleEvent("FC End") },
    { label: "SC START", color: "bg-purple-800 hover:bg-purple-700", action: () => handleEvent("SC Start") },
    { label: "SC END", color: "bg-purple-900 hover:bg-purple-800", action: () => handleEvent("SC End") },
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
               {status === RoastStatus.IDLE ? 'DISCONNECTED' : 'TC4 ONLINE'}
            </div>
         </div>

         <div className="flex gap-2">
            {status === RoastStatus.IDLE && (
                 <>
                 <button onClick={toggleSimulation} className="px-3 py-1 bg-[#333] hover:bg-[#444] border border-[#555] rounded text-xs text-gray-300 font-mono">
                   {isSimulating ? 'STOP SIM' : 'SIMULATE'}
                 </button>
                 <button onClick={handleBluetoothConnect} className="px-4 py-1.5 bg-[#005fb8] hover:bg-[#0070d8] text-white rounded font-bold text-sm flex items-center gap-2 border border-blue-400/20">
                    <Bluetooth size={16} /> CONNECT
                </button>
                </>
            )}

            {status === RoastStatus.CONNECTED && (
                 <button onClick={handleStartRoast} className="px-6 py-1.5 bg-[#2da44e] hover:bg-[#2c974b] text-white rounded font-bold text-sm flex items-center gap-2 border border-green-400/20 shadow-[0_0_10px_rgba(45,164,78,0.4)]">
                   <Play size={16} /> START
               </button>
            )}

            {status === RoastStatus.ROASTING && (
                 <button onClick={handleStopRoast} className="px-6 py-1.5 bg-[#cf222e] hover:bg-[#a40e26] text-white rounded font-bold text-sm flex items-center gap-2 border border-red-400/20 shadow-[0_0_10px_rgba(207,34,46,0.4)]">
                   <Square size={16} /> DROP
               </button>
            )}

            {status === RoastStatus.FINISHED && (
                 <button onClick={handleReset} className="px-4 py-1.5 bg-[#333] hover:bg-[#444] text-white rounded font-bold text-sm flex items-center gap-2 border border-[#555]">
                   <RotateCcw size={16} /> RESET
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
            <div className="mb-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">Temperature</div>
            <StatCard label="Bean Temp (BT)" value={currentBT.toFixed(1)} unit="°C" color="red" />
            <StatCard label="Env Temp (ET)" value={currentET.toFixed(1)} unit="°C" color="blue" />
            
            <div className="my-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">Rate of Rise</div>
            <StatCard label="BT RoR" value={currentRoR.toFixed(1)} unit="°C/min" color="yellow" />
            
            <div className="my-2 pb-2 border-b border-[#333] text-xs font-bold text-gray-500 uppercase tracking-widest">Process</div>
            <StatCard label="Roast Time" value={getDuration()} color="green" />

             {/* AI Panel Small */}
             {(status === RoastStatus.FINISHED || status === RoastStatus.ROASTING) && (
                <div className="mt-auto pt-4 border-t border-[#333]">
                     <button 
                        onClick={handleGeminiAnalysis}
                        disabled={isAnalyzing || data.length < 10}
                        className="w-full py-2 bg-indigo-900/50 hover:bg-indigo-900 border border-indigo-700 text-indigo-200 text-xs font-bold rounded flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        <Sparkles size={14} /> {isAnalyzing ? 'Thinking...' : 'AI Analysis'}
                    </button>
                </div>
            )}
        </div>

        {/* CENTER COLUMN: Chart */}
        <div className="flex-1 bg-[#1a1a1a] p-1 flex flex-col relative">
            <RoastChart data={data} events={events} />
            
            {/* Analysis Overlay */}
            {analysisResult && (
                <div className="absolute bottom-4 left-4 right-4 bg-[#222]/95 border border-[#444] rounded shadow-2xl p-4 max-h-[30vh] overflow-y-auto z-20 backdrop-blur-sm">
                    <div className="flex justify-between items-center mb-2 border-b border-[#444] pb-2">
                        <h4 className="text-indigo-400 font-bold flex items-center gap-2"><Sparkles size={16}/> Roast Coach Report</h4>
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
             <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 text-center">Events</div>
             {eventButtons.map((btn, idx) => (
                 <button
                    key={idx}
                    onClick={btn.action}
                    disabled={status !== RoastStatus.ROASTING}
                    className={`w-full py-3 ${btn.color} text-white font-bold text-xs rounded-sm shadow-sm active:translate-y-0.5 disabled:opacity-20 disabled:cursor-not-allowed transition-all border border-black/20`}
                 >
                     {btn.label}
                 </button>
             ))}

             <div className="mt-auto border-t border-[#333] pt-2">
                 <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                    <Terminal size={12}/> Event Log
                 </div>
                 <div className="h-48 bg-black border border-[#333] p-2 overflow-y-auto font-mono text-[10px] text-green-500/80 rounded-sm">
                    {events.length === 0 && <span className="opacity-50">Waiting for events...</span>}
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