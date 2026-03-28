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
  currentETRoR?: number;
  backgroundData?: DataPoint[]; // New prop for background curve
  showLiveET?: boolean;
  showBackgroundET?: boolean;
  showBtRoR?: boolean;
  showEtRoR?: boolean;
  language?: 'zh-CN' | 'en';
  compactMode?: boolean;
}

const ET_PRESENT_THRESHOLD = 1.0;
const MIN_TEMP_SPAN = 120;
const MIN_ROR_SPAN = 20;
const X_AXIS_BASE_SECONDS = 10 * 60; // Keep timeline fixed at 10 min until data exceeds it.
const TEMP_AXIS_BASE_MAX = 300; // Keep temp axis fixed at 300C until data exceeds it.
const EVENT_LABEL_EN: Record<string, string> = {
  '预热': 'Preheat',
  '开始': 'Start',
  '入豆': 'Charge',
  '回温点': 'Turning Point',
  '脱水结束': 'Dry End',
  '一爆开始': 'FC Start',
  '一爆结束': 'FC End',
  '二爆开始': 'SC Start',
  '二爆结束': 'SC End',
  '下豆': 'Drop'
};

const formatClock = (seconds: number) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
};

const RoastChart: React.FC<RoastChartProps> = ({
  data,
  events,
  currentBT,
  currentET,
  currentRoR,
  currentETRoR = 0,
  backgroundData = [],
  showLiveET,
  showBackgroundET,
  showBtRoR,
  showEtRoR,
  language = 'zh-CN',
  compactMode = false
}) => {
  const isZh = language === 'zh-CN';
  const displayEventLabel = (label: string) => (isZh ? label : (EVENT_LABEL_EN[label] || label));
  const refBtLabel = isZh ? '参考 BT' : 'Ref BT';
  const refEtLabel = isZh ? '参考 ET' : 'Ref ET';
  const refRorLabel = isZh ? '参考 RoR' : 'Ref RoR';
  const btHudLabel = isZh ? 'BT (豆温)' : 'BT (Bean)';
  const etHudLabel = isZh ? 'ET (炉温)' : 'ET (Env)';
  const btLineName = isZh ? '豆温 BT' : 'Bean Temp';
  const etLineName = isZh ? '环境温 ET' : 'Env Temp';
  const btRorLineName = 'BT RoR';
  const etRorLineName = 'ET RoR';

  // Must consider both live and reference curves to scale axes correctly.
  const hasDetectedLiveET = currentET > ET_PRESENT_THRESHOLD || data.some((d) => Number.isFinite(d.et) && d.et > ET_PRESENT_THRESHOLD);
  const hasDetectedBackgroundET = backgroundData.some((d) => Number.isFinite(d.et) && d.et > ET_PRESENT_THRESHOLD);
  const hasLiveET = showLiveET ?? hasDetectedLiveET;
  const hasBackgroundET = showBackgroundET ?? hasDetectedBackgroundET;
  const hasLiveData = data.length > 0;
  const displayBtRoR = showBtRoR ?? true;
  const hasDetectedEtRoR = data.some((d) => Number.isFinite(d.et_ror ?? NaN));
  const displayEtRoR = (showEtRoR ?? true) && hasLiveET && hasDetectedEtRoR;
  const displayAnyRoR = displayBtRoR || displayEtRoR;
  const showLiveBtSeries = hasLiveData;
  const showLiveEtSeries = hasLiveData && hasLiveET;
  const showLiveBtRoRSeries = hasLiveData && displayBtRoR;
  const showLiveEtRoRSeries = hasLiveData && displayEtRoR;

  const tempPoints = [
    ...data.map((d) => d.bt),
    ...backgroundData.map((d) => d.bt),
    ...(hasLiveET ? data.map((d) => d.et) : []),
    ...(hasBackgroundET ? backgroundData.map((d) => d.et) : []),
  ].filter((value) => Number.isFinite(value));

  const positiveTemps = tempPoints.filter((value) => value > 0);
  const tempMinRaw = positiveTemps.length > 0 ? Math.min(...positiveTemps) : 0;
  const tempMaxRaw = positiveTemps.length > 0 ? Math.max(...positiveTemps) : 250;
  const tempMinCandidate = Math.max(0, Math.floor((tempMinRaw - 15) / 10) * 10);
  const tempMin =
    tempMaxRaw <= TEMP_AXIS_BASE_MAX
      ? Math.min(tempMinCandidate, TEMP_AXIS_BASE_MAX - MIN_TEMP_SPAN)
      : tempMinCandidate;
  const tempMax =
    tempMaxRaw <= TEMP_AXIS_BASE_MAX
      ? TEMP_AXIS_BASE_MAX
      : Math.max(
          tempMin + MIN_TEMP_SPAN,
          Math.ceil((tempMaxRaw + 12) / 10) * 10
        );

  const rorPoints = [
    ...(displayBtRoR ? data.map((d) => d.ror) : []),
    ...(displayBtRoR ? backgroundData.map((d) => d.ror) : []),
    ...(displayEtRoR ? data.map((d) => d.et_ror ?? NaN) : []),
  ].filter((value) => Number.isFinite(value));

  const rorMinRaw = rorPoints.length > 0 ? Math.min(...rorPoints) : -5;
  const rorMaxRaw = rorPoints.length > 0 ? Math.max(...rorPoints) : 35;
  const rorMin = Math.min(-5, Math.floor((rorMinRaw - 2) / 5) * 5);
  const rorMax = Math.max(
    15,
    rorMin + MIN_ROR_SPAN,
    Math.ceil((rorMaxRaw + 2) / 5) * 5
  );

  const allTimes = [...data.map((d) => d.time), ...backgroundData.map((d) => d.time)];
  const maxTimeRaw = allTimes.length > 0 ? Math.max(...allTimes) : 0;
  const xAxisMax = Math.max(X_AXIS_BASE_SECONDS, Math.ceil((maxTimeRaw + 15) / 30) * 30);
  const xTickStep = xAxisMax <= 10 * 60 ? 60 : xAxisMax <= 20 * 60 ? 120 : 180;
  const xTicks = Array.from({ length: Math.floor(xAxisMax / xTickStep) + 1 }, (_, i) => i * xTickStep);

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

  // Prevent event labels from stacking when events are very close in time.
  const labeledEventIndexes = new Set<number>();
  let lastLabeledAt = -Infinity;
  events.forEach((event, index) => {
    const isBoundary = index === 0 || index === events.length - 1;
    const isKeyMilestone = /(入豆|下豆|一爆|二爆|CHARGE|DROP|FC|SC)/i.test(event.label);
    if (isBoundary || isKeyMilestone || event.time - lastLabeledAt >= 35) {
      labeledEventIndexes.add(index);
      lastLabeledAt = event.time;
    }
  });

  const tooltipValueFormatter = (value: number | string, name: string) => {
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
    const display = Number.isFinite(numeric) ? numeric.toFixed(1) : `${value}`;
    const unit = /RoR/i.test(name) ? '°/min' : '°C';
    return [`${display} ${unit}`, name];
  };

  const latestLivePoint = data.length > 0 ? data[data.length - 1] : null;

  return (
    <div className="chart-frame w-full h-full relative overflow-hidden">
      
      {/* Reference Curve Legend */}
      {backgroundData.length > 0 && !compactMode && (
        <div className="absolute top-2 left-2 z-10 bg-[#0b121a]/80 border border-[#3a4a5c] rounded px-2 py-1.5 text-[10px] font-mono text-[#a8b7c8] flex items-center gap-3 pointer-events-none">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-5 h-0 border-t-2 border-dashed border-[#ff9f9f] opacity-80"></span>
            <span>{refBtLabel}</span>
          </div>
          {hasBackgroundET && (
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-0 border-t-2 border-dotted border-[#86bcff] opacity-80"></span>
              <span>{refEtLabel}</span>
            </div>
          )}
          {displayBtRoR && (
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-0 border-t border-dashed border-[#ffe08a] opacity-80"></span>
              <span>{refRorLabel}</span>
            </div>
          )}
        </div>
      )}

      {/* Real-time HUD Overlay - Hidden on Mobile (md:block) - Centered */}
      <div className={`${compactMode ? 'hidden' : 'hidden md:block'} chart-hud absolute top-2 left-1/2 -translate-x-1/2 z-10 p-2 pointer-events-none`}>
        <div className="flex gap-4 text-xs font-mono font-bold">
           <div className="flex flex-col items-center">
              <span className="text-[#ff6b6b]">{currentBT.toFixed(1)}</span>
              <span className="text-gray-500 text-[9px]">{btHudLabel}</span>
           </div>
           {hasLiveET && (
             <div className="flex flex-col items-center">
                <span className="text-[#58a6ff]">{currentET.toFixed(1)}</span>
                <span className="text-gray-500 text-[9px]">{etHudLabel}</span>
             </div>
           )}
           {displayBtRoR && (
             <div className="flex flex-col items-center">
                <span className="text-[#ffd84d]">{currentRoR.toFixed(1)}</span>
                <span className="text-gray-500 text-[9px]">BT RoR</span>
             </div>
           )}
           {displayEtRoR && (
             <div className="flex flex-col items-center">
                <span className="text-[#59d2ff]">{currentETRoR.toFixed(1)}</span>
                <span className="text-gray-500 text-[9px]">ET RoR</span>
             </div>
           )}
        </div>
      </div>

      <ResponsiveContainer width="100%" height="100%">
        <LineChart margin={compactMode ? { top: 10, right: 8, left: 0, bottom: 2 } : { top: 20, right: 12, left: 0, bottom: 4 }} data={data}>
          {/* Artisan Dark Grid */}
          <CartesianGrid strokeDasharray="3 3" stroke="#25313d" vertical={true} horizontal={true} />
          
          <XAxis 
            dataKey="time" 
            stroke="#738295" 
            tick={{fontSize: compactMode ? 9 : 10, fill: '#738295', fontFamily: 'JetBrains Mono'}}
            tickFormatter={(val) => formatClock(Number(val))}
            type="number"
            domain={[0, xAxisMax]}
            ticks={xTicks}
            allowDataOverflow={false}
            minTickGap={compactMode ? 16 : 24}
            height={compactMode ? 20 : 24}
            tickMargin={compactMode ? 4 : 6}
          />
          
          {/* Left Axis: Temperature */}
          <YAxis 
            yAxisId="left" 
            stroke="#97a6b8" 
            tick={{fontSize: compactMode ? 9 : 10, fill: '#97a6b8', fontFamily: 'JetBrains Mono'}}
            domain={[tempMin, tempMax]}
            tickCount={7}
            width={compactMode ? 36 : 42}
            tickMargin={compactMode ? 2 : 4}
          />
          
          {/* Right Axis: RoR */}
          {displayAnyRoR && (
            <YAxis 
              yAxisId="right" 
              orientation="right" 
              stroke="#e2c25d" 
              tick={{fontSize: compactMode ? 9 : 10, fill: '#e2c25d', fontFamily: 'JetBrains Mono'}}
              domain={[rorMin, rorMax]}
              tickCount={7}
              width={compactMode ? 36 : 42}
              tickMargin={compactMode ? 2 : 4}
            />
          )}
          
          <Tooltip 
            contentStyle={{ backgroundColor: 'rgba(7,10,13,0.94)', borderColor: '#4a5a6b', color: '#e6edf3', fontFamily: 'JetBrains Mono', fontSize: '12px', borderRadius: '8px' }}
            itemStyle={{ padding: 0 }}
            labelFormatter={(label) => typeof label === 'number' ? formatClock(label) : label}
            formatter={tooltipValueFormatter}
            cursor={{ stroke: '#5c6b7b', strokeDasharray: '3 3', strokeOpacity: 0.65 }}
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
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    yAxisId="left" 
                    name={refBtLabel} 
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
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      yAxisId="left" 
                      name={refEtLabel} 
                      isAnimationActive={false}
                  />
                )}
                {displayBtRoR && (
                  <Line
                      data={backgroundData}
                      type="monotone"
                      dataKey="ror"
                      stroke="#ffe08a"
                      strokeOpacity={0.45}
                      strokeWidth={1}
                      dot={false}
                      strokeDasharray="4 4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      yAxisId="right"
                      name={refRorLabel}
                      isAnimationActive={false}
                      connectNulls
                  />
                )}
             </>
          )}

          {/* Main Data Lines */}
          {showLiveBtSeries && (
            <Line 
              type="monotone" 
              dataKey="bt" 
              stroke="#ff6b6b" 
              strokeWidth={2} 
              dot={false} 
              strokeLinecap="round"
              strokeLinejoin="round"
              yAxisId="left" 
              name={btLineName} 
              isAnimationActive={false} 
            />
          )}
          
          {showLiveEtSeries && (
            <Line 
                type="monotone" 
                dataKey="et" 
                stroke="#58a6ff" 
                strokeWidth={2} 
                dot={false} 
                strokeLinecap="round"
                strokeLinejoin="round"
                yAxisId="left" 
                name={etLineName} 
                isAnimationActive={false} 
            />
          )}

          {showLiveBtRoRSeries && (
            <Line 
              type="monotone" 
              dataKey="ror" 
              stroke="#ffd84d" 
              strokeWidth={1.4} 
              dot={false} 
              strokeLinecap="round"
              strokeLinejoin="round"
              yAxisId="right" 
              name={btRorLineName} 
              isAnimationActive={false} 
              connectNulls
            />
          )}

          {showLiveEtRoRSeries && (
            <Line
              type="monotone"
              dataKey="et_ror"
              stroke="#59d2ff"
              strokeWidth={1.35}
              dot={false}
              strokeLinecap="round"
              strokeLinejoin="round"
              yAxisId="right"
              name={etRorLineName}
              isAnimationActive={false}
              connectNulls
            />
          )}

          {/* Highlight latest sample to improve live readability */}
          {latestLivePoint && (
            <>
              <ReferenceDot
                x={latestLivePoint.time}
                y={latestLivePoint.bt}
                yAxisId="left"
                r={2.8}
                fill="#ff6b6b"
                stroke="#0a1016"
                strokeWidth={1}
              />
              {hasLiveET && (
                <ReferenceDot
                  x={latestLivePoint.time}
                  y={latestLivePoint.et}
                  yAxisId="left"
                  r={2.8}
                  fill="#58a6ff"
                  stroke="#0a1016"
                  strokeWidth={1}
                />
              )}
              {displayBtRoR && (
                <ReferenceDot
                  x={latestLivePoint.time}
                  y={latestLivePoint.ror}
                  yAxisId="right"
                  r={2.4}
                  fill="#ffd84d"
                  stroke="#0a1016"
                  strokeWidth={1}
                />
              )}
              {displayEtRoR && (
                <ReferenceDot
                  x={latestLivePoint.time}
                  y={latestLivePoint.et_ror ?? 0}
                  yAxisId="right"
                  r={2.4}
                  fill="#59d2ff"
                  stroke="#0a1016"
                  strokeWidth={1}
                />
              )}
            </>
          )}

          {/* RoR Anomalies (Flick/Crash) */}
          {displayBtRoR && rorExtrema.map((point, i) => (
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
                strokeOpacity={0.75}
                strokeDasharray="3 3"
                label={labeledEventIndexes.has(index) ? {
                  value: displayEventLabel(event.label),
                  position: 'insideTopLeft',
                  fill: '#8ea0b3',
                  fontSize: 10,
                  offset: 8,
                  className: 'font-mono'
                } : undefined}
            />
          ))}

        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default RoastChart;
