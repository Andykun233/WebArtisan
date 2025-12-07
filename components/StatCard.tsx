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
    red: { text: 'text-[#ff4d4d]', border: 'border-[#ff4d4d]' }, // BT
    blue: { text: 'text-[#4d94ff]', border: 'border-[#4d94ff]' }, // ET
    yellow: { text: 'text-[#ffd700]', border: 'border-[#ffd700]' }, // Delta/RoR
    green: { text: 'text-[#39ff14]', border: 'border-[#39ff14]' }, // Timer
    slate: { text: 'text-gray-300', border: 'border-gray-500' },
    cyan: { text: 'text-cyan-400', border: 'border-cyan-400' }, // ET RoR
  };

  const activeColor = colors[color];

  return (
    <div className="bg-black/40 border border-[#333] p-1 shadow-inner rounded-sm w-full mb-2">
        <div className="flex justify-between items-center px-2 py-1 bg-[#111]">
            <span className={`text-[10px] uppercase font-bold tracking-wider text-gray-400`}>{label}</span>
            {unit && <span className="text-[10px] text-gray-500 font-mono">{unit}</span>}
        </div>
        <div className={`bg-black px-2 py-2 flex flex-col items-end justify-center border-t border-[#222]`}>
            <div className={`text-4xl font-mono font-bold leading-none tracking-tighter ${activeColor.text} drop-shadow-lg`}>
                {value}
            </div>
             {subValue && (
                <div className="text-xs text-gray-500 font-mono mt-1 text-right">
                    {subValue}
                </div>
            )}
        </div>
    </div>
  );
};

export default StatCard;