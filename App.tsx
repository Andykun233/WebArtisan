
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Square, Thermometer, AlertCircle, Terminal, RotateCcw, Loader2, Signal, Undo2, X, Download, FileInput, Bug, Wifi, Settings, Trash2 } from 'lucide-react';
import RoastChart from './components/RoastChart';
import StatCard from './components/StatCard';
import { WebSocketService } from './services/websocketService';
import { DataPoint, RoastStatus, RoastEvent } from './types';

const websocketService = new WebSocketService();

const ROR_CONFIG = {
  earlyWindowSeconds: 30,
  stableWindowSeconds: 50,
  minSpanSeconds: 8,
  minPoints: 5,
  smoothingAlpha: 0.35,
  deadband: 0.15,
  clampMin: -40,
  clampMax: 90,
};

type TimeValuePoint = { time: number; value: number };

// --- Utility: Linear Regression for Slope Calculation (Artisan Algorithm) ---
// Calculates the slope of the best-fit line through the data points using Least Squares.
// Returns slope (rate of change per unit time).
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

function getRoRLookbackWindow(currentTime: number): number {
  return currentTime < 120 ? ROR_CONFIG.earlyWindowSeconds : ROR_CONFIG.stableWindowSeconds;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeRawRoR(points: TimeValuePoint[]): number {
  if (points.length < ROR_CONFIG.minPoints) return 0;

  const span = points[points.length - 1].time - points[0].time;
  if (span < ROR_CONFIG.minSpanSeconds) return 0;

  const slope = calculateSlope(points);
  return slope * 60;
}

function smoothRoR(previous: number, raw: number): number {
  if (previous === 0) return raw;
  return previous * (1 - ROR_CONFIG.smoothingAlpha) + raw * ROR_CONFIG.smoothingAlpha;
}

function normalizeRoR(value: number): number {
  const clipped = clamp(value, ROR_CONFIG.clampMin, ROR_CONFIG.clampMax);
  const withDeadband = Math.abs(clipped) < ROR_CONFIG.deadband ? 0 : clipped;
  return parseFloat(withDeadband.toFixed(1));
}

const ET_PRESENT_THRESHOLD = 1.0;

function hasDetectedET(points: DataPoint[]): boolean {
  return points.some((p) => Number.isFinite(p.et) && p.et > ET_PRESENT_THRESHOLD);
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_]/.test(char);
}

function convertPythonLiteralToJson(literal: string): string {
  let out = "";
  let inSingleString = false;

  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i];

    if (inSingleString) {
      if (ch === "\\") {
        const next = literal[i + 1];
        if (next === undefined) {
          out += "\\\\";
          break;
        }

        if (next === "'") {
          out += "'";
          i++;
          continue;
        }

        if (next === '"') {
          out += '\\"';
          i++;
          continue;
        }

        out += `\\${next}`;
        i++;
        continue;
      }

      if (ch === '"') {
        out += '\\"';
        continue;
      }

      if (ch === "'") {
        out += '"';
        inSingleString = false;
        continue;
      }

      out += ch;
      continue;
    }

    if (ch === "'") {
      out += '"';
      inSingleString = true;
      continue;
    }

    if (
      ch === "T" &&
      literal.startsWith("True", i) &&
      !isWordChar(literal[i - 1]) &&
      !isWordChar(literal[i + 4])
    ) {
      out += "true";
      i += 3;
      continue;
    }

    if (
      ch === "F" &&
      literal.startsWith("False", i) &&
      !isWordChar(literal[i - 1]) &&
      !isWordChar(literal[i + 5])
    ) {
      out += "false";
      i += 4;
      continue;
    }

    if (
      ch === "N" &&
      literal.startsWith("None", i) &&
      !isWordChar(literal[i - 1]) &&
      !isWordChar(literal[i + 4])
    ) {
      out += "null";
      i += 3;
      continue;
    }

    out += ch;
  }

  return out;
}

function parseRoastObject(content: string, fileName: string): any {
  const text = content.trim();

  try {
    return JSON.parse(text);
  } catch (jsonErr) {
    // Artisan ALOG can be Python-literal-like dict text (single quotes + True/False)
    if (fileName.endsWith(".alog")) {
      try {
        const converted = convertPythonLiteralToJson(text);
        return JSON.parse(converted);
      } catch (alogErr) {
        throw new Error("ALOG 文件解析失败：格式不是标准 Artisan 导出内容。");
      }
    }

    throw jsonErr;
  }
}

// --- Utility: Batch Calculate RoR for Imported Data ---
// Uses dynamic lookback + EMA smoothing for better stability.
function recalculateRoR(data: DataPoint[]): DataPoint[] {
    let smoothedBT = 0;
    let smoothedET = 0;

    return data.map((point, index) => {
        const currentTime = point.time;
        const lookbackWindow = getRoRLookbackWindow(currentTime);

        const windowData = data
          .slice(Math.max(0, index - 180), index + 1)
          .filter(d => d.time > currentTime - lookbackWindow && d.time <= currentTime);

        const rawBT = computeRawRoR(windowData.map(d => ({ time: d.time, value: d.bt })));
        const rawET = computeRawRoR(windowData.map(d => ({ time: d.time, value: d.et })));

        smoothedBT = smoothRoR(smoothedBT, rawBT);
        smoothedET = smoothRoR(smoothedET, rawET);

        return {
          ...point,
          ror: normalizeRoR(smoothedBT),
          et_ror: normalizeRoR(smoothedET)
        };
    });
}

