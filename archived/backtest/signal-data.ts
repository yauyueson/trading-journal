import type { BacktestCandle } from './types';
import type { EntrySignal, SignalPresetKey } from './option-sim';
import { SIGNAL_PRESETS, isPullbackPreset } from './types';
import { precomputeSignals } from './engine';
import { computeIVRankMinMax } from './iv-rank';
import { calculatePullbackSignal, type PullbackOptions } from '../tech-analysis';
import { computeFrontBackIVAnomaly, getCachedChain } from './chain-cache';

export interface TickerData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  recentMaxGapPct10: (number | undefined)[];
  dateToIdx: Map<string, number>;
  regimeByDate: Map<string, {
    vrp?: number;
    contango?: number;
    slope?: number;
    vrpPct?: number;
    contangoPct?: number;
  }>;
}

const candleCache = new Map<string, TickerData>();
const anomalyCache = new Map<string, number | null>();

function supabaseUrl(): string {
  return process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
}

function supabaseKey(): string {
  return process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
}

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${table}?${query}`, {
    headers: { apikey: supabaseKey(), Authorization: `Bearer ${supabaseKey()}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

function computeRollingPercentile(values: (number | undefined)[], window = 252): (number | undefined)[] {
  return values.map((value, index) => {
    if (value == null || !Number.isFinite(value)) return undefined;
    const start = Math.max(0, index - window);
    const sample = values
      .slice(start, index + 1)
      .filter((entry): entry is number => entry != null && Number.isFinite(entry));
    if (sample.length < 60) return undefined;
    const lessOrEqual = sample.filter(entry => entry <= value).length;
    return (lessOrEqual / sample.length) * 100;
  });
}

function computeRecentMaxGapPct(
  candles: BacktestCandle[],
  lookback = 10,
): (number | undefined)[] {
  const gaps: (number | undefined)[] = candles.map((candle, index) => {
    if (index === 0) return undefined;
    const prevClose = candles[index - 1]?.close;
    if (!prevClose || !Number.isFinite(prevClose) || prevClose <= 0) return undefined;
    return Math.abs((candle.open - prevClose) / prevClose) * 100;
  });

  return candles.map((_, index) => {
    const start = Math.max(1, index - lookback + 1);
    const sample = gaps
      .slice(start, index + 1)
      .filter((gap): gap is number => gap != null && Number.isFinite(gap));
    if (sample.length === 0) return undefined;
    return Math.max(...sample);
  });
}

