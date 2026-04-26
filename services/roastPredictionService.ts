import { DataPoint, RoastEvent } from '../types';

type AppLanguage = 'zh-CN' | 'en';

export interface RoastPredictionRequest {
  apiUrl: string;
  apiKey?: string;
  model?: string;
  language: AppLanguage;
  points: DataPoint[];
  events: RoastEvent[];
}

export interface RoastPredictionResult {
  targetDropTempC?: number;
  targetDropTimeSec?: number;
  confidence?: number;
  reasoning: string;
  recommendations: string[];
  raw: unknown;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toStringValue(item))
    .filter((item): item is string => !!item);
}

function clamp01(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value > 1 && value <= 100 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = toFiniteNumber(source[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const parsed = toStringValue(source[key]);
    if (parsed) return parsed;
  }
  return undefined;
}

function pickStringList(source: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const parsed = toStringList(source[key]);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

function buildRoastSummary(points: DataPoint[], events: RoastEvent[]) {
  const last = points[points.length - 1];
  const rorTail = points.slice(Math.max(0, points.length - 8));
  const avgRoR =
    rorTail.length > 0
      ? rorTail.reduce((sum, point) => sum + point.ror, 0) / rorTail.length
      : 0;

  const firstCrackStart = events.find((evt) => evt.label === '一爆开始');
  const dryEnd = events.find((evt) => evt.label === '脱水结束');

  return {
    elapsedSec: Number(last?.time || 0),
    btC: Number(last?.bt || 0),
    etC: Number(last?.et || 0),
    btRor: Number(last?.ror || 0),
    etRor: Number(last?.et_ror || 0),
    avgRoRRecent: Number(avgRoR.toFixed(2)),
    dryEndSec: dryEnd ? Number(dryEnd.time.toFixed(2)) : null,
    firstCrackStartSec: firstCrackStart ? Number(firstCrackStart.time.toFixed(2)) : null,
    eventCount: events.length,
    pointCount: points.length
  };
}

function buildPointPayload(points: DataPoint[], limit = 180) {
  const tail = points.slice(-limit);
  return tail.map((point) => ({
    time: Number(point.time.toFixed(2)),
    bt: Number(point.bt.toFixed(2)),
    et: Number(point.et.toFixed(2)),
    ror: Number(point.ror.toFixed(2)),
    et_ror: Number((point.et_ror || 0).toFixed(2))
  }));
}

function buildEventPayload(events: RoastEvent[]) {
  return events
    .slice()
    .sort((a, b) => a.time - b.time)
    .map((event) => ({
      time: Number(event.time.toFixed(2)),
      label: event.label,
      temp: Number(event.temp.toFixed(2))
    }));
}

function normalizePrediction(raw: unknown, language: AppLanguage): RoastPredictionResult {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawCandidate =
    (root.prediction && typeof root.prediction === 'object' ? root.prediction : undefined) ||
    (root.data && typeof root.data === 'object' ? root.data : undefined) ||
    (root.result && typeof root.result === 'object' ? root.result : undefined) ||
    root;

  const candidate = rawCandidate as Record<string, unknown>;

  const targetDropTempC = pickNumber(candidate, [
    'targetDropTempC',
    'target_drop_temp_c',
    'targetTemp',
    'dropTemp',
    'drop_temperature'
  ]);
  const targetDropTimeSec = pickNumber(candidate, [
    'targetDropTimeSec',
    'target_drop_time_sec',
    'targetTimeSec',
    'dropTimeSec',
    'drop_time_sec'
  ]);
  const confidence = clamp01(
    pickNumber(candidate, ['confidence', 'confidenceScore', 'score', 'probability'])
  );

  const reasoning =
    pickString(candidate, ['reasoning', 'analysis', 'summary', 'message']) ||
    pickString(root, ['output_text', 'message']) ||
    (language === 'zh-CN'
      ? '已接收模型响应，但没有识别到标准字段。'
      : 'Model response received but no standard fields were recognized.');

  const recommendations = pickStringList(candidate, [
    'recommendations',
    'actions',
    'suggestions',
    'tips'
  ]);

  return {
    targetDropTempC,
    targetDropTimeSec,
    confidence,
    reasoning,
    recommendations,
    raw
  };
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  const rawText = await response.text();
  if (!rawText) return {};

  try {
    return JSON.parse(rawText);
  } catch {
    return { message: rawText };
  }
}

export async function requestRoastPrediction(request: RoastPredictionRequest): Promise<RoastPredictionResult> {
  const endpoint = request.apiUrl.trim();
  if (!endpoint) {
    throw new Error(request.language === 'zh-CN' ? '请先配置 AI 接口地址' : 'Please set AI endpoint URL first');
  }

  if (request.points.length < 8) {
    throw new Error(request.language === 'zh-CN' ? '当前烘焙数据太少，至少需要 8 个点' : 'Not enough roast data, at least 8 points are required');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  const apiKey = request.apiKey?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const payload = {
    task: 'coffee_roast_prediction',
    model: request.model?.trim() || 'gpt-4.1-mini',
    language: request.language,
    roast: {
      summary: buildRoastSummary(request.points, request.events),
      points: buildPointPayload(request.points),
      events: buildEventPayload(request.events)
    },
    expectedSchema: {
      targetDropTempC: 'number',
      targetDropTimeSec: 'number',
      confidence: '0~1 number',
      reasoning: 'string',
      recommendations: 'string[]'
    }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorPayload = await parseResponsePayload(response);
      const errorMessage =
        toStringValue((errorPayload as Record<string, unknown>).message) ||
        `${response.status} ${response.statusText}`;
      throw new Error(errorMessage);
    }

    const rawPayload = await parseResponsePayload(response);
    return normalizePrediction(rawPayload, request.language);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(request.language === 'zh-CN' ? 'AI 预测请求超时（30秒）' : 'AI prediction request timed out (30s)');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