// --- Utility: Parse Roast Log (Shared Logic) ---
const parseRoastLog = (content: string, fileName: string): { data: DataPoint[], events: RoastEvent[] } => {
    let parsedData: DataPoint[] = [];
    let parsedEvents: RoastEvent[] = [];

    if (fileName.endsWith('.json') || fileName.endsWith('.alog')) {
        // JSON / ALOG Parsing
        const json = parseRoastObject(content, fileName);
        // Custom roaster-app JSON support: { dataList: [...], eventList: [...] }
        if (Array.isArray(json.dataList) && json.dataList.length > 0) {
            parsedData = json.dataList
                .map((item: any) => {
                    const timeVal = Number(item.duration ?? item.time);
                    const btVal = Number(item.bt ?? item.temp2 ?? item.bean ?? item.Bean);
                    const etVal = Number(item.et ?? item.temp1 ?? item.environment ?? item.Environment ?? 0);
                    const rorVal = Number(item.ror);

                    if (!Number.isFinite(timeVal) || !Number.isFinite(btVal)) return null;

                    return {
                        time: timeVal,
                        bt: btVal,
                        et: Number.isFinite(etVal) ? etVal : 0,
                        ror: Number.isFinite(rorVal) ? rorVal : 0,
                        et_ror: 0
                    } as DataPoint;
                })
                .filter((point: DataPoint | null): point is DataPoint => point !== null)
                .sort((a, b) => a.time - b.time);

            // Ignore preheat points before charge when both negative and non-negative timestamps exist.
            if (parsedData.some((p) => p.time < 0) && parsedData.some((p) => p.time >= 0)) {
                parsedData = parsedData.filter((p) => p.time >= 0);
            }

            if (Array.isArray(json.eventList)) {
                const eventCodeMap: {[key: number]: string} = {
                    1: '入豆',
                    2: '回温点',
                    3: '脱水结束',
                    4: '一爆开始',
                    5: '一爆结束',
                    6: '二爆开始',
                    7: '二爆结束',
                    8: '下豆'
                };

                parsedEvents = json.eventList
                    .map((evt: any) => {
                        const timeVal = Number(evt.time ?? evt.duration);
                        const codeVal = Number(evt.event);
                        if (!Number.isFinite(timeVal) || timeVal < 0 || codeVal === 0) return null;

                        let tempVal = Number(evt.temperature);
                        if (!Number.isFinite(tempVal) && parsedData.length > 0) {
                            const closest = parsedData.reduce((prev, curr) =>
                                Math.abs(curr.time - timeVal) < Math.abs(prev.time - timeVal) ? curr : prev
                            , parsedData[0]);
                            tempVal = closest.bt;
                        }

                        return {
                            time: timeVal,
                            label: eventCodeMap[codeVal] || `事件${codeVal}`,
                            temp: Number.isFinite(tempVal) ? tempVal : 0
                        } as RoastEvent;
                    })
                    .filter((evt: RoastEvent | null): evt is RoastEvent => evt !== null)
                    .sort((a, b) => a.time - b.time);
            }
        } else {
            // Support standard Artisan "timex", "temp1" (ET/BT), "temp2" (BT) structure
            let btArray: number[] = [];
            let etArray: number[] = [];
            let timeArray: number[] = [];

            // 1. Try to extract Temperature Arrays
            if (json.temps) {
                // Older or detailed format
                btArray = json.temps.Bean || json.temps.bean || [];
                etArray = json.temps.Environment || json.temps.environment || [];
                if (json.temps.x) timeArray = json.temps.x;
            } else {
                // Root level structure (Common in newer Artisan exports)
                btArray = json.temp2 || json.Bean || [];
                etArray = json.temp1 || json.Environment || [];
            }

            // 2. Try to extract Time Array
            if (json.timex && Array.isArray(json.timex)) {
                timeArray = json.timex;
            } else if (json.time && Array.isArray(json.time)) {
                timeArray = json.time;
            }

            // 3. Fallback: If no time, generate from index
            if (!timeArray || timeArray.length === 0) {
                if (btArray.length > 0) {
                    const interval = json.samplinginterval || 3.0;
                    timeArray = btArray.map((_: any, i: number) => i * interval);
                } else if (json.data && Array.isArray(json.data)) {
                    // Legacy format support
                    parsedData = json.data;
                    parsedEvents = json.events || [];
                }
            }

            // 4. Construct DataPoints if we parsed arrays
            if (parsedData.length === 0 && btArray.length > 0) {
                const len = Math.min(btArray.length, timeArray.length);
                for(let i = 0; i < len; i++) {
                    parsedData.push({
                        time: timeArray[i],
                        bt: btArray[i],
                        et: etArray[i] || 0,
                        ror: 0,
                        et_ror: 0
                    });
                }
            }

            // 5. Extract Events (Try 'computed' first for standard events)
            if (json.computed) {
                const c = json.computed;
                const eventMapping: {[key:string]: string} = {
                    'CHARGE_BT': '入豆',
                    'TP_time': '回温点',
                    'DRY_time': '脱水结束',
                    'FCs_time': '一爆开始',
                    'FCe_time': '一爆结束',
                    'SCs_time': '二爆开始',
                    'SCe_time': '二爆结束',
                    'DROP_time': '下豆'
                };

                for (const [key, label] of Object.entries(eventMapping)) {
                        if (c[key] !== undefined && c[key] > 0) {
                            if (key.endsWith('_time')) {
                                const t = c[key];
                                if (parsedData.length > 0) {
                                    const closest = parsedData.reduce((prev, curr) => 
                                        Math.abs(curr.time - t) < Math.abs(prev.time - t) ? curr : prev
                                    , parsedData[0]);
                                    parsedEvents.push({ time: t, label: label, temp: closest.bt });
                                } else {
                                    parsedEvents.push({ time: t, label: label, temp: 0 });
                                }
                            }
                            else if (key === 'CHARGE_BT') {
                                parsedEvents.push({ time: 0, label: label, temp: c[key] });
                            }
                        }
                }
            }
        }

    } else if (fileName.endsWith('.csv')) {
        // CSV Parsing
        const lines = content.split(/\r?\n/);
        
        // 1. Detect Header Line (Look for 'Time' or 'BT')
        let headerIdx = -1;
        for (let i = 0; i < Math.min(lines.length, 20); i++) {
            const lower = lines[i].toLowerCase();
            if (lower.includes('time') && (lower.includes('bt') || lower.includes('bean') || lower.includes('temp'))) {
                headerIdx = i;
                break;
            }
        }
        if (headerIdx === -1) throw new Error("CSV 中未找到表头 (Time/BT)");

        // 2. Detect Delimiter (comma, semicolon, tab)
        const headerLine = lines[headerIdx];
        const commaCount = (headerLine.match(/,/g) || []).length;
        const semiCount = (headerLine.match(/;/g) || []).length;
        const tabCount = (headerLine.match(/\t/g) || []).length;
        
        let delimiter = ',';
        if (tabCount > commaCount && tabCount > semiCount) delimiter = '\t';
        else if (semiCount > commaCount) delimiter = ';';

        const headers = headerLine.split(delimiter).map(h => h.trim().toLowerCase());
        
        const timeIdx = headers.findIndex(h => h.startsWith('time'));
        // BT usually 'BT', 'Bean', 'Temp2'
        const btIdx = headers.findIndex(h => h === 'bt' || h.includes('bean') || h === 'temp2');
        // ET usually 'ET', 'Env', 'Temp1'
        const etIdx = headers.findIndex(h => h === 'et' || h.includes('env') || h === 'temp1');
        const eventIdx = headers.findIndex(h => h.includes('event') || h.includes('事件'));

        if (btIdx === -1) throw new Error("CSV 中未找到豆温(BT)列");

        for(let i = headerIdx + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(delimiter);
            
            // Handle Time
            let timeVal = 0;
            if (timeIdx !== -1) {
                const tStr = parts[timeIdx].trim();
                if (tStr.includes(':')) {
                    // mm:ss format
                    const [m, s] = tStr.split(':').map(Number);
                    timeVal = (m * 60) + (s || 0);
                } else {
                    timeVal = parseFloat(tStr);
                }
            } else {
                // Fallback time if no column
                timeVal = i - headerIdx; 
            }

            const btVal = parseFloat(parts[btIdx]);
            const etVal = etIdx !== -1 ? parseFloat(parts[etIdx]) : 0;

            if (!isNaN(btVal)) {
                parsedData.push({
                    time: isNaN(timeVal) ? 0 : timeVal,
                    bt: btVal,
                    et: isNaN(etVal) ? 0 : etVal,
                    ror: 0, 
                    et_ror: 0
                });

                // Handle Event
                if (eventIdx !== -1 && parts[eventIdx]) {
                    const evtLabel = parts[eventIdx].trim();
                    if (evtLabel) {
                        // Map English labels to Chinese if needed
                        const labelMap: any = { 'CHARGE': '入豆', 'DRY END': '脱水结束', 'FC START': '一爆开始', 'FC END': '一爆结束', 'DROP': '下豆', 'TP': '回温点' };
                        const finalLabel = labelMap[evtLabel.toUpperCase()] || evtLabel;
                        parsedEvents.push({
                            time: timeVal,
                            label: finalLabel,
                            temp: btVal
                        });
                    }
                }
            }
        }
    } else {
        throw new Error("不支持的文件格式");
    }

    if (parsedData.length === 0) throw new Error("文件为空或解析失败");

    // Post-process: Recalculate RoR
    const processedData = recalculateRoR(parsedData);
    return { data: processedData, events: parsedEvents };
}


type ExportFormat = 'alog' | 'csv' | 'json';

const EXPORT_FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: 'alog', label: 'ALOG (.alog)' },
  { value: 'csv', label: 'CSV (.csv)' },
  { value: 'json', label: 'JSON (.json)' }
];

const EXPORT_EVENT_CODE_MAP: Record<string, number> = {
  '预热': 0,
  '入豆': 1,
  '回温点': 2,
  '脱水结束': 3,
  '一爆开始': 4,
  '一爆结束': 5,
  '二爆开始': 6,
  '二爆结束': 7,
  '下豆': 8
};

const EXPORT_EVENT_TOKEN_MAP: Record<string, string> = {
  '预热': 'P',
  '入豆': 'C',
  '回温点': 'TP',
  '脱水结束': 'DE',
  '一爆开始': 'FCs',
  '一爆结束': 'FCe',
  '二爆开始': 'SCs',
  '二爆结束': 'SCe',
  '下豆': 'D'
};

function normalizeExportBaseName(fileName: string): string {
  return fileName.replace(/\.(alog|csv|json)$/i, '').trim();
}

function toRoundedNumber(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function formatNumeric(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '';
  return toRoundedNumber(value, digits).toString();
}

function estimateSampleInterval(points: DataPoint[]): number {
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].time - points[i - 1].time;
    if (Number.isFinite(dt) && dt > 0 && dt <= 30) {
      deltas.push(dt);
    }
  }

  if (deltas.length === 0) return 1.0;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const median = deltas.length % 2 === 0 ? (deltas[mid - 1] + deltas[mid]) / 2 : deltas[mid];
  return toRoundedNumber(median, 3);
}

function findNearestPoint(points: DataPoint[], time: number): DataPoint | null {
  if (points.length === 0) return null;
  return points.reduce((prev, curr) =>
    Math.abs(curr.time - time) < Math.abs(prev.time - time) ? curr : prev
  );
}

function mapEventsToNearestIndexes(points: DataPoint[], roastEvents: RoastEvent[]): Map<number, RoastEvent[]> {
  const result = new Map<number, RoastEvent[]>();
  if (points.length === 0 || roastEvents.length === 0) return result;

  roastEvents.forEach((event) => {
    let nearestIdx = 0;
    let nearestDelta = Math.abs(points[0].time - event.time);
    for (let i = 1; i < points.length; i++) {
      const delta = Math.abs(points[i].time - event.time);
      if (delta < nearestDelta) {
        nearestDelta = delta;
        nearestIdx = i;
      }
    }
    const bucket = result.get(nearestIdx) || [];
    bucket.push(event);
    result.set(nearestIdx, bucket);
  });

  return result;
}

function toPythonLiteral(value: any): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? `${value}` : 'None';
  if (typeof value === 'string') {
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `'${escaped}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => toPythonLiteral(item)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${toPythonLiteral(k)}: ${toPythonLiteral(v)}`);
    return `{${entries.join(', ')}}`;
  }
  return 'None';
}

