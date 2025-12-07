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
}

const RoastChart: React.FC<RoastChartProps> = ({ data, events, currentBT, currentET, currentRoR }) => {
  // Calculate domains to make chart look nicer, keeping a minimum range
  // Default to 0-300 if no data, otherwise adaptive
  const maxTemp = data.length > 0 ? Math.max(...data.map(d => Math.max(d.bt, d.et))) + 20 : 250;
  
  return (
    <div className="w-full h-full bg-black border border-[#333] relative overflow-hidden rounded-sm shadow-2xl">
      
      {/* Real-time HUD Overlay */}
      <div className="absolute top-2 left-14 z-10 bg-black/70 backdrop-blur-sm border border-[#444] rounded p-2 pointer-events-none shadow-lg">
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
        <LineChart data={data} margin={{ top: 20, right: 50, left: 0, bottom: 20 }}>
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
          />
          
          {/* Left Axis: Temperature */}
          <YAxis 
            yAxisId="left" 
            stroke="#888" 
            tick={{fontSize: 10, fill: '#888', fontFamily: 'JetBrains Mono'}}
            domain={[0, 'auto']}
            tickCount={8}
            width={40}
          />
          
          {/* Right Axis: RoR */}
          <YAxis 
            yAxisId="right" 
            orientation="right" 
            stroke="#d4af37" 
            tick={{fontSize: 10, fill: '#d4af37', fontFamily: 'JetBrains Mono'}}
            domain={[0, 25]} // RoR usually stays within 0-20
            width={40}
          />
          
          <Tooltip 
            contentStyle={{ backgroundColor: 'rgba(0,0,0,0.9)', borderColor: '#444', color: '#f1f5f9', fontFamily: 'JetBrains Mono', fontSize: '12px' }}
            itemStyle={{ padding: 0 }}
            labelFormatter={(label) => `时间: ${Math.floor(label / 60)}:${(label % 60).toString().padStart(2, '0')}`}
            formatter={(value: number) => value.toFixed(1)}
            animationDuration={100}
          />
          
          {/* ET Line (Blue) */}
          <Line 
            yAxisId="left"
            type="monotone" 
            dataKey="et" 
            stroke="#4d94ff" 
            strokeWidth={2} 
            dot={false} 
            name="ET 炉温"
            isAnimationActive={false}
          />

          {/* BT Line (Red) - Rendered after ET to be on top */}
          <Line 
            yAxisId="left"
            type="monotone" 
            dataKey="bt" 
            stroke="#ff4d4d" 
            strokeWidth={2.5} 
            dot={false}
            name="BT 豆温"
            isAnimationActive={false}
          />

          {/* RoR Line (Gold/Yellow) */}
          <Line 
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
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default RoastChart;