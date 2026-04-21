/**
 * Autoresearch Runner — Evaluates strategy.ts via WFA
 *
 * This is the infrastructure the agent does NOT modify.
 * It bundles strategy.ts, loads data, runs WFA, computes combined Sharpe with DTE5,
 * and maintains the leaderboard.
 *
 * Usage: npx tsx scripts/autoresearch/runner.ts
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { Worker } from 'node:worker_threads';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../../.env.local'), override: true });

import type { BacktestCandle } from '../../src/lib/backtest/types';
import { computeIVRankMinMax } from '../../src/lib/backtest/iv-rank';
import { computeOptionAnalytics } from '../../src/lib/backtest/option-sim';
import { buildWFAWindows, computePortfolioDailyMetrics } from '../../src/lib/backtest/wfa-options';
import type {
  StrategyDefinition, TickerDataBundle, RegimeData, EntrySignal,
  DTE5Baseline, RunResult, WindowDef, WorkItem, WorkResult,
  MarketContext, ConfigVariant,
} from './types';
import type { SimConfig } from '../../src/lib/backtest/option-sim';
import {
  loadAdoptionGates, assertGatesUnchanged, assertGateConfigTracked,
  formatGatesSummary, type LoadedGates,
} from './lib/adoption-gates';
import {
  loadDatasetManifest, assertManifestConfigTracked, assertManifestUnchanged,
  windowFallsInHoldout, formatManifestSummary, type LoadedManifest,
} from './lib/dataset-manifest';
import {
  validatePerSeriesCoverage, summarizeTickerSeries, type TickerSeriesSummary,
} from './lib/series-validation';
import { validatePreRegOrBypass, formatPreRegSummary } from './lib/pre-reg-gate';
import { acquireRunnerLock, LockHeldError, type AcquiredLock } from './lib/file-lock';
import { appendTrial } from './lib/trial-ledger';
import { stripHoldoutMetrics } from './lib/leaderboard-redaction';
import { computeEffectiveSampleSize } from './lib/effective-sample-size';
import { bootstrapSharpeCI as bootstrapSharpeCILib } from './lib/bootstrap-sharpe';
import { computeMertensSharpeSE } from './lib/mertens-sharpe-se';
import { normalizeDsrSchema, leaderboardNeedsDsrMigration } from './lib/normalize-dsr-schema';

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const DATA_START = '2017-01-01';
const DATA_END = '2026-02-28';

// Adoption gates moved to config/adoption-gates.json per Phase 0.a.2 of the
// 2026-04-18 foundation rebuild. Runner loads the file, hashes it, and refuses
// to continue if the hash changes mid-campaign. Access them via the `GATES`
// module-scope handle populated in main().
let GATES: LoadedGates | null = null;
function gates(): LoadedGates {
  if (!GATES) throw new Error('Adoption gates accessed before main() loaded them.');
  return GATES;
}

// ── Supabase Helper ─────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── Local Data Cache ─────────────────────────────────────
// Generated once by: npx tsx scripts/autoresearch/prefetch-data.ts
// Eliminates 25+ Supabase round-trips per runner iteration.

interface LocalCache {
  generated: string;
  dataStart: string;
  dataEnd: string;
  spy: { dates: string[]; dailyReturns: number[] };
  tickers: Record<string, {
    candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    iv: Array<{ date: string; iv30: number | null; iv60: number | null; hv20: number | null }>;
  }>;
}

function getLocalCache(): LocalCache | null {
  const cachePath = path.resolve(__dirname, 'data-cache.json');
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as LocalCache;
  } catch {
    return null;
  }
}

// ── EMA Computation ─────────────────────────────────────

function computeEMASeries(closes: number[], period: number): number[] {
  const ema = new Array(closes.length).fill(0);
  if (closes.length < period) return ema;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function computeRollingPercentile(values: (number | undefined)[], window = 252): (number | undefined)[] {
  return values.map((v, i) => {
    if (v == null || !Number.isFinite(v)) return undefined;
    const start = Math.max(0, i - window);
    const w = values.slice(start, i + 1).filter((x): x is number => x != null && Number.isFinite(x));
    if (w.length < 60) return undefined;
    const le = w.filter(x => x <= v).length;
    return (le / w.length) * 100;
  });
}

// ── Naive Baseline Signal Generator ─────────────────────
// Generates periodic signals (every N trading days) with no technical filters.
// Direction matches the strategy's dominant direction so the gate compares
// the same market exposure — a CALL strategy vs a CALL baseline, a PUT strategy
// vs a PUT baseline.

function generateNaiveSignals(
  tickerDataMap: Map<string, TickerDataBundle>,
  intervalDays: number,
  direction: 'CALL' | 'PUT' = 'CALL',
): EntrySignal[] {
  const signals: EntrySignal[] = [];
  for (const [ticker, data] of tickerDataMap) {
    // Start at i=60 to match strategy warmup period
    for (let i = 60; i < data.candles.length; i += intervalDays) {
      signals.push({
        ticker,
        date: data.candles[i].date,
        direction,
        score: 50,
        ivRank: data.ivRanks[i] ?? undefined,
      });
    }
  }
  return signals;
}

// ── Data Loading ────────────────────────────────────────

async function loadTickerData(ticker: string, cache: LocalCache | null = null): Promise<TickerDataBundle> {
  let candleRows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
  let rawIVRows: Array<{ date: string; iv30: number | null; iv60: number | null; hv20: number | null }>;

  if (cache?.tickers[ticker]) {
    candleRows = cache.tickers[ticker].candles;
    rawIVRows = cache.tickers[ticker].iv;
  } else {
    const supabaseCandles = await supabaseGet('stock_candles',
      `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=10000`);
    candleRows = supabaseCandles.map((r: any) => ({
      date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0,
    }));
    const supabaseIV = await supabaseGet('orats_iv_cache',
      `select=date,iv30d,iv60d,hv20d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`);
    rawIVRows = supabaseIV.map((r: any) => ({ date: r.date, iv30: r.iv30d ?? null, iv60: r.iv60d ?? null, hv20: r.hv20d ?? null }));
  }

  const candles: BacktestCandle[] = candleRows.map((r) => ({
    date: r.date, timestamp: new Date(r.date).getTime(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));

  // IV data
  const ivByDate = new Map<string, { iv30: number | null; iv60: number | null; hv20: number | null }>();
  for (const r of rawIVRows) {
    ivByDate.set(r.date, { iv30: r.iv30, iv60: r.iv60, hv20: r.hv20 });
  }
  const ivSeries = candles.map(c => ivByDate.get(c.date)?.iv30 ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  // EMAs
  const closes = candles.map(c => c.close);
  const emaPeriods = [8, 13, 21, 34, 55, 200];
  const emas = new Map<number, number[]>();
  for (const p of emaPeriods) emas.set(p, computeEMASeries(closes, p));

  // Regime data
  const contangoSeries: (number | undefined)[] = [];
  const vrpSeries: (number | undefined)[] = [];
  for (const c of candles) {
    const iv = ivByDate.get(c.date);
    if (iv && iv.iv30 != null && Number.isFinite(iv.iv30) && iv.iv30 > 0) {
      contangoSeries.push(iv.iv60 != null && Number.isFinite(iv.iv60) ? (iv.iv60 / iv.iv30) - 1 : undefined);
      vrpSeries.push(iv.hv20 != null && Number.isFinite(iv.hv20) ? (iv.iv30 * iv.iv30) - (iv.hv20 * iv.hv20) : undefined);
    } else {
      contangoSeries.push(undefined);
      vrpSeries.push(undefined);
    }
  }
  const contangoPctSeries = computeRollingPercentile(contangoSeries);
  const vrpPctSeries = computeRollingPercentile(vrpSeries);

  const regimeByDate = new Map<string, RegimeData>();
  for (let i = 0; i < candles.length; i++) {
    regimeByDate.set(candles[i].date, {
      contango: contangoSeries[i],
      vrp: vrpSeries[i],
      contangoPct: contangoPctSeries[i],
      vrpPct: vrpPctSeries[i],
    });
  }

  const hv20 = candles.map(c => {
    const v = ivByDate.get(c.date)?.hv20;
    return v != null && Number.isFinite(v) ? v : null;
  });

  return { ticker, candles, ivRanks, hv20, dateToIdx, emas, regimeByDate };
}

// ── Market Context (SPY regime data for cross-asset gates) ──

async function buildMarketContext(cache: LocalCache | null): Promise<MarketContext> {
  let spyCandles: Array<{ date: string; close: number }>;

  if (cache?.tickers['SPY']) {
    spyCandles = cache.tickers['SPY'].candles.map(c => ({ date: c.date, close: c.close }));
  } else if (cache?.spy) {
    // SPY benchmark has dates+returns but not closes. Load from Supabase.
    const rows = await supabaseGet('stock_candles',
      `select=date,close&ticker=eq.SPY&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=10000`);
    spyCandles = rows.map((r: any) => ({ date: r.date, close: r.close }));
  } else {
    const rows = await supabaseGet('stock_candles',
      `select=date,close&ticker=eq.SPY&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=10000`);
    spyCandles = rows.map((r: any) => ({ date: r.date, close: r.close }));
  }

  const closes = spyCandles.map(c => c.close);
  const ema200 = computeEMASeries(closes, 200);

  const spyByDate = new Map<string, { close: number; ema200: number }>();
  for (let i = 0; i < spyCandles.length; i++) {
    spyByDate.set(spyCandles[i].date, { close: closes[i], ema200: ema200[i] });
  }

  return { spyByDate };
}

// ── SPY Benchmark ───────────────────────────────────────

interface SpyBenchmark {
  dates: string[];
  dailyReturns: number[];
  returnByDate: Map<string, number>;
}

/**
 * Load SPY daily closes, compute log-daily-returns as the market benchmark
 * for Information Ratio. Returns one row per trading day with the close-to-close
 * return for that day.
 */
async function loadSpyBenchmark(cache: LocalCache | null = null): Promise<SpyBenchmark> {
  if (cache?.spy) {
    const { dates, dailyReturns } = cache.spy;
    const returnByDate = new Map<string, number>();
    for (let i = 0; i < dates.length; i++) returnByDate.set(dates[i], dailyReturns[i]);
    return { dates, dailyReturns, returnByDate };
  }

  const rows = await supabaseGet(
    'stock_candles',
    `select=date,close&ticker=eq.SPY&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=10000`,
  );
  const dates: string[] = [];
  const dailyReturns: number[] = [];
  const returnByDate = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].close;
    const cur = rows[i].close;
    if (prev > 0 && cur > 0) {
      const r = (cur - prev) / prev;
      dates.push(rows[i].date);
      dailyReturns.push(r);
      returnByDate.set(rows[i].date, r);
    }
  }
  return { dates, dailyReturns, returnByDate };
}

/**
 * Information Ratio — risk-adjusted excess return vs a benchmark.
 * IR = mean(excess returns) / stdev(excess returns) × sqrt(252)
 *
 * Interpretation:
 * - IR > 0.5: strong manager-level alpha
 * - IR > 0: beats benchmark on risk-adjusted basis
 * - IR < 0: underperforms benchmark
 *
 * Unlike raw Sharpe, this is market-regime-neutral: a strategy that earns
 * 0% while SPY drops -20% has a high positive IR even though its standalone
 * Sharpe is ~0. Essential for strategies evaluated against a bad-market holdout.
 *
 * Uses date intersection — only days where both strategy and SPY have data.
 */