function buildComputedSummary(points: DataPoint[], roastEvents: RoastEvent[]) {
  const byLabel = (label: string) => roastEvents.find((event) => event.label === label);
  const charge = byLabel('入豆');
  const tp = byLabel('回温点');
  const dry = byLabel('脱水结束');
  const fcs = byLabel('一爆开始');
  const fce = byLabel('一爆结束');
  const scs = byLabel('二爆开始');
  const sce = byLabel('二爆结束');
  const drop = byLabel('下豆');
  const total = points.length > 0 ? points[points.length - 1].time : 0;

  const nearestTemp = (event?: RoastEvent) => {
    if (!event) return { bt: 0, et: 0 };
    const closest = findNearestPoint(points, event.time);
    return {
      bt: toRoundedNumber(closest?.bt ?? event.temp ?? 0, 1),
      et: toRoundedNumber(closest?.et ?? 0, 1)
    };
  };

  const chargeTemp = nearestTemp(charge);
  const tpTemp = nearestTemp(tp);
  const dryTemp = nearestTemp(dry);
  const fcsTemp = nearestTemp(fcs);
  const fceTemp = nearestTemp(fce);
  const scsTemp = nearestTemp(scs);
  const sceTemp = nearestTemp(sce);
  const dropTemp = nearestTemp(drop);

  return {
    CHARGE_ET: chargeTemp.et,
    CHARGE_BT: chargeTemp.bt,
    TP_time: toRoundedNumber(tp?.time ?? 0, 3),
    TP_ET: tpTemp.et,
    TP_BT: tpTemp.bt,
    DRY_time: toRoundedNumber(dry?.time ?? 0, 3),
    DRY_ET: dryTemp.et,
    DRY_BT: dryTemp.bt,
    FCs_time: toRoundedNumber(fcs?.time ?? 0, 3),
    FCs_ET: fcsTemp.et,
    FCs_BT: fcsTemp.bt,
    FCe_time: toRoundedNumber(fce?.time ?? 0, 3),
    FCe_ET: fceTemp.et,
    FCe_BT: fceTemp.bt,
    SCs_time: toRoundedNumber(scs?.time ?? 0, 3),
    SCs_ET: scsTemp.et,
    SCs_BT: scsTemp.bt,
    SCe_time: toRoundedNumber(sce?.time ?? 0, 3),
    SCe_ET: sceTemp.et,
    SCe_BT: sceTemp.bt,
    DROP_time: toRoundedNumber(drop?.time ?? 0, 3),
    DROP_ET: dropTemp.et,
    DROP_BT: dropTemp.bt,
    totaltime: toRoundedNumber(total, 3)
  };
}

function buildCsvExportContent(points: DataPoint[], roastEvents: RoastEvent[], sampleInterval: number): string {
  const eventMap = mapEventsToNearestIndexes(points, roastEvents);
  const metadataLine = JSON.stringify({
    temperatureUnit: 'C',
    sampleInterval,
    curveConfig: {
      hasFan: true,
      hasDrum: true,
      hasEt: true,
      hasInletTemp: false,
      powerRange: [0.0, 100.0],
      fanRange: [0.0, 100.0],
      drumRange: [0.0, 100.0],
      powerUnit: 1,
      fanSpeedUnit: 0,
      drumSpeedUnit: 0
    }
  });

  const header = 'time_seconds,bean_temp,env_temp,ror,event,power,fan,drum_speed';
  const rows = points.map((point, index) => {
    const eventsAtPoint = eventMap.get(index) || [];
    const eventToken = eventsAtPoint
      .map((event) => EXPORT_EVENT_TOKEN_MAP[event.label] || event.label)
      .join('|');

    return [
      formatNumeric(point.time, 3),
      formatNumeric(point.bt, 1),
      formatNumeric(point.et, 1),
      formatNumeric(point.ror, 1),
      eventToken,
      '',
      '',
      ''
    ].join(',');
  });

  return [metadataLine, header, ...rows].join('\n');
}

