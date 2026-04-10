/**
 * Generate DTE5 Baseline — One-time script
 *
 * Runs the validated DTE5 champion config (EMA55 gate, QQQ bull, SL 2.5x, TL 50/50)
 * through WFA and saves the OOS daily returns to dte5-baseline.json.
 *
 * These returns are used by runner.ts to compute combined portfolio Sharpe
 * when evaluating new strategies.
 *
 * Usage: npx tsx scripts/autoresearch/generate-baseline.ts
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
import { DEFAULT_DYNAMIC_SLIPPAGE } from '../../src/lib/backtest/types';
import { computeIVRankMinMax } from '../../src/lib/backtest/iv-rank';
import {
  DEFAULT_CREDIT_CONFIG,
  computeOptionAnalytics,
  type EntrySignal, type SimConfig,
} from '../../src/lib/backtest/option-sim';
import {
  buildWFAWindows,
  computePortfolioDailyMetrics,
} from '../../src/lib/backtest/wfa-options';
import type { DTE5Baseline, WindowDef, WorkItem, WorkResult, WindowResult } from './types';

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const PARAMS = {
  dataStart: '2017-01-01',
  startDate: '2018-01-01',
  endDate: '2026-02-28',
  trainWindowDays: 252,
  forwardStepDays: 126,
  purgeGapDays: 10,
  holdoutCount: 2,
  startingCapital: 10_000,
};

// ── Helpers (adapted from wfa-dte5-tp-sl-study.ts) ──────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

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

// ── Data Loading ────────────────────────────────────────

async function loadQQQData() {
  console.log('Loading QQQ candles...');
  const rows = await supabaseGet('stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.QQQ&timeframe=eq.1D&date=gte.${PARAMS.dataStart}&date=lte.${PARAMS.endDate}&order=date.asc&limit=10000`);
  const candles: BacktestCandle[] = rows.map((r: any) => ({
    date: r.date, timestamp: new Date(r.date).getTime(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0,
  }));
  console.log(`  ${candles.length} candles loaded.`);

  const ivRows = await supabaseGet('orats_iv_cache',
    `select=date,iv30d,iv60d,hv20d&ticker=eq.QQQ&date=gte.${PARAMS.dataStart}&date=lte.${PARAMS.endDate}&order=date.asc&limit=5000`);
  const ivByDate = new Map<string, { iv30: number | null; iv60: number | null; hv20: number | null }>();
  for (const r of ivRows) {
    ivByDate.set(r.date, { iv30: r.iv30d, iv60: r.iv60d ?? null, hv20: r.hv20d ?? null });
  }
  const ivSeries = candles.map(c => ivByDate.get(c.date)?.iv30 ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);

  const closes = candles.map(c => c.close);
  const ema55 = computeEMASeries(closes, 55);

  return { candles, ivRanks, ema55, ivByDate };
}

// ── Signal Generation ───────────────────────────────────

function generateDTE5BullSignals(
  candles: BacktestCandle[],
  ema55: number[],
  ivRanks: (number | null)[],
): EntrySignal[] {
  const signals: EntrySignal[] = [];
  for (let i = 55; i < candles.length; i++) {
    const c = candles[i];
    if (c.date < PARAMS.startDate || c.date > PARAMS.endDate) continue;
    // Bull: close > EMA55
    if (c.close > ema55[i]) {
      signals.push({
        ticker: 'QQQ',
        date: c.date,
        direction: 'CALL',
        score: 50,
        ivRank: ivRanks[i] ?? undefined,
        configuredDelta: 0.30,
        configuredLongDelta: 0.20,
      });
    }
  }
  return signals;
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log('=== DTE5 Baseline Generator ===\n');

  const { candles, ivRanks, ema55 } = await loadQQQData();

  // Generate signals
  const signals = generateDTE5BullSignals(candles, ema55, ivRanks);
  console.log(`${signals.length} DTE5 bull signals generated.\n`);

  // Build trading dates
  const allTradingDates = candles.map(c => c.date);

  // Build WFA windows
  const allWindows = buildWFAWindows(allTradingDates, {
    trainWindowDays: PARAMS.trainWindowDays,
    forwardStepDays: PARAMS.forwardStepDays,
    purgeGapDays: PARAMS.purgeGapDays,
    mode: 'rolling',
    startDate: PARAMS.startDate,
    endDate: PARAMS.endDate,
  });
  const selectionWindows = allWindows.slice(0, -PARAMS.holdoutCount);
  const holdoutWindows = allWindows.slice(-PARAMS.holdoutCount);
  console.log(`WFA: ${selectionWindows.length} selection + ${holdoutWindows.length} holdout windows.\n`);

  // Build DTE5 champion config
  const simConfig: SimConfig = {
    ...DEFAULT_CREDIT_CONFIG,
    creditShortDelta: 0.30,
    creditSpreadWidth: 10,
    creditDTERange: [2, 7] as [number, number],
    creditProfitTarget: 1.0,
    creditStopLossMultiple: 2.5,
    creditTimeStopDTE: 0,
    trailingActivatePct: 0.50,
    trailingFloorPct: 0.50,
    minIVRank: 0,
    fillMode: 'mid',
    slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
    missingChainExitAfterDays: 3,
  };

  // Bundle and spawn worker
  const workerSrc = path.resolve(__dirname, 'worker.ts');
  const workerBundle = path.resolve(__dirname, '.autoresearch-worker.mjs');
  console.log('Bundling worker...');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '../..'), stdio: 'pipe' },
  );

  const workerInitData = {
    signals,
    allTradingDates,
    executionConfig: { maxPositions: 1, maxPerTicker: 1, startingCapital: PARAMS.startingCapital },
    startingCapital: PARAMS.startingCapital,
    evaluatorMode: 'standard' as const,
  };

  const worker = await new Promise<Worker>((resolve, reject) => {
    const w = new Worker(workerBundle, { workerData: workerInitData });
    w.once('message', (msg) => {
      if (msg?.type === 'ready') resolve(w);
      else reject(new Error('Worker failed to initialize'));
    });
    w.once('error', reject);
  });
  console.log('Worker ready.\n');

  // Evaluate
  const result = await new Promise<WorkResult>((resolve, reject) => {
    worker.on('message', (msg: WorkResult) => {
      if (msg.type === 'result') resolve(msg);
    });
    worker.on('error', reject);
    worker.postMessage({
      type: 'eval',
      id: 0,
      simConfig,
      selectionWindows,
      holdoutWindows,
    } satisfies WorkItem);
  });

  // Terminate worker
  worker.postMessage({ type: 'exit' });
  await new Promise(r => setTimeout(r, 100));
  await worker.terminate();

  if (result.error) {
    console.error('Worker error:', result.error);
    process.exit(1);
  }

  // Compute OOS metrics
  const selectionStart = selectionWindows[0]?.oosStart ?? PARAMS.startDate;
  const selectionEnd = selectionWindows[selectionWindows.length - 1]?.oosEnd ?? PARAMS.endDate;

  const oosMetrics = computePortfolioDailyMetrics(
    result.allOOSTrades, allTradingDates, selectionStart, selectionEnd, PARAMS.startingCapital,
  );
  const oosAnalytics = computeOptionAnalytics(result.allOOSTrades);

  console.log('DTE5 OOS Results:');
  console.log(`  Sharpe: ${oosMetrics.sharpe.toFixed(3)}`);
  console.log(`  MaxDD: ${oosMetrics.maxDrawdownPct.toFixed(1)}%`);
  console.log(`  Win Rate: ${oosAnalytics.winRate.toFixed(1)}%`);
  console.log(`  Trades: ${result.allOOSTrades.length}`);
  console.log(`  Equity curve points: ${oosMetrics.equityCurve.length}`);

  // Save baseline
  const baseline: DTE5Baseline = {
    dates: oosMetrics.equityCurve.map(e => e.date),
    dailyReturns: oosMetrics.dailyReturns,
    equityCurve: oosMetrics.equityCurve,
    oosSharpe: oosMetrics.sharpe,
  };

  const outPath = path.resolve(__dirname, 'dte5-baseline.json');
  fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2));
  console.log(`\nBaseline saved to: ${outPath}`);
  console.log(`  ${baseline.dates.length} dates, ${baseline.dailyReturns.length} returns`);
}

main().catch(err => { console.error(err); process.exit(1); });