export async function fetchTickerData(
  ticker: string,
  dataStart: string,
  dataEnd: string,
): Promise<TickerData> {
  const cacheKey = `${ticker}|${dataStart}|${dataEnd}`;
  const cached = candleCache.get(cacheKey);
  if (cached) return cached;

  const candles: BacktestCandle[] = (await supabaseGet(
    'stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${dataStart}&date=lte.${dataEnd}&order=date.asc&limit=5000`,
  )).map(row => ({
    date: row.date,
    timestamp: new Date(`${row.date}T00:00:00Z`).getTime(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));

  const ivData = await supabaseGet(
    'orats_iv_cache',
    `select=date,iv30d,iv60d,hv30d&ticker=eq.${ticker}&date=gte.${dataStart}&date=lte.${dataEnd}&order=date.asc&limit=5000`,
  );

  let coresData: { trade_date: string; slope: number | null }[] = [];
  try {
    coresData = await supabaseGet(
      'orats_cores_cache',
      `select=trade_date,slope&ticker=eq.${ticker}&trade_date=gte.${dataStart}&trade_date=lte.${dataEnd}&order=trade_date.asc&limit=5000`,
    );
  } catch {
    coresData = [];
  }

  const ivByDate = new Map(ivData.map((row: any) => [row.date, Number(row.iv30d)]));
  const regimeByDate = new Map<string, {
    vrp?: number;
    contango?: number;
    slope?: number;
    vrpPct?: number;
    contangoPct?: number;
  }>();
  const slopeByDate = new Map<string, number>();
  const contangoByDate = new Map<string, number>();
  const vrpByDate = new Map<string, number>();

  for (const row of coresData) {
    if (row.slope != null && Number.isFinite(row.slope)) {
      slopeByDate.set(row.trade_date, Number(row.slope));
    }
  }

  for (const row of ivData as any[]) {
    const iv30 = Number(row.iv30d);
    const iv60 = Number(row.iv60d);
    const hv30 = Number(row.hv30d);
    const contango = Number.isFinite(iv30) && iv30 > 0 && Number.isFinite(iv60)
      ? (iv60 / iv30) - 1
      : undefined;
    const vrp = Number.isFinite(iv30) && Number.isFinite(hv30)
      ? (iv30 * iv30) - (hv30 * hv30)
      : undefined;
    if (contango != null) contangoByDate.set(row.date, contango);
    if (vrp != null) vrpByDate.set(row.date, vrp);
  }

  const orderedDates = candles.map(candle => candle.date);
  const contangoPctSeries = computeRollingPercentile(orderedDates.map(date => contangoByDate.get(date)));
  const vrpPctSeries = computeRollingPercentile(orderedDates.map(date => vrpByDate.get(date)));
  const contangoPctByDate = new Map<string, number>();
  const vrpPctByDate = new Map<string, number>();

  for (let index = 0; index < orderedDates.length; index += 1) {
    const contangoPct = contangoPctSeries[index];
    const vrpPct = vrpPctSeries[index];
    if (contangoPct != null) contangoPctByDate.set(orderedDates[index], contangoPct);
    if (vrpPct != null) vrpPctByDate.set(orderedDates[index], vrpPct);
  }

  for (const row of ivData as any[]) {
    regimeByDate.set(row.date, {
      vrp: vrpByDate.get(row.date),
      contango: contangoByDate.get(row.date),
      slope: slopeByDate.get(row.date),
      vrpPct: vrpPctByDate.get(row.date),
      contangoPct: contangoPctByDate.get(row.date),
    });
  }

  const ivSeries = candles.map(candle => ivByDate.get(candle.date) ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);
  const recentMaxGapPct10 = computeRecentMaxGapPct(candles, 10);
  const dateToIdx = new Map(candles.map((candle, index) => [candle.date, index]));
  const data: TickerData = { ticker, candles, ivRanks, recentMaxGapPct10, dateToIdx, regimeByDate };
  candleCache.set(cacheKey, data);
  return data;
}

export function generateSignalsForPreset(
  td: TickerData,
  presetKey: SignalPresetKey,
  periodStart: string,
  periodEnd: string,
): EntrySignal[] {
  if (isPullbackPreset(presetKey)) {
    return generatePullbackSignals(td, presetKey, periodStart, periodEnd, resolvePullbackOptions(presetKey));
  }

  const techOptions = SIGNAL_PRESETS[presetKey];
  const { signals } = precomputeSignals(td.candles, '1D', techOptions);
  const entries: EntrySignal[] = [];

  for (const signal of signals) {
    if (signal.date < periodStart || signal.date > periodEnd) continue;
    if (signal.type === 'NEUTRAL' || signal.score < 70) continue;
    if (signal.adx === undefined || signal.adx < 10) continue;

    const idx = td.dateToIdx.get(signal.date);
    const regime = td.regimeByDate.get(signal.date);
    const frontBackIVAnomaly = getFrontBackIVAnomaly(td.ticker, signal.date);
    entries.push({
      ticker: td.ticker,
      date: signal.date,
      direction: signal.type as 'CALL' | 'PUT',
      score: signal.score,
      sourcePreset: presetKey,
      frontBackIVAnomaly,
      recentMaxGapPct: idx != null ? td.recentMaxGapPct10[idx] : undefined,
      recentMaxGapPct10: idx != null ? td.recentMaxGapPct10[idx] : undefined,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
      vrp: regime?.vrp,
      contango: regime?.contango,
      vrpPct: regime?.vrpPct,
      contangoPct: regime?.contangoPct,
      slope: regime?.slope,
      dirConfidence: signal.dirConfidence,
      d8: signal.d8,
    });
  }

  return entries;
}

export function generatePullbackSignals(
  td: TickerData,
  presetKey: SignalPresetKey,
  periodStart: string,
  periodEnd: string,
  options?: PullbackOptions,
): EntrySignal[] {
  const entries: EntrySignal[] = [];
  const lookback = 150;

  for (let index = lookback; index < td.candles.length; index += 1) {
    const candle = td.candles[index];
    if (candle.date < periodStart || candle.date > periodEnd) continue;

    const result = calculatePullbackSignal(td.candles.slice(0, index + 1), options);
    if (result.type === 'NEUTRAL' || result.techScore < 70) continue;

    const ivIndex = td.dateToIdx.get(candle.date);
    const regime = td.regimeByDate.get(candle.date);
    const frontBackIVAnomaly = getFrontBackIVAnomaly(td.ticker, candle.date);
    entries.push({
      ticker: td.ticker,
      date: candle.date,
      direction: result.type as 'CALL' | 'PUT',
      score: result.techScore,
      sourcePreset: presetKey,
      pullbackEntryEMA: detectPullbackEntryEMA(result.setup),
      frontBackIVAnomaly,
      recentMaxGapPct: ivIndex != null ? td.recentMaxGapPct10[ivIndex] : undefined,
      recentMaxGapPct10: ivIndex != null ? td.recentMaxGapPct10[ivIndex] : undefined,
      ivRank: ivIndex != null ? (td.ivRanks[ivIndex] ?? undefined) : undefined,
      vrp: regime?.vrp,
      contango: regime?.contango,
      vrpPct: regime?.vrpPct,
      contangoPct: regime?.contangoPct,
      slope: regime?.slope,
      dirConfidence: result.dirConfidence,
      d8: result.debug.d8,
    });
  }

  return entries;
}

function resolvePullbackOptions(presetKey: SignalPresetKey): PullbackOptions | undefined {
  if (presetKey === 'pb8') return { entryEMA: 8 };
  if (presetKey === 'pb21') return { entryEMA: 21 };
  if (presetKey === 'pb34') return { entryEMA: 34 };
  return undefined;
}

function detectPullbackEntryEMA(setup: string): 8 | 21 | 34 | undefined {
  if (setup.includes('EMA34')) return 34;
  if (setup.includes('EMA21')) return 21;
  if (setup.includes('EMA8')) return 8;
  return undefined;
}

export function clearTickerDataCache(): void {
  candleCache.clear();
  anomalyCache.clear();
}

function getFrontBackIVAnomaly(ticker: string, date: string): number | undefined {
  const cacheKey = `${ticker}|${date}`;
  if (anomalyCache.has(cacheKey)) {
    return anomalyCache.get(cacheKey) ?? undefined;
  }
  const chain = getCachedChain(ticker, date);
  const anomaly = computeFrontBackIVAnomaly(chain);
  anomalyCache.set(cacheKey, anomaly);
  return anomaly ?? undefined;
}
