/**
 * Credit Spread Sweep — Train/Validate with Signal Tiers
 *
 * Proper IS/OOS methodology:
 *   1. IS sweep (2020-01-01 → 2023-12-31): test all 180 configs
 *   2. Pick top 20 by Sharpe from IS
 *   3. OOS validate (2024-04-01 → 2025-12-31): run top 20 on held-out data
 *
 * Parallel execution using worker_threads (20 workers on Ryzen 9 5900X).
 * All option chain data must be pre-cached in SQLite.
 *
 * Signal Tiers:
 *   S: score ≥ 90  (highest conviction)
 *   A: 80 ≤ score < 90
 *   B: 70 ≤ score < 80
 *   ALL: score ≥ 70  (combined)
 *
 * Usage:
 *   npx tsx scripts/credit-sweep.ts
 *   npx tsx scripts/credit-sweep.ts --ticker SPY
 *   npx tsx scripts/credit-sweep.ts --top 30      # pick top 30 instead of 20
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Worker } from 'node:worker_threads';

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

import type { BacktestCandle } from '../src/lib/backtest/types';
import type { TechScoreOptions } from '../src/lib/tech-analysis';
import { precomputeSignals } from '../src/lib/backtest/engine';
import { initDB, closeDB, getCacheStats } from '../src/lib/backtest/chain-cache';
import {
  DEFAULT_CREDIT_CONFIG,
  type EntrySignal, type SimConfig, type OptionSimAnalytics,
} from '../src/lib/backtest/option-sim';

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';

// Periods
const DATA_START = '2019-01-01';   // candle warmup (signal engine needs ~252 days)
const IS_START   = '2020-01-01';   // IS begins (after 1yr warmup for IV rank)
const IS_END     = '2023-12-31';   // IS ends
const OOS_START  = '2024-04-01';   // OOS begins (3-month gap avoids look-ahead)
const OOS_END    = '2025-12-31';   // OOS ends
const DATA_END   = '2025-12-31';   // max data range

const ALL_TICKERS = ['SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT'];
const NUM_WORKERS = Math.min(os.cpus().length - 2, 20);

// CLI args
const args = process.argv.slice(2);
const SINGLE_TICKER = args.find((a, i) => args[i - 1] === '--ticker') || null;
const TOP_N = parseInt(args.find((a, i) => args[i - 1] === '--top') || '20');
const tickers = SINGLE_TICKER ? [SINGLE_TICKER.toUpperCase()] : ALL_TICKERS;

// ── Supabase ────────────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── IV Rank Computation ─────────────────────────────────

function computeIVRank(ivSeries: (number | null)[]): (number | null)[] {
  const WINDOW = 252;
  return ivSeries.map((v, i) => {
    if (i < WINDOW || v == null) return null;
    const w = ivSeries.slice(i - WINDOW, i + 1).filter(x => x != null) as number[];
    if (w.length < 100) return null;
    const min = Math.min(...w), max = Math.max(...w), range = max - min;
    return range > 0 ? ((v - min) / range) * 100 : 50;
  });
}

// ── Signal Generation (parameterized by period) ─────────

interface TickerSignals {
  ticker: string;
  entries: EntrySignal[];
  allTradingDates: string[];
}

// Signal variants to test
interface SignalVariant {
  label: string;
  options: TechScoreOptions;
}

const SIGNAL_VARIANTS: SignalVariant[] = [
  { label: 'BASELINE', options: {} },
  { label: 'CORE_ONLY', options: { w_ema: 0, w_mom: 0, w_adx: 0, w_vol: 0 } },
];

// Pre-fetched candle data (shared across signal variants)
interface TickerCandleData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

const candleCache = new Map<string, TickerCandleData>();

async function fetchCandleData(ticker: string): Promise<TickerCandleData> {
  if (candleCache.has(ticker)) return candleCache.get(ticker)!;

  const candles: BacktestCandle[] = (await supabaseGet('stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`
  )).map(r => ({
    date: r.date, timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume,
  }));

  const ivData = await supabaseGet('orats_iv_cache',
    `select=date,iv30d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`);

  const ivByDate = new Map(ivData.map((r: any) => [r.date, r.iv30d]));
  const ivSeries = candles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRank(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  const data = { ticker, candles, ivRanks, dateToIdx };
  candleCache.set(ticker, data);
  return data;
}

async function generateSignals(
  ticker: string,
  periodStart: string,
  periodEnd: string,
  techOptions: TechScoreOptions = {},
): Promise<TickerSignals> {
  const td = await fetchCandleData(ticker);

  const { signals } = precomputeSignals(td.candles, '1D', techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    if (sig.date < periodStart || sig.date > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 70) continue;

    const idx = td.dateToIdx.get(sig.date);
    entries.push({
      ticker,
      date: sig.date,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
    });
  }

  const allTradingDates = td.candles
    .filter(c => c.date >= periodStart && c.date <= periodEnd)
    .map(c => c.date);

  return { ticker, entries, allTradingDates };
}

// ── Tier Definitions ────────────────────────────────────

interface TierDef {
  label: string;
  minScore: number;
  maxScore: number; // exclusive
}

const TIERS: TierDef[] = [
  { label: 'ALL', minScore: 70, maxScore: 101 },
  { label: '  S', minScore: 90, maxScore: 101 },
  { label: '  A', minScore: 80, maxScore: 90 },
  { label: '  B', minScore: 70, maxScore: 80 },
];

// ── Sweep Dimensions ────────────────────────────────────

const IV_RANKS = [0, 30, 50];
const CREDIT_TPS = [0.30, 0.50, 0.75];
const CREDIT_SLS = [1.5, 2.0, 3.0, 5.0, 100]; // 100 = no SL

// ── Worker Pool ─────────────────────────────────────────

interface WorkItem {
  id: number;
  config: SimConfig;
  minScore: number;
  maxScore: number;
  tierLabel: string;
  ivLabel: string;
  tpLabel: string;
  slLabel: string;
}

interface WorkResult {
  type: 'result';
  id: number;
  analytics: OptionSimAnalytics;
  tierLabel: string;
  ivLabel: string;
  tpLabel: string;
  slLabel: string;
}

async function createWorkerPool(
  allSignals: TickerSignals[],
  maxDate: string,
  numWorkers: number,
): Promise<Worker[]> {
  // Bundle the worker TS → MJS with esbuild (native modules stay external)
  const workerSrc = path.resolve(__dirname, 'credit-worker.ts');
  const workerBundle = path.resolve(__dirname, '.credit-worker.mjs');
  const { execSync } = await import('child_process');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );

  const workers = await Promise.all(
    Array.from({ length: numWorkers }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(workerBundle, {
          workerData: { allSignals, maxDate, token: ORATS_TOKEN },
        });
        w.once('message', (msg) => {
          if (msg.type === 'ready') resolve(w);
        });
        w.once('error', reject);
      }),
    ),
  );

  return workers;
}

async function terminatePool(workers: Worker[]) {
  for (const w of workers) w.postMessage({ type: 'exit' });
  await new Promise(r => setTimeout(r, 200));
  for (const w of workers) w.terminate();
}

async function runParallelSweep(
  workers: Worker[],
  workItems: WorkItem[],
  label: string,
): Promise<WorkResult[]> {
  const results: WorkResult[] = new Array(workItems.length);
  let nextIdx = 0;
  let completed = 0;
  const startTime = Date.now();

  return new Promise((resolve) => {
    function sendNext(worker: Worker) {
      if (nextIdx >= workItems.length) return;
      const item = workItems[nextIdx++];
      worker.postMessage(item);
    }

    for (const worker of workers) {
      worker.on('message', (msg: WorkResult) => {
        if (msg.type !== 'result') return;
        results[msg.id] = msg;
        completed++;

        const pct = Math.round(completed / workItems.length * 100);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (completed / (Date.now() - startTime) * 1000).toFixed(1);
        process.stdout.write(
          `\r    [${label}] ${completed}/${workItems.length} (${pct}%) | ${elapsed}s | ${rate} configs/s   `,
        );

        if (completed === workItems.length) {
          console.log('');
          resolve(results);
        } else {
          sendNext(worker);
        }
      });

      sendNext(worker);
    }
  });
}

// ── Work Item Builder ───────────────────────────────────

function buildWorkItems(): WorkItem[] {
  const items: WorkItem[] = [];
  let id = 0;

  for (const tier of TIERS) {
    for (const ivMin of IV_RANKS) {
      for (const tp of CREDIT_TPS) {
        for (const sl of CREDIT_SLS) {
          items.push({
            id: id++,
            config: {
              ...DEFAULT_CREDIT_CONFIG,
              minIVRank: ivMin,
              creditProfitTarget: tp,
              creditStopLossMultiple: sl,
            },
            minScore: tier.minScore,
            maxScore: tier.maxScore,
            tierLabel: tier.label,
            ivLabel: ivMin === 0 ? '≥0' : `≥${ivMin}`,
            tpLabel: `${(tp * 100).toFixed(0)}%`,
            slLabel: sl >= 100 ? 'None' : `${sl.toFixed(1)}×`,
          });
        }
      }
    }
  }

  return items;
}

// ── Table Formatting ────────────────────────────────────

function fmtPnl(pnl: number): string {
  return pnl >= 0 ? `+$${(pnl / 1000).toFixed(1)}k` : `-$${(Math.abs(pnl) / 1000).toFixed(1)}k`;
}

function sortResults(results: WorkResult[]): WorkResult[] {
  return [...results].sort((a, b) => {
    const ivA = parseInt(a.ivLabel.replace('≥', '')), ivB = parseInt(b.ivLabel.replace('≥', ''));
    if (ivA !== ivB) return ivA - ivB;
    const tpA = parseInt(a.tpLabel), tpB = parseInt(b.tpLabel);
    if (tpA !== tpB) return tpA - tpB;
    const slA = a.slLabel === 'None' ? 999 : parseFloat(a.slLabel);
    const slB = b.slLabel === 'None' ? 999 : parseFloat(b.slLabel);
    return slA - slB;
  });
}

function printResultRow(r: WorkResult, prefix: string = '  │') {
  const a = r.analytics;
  console.log(
    `${prefix} ${r.tierLabel} │ ${r.ivLabel.padStart(6)} │ ${r.tpLabel.padStart(4)} │ ${r.slLabel.padStart(4)} │ ` +
    `${String(a.totalTrades).padStart(6)} │ ${a.winRate.toFixed(1).padStart(5)}% │ ` +
    `${a.sharpe.toFixed(2).padStart(6)} │ ${a.profitFactor.toFixed(2).padStart(6)} │ ` +
    `${a.avgPnlPct.toFixed(1).padStart(5)}% │ ${fmtPnl(a.totalPnl).padStart(10)} │ ${a.returnOnCapital.toFixed(1).padStart(5)}% │`,
  );
}

const TABLE_HEADER = [
  '  ┌──────┬────────┬──────┬──────┬────────┬────────┬────────┬────────┬────────┬────────────┬────────┐',
  '  │ Tier │ IV Rnk │ TP%  │ SL×  │ Trades │  WR %  │ Sharpe │   PF   │ Avg%   │  Total P&L │ ROC %  │',
  '  ├──────┼────────┼──────┼──────┼────────┼────────┼────────┼────────┼────────┼────────────┼────────┤',
];
const TABLE_SEP = '  ├──────┼────────┼──────┼──────┼────────┼────────┼────────┼────────┼────────┼────────────┼────────┤';
const TABLE_FOOTER = '  └──────┴────────┴──────┴──────┴────────┴────────┴────────┴────────┴────────┴────────────┴────────┘';

function printSignalSummary(label: string, allSignals: TickerSignals[]) {
  for (const ts of allSignals) {
    const s = ts.entries.filter(e => e.score >= 90).length;
    const a = ts.entries.filter(e => e.score >= 80 && e.score < 90).length;
    const b = ts.entries.filter(e => e.score >= 70 && e.score < 80).length;
    console.log(`      ${ts.ticker}: ${ts.entries.length} signals (S:${s} A:${a} B:${b})`);
  }
  const total = allSignals.reduce((s, ts) => s + ts.entries.length, 0);
  const totalS = allSignals.reduce((s, ts) => s + ts.entries.filter(e => e.score >= 90).length, 0);
  const totalA = allSignals.reduce((s, ts) => s + ts.entries.filter(e => e.score >= 80 && e.score < 90).length, 0);
  const totalB = allSignals.reduce((s, ts) => s + ts.entries.filter(e => e.score >= 70 && e.score < 80).length, 0);
  console.log(`      TOTAL: ${total} signals (S:${totalS} A:${totalA} B:${totalB})`);
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║   CREDIT SPREAD — BASELINE vs CORE_ONLY Signal Comparison                   ║');
  console.log('╠═══════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║   IS  (train):    ${IS_START} → ${IS_END}  (4 years)                            ║`);
  console.log(`║   OOS (validate): ${OOS_START} → ${OOS_END}  (1.75 years, 3-month gap)          ║`);
  console.log(`║   Tickers: ${tickers.join(', ').padEnd(49)}            ║`);
  console.log(`║   Workers: ${NUM_WORKERS} threads (${os.cpus().length} CPU cores)${' '.repeat(42)}║`);
  console.log(`║   Signal variants: BASELINE (all 7 features) vs CORE_ONLY (MB+BXS+BXL)     ║`);
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝\n');

  // Verify cache
  initDB();
  const stats = getCacheStats();
  console.log(`  Cache: ${stats.totalRows.toLocaleString()} rows, ${stats.totalDates.toLocaleString()} ticker-dates`);
  console.log(`  Cached tickers: ${stats.tickers.join(', ')}\n`);
  closeDB();

  // Pre-fetch candle data for all tickers (shared across variants)
  console.log('  Fetching candle data for all tickers...');
  for (const ticker of tickers) {
    await fetchCandleData(ticker);
    process.stdout.write(`    ${ticker} `);
  }
  console.log('\n');

  // ═══════════════════════════════════════════════════════
  //  Run IS/OOS sweep for each signal variant
  // ═══════════════════════════════════════════════════════
  interface VariantResult {
    label: string;
    isSignals: TickerSignals[];
    oosSignals: TickerSignals[];
    isResults: WorkResult[];
    oosResults: WorkResult[];
    topN: WorkResult[];
    allWorkItems: WorkItem[];
  }

  const variantResults: VariantResult[] = [];

  for (const variant of SIGNAL_VARIANTS) {
    console.log(`\n  ═══ SIGNAL VARIANT: ${variant.label} ═══════════════════════════════════`);

    // Phase 1: IS signals
    console.log(`\n  Phase 1: Generating IS signals (${IS_START} → ${IS_END}) with ${variant.label}...`);
    const isSignals: TickerSignals[] = [];
    for (const ticker of tickers) {
      isSignals.push(await generateSignals(ticker, IS_START, IS_END, variant.options));
    }
    printSignalSummary('IS', isSignals);

    // Phase 2: IS Sweep
    const allWorkItems = buildWorkItems();
    console.log(`\n  Phase 2: IS sweep — ${allWorkItems.length} configs across ${NUM_WORKERS} workers...`);
    const isStart = Date.now();

    const isWorkers = await createWorkerPool(isSignals, IS_END, NUM_WORKERS);
    console.log(`    Workers initialized (${((Date.now() - isStart) / 1000).toFixed(1)}s)`);

    const isResults = await runParallelSweep(isWorkers, allWorkItems, `IS-${variant.label}`);
    await terminatePool(isWorkers);

    console.log(`    IS sweep done in ${((Date.now() - isStart) / 1000).toFixed(1)}s`);

    // Phase 3: Pick top N
    const MIN_TRADES = 10;
    const qualified = isResults.filter(r => r.analytics.totalTrades >= MIN_TRADES);
    qualified.sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
    const topN = qualified.slice(0, TOP_N);

    console.log(`\n  Phase 3: Top ${TOP_N} IS configs (${variant.label}):`);
    TABLE_HEADER.forEach(l => console.log(l));
    for (let i = 0; i < topN.length; i++) {
      if (i > 0 && i % 5 === 0) console.log(TABLE_SEP);
      printResultRow(topN[i]);
    }
    console.log(TABLE_FOOTER);

    // Phase 4: OOS signals
    console.log(`\n  Phase 4: Generating OOS signals (${OOS_START} → ${OOS_END}) with ${variant.label}...`);
    const oosSignals: TickerSignals[] = [];
    for (const ticker of tickers) {
      oosSignals.push(await generateSignals(ticker, OOS_START, OOS_END, variant.options));
    }
    printSignalSummary('OOS', oosSignals);

    // Phase 5: OOS Validation
    const oosWorkItems: WorkItem[] = topN.map((isResult, i) => ({
      ...allWorkItems[isResult.id],
      id: i,
    }));

    console.log(`\n  Phase 5: OOS validation — ${oosWorkItems.length} configs...`);
    const oosStart = Date.now();

    const oosWorkers = await createWorkerPool(oosSignals, OOS_END, NUM_WORKERS);
    const oosResults = await runParallelSweep(oosWorkers, oosWorkItems, `OOS-${variant.label}`);
    await terminatePool(oosWorkers);

    console.log(`    OOS done in ${((Date.now() - oosStart) / 1000).toFixed(1)}s`);

    variantResults.push({ label: variant.label, isSignals, oosSignals, isResults, oosResults, topN, allWorkItems });
  }

  // ═══════════════════════════════════════════════════════
  //  COMPARISON: BASELINE vs CORE_ONLY
  // ═══════════════════════════════════════════════════════
  console.log('\n\n  ╔═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('  ║   COMPARISON: BASELINE vs CORE_ONLY — IS/OOS Side by Side                                                                             ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝');

  for (const vr of variantResults) {
    console.log(`\n  ─── ${vr.label} ─── Top ${TOP_N} IS → OOS ───`);
    console.log('  ┌──────────────────────────────────┬───────────────────────────────────────────────────────┬───────────────────────────────────────────────────────┐');
    console.log('  │          Config                  │     IS (2020-2023)                                    │     OOS (2024-2025)                                   │');
    console.log('  ├──────┬────────┬──────┬──────┬────┼────────┬────────┬────────┬────────┬────────┬──────────┼────────┬────────┬────────┬────────┬────────┬──────────┤');
    console.log('  │ Tier │ IV Rnk │ TP%  │ SL×  │ Rk │ Trades │  WR %  │ Sharpe │   PF   │ Avg%   │ Tot P&L  │ Trades │  WR %  │ Sharpe │   PF   │ Avg%   │ Tot P&L  │');
    console.log('  ├──────┼────────┼──────┼──────┼────┼────────┼────────┼────────┼────────┼────────┼──────────┼────────┼────────┼────────┼────────┼────────┼──────────┤');

    for (let i = 0; i < vr.topN.length; i++) {
      const is = vr.topN[i].analytics;
      const oos = vr.oosResults[i].analytics;
      const rk = `#${i + 1}`.padStart(3);

      console.log(
        `  │ ${vr.topN[i].tierLabel} │ ${vr.topN[i].ivLabel.padStart(6)} │ ${vr.topN[i].tpLabel.padStart(4)} │ ${vr.topN[i].slLabel.padStart(4)} │ ${rk} │` +
        ` ${String(is.totalTrades).padStart(6)} │ ${is.winRate.toFixed(1).padStart(5)}% │ ${is.sharpe.toFixed(2).padStart(6)} │ ${is.profitFactor.toFixed(2).padStart(6)} │ ${is.avgPnlPct.toFixed(1).padStart(5)}% │ ${fmtPnl(is.totalPnl).padStart(8)} │` +
        ` ${String(oos.totalTrades).padStart(6)} │ ${oos.winRate.toFixed(1).padStart(5)}% │ ${oos.sharpe.toFixed(2).padStart(6)} │ ${oos.profitFactor.toFixed(2).padStart(6)} │ ${oos.avgPnlPct.toFixed(1).padStart(5)}% │ ${fmtPnl(oos.totalPnl).padStart(8)} │`,
      );

      if (i < vr.topN.length - 1 && (i + 1) % 5 === 0) {
        console.log('  ├──────┼────────┼──────┼──────┼────┼────────┼────────┼────────┼────────┼────────┼──────────┼────────┼────────┼────────┼────────┼────────┼──────────┤');
      }
    }
    console.log('  └──────┴────────┴──────┴──────┴────┴────────┴────────┴────────┴────────┴────────┴──────────┴────────┴────────┴────────┴────────┴────────┴──────────┘');

    // Survival
    const oosPositive = vr.oosResults.filter(r => r.analytics.sharpe > 0).length;
    const oosSharpeAboveHalf = vr.oosResults.filter(r => r.analytics.sharpe > 0.5).length;
    const oosRetainPct = vr.topN.filter((is, i) => vr.oosResults[i].analytics.sharpe >= is.analytics.sharpe * 0.5).length;

    console.log(`\n  Survival (${vr.label}):`);
    console.log(`    Positive Sharpe in OOS:       ${oosPositive}/${TOP_N} (${Math.round(oosPositive / TOP_N * 100)}%)`);
    console.log(`    Sharpe > 0.5 in OOS:          ${oosSharpeAboveHalf}/${TOP_N} (${Math.round(oosSharpeAboveHalf / TOP_N * 100)}%)`);
    console.log(`    Retained ≥50% of IS Sharpe:   ${oosRetainPct}/${TOP_N} (${Math.round(oosRetainPct / TOP_N * 100)}%)`);

    const bestOOS = vr.oosResults.reduce((a, b) => a.analytics.sharpe > b.analytics.sharpe ? a : b);
    const bestIdx = vr.oosResults.indexOf(bestOOS);
    const bestIS = vr.topN[bestIdx];
    console.log(`    Best OOS: ${bestIS.tierLabel.trim()} | IV ${bestIS.ivLabel} | TP ${bestIS.tpLabel} | SL ${bestIS.slLabel}`);
    console.log(`      IS → OOS Sharpe: ${bestIS.analytics.sharpe.toFixed(2)} → ${bestOOS.analytics.sharpe.toFixed(2)}`);
    console.log(`      IS → OOS WR:    ${bestIS.analytics.winRate.toFixed(1)}% → ${bestOOS.analytics.winRate.toFixed(1)}%`);
    console.log(`      IS → OOS P&L:   ${fmtPnl(bestIS.analytics.totalPnl)} → ${fmtPnl(bestOOS.analytics.totalPnl)}`);
  }

  // Final verdict
  console.log('\n\n  ═══ FINAL VERDICT ═══════════════════════════════════════════════════');
  for (const vr of variantResults) {
    const bestOOS = vr.oosResults.reduce((a, b) => a.analytics.sharpe > b.analytics.sharpe ? a : b);
    const oosPositive = vr.oosResults.filter(r => r.analytics.sharpe > 0).length;
    console.log(`    ${vr.label.padEnd(12)}: Best OOS Sharpe = ${bestOOS.analytics.sharpe.toFixed(2)}, ${oosPositive}/${TOP_N} survived`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
