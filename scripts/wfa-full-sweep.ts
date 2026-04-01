/**
 * WFA Full Config Sweep — Comprehensive parameter optimization for short-term credit spreads.
 *
 * Sweeps 7 dimensions (2,916 configs) across rolling WFA windows with IS/OOS/holdout.
 * Uses 130M candle data (2020-2026) + ORATS chain cache.
 *
 * Usage:
 *   npx tsx scripts/wfa-full-sweep.ts
 *   npx tsx scripts/wfa-full-sweep.ts --tickers SPY,QQQ
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { Worker } from 'node:worker_threads';
import { execSync } from 'child_process';

const __dirname_early = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname_early, '../.env') });
dotenvConfig({ path: path.resolve(__dirname_early, '../.env.local'), override: true });

import { SIGNAL_PRESETS } from '../src/lib/backtest/types';
import {
  precomputeSignals4H,
  type IVDataRow,
} from '../src/lib/backtest/intraday-signals';
import {
  DEFAULT_SHORT_CREDIT_CONFIG,
  type EntrySignal, type SimConfig,
  type SignalPresetKey,
} from '../src/lib/backtest/option-sim';
import type { FillMode } from '../src/lib/backtest/types';
import { DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import { computeIVRankMinMax, IV_RANK_METHOD_MIN_MAX_252D } from '../src/lib/backtest/iv-rank';
import {
  buildWFAWindows,
  type PortfolioExecutionConfig,
} from '../src/lib/backtest/wfa-options';
import { initIntradayDB, get130MCandles, aggregateToDaily, type IntradayCandle } from '../src/lib/backtest/intraday-cache';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────

const DEFAULT_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
  'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
  'META', 'NFLX', 'GOOG', 'GS',
];

const SWEEP_PARAMS = {
  dataStart: '2019-06-01',
  startDate: '2020-01-01',
  endDate: '2026-02-28',
  trainWindowDays: 189,
  forwardStepDays: 42,
  purgeGapDays: 14,
  mode: 'rolling' as const,
  maxPositions: 10,
  maxPerTicker: 5,
  startingCapital: 100_000,
  holdoutCount: 2,
};

// ── Sweep Dimensions ────────────────────────────────────

const PRESETS: SignalPresetKey[] = ['ema', 'mom', 'em', 'vol', 'full', 'mf'];
const PERIOD_MULTIPLIERS = [2.25, 3.0, 3.75];
const PROFIT_TARGETS = [0.30, 0.40, 0.50];
const SPREAD_WIDTHS = [2.5, 5, 10];
const IV_RANK_MINS = [0, 20, 40];
const SHORT_DELTAS = [0.25, 0.35, 0.45];
const TIME_STOP_DTES = [1, 3];
const SHORT_COMMISSION_PER_LEG = 0.65;
const SHORT_EXECUTION_LABEL = 'bidask_combo_plus_commission';

interface SweepConfig {
  label: string;
  config: SimConfig;
  signalKey: string;
  preset: SignalPresetKey;
  pm: number;
}

function signalMapKey(pm: number, preset: SignalPresetKey): string {
  return `${pm}|${preset}`;
}

function buildSweepConfigs(): SweepConfig[] {
  const configs: SweepConfig[] = [];

  for (const preset of PRESETS) {
    for (const pm of PERIOD_MULTIPLIERS) {
      for (const tp of PROFIT_TARGETS) {
        for (const width of SPREAD_WIDTHS) {
          for (const ivMin of IV_RANK_MINS) {
            for (const delta of SHORT_DELTAS) {
              for (const tsdte of TIME_STOP_DTES) {
                const label = `${preset}|tp${Math.round(tp * 100)}|w${width}|iv${ivMin}|d${Math.round(delta * 100)}|ts${tsdte}|pm${pm}`;
                configs.push({
                  label,
                  preset,
                  pm,
                  signalKey: signalMapKey(pm, preset),
                  config: {
                    ...DEFAULT_SHORT_CREDIT_CONFIG,
                    creditDTERange: [7, 21] as [number, number],
                    creditShortDelta: delta,
                    creditSpreadWidth: width,
                    creditProfitTarget: tp,
                    creditStopLossMultiple: 100,
                    creditTimeStopDTE: tsdte,
                    minIVRank: ivMin,
                    signalWeightPreset: preset,
                    indicatorPeriodMultiplier: pm,
                    bsmKappa: 4.0,
                    bsmRiskFreeRate: 0.04,
                    dailyCalibration: true,
                    ivThetaSource: 'hv60' as const,
                    fillMode: 'bidask' as FillMode,
                    slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true, executionStyle: 'combo' },
                    commissionPerLeg: SHORT_COMMISSION_PER_LEG,
                  },
                });
              }
            }
          }
        }
      }
    }
  }

  return configs;
}

// ── Parse args ──────────────────────────────────────────

const args = process.argv.slice(2);
function parseArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx + 1 >= args.length) return null;
  const val = args[idx + 1];
  return val.startsWith('--') ? null : val;
}

const tickerArg = parseArg('--tickers');
const tickers = tickerArg ? tickerArg.split(',').map(t => t.toUpperCase()) : DEFAULT_TICKERS;

// ── Supabase helper ──────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY!, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  return res.json();
}

// ── Data Fetching ────────────────────────────────────────

interface TickerData {
  ticker: string;
  candles130m: IntradayCandle[];
  dailyCandles: IntradayCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
  ivData: IVDataRow[];
}

async function fetchTickerData(ticker: string, intradayDb: any): Promise<TickerData> {
  const candles130m = get130MCandles(intradayDb, ticker, SWEEP_PARAMS.dataStart, SWEEP_PARAMS.endDate);
  const dailyCandles = aggregateToDaily(candles130m);

  const ivDbRows = await supabaseGet(
    'orats_iv_cache',
    `select=date,iv30d,iv60d,hv20d,hv30d,hv60d&ticker=eq.${ticker}&date=gte.${SWEEP_PARAMS.dataStart}&date=lte.${SWEEP_PARAMS.endDate}&order=date.asc&limit=5000`,
  );
  const ivData: IVDataRow[] = ivDbRows.map((r: any) => ({
    date: r.date as string,
    iv30d: r.iv30d as number | null,
    iv60d: r.iv60d as number | null,
    hv20d: r.hv20d as number | null,
    hv30d: r.hv30d as number | null,
    hv60d: r.hv60d as number | null,
  }));

  const ivByDate = new Map(ivData.map(r => [r.date, r.iv30d]));
  const ivSeries = dailyCandles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);
  const dateToIdx = new Map(dailyCandles.map((c, i) => [c.date, i]));

  return { ticker, candles130m, dailyCandles, ivRanks, dateToIdx, ivData };
}

function generateSignals(
  td: TickerData,
  preset: SignalPresetKey,
  periodMultiplier: number,
): EntrySignal[] {
  const techOptions = SIGNAL_PRESETS[preset];
  const signals = precomputeSignals4H(td.candles130m, td.ivData, periodMultiplier, techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    const barDate = sig.date.split('T')[0].split(' ')[0];
    if (barDate < SWEEP_PARAMS.startDate || barDate > SWEEP_PARAMS.endDate) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 65) continue;
    if (sig.adx !== undefined && sig.adx < 8) continue;

    const idx = td.dateToIdx.get(barDate);
    entries.push({
      ticker: td.ticker,
      date: barDate,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
      hv60: td.ivData.find(r => r.date === barDate)?.hv60d ?? undefined,
    });
  }

  // Deduplicate
  const deduped = new Map<string, EntrySignal>();
  for (const entry of entries) {
    const key = `${entry.ticker}|${entry.date}|${entry.direction}`;
    if (!deduped.has(key) || entry.score > deduped.get(key)!.score) {
      deduped.set(key, entry);
    }
  }
  return [...deduped.values()];
}

// ── Overfitting Grade ────────────────────────────────────

function computeGrade(
  windowResults: Array<{ oosSharpe: number; trainSharpe: number; oosTradeCount: number }>,
  minTrades: number,
  aggregateOOSSharpe: number,
): { grade: string; passCount: number } {
  if (windowResults.length === 0) return { grade: 'F', passCount: 0 };

  const avgISS = windowResults.reduce((s, w) => s + w.trainSharpe, 0) / windowResults.length;
  const avgOOSS = windowResults.reduce((s, w) => s + w.oosSharpe, 0) / windowResults.length;
  const oosStdDev = Math.sqrt(windowResults.reduce((s, w) => s + (w.oosSharpe - avgOOSS) ** 2, 0) / windowResults.length);
  const allPositive = windowResults.every(w => w.oosTradeCount > 0 && w.oosSharpe > 0);
  const totalTrades = windowResults.reduce((s, w) => s + w.oosTradeCount, 0);

  const checks = [
    avgISS > 0 && avgOOSS / avgISS >= 0.40,
    oosStdDev < 1.0,
    allPositive,
    totalTrades >= minTrades,
    avgISS < 5,
    aggregateOOSSharpe > 0.5,
  ];

  const passCount = checks.filter(Boolean).length;
  const grade = passCount === 6 ? 'A' : passCount === 5 ? 'B' : passCount === 4 ? 'C' : passCount >= 3 ? 'D' : 'F';
  return { grade, passCount };
}

// ── Main ─────────────────────────────────────────────────

interface SweepResult {
  configLabel: string;
  preset: string;
  pm: number;
  isSharpe: number;
  rankingMetric: 'net_oos_sharpe';
  oosSharpe: number;
  oosNetSharpe: number;
  oosGrossSharpe: number;
  holdoutSharpe: number;
  holdoutNetSharpe: number;
  holdoutGrossSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  oosNetTotalPnl: number;
  oosGrossTotalPnl: number;
  holdoutTotalPnl: number;
  holdoutNetTotalPnl: number;
  holdoutGrossTotalPnl: number;
  wfEfficiency: number;
  grade: string;
  tradeCount: number;
  exitTypeBreakdown: Record<string, number>;
  ivRankMethod: string;
  executionModel: string;
}

async function main() {
  const startTime = Date.now();
  const sweepConfigs = buildSweepConfigs();

  console.log('WFA Full Config Sweep');
  console.log('═'.repeat(60));
  console.log(`Tickers: ${tickers.join(', ')}`);
  console.log(`Configs: ${sweepConfigs.length}`);
  console.log(`CPUs: ${os.cpus().length}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log();

  // Fetch 130M data
  console.log('Fetching 130M candle data...');
  const intradayDb = initIntradayDB();
  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of tickers) {
    const td = await fetchTickerData(ticker, intradayDb);
    tickerDataMap.set(ticker, td);
    process.stdout.write(` ${ticker}(${td.candles130m.length})`);
  }
  console.log(' done.');

  // Build trading dates
  const allDatesSet = new Set<string>();
  for (const [, td] of tickerDataMap) {
    for (const c of td.dailyCandles) {
      if (c.date >= SWEEP_PARAMS.startDate && c.date <= SWEEP_PARAMS.endDate) allDatesSet.add(c.date);
    }
  }
  const allTradingDates = [...allDatesSet].sort();
  console.log(`Trading dates: ${allTradingDates.length}`);

  // Pre-compute all signal sets (6 presets × 3 PMs = 18 sets)
  console.log('\nPre-computing signal sets...');
  const signalSets: Record<string, EntrySignal[]> = {};
  for (const preset of PRESETS) {
    for (const pm of PERIOD_MULTIPLIERS) {
      const key = signalMapKey(pm, preset);
      const signals: EntrySignal[] = [];
      for (const [, td] of tickerDataMap) {
        signals.push(...generateSignals(td, preset, pm));
      }
      signals.sort((a, b) => a.date.localeCompare(b.date));
      signalSets[key] = signals;
      process.stdout.write(`  ${key}: ${signals.length} signals\n`);
    }
  }

  // Build WFA windows
  const allWindows = buildWFAWindows(allTradingDates, {
    trainWindowDays: SWEEP_PARAMS.trainWindowDays,
    forwardStepDays: SWEEP_PARAMS.forwardStepDays,
    purgeGapDays: SWEEP_PARAMS.purgeGapDays,
    mode: SWEEP_PARAMS.mode,
    startDate: SWEEP_PARAMS.startDate,
    endDate: SWEEP_PARAMS.endDate,
  });

  const selectionWindows = allWindows.slice(0, -SWEEP_PARAMS.holdoutCount);
  const holdoutWindows = allWindows.slice(-SWEEP_PARAMS.holdoutCount);
  console.log(`\nWFA windows: ${allWindows.length} total (${selectionWindows.length} selection + ${holdoutWindows.length} holdout)`);
  for (const w of allWindows.slice(0, 5)) {
    console.log(`  Train ${w.trainStart}→${w.trainEnd} | OOS ${w.oosStart}→${w.oosEnd}`);
  }
  if (allWindows.length > 5) console.log(`  ... (${allWindows.length - 5} more)`);

  const executionConfig: PortfolioExecutionConfig = {
    maxPositions: SWEEP_PARAMS.maxPositions,
    maxPerTicker: SWEEP_PARAMS.maxPerTicker,
    startingCapital: SWEEP_PARAMS.startingCapital,
  };

  // Build worker pool
  const numWorkers = Math.max(1, os.cpus().length - 2);
  console.log(`\nSpawning ${numWorkers} workers...`);

  const workerSrc = path.resolve(__dirname, 'wfa-sweep-worker.ts');
  const workerBundle = path.resolve(__dirname, '.wfa-sweep-worker.mjs');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );

  // Prepare worker init data
  // Workers use EOD chain data (no candles needed — chain cache handles everything)
  const workerInitData = {
    signalSets,
    allTradingDates,
    executionConfig,
    startingCapital: SWEEP_PARAMS.startingCapital,
    startDate: SWEEP_PARAMS.startDate,
    endDate: SWEEP_PARAMS.endDate,
  };

  const workers = await Promise.all(
    Array.from({ length: numWorkers }, () =>
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
  console.log(`${numWorkers} workers ready.`);

  // Dispatch all configs to workers
  interface WorkerResult {
    id: number;
    configLabel: string;
    selectionResults: Array<{
      windowIdx: number; trainSharpe: number; oosSharpe: number;
      oosWR: number; oosMaxDD: number; oosTradeCount: number;
    }>;
    oosSharpe: number;
    oosGrossSharpe: number;
    oosMaxDD: number;
    oosWinRate: number;
    oosTotalPnl: number;
    oosGrossTotalPnl: number;
    oosTradeCount: number;
    oosExitTypes: Record<string, number>;
    holdoutSharpe: number;
    holdoutGrossSharpe: number;
    holdoutMaxDD: number;
    holdoutTotalPnl: number;
    holdoutGrossTotalPnl: number;
    holdoutTradeCount: number;
    error?: string;
  }

  const workItems = sweepConfigs.map((sc, idx) => ({
    type: 'eval' as const,
    id: idx,
    configLabel: sc.label,
    config: sc.config,
    signalKey: sc.signalKey,
    selectionWindows,
    holdoutWindows,
  }));

  const workerResults: WorkerResult[] = new Array(workItems.length);
  let nextIdx = 0;
  let completed = 0;

  console.log(`\nEvaluating ${sweepConfigs.length} configs...`);

  await new Promise<void>((resolve, reject) => {
    const onMessage = (worker: Worker) => (msg: any) => {
      if (!msg || msg.type !== 'result') return;
      workerResults[msg.id] = msg;
      completed++;
      if (completed % 50 === 0 || completed === workItems.length) {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const rate = (completed / ((Date.now() - startTime) / 1000)).toFixed(1);
        const eta = ((workItems.length - completed) / parseFloat(rate) / 60).toFixed(1);
        process.stdout.write(`\r  ${completed}/${workItems.length} configs (${elapsed}m elapsed, ${rate}/s, ETA ${eta}m)`);
      }

      if (completed === workItems.length) {
        process.stdout.write('\n');
        resolve();
        return;
      }
      const next = workItems[nextIdx++];
      if (next) worker.postMessage(next);
    };

    for (const worker of workers) {
      worker.on('message', onMessage(worker));
      worker.on('error', reject);
    }

    for (const worker of workers) {
      const next = workItems[nextIdx++];
      if (!next) break;
      worker.postMessage(next);
    }
  });

  // Terminate workers
  for (const w of workers) w.postMessage({ type: 'exit' });
  await new Promise(r => setTimeout(r, 100));
  await Promise.all(workers.map(w => w.terminate()));
  console.log('Workers terminated.');

  // Process results
  const results: SweepResult[] = [];
  let errors = 0;
  for (let ci = 0; ci < sweepConfigs.length; ci++) {
    const sc = sweepConfigs[ci];
    const wr = workerResults[ci];
    if (!wr || wr.error) { errors++; continue; }

    const avgTrainSharpe = wr.selectionResults.length > 0
      ? wr.selectionResults.reduce((s, w) => s + w.trainSharpe, 0) / wr.selectionResults.length : 0;
    const wfEfficiency = avgTrainSharpe >= 0.1 ? wr.oosSharpe / avgTrainSharpe : 0;

    const { grade } = computeGrade(wr.selectionResults, 50, wr.oosSharpe);

    results.push({
      configLabel: sc.label,
      preset: sc.preset,
      pm: sc.pm,
      isSharpe: avgTrainSharpe,
      rankingMetric: 'net_oos_sharpe',
      oosSharpe: wr.oosSharpe,
      oosNetSharpe: wr.oosSharpe,
      oosGrossSharpe: wr.oosGrossSharpe,
      holdoutSharpe: wr.holdoutSharpe,
      holdoutNetSharpe: wr.holdoutSharpe,
      holdoutGrossSharpe: wr.holdoutGrossSharpe,
      oosWinRate: wr.oosWinRate,
      oosMaxDD: wr.oosMaxDD,
      oosTotalPnl: wr.oosTotalPnl,
      oosNetTotalPnl: wr.oosTotalPnl,
      oosGrossTotalPnl: wr.oosGrossTotalPnl,
      holdoutTotalPnl: wr.holdoutTotalPnl,
      holdoutNetTotalPnl: wr.holdoutTotalPnl,
      holdoutGrossTotalPnl: wr.holdoutGrossTotalPnl,
      wfEfficiency,
      grade,
      tradeCount: wr.oosTradeCount,
      exitTypeBreakdown: wr.oosExitTypes,
      ivRankMethod: IV_RANK_METHOD_MIN_MAX_252D,
      executionModel: SHORT_EXECUTION_LABEL,
    });
  }

  // Sort by OOS Sharpe
  results.sort((a, b) => b.oosSharpe - a.oosSharpe);

  // Print results
  console.log(`\n${'═'.repeat(110)}`);
  console.log('  SHORT-TERM FULL SWEEP RESULTS');
  console.log(`${'═'.repeat(110)}`);
  console.log(`  ${results.length} configs evaluated (${errors} errors)\n`);
  console.log(`  Ranking metric: net OOS Sharpe (${SHORT_EXECUTION_LABEL}, $${SHORT_COMMISSION_PER_LEG.toFixed(2)}/leg, IV rank ${IV_RANK_METHOD_MIN_MAX_252D})\n`);

  // Top 30
  console.log('  TOP 30 CONFIGS (by OOS Sharpe)');
  console.log(`  ${'─'.repeat(106)}`);
  console.log('  Rank  Label                                           IS Sharpe  OOS(Net)    Hold(Net)    WR%   MaxDD  Trades  Grade');
  console.log(`  ${'─'.repeat(106)}`);
  for (let i = 0; i < Math.min(30, results.length); i++) {
    const r = results[i];
    const marker = r.grade === 'A' ? ' ◄' : '';
    console.log(
      `  ${String(i + 1).padStart(4)}  ${r.configLabel.padEnd(50)} ${r.isSharpe.toFixed(2).padStart(9)}  ${r.oosSharpe.toFixed(2).padStart(10)}  ${r.holdoutSharpe.toFixed(2).padStart(8)}  ${r.oosWinRate.toFixed(1).padStart(5)}%  ${r.oosMaxDD.toFixed(1).padStart(5)}%  ${String(r.tradeCount).padStart(6)}  ${r.grade.padStart(5)}${marker}`,
    );
  }

  // Grade A only
  const gradeA = results.filter(r => r.grade === 'A');
  const gradeAB = results.filter(r => r.grade === 'A' || r.grade === 'B');
  console.log(`\n  Grade Distribution: A=${gradeA.length}, A+B=${gradeAB.length}, Total=${results.length}`);

  // Per-preset best
  console.log(`\n  ${'─'.repeat(106)}`);
  console.log('  PER-PRESET BEST');
  console.log(`  ${'─'.repeat(106)}`);
  for (const preset of PRESETS) {
    const best = results.filter(r => r.preset === preset).sort((a, b) => b.oosSharpe - a.oosSharpe)[0];
    if (best) {
      console.log(`  ${preset.padEnd(8)} Best: ${best.configLabel.padEnd(50)} OOS ${best.oosSharpe.toFixed(2)} | Holdout ${best.holdoutSharpe.toFixed(2)} | WR ${best.oosWinRate.toFixed(1)}% | Grade ${best.grade}`);
    }
  }

  // Save results
  const reportDir = path.resolve('backtesting history/credit-spread/reports/full-sweep');
  fs.mkdirSync(reportDir, { recursive: true });

  fs.writeFileSync(
    path.join(reportDir, 'sweep-results.json'),
    JSON.stringify(results, null, 2),
  );

  // Build README
  const totalMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const top10 = results.slice(0, 10);
  const readmeLines = [
    '# Short-Term Credit Spread — Full Config Sweep',
    '',
    `Generated: ${new Date().toISOString().split('T')[0]}`,
    '',
    '## Study Parameters',
    `- **Date range**: ${SWEEP_PARAMS.startDate} → ${SWEEP_PARAMS.endDate}`,
    `- **Tickers**: ${tickers.join(', ')}`,
    `- **Configs swept**: ${sweepConfigs.length}`,
    `- **WFA windows**: ${allWindows.length} (${selectionWindows.length} selection + ${holdoutWindows.length} holdout)`,
    `- **Runtime**: ${totalMinutes} minutes`,
    `- **Ranking metric**: Net OOS Sharpe`,
    `- **Execution model**: ${SHORT_EXECUTION_LABEL}`,
    `- **Commission**: $${SHORT_COMMISSION_PER_LEG.toFixed(2)} per leg per side`,
    `- **IV rank method**: ${IV_RANK_METHOD_MIN_MAX_252D}`,
    '',
    '## Sweep Dimensions',
    `| Dimension | Values |`,
    `|-----------|--------|`,
    `| Signal preset | ${PRESETS.join(', ')} |`,
    `| Period multiplier | ${PERIOD_MULTIPLIERS.join(', ')} |`,
    `| Profit target | ${PROFIT_TARGETS.map(t => (t * 100) + '%').join(', ')} |`,
    `| Spread width | ${SPREAD_WIDTHS.map(w => '$' + w).join(', ')} |`,
    `| IV rank min | ${IV_RANK_MINS.join(', ')} |`,
    `| Short delta | ${SHORT_DELTAS.join(', ')} |`,
    `| Time stop DTE | ${TIME_STOP_DTES.join(', ')} |`,
    '',
    '## Top 10 Results',
    '',
    '| Rank | Config | IS Sharpe | OOS Net | OOS Gross | Holdout Net | Holdout Gross | WR% | MaxDD | Trades | Grade |',
    '|------|--------|-----------|---------|-----------|-------------|---------------|-----|-------|--------|-------|',
    ...top10.map((r, i) =>
      `| ${i + 1} | ${r.configLabel} | ${r.isSharpe.toFixed(2)} | ${r.oosNetSharpe.toFixed(2)} | ${r.oosGrossSharpe.toFixed(2)} | ${r.holdoutNetSharpe.toFixed(2)} | ${r.holdoutGrossSharpe.toFixed(2)} | ${r.oosWinRate.toFixed(1)}% | ${r.oosMaxDD.toFixed(1)}% | ${r.tradeCount} | ${r.grade} |`
    ),
    '',
    `## Grade Distribution`,
    `- **A**: ${gradeA.length} configs`,
    `- **A+B**: ${gradeAB.length} configs`,
    `- **Total**: ${results.length} configs`,
    '',
    '## Methodology',
    '',
    '### Fixed Parameters',
    '- DTE: 7-21 days',
    '- Stop Loss: None (defined risk)',
    '- Delta Stop: Off',
    '- BSM Kappa: 4.0, Risk-free: 4%',
    '- Daily calibration: On',
    `- Fill mode: Bid/ask combo fills with dynamic slippage (${SHORT_EXECUTION_LABEL})`,
    `- Commission: $${SHORT_COMMISSION_PER_LEG.toFixed(2)} per leg per side`,
    `- IV Rank: ${IV_RANK_METHOD_MIN_MAX_252D}`,
    '',
    '### Overfitting Grade Rubric',
    '| Grade | Criteria |',
    '|-------|----------|',
    '| A | 6/6 checks pass |',
    '| B | 5/6 |',
    '| C | 4/6 |',
    '| D | 3/6 |',
    '| F | <3/6 |',
    '',
    'Checks: IS→OOS retention ≥40%, OOS Sharpe StdDev <1.0, all windows positive, sufficient trades, no extreme IS, OOS Sharpe >0.5',
  ];

  fs.writeFileSync(path.join(reportDir, 'README.md'), readmeLines.join('\n'));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Results saved to: ${reportDir}`);
  console.log(`Total time: ${totalMinutes} minutes`);
  console.log(`${'═'.repeat(60)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
