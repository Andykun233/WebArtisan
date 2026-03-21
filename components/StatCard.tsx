import React from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  unit?: string;
  color?: 'red' | 'blue' | 'yellow' | 'green' | 'slate' | 'cyan';
  subValue?: string;
}

const StatCard: React.FC<StatCardProps> = ({ label, value, unit, color = 'slate', subValue }) => {
  // Artisan Style Colors
  const colors = {
    red: { text: 'text-[#ff6b6b]', border: 'border-[#ff6b6b]', dot: 'bg-[#ff6b6b]' }, // BT
    blue: { text: 'text-[#58a6ff]', border: 'border-[#58a6ff]', dot: 'bg-[#58a6ff]' }, // ET
    yellow: { text: 'text-[#ffd84d]', border: 'border-[#ffd84d]', dot: 'bg-[#ffd84d]' }, // Delta/RoR
    green: { text: 'text-[#4adf8f]', border: 'border-[#4adf8f]', dot: 'bg-[#4adf8f]' }, // Timer
    slate: { text: 'text-gray-300', border: 'border-gray-500', dot: 'bg-gray-300' },
    cyan: { text: 'text-cyan-300', border: 'border-cyan-300', dot: 'bg-cyan-300' }, // ET RoR
  };

  const activeColor = colors[color];

  return (
    <div className={`stat-card w-full mb-2 border-l-2 ${activeColor.border}`}>
        <div className="stat-card-head flex justify-between items-center px-2.5 py-1.5">
            <span className="text-[10px] uppercase font-semibold tracking-[0.16em] text-gray-400 flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${activeColor.dot} live-pulse`}></span>
              {label}
            </span>
            {unit && <span className="text-[10px] text-gray-500 font-mono">{unit}</span>}
        </div>
        <div className="stat-card-body px-2.5 py-2.5 flex flex-col items-end justify-center border-t border-[#1f2730]">
            <div className={`text-[2rem] md:text-[2.1rem] font-mono font-bold leading-none tracking-tight ${activeColor.text}`}>
                {value}
            </div>
             {subValue && (
                <div className="text-[11px] text-gray-500 font-mono mt-1 text-right">
                    {subValue}
                </div>
            )}
        </div>
    </div>
  );
};

export default StatCard;
