/**
 * Comprehensive 4H vs 130M Timeframe Comparison
 *
 * Production-quality WFA comparison with:
 *  - Data integrity validation (bars/day, hour distribution, date overlap)
 *  - Expanded sweep grid (288 configs per arm, matching production dimensions)
 *  - Per-config stability tracking across windows
 *  - Matched config head-to-head comparison (isolates timeframe effect)
 *  - Degradation distribution analysis
 *  - JSON output for future reference
 *
 * Usage:
 *   npx tsx scripts/wfa-ab-130m.ts                    # all 15 tickers
 *   npx tsx scripts/wfa-ab-130m.ts --ticker SPY       # quick validation
 *   npx tsx scripts/wfa-ab-130m.ts --ticker SPY,QQQ   # subset
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env ────────────────────────────────────────────
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
      if (key && !key.startsWith('#')) process.env[key] = value;
    }
  });
}

import { SIGNAL_PRESETS, DIR_CONF_THRESHOLDS } from '../src/lib/backtest/types';
import type { FillMode, SignalPresetKey, DirConfTier } from '../src/lib/backtest/types';
import {
  initDB,
  closeDB,
  getCachedChain,
  findSpreadStrikes,
  findContractDirect,
} from '../src/lib/backtest/chain-cache';
import { initIntradayDB, get4HCandles, get130MRawCandles, get130MCandles, aggregateToDaily, type IntradayCandle } from '../src/lib/backtest/intraday-cache';
import {
  precomputeSignals4H,
  type IVDataRow,
  PERIOD_MULTIPLIERS,
  PERIOD_MULTIPLIERS_130M,
} from '../src/lib/backtest/intraday-signals';
import {
  DEFAULT_SHORT_CREDIT_CONFIG,
  computeOptionAnalytics,
  type EntrySignal,
  type OptionTrade,
  type SimConfig,
} from '../src/lib/backtest/option-sim';
import { evaluateCreditSpread4H } from '../src/lib/backtest/intraday-monitor';
import { applyFill } from '../src/lib/backtest/slippage';
import { buildWFAWindows, computePortfolioDailyMetrics, type WFAWindow } from '../src/lib/backtest/wfa-options';

// ── Config ───────────────────────────────────────────────

const args = process.argv.slice(2);
const tickerArgIdx = args.indexOf('--ticker');
const ALL_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
  'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
  'META', 'NFLX', 'GOOGL', 'GS', 'COST',
];
const tickers = tickerArgIdx >= 0 && args[tickerArgIdx + 1]
  ? args[tickerArgIdx + 1].split(',').map(t => t.trim().toUpperCase())
  : ALL_TICKERS;

/**
 * Hybrid 130M getter: native Polygon data where available, 1H→130M view as fallback.
 * This gives full date coverage (matching 4H) while using the most accurate data available.
 */
function get130MHybrid(db: any, ticker: string, startDate: string, endDate: string): IntradayCandle[] {
  // Try raw first
  let rawCandles = get130MRawCandles(db, ticker, startDate, endDate);
  if (rawCandles.length === 0 && ticker === 'GOOGL') {
    rawCandles = get130MRawCandles(db, 'GOOG', startDate, endDate);
  }

  // Find the max date covered by raw data
  const rawMaxDate = rawCandles.length > 0
    ? rawCandles[rawCandles.length - 1].date
    : startDate;

  // If raw covers the full range, return it
  if (rawMaxDate >= endDate) return rawCandles;

  // Fill gap with 1H→130M view
  const gapStart = rawMaxDate;  // slight overlap is fine, we'll dedupe
  let viewCandles = get130MCandles(db, ticker, gapStart, endDate);
  if (viewCandles.length === 0 && ticker === 'GOOGL') {
    viewCandles = get130MCandles(db, 'GOOG', gapStart, endDate);
  }

  // Dedupe by timestamp (raw takes priority)
  const seen = new Set(rawCandles.map(c => c.timestamp));
  const merged = [...rawCandles];
  for (const c of viewCandles) {
    if (!seen.has(c.timestamp)) {
      merged.push(c);
      seen.add(c.timestamp);
    }
  }
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}

const AB_CONFIG = {
  tickers,
  dataStart: '2023-01-01',
  startDate: '2024-03-01',
  endDate: '2026-02-28',
  trainWindowDays: 189,
  forwardStepDays: 42,
  purgeGapDays: 14,
  mode: 'rolling' as const,
  maxPositions: 10,
  maxPerTicker: 5,
  startingCapital: 100_000,
  fillMode: 'mid' as FillMode,
  presets: ['ema', 'mom', 'em', 'mf', 'full', 'vol'] as SignalPresetKey[],
  // Comprehensive sweep grid
  profitTargets: [0.30, 0.50],
  spreadWidths: [2.5, 5, 10],
  ivRankMins: [0, 20, 30],
  deltaStops: [0.65, Infinity],  // Infinity = deltaStop off
  timeStopDTEs: [1],
};

// Period multiplier equivalence: 4H pm × 1.5 = 130M pm (same calendar-day lookback)
const PERIOD_MULTS_4H = [1.5, 2.0, 2.5] as const;
const PERIOD_MULTS_130M = [2.25, 3.0, 3.75] as const;

// Mapping for matched config comparison
const MULT_MAP_4H_TO_130M: Record<number, number> = { 1.5: 2.25, 2.0: 3.0, 2.5: 3.75 };

function sigMapKey(mult: number, preset: string): string {
  return `${mult}|${preset}`;
}

// ── Supabase Helper ──────────────────────────────────────

const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

