/**
 * Campaign A — Regime Gate test on d65-tp40 champion
 *
 * Pre-registered in .prompts/campaign-a-regime-gate-preregistration.md (2026-04-16).
 *
 * Base strategy: d65-tp40 (deep ITM LEAP CALL, champion under bid/ask fills).
 * Test: add one of 6 pre-registered regime gates, evaluate under a WFA split
 *       that puts 2024-01-22 → 2026-02-27 entirely in holdout (holdoutCount=5).
 *
 * Run via:
 *   GATE=<name> AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-a \
 *     npx tsx scripts/autoresearch/runner.ts
 *
 * GATE values: none, ticker_ema200, breadth, spy_extension, contango_tight,
 *              rv_regime, trend_age
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

// ── Gate dispatch ──────────────────────────────────────────
const GATE = (process.env.GATE || 'none').toLowerCase();
const VALID_GATES = new Set([
  'none', 'ticker_ema200', 'breadth', 'spy_extension',
  'contango_tight', 'rv_regime', 'trend_age',
]);
if (!VALID_GATES.has(GATE)) {
  throw new Error(`Invalid GATE=${GATE}. Must be one of: ${[...VALID_GATES].join(', ')}`);
}
console.log(`[strategy.ts] Campaign A — GATE=${GATE}`);

// ── Campaign ticker list (d65-tp40 champion set) ──────────
const CAMPAIGN_TICKERS = [
  'GLD', 'IWM', 'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META',
  'JPM', 'GS', 'COST', 'UNH', 'NFLX', 'NVDA', 'TSLA',
];

// ── EMA helper (matches runner) ───────────────────────────
function computeEMA(closes: number[], period: number): number[] {
  const out = new Array(closes.length).fill(0);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

// ── Pre-compute breadth (Gate 2) + hv20 percentile (Gate 5) ─
// Breadth = fraction of CAMPAIGN_TICKERS with close > EMA200 on each date.
// Two sources: (1) local data-cache.json at module load for fast iteration;
// (2) fallback via strategy.prepare() using the runner's tickerDataMap, so
// cacheless Supabase paths don't silently disable these gates.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let breadthByDate: Map<string, number> = new Map();
let hv20PctByTickerDate: Map<string, Map<string, number>> = new Map();

// Percentile rank of the latest hv20 value in a trailing 252-day window.
// Requires at least 60 non-null observations to report.
function buildHv20PercentileMap(hv20Series: Array<number | null>, dates: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < hv20Series.length; i++) {
    const v = hv20Series[i];
    if (v == null) continue;
    const startI = Math.max(0, i - 252);
    const window = hv20Series.slice(startI, i + 1).filter((x): x is number => x != null);
    if (window.length < 60) continue;
    const pct = (window.filter(x => x <= v).length / window.length) * 100;
    out.set(dates[i], pct);
  }
  return out;
}

function computeBreadthFromAboveEmaMaps(
  perTicker: Array<{ dateToAbove: Map<string, boolean> }>,
  allDateSet: Set<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  const sortedDates = [...allDateSet].sort();
  for (const d of sortedDates) {
    let have = 0, above = 0;
    for (const row of perTicker) {
      const v = row.dateToAbove.get(d);
      if (v === undefined) continue;
      have++;
      if (v) above++;
    }
    if (have > 0) out.set(d, above / have);
  }
  return out;
}

// Fast path: data-cache.json on disk. Populated at module load if present.
{
  const cachePath = path.resolve(__dirname, 'data-cache.json');
  if (fs.existsSync(cachePath)) {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const perTickerAboveEma: Array<{ dateToAbove: Map<string, boolean> }> = [];
    const allDateSet = new Set<string>();
    for (const t of CAMPAIGN_TICKERS) {
      const td = cache.tickers[t];
      if (!td) continue;
      const closes: number[] = td.candles.map((c: any) => c.close);
      const ema200 = computeEMA(closes, 200);
      const dateToAbove = new Map<string, boolean>();
      for (let i = 0; i < td.candles.length; i++) {
        const d = td.candles[i].date;
        allDateSet.add(d);
        if (ema200[i] > 0) dateToAbove.set(d, closes[i] > ema200[i]);
      }
      const ivRows = td.iv || [];
      const hv20Series: Array<number | null> = td.candles.map((c: any) => {
        const row = ivRows.find((r: any) => r.date === c.date);
        return row && row.hv20 != null && Number.isFinite(row.hv20) ? row.hv20 : null;
      });
      const dates: string[] = td.candles.map((c: any) => c.date);
      hv20PctByTickerDate.set(t, buildHv20PercentileMap(hv20Series, dates));
      perTickerAboveEma.push({ dateToAbove });
    }
    breadthByDate = computeBreadthFromAboveEmaMaps(perTickerAboveEma, allDateSet);
    console.log(`[strategy.ts] Pre-computed breadth for ${breadthByDate.size} dates across ${perTickerAboveEma.length} tickers (cache path)`);
  }
}

// ── Gate parameters (pre-registered) ──────────────────────
const BREADTH_MIN = 0.60;
const SPY_EXTENSION_MAX = 0.10;   // reject when SPY > EMA200 × 1.10
const CONTANGO_PCT_TIGHT = 30;     // default was 48
const HV20_PCT_MAX = 25;           // bottom quartile realized vol
const MAX_TREND_AGE_DAYS = 120;

// ── Gate filter: returns true if signal PASSES gate ───────
function gateAllows(
  ticker: string,
  date: string,
  i: number,
  candles: { date: string; close: number }[],
  ema34: number[],
  ema200: number[],
  spy: { close: number; ema200: number } | undefined,
): boolean {
  switch (GATE) {
    case 'none':
      return true;

    case 'ticker_ema200':
      return ema200[i] > 0 && candles[i].close > ema200[i];

    case 'breadth': {
      const b = breadthByDate.get(date);
      return b !== undefined && b >= BREADTH_MIN;
    }

    case 'spy_extension': {
      if (!spy || spy.ema200 <= 0) return false;
      return spy.close / spy.ema200 <= (1 + SPY_EXTENSION_MAX);
    }

    case 'contango_tight':
      // handled inline via stricter contangoPct ceiling — allow here
      return true;

    case 'rv_regime': {
      const m = hv20PctByTickerDate.get(ticker);
      if (!m) return false;
      const p = m.get(date);
      return p !== undefined && p <= HV20_PCT_MAX;
    }

    case 'trend_age': {
      // Age = days since last close < ema34. Scan backward from i.
      let age = 0;
      for (let j = i; j >= 0; j--) {
        if (ema34[j] <= 0) break;
        if (candles[j].close < ema34[j]) break;
        age++;
      }
      return age <= MAX_TREND_AGE_DAYS;
    }

    default:
      return true;
  }
}

// ── Strategy definition ───────────────────────────────────
export const strategy: StrategyDefinition = {
  name: `d65-tp40-gate-${GATE}`,
  tickers: CAMPAIGN_TICKERS,

  // Fallback path when data-cache.json is absent (cacheless Supabase runs):
  // rebuild breadth/hv20 percentile maps from the runner's tickerDataMap so
  // `breadth` and `rv_regime` gates aren't silently disabled.
  prepare(tickerDataMap) {
    if (breadthByDate.size > 0) return;  // cache path already populated
    const perTickerAboveEma: Array<{ dateToAbove: Map<string, boolean> }> = [];
    const allDateSet = new Set<string>();
    for (const t of CAMPAIGN_TICKERS) {
      const td = tickerDataMap.get(t);
      if (!td) continue;
      const ema200 = td.emas.get(200);
      if (!ema200) continue;
      const dateToAbove = new Map<string, boolean>();
      for (let i = 0; i < td.candles.length; i++) {
        const d = td.candles[i].date;
        allDateSet.add(d);
        if (ema200[i] > 0) dateToAbove.set(d, td.candles[i].close > ema200[i]);
      }
      // hv20 series: TickerDataBundle exposes hv20 via ivRanks? If not, leave
      // rv_regime disabled for that ticker — prepare() can only build what the
      // bundle carries. (ivRanks / hv20 come from the runner's IV cache.)
      const dates = td.candles.map(c => c.date);
      const hv20Series = td.candles.map((_, i) => {
        const v = td.hv20?.[i];
        return v != null && Number.isFinite(v) ? v : null;
      });
      if (td.hv20) hv20PctByTickerDate.set(t, buildHv20PercentileMap(hv20Series, dates));
      perTickerAboveEma.push({ dateToAbove });
    }
    breadthByDate = computeBreadthFromAboveEmaMaps(perTickerAboveEma, allDateSet);
    console.log(`[strategy.ts] Rebuilt breadth for ${breadthByDate.size} dates + hv20 pct for ${hv20PctByTickerDate.size} tickers (prepare hook, cacheless path)`);
  },

  portfolio: {
    maxPositions: 4,
    maxPerTicker: 1,
    startingCapital: 10000,
  },

  wfa: {
    trainWindowDays: 252,
    forwardStepDays: 126,
    purgeGapDays: 10,
    mode: 'rolling' as const,
    // holdoutCount=5 puts holdout = 2024-01-22 -> 2026-02-27 (5 windows).
    // This covers the 45-loss streak (Jan 2025+). Selection ends 2024-01-19.
    holdoutCount: 5,
  },

  buildConfig(_ticker: string, _direction: 'CALL' | 'PUT'): SimConfig {
    // d65-tp40 champion parameters (the current best under bid/ask fills)
    return {
      ...DEFAULT_LEAP_CONFIG,
      mode: 'LEAP' as const,
      leapDeltaRange: [0.65, 0.80] as [number, number],
      leapDTERange: [180, 270] as [number, number],
      leapProfitTarget: 0.40,
      leapStopLoss: 0.30,
      leapTimeStopDTE: 105,
      monitoringIntervalDays: 1,
    };
  },

  generateSignals(data: TickerDataBundle, market: MarketContext): EntrySignal[] {
    const signals: EntrySignal[] = [];
    const ema8 = data.emas.get(8)!;
    const ema13 = data.emas.get(13)!;
    const ema34 = data.emas.get(34)!;
    const ema55 = data.emas.get(55)!;
    const ema200 = data.emas.get(200)!;
    const n = data.candles.length;

    // Gate 4 re-parameterizes contangoPct threshold. Default stays at 48.
    const contangoMax = GATE === 'contango_tight' ? CONTANGO_PCT_TIGHT : 48;

    for (let i = 60; i < n; i++) {
      const c = data.candles[i];

      // Validity guards (identical to champion)
      if (ema8[i] <= 0 || ema13[i] <= 0) continue;
      if (ema34[i] <= 0 || ema34[i - 5] <= 0) continue;
      if (ema55[i] <= 0) continue;
      if (ema200[i] <= 0) continue;

      const spy = market.spyByDate.get(c.date);
      if (!spy || !spy.ema200 || spy.ema200 <= 0) continue;

      // Baseline d65-tp40 gates
      if (spy.close <= spy.ema200) continue;            // SPY > EMA200
      if (c.close <= ema55[i]) continue;                // ticker > EMA55
      if (!(ema8[i] > ema13[i] && ema34[i] > ema34[i - 5])) continue;  // short-term momentum + EMA34 rising

      const pct = (c.close - ema34[i]) / ema34[i];
      if (!(pct >= 0 && pct < 0.05)) continue;          // 0-5% band above EMA34 (champion's 0-5%)

      const regime = data.regimeByDate.get(c.date);
      if (regime && regime.contangoPct !== undefined && regime.contangoPct >= contangoMax) continue;

      // Campaign A gate
      if (!gateAllows(data.ticker, c.date, i, data.candles, ema34, ema200, spy)) continue;

      signals.push({
        ticker: data.ticker,
        date: c.date,
        direction: 'CALL',
        score: Math.round(100 - pct * 1000),   // proximity score (closer to EMA34 = higher)
      });
    }

    return signals;
  },
};
