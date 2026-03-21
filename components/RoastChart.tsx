import React from 'react';
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
  showLiveET?: boolean;
  showBackgroundET?: boolean;
}

const ET_PRESENT_THRESHOLD = 1.0;

const RoastChart: React.FC<RoastChartProps> = ({ data, events, currentBT, currentET, currentRoR, backgroundData = [], showLiveET, showBackgroundET }) => {
  // Calculate domains to make chart look nicer, keeping a minimum range
  // Must consider both current data AND background data to scale axes correctly
  const hasDetectedLiveET = currentET > ET_PRESENT_THRESHOLD || data.some((d) => Number.isFinite(d.et) && d.et > ET_PRESENT_THRESHOLD);
  const hasDetectedBackgroundET = backgroundData.some((d) => Number.isFinite(d.et) && d.et > ET_PRESENT_THRESHOLD);
  const hasLiveET = showLiveET ?? hasDetectedLiveET;
  const hasBackgroundET = showBackgroundET ?? hasDetectedBackgroundET;

  const tempPoints = [
    ...data.map((d) => d.bt),
    ...backgroundData.map((d) => d.bt),
    ...(hasLiveET ? data.map((d) => d.et) : []),
    ...(hasBackgroundET ? backgroundData.map((d) => d.et) : []),
  ];

  const maxTemp = tempPoints.length > 0 ? Math.max(...tempPoints) + 10 : 250;

  // Determine if we should show the ET line (hide if all 0/missing)
  // Live and background are intentionally separated to avoid showing one because of the other.

  // --- RoR Analysis: Detect Flicks (Peaks) and Crashes (Valleys) ---
  // Calculated inline for stability
  const rorExtrema: { time: number; ror: number; type: 'peak' | 'valley' }[] = [];
  
  if (data.length >= 10) {
    // Window size for local extrema detection (2 means look at +/- 2 neighbors, total 5 points window)
    const window = 2; 
    
    // Skip the first 3 minutes (180s) usually to avoid the turning point chaos and initial high RoR
    const startIndex = data.findIndex(d => d.time > 180);
    
    if (startIndex !== -1) {
        for (let i = startIndex + window; i < data.length - window; i++) {
            const current = data[i].ror;
            const prev1 = data[i - 1].ror;
            const prev2 = data[i - 2].ror;
            const next1 = data[i + 1].ror;
            const next2 = data[i + 2].ror;

            // Threshold to ignore micro-jitters (e.g., must be structurally significant)
            // Check local maximum (Peak/Flick)
            if (current > prev1 && current > prev2 && current > next1 && current > next2) {
                 rorExtrema.push({ time: data[i].time, ror: current, type: 'peak' });
            }
            // Check local minimum (Valley/Crash)
            else if (current < prev1 && current < prev2 && current < next1 && current < next2) {
                 rorExtrema.push({ time: data[i].time, ror: current, type: 'valley' });
            }
        }
    }
  }

  return (
    <div className="chart-frame w-full h-full relative overflow-hidden">
      
      {/* Reference Curve Legend */}
      {backgroundData.length > 0 && (
        <div className="absolute top-2 left-2 z-10 bg-[#0b121a]/80 border border-[#3a4a5c] rounded px-2 py-1.5 text-[10px] font-mono text-[#a8b7c8] flex items-center gap-3 pointer-events-none">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-5 h-0 border-t-2 border-dashed border-[#ff9f9f] opacity-80"></span>
            <span>参考 BT</span>
          </div>
          {hasBackgroundET && (
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-0 border-t-2 border-dotted border-[#86bcff] opacity-80"></span>
              <span>参考 ET</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-5 h-0 border-t border-dashed border-[#ffe08a] opacity-80"></span>
            <span>参考 RoR</span>
          </div>
        </div>
      )}

      {/* Real-time HUD Overlay - Hidden on Mobile (md:block) - Centered */}
      <div className="chart-hud hidden md:block absolute top-2 left-1/2 -translate-x-1/2 z-10 p-2 pointer-events-none">
        <div className="flex gap-4 text-xs font-mono font-bold">
           <div className="flex flex-col items-center">
              <span className="text-[#ff6b6b]">{currentBT.toFixed(1)}</span>
              <span className="text-gray-500 text-[9px]">BT (豆温)</span>
           </div>
           {hasLiveET && (
             <div className="flex flex-col items-center">
                <span className="text-[#58a6ff]">{currentET.toFixed(1)}</span>
                <span className="text-gray-500 text-[9px]">ET (炉温)</span>
             </div>
           )}
           <div className="flex flex-col items-center">
              <span className="text-[#ffd84d]">{currentRoR.toFixed(1)}</span>
              <span className="text-gray-500 text-[9px]">RoR (温升)</span>
           </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height="100%">
        <LineChart margin={{ top: 20, right: 10, left: 0, bottom: 0 }} data={data}>
          {/* Artisan Dark Grid */}
          <CartesianGrid strokeDasharray="3 3" stroke="#25313d" vertical={true} horizontal={true} />
          
          <XAxis 
            dataKey="time" 
            stroke="#738295" 
            tick={{fontSize: 10, fill: '#738295', fontFamily: 'JetBrains Mono'}}
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
            stroke="#97a6b8" 
            tick={{fontSize: 10, fill: '#97a6b8', fontFamily: 'JetBrains Mono'}}
            domain={[0, maxTemp]}
            tickCount={8}
            width={35}
          />
          
          {/* Right Axis: RoR */}
          <YAxis 
            yAxisId="right" 
            orientation="right" 
            stroke="#e2c25d" 
            tick={{fontSize: 10, fill: '#e2c25d', fontFamily: 'JetBrains Mono'}}
            domain={[-5, 'auto']} // Allows seeing crashes (negatives) and high spikes
            width={35}
          />
          
          <Tooltip 
            contentStyle={{ backgroundColor: 'rgba(7,10,13,0.94)', borderColor: '#4a5a6b', color: '#e6edf3', fontFamily: 'JetBrains Mono', fontSize: '12px', borderRadius: '8px' }}
            itemStyle={{ padding: 0 }}
            labelFormatter={(label) => typeof label === 'number' ? `${Math.floor(label / 60)}:${(label % 60).toString().padStart(2, '0')}` : label}
          />

          {/* Background Reference Data (if loaded) */}
          {backgroundData.length > 0 && (
             <>
                <Line 
                    data={backgroundData}
                    type="monotone" 
                    dataKey="bt" 
                    stroke="#ff9f9f"
                    strokeOpacity={0.55}
                    strokeWidth={1.5}
                    dot={false} 
                    strokeDasharray="6 4" 
                    yAxisId="left" 
                    name="参考 BT" 
                    isAnimationActive={false}
                />
                {hasBackgroundET && (
                  <Line 
                      data={backgroundData}
                      type="monotone" 
                      dataKey="et" 
                      stroke="#86bcff"
                      strokeOpacity={0.5}
                      strokeWidth={1.5}
                      dot={false} 
                      strokeDasharray="2 5" 
                      yAxisId="left" 
                      name="参考 ET" 
                      isAnimationActive={false}
                  />
                )}
                <Line
                    data={backgroundData}
                    type="monotone"
                    dataKey="ror"
                    stroke="#ffe08a"
                    strokeOpacity={0.45}
                    strokeWidth={1}
                    dot={false}
                    strokeDasharray="4 4"
                    yAxisId="right"
                    name="参考 RoR"
                    isAnimationActive={false}
                    connectNulls
                />
             </>
          )}

          {/* Main Data Lines */}
          <Line 
            type="monotone" 
            dataKey="bt" 
            stroke="#ff6b6b" 
            strokeWidth={2} 
            dot={false} 
            yAxisId="left" 
            name="Bean Temp" 
            isAnimationActive={false} 
          />
          
          {hasLiveET && (
            <Line 
                type="monotone" 
                dataKey="et" 
                stroke="#58a6ff" 
                strokeWidth={2} 
                dot={false} 
                yAxisId="left" 
                name="Env Temp" 
                isAnimationActive={false} 
            />
          )}

          <Line 
            type="monotone" 
            dataKey="ror" 
            stroke="#ffd84d" 
            strokeWidth={1} 
            dot={false} 
            yAxisId="right" 
            name="RoR" 
            isAnimationActive={false} 
            connectNulls
          />

          {/* RoR Anomalies (Flick/Crash) */}
          {rorExtrema.map((point, i) => (
             <ReferenceDot 
                key={`ror-${i}`}
                x={point.time}
                y={point.ror}
                yAxisId="right"
                r={3}
                fill={point.type === 'peak' ? '#ff9b3f' : '#26c6da'}
                stroke="none"
             />
          ))}

          {/* Event Lines */}
          {events.map((event, index) => (
            <ReferenceLine 
                key={`evt-${index}`} 
                x={event.time} 
                stroke="#738295" 
                yAxisId="left" 
                strokeDasharray="3 3"
                label={{ 
                    value: event.label, 
                    position: 'insideTopLeft', 
                    fill: '#8ea0b3', 
                    fontSize: 10,
                    className: 'font-mono'
                }}
            />
          ))}

        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default RoastChart;