function buildJsonExportPayload(
  points: DataPoint[],
  roastEvents: RoastEvent[],
  fileBaseName: string,
  now: Date,
  sampleInterval: number
) {
  const eventMap = mapEventsToNearestIndexes(points, roastEvents);
  const sortedEvents = [...roastEvents].sort((a, b) => a.time - b.time);
  const duration = points.length > 0 ? points[points.length - 1].time : 0;
  const roastId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `wa-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

  const dataList = points.map((point, index) => {
    const rowEvent = (eventMap.get(index) || [])[0];
    const payload: any = {
      duration: toRoundedNumber(point.time, 3),
      bt: toRoundedNumber(point.bt, 1),
      et: toRoundedNumber(point.et, 1),
      ror: toRoundedNumber(point.ror, 1),
      rorTempUnit: 'C',
      rorPeriodSeconds: 60,
      roasterParams: [
        { key: 'HP', value: 0 },
        { key: 'FC', value: 0 },
        { key: 'TS', value: 0 },
        { key: 'RC', value: 0 }
      ]
    };

    const eventCode = rowEvent ? EXPORT_EVENT_CODE_MAP[rowEvent.label] : undefined;
    if (eventCode !== undefined) payload.event = eventCode;
    return payload;
  });

  const eventList = sortedEvents.map((event) => {
    const nearest = findNearestPoint(points, event.time);
    const eventCode = EXPORT_EVENT_CODE_MAP[event.label];
    const payload: any = {
      temperature: toRoundedNumber(nearest?.bt ?? event.temp ?? 0, 1),
      temperatureUnit: 'C',
      time: toRoundedNumber(event.time, 3)
    };
    if (eventCode !== undefined) payload.event = eventCode;
    return payload;
  });

  const dry = sortedEvents.find((e) => e.label === '脱水结束');
  const fcs = sortedEvents.find((e) => e.label === '一爆开始');
  const drop = sortedEvents.find((e) => e.label === '下豆');
  const phaseList: { phase: number; percentage: number; duration: number }[] = [];
  if (drop && drop.time > 0) {
    if (dry && dry.time > 0 && dry.time <= drop.time) {
      phaseList.push({
        phase: 2,
        percentage: toRoundedNumber(dry.time / drop.time, 6),
        duration: toRoundedNumber(dry.time, 3)
      });
    }
    if (dry && fcs && fcs.time >= dry.time && fcs.time <= drop.time) {
      phaseList.push({
        phase: 3,
        percentage: toRoundedNumber((fcs.time - dry.time) / drop.time, 6),
        duration: toRoundedNumber(fcs.time - dry.time, 3)
      });
    }
    if (fcs && fcs.time <= drop.time) {
      phaseList.push({
        phase: 4,
        percentage: toRoundedNumber((drop.time - fcs.time) / drop.time, 6),
        duration: toRoundedNumber(drop.time - fcs.time, 3)
      });
    }
  }

  return {
    id: roastId,
    name: fileBaseName,
    favorite: false,
    version: '1.0.1',
    sampleInterval,
    temperatureUnit: 'C',
    dateTime: now.toISOString().replace('Z', ''),
    duration: toRoundedNumber(duration, 3),
    dataList,
    eventList,
    phaseList,
    notes: '',
    channels: {}
  };
}

function buildAlogExportContent(
  points: DataPoint[],
  roastEvents: RoastEvent[],
  fileBaseName: string,
  now: Date,
  sampleInterval: number
): string {
  const computed = buildComputedSummary(points, roastEvents);
  const payload = {
    recording_version: '3.2.0',
    version: '3.2.0',
    mode: 'C',
    viewerMode: false,
    locale: 'zh_CN',
    title: fileBaseName,
    roastisodate: now.toISOString().slice(0, 10),
    roasttime: now.toTimeString().slice(0, 8),
    roastepoch: Math.floor(now.getTime() / 1000),
    samplinginterval: sampleInterval,
    timex: points.map((point) => toRoundedNumber(point.time, 3)),
    temp1: points.map((point) => toRoundedNumber(point.et, 1)),
    temp2: points.map((point) => toRoundedNumber(point.bt, 1)),
    computed
  };

  return toPythonLiteral(payload);
}

const App: React.FC = () => {
  const [status, setStatus] = useState<RoastStatus>(RoastStatus.IDLE);
  const [data, setData] = useState<DataPoint[]>([]);
  const [events, setEvents] = useState<RoastEvent[]>([]);
  
  // Background Data (Reference Curve)
  const [backgroundData, setBackgroundData] = useState<DataPoint[]>([]);
  const [backgroundEvents, setBackgroundEvents] = useState<RoastEvent[]>([]);

  const [startTime, setStartTime] = useState<number | null>(null);
  
  // Instant values for display. Initialized to 0.
  const [currentBT, setCurrentBT] = useState<number>(0);
  const [currentET, setCurrentET] = useState<number>(0);
  const [currentRoR, setCurrentRoR] = useState<number>(0.0);
  const [currentETRoR, setCurrentETRoR] = useState<number>(0.0);

  // New State: Track if we have received real data to prevent false positives on logic
  const [hasReceivedFirstData, setHasReceivedFirstData] = useState(false);

  // Debugging
  const [showRawLog, setShowRawLog] = useState(false);
  const [rawLogs, setRawLogs] = useState<string[]>([]);
  const rawLogsRef = useRef<string[]>([]);

  // Refs for stable access inside intervals without triggering re-renders. Initialized to 0.
  const btRef = useRef(0);
  const etRef = useRef(0);
  const swapBtEtRef = useRef(false);
  const dataRef = useRef<DataPoint[]>([]);
  const recentBtHistoryRef = useRef<TimeValuePoint[]>([]);
  const recentEtHistoryRef = useRef<TimeValuePoint[]>([]);
  const smoothedRoRRef = useRef<{ bt: number; et: number }>({ bt: 0, et: 0 });
  const lastSensorUpdateRef = useRef<number>(0);
  const backgroundInputRef = useRef<HTMLInputElement>(null);

  // Connection State
  const [isConnecting, setIsConnecting] = useState(false);
  const [activeService, setActiveService] = useState<'websocket' | 'simulation' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  // Simulation
  const [isSimulating, setIsSimulating] = useState(false);

  const hasLiveET = currentET > ET_PRESENT_THRESHOLD || hasDetectedET(data);
  const hasBackgroundET = hasDetectedET(backgroundData);
  const simulationIntervalRef = useRef<number | null>(null);

  // Undo Drop State
  const [showUndoDrop, setShowUndoDrop] = useState(false);
  const undoTimerRef = useRef<number | null>(null);

  // Export Modal State
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportFileName, setExportFileName] = useState("");
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [samplingIntervalSeconds, setSamplingIntervalSeconds] = useState<number>(3);
  const [swapBtEt, setSwapBtEt] = useState(false);
  const [showBtRoR, setShowBtRoR] = useState(true);
  const [showEtRoR, setShowEtRoR] = useState(true);
  
  // Mobile Event Panel State
  const [isMobileEventsExpanded, setIsMobileEventsExpanded] = useState(false);
  const [isCompactLandscape, setIsCompactLandscape] = useState(false);

  useEffect(() => {
    const updateCompactLandscape = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const isLandscape = vw > vh;
      const isTouchLike = window.matchMedia('(pointer: coarse)').matches || vw <= 1024;
      setIsCompactLandscape(isTouchLike && isLandscape && vh <= 560);
    };

    updateCompactLandscape();
    window.addEventListener('resize', updateCompactLandscape);
    window.addEventListener('orientationchange', updateCompactLandscape);

    return () => {
      window.removeEventListener('resize', updateCompactLandscape);
      window.removeEventListener('orientationchange', updateCompactLandscape);
    };
  }, []);

  useEffect(() => {
    swapBtEtRef.current = swapBtEt;
  }, [swapBtEt]);

  const handleDataUpdate = useCallback((bt: number, et: number) => {
    const mappedBT = swapBtEtRef.current ? et : bt;
    const mappedET = swapBtEtRef.current ? bt : et;
    // Update Refs for logic
    btRef.current = mappedBT;
    etRef.current = mappedET;
    lastSensorUpdateRef.current = Date.now();
    // Update State for UI
    setCurrentBT(mappedBT);
    setCurrentET(mappedET);
    setHasReceivedFirstData(true);
  }, []);

  const handleRawData = useCallback((raw: string) => {
      // Append to raw logs for debugging
      const timestamp = new Date().toLocaleTimeString().split(' ')[0];
      const logLine = `[${timestamp}] ${raw.trim()}`;
      
      // Limit log size to last 50 lines to prevent memory issues
      rawLogsRef.current = [logLine, ...rawLogsRef.current].slice(0, 50);
      setRawLogs([...rawLogsRef.current]);
  }, []);

  const handleDisconnect = useCallback(() => {
     setStatus(RoastStatus.IDLE);
     setIsSimulating(false);
     setDeviceName(null);
     setActiveService(null);
     setErrorMsg("设备连接已断开");
     setHasReceivedFirstData(false);
     
     // Reset values to 0 on disconnect
     setCurrentBT(0);
     setCurrentET(0);
     setCurrentRoR(0);
     setCurrentETRoR(0);
     btRef.current = 0;
     etRef.current = 0;
     recentBtHistoryRef.current = [];
     recentEtHistoryRef.current = [];
     smoothedRoRRef.current = { bt: 0, et: 0 };
     lastSensorUpdateRef.current = 0;
  }, []);

  const handleSwapBtEtChange = (enabled: boolean) => {
    setSwapBtEt(enabled);
    swapBtEtRef.current = enabled;

    // Swap currently displayed values immediately so UI reflects setting change at once.
    const prevBT = btRef.current;
    const prevET = etRef.current;
    btRef.current = prevET;
    etRef.current = prevBT;
    setCurrentBT(prevET);
    setCurrentET(prevBT);

    // Reset RoR windows to avoid a temporary spike caused by channel remap.
    recentBtHistoryRef.current = [];
    recentEtHistoryRef.current = [];
    smoothedRoRRef.current = { bt: 0, et: 0 };
  };

  // Handlers
  const handleWebSocketConnect = async () => {
    setIsConnecting(true);
    setRawLogs([]);
    rawLogsRef.current = [];

    const defaultIp = "请输入Roast32的IP地址";
    const input = window.prompt(
      "请输入设备 IP 地址（仅 IP）\n连接地址将固定为: ws://<IP>:80/ws",
      defaultIp
    );

    if (input === null) {
        setIsConnecting(false);
        return;
    }

    const raw = input.trim();
    if (!raw) {
        setErrorMsg("请输入设备 IP 地址");
        setIsConnecting(false);
        return;
    }

    // Allow pasting ws://... and normalize to fixed ws://<host>:80/ws
    const normalizedHost = raw
      .replace(/^wss?:\/\//i, '')
      .split('/')[0]
      .split(':')[0]
      .trim();

    if (!normalizedHost) {
        setErrorMsg("无效的设备 IP 地址");
        setIsConnecting(false);
        return;
    }

    const url = `ws://${normalizedHost}:80/ws`;

    try {
        setErrorMsg(null);
        const name = await websocketService.connect(
            url, 
            handleDataUpdate, 
            handleDisconnect, 
            handleRawData,
            (msg) => setErrorMsg(msg)
        );
        setDeviceName(name);
        setActiveService('websocket');
        setStatus(RoastStatus.CONNECTED); 
    } catch (err: any) {
        setErrorMsg(err.message || "WebSocket 连接失败");
    } finally {
        setIsConnecting(false);
    }
  };

  const handleStartRoast = () => {
    if (status !== RoastStatus.CONNECTED || !activeService) {
      setErrorMsg("请先连接设备，再开始烘焙");
      setTimeout(() => setErrorMsg(null), 2500);
      return;
    }

    const now = Date.now();
    setStartTime(now);
    lastSensorUpdateRef.current = now;
    
    // Reset Data but KEEP background data
    setData([]);
    dataRef.current = [];
    recentBtHistoryRef.current = [];
    recentEtHistoryRef.current = [];
    smoothedRoRRef.current = { bt: 0, et: 0 };
    
    setEvents([]);
    setStatus(RoastStatus.ROASTING);
    
    // Add START event manually since startTime state update is async
    const startEvent: RoastEvent = { time: 0, label: "开始", temp: btRef.current };
    setEvents([startEvent]);
  };

  const handleStopRoast = () => {
    setStatus(RoastStatus.FINISHED);
    handleEvent("下豆"); // Drop is a one-time final event

    // Trigger Undo UI
    setShowUndoDrop(true);
    
    // Auto hide undo after 5 seconds
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = window.setTimeout(() => {
        setShowUndoDrop(false);
    }, 5000);
  };

  const handleUndoDrop = () => {
    // 1. Clear timeout
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    
    // 2. Hide UI
    setShowUndoDrop(false);

    // 3. Revert Status (Resume Roasting)
    // The useEffect dependent on [status] will pick up where it left off
    setStatus(RoastStatus.ROASTING);

    // 4. Remove the "下豆" event
    setEvents(prev => {
        // Filter out the last event if it is "下豆"
        // Or strictly filter by label, but strictly speaking we just want to undo the last action
        const newEvents = [...prev];
        if (newEvents.length > 0 && newEvents[newEvents.length - 1].label === "下豆") {
            newEvents.pop();
        }
        return newEvents;
    });
  };

  const handleReset = async () => {
    // Clear any pending undo
    setShowUndoDrop(false);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);

    // Return to connected state only when a real service is still active.
    setStatus(activeService ? RoastStatus.CONNECTED : RoastStatus.IDLE);
    
    setData([]);
    dataRef.current = [];
    recentBtHistoryRef.current = [];
    recentEtHistoryRef.current = [];
    smoothedRoRRef.current = { bt: 0, et: 0 };
    setEvents([]);
    setStartTime(null);
    setCurrentRoR(0);
    setCurrentETRoR(0);
    
    // Optional: Clear background on reset? Maybe keep it.
    // setBackgroundData([]); 
  };

  // Close connections on unmount (cleanup)
  useEffect(() => {
      return () => {
          websocketService.disconnect();
      }
  }, []);

  // Keep mobile event panel compact outside roasting mode
  useEffect(() => {
    if (status !== RoastStatus.ROASTING) {
      setIsMobileEventsExpanded(false);
    }
  }, [status]);

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

  // --- Export Logic ---
  const handleOpenExportModal = () => {
      if (data.length === 0) {
          setErrorMsg("没有数据可导出");
          setTimeout(() => setErrorMsg(null), 3000);
          return;
      }
      const now = new Date();
      // Default name: roast_YYYYMMDD_HHMM
      const defaultName = `roast_${now.toISOString().slice(0,10).replace(/-/g,'')}_${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}`;
      setExportFileName(defaultName);
      setIsExportModalOpen(true);
  };

  const handleConfirmExport = (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (data.length === 0) {
          setErrorMsg("没有数据可导出");
          setTimeout(() => setErrorMsg(null), 3000);
          return;
      }

      setIsExportModalOpen(false);

      const now = new Date();
      const sampleInterval = estimateSampleInterval(data);
      const fallbackBaseName = `roast_${now.toISOString().slice(0,10).replace(/-/g,'')}`;
      const baseName = normalizeExportBaseName(exportFileName.trim()) || fallbackBaseName;

      let fileContent = '';
      let mimeType = 'text/plain;charset=utf-8;';

      if (exportFormat === 'csv') {
          fileContent = buildCsvExportContent(data, events, sampleInterval);
          mimeType = 'text/csv;charset=utf-8;';
      } else if (exportFormat === 'json') {
          const payload = buildJsonExportPayload(data, events, baseName, now, sampleInterval);
          fileContent = JSON.stringify(payload, null, 2);
          mimeType = 'application/json;charset=utf-8;';
      } else {
          fileContent = buildAlogExportContent(data, events, baseName, now, sampleInterval);
          mimeType = 'text/plain;charset=utf-8;';
      }

      const contentWithBom = exportFormat === 'csv' ? `\uFEFF${fileContent}` : fileContent;
      const blob = new Blob([contentWithBom], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      const finalName = `${baseName}.${exportFormat}`;
      link.setAttribute('download', finalName);
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setSuccessMsg(`导出成功：${finalName}`);
      setTimeout(() => setSuccessMsg(null), 3000);
  };

  // --- Import Logic ---
  const handleBackgroundClick = () => {
      if (backgroundInputRef.current) backgroundInputRef.current.click();
  };

  const handleClearBackground = () => {
      setBackgroundData([]);
      setBackgroundEvents([]);
      if (backgroundInputRef.current) backgroundInputRef.current.value = "";
      setSuccessMsg("已清除背景曲线");
      setTimeout(() => setSuccessMsg(null), 3000);
  };

  const handleBackgroundFile = (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      processImport(file, true);
  };

  const processImport = (file: File, isBackground: boolean) => {
      const reader = new FileReader();
      reader.onload = (e) => {
          const content = e.target?.result as string;
          try {
              const { data: parsedData, events: parsedEvents } = parseRoastLog(content, file.name);

              if (isBackground) {
                   setBackgroundData(parsedData);
                   setBackgroundEvents(parsedEvents);
                   setSuccessMsg(`已加载背景曲线: ${file.name}`);
              } else {
                   // Standard Import Mode
                   // 1. Stop simulations if any
                   if (isSimulating) toggleSimulation();
                   
                   // 2. Set State
                   setData(parsedData);
                   dataRef.current = parsedData; // Sync ref
                   recentBtHistoryRef.current = [];
                   recentEtHistoryRef.current = [];
                   setEvents(parsedEvents);
                   setStatus(RoastStatus.FINISHED); // View mode
                   setStartTime(null); // Static
                   
                   // 3. Update Display Values to end of roast
                   if (parsedData.length > 0) {
                       const last = parsedData[parsedData.length - 1];
                       setCurrentBT(last.bt);
                       setCurrentET(last.et);
                       setCurrentRoR(last.ror);
                       setCurrentETRoR(last.et_ror || 0);
                       smoothedRoRRef.current = { bt: last.ror, et: last.et_ror || 0 };
                       btRef.current = last.bt;
                       etRef.current = last.et;
                   }
                   setSuccessMsg(`成功导入: ${file.name}`);
              }

          } catch (err: any) {
              console.error("Import error", err);
              setErrorMsg((isBackground ? "背景加载失败: " : "导入失败: ") + (err.message || "文件格式错误"));
          } finally {
              // Reset inputs
              if (backgroundInputRef.current) backgroundInputRef.current.value = "";
          }
      };
      reader.readAsText(file);
  }

  // RoR Calculation and Data Recording
  useEffect(() => {
    if (status !== RoastStatus.ROASTING || !startTime) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const currentTime = (now - startTime) / 1000;
      const currentBTVal = btRef.current;
      const currentETVal = etRef.current;

      // Prevent stale points from distorting RoR if sensor stream pauses.
      if (!isSimulating && hasReceivedFirstData && lastSensorUpdateRef.current > 0) {
        const staleMs = now - lastSensorUpdateRef.current;
        const staleThresholdMs = Math.max(4000, samplingIntervalSeconds * 3000);
        if (staleMs > staleThresholdMs) {
          return;
        }
      }

      // Wait for first real packet before recording live roast (except simulation).
      if (!isSimulating && !hasReceivedFirstData) {
        return;
      }

      const lookbackWindow = getRoRLookbackWindow(currentTime);

      recentBtHistoryRef.current.push({ time: currentTime, value: currentBTVal });
      recentEtHistoryRef.current.push({ time: currentTime, value: currentETVal });

      while (recentBtHistoryRef.current.length > 0 && recentBtHistoryRef.current[0].time < currentTime - lookbackWindow) {
        recentBtHistoryRef.current.shift();
      }
      while (recentEtHistoryRef.current.length > 0 && recentEtHistoryRef.current[0].time < currentTime - lookbackWindow) {
        recentEtHistoryRef.current.shift();
      }

      const rawRoR = computeRawRoR(recentBtHistoryRef.current);
      const rawETRoR = computeRawRoR(recentEtHistoryRef.current);

      const smoothedBT = smoothRoR(smoothedRoRRef.current.bt, rawRoR);
      const smoothedET = smoothRoR(smoothedRoRRef.current.et, rawETRoR);

      const finalRoR = normalizeRoR(smoothedBT);
      const finalETRoR = normalizeRoR(smoothedET);

      smoothedRoRRef.current = { bt: finalRoR, et: finalETRoR };

      // Update UI
      setCurrentRoR(finalRoR);
      setCurrentETRoR(finalETRoR);

      // Create new DataPoint
      const newDataPoint: DataPoint = { 
        time: currentTime, 
        bt: currentBTVal, 
        et: currentETVal, 
        ror: finalRoR,
        et_ror: finalETRoR
      };

      // Update Ref
      dataRef.current = [...dataRef.current, newDataPoint];
      
      // Update State (triggers chart re-render)
      setData(dataRef.current);

    }, samplingIntervalSeconds * 1000);

    return () => clearInterval(interval);
  }, [status, startTime, hasReceivedFirstData, isSimulating, samplingIntervalSeconds]);

  // Simulation Logic
  const toggleSimulation = () => {
    if (isSimulating) {
        setIsSimulating(false);
        if (simulationIntervalRef.current) clearInterval(simulationIntervalRef.current);
        setStatus(RoastStatus.IDLE);
        setActiveService(null);
        setDeviceName(null);
    } else {
        setIsSimulating(true);
        setActiveService('simulation');
        setStatus(RoastStatus.CONNECTED); // Start Connected
        setDeviceName("模拟烘焙机 (Demo)");
        
        // Init physics vars
        let simBt = 150;
        let simEt = 200;
        handleDataUpdate(simBt, simEt);
        
        simulationIntervalRef.current = window.setInterval(() => {
            // Physics simulation
            const targetET = 240; 
            simEt += (targetET - simEt) * 0.05 + (Math.random() - 0.5);
            const delta = simEt - simBt;
            simBt += delta * 0.02; // Thermal mass

            handleDataUpdate(
              parseFloat(simBt.toFixed(1)),
              parseFloat(simEt.toFixed(1))
            );
        }, samplingIntervalSeconds * 1000);
    }
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
     if (data.length > 0 && status === RoastStatus.FINISHED) return formatTime(data[data.length-1].time * 1000);
     return "00:00";
  }

  const getElapsedSeconds = () => {
    if (status === RoastStatus.ROASTING && startTime) return Math.max(0, (Date.now() - startTime) / 1000);
    if (data.length > 0) return data[data.length - 1].time;
    return 0;
  };

  // Helper to check if event exists
  const hasEvent = (label: string) => events.some(e => e.label === label);

  // Define event buttons config
  const eventButtons = [
    { 
        label: "入豆", // Charge
        baseColor: "green",
        bgClass: "bg-emerald-600",
        borderClass: "border-emerald-500 text-emerald-400",
        action: () => handleToggleEvent("入豆"),
        disabled: false 
    },
    { 
        label: "脱水结束", // Dry End
        baseColor: "yellow",
        bgClass: "bg-amber-600",
        borderClass: "border-amber-500 text-amber-400",
        action: () => handleToggleEvent("脱水结束"),
        disabled: !hasEvent("入豆") 
    },
    { 
        label: "一爆开始", // FC Start
        baseColor: "red",
        bgClass: "bg-red-600",
        borderClass: "border-red-500 text-red-400",
        action: () => handleToggleEvent("一爆开始"),
        disabled: !hasEvent("入豆")
    },
    { 
        label: "一爆结束", // FC End
        baseColor: "red",
        bgClass: "bg-red-800",
        borderClass: "border-red-700 text-red-500",
        action: () => handleToggleEvent("一爆结束"),
        disabled: !hasEvent("一爆开始")
    },
    { 
        label: "二爆开始", // SC Start
        baseColor: "cyan",
        bgClass: "bg-cyan-700",
        borderClass: "border-cyan-600 text-cyan-400",
        action: () => handleToggleEvent("二爆开始"),
        disabled: !hasEvent("入豆")
    },
    { 
        label: "二爆结束", // SC End
        baseColor: "cyan",
        bgClass: "bg-cyan-900",
        borderClass: "border-cyan-800 text-cyan-600",
        action: () => handleToggleEvent("二爆结束"),
        disabled: !hasEvent("二爆开始")
    },
  ];

  const primaryMobileEventButtons = eventButtons.slice(0, 3);
  const secondaryMobileEventButtons = eventButtons.slice(3);
  const orderedEventLabels = ["入豆", "脱水结束", "一爆开始", "一爆结束", "二爆开始", "二爆结束"];
  const nextEventHint = orderedEventLabels.find(label => !hasEvent(label)) || "流程完成";
  const isDeviceConnected = activeService !== null;
  const hasBackgroundCurve = backgroundData.length > 0 || backgroundEvents.length > 0;
  const elapsedRoastSeconds = getElapsedSeconds();
  const firstCrackStartEvent = events.find((event) => event.label === "一爆开始");
  const showDevelopmentRatio = !!firstCrackStartEvent && elapsedRoastSeconds >= firstCrackStartEvent.time;
  const developmentRatio = showDevelopmentRatio
    ? Math.min(100, Math.max(0, ((elapsedRoastSeconds - firstCrackStartEvent!.time) / Math.max(elapsedRoastSeconds, 1e-6)) * 100))
    : 0;
  const showEtRoRSeries = showEtRoR && hasLiveET;
  const hasAnyRoRDisplay = showBtRoR || showEtRoRSeries;
  const mobileTickerColumnCount =
    2 +
    (hasLiveET ? 1 : 0) +
    (showBtRoR ? 1 : 0) +
    (showEtRoRSeries ? 1 : 0) +
    (showDevelopmentRatio ? 1 : 0);
  const mobileTickerGridClass =
    mobileTickerColumnCount <= 2
      ? 'grid-cols-2'
      : mobileTickerColumnCount === 3
        ? 'grid-cols-3'
        : mobileTickerColumnCount === 4
          ? 'grid-cols-4'
          : 'grid-cols-5';

  // Logic for status color
  const getStatusColor = () => {
      if (isConnecting) return 'status-dot-connecting live-pulse';
      if (isDeviceConnected) return 'status-dot-online';
      return 'status-dot-offline';
  };

  const getStatusText = () => {
      if (isConnecting) return '正在连接...';
      if (isDeviceConnected) return '设备在线';
      return '未连接';
  };

  const getModeText = () => {
      if (activeService === 'websocket') return 'WebSocket';
      if (activeService === 'simulation') return 'Simulation';
      return '未知';
  };

  return (
    <div className="app-shell h-[100dvh] w-full flex flex-col text-[#e6edf3]">
      
      {/* Hidden File Inputs */}
      <input 
        type="file" 
        ref={backgroundInputRef} 
        onChange={handleBackgroundFile} 
        className="hidden" 
        accept=".json,.alog,.csv"
      />

      {/* EXPORT MODAL */}
      {isExportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="panel-surface border rounded-lg shadow-2xl w-full max-w-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-[#2f3944] flex justify-between items-center bg-[#252f3a]/80">
                    <span className="font-bold text-gray-200 flex items-center gap-2">
                        <Download size={16} /> 导出记录
                    </span>
                    <button onClick={() => setIsExportModalOpen(false)} className="text-gray-500 hover:text-gray-300">
                        <X size={18} />
                    </button>
                </div>
                <form onSubmit={handleConfirmExport} className="p-4 flex flex-col gap-4">
                    <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1">文件名</label>
                        <div className="flex items-center">
                            <input 
                                type="text" 
                                value={exportFileName}
                                onChange={(e) => setExportFileName(e.target.value)}
                                className="flex-1 bg-[#111823] border border-[#3e4b5a] text-white px-3 py-2 text-sm rounded-l focus:outline-none focus:border-blue-500"
                                autoFocus
                            />
                            <div className="bg-[#28313d] border border-l-0 border-[#3e4b5a] text-gray-400 px-3 py-2 text-sm rounded-r">
                                .{exportFormat}
                            </div>
                        </div>
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1">导出格式</label>
                        <select
                            value={exportFormat}
                            onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                            className="w-full bg-[#111823] border border-[#3e4b5a] text-white px-3 py-2 text-sm rounded focus:outline-none focus:border-blue-500"
                        >
                            {EXPORT_FORMAT_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button 
                            type="button"
                            onClick={() => setIsExportModalOpen(false)}
                            className="toolbar-btn px-3 py-1.5 rounded text-sm font-bold text-gray-300"
                        >
                            取消
                        </button>
                        <button 
                            type="submit"
                            className="toolbar-btn toolbar-btn-primary px-4 py-1.5 rounded text-sm font-bold shadow-lg"
                        >
                            确认导出
                        </button>
                    </div>
                </form>
            </div>
        </div>
      )}

      {/* SETTINGS MODAL */}
      {isSettingsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="panel-surface border rounded-lg shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-[#2f3944] flex justify-between items-center bg-[#252f3a]/80">
              <span className="font-bold text-gray-200 flex items-center gap-2">
                <Settings size={16} /> 设置
              </span>
              <button onClick={() => setIsSettingsModalOpen(false)} className="text-gray-500 hover:text-gray-300">
                <X size={18} />
              </button>
            </div>
            <div className="p-4 flex flex-col gap-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">采样时间</label>
                <select
                  value={samplingIntervalSeconds}
                  onChange={(e) => setSamplingIntervalSeconds(Number(e.target.value))}
                  className="w-full bg-[#111823] border border-[#3e4b5a] text-white px-3 py-2 text-sm rounded focus:outline-none focus:border-blue-500"
                >
                  {[1, 2, 3, 4, 5].map((sec) => (
                    <option key={sec} value={sec}>
                      {sec} 秒
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-center justify-between rounded border border-[#31404f] bg-[#111823]/75 px-3 py-2 text-sm text-gray-200">
                <span>BT / ET 温度互换</span>
                <input
                  type="checkbox"
                  checked={swapBtEt}
                  onChange={(e) => handleSwapBtEtChange(e.target.checked)}
                  className="h-4 w-4 accent-blue-500"
                />
              </label>

              <label className="flex items-center justify-between rounded border border-[#31404f] bg-[#111823]/75 px-3 py-2 text-sm text-gray-200">
                <span>显示 BT RoR</span>
                <input
                  type="checkbox"
                  checked={showBtRoR}
                  onChange={(e) => setShowBtRoR(e.target.checked)}
                  className="h-4 w-4 accent-blue-500"
                />
              </label>

              <label className="flex items-center justify-between rounded border border-[#31404f] bg-[#111823]/75 px-3 py-2 text-sm text-gray-200">
                <span>显示 ET RoR</span>
                <input
                  type="checkbox"
                  checked={showEtRoR}
                  onChange={(e) => setShowEtRoR(e.target.checked)}
                  className="h-4 w-4 accent-blue-500"
                />
              </label>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setIsSettingsModalOpen(false)}
                  className="toolbar-btn toolbar-btn-primary px-4 py-1.5 rounded text-sm font-bold shadow-lg"
                >
                  完成
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 1. TOP TOOLBAR */}
      <div className="top-toolbar z-10 shrink-0">
        <div className={`${isCompactLandscape ? 'hidden' : 'hidden md:flex'} h-14 items-center justify-between px-4`}>
          <div className="flex items-center gap-4">
            <span className="font-semibold text-lg tracking-[0.12em] text-gray-200 flex items-center gap-1.5 uppercase">
              <Thermometer className="text-orange-400 w-5 h-5" />
              <span>Web</span><span className="text-orange-400">Artisan</span>
            </span>
            <div className="h-6 w-px bg-[#445262] mx-2"></div>

            {/* Connection Status Indicator */}
            <div className="group relative flex items-center gap-1.5 text-xs font-mono tracking-[0.12em] uppercase cursor-help py-2">
              <span className={`w-3 h-3 rounded-full transition-colors duration-300 ${getStatusColor()}`}></span>
              <span className="text-[#9fb0c2] transition-colors group-hover:text-white">{getStatusText()}</span>

              {/* Tooltip Popup */}
              <div className="absolute top-full left-0 mt-1 w-52 p-2.5 bg-[#0a1119]/95 backdrop-blur border border-[#425161] rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 text-[10px] text-gray-300 transform origin-top-left">
                <div className="font-bold text-white mb-1 border-b border-[#2c3a48] pb-1 tracking-wider">系统状态</div>
                  <div className="flex flex-col gap-1">
                  <div>
                    状态: <span className={isDeviceConnected ? 'text-green-400' : 'text-red-400'}>
                      {isConnecting ? '初始化中...' : isDeviceConnected ? '已就绪' : '等待连接'}
                    </span>
                  </div>
                  {isDeviceConnected && (
                    <>
                      <div>设备: {deviceName || '未知'}</div>
                      <div>模式: {getModeText()}</div>
                      <div className="flex items-center gap-1">信号: <Signal size={10} className="text-green-500"/> 强</div>
                    </>
                  )}
                  {!isDeviceConnected && !isConnecting && (
                    <div className="text-gray-500 italic">请点击右侧按钮连接设备</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-2 items-center">
            {status === RoastStatus.ROASTING ? (
              <button
                onClick={handleStopRoast}
                className="toolbar-btn toolbar-btn-danger shrink-0 px-3 md:px-4 py-1.5 rounded font-bold text-xs md:text-sm flex items-center gap-1 shadow-[0_0_10px_rgba(207,34,46,0.35)]"
              >
                <Square size={14} className="md:w-4 md:h-4" /> 下豆
              </button>
            ) : status === RoastStatus.FINISHED ? (
              <button
                onClick={handleReset}
                className="toolbar-btn shrink-0 px-3 py-1.5 rounded font-bold text-xs md:text-sm flex items-center gap-1"
              >
                <RotateCcw size={14} className="md:w-4 md:h-4" /> 重置
              </button>
            ) : (
              <button
                onClick={handleStartRoast}
                disabled={status !== RoastStatus.CONNECTED || isConnecting || !isDeviceConnected}
                className={`toolbar-btn toolbar-btn-success shrink-0 px-3 md:px-4 py-1.5 rounded font-bold text-xs md:text-sm flex items-center gap-1 ${
                  status !== RoastStatus.CONNECTED || isConnecting || !isDeviceConnected
                    ? 'opacity-45 cursor-not-allowed shadow-none'
                    : 'shadow-[0_0_10px_rgba(45,164,78,0.35)]'
                }`}
                title={status === RoastStatus.CONNECTED ? "开始烘焙" : "连接设备后可开始"}
              >
                <Play size={14} className="md:w-4 md:h-4" /> 开始
              </button>
            )}

            <button onClick={handleOpenExportModal} className="toolbar-btn shrink-0 p-1.5 md:px-2 md:py-1.5 rounded flex items-center gap-1" title="导出记录">
              <Download size={14} className="md:w-4 md:h-4" />
              <span className="hidden md:inline text-xs">导出</span>
            </button>
            <button onClick={handleBackgroundClick} className="toolbar-btn shrink-0 p-1.5 md:px-2 md:py-1.5 rounded flex items-center gap-1 mr-1 md:mr-2" title="加载背景曲线 (跟随烘焙)">
              <FileInput size={14} className="md:w-4 md:h-4" />
              <span className="hidden md:inline text-xs">背景</span>
            </button>
            <button
              onClick={handleClearBackground}
              disabled={!hasBackgroundCurve}
              className="toolbar-btn shrink-0 p-1.5 md:px-2 md:py-1.5 rounded flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
              title="清除背景曲线"
            >
              <Trash2 size={14} className="md:w-4 md:h-4" />
              <span className="hidden md:inline text-xs">清背景</span>
            </button>
            <button onClick={() => setIsSettingsModalOpen(true)} className="toolbar-btn shrink-0 p-1.5 md:px-2 md:py-1.5 rounded flex items-center gap-1" title="设置">
              <Settings size={14} className="md:w-4 md:h-4" />
              <span className="hidden md:inline text-xs">设置</span>
            </button>

            {!isDeviceConnected && (
              <button
                onClick={handleWebSocketConnect}
                disabled={isConnecting}
                className="toolbar-btn toolbar-btn-primary shrink-0 px-2 py-1.5 md:px-3 rounded font-bold text-xs md:text-sm flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
                title="连接 Artisan WebSocket (WiFi)"
              >
                {isConnecting ? (
                  <Loader2 size={14} className="animate-spin md:w-4 md:h-4" />
                ) : (
                  <Wifi size={14} className="md:w-4 md:h-4" />
                )}
                <span className="inline">{isConnecting ? '...' : 'WiFi'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Mobile Toolbar */}
        <div className={`${isCompactLandscape ? 'flex' : 'md:hidden'} px-2 ${isCompactLandscape ? 'py-1.5' : 'py-2'} flex flex-col ${isCompactLandscape ? 'gap-1.5' : 'gap-2'}`}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Thermometer className="text-orange-400 w-4 h-4 shrink-0" />
              <div className="min-w-0">
                <div className="text-[11px] font-semibold tracking-[0.1em] uppercase text-gray-200 truncate">
                  Web<span className="text-orange-400">Artisan</span>
                </div>
                <div className="text-[9px] text-[#8ea0b3] font-mono truncate">
                  {!isDeviceConnected
                    ? (data.length > 0 ? '回放模式（未连接设备）' : '设备未连接')
                    : `${deviceName || '设备在线'} · ${getModeText()}`}
                </div>
              </div>
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${getStatusColor()}`}></span>
            </div>

            {status === RoastStatus.ROASTING ? (
              <button
                onClick={handleStopRoast}
                className="toolbar-btn toolbar-btn-danger shrink-0 px-3 py-1.5 rounded font-bold text-xs flex items-center gap-1 shadow-[0_0_8px_rgba(207,34,46,0.35)]"
              >
                <Square size={13} /> 下豆
              </button>
            ) : status === RoastStatus.FINISHED ? (
              <button
                onClick={handleReset}
                className="toolbar-btn shrink-0 px-3 py-1.5 rounded font-bold text-xs flex items-center gap-1"
              >
                <RotateCcw size={13} /> 重置
              </button>
            ) : (
              <button
                onClick={handleStartRoast}
                disabled={status !== RoastStatus.CONNECTED || isConnecting || !isDeviceConnected}
                className={`toolbar-btn toolbar-btn-success shrink-0 px-3 py-1.5 rounded font-bold text-xs flex items-center gap-1 ${
                  status !== RoastStatus.CONNECTED || isConnecting || !isDeviceConnected
                    ? 'opacity-45 cursor-not-allowed shadow-none'
                    : 'shadow-[0_0_8px_rgba(45,164,78,0.35)]'
                }`}
              >
                <Play size={13} /> 开始
              </button>
            )}
          </div>

          {!isDeviceConnected ? (
            <div className="grid grid-cols-1 gap-1.5">
              <button
                onClick={handleWebSocketConnect}
                disabled={isConnecting}
                className="toolbar-btn py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1 disabled:opacity-45"
              >
                {isConnecting ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />}
                WiFi
              </button>
            </div>
          ) : (
            <div className="px-2 py-1.5 rounded-md border border-[#31404f] bg-[#111823]/70 text-[10px] text-[#8ea0b3] font-mono flex items-center justify-between">
              <span className="truncate max-w-[62%]">设备: {deviceName || '未知设备'}</span>
              <span>{getStatusText()}</span>
            </div>
          )}

          <div className="grid grid-cols-4 gap-1.5">
            <button onClick={handleOpenExportModal} className="toolbar-btn py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1">
              <Download size={12} /> 导出
            </button>
            <button onClick={handleBackgroundClick} className="toolbar-btn py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1">
              <FileInput size={12} /> 背景
            </button>
            <button
              onClick={handleClearBackground}
              disabled={!hasBackgroundCurve}
              className="toolbar-btn py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1 disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <Trash2 size={12} /> 清背景
            </button>
            <button onClick={() => setIsSettingsModalOpen(true)} className="toolbar-btn py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1">
              <Settings size={12} /> 设置
            </button>
          </div>
        </div>
      </div>

      {/* NOTIFICATIONS */}
      {errorMsg && (
        <div className="notice-error text-white px-4 py-2 text-xs md:text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
            <AlertCircle size={14} /> {errorMsg}
        </div>
      )}
      {successMsg && (
        <div className="notice-success text-white px-4 py-2 text-xs md:text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
            <Signal size={14} /> {successMsg}
        </div>
      )}

      {/* 2. MAIN WORKSPACE */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative min-h-0">
        
        {/* Undo Drop Toast */}
        {showUndoDrop && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-top-4 fade-in duration-300">
                <div className="panel-surface border border-[#cf4f59] rounded-md shadow-2xl p-3 flex items-center gap-3">
                    <div className="flex flex-col">
                        <span className="text-white font-bold text-sm">已下豆 (Roast Finished)</span>
                        <span className="text-gray-400 text-xs">烘焙已完成。误操作？</span>
                    </div>
                    <div className="h-6 w-px bg-gray-600/80"></div>
                    <button 
                        onClick={handleUndoDrop}
                        className="toolbar-btn toolbar-btn-danger flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded"
                    >
                        <Undo2 size={14} /> 撤销
                    </button>
                    <button 
                        onClick={() => setShowUndoDrop(false)}
                        className="text-gray-500 hover:text-gray-300"
                    >
                        <X size={16} />
                    </button>
                </div>
            </div>
        )}

        {/* DESKTOP LEFT SIDEBAR: Large LCD Displays - HIDDEN ON MOBILE */}
        <div className={`
            ${isCompactLandscape ? 'hidden' : 'hidden md:flex'} panel-surface border-r 
            ${isCompactLandscape ? 'w-44 p-2 gap-1.5' : 'w-64 p-3 gap-2'}
            flex-col overflow-y-auto shrink-0 no-scrollbar
        `}>
            <div className={`${isCompactLandscape ? 'mb-1.5 pb-1.5 text-[10px]' : 'mb-2 pb-2 text-[11px]'} border-b border-[#31404f] font-semibold text-[#8ea0b3] uppercase tracking-[0.15em]`}>实时温度</div>
            <StatCard compact={isCompactLandscape} label="Bean Temp" value={currentBT.toFixed(1)} unit="°C" color="red" />
            {hasLiveET && <StatCard compact={isCompactLandscape} label="Env Temp" value={currentET.toFixed(1)} unit="°C" color="blue" />}
            
            {hasAnyRoRDisplay && (
              <>
                <div className={`${isCompactLandscape ? 'my-1.5 pb-1.5 text-[10px]' : 'my-2 pb-2 text-[11px]'} border-b border-[#31404f] font-semibold text-[#8ea0b3] uppercase tracking-[0.15em]`}>温升率</div>
                {showBtRoR && <StatCard compact={isCompactLandscape} label="BT RoR" value={currentRoR.toFixed(1)} unit="°/min" color="yellow" />}
                {showEtRoRSeries && <StatCard compact={isCompactLandscape} label="ET RoR" value={currentETRoR.toFixed(1)} unit="°/min" color="cyan" />}
              </>
            )}
            
            <div className={`${isCompactLandscape ? 'my-1.5 pb-1.5 text-[10px]' : 'my-2 pb-2 text-[11px]'} border-b border-[#31404f] font-semibold text-[#8ea0b3] uppercase tracking-[0.15em]`}>时间</div>
            <StatCard compact={isCompactLandscape} label="TIME" value={getDuration()} color="green" />
            {showDevelopmentRatio && (
              <StatCard
                compact={isCompactLandscape}
                label="发展率 DTR"
                value={developmentRatio.toFixed(1)}
                unit="%"
                color="cyan"
              />
            )}
        </div>

        {/* CENTER COLUMN: Chart + Mobile Ticker */}
        <div className="flex-1 bg-[#131920]/80 flex flex-col relative min-h-0">
            
            {/* MOBILE ONLY: Data Ticker */}
            <div className={`${isCompactLandscape ? 'grid h-11' : 'md:hidden grid h-12'} panel-surface border-b ${mobileTickerGridClass} gap-1 px-1.5 py-1 shrink-0 z-10`}>
               <div className="rounded bg-[#0f151d]/70 border border-[#263444] flex flex-col items-center justify-center">
                  <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-wide">BT</span>
                  <span className="text-sm font-mono font-bold text-[#ff6b6b] leading-none">{currentBT.toFixed(1)}</span>
               </div>
               {hasLiveET && (
                 <div className="rounded bg-[#0f151d]/70 border border-[#263444] flex flex-col items-center justify-center">
                    <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-wide">ET</span>
                    <span className="text-sm font-mono font-bold text-[#58a6ff] leading-none">{currentET.toFixed(1)}</span>
                 </div>
               )}
               {showBtRoR && (
                 <div className="rounded bg-[#0f151d]/70 border border-[#263444] flex flex-col items-center justify-center">
                    <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-wide">BT RoR</span>
                    <span className="text-sm font-mono font-bold text-[#ffd84d] leading-none">{currentRoR.toFixed(1)}</span>
                 </div>
               )}
               {showEtRoRSeries && (
                 <div className="rounded bg-[#0f151d]/70 border border-[#263444] flex flex-col items-center justify-center">
                    <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-wide">ET RoR</span>
                    <span className="text-sm font-mono font-bold text-[#59d2ff] leading-none">{currentETRoR.toFixed(1)}</span>
                 </div>
               )}
               {showDevelopmentRatio && (
                 <div className="rounded bg-[#0f151d]/70 border border-[#263444] flex flex-col items-center justify-center">
                    <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-wide">DTR</span>
                    <span className="text-sm font-mono font-bold text-[#59d2ff] leading-none">{developmentRatio.toFixed(1)}%</span>
                 </div>
               )}
               <div className="rounded bg-[#0f151d]/70 border border-[#263444] flex flex-col items-center justify-center">
                  <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-wide">时间</span>
                  <span className="text-[11px] font-mono font-bold text-[#4adf8f] leading-none">{getDuration()}</span>
               </div>
            </div>

            <div className={`flex-1 ${isCompactLandscape ? 'p-0.5' : 'p-0 md:p-1 md:pb-0'} relative min-h-0`}>
                <RoastChart 
                    data={data} 
                    events={events} 
                    currentBT={currentBT}
                    currentET={currentET}
                    currentRoR={currentRoR}
                    currentETRoR={currentETRoR}
                    backgroundData={backgroundData}
                    showLiveET={hasLiveET}
                    showBackgroundET={hasBackgroundET}
                    showBtRoR={showBtRoR}
                    showEtRoR={showEtRoRSeries}
                    compactMode={isCompactLandscape}
                />
            </div>
        </div>

        {/* RIGHT COLUMN: Controls & Events */}
        {/* Mobile: Bottom Grid | Desktop: Right Sidebar */}
        <div className={`
            w-full ${isCompactLandscape ? 'md:w-40 p-1.5' : 'md:w-48 p-2'} panel-surface border-t md:border-t-0 md:border-l
            flex flex-col md:flex-col gap-2 shrink-0 
            pb-safe md:pb-2 z-20
            ${isCompactLandscape ? 'overflow-y-auto no-scrollbar' : ''}
        `}>
             {/* Mobile Event Layout: Primary events + expandable secondary events */}
             <div className="md:hidden flex flex-col gap-1.5 mb-safe-offset">
                 <div className="flex items-center justify-between px-0.5">
                     <div className="text-[10px] font-semibold text-[#8ea0b3] uppercase tracking-[0.14em]">事件快捷</div>
                     <div className="flex items-center gap-1.5">
                         <span className="text-[9px] text-[#6e8398] font-mono">
                           {status === RoastStatus.ROASTING ? `下一步: ${nextEventHint}` : "待机"}
                         </span>
                         <button
                           onClick={() => setIsMobileEventsExpanded(prev => !prev)}
                           className="toolbar-btn text-[9px] px-2 py-1 rounded text-gray-300"
                         >
                           {isMobileEventsExpanded ? "收起事件" : "更多事件"}
                         </button>
                     </div>
                 </div>

                 <div className="grid grid-cols-3 gap-1.5">
                     {primaryMobileEventButtons.map((btn) => {
                         const isActive = hasEvent(btn.label);

                         return (
                           <button
                             key={`${btn.label}-mobile-primary`}
                             onClick={btn.action}
                             disabled={status !== RoastStatus.ROASTING || btn.disabled}
                             className={`
                               w-full py-2.5 font-semibold text-[10px] rounded-md transition-all border select-none active:scale-95 touch-manipulation tracking-wide
                               ${status !== RoastStatus.ROASTING || btn.disabled
                                 ? 'bg-[#262e37] text-[#5d6a79] border-[#2e3844] shadow-none'
                                 : isActive
                                   ? `${btn.bgClass} text-white border-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_8px_14px_rgba(0,0,0,0.25)]`
                                   : `bg-[#1a2129]/70 ${btn.borderClass} hover:bg-[#23303d] active:bg-[#2a3644]`
                               }
                             `}
                           >
                             {btn.label}
                           </button>
                         );
                     })}
                 </div>

                 {isMobileEventsExpanded && (
                   <div className="grid grid-cols-3 gap-1.5 pt-0.5">
                     {secondaryMobileEventButtons.map((btn) => {
                       const isActive = hasEvent(btn.label);

                       return (
                         <button
                           key={`${btn.label}-mobile-secondary`}
                           onClick={btn.action}
                           disabled={status !== RoastStatus.ROASTING || btn.disabled}
                           className={`
                             w-full py-2.5 font-semibold text-[10px] rounded-md transition-all border select-none active:scale-95 touch-manipulation tracking-wide
                             ${status !== RoastStatus.ROASTING || btn.disabled
                               ? 'bg-[#262e37] text-[#5d6a79] border-[#2e3844] shadow-none'
                               : isActive
                                 ? `${btn.bgClass} text-white border-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_8px_14px_rgba(0,0,0,0.25)]`
                                 : `bg-[#1a2129]/70 ${btn.borderClass} hover:bg-[#23303d] active:bg-[#2a3644]`
                             }
                           `}
                         >
                           {btn.label}
                         </button>
                       );
                     })}
                   </div>
                 )}
             </div>

             <div className={`hidden md:block ${isCompactLandscape ? 'text-[10px] mb-0.5' : 'text-[11px] mb-1'} font-semibold text-[#8ea0b3] uppercase tracking-[0.15em] text-center`}>事件标记</div>
             <div className={isCompactLandscape ? 'hidden md:grid md:grid-cols-2 gap-1.5' : 'hidden md:flex md:flex-col gap-2'}>
                 {eventButtons.map((btn) => {
                     const isActive = hasEvent(btn.label);

                     return (
                       <button
                         key={`${btn.label}-desktop`}
                         onClick={btn.action}
                         disabled={status !== RoastStatus.ROASTING || btn.disabled}
                         className={`
                           w-full ${isCompactLandscape ? 'py-2 text-[11px]' : 'py-3 text-xs'} font-semibold rounded-md transition-all border select-none active:scale-95 touch-manipulation tracking-wide
                           ${status !== RoastStatus.ROASTING || btn.disabled
                             ? 'bg-[#262e37] text-[#5d6a79] border-[#2e3844] shadow-none'
                             : isActive
                               ? `${btn.bgClass} text-white border-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_8px_14px_rgba(0,0,0,0.25)]`
                               : `bg-[#1a2129]/70 ${btn.borderClass} hover:bg-[#23303d] active:bg-[#2a3644]`
                           }
                         `}
                       >
                         {btn.label}
                       </button>
                     );
                 })}
             </div>

             {/* Event Log / Debug Terminal */}
             <div className={`${isCompactLandscape ? 'hidden' : 'hidden md:flex'} mt-auto border-t border-[#31404f] pt-3 flex-col gap-2`}>
                 <div className="text-[10px] font-semibold text-[#7d8ea0] uppercase tracking-[0.12em] flex items-center justify-between px-1">
                    <span className="flex items-center gap-2">
                        {showRawLog ? <Bug size={10} className="text-orange-400" /> : <Terminal size={10} />}
                        {showRawLog ? "原始数据 (RAW)" : "事件日志 (LOG)"}
                    </span>
                    <button 
                        onClick={() => setShowRawLog(!showRawLog)} 
                        className="toolbar-btn text-[9px] px-1.5 py-0.5 rounded text-gray-300"
                        title="切换视图"
                    >
                        {showRawLog ? "查看事件" : "查看数据"}
                    </button>
                 </div>
                 
                 <div className="h-48 bg-[#0b1117]/85 border border-[#31404f] rounded-md overflow-y-auto custom-scrollbar shadow-inner relative">
                    
                    {/* View: Events List */}
                    {!showRawLog && (
                        <>
                        {events.length === 0 && (
                            <div className="absolute inset-0 flex items-center justify-center text-[#3d4b5a] text-[10px] italic">
                                等待记录...
                            </div>
                        )}
                        <div className="flex flex-col">
                            {events.map((e, i) => (
                                <div key={i} className="flex items-center justify-between p-2 border-b border-[#1a2530] hover:bg-[#122030] transition-colors group">
                                    <div className="flex flex-col">
                                        <span className="text-[#dde7f1] font-semibold text-[10px] group-hover:text-white transition-colors">
                                            {e.label}
                                        </span>
                                        <span className="text-[#5f7183] text-[9px] group-hover:text-[#8ca0b4] transition-colors font-mono">
                                            @ {e.temp.toFixed(1)}°C
                                        </span>
                                    </div>
                                    <span className="text-[#58a6ff] font-mono text-[10px] bg-[#58a6ff]/10 px-1.5 py-0.5 rounded border border-[#58a6ff]/25">
                                        {formatTime(e.time * 1000)}
                                    </span>
                                </div>
                            )).reverse()}
                        </div>
                        </>
                    )}

                    {/* View: Raw Data Log */}
                    {showRawLog && (
                        <div className="flex flex-col p-2 font-mono text-[10px] text-[#9badbf]">
                             {rawLogs.length === 0 && (
                                <div className="text-center italic text-[#3d4b5a] mt-10">暂无数据...<br/>请连接设备</div>
                            )}
                            {rawLogs.map((log, i) => (
                                <div key={i} className="border-b border-[#1a2530] py-0.5 break-all">
                                    {log}
                                </div>
                            ))}
                        </div>
                    )}

                 </div>
             </div>
        </div>
      </div>
    </div>
  );
};

export default App;
