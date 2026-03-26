/**
 * WFA SL Study on Sweep Winners — Tests SL mechanisms on top 5 configs from full sweep.
 *
 * Usage:
 *   npx tsx scripts/wfa-sl-on-sweep.ts
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
import { precomputeSignals4H, type IVDataRow } from '../src/lib/backtest/intraday-signals';
import {
  DEFAULT_SHORT_CREDIT_CONFIG,
  type EntrySignal, type SimConfig, type SignalPresetKey,
} from '../src/lib/backtest/option-sim';
import type { FillMode } from '../src/lib/backtest/types';
import { DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import { computeIVRankMinMax, IV_RANK_METHOD_MIN_MAX_252D } from '../src/lib/backtest/iv-rank';
import { buildWFAWindows, type PortfolioExecutionConfig } from '../src/lib/backtest/wfa-options';
import { initIntradayDB, get130MCandles, aggregateToDaily, type IntradayCandle } from '../src/lib/backtest/intraday-cache';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHORT_COMMISSION_PER_LEG = 0.65;
const SHORT_EXECUTION_LABEL = 'bidask_combo_plus_commission';

// ── Top 5 base configs from sweep ────────────────────────

interface BaseConfig {
  label: string;
  preset: SignalPresetKey;
  pm: number;
  config: SimConfig;
}

function makeBaseConfig(preset: SignalPresetKey, tp: number, width: number, delta: number, pm: number): SimConfig {
  return {
    ...DEFAULT_SHORT_CREDIT_CONFIG,
    creditDTERange: [7, 21] as [number, number],
    creditShortDelta: delta,
    creditSpreadWidth: width,
    creditProfitTarget: tp,
    creditStopLossMultiple: 100,
    creditTimeStopDTE: 1,
    minIVRank: 0,
    signalWeightPreset: preset,
    indicatorPeriodMultiplier: pm,
    fillMode: 'bidask' as FillMode,
    slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true, executionStyle: 'combo' },
    commissionPerLeg: SHORT_COMMISSION_PER_LEG,
  };
}

const TOP5: BaseConfig[] = [
  { label: 'vol|tp50|w2.5|d45|pm3',    preset: 'vol',  pm: 3,    config: makeBaseConfig('vol',  0.50, 2.5, 0.45, 3) },
  { label: 'full|tp50|w2.5|d45|pm3.75', preset: 'full', pm: 3.75, config: makeBaseConfig('full', 0.50, 2.5, 0.45, 3.75) },
  { label: 'vol|tp50|w2.5|d45|pm2.25',  preset: 'vol',  pm: 2.25, config: makeBaseConfig('vol',  0.50, 2.5, 0.45, 2.25) },
  { label: 'mf|tp50|w2.5|d45|pm3',     preset: 'mf',   pm: 3,    config: makeBaseConfig('mf',   0.50, 2.5, 0.45, 3) },
  { label: 'full|tp50|w2.5|d45|pm3',   preset: 'full',  pm: 3,    config: makeBaseConfig('full', 0.50, 2.5, 0.45, 3) },
];

// ── SL Variants ──────────────────────────────────────────

interface SLVariant {
  label: string;
  apply: (base: SimConfig) => SimConfig;
}

function buildSLVariants(): SLVariant[] {
  const variants: SLVariant[] = [];

  // Baseline (reference)
  variants.push({ label: 'baseline', apply: (b) => ({ ...b }) });

  // Best individual performers from previous run (reference)
  variants.push({ label: 'tl75-25', apply: (b) => ({ ...b, trailingActivatePct: 0.75, trailingFloorPct: 0.25 }) });
  variants.push({ label: 'tl50-50', apply: (b) => ({ ...b, trailingActivatePct: 0.50, trailingFloorPct: 0.50 }) });
  variants.push({ label: 'ml75', apply: (b) => ({ ...b, creditMaxLossStopPct: 0.75 }) });
  variants.push({ label: 'ml90', apply: (b) => ({ ...b, creditMaxLossStopPct: 0.90 }) });

  // ── Combos: Trailing Lock + Max Loss ──
  for (const [act, floor] of [[0.75, 0.25], [0.50, 0.50]] as [number, number][]) {
    for (const ml of [0.75, 0.90]) {
      variants.push({
        label: `tl${(act*100).toFixed(0)}-${(floor*100).toFixed(0)}+ml${(ml*100).toFixed(0)}`,
        apply: (b) => ({ ...b, trailingActivatePct: act, trailingFloorPct: floor, creditMaxLossStopPct: ml }),
      });
    }
  }

  // ── Combos: Trailing Lock + Delta Stop ──
  for (const [act, floor] of [[0.75, 0.25], [0.50, 0.50]] as [number, number][]) {
    for (const ds of [0.70, 0.75, 0.80]) {
      variants.push({
        label: `tl${(act*100).toFixed(0)}-${(floor*100).toFixed(0)}+ds${(ds*100).toFixed(0)}`,
        apply: (b) => ({ ...b, trailingActivatePct: act, trailingFloorPct: floor, creditDeltaStop: ds }),
      });
    }
  }

  // ── Combos: Max Loss + Delta Stop ──
  for (const ml of [0.75, 0.90]) {
    for (const ds of [0.70, 0.75, 0.80]) {
      variants.push({
        label: `ml${(ml*100).toFixed(0)}+ds${(ds*100).toFixed(0)}`,
        apply: (b) => ({ ...b, creditMaxLossStopPct: ml, creditDeltaStop: ds }),
      });
    }
  }

  // ── Triple combos: Trailing Lock + Max Loss + Delta Stop ──
  for (const [act, floor] of [[0.75, 0.25], [0.50, 0.50]] as [number, number][]) {
    for (const ml of [0.75, 0.90]) {
      for (const ds of [0.75, 0.80]) {
        variants.push({
          label: `tl${(act*100).toFixed(0)}-${(floor*100).toFixed(0)}+ml${(ml*100).toFixed(0)}+ds${(ds*100).toFixed(0)}`,
          apply: (b) => ({ ...b, trailingActivatePct: act, trailingFloorPct: floor, creditMaxLossStopPct: ml, creditDeltaStop: ds }),
        });
      }
    }
  }

  return variants;
}

// ── Params ───────────────────────────────────────────────

const DEFAULT_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA',
  'AMZN', 'MSFT', 'META', 'NFLX', 'GOOG', 'GS',
];

const PARAMS = {
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

// ── Helpers ──────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY!, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  return res.json();
}

function signalMapKey(pm: number, preset: SignalPresetKey): string {
  return `${pm}|${preset}`;
}

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

async function main() {
  const startTime = Date.now();
  const slVariants = buildSLVariants();
  const totalConfigs = TOP5.length * slVariants.length;

  console.log('WFA SL Study on Sweep Winners');
  console.log('═'.repeat(60));
  console.log(`Base configs: ${TOP5.length}`);
  console.log(`SL variants: ${slVariants.length}`);
  console.log(`Total: ${totalConfigs}`);
  console.log(`CPUs: ${os.cpus().length}`);
  console.log();

  // Fetch data
  console.log('Fetching 130M candle data...');
  const intradayDb = initIntradayDB();
  const tickerCandles130m: Record<string, IntradayCandle[]> = {};
  const allDatesSet = new Set<string>();

  for (const ticker of DEFAULT_TICKERS) {
    const candles130m = get130MCandles(intradayDb, ticker, PARAMS.dataStart, PARAMS.endDate);
    tickerCandles130m[ticker] = candles130m;
    const daily = aggregateToDaily(candles130m);
    for (const c of daily) {
      if (c.date >= PARAMS.startDate && c.date <= PARAMS.endDate) allDatesSet.add(c.date);
    }
    process.stdout.write(` ${ticker}(${candles130m.length})`);
  }
  console.log(' done.');

  const allTradingDates = [...allDatesSet].sort();
  console.log(`Trading dates: ${allTradingDates.length}`);

  // Pre-compute signal sets (only unique preset+PM combos from top 5)
  const uniqueKeys = new Set(TOP5.map(t => signalMapKey(t.pm, t.preset)));
  console.log(`\nPre-computing ${uniqueKeys.size} signal sets...`);
  const signalSets: Record<string, EntrySignal[]> = {};

  for (const base of TOP5) {
    const key = signalMapKey(base.pm, base.preset);
    if (signalSets[key]) continue;

    const signals: EntrySignal[] = [];
    for (const ticker of DEFAULT_TICKERS) {
      const candles = tickerCandles130m[ticker];
      const daily = aggregateToDaily(candles);

      const ivDbRows = await supabaseGet(
        'orats_iv_cache',
        `select=date,iv30d,iv60d,hv20d,hv30d,hv60d&ticker=eq.${ticker}&date=gte.${PARAMS.dataStart}&date=lte.${PARAMS.endDate}&order=date.asc&limit=5000`,
      );
      const ivData: IVDataRow[] = ivDbRows.map((r: any) => ({
        date: r.date, iv30d: r.iv30d, iv60d: r.iv60d,
        hv20d: r.hv20d, hv30d: r.hv30d, hv60d: r.hv60d,
      }));

      const ivByDate = new Map(ivData.map(r => [r.date, r.iv30d]));
      const ivSeries = daily.map(c => ivByDate.get(c.date) ?? null);
      const ivRanks = computeIVRankMinMax(ivSeries);
      const dateToIdx = new Map(daily.map((c, i) => [c.date, i]));

      const techOptions = SIGNAL_PRESETS[base.preset];
      const rawSignals = precomputeSignals4H(candles, ivData, base.pm, techOptions);

      for (const sig of rawSignals) {
        const barDate = sig.date.split('T')[0].split(' ')[0];
        if (barDate < PARAMS.startDate || barDate > PARAMS.endDate) continue;
        if (sig.type === 'NEUTRAL' || sig.score < 65) continue;
        if (sig.adx !== undefined && sig.adx < 8) continue;
        const idx = dateToIdx.get(barDate);
        signals.push({
          ticker, date: barDate,
          direction: sig.type as 'CALL' | 'PUT', score: sig.score,
          ivRank: idx != null ? (ivRanks[idx] ?? undefined) : undefined,
          hv60: ivData.find(r => r.date === barDate)?.hv60d ?? undefined,
        });
      }
    }

    // Deduplicate
    const deduped = new Map<string, EntrySignal>();
    for (const entry of signals) {
      const k = `${entry.ticker}|${entry.date}|${entry.direction}`;
      if (!deduped.has(k) || entry.score > deduped.get(k)!.score) deduped.set(k, entry);
    }
    signalSets[key] = [...deduped.values()].sort((a, b) => a.date.localeCompare(b.date));
    console.log(`  ${key}: ${signalSets[key].length} signals`);
  }

  // Build windows
  const allWindows = buildWFAWindows(allTradingDates, {
    trainWindowDays: PARAMS.trainWindowDays, forwardStepDays: PARAMS.forwardStepDays,
    purgeGapDays: PARAMS.purgeGapDays, mode: PARAMS.mode,
    startDate: PARAMS.startDate, endDate: PARAMS.endDate,
  });
  const selectionWindows = allWindows.slice(0, -PARAMS.holdoutCount);
  const holdoutWindows = allWindows.slice(-PARAMS.holdoutCount);
  console.log(`\nWFA windows: ${allWindows.length} (${selectionWindows.length} sel + ${holdoutWindows.length} holdout)`);

  const executionConfig: PortfolioExecutionConfig = {
    maxPositions: PARAMS.maxPositions, maxPerTicker: PARAMS.maxPerTicker, startingCapital: PARAMS.startingCapital,
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

  const workers = await Promise.all(
    Array.from({ length: numWorkers }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(workerBundle, {
          workerData: { signalSets, allTradingDates, executionConfig, startingCapital: PARAMS.startingCapital, startDate: PARAMS.startDate, endDate: PARAMS.endDate },
        });
        w.once('message', (msg) => msg?.type === 'ready' ? resolve(w) : reject(new Error('Worker init failed')));
        w.once('error', reject);
      }),
    ),
  );
  console.log(`${numWorkers} workers ready.`);

  // Build work items
  interface WorkItem {
    type: 'eval'; id: number; configLabel: string; config: SimConfig;
    signalKey: string; selectionWindows: typeof selectionWindows; holdoutWindows: typeof holdoutWindows;
  }

  const workItems: WorkItem[] = [];
  const configMeta: Array<{ baseLabel: string; slLabel: string }> = [];

  for (const base of TOP5) {
    for (const sl of slVariants) {
      const id = workItems.length;
      const label = `${base.label}+${sl.label}`;
      workItems.push({
        type: 'eval', id, configLabel: label,
        config: sl.apply(base.config),
        signalKey: signalMapKey(base.pm, base.preset),
        selectionWindows, holdoutWindows,
      });
      configMeta.push({ baseLabel: base.label, slLabel: sl.label });
    }
  }

  // Dispatch
  interface WorkerResult {
    id: number; configLabel: string;
    selectionResults: Array<{ windowIdx: number; trainSharpe: number; oosSharpe: number; oosWR: number; oosMaxDD: number; oosTradeCount: number }>;
    oosSharpe: number; oosGrossSharpe: number; oosMaxDD: number; oosWinRate: number; oosTotalPnl: number; oosGrossTotalPnl: number;
    oosTradeCount: number; oosExitTypes: Record<string, number>;
    holdoutSharpe: number; holdoutGrossSharpe: number; holdoutMaxDD: number; holdoutTotalPnl: number; holdoutGrossTotalPnl: number; holdoutTradeCount: number;
    error?: string;
  }

  const workerResults: WorkerResult[] = new Array(workItems.length);
  let nextIdx = 0, completed = 0;

  console.log(`\nEvaluating ${workItems.length} configs...`);

  await new Promise<void>((resolve, reject) => {
    const onMessage = (worker: Worker) => (msg: any) => {
      if (!msg || msg.type !== 'result') return;
      workerResults[msg.id] = msg;
      completed++;
      if (completed % 10 === 0 || completed === workItems.length) {
        process.stdout.write(`\r  ${completed}/${workItems.length} configs`);
      }
      if (completed === workItems.length) { process.stdout.write('\n'); resolve(); return; }
      const next = workItems[nextIdx++];
      if (next) worker.postMessage(next);
    };
    for (const w of workers) { w.on('message', onMessage(w)); w.on('error', reject); }
    for (const w of workers) { const next = workItems[nextIdx++]; if (next) w.postMessage(next); }
  });

  for (const w of workers) w.postMessage({ type: 'exit' });
  await new Promise(r => setTimeout(r, 100));
  await Promise.all(workers.map(w => w.terminate()));
  console.log('Workers terminated.');
  console.log(`Execution defaults: ${SHORT_EXECUTION_LABEL}, $${SHORT_COMMISSION_PER_LEG.toFixed(2)}/leg, IV rank ${IV_RANK_METHOD_MIN_MAX_252D}`);

  // Print results grouped by base config
  for (const base of TOP5) {
    console.log(`\n${'═'.repeat(100)}`);
    console.log(`  BASE: ${base.label}`);
    console.log(`${'═'.repeat(100)}`);
    console.log('  SL Variant          IS Sharpe  OOS Sharpe   Holdout     WR%   MaxDD  Trades  Grade');
    console.log(`  ${'─'.repeat(94)}`);

    const baseResults: Array<{ slLabel: string; isSharpe: number; oosSharpe: number; holdoutSharpe: number; oosWR: number; oosMaxDD: number; trades: number; grade: string }> = [];

    for (const sl of slVariants) {
      const idx = configMeta.findIndex(m => m.baseLabel === base.label && m.slLabel === sl.label);
      if (idx < 0) continue;
      const wr = workerResults[idx];
      if (!wr || wr.error) { console.log(`  ${sl.label.padEnd(20)} ERROR: ${wr?.error}`); continue; }

      const avgIS = wr.selectionResults.length > 0
        ? wr.selectionResults.reduce((s, w) => s + w.trainSharpe, 0) / wr.selectionResults.length : 0;
      const { grade } = computeGrade(wr.selectionResults, 50, wr.oosSharpe);

      baseResults.push({
        slLabel: sl.label, isSharpe: avgIS, oosSharpe: wr.oosSharpe,
        holdoutSharpe: wr.holdoutSharpe, oosWR: wr.oosWinRate,
        oosMaxDD: wr.oosMaxDD, trades: wr.oosTradeCount, grade,
      });
    }

    baseResults.sort((a, b) => b.oosSharpe - a.oosSharpe);
    for (const r of baseResults) {
      const marker = r.slLabel === 'baseline' ? ' ◄' : (r.oosSharpe > baseResults.find(x => x.slLabel === 'baseline')!.oosSharpe ? ' ★' : '');
      console.log(
        `  ${r.slLabel.padEnd(20)} ${r.isSharpe.toFixed(2).padStart(9)}  ${r.oosSharpe.toFixed(2).padStart(10)}  ${r.holdoutSharpe.toFixed(2).padStart(8)}  ${r.oosWR.toFixed(1).padStart(5)}%  ${r.oosMaxDD.toFixed(1).padStart(5)}%  ${String(r.trades).padStart(6)}  ${r.grade.padStart(5)}${marker}`,
      );
    }
  }

  // Save results
  const reportDir = path.resolve('backtesting history/credit-spread/reports/full-sweep');
  const allResults = workItems.map((wi, i) => {
    const wr = workerResults[i];
    if (!wr) return null;
    const avgIS = wr.selectionResults.length > 0
      ? wr.selectionResults.reduce((s, w) => s + w.trainSharpe, 0) / wr.selectionResults.length : 0;
    const { grade } = computeGrade(wr.selectionResults, 50, wr.oosSharpe);
    return {
      configLabel: wi.configLabel,
      baseConfig: configMeta[i].baseLabel,
      slVariant: configMeta[i].slLabel,
      rankingMetric: 'net_oos_sharpe',
      isSharpe: avgIS,
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
      grade,
      tradeCount: wr.oosTradeCount,
      exitTypes: wr.oosExitTypes,
      ivRankMethod: IV_RANK_METHOD_MIN_MAX_252D,
      executionModel: SHORT_EXECUTION_LABEL,
    };
  }).filter(Boolean);

  fs.writeFileSync(path.join(reportDir, 'sl-on-sweep-results.json'), JSON.stringify(allResults, null, 2));

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Done in ${totalMin} minutes. Results: ${reportDir}/sl-on-sweep-results.json`);
  console.log(`${'═'.repeat(60)}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
