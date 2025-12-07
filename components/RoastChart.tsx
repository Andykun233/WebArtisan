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
  Area
} from 'recharts';
import { DataPoint, RoastEvent } from '../types';

interface RoastChartProps {
  data: DataPoint[];
  events: RoastEvent[];
}

const RoastChart: React.FC<RoastChartProps> = ({ data, events }) => {
  // Calculate domains to make chart look nicer
  const maxTemp = data.length > 0 ? Math.max(...data.map(d => Math.max(d.bt, d.et))) + 10 : 250;
  
  return (
    <div className="w-full h-full bg-black border border-[#333] relative overflow-hidden rounded-sm shadow-2xl">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 20, right: 50, left: 10, bottom: 20 }}>
          {/* Artisan Dark Grid */}
          <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={true} horizontal={true} />
          
          <XAxis 
            dataKey="time" 
            stroke="#666" 
            tick={{fontSize: 12, fill: '#666', fontFamily: 'JetBrains Mono'}}
            tickFormatter={(val) => `${Math.floor(val / 60)}:${(val % 60).toString().padStart(2, '0')}`}
            type="number"
            domain={['auto', 'auto']}
            allowDataOverflow={true}
          />
          
          {/* Left Axis: Temperature */}
          <YAxis 
            yAxisId="left" 
            stroke="#888" 
            tick={{fontSize: 12, fill: '#888', fontFamily: 'JetBrains Mono'}}
            domain={[0, 'auto']}
            allowDataOverflow={false}
            tickCount={8}
          />
          
          {/* Right Axis: RoR */}
          <YAxis 
            yAxisId="right" 
            orientation="right" 
            stroke="#d4af37" 
            tick={{fontSize: 12, fill: '#d4af37', fontFamily: 'JetBrains Mono'}}
            domain={[0, 25]} // RoR usually stays within 0-20
            allowDataOverflow={false}
          />
          
          <Tooltip 
            contentStyle={{ backgroundColor: 'rgba(0,0,0,0.9)', borderColor: '#444', color: '#f1f5f9', fontFamily: 'JetBrains Mono', fontSize: '12px' }}
            itemStyle={{ padding: 0 }}
            labelFormatter={(label) => `Time: ${Math.floor(label / 60)}:${(label % 60).toString().padStart(2, '0')}`}
            formatter={(value: number) => value.toFixed(1)}
          />
          
          {/* ET Line (Blue) */}
          <Line 
            yAxisId="left"
            type="monotone" 
            dataKey="et" 
            stroke="#4d94ff" 
            strokeWidth={2} 
            dot={false} 
            name="ET"
            isAnimationActive={false}
          />

          {/* BT Line (Red) - Rendered after ET to be on top */}
          <Line 
            yAxisId="left"
            type="monotone" 
            dataKey="bt" 
            stroke="#ff4d4d" 
            strokeWidth={3} 
            dot={false}
            name="BT"
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
            name="RoR"
            isAnimationActive={false}
          />

          {/* Vertical Event Lines */}
          {events.map((evt, idx) => (
             <ReferenceLine 
                key={`line-${idx}`} 
                yAxisId="left"
                x={evt.time} 
                stroke="#666" 
                strokeDasharray="4 2"
            />
          ))}

          {/* Event Dots & Labels */}
           {events.map((evt, idx) => (
             <React.Fragment key={`evt-${idx}`}>
                <ReferenceDot
                    yAxisId="left"
                    x={evt.time}
                    y={evt.temp}
                    r={3}
                    fill="#fff"
                    stroke="none"
                />
                <ReferenceDot
                    yAxisId="left"
                    x={evt.time}
                    y={20} // Position labels at bottom or consistent height
                    r={0}
                >
                    <g transform={`translate(0, ${-20 + (idx % 2) * -15})`}> 
                       <text 
                        x={0} 
                        y={0} 
                        fill="#aaa" 
                        textAnchor="middle" 
                        fontSize={10} 
                        fontFamily="Arial"
                        transform="rotate(0)"
                       >
                        {evt.label}
                       </text>
                    </g>
                </ReferenceDot>
             </React.Fragment>
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default RoastChart;