/**
 * Walk-Forward Analysis Runner — Short-Term Credit Spreads (7-14 DTE)
 *
 * Phase 0 validation: parallelized WFA using worker_threads.
 * Each worker has its own SQLite connection and evaluates configs independently.
 *
 * Usage:
 *   npx tsx scripts/wfa-run-short.ts
 *   npx tsx scripts/wfa-run-short.ts --ticker SPY
 *   npx tsx scripts/wfa-run-short.ts --fill bidask
 *   npx tsx scripts/wfa-run-short.ts --workers 8
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Worker } from 'node:worker_threads';
import { execSync } from 'child_process';

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
import { SIGNAL_PRESETS, DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import { precomputeSignals } from '../src/lib/backtest/engine';
import {
  initDB, closeDB, getCacheStats,
} from '../src/lib/backtest/chain-cache';
import {
  DEFAULT_SHORT_CREDIT_CONFIG,
  computeOptionAnalytics,
  type EntrySignal, type SimConfig, type OptionTrade,
  type SignalPresetKey,
} from '../src/lib/backtest/option-sim';
import type { FillMode } from '../src/lib/backtest/types';
import { buildWFAWindows, type WindowDef } from '../src/lib/backtest/wfa-options';

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';

const DATA_START = '2021-01-01';   // candle warmup (1yr for tech indicators)
const WFA_START  = '2022-01-01';   // WFA date range start
const WFA_END    = '2026-02-28';   // WFA date range end
const DATA_END   = '2026-02-28';

const ALL_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
  'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
  'META', 'NFLX', 'GOOG', 'GS',
];

// CLI args
const args = process.argv.slice(2);
function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const SINGLE_TICKER = getArg('--ticker');
const WFA_MODE = (getArg('--mode') || 'rolling') as 'rolling' | 'anchored';
const TRAIN_DAYS = parseInt(getArg('--train') || '252');
const STEP_DAYS = parseInt(getArg('--step') || '63');
const PURGE_DAYS = parseInt(getArg('--purge') || '25');
const STARTING_CAPITAL = parseInt(getArg('--capital') || '100000');
const FILL_MODE = (getArg('--fill') || 'mid') as FillMode;
const NUM_WORKERS = Math.min(parseInt(getArg('--workers') || String(os.cpus().length - 2)), 20);

const tickers = SINGLE_TICKER ? [SINGLE_TICKER.toUpperCase()] : ALL_TICKERS;

// ── Supabase ────────────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── IV Rank ─────────────────────────────────────────────

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

// ── Candle + Signal Data ────────────────────────────────

interface TickerData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

const candleCache = new Map<string, TickerData>();

async function fetchTickerData(ticker: string): Promise<TickerData> {
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

function generateSignalsForPreset(
  td: TickerData, presetKey: SignalPresetKey, periodStart: string, periodEnd: string,
): EntrySignal[] {
  const techOptions = SIGNAL_PRESETS[presetKey];
  const { signals } = precomputeSignals(td.candles, '1D', techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    if (sig.date < periodStart || sig.date > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 70) continue;

    const idx = td.dateToIdx.get(sig.date);
    entries.push({
      ticker: td.ticker,
      date: sig.date,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
    });
  }

  return entries;
}

// ── Sweep Grid ──────────────────────────────────────────

function buildSweepCandidates(): SimConfig[] {
  const candidates: SimConfig[] = [];

  const presets: SignalPresetKey[] = ['ema', 'mom'];
  const dteRanges: [number, number][] = [[7, 14]];
  const spreadWidths = [2.5, 5, 7.5, 10];
  const profitTargets = [0.40, 0.50, 0.65];
  const stopLosses = [100, 2, 3];
  const shortDeltas = [0.30, 0.35, 0.40, 0.45];
  const ivRankMins = [30, 40];
  const timeStopDTEs = [1, 2];

  for (const preset of presets) {
    for (const dteRange of dteRanges) {
      for (const width of spreadWidths) {
        for (const tp of profitTargets) {
          for (const sl of stopLosses) {
            for (const delta of shortDeltas) {
              for (const ivMin of ivRankMins) {
                for (const tsdte of timeStopDTEs) {
                  candidates.push({
                    ...DEFAULT_SHORT_CREDIT_CONFIG,
                    creditDTERange: dteRange,
                    creditSpreadWidth: width,
                    creditProfitTarget: tp,
                    creditStopLossMultiple: sl,
                    creditShortDelta: delta,
                    minIVRank: ivMin,
                    creditTimeStopDTE: tsdte,
                    fillMode: FILL_MODE,
                    slippage: FILL_MODE === 'bidask'
                      ? { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true }
                      : { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
                    signalWeightPreset: preset,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return candidates;
}

// ── Worker Pool ─────────────────────────────────────────

interface WorkItem {
  id: number;
  configIdx: number;
  config: SimConfig;
  trainStart: string;
  trainEnd: string;
  maxDate: string;
}

interface WorkResult {
  type: 'result';
  id: number;
  configIdx: number;
  sharpe: number;
  trades: number;
  winRate: number;
  totalPnl: number;
  maxDD: number;
  tradeData?: any[];
}

async function createWorkerPool(
  signalsByPreset: Record<string, EntrySignal[]>,
  allTradingDates: string[],
  numWorkers: number,
): Promise<Worker[]> {
  // Bundle the worker
  const workerSrc = path.resolve(__dirname, 'wfa-short-worker.ts');
  const workerBundle = path.resolve(__dirname, '.wfa-short-worker.mjs');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );

  const workers = await Promise.all(
    Array.from({ length: numWorkers }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(workerBundle, {
          workerData: { signalsByPreset, allTradingDates, fillMode: FILL_MODE },
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

async function runParallelWork(
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
          `\r    [${label}] ${completed}/${workItems.length} (${pct}%) | ${elapsed}s | ${rate} items/s   `,
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

// ── Reporting ───────────────────────────────────────────

function formatPct(v: number, decimals = 1): string {
  return v.toFixed(decimals) + '%';
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('WFA Engine — Short-DTE Credit Spread Validation (Phase 0)');
  console.log(`Workers: ${NUM_WORKERS} threads (${os.cpus().length} CPU cores)`);
  console.log('-'.repeat(60));

  // 1. Initialize chain cache (just for stats, workers open their own)
  initDB();
  const stats = getCacheStats();
  console.log(`Chain cache: ${stats.totalRows.toLocaleString()} rows, ${stats.totalDates} dates, ${stats.tickers.length} tickers`);
  closeDB();

  // 2. Fetch candle data
  console.log(`\nFetching candle data for ${tickers.length} tickers...`);
  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of tickers) {
    const td = await fetchTickerData(ticker);
    tickerDataMap.set(ticker, td);
    process.stdout.write(` ${ticker}(${td.candles.length})`);
  }
  console.log(' done.');

  // 3. Build trading dates
  const allDatesSet = new Set<string>();
  for (const td of tickerDataMap.values()) {
    for (const c of td.candles) {
      if (c.date >= WFA_START && c.date <= WFA_END) allDatesSet.add(c.date);
    }
  }
  const allTradingDates = [...allDatesSet].sort();
  console.log(`Trading dates: ${allTradingDates.length} (${allTradingDates[0]} -> ${allTradingDates[allTradingDates.length - 1]})`);

  // 4. Pre-compute signals per preset
  console.log('\nGenerating signals per preset...');
  const signalsByPreset: Record<string, EntrySignal[]> = {};
  const presetKeys: SignalPresetKey[] = ['ema', 'mom'];

  for (const preset of presetKeys) {
    const allSignals: EntrySignal[] = [];
    for (const [, td] of tickerDataMap) {
      const entries = generateSignalsForPreset(td, preset, WFA_START, WFA_END);
      allSignals.push(...entries);
    }
    allSignals.sort((a, b) => a.date.localeCompare(b.date));
    signalsByPreset[preset] = allSignals;
    console.log(`  ${preset}: ${allSignals.length} signals`);
  }

  // 5. Build sweep candidates
  const candidates = buildSweepCandidates();
  console.log(`\nSweep candidates: ${candidates.length} configs`);

  // 6. Build WFA windows
  const windowDefs = buildWFAWindows(allTradingDates, {
    trainWindowDays: TRAIN_DAYS,
    forwardStepDays: STEP_DAYS,
    purgeGapDays: PURGE_DAYS,
    mode: WFA_MODE,
    startDate: WFA_START,
    endDate: WFA_END,
  });
  console.log(`WFA windows: ${windowDefs.length} (${WFA_MODE})`);
  for (const w of windowDefs) {
    console.log(`  Train ${w.trainStart}->${w.trainEnd} | OOS ${w.oosStart}->${w.oosEnd}`);
  }

  // 7. Create worker pool
  console.log(`\nInitializing ${NUM_WORKERS} workers...`);
  const workers = await createWorkerPool(signalsByPreset, allTradingDates, NUM_WORKERS);
  console.log('Workers ready.');

  // 8. Run WFA: for each window, evaluate all configs on training data
  interface WFAWindowResult {
    window: WindowDef;
    bestConfigIdx: number;
    bestConfig: SimConfig;
    bestTrainSharpe: number;
    oosTrades: any[];
    oosSharpe: number;
    oosWinRate: number;
    oosMaxDD: number;
    oosTotalPnl: number;
  }

  const wfaResults: WFAWindowResult[] = [];
  const allOOSTrades: any[] = [];

  for (let wi = 0; wi < windowDefs.length; wi++) {
    const w = windowDefs[wi];
    console.log(`\n  Window ${wi + 1}/${windowDefs.length}: Train ${w.trainStart}->${w.trainEnd}`);

    // Build train work items (all configs for this window)
    const trainItems: WorkItem[] = candidates.map((config, ci) => ({
      id: ci,
      configIdx: ci,
      config,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      maxDate: w.trainEnd,  // train: don't let trades leak past train end
    }));

    const trainResults = await runParallelWork(workers, trainItems, `W${wi + 1}-Train`);

    // Pick best config by Sharpe
    let bestIdx = 0;
    let bestSharpe = -Infinity;
    for (let i = 0; i < trainResults.length; i++) {
      if (trainResults[i].sharpe > bestSharpe) {
        bestSharpe = trainResults[i].sharpe;
        bestIdx = i;
      }
    }

    console.log(`    Best train: config #${bestIdx} (Sharpe ${bestSharpe.toFixed(2)}, ${trainResults[bestIdx].trades} trades)`);

    // Run OOS with best config
    const oosItem: WorkItem = {
      id: 0,
      configIdx: bestIdx,
      config: candidates[bestIdx],
      trainStart: w.oosStart,
      trainEnd: w.oosEnd,
      maxDate: WFA_END,  // OOS: allow positions to close after window
    };

    const oosResults = await runParallelWork(workers, [oosItem], `W${wi + 1}-OOS`);
    const oos = oosResults[0];

    console.log(`    OOS: Sharpe ${oos.sharpe.toFixed(2)}, WR ${oos.winRate.toFixed(1)}%, ${oos.trades} trades, P&L $${oos.totalPnl.toFixed(0)}`);

    wfaResults.push({
      window: w,
      bestConfigIdx: bestIdx,
      bestConfig: candidates[bestIdx],
      bestTrainSharpe: bestSharpe,
      oosTrades: oos.tradeData ?? [],
      oosSharpe: oos.sharpe,
      oosWinRate: oos.winRate,
      oosMaxDD: oos.maxDD,
      oosTotalPnl: oos.totalPnl,
    });

    if (oos.tradeData) allOOSTrades.push(...oos.tradeData);
  }

  // 9. Terminate workers
  await terminatePool(workers);

  // 10. Aggregate results
  const totalElapsed = Date.now() - t0;
  const oosTotalPnl = wfaResults.reduce((s, w) => s + w.oosTotalPnl, 0);
  const avgTrainSharpe = wfaResults.reduce((s, w) => s + w.bestTrainSharpe, 0) / wfaResults.length;

  // Compute aggregate OOS analytics
  const aggAnalytics = computeOptionAnalytics(allOOSTrades as OptionTrade[]);

  // WF efficiency
  const wfEfficiency = avgTrainSharpe > 0 ? aggAnalytics.sharpe / avgTrainSharpe : 0;

  // Print report
  console.log('\n' + '='.repeat(80));
  console.log('  SHORT-DTE WALK-FORWARD ANALYSIS RESULTS');
  console.log('='.repeat(80));

  console.log(`\n  Mode: ${WFA_MODE.toUpperCase()}`);
  console.log(`  Period: ${WFA_START} -> ${WFA_END}`);
  console.log(`  Train: ${TRAIN_DAYS}d | Step: ${STEP_DAYS}d | Purge: ${PURGE_DAYS}d`);
  console.log(`  Tickers: ${tickers.join(', ')}`);
  console.log(`  Capital: $${STARTING_CAPITAL.toLocaleString()}`);
  console.log(`  Fill mode: ${FILL_MODE}`);
  console.log(`  Workers: ${NUM_WORKERS}`);
  console.log(`  Elapsed: ${(totalElapsed / 1000).toFixed(1)}s`);

  console.log('\n' + '-'.repeat(80));
  console.log('  AGGREGATE OOS METRICS');
  console.log('-'.repeat(80));
  console.log(`  Sharpe:       ${aggAnalytics.sharpe.toFixed(2)}`);
  console.log(`  Win Rate:     ${formatPct(aggAnalytics.winRate)}`);
  console.log(`  Max DD:       ${formatPct(aggAnalytics.maxDrawdown)}`);
  console.log(`  Total P&L:    $${oosTotalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`  ROC:          ${formatPct(oosTotalPnl / STARTING_CAPITAL * 100)}`);
  console.log(`  WF Efficiency: ${wfEfficiency.toFixed(2)}`);
  console.log(`  OOS Trades:   ${allOOSTrades.length}`);

  if (allOOSTrades.length > 0) {
    const avgHold = allOOSTrades.reduce((s: number, t: any) => s + t.holdDays, 0) / allOOSTrades.length;
    const avgDTE = allOOSTrades.reduce((s: number, t: any) => s + t.entryDTE, 0) / allOOSTrades.length;
    console.log(`  Avg Hold Days: ${avgHold.toFixed(1)}`);
    console.log(`  Avg Entry DTE: ${avgDTE.toFixed(1)}`);
  }

  // Decision gate
  console.log('\n' + '-'.repeat(80));
  console.log('  DECISION GATE');
  console.log('-'.repeat(80));
  if (aggAnalytics.sharpe < 0.5) {
    console.log('  ** FAIL: OOS Sharpe < 0.5 — short-DTE strategy does NOT work at daily granularity **');
  } else if (aggAnalytics.sharpe < 1.0) {
    console.log(`  MARGINAL: OOS Sharpe = ${aggAnalytics.sharpe.toFixed(2)} — promising but needs tuning`);
  } else {
    console.log(`  PASS: OOS Sharpe = ${aggAnalytics.sharpe.toFixed(2)} — proceed to Phase 1`);
  }
  if (allOOSTrades.length < 50) {
    console.log(`  WARNING: Only ${allOOSTrades.length} OOS trades — may have data gaps for short DTE chains`);
  }

  // Per-window breakdown
  console.log('\n' + '-'.repeat(80));
  console.log('  PER-WINDOW BREAKDOWN');
  console.log('-'.repeat(80));
  console.log('  #  Train Period          OOS Period            Train    OOS     OOS    OOS   Best Config');
  console.log('     Start    -> End       Start    -> End        Sharpe   Sharpe  WR%    Trd   (preset/d/tp/w/iv/sl)');
  console.log('  ' + '.'.repeat(78));

  for (let i = 0; i < wfaResults.length; i++) {
    const wr = wfaResults[i];
    const cfg = wr.bestConfig;
    const slStr = cfg.creditStopLossMultiple >= 100 ? 'noSL' : `sl${cfg.creditStopLossMultiple}x`;
    const configStr = `${cfg.signalWeightPreset ?? 'ema'}/d${cfg.creditShortDelta}/tp${(cfg.creditProfitTarget * 100).toFixed(0)}/w${cfg.creditSpreadWidth}/iv${cfg.minIVRank}/${slStr}`;
    console.log(
      `  ${String(i).padStart(2)}  ${wr.window.trainStart} -> ${wr.window.trainEnd}  ${wr.window.oosStart} -> ${wr.window.oosEnd}` +
      `  ${wr.bestTrainSharpe.toFixed(2).padStart(6)}  ${wr.oosSharpe.toFixed(2).padStart(6)}` +
      `  ${formatPct(wr.oosWinRate).padStart(5)}  ${String(wr.oosTrades.length).padStart(4)}   ${configStr}`,
    );
  }

  // Exit type breakdown
  if (allOOSTrades.length > 0) {
    const byExit: Record<string, number> = {};
    for (const t of allOOSTrades) {
      byExit[t.exitType] = (byExit[t.exitType] ?? 0) + 1;
    }
    console.log('\n' + '-'.repeat(80));
    console.log('  EXIT TYPE BREAKDOWN');
    console.log('-'.repeat(80));
    for (const [type, count] of Object.entries(byExit).sort((a, b) => (b as number) - (a as number))) {
      console.log(`  ${type.padEnd(20)} ${count} (${formatPct((count as number) / allOOSTrades.length * 100)})`);
    }
  }

  // Save JSON
  const outDir = path.resolve(__dirname, '../data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const exportResult = {
    _meta: {
      strategy: 'SHORT_DTE_CREDIT_SPREAD',
      dteRanges: [[7, 14]],
      spreadWidths: [2.5, 5, 7.5, 10],
      shortDeltas: [0.30, 0.35, 0.40, 0.45],
      profitTargets: [0.40, 0.50, 0.65],
      stopLosses: ['none', '2x', '3x'],
      elapsed: totalElapsed,
      workers: NUM_WORKERS,
    },
    oosSharpe: aggAnalytics.sharpe,
    oosWinRate: aggAnalytics.winRate,
    oosMaxDD: aggAnalytics.maxDrawdown,
    oosTotalPnl: oosTotalPnl,
    wfEfficiency,
    totalOOSTrades: allOOSTrades.length,
    windows: wfaResults.map(wr => ({
      trainStart: wr.window.trainStart,
      trainEnd: wr.window.trainEnd,
      oosStart: wr.window.oosStart,
      oosEnd: wr.window.oosEnd,
      bestTrainSharpe: wr.bestTrainSharpe,
      bestConfig: {
        preset: wr.bestConfig.signalWeightPreset,
        delta: wr.bestConfig.creditShortDelta,
        tp: wr.bestConfig.creditProfitTarget,
        width: wr.bestConfig.creditSpreadWidth,
        ivMin: wr.bestConfig.minIVRank,
        sl: wr.bestConfig.creditStopLossMultiple,
        tsdte: wr.bestConfig.creditTimeStopDTE,
      },
      oosSharpe: wr.oosSharpe,
      oosWinRate: wr.oosWinRate,
      oosMaxDD: wr.oosMaxDD,
      oosTrades: wr.oosTrades,
    })),
    allOOSTrades,
  };

  const outPath = path.resolve(outDir, 'wfa-results-short.json');
  fs.writeFileSync(outPath, JSON.stringify(exportResult, null, 2));
  console.log(`\nResults saved to ${outPath}`);

  console.log('\n' + '='.repeat(80) + '\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