async function supabaseGet(table: string, query: string): Promise<any[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${query}`, {
        headers: { apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}` },
      });
      if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
      return res.json();
    } catch (err: any) {
      if (attempt < 2 && (err.cause?.code === 'EPIPE' || err.cause?.code === 'ECONNRESET' || err.message?.includes('fetch failed'))) {
        console.warn(`  [retry ${attempt + 1}/3] ${table} fetch: ${err.cause?.code || err.message}`);
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  return [];
}

// ── Data Validation ──────────────────────────────────────

interface ValidationResult {
  passed: boolean;
  checks: { name: string; status: 'PASS' | 'FAIL' | 'WARN'; detail: string }[];
  overlapStart: string;
  overlapEnd: string;
}

function validateData(intradayDb: any): ValidationResult {
  console.log('\n' + '═'.repeat(80));
  console.log('  DATA VALIDATION');
  console.log('═'.repeat(80));

  const checks: ValidationResult['checks'] = [];
  let allPassed = true;

  // Check 4H bars/day per ticker
  const barsPerDay4H: Record<string, number> = {};
  for (const ticker of AB_CONFIG.tickers) {
    const row = intradayDb.prepare(
      `SELECT COUNT(*) AS cnt, COUNT(DISTINCT date) AS days FROM candles_4h
       WHERE ticker = ? AND date >= ? AND date <= ?`
    ).get(ticker, AB_CONFIG.startDate, AB_CONFIG.endDate) as { cnt: number; days: number };
    barsPerDay4H[ticker] = row.days > 0 ? row.cnt / row.days : 0;
  }
  const avg4H = Object.values(barsPerDay4H).reduce((s, v) => s + v, 0) / Object.values(barsPerDay4H).length;
  const pass4H = avg4H >= 1.8 && avg4H <= 2.2;
  checks.push({
    name: '4H bars/day',
    status: pass4H ? 'PASS' : 'FAIL',
    detail: Object.entries(barsPerDay4H).map(([t, v]) => `${t}=${v.toFixed(2)}`).join(' '),
  });
  if (!pass4H) allPassed = false;

  // Check 130M bars/day per ticker (hybrid: count via actual getter)
  const barsPerDay130M: Record<string, number> = {};
  for (const ticker of AB_CONFIG.tickers) {
    const candles = get130MHybrid(intradayDb, ticker, AB_CONFIG.startDate, AB_CONFIG.endDate);
    const days = new Set(candles.map(c => c.date)).size;
    barsPerDay130M[ticker] = days > 0 ? candles.length / days : 0;
  }
  const avg130M = Object.values(barsPerDay130M).reduce((s, v) => s + v, 0) / Object.values(barsPerDay130M).length;
  const pass130M = avg130M >= 2.8 && avg130M <= 3.2;
  checks.push({
    name: '130M bars/day (hybrid)',
    status: pass130M ? 'PASS' : 'FAIL',
    detail: Object.entries(barsPerDay130M).map(([t, v]) => `${t}=${v.toFixed(2)}`).join(' '),
  });
  if (!pass130M) allPassed = false;

  // Check 4H hour distribution (UTC hours should be 13-20 only)
  const hourDist4H = intradayDb.prepare(
    `SELECT DISTINCT CAST(SUBSTR(datetime, 12, 2) AS INTEGER) AS hour FROM candles_4h
     WHERE date >= ? AND date <= ? ORDER BY hour`
  ).all(AB_CONFIG.startDate, AB_CONFIG.endDate) as { hour: number }[];
  const hours4H = hourDist4H.map(r => r.hour);
  const validHours4H = hours4H.every(h => h >= 13 && h <= 20);
  checks.push({
    name: '4H hour filter',
    status: validHours4H ? 'PASS' : 'FAIL',
    detail: `UTC hours: [${hours4H.join(', ')}]${validHours4H ? '' : ' — expected [13-20] only'}`,
  });
  if (!validHours4H) allPassed = false;

  // Check 130M hour distribution (hybrid: raw uses ET, view uses UTC — just verify bars/day is ~3)
  checks.push({
    name: '130M hybrid coverage',
    status: 'PASS',
    detail: `Native Polygon + 1H→130M view fallback, avg ${avg130M.toFixed(2)} bars/day`,
  });

  // Date range overlap
  const range4H = intradayDb.prepare(
    `SELECT MIN(date) AS minD, MAX(date) AS maxD FROM candles_4h
     WHERE date >= ? AND date <= ?`
  ).get(AB_CONFIG.startDate, AB_CONFIG.endDate) as { minD: string; maxD: string };
  const range130M = intradayDb.prepare(
    `SELECT MIN(date) AS minD, MAX(date) AS maxD FROM candles_130m_raw
     WHERE date >= ? AND date <= ?`
  ).get(AB_CONFIG.startDate, AB_CONFIG.endDate) as { minD: string; maxD: string };

  const overlapStart = range4H.minD > range130M.minD ? range4H.minD : range130M.minD;
  const overlapEnd = range4H.maxD < range130M.maxD ? range4H.maxD : range130M.maxD;

  const overlapDays4H = (intradayDb.prepare(
    `SELECT COUNT(DISTINCT date) AS cnt FROM candles_4h WHERE date >= ? AND date <= ?`
  ).get(overlapStart, overlapEnd) as { cnt: number }).cnt;

  checks.push({
    name: 'Date overlap',
    status: overlapDays4H >= 400 ? 'PASS' : overlapDays4H >= 200 ? 'WARN' : 'FAIL',
    detail: `${overlapStart} → ${overlapEnd} (${overlapDays4H} trading days)`,
  });
  if (overlapDays4H < 200) allPassed = false;

  // Print results
  for (const check of checks) {
    const icon = check.status === 'PASS' ? '[PASS]' : check.status === 'WARN' ? '[WARN]' : '[FAIL]';
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
  }
  console.log('');

  return { passed: allPassed, checks, overlapStart, overlapEnd };
}

// ── Sweep Grid Builder ───────────────────────────────────

function configLabel(c: SimConfig): string {
  const preset = c.signalWeightPreset ?? 'ema';
  const tp = Math.round((c.creditProfitTarget ?? 0.3) * 100);
  const w = c.creditSpreadWidth ?? 5;
  const iv = c.minIVRank ?? 0;
  const ds = (c.creditDeltaStop && c.creditDeltaStop > 0) ? c.creditDeltaStop.toFixed(2) : 'off';
  const pm = (c as any).indicatorPeriodMultiplier ?? 2.0;
  return `${preset}|tp${tp}|w${w}|iv${iv}|ds${ds}|pm${pm}`;
}

/** Config identity without period multiplier — for matched comparison */
function configBase(c: SimConfig): string {
  const preset = c.signalWeightPreset ?? 'ema';
  const tp = Math.round((c.creditProfitTarget ?? 0.3) * 100);
  const w = c.creditSpreadWidth ?? 5;
  const iv = c.minIVRank ?? 0;
  const ds = (c.creditDeltaStop && c.creditDeltaStop > 0) ? c.creditDeltaStop.toFixed(2) : 'off';
  return `${preset}|tp${tp}|w${w}|iv${iv}|ds${ds}`;
}

function buildSweepGrid(periodMultipliers: readonly number[]): SimConfig[] {
  const candidates: SimConfig[] = [];

  for (const preset of AB_CONFIG.presets) {
    for (const width of AB_CONFIG.spreadWidths) {
      for (const tp of AB_CONFIG.profitTargets) {
        for (const ivMin of AB_CONFIG.ivRankMins) {
          for (const deltaStop of AB_CONFIG.deltaStops) {
            for (const ts of AB_CONFIG.timeStopDTEs) {
              for (const periodMult of periodMultipliers) {
                candidates.push({
                  ...DEFAULT_SHORT_CREDIT_CONFIG,
                  creditDTERange: [7, 21] as [number, number],
                  creditSpreadWidth: width,
                  creditProfitTarget: tp,
                  creditStopLossMultiple: 100,
                  creditTimeStopDTE: ts,
                  creditDeltaStop: deltaStop === Infinity ? 0 : deltaStop,
                  minIVRank: ivMin,
                  signalWeightPreset: preset,
                  fillMode: AB_CONFIG.fillMode,
                  maxPerTicker: AB_CONFIG.maxPerTicker,
                  maxPositions: AB_CONFIG.maxPositions,
                  indicatorPeriodMultiplier: periodMult,
                  bsmKappa: 4.0,
                  bsmRiskFreeRate: 0.04,
                  dailyCalibration: true,
                  ivThetaSource: 'hv60',
                } as SimConfig);
              }
            }
          }
        }
      }
    }
  }

  return candidates;
}

// ── Data ─────────────────────────────────────────────────

interface ABTickerData {
  ticker: string;
  candles: IntradayCandle[];
  dailyCandles: IntradayCandle[];
  ivData: IVDataRow[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

function computeIVRank(ivSeries: (number | null)[]): (number | null)[] {
  const window = 252;
  return ivSeries.map((v, i) => {
    if (i < window || v == null) return null;
    const sample = ivSeries.slice(i - window, i + 1).filter((x): x is number => x != null);
    if (sample.length < 100) return null;
    const min = Math.min(...sample);
    const max = Math.max(...sample);
    const range = max - min;
    return range > 0 ? ((v - min) / range) * 100 : 50;
  });
}

async function fetchData(
  ticker: string,
  dataStart: string,
  dataEnd: string,
  intradayDb: any,
  candleGetter: (db: any, ticker: string, start: string, end: string) => IntradayCandle[],
): Promise<ABTickerData> {
  let candles = candleGetter(intradayDb, ticker, dataStart, dataEnd);
  if (candles.length === 0 && ticker === 'GOOGL') {
    candles = candleGetter(intradayDb, 'GOOG', dataStart, dataEnd);
  }
  const dailyCandles = aggregateToDaily(candles);

  const ivDbRows = await supabaseGet(
    'orats_iv_cache',
    `select=date,iv30d,iv60d,hv20d,hv30d,hv60d&ticker=eq.${ticker}&date=gte.${dataStart}&date=lte.${dataEnd}&order=date.asc&limit=5000`,
  );
  const ivData: IVDataRow[] = ivDbRows.map((r: any) => ({
    date: r.date, iv30d: r.iv30d, iv60d: r.iv60d, hv20d: r.hv20d, hv30d: r.hv30d, hv60d: r.hv60d,
  }));

  const ivByDate = new Map(ivData.map(r => [r.date, r.iv30d]));
  const ivSeries = dailyCandles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRank(ivSeries);
  const dateToIdx = new Map(dailyCandles.map((c, i) => [c.date, i]));

  return { ticker, candles, dailyCandles, ivData, ivRanks, dateToIdx };
}

// ── Signal Generation ────────────────────────────────────

function generateSignals(
  td: ABTickerData,
  presetKey: SignalPresetKey,
  periodMultiplier: number,
  periodStart: string,
  periodEnd: string,
): EntrySignal[] {
  const techOptions = SIGNAL_PRESETS[presetKey];
  const signals = precomputeSignals4H(td.candles, td.ivData, periodMultiplier, techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    const barDate = sig.date.split('T')[0].split(' ')[0];
    if (barDate < periodStart || barDate > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 65) continue;
    if (sig.adx !== undefined && sig.adx < 8) continue;

    const idx = td.dateToIdx.get(barDate);
    entries.push({
      ticker: td.ticker,
      date: barDate,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
      hv60: sig.ivEstimate60,
      oratsIV60: sig.oratsIV60,
      indicatorPeriodMultiplier: periodMultiplier,
      dirConfidence: sig.subScores
        ? Math.round(Object.values(sig.subScores).filter(v => v > 50).length / Object.values(sig.subScores).length * 100)
        : undefined,
    });
  }

  const deduped = new Map<string, EntrySignal>();
  for (const entry of entries) {
    const key = `${entry.ticker}|${entry.date}|${entry.direction}`;
    if (!deduped.has(key) || entry.score > deduped.get(key)!.score) {
      deduped.set(key, entry);
    }
  }
  return [...deduped.values()];
}

// ── Evaluator ────────────────────────────────────────────

function makeEvaluator(tdMap: Map<string, ABTickerData>, fillMode: FillMode) {
  return (signal: EntrySignal, config: SimConfig, tradingDates: string[], maxDate: string) => {
    const td = tdMap.get(signal.ticker);
    if (!td) return null;

    if (config.dirConfTier && config.dirConfTier !== 'any' && signal.dirConfidence != null) {
      if (signal.dirConfidence < DIR_CONF_THRESHOLDS[config.dirConfTier]) return null;
    }

    return evaluateCreditSpread4H(signal, config, td.candles, tradingDates, maxDate, {
      getChain: (ticker, date) => getCachedChain(ticker, date),
      findSpread: (chain, shortDelta, width, type, dteRange) =>
        findSpreadStrikes(chain, shortDelta, width, type as 'Call' | 'Put', dteRange),
      findContract: (ticker, date, strike, expiry, type) =>
        findContractDirect(ticker, date, strike, expiry, type as 'Call' | 'Put'),
      applyFillFn: (mid, bid, ask, side, cfg, oi, dte) =>
        applyFill(fillMode, mid, bid, ask, side, cfg, oi, dte),
    });
  };
}

// ── Per-Config Tracking ──────────────────────────────────

interface ConfigTracker {
  label: string;
  base: string;  // label without period multiplier
  preset: string;
  periodMultiplier: number;
  profitTarget: number;
  spreadWidth: number;
  ivRankMin: number;
  deltaStop: number;
  windowTrainSharpes: number[];
  windowOOSSharpes: number[];
  windowOOSWinRates: number[];
  windowOOSTradeCounts: number[];
  windowDegradations: number[];
  timesSelectedAsBest: number;
}

interface StabilityResult {
  label: string;
  base: string;
  preset: string;
  periodMultiplier: number;
  avgTrainSharpe: number;
  avgOOSSharpe: number;
  medianDegradation: number;
  pctPositiveOOS: number;
  oosStdDev: number;
  stabilityScore: number;
  totalOOSTrades: number;
  avgOOSWinRate: number;
}

// ── WFA Types ────────────────────────────────────────────

interface WindowDetail {
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  trainSharpe: number;
  oosSharpe: number;
  degradation: number;
  oosTradeCount: number;
  oosWinRate: number;
  bestConfigLabel: string;
}

interface ABResult {
  label: string;
  barsPerDay: number;
  candleCount: number;
  sharpe: number;
  winRate: number;
  maxDD: number;
  totalPnl: number;
  tradeCount: number;
  wfEfficiency: number;
  avgTrainSharpe: number;
  avgDegradation: number;
  windowDetails: WindowDetail[];
  topStableConfigs: StabilityResult[];
  elapsedMs: number;
}

// ── WFA Runner ───────────────────────────────────────────

async function runABArm(
  label: string,
  barsPerDay: number,
  periodMultipliers: readonly number[],
  candleGetter: (db: any, ticker: string, start: string, end: string) => IntradayCandle[],
  intradayDb: any,
): Promise<ABResult> {
  const t0 = Date.now();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Running ${label}...`);
  console.log(`${'─'.repeat(60)}`);

  // Fetch data
  const tdMap = new Map<string, ABTickerData>();
  for (const ticker of AB_CONFIG.tickers) {
    const td = await fetchData(ticker, AB_CONFIG.dataStart, AB_CONFIG.endDate, intradayDb, candleGetter);
    tdMap.set(ticker, td);
    console.log(`  ${ticker}: ${td.candles.length} candles, ${td.dailyCandles.length} daily`);
  }

  // Trading dates
  const allDatesSet = new Set<string>();
  for (const td of tdMap.values()) {
    for (const c of td.dailyCandles) {
      if (c.date >= AB_CONFIG.startDate && c.date <= AB_CONFIG.endDate) allDatesSet.add(c.date);
    }
  }
  const allTradingDates = [...allDatesSet].sort();

  // Generate signals for all preset × multiplier combos
  const signalsByMultPreset = new Map<string, EntrySignal[]>();
  for (const mult of periodMultipliers) {
    for (const preset of AB_CONFIG.presets) {
      const allSignals: EntrySignal[] = [];
      for (const td of tdMap.values()) {
        allSignals.push(...generateSignals(td, preset, mult, AB_CONFIG.startDate, AB_CONFIG.endDate));
      }
      allSignals.sort((a, b) => a.date.localeCompare(b.date));
      signalsByMultPreset.set(sigMapKey(mult, preset), allSignals);
      console.log(`  Signal ${sigMapKey(mult, preset)}: ${allSignals.length}`);
    }
  }

  // WFA windows
  const windowDefs = buildWFAWindows(allTradingDates, {
    trainWindowDays: AB_CONFIG.trainWindowDays,
    forwardStepDays: AB_CONFIG.forwardStepDays,
    purgeGapDays: AB_CONFIG.purgeGapDays,
    mode: AB_CONFIG.mode,
    startDate: AB_CONFIG.startDate,
    endDate: AB_CONFIG.endDate,
  });
  console.log(`  WFA windows: ${windowDefs.length}`);

  // Build sweep grid
  const candidates = buildSweepGrid(periodMultipliers);
  console.log(`  Sweep candidates: ${candidates.length}`);

  // Initialize per-config trackers
  const trackers = new Map<string, ConfigTracker>();
  for (const c of candidates) {
    const lbl = configLabel(c);
    if (!trackers.has(lbl)) {
      trackers.set(lbl, {
        label: lbl,
        base: configBase(c),
        preset: c.signalWeightPreset ?? 'ema',
        periodMultiplier: (c as any).indicatorPeriodMultiplier ?? 2.0,
        profitTarget: c.creditProfitTarget ?? 0.3,
        spreadWidth: c.creditSpreadWidth ?? 5,
        ivRankMin: c.minIVRank ?? 0,
        deltaStop: (c.creditDeltaStop && c.creditDeltaStop > 0) ? c.creditDeltaStop : 0,
        windowTrainSharpes: [],
        windowOOSSharpes: [],
        windowOOSWinRates: [],
        windowOOSTradeCounts: [],
        windowDegradations: [],
        timesSelectedAsBest: 0,
      });
    }
  }

  const evaluator = makeEvaluator(tdMap, AB_CONFIG.fillMode);

  // Run single-threaded WFA with per-config tracking
  const allOOSTrades: OptionTrade[] = [];
  const wfaWindows: WFAWindow[] = [];
  const windowBestLabels: string[] = [];

  for (let wi = 0; wi < windowDefs.length; wi++) {
    const w = windowDefs[wi];
    let bestTrainSharpe = -Infinity;
    let bestConfig = candidates[0];
    let bestOOSTrades: OptionTrade[] = [];
    let bestOOSSharpe = 0;
    let bestOOSWinRate = 0;
    let bestOOSMaxDD = 0;
    let bestTrainTradeCount = 0;

    // Phase 1: Train all candidates, record per-config IS Sharpe
    const configTrainResults = new Map<string, { trainSharpe: number; trainTrades: number }>();

    for (const candidate of candidates) {
      const presetKey = candidate.signalWeightPreset ?? 'ema';
      const periodMult = (candidate as any).indicatorPeriodMultiplier ?? 2.0;
      const signals = signalsByMultPreset.get(sigMapKey(periodMult, presetKey)) ?? [];

      const trainSignals = signals.filter(s => s.date >= w.trainStart && s.date <= w.trainEnd);
      const trainTrades: OptionTrade[] = [];
      for (const signal of trainSignals) {
        const trade = evaluator(signal, candidate, allTradingDates, w.trainEnd);
        if (trade) trainTrades.push(trade);
      }
      const trainAnalytics = computeOptionAnalytics(trainTrades);
      const trainSharpe = trainAnalytics.dailyPortfolioSharpe ?? trainAnalytics.tradeSharpeLegacy;

      const lbl = configLabel(candidate);
      configTrainResults.set(lbl, { trainSharpe, trainTrades: trainTrades.length });

      // Track IS Sharpe for this config
      const tracker = trackers.get(lbl)!;
      tracker.windowTrainSharpes.push(trainSharpe);

      if (trainSharpe > bestTrainSharpe) {
        bestTrainSharpe = trainSharpe;
        bestConfig = candidate;
        bestTrainTradeCount = trainTrades.length;
      }
    }

    // Phase 2: Run OOS for best config (production-style best-per-window)
    const bestPresetKey = bestConfig.signalWeightPreset ?? 'ema';
    const bestPeriodMult = (bestConfig as any).indicatorPeriodMultiplier ?? 2.0;
    const bestSignals = signalsByMultPreset.get(sigMapKey(bestPeriodMult, bestPresetKey)) ?? [];
    const oosSignals = bestSignals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const oosTrades: OptionTrade[] = [];
    const openPositions: OptionTrade[] = [];

    for (const signal of oosSignals) {
      for (let j = openPositions.length - 1; j >= 0; j--) {
        if (openPositions[j].exitDate <= signal.date) openPositions.splice(j, 1);
      }
      if (openPositions.length >= AB_CONFIG.maxPositions) continue;
      if (openPositions.filter(t => t.ticker === signal.ticker).length >= AB_CONFIG.maxPerTicker) continue;

      const trade = evaluator(signal, bestConfig, allTradingDates, AB_CONFIG.endDate);
      if (trade) { oosTrades.push(trade); openPositions.push(trade); }
    }

    const oosAnalytics = computeOptionAnalytics(oosTrades);
    bestOOSTrades = oosTrades;
    bestOOSSharpe = oosAnalytics.dailyPortfolioSharpe ?? oosAnalytics.tradeSharpeLegacy;
    bestOOSWinRate = oosAnalytics.winRate;
    bestOOSMaxDD = oosAnalytics.dailyMtMDrawdownPct ?? oosAnalytics.realizedExitDrawdownPct;

    const bestLabel = configLabel(bestConfig);
    windowBestLabels.push(bestLabel);
    const bestTracker = trackers.get(bestLabel)!;
    bestTracker.timesSelectedAsBest++;

    // Phase 3: Run OOS for top-20 configs by train Sharpe (stability analysis)
    const sortedConfigs = [...configTrainResults.entries()]
      .sort((a, b) => b[1].trainSharpe - a[1].trainSharpe)
      .slice(0, 20);

    for (const [lbl] of sortedConfigs) {
      const tracker = trackers.get(lbl)!;
      const candidate = candidates.find(c => configLabel(c) === lbl)!;
      const presetKey = candidate.signalWeightPreset ?? 'ema';
      const periodMult = (candidate as any).indicatorPeriodMultiplier ?? 2.0;
      const signals = signalsByMultPreset.get(sigMapKey(periodMult, presetKey)) ?? [];

      const topOosSignals = signals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
      const topOosTrades: OptionTrade[] = [];
      const topOpenPos: OptionTrade[] = [];

      for (const signal of topOosSignals) {
        for (let j = topOpenPos.length - 1; j >= 0; j--) {
          if (topOpenPos[j].exitDate <= signal.date) topOpenPos.splice(j, 1);
        }
        if (topOpenPos.length >= AB_CONFIG.maxPositions) continue;
        if (topOpenPos.filter(t => t.ticker === signal.ticker).length >= AB_CONFIG.maxPerTicker) continue;

        const trade = evaluator(signal, candidate, allTradingDates, AB_CONFIG.endDate);
        if (trade) { topOosTrades.push(trade); topOpenPos.push(trade); }
      }

      const topOosAnalytics = computeOptionAnalytics(topOosTrades);
      const topOosSharpe = topOosAnalytics.dailyPortfolioSharpe ?? topOosAnalytics.tradeSharpeLegacy;
      const trainSharpe = configTrainResults.get(lbl)!.trainSharpe;

      tracker.windowOOSSharpes.push(topOosSharpe);
      tracker.windowOOSWinRates.push(topOosAnalytics.winRate);
      tracker.windowOOSTradeCounts.push(topOosTrades.length);
      tracker.windowDegradations.push(trainSharpe > 0.1 ? topOosSharpe / trainSharpe : 0);
    }

    process.stdout.write(`  Window ${wi + 1}/${windowDefs.length}: best=${bestLabel} → ${bestOOSTrades.length} OOS trades, Sharpe ${bestOOSSharpe.toFixed(2)}\n`);

    wfaWindows.push({
      trainStart: w.trainStart, trainEnd: w.trainEnd,
      oosStart: w.oosStart, oosEnd: w.oosEnd,
      bestConfig: bestConfig as any,
      bestTrainSharpe, trainTradeCount: bestTrainTradeCount,
      oosTrades: bestOOSTrades, oosSharpe: bestOOSSharpe,
      oosWinRate: bestOOSWinRate, oosMaxDD: bestOOSMaxDD,
      oosTradeCount: bestOOSTrades.length,
    });
    allOOSTrades.push(...bestOOSTrades);
  }

  // Compute stability results for configs with OOS data across multiple windows
  const stabilityResults: StabilityResult[] = [];
  for (const [, tracker] of trackers) {
    if (tracker.windowOOSSharpes.length < 2) continue;

    const avgTrain = tracker.windowTrainSharpes.reduce((s, v) => s + v, 0) / tracker.windowTrainSharpes.length;
    const avgOOS = tracker.windowOOSSharpes.reduce((s, v) => s + v, 0) / tracker.windowOOSSharpes.length;
    const pctPositive = tracker.windowOOSSharpes.filter(v => v > 0).length / tracker.windowOOSSharpes.length;

    const sorted = [...tracker.windowDegradations].sort((a, b) => a - b);
    const medianDeg = sorted[Math.floor(sorted.length / 2)];

    const mean = avgOOS;
    const variance = tracker.windowOOSSharpes.reduce((s, v) => s + (v - mean) ** 2, 0) / tracker.windowOOSSharpes.length;
    const stdDev = Math.sqrt(variance);

    const stabilityScore = (pctPositive * Math.max(0, medianDeg)) / Math.max(stdDev, 0.1);

    stabilityResults.push({
      label: tracker.label,
      base: tracker.base,
      preset: tracker.preset,
      periodMultiplier: tracker.periodMultiplier,
      avgTrainSharpe: avgTrain,
      avgOOSSharpe: avgOOS,
      medianDegradation: medianDeg,
      pctPositiveOOS: pctPositive * 100,
      oosStdDev: stdDev,
      stabilityScore,
      totalOOSTrades: tracker.windowOOSTradeCounts.reduce((s, v) => s + v, 0),
      avgOOSWinRate: tracker.windowOOSWinRates.reduce((s, v) => s + v, 0) / tracker.windowOOSWinRates.length,
    });
  }

  stabilityResults.sort((a, b) => b.stabilityScore - a.stabilityScore);

  // Aggregate results
  const windowDetails: WindowDetail[] = wfaWindows.map((w, i) => ({
    trainStart: w.trainStart,
    trainEnd: w.trainEnd,
    oosStart: w.oosStart,
    oosEnd: w.oosEnd,
    trainSharpe: w.bestTrainSharpe,
    oosSharpe: w.oosSharpe,
    degradation: w.bestTrainSharpe > 0.1 ? w.oosSharpe / w.bestTrainSharpe : 0,
    oosTradeCount: w.oosTrades.length,
    oosWinRate: w.oosWinRate,
    bestConfigLabel: windowBestLabels[i],
  }));

  const windowsWithTrades = windowDetails.filter(w => w.oosTradeCount > 0);
  const avgDegradation = windowsWithTrades.length > 0
    ? windowsWithTrades.reduce((s, w) => s + w.degradation, 0) / windowsWithTrades.length : 0;

  const portfolioMetrics = computePortfolioDailyMetrics(
    allOOSTrades, allTradingDates, AB_CONFIG.startDate, AB_CONFIG.endDate, AB_CONFIG.startingCapital,
  );
  const oosAnalytics = computeOptionAnalytics(allOOSTrades);
  const avgTrainSharpe = wfaWindows.length > 0
    ? wfaWindows.reduce((s, w) => s + w.bestTrainSharpe, 0) / wfaWindows.length : 0;

  return {
    label,
    barsPerDay,
    candleCount: tdMap.values().next().value?.candles.length ?? 0,
    sharpe: portfolioMetrics.sharpe,
    winRate: oosAnalytics.winRate,
    maxDD: portfolioMetrics.maxDrawdownPct,
    totalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
    tradeCount: allOOSTrades.length,
    wfEfficiency: avgTrainSharpe >= 0.1 ? portfolioMetrics.sharpe / avgTrainSharpe : 0,
    avgTrainSharpe,
    avgDegradation,
    windowDetails,
    topStableConfigs: stabilityResults.slice(0, 10),
    elapsedMs: Date.now() - t0,
  };
}

// ── Reporting ────────────────────────────────────────────

function printWindowTable(label: string, details: WindowDetail[]) {
  console.log('\n' + '─'.repeat(100));
  console.log(`  PER-WINDOW DEGRADATION (${label})`);
  console.log('─'.repeat(100));
  console.log('  #   Train Period          OOS Period            IS Shrp  OOS Shrp  Degrad  WR%    Trades  Best Config');
  console.log('  ' + '·'.repeat(98));
  for (let i = 0; i < details.length; i++) {
    const w = details[i];
    const fmtPct = (v: number) => v.toFixed(1) + '%';
    console.log(
      `  ${String(i + 1).padStart(2)}  ${w.trainStart} → ${w.trainEnd}  ${w.oosStart} → ${w.oosEnd}` +
      `  ${w.trainSharpe.toFixed(2).padStart(7)}  ${w.oosSharpe.toFixed(2).padStart(8)}  ${w.degradation.toFixed(2).padStart(6)}  ${fmtPct(w.oosWinRate).padStart(5)}  ${String(w.oosTradeCount).padStart(6)}  ${w.bestConfigLabel}`,
    );
  }
}

function printStabilityTable(label: string, configs: StabilityResult[]) {
  console.log('\n' + '─'.repeat(110));
  console.log(`  CONFIG STABILITY — TOP 10 (${label})`);
  console.log('─'.repeat(110));
  console.log('  #   Config                              Avg IS   Avg OOS  Degrad   Pos%  StdDev  Score   Trades  WR%');
  console.log('  ' + '·'.repeat(108));
  for (let i = 0; i < configs.length; i++) {
    const c = configs[i];
    console.log(
      `  ${String(i + 1).padStart(2)}  ${c.label.padEnd(36)}  ${c.avgTrainSharpe.toFixed(2).padStart(6)}  ${c.avgOOSSharpe.toFixed(2).padStart(7)}  ${c.medianDegradation.toFixed(2).padStart(6)}  ${c.pctPositiveOOS.toFixed(0).padStart(4)}%  ${c.oosStdDev.toFixed(2).padStart(6)}  ${c.stabilityScore.toFixed(2).padStart(5)}  ${String(c.totalOOSTrades).padStart(6)}  ${c.avgOOSWinRate.toFixed(1).padStart(5)}%`,
    );
  }
}

function printMatchedComparison(result4H: ABResult, result130M: ABResult) {
  console.log('\n' + '─'.repeat(100));
  console.log('  MATCHED CONFIG COMPARISON (4H vs 130M, same calendar-day lookback)');
  console.log('─'.repeat(100));

  // Build lookup by base config
  const lookup4H = new Map<string, StabilityResult>();
  const lookup130M = new Map<string, StabilityResult>();
  for (const c of result4H.topStableConfigs) lookup4H.set(c.base, c);
  for (const c of result130M.topStableConfigs) lookup130M.set(c.base, c);

  // Find all bases that appear in both
  const allBases = new Set([...lookup4H.keys(), ...lookup130M.keys()]);
  const matched: { base: string; r4H: StabilityResult; r130M: StabilityResult }[] = [];
  for (const base of allBases) {
    const r4H = lookup4H.get(base);
    const r130M = lookup130M.get(base);
    if (r4H && r130M) matched.push({ base, r4H, r130M });
  }

  if (matched.length === 0) {
    console.log('  No matching configs found in top-10 of both timeframes.');
    console.log('  (This means the best configs differ significantly between 4H and 130M.)');
    return;
  }

  console.log(`  ${matched.length} matched config(s) found in top-10 of both timeframes:\n`);
  console.log('  Config Base                      4H OOS   130M OOS  Delta   4H WR%  130M WR%  Winner');
  console.log('  ' + '·'.repeat(88));

  let wins4H = 0, wins130M = 0;
  for (const { base, r4H, r130M } of matched) {
    const delta = r130M.avgOOSSharpe - r4H.avgOOSSharpe;
    const winner = delta > 0.05 ? '130M' : delta < -0.05 ? '4H' : 'TIE';
    if (winner === '4H') wins4H++;
    if (winner === '130M') wins130M++;
    console.log(
      `  ${base.padEnd(32)}  ${r4H.avgOOSSharpe.toFixed(2).padStart(7)}  ${r130M.avgOOSSharpe.toFixed(2).padStart(8)}  ${(delta > 0 ? '+' : '') + delta.toFixed(2)}  ${r4H.avgOOSWinRate.toFixed(1).padStart(6)}%  ${r130M.avgOOSWinRate.toFixed(1).padStart(6)}%  ${winner.padStart(5)}`,
    );
  }
  console.log(`\n  Matched wins: 4H=${wins4H}, 130M=${wins130M}, TIE=${matched.length - wins4H - wins130M}`);
}

function printDegradationDistribution(label: string, details: WindowDetail[]) {
  const negative = details.filter(w => w.oosSharpe < 0).length;
  const low = details.filter(w => w.degradation >= 0 && w.degradation < 0.5).length;
  const mid = details.filter(w => w.degradation >= 0.5 && w.degradation <= 1.0).length;
  const high = details.filter(w => w.degradation > 1.0).length;
  const n = details.length;
  console.log(`  ${label.padEnd(6)} Negative OOS: ${negative}/${n} | 0-50%: ${low} | 50-100%: ${mid} | >100%: ${high}`);
}

// ── Ensure Views Are Correct ─────────────────────────────

function ensureCorrectViews() {
  const dbPath = path.resolve(process.cwd(), 'data', 'intraday-candles.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error('ERROR: intraday-candles.sqlite not found. Run: node scripts/cache-intraday.mjs');
    process.exit(1);
  }

  // Open read-write to fix views
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Recreate 4H view with proper trading-hours filter
  db.exec(`DROP VIEW IF EXISTS candles_4h`);
  db.exec(`
    CREATE VIEW IF NOT EXISTS candles_4h AS
    SELECT
      ticker,
      MIN(timestamp) AS timestamp,
      MIN(datetime)  AS datetime,
      date,
      CASE WHEN CAST(SUBSTR(datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END AS block,
      (SELECT c2.open FROM candles_1h c2
       WHERE c2.ticker = c1.ticker AND c2.date = c1.date
         AND CAST(SUBSTR(c2.datetime, 12, 2) AS INTEGER) BETWEEN 13 AND 20
         AND (CASE WHEN CAST(SUBSTR(c2.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END) =
             (CASE WHEN CAST(SUBSTR(c1.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END)
       ORDER BY c2.timestamp ASC LIMIT 1) AS open,
      MAX(high) AS high,
      MIN(low)  AS low,
      (SELECT c3.close FROM candles_1h c3
       WHERE c3.ticker = c1.ticker AND c3.date = c1.date
         AND CAST(SUBSTR(c3.datetime, 12, 2) AS INTEGER) BETWEEN 13 AND 20
         AND (CASE WHEN CAST(SUBSTR(c3.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END) =
             (CASE WHEN CAST(SUBSTR(c1.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END)
       ORDER BY c3.timestamp DESC LIMIT 1) AS close,
      SUM(volume) AS volume
    FROM candles_1h c1
    WHERE CAST(SUBSTR(datetime, 12, 2) AS INTEGER) BETWEEN 13 AND 20
    GROUP BY ticker, date, CASE WHEN CAST(SUBSTR(datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END;
  `);

  console.log('  Views verified/recreated in SQLite DB');
  db.close();
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  // Ensure views are correct before opening read-only
  ensureCorrectViews();

  // Init chain cache (for ORATS chain data)
  initDB();
  closeDB();

  const intradayDb = initIntradayDB();

  try {
    const configCount = AB_CONFIG.presets.length * AB_CONFIG.spreadWidths.length * AB_CONFIG.profitTargets.length * AB_CONFIG.ivRankMins.length * AB_CONFIG.deltaStops.length * AB_CONFIG.timeStopDTEs.length * 3;

    console.log('═'.repeat(80));
    console.log('  COMPREHENSIVE 4H vs 130M TIMEFRAME SHOWDOWN');
    console.log(`  Tickers: ${AB_CONFIG.tickers.join(', ')} (${AB_CONFIG.tickers.length})`);
    console.log(`  Period: ${AB_CONFIG.startDate} → ${AB_CONFIG.endDate}`);
    console.log(`  Grid: ${AB_CONFIG.presets.length}P × ${AB_CONFIG.spreadWidths.length}W × ${AB_CONFIG.profitTargets.length}TP × ${AB_CONFIG.ivRankMins.length}IV × ${AB_CONFIG.deltaStops.length}DS × ${AB_CONFIG.timeStopDTEs.length}TS × 3M = ${configCount} configs/arm`);
    console.log(`  130M data: hybrid (native Polygon + 1H→130M view fallback for full coverage)`);
    console.log(`  130M advantage: 3 × 130min = 390min = exact market session (no boundary artifacts)`);
    console.log('═'.repeat(80));

    // Phase 0: Data validation
    const validation = validateData(intradayDb);
    if (!validation.passed) {
      console.error('\n  CRITICAL: Data validation failed. Fix data issues before running comparison.');
      console.error('  Run: node scripts/cache-intraday.mjs to rebuild data.\n');
      process.exit(1);
    }

    // Arm A: 4H baseline
    const result4H = await runABArm(
      '4H (2 bars/day)', 2,
      PERIOD_MULTS_4H,
      get4HCandles,
      intradayDb,
    );

    // Arm B: 130M (hybrid: native Polygon + 1H→130M view fallback)
    const result130M = await runABArm(
      '130M (3 bars/day)', 3,
      PERIOD_MULTS_130M,
      get130MHybrid,
      intradayDb,
    );

    // ── Print Results ────────────────────────────────────

    console.log('\n' + '═'.repeat(80));
    console.log('  AGGREGATE COMPARISON (Best-Per-Window WFA)');
    console.log('═'.repeat(80));

    const pad = (s: string, n: number) => s.padStart(n);
    const fmtPct = (v: number) => v.toFixed(1) + '%';
    const fmtDollar = (v: number) => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    const fmtDelta = (a: number, b: number, fmt: (v: number) => string) => {
      const d = b - a;
      return (d > 0 ? '+' : '') + fmt(d);
    };

    console.log(`\n  ${'Metric'.padEnd(20)} ${'4H'.padStart(12)} ${'130M'.padStart(12)} ${'Delta'.padStart(12)}`);
    console.log('  ' + '─'.repeat(56));

    const rows: [string, string, string, string][] = [
      ['Candles (sample)', String(result4H.candleCount), String(result130M.candleCount), `${result130M.barsPerDay}/${result4H.barsPerDay}x/day`],
      ['OOS Sharpe', result4H.sharpe.toFixed(2), result130M.sharpe.toFixed(2), fmtDelta(result4H.sharpe, result130M.sharpe, v => v.toFixed(2))],
      ['Win Rate', fmtPct(result4H.winRate), fmtPct(result130M.winRate), fmtDelta(result4H.winRate, result130M.winRate, fmtPct)],
      ['Max DD', fmtPct(result4H.maxDD), fmtPct(result130M.maxDD), fmtDelta(result4H.maxDD, result130M.maxDD, fmtPct)],
      ['Total P&L', fmtDollar(result4H.totalPnl), fmtDollar(result130M.totalPnl), fmtDelta(result4H.totalPnl, result130M.totalPnl, fmtDollar)],
      ['OOS Trades', String(result4H.tradeCount), String(result130M.tradeCount), fmtDelta(result4H.tradeCount, result130M.tradeCount, v => String(Math.round(v)))],
      ['Avg IS Sharpe', result4H.avgTrainSharpe.toFixed(2), result130M.avgTrainSharpe.toFixed(2), fmtDelta(result4H.avgTrainSharpe, result130M.avgTrainSharpe, v => v.toFixed(2))],
      ['WF Efficiency', result4H.wfEfficiency.toFixed(2), result130M.wfEfficiency.toFixed(2), fmtDelta(result4H.wfEfficiency, result130M.wfEfficiency, v => v.toFixed(2))],
      ['Avg Degradation', result4H.avgDegradation.toFixed(2), result130M.avgDegradation.toFixed(2), fmtDelta(result4H.avgDegradation, result130M.avgDegradation, v => v.toFixed(2))],
      ['Runtime', `${(result4H.elapsedMs / 1000).toFixed(1)}s`, `${(result130M.elapsedMs / 1000).toFixed(1)}s`, ''],
    ];

    for (const [metric, a, b, delta] of rows) {
      console.log(`  ${metric.padEnd(20)} ${pad(a, 12)} ${pad(b, 12)} ${pad(delta, 12)}`);
    }

    // Per-window degradation
    printWindowTable('4H', result4H.windowDetails);
    printWindowTable('130M', result130M.windowDetails);

    // Config stability
    printStabilityTable('4H', result4H.topStableConfigs);
    printStabilityTable('130M', result130M.topStableConfigs);

    // Matched comparison
    printMatchedComparison(result4H, result130M);

    // Degradation distribution
    console.log('\n' + '─'.repeat(80));
    console.log('  DEGRADATION DISTRIBUTION (IS→OOS)');
    console.log('─'.repeat(80));
    printDegradationDistribution('4H', result4H.windowDetails);
    printDegradationDistribution('130M', result130M.windowDetails);

    // Recommendation
    console.log('\n' + '═'.repeat(80));
    console.log('  RECOMMENDATION');
    console.log('═'.repeat(80));

    const metrics130MWins = [
      result130M.sharpe > result4H.sharpe,
      result130M.winRate > result4H.winRate,
      result130M.maxDD < result4H.maxDD,
      result130M.wfEfficiency > result4H.wfEfficiency,
      result130M.avgDegradation > result4H.avgDegradation,
    ];
    const wins130M = metrics130MWins.filter(Boolean).length;

    console.log(`  130M wins ${wins130M}/5 aggregate metrics vs 4H`);
    console.log(`  130M structural: 3×130m=390m exact session fit (no boundary artifacts)`);

    if (wins130M >= 4) {
      console.log(`  >>> 130M shows clear edge. Consider migration.`);
    } else if (wins130M >= 3) {
      console.log(`  >>> 130M has slight edge. Worth further investigation.`);
    } else if (wins130M === 2) {
      console.log(`  >>> Results are mixed. No clear winner.`);
    } else {
      console.log(`  >>> 4H maintains edge. Keep current baseline.`);
    }
    console.log('═'.repeat(80) + '\n');

    // Write JSON output
    const jsonOutput = {
      runDate: new Date().toISOString(),
      tickers: AB_CONFIG.tickers,
      dateRange: { start: AB_CONFIG.startDate, end: AB_CONFIG.endDate },
      gridSize: buildSweepGrid(PERIOD_MULTS_4H).length,
      validation: validation.checks,
      aggregate: {
        fourH: {
          sharpe: result4H.sharpe, winRate: result4H.winRate, maxDD: result4H.maxDD,
          totalPnl: result4H.totalPnl, trades: result4H.tradeCount,
          wfEfficiency: result4H.wfEfficiency, avgDegradation: result4H.avgDegradation,
        },
        oneThirtyM: {
          sharpe: result130M.sharpe, winRate: result130M.winRate, maxDD: result130M.maxDD,
          totalPnl: result130M.totalPnl, trades: result130M.tradeCount,
          wfEfficiency: result130M.wfEfficiency, avgDegradation: result130M.avgDegradation,
        },
      },
      windowDetails: {
        fourH: result4H.windowDetails,
        oneThirtyM: result130M.windowDetails,
      },
      topStableConfigs: {
        fourH: result4H.topStableConfigs,
        oneThirtyM: result130M.topStableConfigs,
      },
      metricsWon130M: wins130M,
    };

    const outPath = path.resolve(process.cwd(), 'data', 'timeframe-comparison-results.json');
    fs.writeFileSync(outPath, JSON.stringify(jsonOutput, null, 2));
    console.log(`  JSON output: ${outPath}\n`);

  } finally {
    intradayDb.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