function computeInformationRatio(
  strategyReturns: number[],
  strategyDates: string[],
  spy: SpyBenchmark,
): { ir: number; excessReturn: number; overlapDays: number } {
  const stratMap = new Map<string, number>();
  for (let i = 0; i < strategyDates.length; i++) {
    stratMap.set(strategyDates[i], strategyReturns[i] ?? 0);
  }

  const excess: number[] = [];
  for (const d of strategyDates) {
    const sr = stratMap.get(d);
    const br = spy.returnByDate.get(d);
    if (sr !== undefined && br !== undefined) {
      excess.push(sr - br);
    }
  }

  if (excess.length < 20) {
    return { ir: 0, excessReturn: 0, overlapDays: excess.length };
  }

  const n = excess.length;
  const mean = excess.reduce((s, r) => s + r, 0) / n;
  const variance = excess.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);

  const ir = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  // Annualized excess return (simple, for communication)
  const excessReturn = mean * 252;

  return { ir, excessReturn, overlapDays: n };
}

// ── Combined Sharpe ─────────────────────────────────────

function computeCombinedMetrics(
  strategyReturns: number[],
  strategyDates: string[],
  baseline: DTE5Baseline,
): { combinedSharpe: number; correlation: number; combinedMaxDD: number } {
  // Build date-indexed maps
  const stratMap = new Map<string, number>();
  for (let i = 0; i < strategyDates.length; i++) {
    stratMap.set(strategyDates[i], strategyReturns[i] ?? 0);
  }
  const baseMap = new Map<string, number>();
  for (let i = 0; i < baseline.dates.length; i++) {
    baseMap.set(baseline.dates[i], baseline.dailyReturns[i] ?? 0);
  }

  // Union of all dates (sorted) — for combined portfolio Sharpe
  // On days where only one strategy has returns, the other contributes 0
  // (capital sits idle in that half). This is the correct 50/50 allocation model.
  const allDates = [...new Set([...strategyDates, ...baseline.dates])].sort();

  const combinedReturns: number[] = [];
  for (const d of allDates) {
    const sr = stratMap.get(d) ?? 0;
    const br = baseMap.get(d) ?? 0;
    combinedReturns.push(0.5 * sr + 0.5 * br);
  }

  // Combined Sharpe
  const mean = combinedReturns.reduce((s, r) => s + r, 0) / (combinedReturns.length || 1);
  const variance = combinedReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (combinedReturns.length || 1);
  const std = Math.sqrt(variance);
  const combinedSharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // Pearson correlation — ONLY on dates where BOTH strategies have non-zero returns.
  // Zero-padded correlation is misleading (shared rest days inflate it).
  const overlapStrat: number[] = [];
  const overlapBase: number[] = [];
  for (const d of allDates) {
    const sr = stratMap.get(d);
    const br = baseMap.get(d);
    // Only include if both have data for this date (even if return is 0 on a trading day)
    if (sr !== undefined && br !== undefined) {
      overlapStrat.push(sr);
      overlapBase.push(br);
    }
  }

  let correlation = 0;
  if (overlapStrat.length >= 20) {
    const n = overlapStrat.length;
    const meanS = overlapStrat.reduce((s, r) => s + r, 0) / n;
    const meanB = overlapBase.reduce((s, r) => s + r, 0) / n;
    let cov = 0, varS = 0, varB = 0;
    for (let i = 0; i < n; i++) {
      const ds = overlapStrat[i] - meanS;
      const db = overlapBase[i] - meanB;
      cov += ds * db;
      varS += ds * ds;
      varB += db * db;
    }
    correlation = (varS > 0 && varB > 0) ? cov / (Math.sqrt(varS) * Math.sqrt(varB)) : 0;
  }

  // Combined MaxDD
  let peak = 1;
  let equity = 1;
  let maxDD = 0;
  for (const r of combinedReturns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return { combinedSharpe, correlation, combinedMaxDD: maxDD };
}

// ── Overfitting Defenses ────────────────────────────────

// Phase 2.b: `bootstrapSharpeCI` extracted to
// `./lib/bootstrap-sharpe.ts` so coverage-validation tests can import it
// without dragging in the whole runner graph. The runner's only behavior
// change is the imported name below.
function bootstrapSharpeCI(dailyReturns: number[], iterations = gates().gates.bootstrapIterations): [number, number] {
  return bootstrapSharpeCILib(dailyReturns, iterations);
}

/**
 * Deflated Sharpe Ratio — adjusts for multiple testing.
 * Based on Bailey & López de Prado (2014): "The Deflated Sharpe Ratio"
 *
 * Uses Gumbel EVT for expected max of N i.i.d. standard normals, scaled by the
 * bootstrap SE of the Sharpe estimator. Positive deflated Sharpe = likely real edge.
 */
function computeDeflatedSharpe(observedSharpe: number, numAttempts: number, sharpeSE: number): number {
  if (numAttempts <= 1) return observedSharpe;
  if (sharpeSE <= 0) return observedSharpe;
  const gamma = 0.5772; // Euler-Mascheroni
  const logN = Math.log(numAttempts);
  const sqrtTwoLogN = Math.sqrt(2 * logN);
  // Gumbel location/scale for max of N standard normals
  const a_N = sqrtTwoLogN - (Math.log(4 * Math.PI) + Math.log(logN)) / (2 * sqrtTwoLogN);
  const b_N = 1.0 / sqrtTwoLogN;
  const expectedMaxStdNormal = a_N + gamma * b_N;
  // Each trial's Sharpe ~ N(0, SE) under null → scale expected max accordingly
  const expectedMaxSharpe = sharpeSE * expectedMaxStdNormal;
  return observedSharpe - expectedMaxSharpe;
}

// ── Leaderboard ─────────────────────────────────────────
//
// Two files:
//   data/leaderboard-full.json — full internal metrics (gitignored)
//   leaderboard.json           — agent-visible: holdout numeric fields stripped
//
// The exact holdout Sharpe, IR, and ratio are the fields that leak. Boolean gate
// results (passesHoldout, passesHoldoutOrIR, isValid) are safe to keep.

// Holdout-redaction constant + stripping function moved to
// ./lib/leaderboard-redaction.ts in Phase 0.a.4 so tests can import them
// without pulling the runner's worker/backtest graph.

// Apply a ConfigVariant's overrides onto a base SimConfig without losing nested
// sibling fields. SimConfig has two object-valued fields (`signalInvalidation`,
// `slippage`) that must be merged one level deep; everything else at the top
// level is primitive/array-valued and replacement is the correct override
// semantic. Adversarial review finding (Codex, post-remediation): a shallow
// spread silently wiped sibling fields on any nested override.
function mergeConfigOverrides(base: SimConfig, over: Partial<SimConfig> | undefined): SimConfig {
  if (!over) return { ...base };
  const out = { ...base, ...over } as SimConfig;
  if (over.signalInvalidation && base.signalInvalidation) {
    out.signalInvalidation = { ...base.signalInvalidation, ...over.signalInvalidation };
  }
  if (over.slippage && base.slippage) {
    out.slippage = { ...base.slippage, ...over.slippage };
  }
  return out;
}

// Backfill `isValidForSearch` on entries that predate the split.
// Pre-split entries only have `isValid` (which already embedded the holdout gate).
// For those rows we reconstruct search-validity from the individual pass fields
// when present, and fall back to `isValid` otherwise — a true `isValid` strictly
// implies `isValidForSearch`, since the full gate is the search gate AND holdout.
function backfillIsValidForSearch(entry: RunResult): RunResult {
  if (typeof (entry as unknown as { isValidForSearch?: unknown }).isValidForSearch === 'boolean') {
    return entry;
  }
  const e = entry as unknown as Record<string, unknown>;
  const allPassFields = [
    e.passesMinTrades,
    e.passesMaxDD,
    e.passesWFA,
    e.passesSanity,
    e.passesDeltaGates,
  ];
  const hasAllFields = allPassFields.every(v => typeof v === 'boolean');
  const computed = hasAllFields
    ? allPassFields.every(Boolean)
    : Boolean(e.isValid);
  return { ...entry, isValidForSearch: computed } as RunResult;
}

// Phase 2.j migration — extracted to `./lib/normalize-dsr-schema.ts`
// in Phase 2.k so tests can exercise the REAL helper rather than a
// duplicated copy (Codex round-24 Finding 2).

// Optional suffix for leaderboard files — lets a campaign run in isolation
// (e.g. AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-a writes to
// leaderboard-campaign-a.json / leaderboard-full-campaign-a.json).
// Prior runs' leaderboards are untouched, and deflated Sharpe resets to N=1.
function leaderboardSuffix(): string {
  const s = process.env.AUTORESEARCH_LEADERBOARD_SUFFIX;
  return s ? `-${s}` : '';
}

// Global attempt counter across ALL campaigns — fixes Codex adversarial
// finding (high #5): per-campaign leaderboards reset deflatedSharpe's N,
// understating the true serial search burden. The counter now lives inside
// the Phase 0.a.3 trial ledger (scripts/autoresearch/lib/trial-ledger.ts)
// along with per-trial return vectors used to compute N_eff. The count
// persists across every runner invocation regardless of suffix.

function leaderboardPaths(): { fullPath: string; agentPath: string } {
  const suf = leaderboardSuffix();
  return {
    fullPath: path.resolve(__dirname, `../../data/leaderboard-full${suf}.json`),
    agentPath: path.resolve(__dirname, `leaderboard${suf}.json`),
  };
}

function loadLeaderboard(): RunResult[] {
  // Read the full (unstripped) leaderboard only. The agent-visible file drops
  // `isValid` and holdout fields by design; falling back to it would silently
  // corrupt champion selection (`filter(e => e.isValid)` would return []).
  // On a first-run-after-patch the migration block in main() populates
  // fullPath from agentPath, so this file always exists for any campaign
  // that had prior history.
  const { fullPath } = leaderboardPaths();
  if (!fs.existsSync(fullPath)) return [];
  const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as RunResult[];
  return raw.map(backfillIsValidForSearch).map(normalizeDsrSchema);
}

function saveLeaderboard(entries: RunResult[]) {
  const { fullPath, agentPath } = leaderboardPaths();
  fs.writeFileSync(fullPath, JSON.stringify(entries, null, 2));
  fs.writeFileSync(agentPath, JSON.stringify(entries.map(stripHoldoutMetrics), null, 2));
}

// ── CLI Flags ───────────────────────────────────────────

const SCREEN_MODE = process.argv.includes('--screen');
const SCREEN_SELECTION_WINDOWS = 4;  // fewer windows for fast triage

// ── Worker Helpers ──────────────────────────────────────

async function spawnOneWorker(bundle: string, initData: object): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const w = new Worker(bundle, { workerData: initData });
    w.once('message', (msg) => {
      if (msg?.type === 'ready') resolve(w);
      else reject(new Error('Worker failed to initialize'));
    });
    w.once('error', reject);
  });
}

async function evalOnWorker(
  worker: Worker, id: number, simConfig: SimConfig,
  selWindows: WindowDef[], holdWindows: WindowDef[],
  putSimConfig?: SimConfig,
): Promise<WorkResult> {
  return new Promise((resolve, reject) => {
    const onMsg = (msg: WorkResult) => {
      if (msg.type === 'result' && msg.id === id) {
        worker.off('message', onMsg);
        worker.off('error', onErr);
        resolve(msg);
      }
    };
    const onErr = (err: Error) => {
      worker.off('message', onMsg);
      worker.off('error', onErr);
      reject(err);
    };
    worker.on('message', onMsg);
    worker.on('error', onErr);
    const workItem: WorkItem = {
      type: 'eval', id, simConfig,
      selectionWindows: selWindows,
      holdoutWindows: holdWindows,
    };
    if (putSimConfig) workItem.putSimConfig = putSimConfig;
    worker.postMessage(workItem);
  });
}

