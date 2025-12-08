
import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
  ReferenceLine,
} from 'recharts';
import { DataPoint, RoastEvent } from '../types';

interface RoastChartProps {
  data: DataPoint[];
  events: RoastEvent[];
  currentBT: number;
  currentET: number;
  currentRoR: number;
  backgroundData?: DataPoint[]; // New prop for background curve
}

const RoastChart: React.FC<RoastChartProps> = ({ data, events, currentBT, currentET, currentRoR, backgroundData = [] }) => {
  // Calculate domains to make chart look nicer, keeping a minimum range
  // Must consider both current data AND background data to scale axes correctly
  const allDataPoints = [...data, ...backgroundData];
  
  const maxTemp = allDataPoints.length > 0 
    ? Math.max(...allDataPoints.map(d => Math.max(d.bt, d.et))) + 10 
    : 250;

  // Determine if we should show the ET line (hide if all 0/missing)
  const hasActiveET = useMemo(() => {
     if (data.length === 0) return false;
     // Assume valid ET must be > 1.0 (to filter out default 0s)
     return data.some(d => d.et > 1.0);
  }, [data]);

  // --- RoR Analysis: Detect Flicks (Peaks) and Crashes (Valleys) ---
  const rorExtrema = useMemo(() => {
    const points: { time: number; ror: number; type: 'peak' | 'valley' }[] = [];
    if (data.length < 10) return points;

    // Window size for local extrema detection (2 means look at +/- 2 neighbors, total 5 points window)
    const window = 2; 
    
    // Skip the first 3 minutes (180s) usually to avoid the turning point chaos and initial high RoR
    const startIndex = data.findIndex(d => d.time > 180);
    if (startIndex === -1) return points;

    for (let i = startIndex + window; i < data.length - window; i++) {
        const current = data[i].ror;
        const prev1 = data[i - 1].ror;
        const prev2 = data[i - 2].ror;
        const next1 = data[i + 1].ror;
        const next2 = data[i + 2].ror;

        // Threshold to ignore micro-jitters (e.g., must be structurally significant)
        // Check local maximum (Peak/Flick)
        if (current > prev1 && current > prev2 && current > next1 && current > next2) {
             points.push({ time: data[i].time, ror: current, type: 'peak' });
        }
        // Check local minimum (Valley/Crash)
        else if (current < prev1 && current < prev2 && current < next1 && current < next2) {
             points.push({ time: data[i].time, ror: current, type: 'valley' });
        }
    }
    return points;
  }, [data]);

  return (
    <div className="w-full h-full bg-black border border-[#333] relative overflow-hidden rounded-sm shadow-2xl">
      
      {/* Real-time HUD Overlay - Hidden on Mobile (md:block) - Centered */}
      <div className="hidden md:block absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-black/70 backdrop-blur-sm border border-[#444] rounded p-2 pointer-events-none shadow-lg">
        <div className="flex gap-4 text-xs font-mono font-bold">
           <div className="flex flex-col items-center">
              <span className="text-[#ff4d4d]">{currentBT.toFixed(1)}</span>
              <span className="text-gray-500 text-[9px]">BT (豆温)</span>
           </div>
           <div className="flex flex-col items-center">
              <span className="text-[#4d94ff]">{currentET.toFixed(1)}</span>
              <span className="text-gray-500 text-[9px]">ET (炉温)</span>
           </div>
           <div className="flex flex-col items-center">
              <span className="text-[#ffd700]">{currentRoR.toFixed(1)}</span>
              <span className="text-gray-500 text-[9px]">RoR (温升)</span>
           </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height="100%">
        <LineChart margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
          {/* Artisan Dark Grid */}
          <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={true} horizontal={true} />
          
          <XAxis 
            dataKey="time" 
            stroke="#666" 
            tick={{fontSize: 10, fill: '#666', fontFamily: 'JetBrains Mono'}}
            tickFormatter={(val) => `${Math.floor(val / 60)}:${(val % 60).toString().padStart(2, '0')}`}
            type="number"
            domain={['auto', 'auto']}
            allowDataOverflow={true}
            minTickGap={30}
            height={20}
          />
          
          {/* Left Axis: Temperature */}
          <YAxis 
            yAxisId="left" 
            stroke="#888" 
            tick={{fontSize: 10, fill: '#888', fontFamily: 'JetBrains Mono'}}
            domain={[0, maxTemp]}
            tickCount={8}
            width={35}
          />
          
          {/* Right Axis: RoR */}
          <YAxis 
            yAxisId="right" 
            orientation="right" 
            stroke="#d4af37" 
            tick={{fontSize: 10, fill: '#d4af37', fontFamily: 'JetBrains Mono'}}
            domain={[-5, 'auto']} // Allows seeing crashes (negatives) and high spikes
            width={35}
          />
          
          <Tooltip 
            contentStyle={{ backgroundColor: 'rgba(0,0,0,0.9)', borderColor: '#444', color: '#f1f5f9', fontFamily: 'JetBrains Mono', fontSize: '12px' }}
            itemStyle={{ padding: 0 }}
            labelFormatter={(label) => `时间: ${Math.floor(label / 60)}:${(label % 60).toString().padStart(2, '0')}`}
            formatter={(value: number, name: string) => {
                if (name.includes('背景')) return [value.toFixed(1), name];
                return value.toFixed(1);
            }}
            animationDuration={100}
          />

          {/* --- BACKGROUND LINES (Reference) --- */}
          {/* Render these first so they appear behind active lines */}
          {backgroundData.length > 0 && (
            <>
               <Line
                  yAxisId="left"
                  data={backgroundData}
                  type="monotone"
                  dataKey="et"
                  stroke="#2a4a75" // Muted Blue
                  strokeWidth={1.5}
                  strokeDasharray="5 5"
                  dot={false}
                  name="背景 ET"
                  isAnimationActive={false}
               />
               <Line
                  yAxisId="left"
                  data={backgroundData}
                  type="monotone"
                  dataKey="bt"
                  stroke="#752a2a" // Muted Red
                  strokeWidth={1.5}
                  strokeDasharray="5 5"
                  dot={false}
                  name="背景 BT"
                  isAnimationActive={false}
               />
            </>
          )}
          
          {/* --- ACTIVE LINES --- */}
          {/* Main Data Source - ET (Conditional) */}
          {hasActiveET && (
              <Line 
                data={data}
                yAxisId="left"
                type="monotone" 
                dataKey="et" 
                stroke="#4d94ff" 
                strokeWidth={2} 
                dot={false} 
                name="ET 炉温"
                isAnimationActive={false}
              />
          )}

          {/* Main Data Source - BT */}
          <Line 
            data={data}
            yAxisId="left"
            type="monotone" 
            dataKey="bt" 
            stroke="#ff4d4d" 
            strokeWidth={2.5} 
            dot={false}
            name="BT 豆温"
            isAnimationActive={false}
          />

          <Line 
            data={data}
            yAxisId="right"
            type="monotone" 
            dataKey="ror" 
            stroke="#ffd700" 
            strokeWidth={1.5} 
            dot={false} 
            name="RoR 温升"
            isAnimationActive={false}
          />

          {/* Vertical Event Lines & Labels */}
          {events.map((evt, idx) => (
             <ReferenceLine 
                key={`line-${idx}`} 
                yAxisId="left"
                x={evt.time} 
                stroke="#666" 
                strokeDasharray="3 3"
                label={{ 
                    position: 'insideTopLeft', 
                    value: evt.label, 
                    fill: '#ccc', 
                    fontSize: 10, 
                    angle: -90, // Vertical text like Artisan
                    dx: 10,
                    dy: 40
                }}
            />
          ))}

          {/* Event Dots on BT Curve */}
           {events.map((evt, idx) => (
             <ReferenceDot
                key={`dot-${idx}`}
                yAxisId="left"
                x={evt.time}
                y={evt.temp}
                r={4}
                fill="#fff"
                stroke="#000"
                strokeWidth={1}
            />
          ))}

          {/* RoR Flicks (Peaks) and Crashes (Valleys) Markers */}
          {rorExtrema.map((point, idx) => (
             <ReferenceDot
                key={`ror-extrema-${idx}`}
                yAxisId="right"
                x={point.time}
                y={point.ror}
                r={3}
                fill="#1c1c1c" // Dark center
                stroke={point.type === 'peak' ? '#ff00ff' : '#00ffff'} // Magenta for Peak (Flick), Cyan for Valley (Crash)
                strokeWidth={2}
                shape="circle"
                isFront={true}
            />
          ))}

        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default RoastChart;
