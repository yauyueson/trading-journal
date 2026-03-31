#!/usr/bin/env npx tsx
/**
 * Debit Spread WFA — Option B for swing trading
 *
 * Rationale: Credit spreads failed at swing DTE (-0.38 post-audit).
 * The directional signal (pb8/pb21) achieves Sharpe 0.70 on underlying.
 * Debit spreads provide leveraged directional exposure with defined risk.
 *
 * Key question: Does defined-risk leverage from debit spreads improve the
 * 0.70 underlying Sharpe, or does cost drag make it worse (like swing
 * long option at 0.30)?
 *
 * Grid: 1 preset × 3 DTE ranges × 3 long deltas × 3 short deltas ×
 *        2 profit targets × 2 exit EMAs × 2 hold days = 432 configs
 *        With pb8 + pb21: 864 total
 *
 * Uses existing infrastructure:
 * - wfa-pipeline-directional.ts (debit mode)
 * - chain-cache.ts (findDebitSpreadStrikes)
 * - debit-spread-exit.ts (exit logic)
 * - bidask fills + dynamic slippage + commission
 *
 * Usage: npx tsx scripts/vrp-debit-spread-wfa.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname_early = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname_early, '../.env') });
dotenvConfig({ path: path.resolve(__dirname_early, '../.env.local'), override: true });

import {
  runDirectionalPipeline,
  DIRECTIONAL_DEFAULTS,
  type DirectionalPipelineConfig,
  type DirectionalPipelineResult,
} from './wfa-pipeline-directional';
import { computeOptionAnalytics } from '../src/lib/backtest/option-sim';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA',
  'AMZN', 'MSFT', 'META', 'NFLX', 'GOOG', 'GS',
];

async function runDebitSpreadWFA(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Option B: Debit Spread WFA — Swing Directional Strategy   ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Leveraged directional with defined risk                    ║');
  console.log('║  14 tickers | pb signal | bidask fills | chain-based       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ── Run 1: Standard debit spread (30-45 DTE, trend-following) ──

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Run 1: Debit Spread — pb signal, full sweep');
  console.log('═══════════════════════════════════════════════════════\n');

  const debitConfig: DirectionalPipelineConfig = {
    ...DIRECTIONAL_DEFAULTS,
    strategy: 'debit',
    tickers: TICKERS,
    dataStart: '2017-01-01',
    startDate: '2018-01-01',
    endDate: '2026-02-28',
    trainWindowDays: 504,
    forwardStepDays: 126,
    purgeGapDays: 65,
    mode: 'rolling',
    maxPositions: 10,
    maxPerTicker: 2,
    startingCapital: 100_000,
    fixedNotional: 10_000,
    fillMode: 'bidask',
    presets: ['pb'],
    sweepOverrides: {
      presets: ['pb'],
      // 3 DTE ranges: short swing, mid swing, long swing
      debitDTERanges: [[21, 35], [30, 45], [45, 65]],
      // 3 long deltas: deep ITM to ATM
      debitLongDeltas: [0.50, 0.60, 0.70],
      // 3 short deltas: how far OTM the short leg is
      debitShortDeltas: [0.20, 0.30, 0.40],
      // 2 profit targets
      debitProfitTargets: [0.50, 0.75],
      // 2 exit EMAs (trend failure exit)
      debitExitEMAs: [21, 34],
      // Keep these fixed to reduce grid size
      debitExitConfirmDays: [2],
      debitExitRequireSlope: [true],
      debitMaxHoldDays: [15, 25],
      debitMinExitDTEs: [7, 14],
      // IV rank filter variants
      debitMaxIVRanks: [undefined, 55],
    },
  };

  const debitResult = await runDirectionalPipeline(debitConfig);

  if (debitResult.debit) {
    const wfa = debitResult.debit.wfa;
    const trades = wfa.allOOSTrades;
    const analytics = computeOptionAnalytics(trades);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const years = 8;
    const cagr = ((100_000 + totalPnl) / 100_000) ** (1 / years) - 1;

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  DEBIT SPREAD WFA RESULTS');
    console.log('══════════════════════════════════════════════════════════════\n');

    console.log(`Trades:         ${trades.length}`);
    console.log(`Win Rate:       ${analytics.winRate.toFixed(1)}%`);
    console.log(`Sharpe:         ${wfa.oosSharpe.toFixed(2)}`);
    console.log(`Total PnL:      $${totalPnl.toFixed(0)}`);
    console.log(`Max DD:         ${wfa.oosMaxDD.toFixed(1)}%`);
    console.log(`WF Efficiency:  ${wfa.wfEfficiency.toFixed(2)}`);
    console.log(`CAGR:           ${(cagr * 100).toFixed(1)}%`);

    console.log('\nPer-window:');
    for (const w of wfa.windows) {
      const wPnl = w.oosTrades.reduce((s, t) => s + t.pnl, 0);
      const icon = wPnl > 0 ? '🟢' : w.oosTrades.length === 0 ? '⬜' : '🔴';
      console.log(
        `  ${icon} W${String(w.windowIndex).padStart(2)} ` +
        `OOS ${w.oosStart}→${w.oosEnd}  ` +
        `${String(w.oosTrades.length).padStart(3)} trades  ` +
        `WR ${w.oosWinRate.toFixed(1).padStart(5)}%  ` +
        `Sharpe ${w.oosSharpe.toFixed(2).padStart(6)}  ` +
        `PnL $${wPnl.toFixed(0).padStart(7)}`
      );
    }

    // Exit types
    const exitCounts: Record<string, number> = {};
    for (const t of trades) {
      exitCounts[t.exitType] = (exitCounts[t.exitType] || 0) + 1;
    }
    console.log('\nExit types:');
    for (const [type, count] of Object.entries(exitCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type.padEnd(20)} ${count} (${(count / trades.length * 100).toFixed(1)}%)`);
    }

    // Gate check
    console.log('\n── Gate Check ────────────────────────────────────────\n');
    for (const check of debitResult.debit.gate.checks) {
      console.log(`${check.passed ? '✅' : '❌'} ${check.name}: ${check.actual} (target: ${check.target})`);
    }
    console.log(`\n${debitResult.debit.gate.passed ? '🟢 GATE PASSED' : '🔴 GATE FAILED'}`);

    // Comparison to underlying baseline
    console.log('\n── vs Underlying Baseline ────────────────────────────\n');
    console.log('Strategy           Sharpe  PnL        WR%    MaxDD   CAGR');
    console.log(`Underlying (pb)     0.70   $33,790    43.2%   6.8%   3.8%`);
    console.log(`Debit Spread        ${wfa.oosSharpe.toFixed(2).padStart(5)}   $${totalPnl.toFixed(0).padStart(7)}    ${analytics.winRate.toFixed(1).padStart(4)}%  ${wfa.oosMaxDD.toFixed(1).padStart(5)}%  ${(cagr * 100).toFixed(1).padStart(5)}%`);
    console.log(`130M Credit (ref)   2.00+  $70K+      82%+    1.5%   ~14%`);

    // Save
    const outDir = path.join(__dirname, '..', 'backtesting history', 'vrp-harvester');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'debit-spread-wfa-results.json'), JSON.stringify({
      config: debitConfig,
      summary: {
        trades: trades.length,
        winRate: analytics.winRate,
        sharpe: wfa.oosSharpe,
        totalPnl,
        maxDD: wfa.oosMaxDD,
        wfEfficiency: wfa.wfEfficiency,
        cagr: cagr * 100,
      },
      gate: debitResult.debit.gate,
      windows: wfa.windows.map(w => ({
        index: w.windowIndex,
        oosStart: w.oosStart,
        oosEnd: w.oosEnd,
        trades: w.oosTrades.length,
        winRate: w.oosWinRate,
        sharpe: w.oosSharpe,
        pnl: w.oosTrades.reduce((s, t) => s + t.pnl, 0),
      })),
      exitTypes: exitCounts,
    }, null, 2));
    console.log(`\nResults saved to: ${path.join(outDir, 'debit-spread-wfa-results.json')}`);
  } else {
    console.log('ERROR: No debit results returned from pipeline');
  }
}

// ── Run 2: Underlying baseline for comparison ──────────

async function runUnderlyingBaseline(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Run 2: Underlying Baseline — same universe, same WFA');
  console.log('═══════════════════════════════════════════════════════\n');

  const underlyingConfig: DirectionalPipelineConfig = {
    ...DIRECTIONAL_DEFAULTS,
    strategy: 'underlying',
    tickers: TICKERS,
    dataStart: '2017-01-01',
    startDate: '2018-01-01',
    endDate: '2026-02-28',
    trainWindowDays: 504,
    forwardStepDays: 126,
    purgeGapDays: 65,
    mode: 'rolling',
    maxPositions: 10,
    maxPerTicker: 2,
    startingCapital: 100_000,
    fixedNotional: 10_000,
    fillMode: 'bidask',
    presets: ['pb'],
  };

  const result = await runDirectionalPipeline(underlyingConfig);

  if (result.underlying) {
    const wfa = result.underlying.wfa;
    const totalPnl = wfa.oosTotalPnl;
    console.log(`\nUnderlying baseline: ${wfa.allOOSTrades.length} trades, Sharpe ${wfa.oosSharpe.toFixed(2)}, PnL $${totalPnl.toFixed(0)}, WR ${wfa.oosWinRate.toFixed(1)}%`);
  }
}

// ── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  await runDebitSpreadWFA();
  await runUnderlyingBaseline();
}

main().catch(err => {
  console.error('Debit spread WFA failed:', err);
  process.exit(1);
});