async function terminateWorker(w: Worker) {
  w.postMessage({ type: 'exit' });
  await w.terminate();
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log('=== Autoresearch Runner ===\n');

  // 0pre. Acquire cross-process lock on the runner's writable artifacts
  //       (leaderboard-*.json, attempts-global.json). Without this, two
  //       runner processes started near-simultaneously can silently lose
  //       one process's RunResult row and undercount the global attempt
  //       counter — Codex round-3 Finding 2, 2026-04-18.
  let runnerLock: AcquiredLock;
  try {
    const repoRoot = path.resolve(__dirname, '../..');
    const suffixLbl = process.env.AUTORESEARCH_LEADERBOARD_SUFFIX
      ? `campaign=${process.env.AUTORESEARCH_LEADERBOARD_SUFFIX}`
      : 'primary';
    runnerLock = acquireRunnerLock(repoRoot, `runner:${suffixLbl}`);
    console.log(`Acquired runner lock at ${runnerLock.lockPath}\n`);
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(`\nFATAL: ${err.message}`);
      console.error(`Wait for the other runner to finish, or kill pid ${err.held.pid} if it's stuck.`);
      console.error(`If you are certain no runner is active, delete ${err.lockPath} and retry.`);
    } else {
      console.error(`\nFATAL: could not acquire runner lock: ${(err as Error).message}`);
    }
    process.exit(1);
  }

  // Install removable crash handlers so the lock is released even if
  // main() throws in the middle. Codex round-5 + round-6 Finding 2: all
  // listeners (incl. 'exit') are named closures and removed in the finally
  // block below, so sequential same-pid invocations don't leak.
  const onUncaught = (e: unknown): void => {
    console.error('[uncaughtException]', e);
    runnerLock.release();
    process.exit(1);
  };
  const onUnhandled = (e: unknown): void => {
    console.error('[unhandledRejection]', e);
    runnerLock.release();
    process.exit(1);
  };
  const onExit = (): void => {
    // Defensive: if we ever reach process-exit with the lock still held
    // (e.g. test killed us), release it. Normal-path release happens in
    // the `finally` below.
    runnerLock.release();
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  process.on('exit', onExit);

  try {
  // 0.DSR. Phase 2.k/2.l boot-time DSR migration — runs FIRST, before any
  //     gate / manifest / pre-reg guard that could early-exit. External
  //     consumers (analyze-*.ts, search-loop agent) read the leaderboard
  //     JSON directly on disk; if the runner dies on a dirty pre-reg or
  //     missing manifest, those consumers would keep seeing Phase 2.g-era
  //     mixed-schema rows until the operator fixes the guard. Running the
  //     migration up-front makes the on-disk files clean regardless of
  //     whether the rest of main() succeeds. Codex round-25 (2026-04-20).
  {
    const { fullPath, agentPath } = leaderboardPaths();
    if (fs.existsSync(fullPath)) {
      const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as RunResult[];
      if (leaderboardNeedsDsrMigration(raw)) {
        const migrated = raw.map(backfillIsValidForSearch).map(normalizeDsrSchema);
        fs.writeFileSync(fullPath, JSON.stringify(migrated, null, 2));
        fs.writeFileSync(agentPath, JSON.stringify(migrated.map(stripHoldoutMetrics), null, 2));
        const suffixLabel = leaderboardSuffix() || '(primary)';
        console.log(`Migrated ${migrated.length} ${suffixLabel} leaderboard entries → Phase 2.i DSR schema (Codex r25)`);
        console.log('');
      }
    }
  }

  // 0a. Load adoption gates (Phase 0.a.2 of 2026-04-18 foundation rebuild).
  //     Hardcoded gate constants were moved to config/adoption-gates.json.
  //     The file is hashed here; gates().assertGatesUnchanged() re-checks the
  //     hash at end of main() so mid-campaign edits abort the run.
  //     The file is ALSO required to be tracked+clean in git — stamping the
  //     hash of an unrecoverable local file into the leaderboard would make
  //     the audit meaningless. Codex round-6 Finding 1.
  try {
    GATES = loadAdoptionGates();
    assertGateConfigTracked(GATES);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    console.error('Cannot start autoresearch without valid adoption gates configuration.');
    process.exit(1);
  }
  console.log(formatGatesSummary(GATES));

  // 0a2. Dataset manifest (Phase 0.b.6). Declares the dataset + holdout
  //      date range. Its sha256 is what the Pre-Registration block's
  //      "Holdout Window Hash" must match — closes the semantic-binding
  //      gap that pre-reg-gate.ts previously flagged with a TODO comment.
  let MANIFEST: LoadedManifest;
  try {
    MANIFEST = loadDatasetManifest();
    assertManifestConfigTracked(MANIFEST);
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    console.error('Cannot start autoresearch without valid dataset manifest.');
    process.exit(1);
  }
  console.log(formatManifestSummary(MANIFEST));

  // Phase 0.b.6 round-2: the module-level DATA_START / DATA_END constants
  // feed the Supabase fetchers. They must match the manifest or the fetch
  // paths would silently load a different range than the manifest claims.
  // Refactoring the loaders to be manifest-driven is larger scope — this
  // runtime assertion is the cheap defense.
  if (DATA_START !== MANIFEST.manifest.dataStartDate || DATA_END !== MANIFEST.manifest.dataEndDate) {
    console.error(`\nFATAL: runner.ts DATA_START/DATA_END constants (${DATA_START} / ${DATA_END}) do not match the committed manifest (${MANIFEST.manifest.dataStartDate} / ${MANIFEST.manifest.dataEndDate}).`);
    console.error(`Update scripts/autoresearch/runner.ts so the constants equal config/dataset-manifest.json's dataStartDate/dataEndDate, then commit both.`);
    process.exit(1);
  }

  // 0b. Pre-registration gate (Phase 0.a.1).
  //     Every autoresearch run must reference a committed Pre-Registration block
  //     in .handoff/current.md (hypothesis, config grid, decision rule, adoption
  //     threshold, holdout window hash). Set AUTORESEARCH_PREREG_BYPASS="<reason>"
  //     to skip this (reason is logged and counts as a declared trial).
  //     Env overrides on gates must be declared in the pre-reg block.
  //     git-clean requirement is not opt-outable in production — the only way to
  //     run against a dirty .handoff/current.md is the explicit BYPASS flow above
  //     (Codex adversarial-review Finding 1, 2026-04-18).
  const declaredEnvOverrides = GATES.envOverrides.map(o => o.envVar);
  const preRegOutcome = validatePreRegOrBypass({
    requireGitClean: true,
    envOverridesRequired: declaredEnvOverrides,
  });
  if (!preRegOutcome.ok) {
    console.error(`\nFATAL: Pre-registration gate blocked the run.`);
    console.error(`Reason: ${preRegOutcome.reason}`);
    if (preRegOutcome.hint) console.error(`Hint:   ${preRegOutcome.hint}`);
    console.error('');
    console.error('See .handoff/TEAM.md "Pre-Registration Convention" or the 2026-04-18 foundation rebuild plan.');
    process.exit(1);
  }
  console.log('');
  console.log(formatPreRegSummary(preRegOutcome));
  console.log('');

  // Pre-registration audit metadata persisted onto every leaderboard entry
  // produced during this run (Codex re-review Finding 2, 2026-04-18).
  const preRegAudit = preRegOutcome.bypassed
    ? {
        preRegBypassed: true as const,
        preRegBypassReason: preRegOutcome.bypassReason,
        preRegBlockHash: undefined,
        preRegGitSha: undefined,
        preRegHoldoutWindowHash: undefined,
      }
    : {
        preRegBypassed: false as const,
        preRegBypassReason: undefined,
        preRegBlockHash: preRegOutcome.block.blockHash,
        preRegGitSha: preRegOutcome.gitSha,
        preRegHoldoutWindowHash: preRegOutcome.block.holdoutWindowHash,
      };

  // Phase 0.b.6 semantic binding: the pre-reg block's "Holdout Window Hash"
  // must match the committed dataset manifest's sha256. Placeholder hashes
  // (e.g. sha256:0000...0000) no longer pass — the operator must use the
  // current manifest hash. Bypassed runs don't have a block to check.
  if (!preRegOutcome.bypassed) {
    const expected = `sha256:${MANIFEST.rawHash}`;
    if (preRegOutcome.block.holdoutWindowHash !== expected) {
      console.error(`\nFATAL: Pre-Registration "Holdout Window Hash" does not match the committed dataset manifest.`);
      console.error(`  pre-reg:  ${preRegOutcome.block.holdoutWindowHash}`);
      console.error(`  manifest: ${expected}`);
      console.error(`Either update the Pre-Registration block to the current manifest hash, or commit a new manifest.`);
      process.exit(1);
    }
  }

  // 0. One-time migration: if leaderboard-full*.json doesn't exist but leaderboard*.json does,
  //    copy full data there and rewrite leaderboard*.json with holdout metrics stripped.
  //    Runs for the default suffix AND for any campaign suffix — the full file
  //    is gitignored so a fresh clone only has the stripped (agent-visible) file.
  //    Each invocation is idempotent: it fires only when fullPath is missing.
  {
    const { fullPath, agentPath } = leaderboardPaths();
    if (!fs.existsSync(fullPath) && fs.existsSync(agentPath)) {
      const raw = JSON.parse(fs.readFileSync(agentPath, 'utf-8')) as RunResult[];
      const existing = raw.map(backfillIsValidForSearch).map(normalizeDsrSchema);
      fs.writeFileSync(fullPath, JSON.stringify(existing, null, 2));
      fs.writeFileSync(agentPath, JSON.stringify(existing.map(stripHoldoutMetrics), null, 2));
      const backfilled = existing.length - raw.filter(e => typeof (e as unknown as { isValidForSearch?: unknown }).isValidForSearch === 'boolean').length;
      const suffixLabel = leaderboardSuffix() || '(primary)';
      console.log(`Migrated ${existing.length} existing ${suffixLabel} leaderboard entries → ${path.basename(fullPath)} (full) + ${path.basename(agentPath)} (stripped)`);
      if (backfilled > 0) console.log(`  Backfilled isValidForSearch on ${backfilled} pre-split entries`);
      console.log('');
    }
  }
  // 0a. Phase 2.k/2.l DSR migration moved earlier — see section 0.DSR
  //     near the top of main(). Kept inline comment to make the
  //     relocation obvious in git blame.
  if (leaderboardSuffix()) {
    console.log(`CAMPAIGN MODE: leaderboard suffix="${leaderboardSuffix()}" — isolated from primary leaderboard\n`);
  }

  // 1. Load DTE5 baseline
  const baselinePath = path.resolve(__dirname, 'dte5-baseline.json');
  if (!fs.existsSync(baselinePath)) {
    console.error('ERROR: dte5-baseline.json not found. Run generate-baseline.ts first.');
    process.exit(1);
  }
  const baseline: DTE5Baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  console.log(`DTE5 baseline: Sharpe ${baseline.oosSharpe.toFixed(3)}, ${baseline.dates.length} dates`);

  // 1b. Load SPY benchmark (local cache if available, else Supabase)
  const localCache = getLocalCache();
  if (localCache) {
    console.log(`Using local data cache (generated: ${localCache.generated})`);
    console.log(`Tip: re-run prefetch-data.ts to refresh if data range changes\n`);
  } else {
    console.log('No local cache — fetching from Supabase.');
    console.log('Run: npx tsx scripts/autoresearch/prefetch-data.ts  to cache locally\n');
  }

  console.log('Loading SPY benchmark + market context...');
  const spyBenchmark = await loadSpyBenchmark(localCache);
  const marketContext = await buildMarketContext(localCache);
  console.log(`SPY benchmark: ${spyBenchmark.dates.length} daily returns, ${marketContext.spyByDate.size} market context dates\n`);

  // 2. Bundle strategy.ts
  // AUTORESEARCH_STRATEGY_FILENAME lets parallel campaigns use their own strategy file
  // (e.g. strategy-option3.ts) without conflicting with the primary one.
  const strategyFilename = process.env.AUTORESEARCH_STRATEGY_FILENAME || 'strategy.ts';
  const strategySrc = path.resolve(__dirname, strategyFilename);
  const bestStrategyFilename = `best-${strategyFilename}`;
  const strategyBundle = path.resolve(__dirname, `.autoresearch-${strategyFilename.replace(/\.ts$/, '')}.mjs`);

  const strategyRelFromRoot = path.relative(path.resolve(__dirname, '../..'), strategySrc);
  const repoRootForGit = path.resolve(__dirname, '../..');
  console.log(`Bundling ${strategyFilename}...`);
  try {
    execSync(
      `npx esbuild ${strategySrc} --bundle --platform=node --format=esm --outfile=${strategyBundle} --external:better-sqlite3 --packages=external`,
      { cwd: path.resolve(__dirname, '../..'), stdio: 'pipe' },
    );
  } catch (err: any) {
    console.error('\n=== SYNTAX ERROR in strategy.ts ===');
    console.error(err.stderr?.toString() || err.message);
    console.error('Fix the error and re-run.');
    process.exit(1);
  }

  // 3. Dynamic import
  const strategyModule = await import(strategyBundle);
  const strategy: StrategyDefinition = strategyModule.strategy || strategyModule.default;
  if (!strategy || !strategy.name || !strategy.tickers || !strategy.generateSignals) {
    console.error('ERROR: strategy.ts must export a StrategyDefinition as `strategy` or default export.');
    process.exit(1);
  }
  console.log(`Strategy: "${strategy.name}", tickers: [${strategy.tickers.join(', ')}]\n`);

  // Phase 0.a.5 provenance: capture AFTER esbuild completes so SHAs reflect
  // the exact source state that was bundled. (If the operator edits a source
  // file between here and here, esbuild already wrote the bundle — the worker
  // uses that bundle, not the current file.) Three stamps:
  //   - strategyGitSha: last commit that touched the strategy file.
  //   - strategyBlobSha: content hash of the strategy file (git hash-object).
  //   - repoGitSha: HEAD of the whole repo, null if the working tree is dirty.
  // Codex round-4 note: a determined adversary could edit+revert a source
  // file during the runner run; the bundle captures the edit but the SHAs
  // see only the reverted state. This is documented in docs/sealed-holdout.md
  // and considered out-of-scope for solo-operator trust. A future phase may
  // isolate execution in a temp worktree to close it entirely.
  const strategyGitSha: string | null = (() => {
    try {
      const dirty = execSync(`git status --porcelain -- "${strategyRelFromRoot}"`, { cwd: repoRootForGit, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      if (dirty.length > 0) return null;
      const sha = execSync(`git log -n 1 --format=%H -- "${strategyRelFromRoot}"`, { cwd: repoRootForGit, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      return sha || null;
    } catch {
      return null;
    }
  })();
  const strategyBlobSha: string | null = (() => {
    try {
      const sha = execSync(`git hash-object "${strategyRelFromRoot}"`, { cwd: repoRootForGit, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      return sha || null;
    } catch {
      return null;
    }
  })();
  const repoGitSha: string | null = (() => {
    try {
      const dirty = execSync(`git status --porcelain`, { cwd: repoRootForGit, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      if (dirty.length > 0) return null;
      const head = execSync(`git rev-parse HEAD`, { cwd: repoRootForGit, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      return head || null;
    } catch {
      return null;
    }
  })();
  if (!strategyGitSha) {
    console.warn(`  (strategy file is untracked or dirty — produced rows will be unsealable: ${strategyRelFromRoot})`);
  } else {
    console.log(`Strategy git SHA: ${strategyGitSha.slice(0, 10)}`);
  }
  if (!repoGitSha) {
    console.warn(`  (working tree has uncommitted changes — produced rows will be unsealable)`);
  } else {
    console.log(`Repo HEAD:        ${repoGitSha.slice(0, 10)}`);
  }
  if (strategyBlobSha) console.log(`Strategy blob:    ${strategyBlobSha.slice(0, 10)}\n`);

  // 4. Load ticker data (parallel — local cache = instant, Supabase = parallel fetch)
  console.log('Loading ticker data...');
  const tickerEntries = await Promise.all(
    strategy.tickers.map(async (ticker) => {
      const data = await loadTickerData(ticker, localCache);
      process.stdout.write(`  ${ticker}: ${data.candles.length} candles\n`);
      return [ticker, data] as const;
    }),
  );
  const tickerDataMap = new Map<string, TickerDataBundle>(tickerEntries);

  // Phase 0.b.7 per-series coverage check. Runs BEFORE signal generation
  // so a truncated ticker can't silently contribute zero signals while
  // other tickers' coverage masks the gap in the union-based bounds check.
  // Closes Codex Phase 0.b.6 round-3 F1.
  //
  // Round-1 fix (Codex 0.b.7 F1+F2): pass the full marketContext SPY date
  // list so coverage is validated against candle dates (not the benchmark's
  // return dates, which are one trading day later), and cross-check the
  // two SPY sources on their full date sequences.
  const perTickerSeries: Record<string, TickerSeriesSummary> = {};
  for (const [ticker, data] of tickerDataMap) {
    perTickerSeries[ticker] = summarizeTickerSeries(data.candles);
  }
  const marketCtxDates = [...marketContext.spyByDate.keys()].sort();
  const coverage = validatePerSeriesCoverage(
    perTickerSeries, spyBenchmark.dates, marketCtxDates, MANIFEST.manifest,
  );
  if (!coverage.ok) {
    console.error(`\nFATAL: per-series dataset check failed — ${coverage.reason}`);
    if (coverage.hint) console.error(`Hint: ${coverage.hint}`);
    process.exit(1);
  }
  const tickerCoverageHash = coverage.tickerCoverageHash;
  console.log(`Ticker coverage hash: ${tickerCoverageHash.slice(0, 12)}...`);

  // 5. Generate signals
  // Invoke strategy.prepare() if defined, so strategies that need cross-ticker
  // derived data (e.g. breadth, rv_regime) can build it from the loaded
  // tickerDataMap rather than a serialized cache on disk.
  if (typeof strategy.prepare === 'function') {
    strategy.prepare(tickerDataMap, marketContext);
  }
  console.log('\nGenerating signals...');
  const allSignals: import('./types').EntrySignal[] = [];
  for (const [ticker, data] of tickerDataMap) {
    const signals = strategy.generateSignals(data, marketContext);
    console.log(`  ${ticker}: ${signals.length} signals`);
    allSignals.push(...signals);
  }
  if (allSignals.length === 0) {
    printErrorResult(strategy.name, 'No signals generated. Entry conditions too restrictive.', startMs);
    process.exit(0);
  }
  console.log(`  Total: ${allSignals.length} signals\n`);

  // Determine trading dates (union of all tickers, sorted)
  const allDateSet = new Set<string>();
  for (const data of tickerDataMap.values()) {
    for (const c of data.candles) allDateSet.add(c.date);
  }
  const allTradingDates = [...allDateSet].sort();

  // 6. Build WFA windows
  const wfa = strategy.wfa;
  // AUTORESEARCH_SKIP_HOLDOUT=1 (Phase 0.a.5): the disciplined-researcher
  // opt-out. When set, the runner evaluates on selection windows only and
  // emits empty holdout metrics. Produces audit rows that the seal ceremony
  // will refuse (no holdout data to seal), forcing a deliberate re-run
  // before promotion. Default off → preserves existing audit-file workflow.
  const skipHoldout = ['1', 'true', 'yes'].includes(String(process.env.AUTORESEARCH_SKIP_HOLDOUT ?? '').toLowerCase());
  const holdoutCount = skipHoldout ? 0 : (wfa.holdoutCount ?? 2);
  const wfaStartDate = allTradingDates.find(d => d >= '2018-01-01') ?? allTradingDates[0];
  const allWindows = buildWFAWindows(allTradingDates, {
    trainWindowDays: wfa.trainWindowDays,
    forwardStepDays: wfa.forwardStepDays,
    purgeGapDays: wfa.purgeGapDays,
    mode: wfa.mode,
    startDate: wfaStartDate,
    endDate: allTradingDates[allTradingDates.length - 1],
  });
  // Guard the slice(0, -0) footgun: -0 collapses to 0 → slice(0, 0) returns [].
  const selectionWindows = holdoutCount === 0 ? [...allWindows] : allWindows.slice(0, -holdoutCount);
  const holdoutWindows = holdoutCount === 0 ? [] : allWindows.slice(-holdoutCount);
  if (skipHoldout) {
    console.log(`AUTORESEARCH_SKIP_HOLDOUT=1 — holdout evaluation disabled (discipline mode).`);
  }
  console.log(`WFA: ${selectionWindows.length} selection + ${holdoutWindows.length} holdout windows\n`);

  // Phase 0.b.6 data-bounds check: the loaded dataset must actually fit
  // within AND reach the manifest's declared [dataStartDate, dataEndDate]
  // range. Codex round-1 F1: metadata-only binding wasn't enough — a
  // vendor backfill, corrected early history, truncated feed, or stale
  // cache could all change WFA outcomes while the manifest hash passed.
  // Round 2 F1 (post-ship): also require the data to REACH the declared
  // boundaries, not just stay inside them. Otherwise a stale cache could
  // silently evaluate less than declared while passing the hash check.
  if (allTradingDates.length === 0) {
    console.error(`\nFATAL: loaded zero trading dates. The dataset is empty.`);
    process.exit(1);
  }
  const firstDate = allTradingDates[0];
  const lastDate = allTradingDates[allTradingDates.length - 1];
  // Bounds: no data outside the declared range.
  if (firstDate < MANIFEST.manifest.dataStartDate) {
    console.error(`\nFATAL: loaded data starts at ${firstDate}, BEFORE manifest dataStartDate ${MANIFEST.manifest.dataStartDate}.`);
    console.error(`Vendor backfill or an earlier fetch has expanded the dataset. Update config/dataset-manifest.json (bump dataStartDate) and re-run.`);
    process.exit(1);
  }
  if (lastDate > MANIFEST.manifest.dataEndDate) {
    console.error(`\nFATAL: loaded data ends at ${lastDate}, AFTER manifest dataEndDate ${MANIFEST.manifest.dataEndDate}.`);
    console.error(`Rolling-forward data has extended past the declared range. Update config/dataset-manifest.json (bump dataEndDate) and re-run.`);
    process.exit(1);
  }
  // Coverage: data must reach at least to the end of the declared holdout
  // and must include at least one trading day on/before the declared
  // holdout start (pre-holdout history for the WFA training windows).
  // BOUNDARY_SLACK_DAYS of weekend/holiday tolerance (Codex 0.b.7 round-2)
  // because manifest dates may be calendar boundaries that fall on non-
  // trading days.
  const BOUNDARY_SLACK_MS = 10 * 86400 * 1000;
  const slackBefore = (dateStr: string) => new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - BOUNDARY_SLACK_MS).toISOString().slice(0, 10);
  if (lastDate < slackBefore(MANIFEST.manifest.holdoutEndDate)) {
    console.error(`\nFATAL: loaded data ends at ${lastDate}, more than 10 days before manifest holdoutEndDate ${MANIFEST.manifest.holdoutEndDate}.`);
    console.error(`The dataset does not reach the declared holdout end — a stale cache or truncated feed. Refresh the data (or bump the manifest) and re-run.`);
    process.exit(1);
  }
  if (firstDate > MANIFEST.manifest.holdoutStartDate) {
    console.error(`\nFATAL: loaded data starts at ${firstDate}, AFTER manifest holdoutStartDate ${MANIFEST.manifest.holdoutStartDate}.`);
    console.error(`The dataset has no pre-holdout history — WFA training windows cannot form. Refresh the data or adjust the manifest.`);
    process.exit(1);
  }

  // Phase 0.b.6 holdout-range check: when holdout is live, every generated
  // holdout window must fall within the manifest's declared holdout range.
  // Catches the case where `allTradingDates` drifted (new candles, rolled-
  // forward data) and the WFA-sliced window no longer matches the manifest.
  if (holdoutWindows.length > 0) {
    for (const w of holdoutWindows) {
      if (!windowFallsInHoldout(w.oosStart, w.oosEnd, MANIFEST.manifest)) {
        console.error(`\nFATAL: computed holdout window [${w.oosStart}..${w.oosEnd}] falls outside manifest range [${MANIFEST.manifest.holdoutStartDate}..${MANIFEST.manifest.holdoutEndDate}].`);
        console.error(`This usually means the underlying candle data has shifted since the manifest was written. Update and commit config/dataset-manifest.json, then update the Pre-Registration block's Holdout Window Hash, then re-run.`);
        process.exit(1);
      }
    }
  }

  if (selectionWindows.length === 0) {
    printErrorResult(strategy.name, 'No WFA windows generated. Check date range and window params.', startMs);
    process.exit(0);
  }

  // 7. Build SimConfig + variants
  // Build both CALL and PUT configs. If they differ, pass putSimConfig to workers
  // so PUT-direction signals are evaluated with their own config (hybrid strategies).
  const baseSimConfig = strategy.buildConfig(strategy.tickers[0], 'CALL');
  const basePutSimConfig = strategy.buildConfig(strategy.tickers[0], 'PUT');
  const hasSeparatePutConfig = JSON.stringify(baseSimConfig) !== JSON.stringify(basePutSimConfig);
  const variants: Array<{ name: string; simConfig: SimConfig; putSimConfig?: SimConfig }> = [
    { name: strategy.name, simConfig: baseSimConfig, putSimConfig: hasSeparatePutConfig ? basePutSimConfig : undefined },
  ];
  const seenVariantNames = new Set<string>([strategy.name]);
  if (strategy.configVariants) {
    for (const v of strategy.configVariants) {
      if (seenVariantNames.has(v.name)) {
        console.warn(`⚠️  Skipping duplicate configVariant "${v.name}" — base strategy is always evaluated as variant 1; do not re-declare the incumbent as an empty-override variant.`);
        continue;
      }
      seenVariantNames.add(v.name);
      const callCfg = mergeConfigOverrides(baseSimConfig, v.overrides);
      const putCfg  = hasSeparatePutConfig ? mergeConfigOverrides(basePutSimConfig, v.overrides) : undefined;
      variants.push({ name: v.name, simConfig: callCfg, putSimConfig: putCfg });
    }
  }

  // Screen mode: truncate windows for fast triage
  if (SCREEN_MODE) {
    const maxSel = Math.min(SCREEN_SELECTION_WINDOWS, selectionWindows.length);
    selectionWindows.splice(0, selectionWindows.length - maxSel);
    holdoutWindows.splice(0, holdoutWindows.length - 1);
    console.log(`SCREEN MODE: ${selectionWindows.length} selection + ${holdoutWindows.length} holdout windows (fast triage)\n`);
  }

  if (variants.length > 1) {
    console.log(`Evaluating ${variants.length} variants: ${variants.map(v => v.name).join(', ')}\n`);
  }

  // 8. Bundle worker
  const workerSrc = path.resolve(__dirname, 'worker.ts');
  const workerBundle = path.resolve(__dirname, '.autoresearch-worker.mjs');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '../..'), stdio: 'pipe' },
  );

  const workerInitData = {
    signals: allSignals,
    allTradingDates,
    executionConfig: strategy.portfolio,
    startingCapital: strategy.portfolio.startingCapital,
    evaluatorMode: 'standard' as const,
  };

  // Spawn strategy worker (reused across all variants)
  console.log('Spawning workers...');
  const stratWorker = await spawnOneWorker(workerBundle, workerInitData);

  // Spawn baseline worker (skip in screen mode)
  let blWorker: Worker | null = null;
  const putCount = allSignals.filter(s => s.direction === 'PUT').length;
  const naiveDirection: 'CALL' | 'PUT' = putCount > allSignals.length / 2 ? 'PUT' : 'CALL';
  const naiveSignals = generateNaiveSignals(tickerDataMap, gates().gates.naiveBaselineIntervalDays, naiveDirection);
  if (!SCREEN_MODE) {
    try {
      blWorker = await spawnOneWorker(workerBundle, {
        ...workerInitData,
        signals: naiveSignals,
      });
      console.log(`Workers ready. Naive baseline: ${naiveSignals.length} ${naiveDirection} signals\n`);
    } catch (err: any) {
      console.log(`Baseline worker failed: ${err.message}. Delta gates will be skipped.\n`);
    }
  } else {
    console.log('Workers ready. Baseline skipped in screen mode.\n');
  }

  // ── Evaluate all variants ────────────────────────────────

  const selectionStart = selectionWindows[0]?.oosStart ?? wfaStartDate;
  const selectionEnd = selectionWindows[selectionWindows.length - 1]?.oosEnd ?? DATA_END;
  const holdoutStart = holdoutWindows[0]?.oosStart ?? wfaStartDate;
  const holdoutEnd = holdoutWindows[holdoutWindows.length - 1]?.oosEnd ?? DATA_END;
  const leaderboard = loadLeaderboard();
  const allVariantResults: RunResult[] = [];

  for (let vi = 0; vi < variants.length; vi++) {
    const variant = variants[vi];
    const simConfig = variant.simConfig;
    if (variants.length > 1) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`  Variant ${vi + 1}/${variants.length}: ${variant.name}`);
      console.log(`${'─'.repeat(50)}`);
    }

    // 9. Evaluate strategy variant
    const workerResult = await evalOnWorker(stratWorker, vi, simConfig, selectionWindows, holdoutWindows, variant.putSimConfig);

    if (workerResult.error) {
      console.log(`  Worker error: ${workerResult.error}`);
      continue;
    }

    // 9b. Evaluate baseline (same SimConfig, naive signals — direction matches strategy)
    let baselineWorkerResult: WorkResult | null = null;
    if (blWorker) {
      try {
        baselineWorkerResult = await evalOnWorker(
          blWorker, vi, simConfig, selectionWindows, holdoutWindows, variant.putSimConfig,
        );
        if (baselineWorkerResult.error) {
          console.log(`  Baseline error: ${baselineWorkerResult.error}`);
          baselineWorkerResult = null;
        }
      } catch (err: any) {
        console.log(`  Baseline eval failed: ${err.message}`);
      }
    }

    // 10. Compute metrics
    const oosMetrics = computePortfolioDailyMetrics(
      workerResult.allOOSTrades, allTradingDates, selectionStart, selectionEnd, strategy.portfolio.startingCapital,
    );
    const oosAnalytics = computeOptionAnalytics(workerResult.allOOSTrades);
    // Holdout metrics include BOTH selection-entered trades that survive into
    // the holdout window AND holdout-entered trades. computePortfolioDailyMetrics
    // filters by date range, so only in-holdout dailyMtM entries contribute —
    // selection dates are naturally excluded.
    //
    // Seed holdout equity/peak from the selection-ending portfolio value so
    // returns are measured against the capital the strategy actually brought
    // into the unseen window. Without this seed, returns would be divided by
    // startingCapital instead of the carried equity, distorting Sharpe/MaxDD
    // whenever selection P&L was non-zero.
    const holdoutTradesUnion = [...workerResult.allOOSTrades, ...workerResult.holdoutTrades];
    const selectionEndEquity = oosMetrics.equityCurve.length > 0
      ? oosMetrics.equityCurve[oosMetrics.equityCurve.length - 1].equity
      : strategy.portfolio.startingCapital;
    // Peak is the max equity reached during selection — not necessarily the
    // selection-end equity if selection ended in a drawdown. Carrying the
    // true peak into holdout ensures continuing drawdowns are measured
    // against the real high-water mark, not a depressed boundary.
    const selectionPeak = oosMetrics.equityCurve.length > 0
      ? oosMetrics.equityCurve.reduce((m, e) => e.equity > m ? e.equity : m, strategy.portfolio.startingCapital)
      : strategy.portfolio.startingCapital;
    const holdoutMetrics = computePortfolioDailyMetrics(
      holdoutTradesUnion, allTradingDates, holdoutStart, holdoutEnd,
      strategy.portfolio.startingCapital, selectionEndEquity, selectionPeak,
    );

    const avgTrainSharpe = workerResult.selectionResults.length > 0
      ? workerResult.selectionResults.reduce((s, w) => s + w.trainSharpe, 0) / workerResult.selectionResults.length
      : 0;
    const wfEfficiency = avgTrainSharpe >= 0.1 ? oosMetrics.sharpe / avgTrainSharpe : 0;

    // 11. Combined Sharpe with DTE5
    const strategyDates = oosMetrics.equityCurve.map(e => e.date);
    const { combinedSharpe, correlation, combinedMaxDD } = computeCombinedMetrics(
      oosMetrics.dailyReturns, strategyDates, baseline,
    );

    const monitoringDays = simConfig.monitoringIntervalDays ?? 1;
    if (monitoringDays > 1) {
      console.log(`[ARTIFACT] monitoringIntervalDays=${monitoringDays}: dailyMtM is only ${Math.round(100 / monitoringDays)}% filled.`);
    }

    // 11b. SPY Information Ratio
    const holdoutDates = holdoutMetrics.equityCurve.map(e => e.date);
    const oosSpyIRResult = computeInformationRatio(oosMetrics.dailyReturns, strategyDates, spyBenchmark);
    const holdoutSpyIRResult = computeInformationRatio(holdoutMetrics.dailyReturns, holdoutDates, spyBenchmark);

    // 11c. Baseline comparison
    let baselineOosSharpe: number | undefined;
    let baselineMaxDD: number | undefined;
    let baselineCorrelation: number | undefined;
    let baselineSpyIR: number | undefined;
    let baselineTrades: number | undefined;

    if (baselineWorkerResult && baselineWorkerResult.allOOSTrades.length >= 20) {
      const blMetrics = computePortfolioDailyMetrics(
        baselineWorkerResult.allOOSTrades, allTradingDates, selectionStart, selectionEnd, strategy.portfolio.startingCapital,
      );
      const blDates = blMetrics.equityCurve.map(e => e.date);
      const blCombined = computeCombinedMetrics(blMetrics.dailyReturns, blDates, baseline);
      const blSpyIR = computeInformationRatio(blMetrics.dailyReturns, blDates, spyBenchmark);
      baselineOosSharpe = blMetrics.sharpe;
      baselineMaxDD = blMetrics.maxDrawdownPct;
      baselineCorrelation = blCombined.correlation;
      baselineSpyIR = blSpyIR.ir;
      baselineTrades = baselineWorkerResult.allOOSTrades.length;
    }

    // Delta metrics
    const deltaSpyIR = (baselineSpyIR != null) ? oosSpyIRResult.ir - baselineSpyIR : undefined;
    const deltaMaxDD = (baselineMaxDD != null) ? oosMetrics.maxDrawdownPct - baselineMaxDD : undefined;
    const deltaCorrelation = (baselineCorrelation != null) ? correlation - baselineCorrelation : undefined;
    // SCREEN_MODE intentionally skips the baseline worker for fast triage, so a
    // missing delta metric there is expected — let the gate pass. In normal mode
    // a missing metric means the baseline legitimately failed; fail closed so
    // sparse-chain or worker errors don't silently promote strategies.
    const missingBaselineDefault = SCREEN_MODE;
    const passesDeltaSpyIR = deltaSpyIR != null ? deltaSpyIR > 0 : missingBaselineDefault;
    const passesDeltaMaxDD = deltaMaxDD != null ? deltaMaxDD <= 0 : missingBaselineDefault;
    const passesDeltaCorr = deltaCorrelation != null ? deltaCorrelation <= 0 : missingBaselineDefault;
    const passesDeltaGates = passesDeltaSpyIR && passesDeltaMaxDD && passesDeltaCorr;

    // 12. Overfitting defenses
    const bootstrapCI = bootstrapSharpeCI(oosMetrics.dailyReturns);
    const bootstrapSignificant = bootstrapCI[0] > 0;
    // Verify the gate config is still unchanged BEFORE incrementing the
    // global attempt counter. Codex round-7 Finding 2 (2026-04-18): if gates
    // are edited mid-run, the counter was advancing even though the runner
    // would abort at save time with no leaderboard row, drifting the
    // multiple-testing ledger and deflated-Sharpe denominator.
    assertGatesUnchanged(gates());
    assertManifestUnchanged(MANIFEST);
    // attemptNumber uses the GLOBAL ledger (all campaigns combined), not the
    // per-suffix leaderboard. Previously per-campaign counts reset when
    // AUTORESEARCH_LEADERBOARD_SUFFIX changed, which under-penalized deflated
    // Sharpe for serial searches across campaigns.
    //
    // Phase 0.a.3 (2026-04-18): we now record the OOS return vector alongside
    // the attempt counter. `scripts/compute-effective-trials.ts` reads these
    // to compute N_eff via participation ratio — the correct denominator for
    // Deflated Sharpe when many trials are correlated (e.g. adjacent grid
    // points). See scripts/autoresearch/lib/trial-ledger.ts for math.
    const localAttempt = leaderboard.length + 1;
    const trialSource = `${leaderboardSuffix() || 'primary'}:${variant.name}`;
    const appended = appendTrial({
      source: trialSource,
      strategyName: variant.name,
      leaderboardSuffix: leaderboardSuffix() || '',
      oosSharpe: oosMetrics.sharpe,
      oosTrades: workerResult.allOOSTrades.length,
      oosDates: oosMetrics.equityCurve.map(e => e.date),
      oosDailyReturns: oosMetrics.dailyReturns,
      adoptionGatesEffectiveHash: gates().effectiveHash,
      preRegBlockHash: preRegAudit.preRegBlockHash,
    });
    const globalAttempt = appended.ordinal;
    const attemptNumber = globalAttempt;
    // Phase 2.a: N_eff diagnostic on the OOS daily-return series.
    // Bandwidth 20 days ≈ one month, enough to capture typical credit-
    // spread trade-life autocorrelation.
    const nOosDaily = oosMetrics.dailyReturns.length;
    const nEffOosDaily = computeEffectiveSampleSize(oosMetrics.dailyReturns, 20);
    // Phase 2.c: closed-form Mertens SE on the annualized Sharpe, using
    // N_eff as the effective sample size and the OOS returns' own
    // skewness + kurtosis. Deterministic alternative to the bootstrap-
    // CI-derived SE (which is itself noisy and under-covers above
    // phi ≈ 0.5 per the 2.b Monte Carlo validation).
    const mertens = computeMertensSharpeSE(oosMetrics.dailyReturns, nEffOosDaily, 252);
    const mertensSharpeSE = mertens.annualizedSe;
    const mertensSkewness = mertens.skewness;
    const mertensKurtosis = mertens.kurtosis;
    // Phase 2.i (2026-04-20): REVERTED Phase 2.g's swap — `deflatedSharpe`
    // is bootstrap-SE-driven again, matching historical leaderboard
    // semantics. `deflatedSharpeMertens` returns as a diagnostic companion.
    //
    // Why reverted: downstream analyses (`scripts/autoresearch/analyze-*.ts`)
    // compare `deflatedSharpe > 0` and sort by its value across rows that
    // span the 2.g boundary. Quietly changing the field's underlying
    // formula makes a single leaderboard-full-*.json internally
    // inconsistent — new rows reporting Mertens DSR mixed with old rows
    // reporting bootstrap DSR. Codex round-22 Finding 1 (2026-04-20).
    //
    // Operators who want a Mertens-authoritative view of the fleet should
    // prefer `deflatedSharpeMertens` in new analysis code. The Phase 2.h
    // `passesStatConsistency` flag still surfaces disagreement between
    // the two estimators for human review.
    const bootstrapSharpeSE = bootstrapCI[1] > bootstrapCI[0] ? (bootstrapCI[1] - bootstrapCI[0]) / (2 * 1.96) : 1;
    const deflatedSharpe = computeDeflatedSharpe(oosMetrics.sharpe, attemptNumber, bootstrapSharpeSE);
    const deflatedSharpeMertens: number | undefined = mertensSharpeSE > 0
      ? computeDeflatedSharpe(oosMetrics.sharpe, attemptNumber, mertensSharpeSE)
      : undefined;
    // Phase 2.h: stat-consistency flag between the two SE estimators.
    // Ratio of the larger to the smaller, symmetric. Not a hard gate —
    // reviewer-only signal. Triggered when the bootstrap SE and the
    // parametric Mertens SE disagree by more than `maxStatConsistencyRatio`,
    // which flags either a bootstrap coverage failure (autocorrelation
    // beyond fixed-block's reach) or a Mertens mis-specification
    // (extreme higher moments). Skipped when Mertens SE is unavailable.
    const statConsistencyRatio = mertensSharpeSE > 0 && bootstrapSharpeSE > 0
      ? Math.max(mertensSharpeSE / bootstrapSharpeSE, bootstrapSharpeSE / mertensSharpeSE)
      : undefined;
    const passesStatConsistency = statConsistencyRatio == null
      ? undefined
      : statConsistencyRatio <= gates().gates.maxStatConsistencyRatio;
    const holdoutOOSRatio = oosMetrics.sharpe > 0.01 ? holdoutMetrics.sharpe / oosMetrics.sharpe : 0;

    // 13. Validity checks
    //
    // CRITICAL: We split validity into two tiers to prevent holdout leakage
    // through the agent-visible boolean. Search-time validity uses ONLY
    // selection-window + sanity + delta-gate criteria. Overall validity
    // additionally requires the holdout gate, but that field is stripped
    // from the agent-visible leaderboard so iterative search cannot learn
    // holdout pass/fail.
    //
    // Adversarial review finding (Codex, 2026-04-17) — prior `isValid`
    // embedded `passesHoldoutOrIR`, leaking holdout outcome to the search loop.
    const g = gates().gates;
    const passesMinTrades = workerResult.allOOSTrades.length >= g.minOosTrades;
    const passesMaxDD = oosMetrics.maxDrawdownPct <= g.maxOosDrawdownPct;
    const passesWFA = oosMetrics.sharpe > 0;
    const passesHoldout = holdoutMetrics.sharpe >= g.minHoldoutSharpe;
    const passesHoldoutAbsolute = holdoutMetrics.sharpe >= g.minHoldoutMetric;
    const passesHoldoutIR = holdoutSpyIRResult.ir >= g.minHoldoutMetric;
    // Legacy disjunctive gate — too permissive: accepts a winner with deeply
    // negative IR as long as raw Sharpe is above 0.3. Kept as diagnostic field
    // only; no longer wired into `isValid`. See gotcha #41.
    const passesHoldoutOrIR = passesHoldoutAbsolute || passesHoldoutIR;
    // Tighter gate (Codex Finding #3, 2026-04-18): require non-negative holdout
    // SPY IR in addition to positive absolute holdout Sharpe. Blocks adopting a
    // strategy that materially loses to SPY on the unseen regime.
    const passesHoldoutIRFloor = holdoutSpyIRResult.ir >= g.minHoldoutIrFloor;
    const passesHoldoutAndIR = passesHoldoutAbsolute && passesHoldoutIRFloor;
    // Phase 1.c/d: three-pronged sanity on OOS metrics. All three are
    // designed to catch the "result is too clean to be real" simulator-bug
    // fingerprint documented in docs/backtest-trust-gotchas.md §1-2.
    //   Upper Sharpe: impossibly-good aggregate (double-count premium,
    //     phantom expiration profits).
    //   Lower MaxDD: losses silently swallowed (TRAILING_LOCK class) —
    //     8yr MaxDD < 2% is almost always a bug.
    //   Per-trade edge: mean(grossPnl/maxProfit) across credit-spread
    //     trades near 1.0 means the simulator books near-max-profit on
    //     every trade, which is physically impossible across a mix of
    //     winners and losers. Real strategies have a handful of SL-hit
    //     losers that pull the mean well below 0.9 even at delta 0.20.
    //     Only computed for strategies with ≥ 20 credit-spread trades in
    //     OOS — below that the sample is too noisy to gate on mean.
    const passesSanitySharpe = oosMetrics.sharpe <= g.maxSaneOosSharpe;
    const passesSanityMaxDD = oosMetrics.maxDrawdownPct >= g.minSaneOosDrawdownPct;
    // Per-trade edge: only CREDIT_SPREAD mode has a bounded maxProfit.
    // LEAP/BUY_WRITE trades carry no such ceiling and trivially pass.
    //
    // Codex round-12 Finding 1 (2026-04-20): numerator and denominator must
    // be on the same fill basis. `maxProfit` is stored as the net entry
    // credit, but `grossPnl` is clamped against the GROSS entry credit
    // (= net + entrySlippage). Under default bid/ask slippage, any trade
    // closing at max profit yields `grossPnl / (maxProfit * 100) > 1.0`,
    // which would falsely trip `passesSanityEdge` for legitimate runs.
    // Reconstruct the gross max profit from stored trade fields so the
    // ratio stays bounded at 1.0 regardless of slippage magnitude.
    const csOosTrades = workerResult.allOOSTrades.filter(
      t => t.mode === 'CREDIT_SPREAD' && (t.maxProfit ?? 0) > 0,
    );
    const oosPerTradeEdges = csOosTrades.map(t => {
      if (t.grossPnl != null) {
        // Gross basis: grossPnl is clamped at grossEntryCredit*100 where
        // grossEntryCredit = clampSpreadCloseCost(netEntryCredit + entrySlippage, actualWidth)
        // — i.e. capped at the spread width in buildCreditSpreadTrade.
        // Codex round-13 Finding 1 (2026-04-20): match the same clamp
        // here, else high-credit trades on narrow spreads score below 1.0
        // at true gross max profit and under-count the near-max-profit
        // pattern the gate is meant to catch.
        const unclampedGross = (t.maxProfit ?? 0) + (t.entrySlippage ?? 0);
        const grossMaxProfit = t.spreadWidth != null
          ? Math.min(unclampedGross, t.spreadWidth)
          : unclampedGross;
        return grossMaxProfit > 0 ? t.grossPnl / (grossMaxProfit * 100) : 0;
      }
      // Net basis fallback for trades missing grossPnl (legacy/cached rows).
      return t.pnl / ((t.maxProfit ?? 1) * 100);
    });
    const meanPerTradeEdge = oosPerTradeEdges.length > 0
      ? oosPerTradeEdges.reduce((s, e) => s + e, 0) / oosPerTradeEdges.length
      : 0;
    const passesSanityEdge = csOosTrades.length < 20 || meanPerTradeEdge < g.maxSanePerTradeEdge;
    const passesSanity = passesSanitySharpe && passesSanityMaxDD && passesSanityEdge;
    // Separate carry (selection-entered, live during holdout) from new (entered
    // inside holdout). A strategy that stops generating signals after the
    // boundary can otherwise pass the Sharpe/IR gate on a single carried LEAP
    // without ever demonstrating it works on the unseen regime.
    const newHoldoutTrades = workerResult.holdoutTrades.length;
    // Carry = selection-entered trade whose life overlaps the holdout window.
    // Use date-range overlap (entryDate < holdoutStart && exitDate >= holdoutStart)
    // rather than dailyMtM presence: sparse monitoring, missing-chain gaps, or
    // early exits can move holdout P&L through the residual path even when no
    // in-holdout MtM entry exists. allOOSTrades already filters entryDate <
    // holdoutStart, so the overlap check reduces to exitDate >= holdoutStart.
    const carriedHoldoutTrades = workerResult.allOOSTrades.filter(t =>
      t.exitDate >= holdoutStart,
    ).length;
    const passesHoldoutNewEntries = newHoldoutTrades >= g.minNewHoldoutTrades;
    // Phase 1.b: holdout/OOS stability gate. The ratio reveals whether
    // holdout performance is consistent with OOS (ratio ~1) or diverges
    // wildly. Ratio below min → overfit to selection window. Ratio above
    // max → holdout "too good," usually data snooping or pre-reg-rule
    // bending. Previously documented as "manual check" in
    // backtest-trust-gotchas.md; now a hard gate in `isValid`. Bounds live
    // in the hashed adoption-gates config so changes trip
    // adoptionGatesRawHash (Codex round-12 Finding 2, 2026-04-20). Held OUT
    // of `isValidForSearch` to keep agents holdout-blind; stripped from
    // agent-visible leaderboard below.
    const passesStability =
      holdoutOOSRatio >= g.minStabilityHoldoutOosRatio &&
      holdoutOOSRatio <= g.maxStabilityHoldoutOosRatio;
    // Search-time validity: holdout-blind. Agents see this.
    const isValidForSearch = passesMinTrades && passesMaxDD && passesWFA && passesSanity && passesDeltaGates;
    // Overall validity: includes holdout gate + new-entries guard + stability.
    // Full leaderboard only — stripped from agent-visible file.
    // Gate uses `passesHoldoutAndIR` (Sharpe ≥ 0.3 AND IR ≥ 0), NOT the legacy
    // disjunctive `passesHoldoutOrIR`. See runner.ts comment on `passesHoldoutAndIR` and gotcha #41.
    const isValid = isValidForSearch && passesHoldoutAndIR && passesHoldoutNewEntries && passesStability;

    const exitTypeBreakdown: Record<string, number> = {};
    for (const t of workerResult.allOOSTrades) {
      exitTypeBreakdown[t.exitType] = (exitTypeBreakdown[t.exitType] ?? 0) + 1;
    }

    const elapsedMs = Date.now() - startMs;

    const runResult: RunResult = {
      strategyName: variant.name,
      timestamp: new Date().toISOString(),
      oosSharpe: oosMetrics.sharpe,
      oosMaxDD: oosMetrics.maxDrawdownPct,
      oosWinRate: oosAnalytics.winRate,
      oosTrades: workerResult.allOOSTrades.length,
      oosTotalPnl: workerResult.allOOSTrades.reduce((s, t) => s + t.pnl, 0),
      combinedSharpe,
      correlationWithDTE5: correlation,
      combinedMaxDD,
      holdoutSharpe: holdoutMetrics.sharpe,
      holdoutTrades: workerResult.holdoutTrades.length,
      newHoldoutTrades,
      carriedHoldoutTrades,
      passesHoldoutNewEntries,
      oosSpyIR: oosSpyIRResult.ir,
      oosSpyExcessReturn: oosSpyIRResult.excessReturn,
      holdoutSpyIR: holdoutSpyIRResult.ir,
      holdoutSpyExcessReturn: holdoutSpyIRResult.excessReturn,
      avgTrainSharpe,
      wfEfficiency,
      passesMinTrades, passesMaxDD, passesWFA, passesHoldout, passesHoldoutOrIR, passesHoldoutIRFloor, passesHoldoutAndIR, passesSanity, passesStability, isValid, isValidForSearch,
      meanPerTradeEdge: oosPerTradeEdges.length > 0 ? meanPerTradeEdge : undefined,
      holdoutOOSRatio,
      bootstrapSharpe95CI: bootstrapCI,
      bootstrapSignificant,
      attemptNumber,
      deflatedSharpe,
      nEffOosDaily,
      nOosDaily,
      mertensSharpeSE,
      mertensSkewness,
      mertensKurtosis,
      deflatedSharpeMertens,
      statConsistencyRatio,
      passesStatConsistency,
      exitTypeBreakdown,
      signalsGenerated: allSignals.length,
      signalsSkippedNoChain: allSignals.length - workerResult.allOOSTrades.length - workerResult.holdoutTrades.length,
      baselineOosSharpe, baselineMaxDD, baselineCorrelation, baselineSpyIR, baselineTrades,
      deltaSpyIR, deltaMaxDD, deltaCorrelation, passesDeltaSpyIR, passesDeltaMaxDD, passesDeltaCorr, passesDeltaGates,
      preRegBypassed: preRegAudit.preRegBypassed,
      preRegBypassReason: preRegAudit.preRegBypassReason,
      preRegBlockHash: preRegAudit.preRegBlockHash,
      preRegGitSha: preRegAudit.preRegGitSha,
      preRegHoldoutWindowHash: preRegAudit.preRegHoldoutWindowHash,
      adoptionGatesRawHash: gates().rawHash,
      adoptionGatesEffectiveHash: gates().effectiveHash,
      adoptionGatesOverrides: gates().envOverrides.map(o => ({ envVar: o.envVar, target: o.target, value: o.parsed })),
      // Phase 0.a.5 provenance: binds this row to strategy + repo state and
      // records whether holdout was actually evaluated. Seal reads all three.
      strategyGitSha,
      strategyBlobSha,
      repoGitSha,
      holdoutEvaluated: holdoutWindows.length > 0,
      // Phase 0.b.6 dataset-manifest provenance. Seal ceremony refuses rows
      // whose datasetManifestHash doesn't match the current committed
      // manifest — prevents sealing a row produced under an old manifest
      // under a newer one.
      datasetManifestHash: MANIFEST.rawHash,
      datasetManifestVersion: MANIFEST.manifest.manifestVersion,
      // Phase 0.b.7 per-series coverage hash. Seal refuses if a row's hash
      // doesn't match current ticker-cache state.
      tickerCoverageHash,
      elapsedMs,
    };

    // Update leaderboard (skip in screen mode).
    // Re-hash adoption gates config AND dataset manifest before persisting —
    // refuse to write if either file changed mid-campaign (Phase 0.a.2 / 0.b.6
    // immutability checks).
    if (!SCREEN_MODE) {
      assertGatesUnchanged(gates());
      assertManifestUnchanged(MANIFEST);
      leaderboard.push(runResult);
      saveLeaderboard(leaderboard);

      // Phase 0.a.5: append each non-bypassed RunResult as one line in
      // docs/audit-rows/<blockHash>.jsonl. The seal ceremony reads FROM
      // this tracked file after the operator commits it — appending (not
      // overwriting) so earlier rows are preserved in git history, closing
      // the "silent overwrite" hole Codex flagged in round 2 (Finding 2).
      if (!preRegAudit.preRegBypassed && preRegAudit.preRegBlockHash) {
        const rowsDir = path.resolve(__dirname, '../../docs/audit-rows');
        fs.mkdirSync(rowsDir, { recursive: true });
        const rowPath = path.join(rowsDir, `${preRegAudit.preRegBlockHash}.jsonl`);
        fs.appendFileSync(rowPath, JSON.stringify(runResult) + '\n');
      }
    }
    allVariantResults.push(runResult);

    // Optional: dump trades to JSON for post-replay analysis (used by Campaign C).
    // Only dumps the single-variant case to avoid cross-variant confusion.
    if (process.env.SAVE_TRADES === '1' && variants.length === 1) {
      const dumpPath = path.resolve(__dirname, `campaign-trades-${variant.name}.json`);
      const simplifyTrade = (t: any) => ({
        ticker: t.ticker,
        entryDate: t.entryDate,
        exitDate: t.exitDate,
        exitType: t.exitType,
        pnl: t.pnl,
        pnlPct: t.pnlPct,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        dailyMtM: t.dailyMtM || [],
      });
      fs.writeFileSync(dumpPath, JSON.stringify({
        strategyName: variant.name,
        selectionStart, selectionEnd, holdoutStart, holdoutEnd,
        baselineDates: baseline.dates,
        baselineReturns: baseline.dailyReturns,
        spyDates: spyBenchmark.dates,
        spyReturns: spyBenchmark.dailyReturns,
        allTradingDates,
        startingCapital: strategy.portfolio.startingCapital,
        oosTrades: workerResult.allOOSTrades.map(simplifyTrade),
        holdoutTrades: workerResult.holdoutTrades.map(simplifyTrade),
      }, null, 2));
      console.log(`[SAVE_TRADES] Dumped ${workerResult.allOOSTrades.length} OOS + ${workerResult.holdoutTrades.length} holdout trades to ${dumpPath}`);
    }

    // Print per-variant result (compact for multi-variant, full for single)
    if (variants.length === 1) {
      const validEntries = leaderboard.filter(e => e.isValid);
      const currentBest = validEntries.length > 0
        ? validEntries.reduce((best, e) => e.combinedSharpe > best.combinedSharpe ? e : best)
        : null;
      const isNewChampion = isValid && (!currentBest || combinedSharpe >= currentBest.combinedSharpe);
      if (isNewChampion) {
        fs.copyFileSync(strategySrc, path.resolve(__dirname, bestStrategyFilename));
      }
      printResult(runResult, currentBest, isNewChampion);
    }
  }

  // ── Terminate workers ────────────────────────────────────

  await terminateWorker(stratWorker);
  if (blWorker) await terminateWorker(blWorker);

  // ── Multi-variant summary ────────────────────────────────

  if (variants.length > 1) {
    console.log('\n' + '='.repeat(70));
    console.log(SCREEN_MODE ? '=== SCREEN RESULTS (rough estimates, fewer WFA windows) ===' : '=== SWEEP RESULTS ===');
    console.log('='.repeat(70));
    console.log('');
    console.log(`${'Name'.padEnd(35)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(6)} ${'Corr'.padStart(6)} ${'Trades'.padStart(7)} ${'SPY IR'.padStart(7)} ${'SrchVld'.padStart(7)}`);
    console.log('─'.repeat(70));

    const sorted = [...allVariantResults].sort((a, b) => b.combinedSharpe - a.combinedSharpe);
    for (const r of sorted) {
      const valid = r.isValidForSearch ? '    YES' : '     NO';
      console.log(
        `${r.strategyName.padEnd(35)} ${r.combinedSharpe.toFixed(3).padStart(7)} ${(r.oosMaxDD.toFixed(1) + '%').padStart(6)} ${r.correlationWithDTE5.toFixed(3).padStart(6)} ${String(r.oosTrades).padStart(7)} ${r.oosSpyIR.toFixed(3).padStart(7)} ${valid}`,
      );
    }
    console.log('─'.repeat(70));

    if (!SCREEN_MODE) {
      // Agent-visible "best by selection" uses search validity only (no holdout).
      // True champion determination (including holdout) is reviewer-only below.
      const searchBest = allVariantResults
        .filter((e) => e.isValidForSearch)
        .sort((a, b) => b.combinedSharpe - a.combinedSharpe)[0];
      if (searchBest) {
        console.log(`\nBest by search validity: ${searchBest.strategyName} (combined ${searchBest.combinedSharpe.toFixed(3)})`);
      }
      // Reviewer-only: real champion including holdout.
      const validEntries = leaderboard.filter((e) => e.isValid);
      const trueBest = validEntries.length > 0
        ? validEntries.reduce((best, e) => e.combinedSharpe > best.combinedSharpe ? e : best)
        : null;
      console.log('__BEGIN_REVIEWER_ONLY__');
      if (trueBest) {
        console.log(`True champion (search + holdout): ${trueBest.strategyName} (combined ${trueBest.combinedSharpe.toFixed(3)})`);
      } else {
        console.log(`True champion (search + holdout): none — no variant passes both search validity and holdout gate`);
      }
      console.log('__END_REVIEWER_ONLY__');
    } else {
      // Save screen results to separate file (agent-safe — no holdout-derived fields)
      const screenPath = path.resolve(__dirname, 'screen-results.json');
      fs.writeFileSync(screenPath, JSON.stringify(sorted.map(r => ({
        name: r.strategyName,
        combinedSharpe: r.combinedSharpe,
        oosSharpe: r.oosSharpe,
        oosMaxDD: r.oosMaxDD,
        correlation: r.correlationWithDTE5,
        oosTrades: r.oosTrades,
        oosSpyIR: r.oosSpyIR,
        isValidForSearch: r.isValidForSearch,
      })), null, 2));
      console.log(`\nScreen results saved to ${screenPath}`);
      console.log('Run without --screen on top candidates for full evaluation.');
    }
    console.log('='.repeat(70));
  }

  // Cleanup temp bundle
  try { fs.unlinkSync(strategyBundle); } catch {}
  } finally {
    // Happy-path teardown — Codex round-6 Finding 2. Release the lock and
    // remove every process-level handler main() installed, so sequential
    // same-pid invocations don't accumulate listeners.
    runnerLock.release();
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
    process.off('exit', onExit);
  }
}

// ── Output Formatting ───────────────────────────────────

function printResult(r: RunResult, currentBest: RunResult | null, isNewChampion: boolean) {
  const bestSharpe = currentBest?.combinedSharpe ?? 0;
  const g2 = gates().gates;
  // Stability label tracks the configurable bounds. Codex round-13 Finding 2
  // (2026-04-20): previously hardcoded 0.5/0.1 — would drift out of sync
  // with the gate if an operator changed the hashed config.
  const holdoutStability = (
    r.holdoutOOSRatio >= g2.minStabilityHoldoutOosRatio &&
    r.holdoutOOSRatio <= g2.maxStabilityHoldoutOosRatio
      ? 'STABLE'
      : r.holdoutOOSRatio > g2.maxStabilityHoldoutOosRatio
        ? 'HIGH'
        : 'WEAK'
  );
  // Status line is SEARCH-VALIDITY ONLY (no holdout feedback). Holdout outcomes
  // appear only in the reviewer-only block below, which the agent-facing shells
  // strip before including the output in the next iteration's prompt.
  const invalidReasons = [
    !r.passesMinTrades && `${r.oosTrades} trades < ${g2.minOosTrades} min`,
    !r.passesMaxDD && `MaxDD ${r.oosMaxDD.toFixed(1)}% > ${g2.maxOosDrawdownPct}% limit`,
    !r.passesWFA && `OOS Sharpe ${r.oosSharpe.toFixed(3)} <= 0`,
    !r.passesSanity && (
      r.oosSharpe > g2.maxSaneOosSharpe
        ? `OOS Sharpe ${r.oosSharpe.toFixed(3)} > ${g2.maxSaneOosSharpe} (sanity bound — simulator bug likely)`
      : r.oosMaxDD < g2.minSaneOosDrawdownPct
        ? `OOS MaxDD ${r.oosMaxDD.toFixed(2)}% < ${g2.minSaneOosDrawdownPct}% (sanity bound — losses may be silently swallowed, TRAILING_LOCK fingerprint)`
        : `Mean per-trade edge ${(r.meanPerTradeEdge ?? 0).toFixed(3)} ≥ ${g2.maxSanePerTradeEdge} (sanity bound — near-max-profit on every trade is a TRAILING_LOCK fingerprint)`
    ),
    !r.passesDeltaGates && 'delta gates: signal timing does not beat naive baseline',
  ].filter(Boolean);
  const status = r.isValidForSearch ? 'VALID_FOR_SEARCH' : `INVALID_FOR_SEARCH (${invalidReasons.join(', ')})`;

  // Overfitting risk (agent-safe — no holdout signal)
  let overfitWarning = '';
  if (r.deflatedSharpe < 0) overfitWarning += ' [WARNING: deflated Sharpe < 0 after multiple testing adjustment]';

  console.log('\n' + '='.repeat(60));
  console.log('=== RUN RESULT ===');
  console.log(`Strategy: ${r.strategyName}`);
  console.log(`Status: ${status}`);
  console.log(`Attempt: #${r.attemptNumber}`);
  console.log('');
  console.log('--- Performance ---');
  console.log(`Combined Sharpe: ${r.combinedSharpe.toFixed(3)} (current best: ${bestSharpe.toFixed(3)})`);
  console.log(`Correlation with DTE5: ${r.correlationWithDTE5.toFixed(3)}`);
  console.log(`Standalone: Sharpe ${r.oosSharpe.toFixed(3)} | MaxDD ${r.oosMaxDD.toFixed(1)}% | WR ${r.oosWinRate.toFixed(1)}% | Trades ${r.oosTrades}`);
  console.log(`Total P&L: $${(r.oosTotalPnl / 100).toFixed(0)}`);
  console.log('');
  console.log('--- SPY Benchmark (market-regime-neutral alpha) ---');
  console.log(`OOS Information Ratio: ${r.oosSpyIR.toFixed(3)} (excess return ${(r.oosSpyExcessReturn * 100).toFixed(2)}%/yr over SPY)`);
  console.log('');
  console.log('--- Overfitting Checks (agent-safe — no holdout signal) ---');
  console.log(`Bootstrap 95% CI: [${r.bootstrapSharpe95CI[0].toFixed(3)}, ${r.bootstrapSharpe95CI[1].toFixed(3)}] ${r.bootstrapSignificant ? '✓ significant' : '✗ NOT significant'}`);
  // Phase 2.i: `deflatedSharpe` is bootstrap-SE-driven (historical
  // semantics). `deflatedSharpeMertens` is the parametric-SE companion.
  console.log(`Deflated Sharpe: ${r.deflatedSharpe.toFixed(3)} (bootstrap SE, adjusted for ${r.attemptNumber} attempts) ${r.deflatedSharpe > 0 ? '✓ survives' : '✗ may be noise'}${overfitWarning}`);
  if (r.deflatedSharpeMertens != null) {
    console.log(`Deflated Sharpe (Mertens): ${r.deflatedSharpeMertens.toFixed(3)}`);
  }
  if (r.statConsistencyRatio != null) {
    // Phase 2.h: SE-estimator consistency flag against the hashed
    // `maxStatConsistencyRatio` in adoption-gates. Authoritative
    // divergence signal — the old hardcoded 0.5-Sharpe-unit check
    // between the two DSR values was dropped in 2.i to remove the
    // conflict with this config-driven threshold.
    const status = r.passesStatConsistency === false ? '⚠ FLAG' : '✓ ok';
    console.log(`SE estimator consistency: ratio ${r.statConsistencyRatio.toFixed(2)}x ${status}`);
  }
  if (r.nEffOosDaily != null && r.nOosDaily != null && r.nOosDaily > 0) {
    const ratio = r.nEffOosDaily / r.nOosDaily;
    const flag = ratio < 0.3 ? ' ⚠ very autocorrelated' : ratio < 0.6 ? ' (moderately autocorrelated)' : '';
    console.log(`N_eff(OOS daily): ${r.nEffOosDaily.toFixed(0)} of ${r.nOosDaily} days (ratio ${ratio.toFixed(2)})${flag}`);
  }
  if (r.mertensSharpeSE != null) {
    // Compare Mertens SE against the bootstrap-CI-derived SE.
    // Large ratio (> 1.5 or < 0.67) = model-spec disagreement worth flagging.
    const bootSE = (r.bootstrapSharpe95CI[1] - r.bootstrapSharpe95CI[0]) / (2 * 1.96);
    const disagree = bootSE > 0 && (r.mertensSharpeSE / bootSE > 1.5 || r.mertensSharpeSE / bootSE < 0.67);
    const skewTxt = r.mertensSkewness != null ? `skew ${r.mertensSkewness.toFixed(2)}` : '';
    const kurtTxt = r.mertensKurtosis != null ? `kurt ${r.mertensKurtosis.toFixed(2)}` : '';
    console.log(
      `Mertens Sharpe SE: ${r.mertensSharpeSE.toFixed(3)} vs bootstrap SE ${bootSE.toFixed(3)}` +
      `${disagree ? ' ⚠ disagrees' : ''} (${[skewTxt, kurtTxt].filter(Boolean).join(', ')})`
    );
  }
  console.log(`WF Efficiency: ${r.wfEfficiency.toFixed(2)} (avg train: ${r.avgTrainSharpe.toFixed(3)})`);
  console.log('');
  console.log('--- Signal Timing Alpha (vs naive baseline) ---');
  if (r.baselineOosSharpe != null) {
    console.log(`Baseline: Sharpe ${r.baselineOosSharpe.toFixed(3)} | MaxDD ${r.baselineMaxDD?.toFixed(1)}% | Corr ${r.baselineCorrelation?.toFixed(3)} | SPY IR ${r.baselineSpyIR?.toFixed(3)} | Trades ${r.baselineTrades}`);
    console.log(`ΔSPY IR: ${r.deltaSpyIR != null ? r.deltaSpyIR.toFixed(3) : 'N/A'} ${r.passesDeltaSpyIR ? '✓' : '✗ FAIL (strategy IR ≤ baseline)'}`);
    console.log(`ΔMaxDD: ${r.deltaMaxDD != null ? r.deltaMaxDD.toFixed(1) + 'pp' : 'N/A'} ${r.passesDeltaMaxDD ? '✓' : '✗ FAIL (strategy DD > baseline)'}`);
    console.log(`ΔCorrelation: ${r.deltaCorrelation != null ? r.deltaCorrelation.toFixed(3) : 'N/A'} ${r.passesDeltaCorr ? '✓' : '✗ FAIL (strategy corr > baseline)'}`);
    console.log(`Delta gates: ${r.passesDeltaGates ? 'PASS — signal timing adds alpha' : 'FAIL — no alpha over naive always-long'}`);
  } else {
    console.log('Baseline unavailable — delta gates skipped');
  }
  console.log('');
  console.log(`Exit types: ${Object.entries(r.exitTypeBreakdown).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  console.log(`Elapsed: ${(r.elapsedMs / 1000).toFixed(1)}s`);
  // Agent-safe verdict: only reflects search-time validity. The "true" champion
  // determination (including holdout gate) is in the reviewer-only block and
  // in data/leaderboard-full-*.json for human analysis.
  const searchVerdict = r.isValidForSearch
    ? (!currentBest || r.combinedSharpe >= bestSharpe ? 'NEW PROVISIONAL BEST' : 'VALID_FOR_SEARCH — not best')
    : 'DISCARDED (failed search validity)';
  console.log(`Verdict (search-time): ${searchVerdict}`);

  // ── REVIEWER-ONLY — holdout feedback, stripped by agent-facing shells ──
  // Sentinel markers are recognized by run-*-overnight.sh when building
  // RUNNER_SUMMARY for the agent's journal prompt; everything between
  // BEGIN_REVIEWER_ONLY and END_REVIEWER_ONLY is removed before the agent sees it.
  console.log('__BEGIN_REVIEWER_ONLY__');
  console.log('--- Holdout Evaluation (do NOT feed to search agent) ---');
  console.log(`Holdout Sharpe gate: ${r.passesHoldout ? 'PASS' : 'FAIL'} (Sharpe ${r.holdoutSharpe.toFixed(3)}, ${r.holdoutTrades} trades)`);
  console.log(`Holdout-or-IR gate: ${r.passesHoldoutOrIR ? 'PASS' : 'FAIL'} (IR ${r.holdoutSpyIR.toFixed(3)}, excess ${(r.holdoutSpyExcessReturn * 100).toFixed(2)}%/yr)`);
  const stabilityGate = r.passesStability === false ? 'FAIL' : r.passesStability === true ? 'PASS' : 'n/a';
  console.log(`Holdout stability: ${holdoutStability} (ratio ${r.holdoutOOSRatio.toFixed(2)}, gate ${stabilityGate} — bounds [${g2.minStabilityHoldoutOosRatio.toFixed(2)}, ${g2.maxStabilityHoldoutOosRatio.toFixed(2)}])`);
  console.log(`Overall validity (search+holdout): ${r.isValid ? 'VALID' : 'INVALID'}`);
  console.log(`True champion verdict: ${isNewChampion ? 'NEW CHAMPION' : 'NOT CHAMPION'}`);
  console.log('__END_REVIEWER_ONLY__');
  console.log('='.repeat(60));
}

function printErrorResult(name: string, error: string, startMs: number) {
  console.log('\n' + '='.repeat(50));
  console.log('=== RUN RESULT ===');
  console.log(`Strategy: ${name}`);
  console.log(`Status: ERROR`);
  console.log(`Error: ${error}`);
  console.log(`Elapsed: ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
  console.log(`Verdict: DISCARDED`);
  console.log('='.repeat(50));
}

main().catch(err => { console.error(err); process.exit(1); });
