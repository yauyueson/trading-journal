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
  StrategyDefinition, TickerDataBundle, RegimeData,
  DTE5Baseline, RunResult, WindowDef, WorkItem, WorkResult,
} from './types';

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const DATA_START = '2017-01-01';
const DATA_END = '2026-02-28';
const MIN_OOS_TRADES = 100;
const MAX_OOS_DD = 35;
const MIN_HOLDOUT_SHARPE = 0;       // holdout must be non-negative
const MAX_SANE_OOS_SHARPE = 3.0;    // anything above this is suspicious — simulator bug likely
const BOOTSTRAP_ITERATIONS = 1000;  // for CI estimation

// ── Supabase Helper ─────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
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

// ── Data Loading ────────────────────────────────────────

async function loadTickerData(ticker: string): Promise<TickerDataBundle> {
  const rows = await supabaseGet('stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=10000`);
  const candles: BacktestCandle[] = rows.map((r: any) => ({
    date: r.date, timestamp: new Date(r.date).getTime(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0,
  }));

  // IV data
  const ivRows = await supabaseGet('orats_iv_cache',
    `select=date,iv30d,iv60d,hv20d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`);
  const ivByDate = new Map<string, { iv30: number | null; iv60: number | null; hv20: number | null }>();
  for (const r of ivRows) {
    ivByDate.set(r.date, { iv30: r.iv30d, iv60: r.iv60d ?? null, hv20: r.hv20d ?? null });
  }
  const ivSeries = candles.map(c => ivByDate.get(c.date)?.iv30 ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  // EMAs
  const closes = candles.map(c => c.close);
  const emaPeriods = [8, 13, 21, 34, 55];
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

  return { ticker, candles, ivRanks, dateToIdx, emas, regimeByDate };
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
async function loadSpyBenchmark(): Promise<SpyBenchmark> {
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

/**
 * Block bootstrap 95% confidence interval on Sharpe ratio.
 * Uses overlapping block bootstrap (block size ~sqrt(n)) to preserve
 * autocorrelation structure in daily returns — unlike i.i.d. bootstrap
 * which understates CI width for serially correlated time series.
 */
function bootstrapSharpeCI(dailyReturns: number[], iterations = BOOTSTRAP_ITERATIONS): [number, number] {
  if (dailyReturns.length < 30) return [0, 0];

  const n = dailyReturns.length;
  const blockSize = Math.max(5, Math.floor(Math.sqrt(n))); // ~15 for 252 days
  const sharpes: number[] = [];

  for (let i = 0; i < iterations; i++) {
    // Block bootstrap: sample contiguous blocks with replacement
    const resampled: number[] = [];
    while (resampled.length < n) {
      const startIdx = Math.floor(Math.random() * (n - blockSize + 1));
      for (let j = 0; j < blockSize && resampled.length < n; j++) {
        resampled.push(dailyReturns[startIdx + j]);
      }
    }

    let sum = 0, sumSq = 0;
    for (let j = 0; j < n; j++) {
      sum += resampled[j];
      sumSq += resampled[j] * resampled[j];
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    const std = Math.sqrt(Math.max(0, variance));
    sharpes.push(std > 0 ? (mean / std) * Math.sqrt(252) : 0);
  }

  sharpes.sort((a, b) => a - b);
  const lo = sharpes[Math.floor(iterations * 0.025)];
  const hi = sharpes[Math.floor(iterations * 0.975)];
  return [lo, hi];
}

/**
 * Deflated Sharpe Ratio — adjusts for multiple testing.
 * Based on Bailey & López de Prado (2014): "The Deflated Sharpe Ratio"
 *
 * Given N attempts, the expected maximum Sharpe from random strategies is:
 *   E[max] ≈ sqrt(2 * ln(N)) * (1 - γ / (2 * ln(N))) + γ / sqrt(2 * ln(N))
 * where γ ≈ 0.5772 (Euler-Mascheroni constant).
 *
 * The deflated Sharpe = observed Sharpe - E[max from noise]
 * A positive deflated Sharpe means the strategy likely has real edge beyond luck.
 */
function computeDeflatedSharpe(observedSharpe: number, numAttempts: number): number {
  if (numAttempts <= 1) return observedSharpe;
  const gamma = 0.5772; // Euler-Mascheroni
  const logN = Math.log(numAttempts);
  const expectedMaxSharpe = Math.sqrt(2 * logN) * (1 - gamma / (2 * logN)) + gamma / Math.sqrt(2 * logN);
  return observedSharpe - expectedMaxSharpe;
}

// ── Leaderboard ─────────────────────────────────────────

function loadLeaderboard(): RunResult[] {
  const p = path.resolve(__dirname, 'leaderboard.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function saveLeaderboard(entries: RunResult[]) {
  const p = path.resolve(__dirname, 'leaderboard.json');
  fs.writeFileSync(p, JSON.stringify(entries, null, 2));
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log('=== Autoresearch Runner ===\n');

  // 1. Load DTE5 baseline
  const baselinePath = path.resolve(__dirname, 'dte5-baseline.json');
  if (!fs.existsSync(baselinePath)) {
    console.error('ERROR: dte5-baseline.json not found. Run generate-baseline.ts first.');
    process.exit(1);
  }
  const baseline: DTE5Baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  console.log(`DTE5 baseline: Sharpe ${baseline.oosSharpe.toFixed(3)}, ${baseline.dates.length} dates`);

  // 1b. Load SPY benchmark for Information Ratio (market-regime-neutral alpha)
  console.log('Loading SPY benchmark...');
  const spyBenchmark = await loadSpyBenchmark();
  console.log(`SPY benchmark: ${spyBenchmark.dates.length} daily returns loaded\n`);

  // 2. Bundle strategy.ts
  const strategySrc = path.resolve(__dirname, 'strategy.ts');
  const strategyBundle = path.resolve(__dirname, '.autoresearch-strategy.mjs');
  console.log('Bundling strategy.ts...');
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

  // 4. Load ticker data
  console.log('Loading ticker data...');
  const tickerDataMap = new Map<string, TickerDataBundle>();
  for (const ticker of strategy.tickers) {
    process.stdout.write(`  ${ticker}...`);
    const data = await loadTickerData(ticker);
    tickerDataMap.set(ticker, data);
    process.stdout.write(` ${data.candles.length} candles\n`);
  }

  // 5. Generate signals
  console.log('\nGenerating signals...');
  const allSignals: import('./types').EntrySignal[] = [];
  for (const [ticker, data] of tickerDataMap) {
    const signals = strategy.generateSignals(data);
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
  const holdoutCount = wfa.holdoutCount ?? 2;
  const wfaStartDate = allTradingDates.find(d => d >= '2018-01-01') ?? allTradingDates[0];
  const allWindows = buildWFAWindows(allTradingDates, {
    trainWindowDays: wfa.trainWindowDays,
    forwardStepDays: wfa.forwardStepDays,
    purgeGapDays: wfa.purgeGapDays,
    mode: wfa.mode,
    startDate: wfaStartDate,
    endDate: allTradingDates[allTradingDates.length - 1],
  });
  const selectionWindows = allWindows.slice(0, -holdoutCount);
  const holdoutWindows = allWindows.slice(-holdoutCount);
  console.log(`WFA: ${selectionWindows.length} selection + ${holdoutWindows.length} holdout windows\n`);

  if (selectionWindows.length === 0) {
    printErrorResult(strategy.name, 'No WFA windows generated. Check date range and window params.', startMs);
    process.exit(0);
  }

  // 7. Build SimConfig (use first ticker/CALL as representative — agent can customize per signal via configuredDelta)
  const simConfig = strategy.buildConfig(strategy.tickers[0], 'CALL');

  // 8. Bundle and spawn worker pool (8 cores)
  const NUM_WORKERS = 8;
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

  // Split windows into chunks for parallel evaluation
  function chunkArray<T>(arr: T[], n: number): T[][] {
    const chunks: T[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < arr.length; i++) {
      chunks[i % n].push(arr[i]);
    }
    return chunks;
  }

  const selectionChunks = chunkArray(selectionWindows, NUM_WORKERS);
  const holdoutChunks = chunkArray(holdoutWindows, NUM_WORKERS);

  // Spawn all workers in parallel
  console.log(`Spawning ${NUM_WORKERS} workers...`);
  const workers: Worker[] = await Promise.all(
    Array.from({ length: NUM_WORKERS }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(workerBundle, { workerData: workerInitData });
        w.once('message', (msg) => {
          if (msg?.type === 'ready') resolve(w);
          else reject(new Error('Worker failed to initialize'));
        });
        w.once('error', reject);
      }),
    ),
  );
  console.log(`${NUM_WORKERS} workers ready. Evaluating in parallel...\n`);

  // 9. Evaluate — fan out windows across workers, collect results
  const workerResults = await Promise.all(
    workers.map((worker, idx) =>
      new Promise<WorkResult>((resolve, reject) => {
        worker.on('message', (msg: WorkResult) => {
          if (msg.type === 'result') resolve(msg);
        });
        worker.on('error', reject);
        worker.postMessage({
          type: 'eval',
          id: idx,
          simConfig,
          selectionWindows: selectionChunks[idx],
          holdoutWindows: holdoutChunks[idx],
        } satisfies WorkItem);
      }),
    ),
  );

  // Terminate all workers
  await Promise.all(workers.map(async (w) => {
    w.postMessage({ type: 'exit' });
    await w.terminate();
  }));

  // Merge results from all workers
  const workerResult: WorkResult = {
    type: 'result',
    id: 0,
    selectionResults: workerResults.flatMap(r => r.selectionResults),
    allOOSTrades: workerResults.flatMap(r => r.allOOSTrades),
    holdoutTrades: workerResults.flatMap(r => r.holdoutTrades),
    error: workerResults.find(r => r.error)?.error,
  };
  // Re-sort selection results by window index for consistent ordering
  workerResult.selectionResults.sort((a, b) => a.windowIdx - b.windowIdx);

  if (workerResult.error) {
    printErrorResult(strategy.name, `Worker error: ${workerResult.error}`, startMs);
    process.exit(0);
  }

  // 10. Compute metrics
  const selectionStart = selectionWindows[0]?.oosStart ?? wfaStartDate;
  const selectionEnd = selectionWindows[selectionWindows.length - 1]?.oosEnd ?? DATA_END;
  const holdoutStart = holdoutWindows[0]?.oosStart ?? wfaStartDate;
  const holdoutEnd = holdoutWindows[holdoutWindows.length - 1]?.oosEnd ?? DATA_END;

  const oosMetrics = computePortfolioDailyMetrics(
    workerResult.allOOSTrades, allTradingDates, selectionStart, selectionEnd, strategy.portfolio.startingCapital,
  );
  const oosAnalytics = computeOptionAnalytics(workerResult.allOOSTrades);
  const holdoutMetrics = computePortfolioDailyMetrics(
    workerResult.holdoutTrades, allTradingDates, holdoutStart, holdoutEnd, strategy.portfolio.startingCapital,
  );
  const holdoutAnalytics = computeOptionAnalytics(workerResult.holdoutTrades);

  const avgTrainSharpe = workerResult.selectionResults.length > 0
    ? workerResult.selectionResults.reduce((s, w) => s + w.trainSharpe, 0) / workerResult.selectionResults.length
    : 0;
  const wfEfficiency = avgTrainSharpe >= 0.1 ? oosMetrics.sharpe / avgTrainSharpe : 0;

  // 11. Combined Sharpe with DTE5
  const strategyDates = oosMetrics.equityCurve.map(e => e.date);
  const { combinedSharpe, correlation, combinedMaxDD } = computeCombinedMetrics(
    oosMetrics.dailyReturns, strategyDates, baseline,
  );

  // 11b. SPY Information Ratio for selection and holdout periods
  // This is the market-regime-neutral alpha check. A strategy that earns 0% while
  // SPY drops -20% has high positive IR even though its absolute Sharpe looks bad.
  const holdoutDates = holdoutMetrics.equityCurve.map(e => e.date);
  const oosSpyIRResult = computeInformationRatio(oosMetrics.dailyReturns, strategyDates, spyBenchmark);
  const holdoutSpyIRResult = computeInformationRatio(holdoutMetrics.dailyReturns, holdoutDates, spyBenchmark);

  // 12. Overfitting defenses
  const bootstrapCI = bootstrapSharpeCI(oosMetrics.dailyReturns);
  const bootstrapSignificant = bootstrapCI[0] > 0;
  const leaderboard = loadLeaderboard();
  const attemptNumber = leaderboard.length + 1;
  const deflatedSharpe = computeDeflatedSharpe(oosMetrics.sharpe, attemptNumber);
  const holdoutOOSRatio = oosMetrics.sharpe > 0.01 ? holdoutMetrics.sharpe / oosMetrics.sharpe : 0;

  // 13. Validity checks (now includes holdout gate)
  // Sanity bound: nothing real produces OOS Sharpe > 3 on 8 years of data.
  // If we see it, a simulator bug or data leak is the likely cause — reject.
  const passesMinTrades = workerResult.allOOSTrades.length >= MIN_OOS_TRADES;
  const passesMaxDD = oosMetrics.maxDrawdownPct <= MAX_OOS_DD;
  const passesWFA = oosMetrics.sharpe > 0;
  const passesHoldout = holdoutMetrics.sharpe >= MIN_HOLDOUT_SHARPE;
  // Relaxed holdout gate: accept strategies that BEAT SPY even if absolute
  // Sharpe is muted. This catches the case where the holdout window happens
  // to be a bad market regime — a strategy with holdout Sharpe 0.1 but IR 0.5
  // is doing its job (beating a terrible market), whereas a strategy with
  // Sharpe 2.0 but IR -0.3 is just riding a bull regime.
  //
  // Two paths to pass:
  //   (a) holdout Sharpe >= 0.3 (meaningful absolute return, regardless of market)
  //   (b) holdout IR >= 0.3     (meaningful alpha vs SPY, regardless of absolute return)
  //
  // Using 0.3 on both sides (not 0) catches near-zero results that are
  // statistically indistinguishable from failure. The previous LEAP champion
  // had holdout Sharpe 0.01 and IR -0.21 — neither passes 0.3.
  const MIN_HOLDOUT_METRIC = 0.3;
  const passesHoldoutAbsolute = holdoutMetrics.sharpe >= MIN_HOLDOUT_METRIC;
  const passesHoldoutIR = holdoutSpyIRResult.ir >= MIN_HOLDOUT_METRIC;
  const passesHoldoutOrIR = passesHoldoutAbsolute || passesHoldoutIR;
  const passesSanity = oosMetrics.sharpe <= MAX_SANE_OOS_SHARPE;
  const isValid = passesMinTrades && passesMaxDD && passesWFA && passesHoldoutOrIR && passesSanity;

  // Exit type breakdown
  const exitTypeBreakdown: Record<string, number> = {};
  for (const t of workerResult.allOOSTrades) {
    exitTypeBreakdown[t.exitType] = (exitTypeBreakdown[t.exitType] ?? 0) + 1;
  }

  const elapsedMs = Date.now() - startMs;

  const runResult: RunResult = {
    strategyName: strategy.name,
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
    oosSpyIR: oosSpyIRResult.ir,
    oosSpyExcessReturn: oosSpyIRResult.excessReturn,
    holdoutSpyIR: holdoutSpyIRResult.ir,
    holdoutSpyExcessReturn: holdoutSpyIRResult.excessReturn,
    avgTrainSharpe,
    wfEfficiency,
    passesMinTrades,
    passesMaxDD,
    passesWFA,
    passesHoldout,
    passesHoldoutOrIR,
    passesSanity,
    isValid,
    holdoutOOSRatio,
    bootstrapSharpe95CI: bootstrapCI,
    bootstrapSignificant,
    attemptNumber,
    deflatedSharpe,
    exitTypeBreakdown,
    signalsGenerated: allSignals.length,
    signalsSkippedNoChain: allSignals.length - workerResult.allOOSTrades.length - workerResult.holdoutTrades.length,
    elapsedMs,
  };

  // 14. Update leaderboard
  leaderboard.push(runResult);
  saveLeaderboard(leaderboard);

  const validEntries = leaderboard.filter(e => e.isValid);
  const currentBest = validEntries.length > 0
    ? validEntries.reduce((best, e) => e.combinedSharpe > best.combinedSharpe ? e : best)
    : null;

  // 14. Keep/discard
  const isNewChampion = isValid && (!currentBest || combinedSharpe >= currentBest.combinedSharpe);
  if (isNewChampion) {
    const bestPath = path.resolve(__dirname, 'best-strategy.ts');
    fs.copyFileSync(strategySrc, bestPath);
  }

  // 15. Print structured output
  printResult(runResult, currentBest, isNewChampion);

  // Cleanup temp bundle
  try { fs.unlinkSync(strategyBundle); } catch {}
}

// ── Output Formatting ───────────────────────────────────

function printResult(r: RunResult, currentBest: RunResult | null, isNewChampion: boolean) {
  const bestSharpe = currentBest?.combinedSharpe ?? 0;
  const invalidReasons = [
    !r.passesMinTrades && `${r.oosTrades} trades < ${MIN_OOS_TRADES} min`,
    !r.passesMaxDD && `MaxDD ${r.oosMaxDD.toFixed(1)}% > ${MAX_OOS_DD}% limit`,
    !r.passesWFA && `OOS Sharpe ${r.oosSharpe.toFixed(3)} <= 0`,
    !r.passesHoldoutOrIR && `holdout fail: Sharpe ${r.holdoutSharpe.toFixed(2)} < 0.3 AND SPY IR ${r.holdoutSpyIR.toFixed(2)} < 0.3 (beats neither absolute nor market)`,
    !r.passesSanity && `OOS Sharpe ${r.oosSharpe.toFixed(3)} > ${MAX_SANE_OOS_SHARPE} (sanity bound — simulator bug likely)`,
  ].filter(Boolean);
  const status = r.isValid ? 'VALID' : `INVALID (${invalidReasons.join(', ')})`;

  // Overfitting risk assessment
  let overfitWarning = '';
  if (r.holdoutOOSRatio < 0.3 && r.oosSharpe > 0.5) overfitWarning = ' [WARNING: holdout/OOS ratio < 0.3 — likely overfit]';
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
  console.log(`Holdout Information Ratio: ${r.holdoutSpyIR.toFixed(3)} (excess return ${(r.holdoutSpyExcessReturn * 100).toFixed(2)}%/yr over SPY)`);
  console.log('');
  console.log('--- Overfitting Checks ---');
  // IMPORTANT: holdout Sharpe is shown only as pass/fail, NOT the exact number.
  // This prevents the agent from implicitly optimizing for holdout over many iterations.
  console.log(`Holdout Sharpe gate: ${r.passesHoldout ? 'PASS' : 'FAIL'} (${r.holdoutTrades} trades)`);
  console.log(`Holdout-or-IR gate (either beats absolute OR beats SPY): ${r.passesHoldoutOrIR ? 'PASS' : 'FAIL'}`);
  console.log(`Holdout/OOS ratio: ${r.holdoutOOSRatio.toFixed(2)} (want > 0.5)${overfitWarning}`);
  console.log(`Bootstrap 95% CI: [${r.bootstrapSharpe95CI[0].toFixed(3)}, ${r.bootstrapSharpe95CI[1].toFixed(3)}] ${r.bootstrapSignificant ? '✓ significant' : '✗ NOT significant'}`);
  console.log(`Deflated Sharpe: ${r.deflatedSharpe.toFixed(3)} (adjusted for ${r.attemptNumber} attempts) ${r.deflatedSharpe > 0 ? '✓ survives' : '✗ may be noise'}`);
  console.log(`WF Efficiency: ${r.wfEfficiency.toFixed(2)} (avg train: ${r.avgTrainSharpe.toFixed(3)})`);
  console.log('');
  console.log(`Exit types: ${Object.entries(r.exitTypeBreakdown).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  console.log(`Elapsed: ${(r.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`Verdict: ${isNewChampion ? 'NEW CHAMPION' : 'DISCARDED'}`);
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
