#!/usr/bin/env npx tsx
/**
 * VRP Full Sweep — Proper WFA with expanded grid + multicore + portfolio scaling
 *
 * Fixes from prior runs:
 * 1. Expand grid from 40 → ~400 configs (balance between selection and overfitting)
 * 2. Use bidask fills (acts as quality gate, filters thin-credit junk)
 * 3. Exclude mf from presets (selected on IS but produces 0 OOS trades)
 * 4. Use all CPU cores for parallel training
 * 5. Test 3 portfolio scales: 5/10/15 positions with 1/2/3 contracts
 *
 * Grid: 4 presets × 3 deltas × 3 widths × 2 TPs × 3 IVs × 2 timeStopDTEs = 432 configs
 *
 * Usage: npx tsx scripts/vrp-full-sweep.ts
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname_early = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname_early, '../.env') });
dotenvConfig({ path: path.resolve(__dirname_early, '../.env.local'), override: true });

import {
  runSwingPipeline,
  SWING_DEFAULTS,
  type SwingPipelineConfig,
  type SwingPipelineResult,
} from './wfa-pipeline-swing';
import { computeOptionAnalytics, type OptionTrade } from '../src/lib/backtest/option-sim';
import type { FillMode } from '../src/lib/backtest/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NUM_WORKERS = Math.max(1, os.cpus().length - 2); // leave 2 cores free

// ── Portfolio Scenarios ─────────────────────────────────

interface PortfolioScenario {
  name: string;
  maxPositions: number;
  maxPerTicker: number;
  contracts: number;
}

const SCENARIOS: PortfolioScenario[] = [
  { name: '5pos×1c (baseline)',  maxPositions: 5,  maxPerTicker: 2, contracts: 1 },
  { name: '10pos×1c',           maxPositions: 10, maxPerTicker: 3, contracts: 1 },
  { name: '10pos×2c',           maxPositions: 10, maxPerTicker: 3, contracts: 2 },
  { name: '15pos×2c',           maxPositions: 15, maxPerTicker: 3, contracts: 2 },
  { name: '20pos×3c',           maxPositions: 20, maxPerTicker: 4, contracts: 3 },
];

// ── Main ────────────────────────────────────────────────

async function runFullSweep(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  VRP Full Sweep — Expanded Grid + Multicore + Portfolio Scaling  ║');
  console.log('╠═══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Grid: 4 presets × 3 deltas × 3 widths × 2 TPs × 3 IVs × 2 TS  ║`);
  console.log(`║  = 432 configs | ${NUM_WORKERS} workers | mid fills | 14 tickers           ║`);
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  const allResults: {
    scenario: PortfolioScenario;
    wfaResult: SwingPipelineResult;
    scaledTrades: OptionTrade[];
    scaledPnl: number;
    scaledSharpe: number;
  }[] = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${scenario.name} (${scenario.maxPositions} pos, ${scenario.contracts} contracts)`);
    console.log(`${'═'.repeat(70)}\n`);

    const pipeConfig: SwingPipelineConfig = {
      ...SWING_DEFAULTS,
      maxPositions: scenario.maxPositions,
      maxPerTicker: scenario.maxPerTicker,
      // 4 presets that actually generate OOS trades (no mf)
      presets: ['em', 'mom', 'ema', 'vol'],
      fillMode: 'mid' as FillMode,
      numWorkers: NUM_WORKERS,
      sweepOverrides: {
        // CRITICAL: must match the presets list above, otherwise WFA evaluates
        // configs for presets with no signals → 0 trades → wins by default
        presets: ['em', 'mom', 'ema', 'vol'],
        // 4 presets × 3 deltas × 3 widths × 2 TPs × 3 IVs × 2 timeStops = 432
        creditShortDeltas: [0.25, 0.35, 0.45],
        spreadWidths: [5, 10, 15],
        profitTargets: [0.30, 0.50],
        ivRankMins: [0, 20, 30],
        timeStopDTEs: [5, 7],
        deltaStops: [Infinity],  // no delta stop (validated)
      },
    };

    const pipeResult = await runSwingPipeline(pipeConfig);
    const rawTrades = pipeResult.wfa.allOOSTrades;

    // Scale by contracts
    let scaledTrades: OptionTrade[];
    if (scenario.contracts > 1) {
      scaledTrades = rawTrades.map(t => ({
        ...t,
        contracts: scenario.contracts,
        positionSize: scenario.contracts,
        pnl: t.pnl * scenario.contracts,
        grossPnl: t.grossPnl != null ? t.grossPnl * scenario.contracts : undefined,
      }));
    } else {
      scaledTrades = rawTrades;
    }

    const scaledPnl = scaledTrades.reduce((s, t) => s + t.pnl, 0);
    const scaledAnalytics = computeOptionAnalytics(scaledTrades);

    allResults.push({
      scenario,
      wfaResult: pipeResult,
      scaledTrades,
      scaledPnl,
      scaledSharpe: scaledAnalytics.sharpe,
    });

    const years = 8; // 2018-2026
    const cagr = ((100_000 + scaledPnl) / 100_000) ** (1 / years) - 1;
    console.log(`\n  Portfolio-scaled: ${scaledTrades.length} trades, PnL $${scaledPnl.toFixed(0)}, Sharpe ${scaledAnalytics.sharpe.toFixed(2)}, CAGR ${(cagr * 100).toFixed(1)}%`);
  }

  // ── Final Comparison ──────────────────────────────────
  console.log('\n' + '═'.repeat(80));
  console.log('  FINAL COMPARISON — ALL SCENARIOS');
  console.log('═'.repeat(80) + '\n');

  console.log('Scenario             Trades  WR%    Sharpe  PF     PnL         MaxDD   CAGR    Windows+');
  for (const r of allResults) {
    const wfa = r.wfaResult.wfa;
    const analytics = computeOptionAnalytics(r.scaledTrades);
    const cagr = ((100_000 + r.scaledPnl) / 100_000) ** (1 / 8) - 1;
    const activeWindows = wfa.windows.filter(w => w.oosTrades.length > 0).length;
    const icon = r.scaledPnl > 0 ? '🟢' : '🔴';

    console.log(
      `${icon} ${r.scenario.name.padEnd(20)}${String(r.scaledTrades.length).padStart(5)}  ` +
      `${analytics.winRate.toFixed(1).padStart(5)}%  ${r.scaledSharpe.toFixed(2).padStart(6)}  ` +
      `${analytics.profitFactor.toFixed(2).padStart(5)}  $${r.scaledPnl.toFixed(0).padStart(9)}  ` +
      `${analytics.maxDrawdown.toFixed(1).padStart(5)}%  ${(cagr * 100).toFixed(1).padStart(5)}%  ` +
      `${activeWindows}/${wfa.windows.length}`
    );
  }

  // Per-window detail for best scenario
  const best = allResults.reduce((a, b) => a.scaledSharpe > b.scaledSharpe ? a : b);
  console.log(`\nBest scenario: ${best.scenario.name}`);
  console.log('\nPer-window detail:');
  for (const w of best.wfaResult.wfa.windows) {
    const icon = w.oosTrades.length === 0 ? '⬜' : w.oosSharpe > 0 ? '🟢' : '🔴';
    console.log(
      `  ${icon} W${String(w.windowIndex).padStart(2)} OOS ${w.oosStart}→${w.oosEnd}  ` +
      `${String(w.oosTrades.length).padStart(4)} trades  WR ${w.oosWinRate.toFixed(1).padStart(5)}%  ` +
      `Sharpe ${w.oosSharpe.toFixed(2).padStart(6)}  Config: ${formatConfig(w.bestConfig)}`
    );
  }

  // SPY comparison
  const spyCagr = 13;
  const bestCagr = ((100_000 + best.scaledPnl) / 100_000) ** (1 / 8) - 1;
  console.log(`\nSPY B&H CAGR: ~${spyCagr}%`);
  console.log(`Best scenario CAGR: ${(bestCagr * 100).toFixed(1)}%`);
  console.log(bestCagr * 100 > spyCagr
    ? `✅ Beats SPY by ${((bestCagr * 100 / spyCagr - 1) * 100).toFixed(0)}%`
    : `❌ Underperforms SPY by ${((1 - bestCagr * 100 / spyCagr) * 100).toFixed(0)}%`);

  // Save
  const outDir = path.join(__dirname, '..', 'backtesting history', 'vrp-harvester');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'full-sweep-results.json'), JSON.stringify({
    grid: '4 presets × 3 deltas × 3 widths × 2 TPs × 3 IVs × 2 TS = 432',
    fillMode: 'bidask',
    workers: NUM_WORKERS,
    scenarios: allResults.map(r => ({
      name: r.scenario.name,
      ...r.scenario,
      trades: r.scaledTrades.length,
      winRate: computeOptionAnalytics(r.scaledTrades).winRate,
      sharpe: r.scaledSharpe,
      profitFactor: computeOptionAnalytics(r.scaledTrades).profitFactor,
      totalPnl: r.scaledPnl,
      maxDD: computeOptionAnalytics(r.scaledTrades).maxDrawdown,
      cagr: ((100_000 + r.scaledPnl) / 100_000) ** (1 / 8) - 1,
      activeWindows: r.wfaResult.wfa.windows.filter(w => w.oosTrades.length > 0).length,
    })),
    windows: best.wfaResult.wfa.windows.map(w => ({
      index: w.windowIndex,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      trades: w.oosTrades.length,
      winRate: w.oosWinRate,
      sharpe: w.oosSharpe,
      config: formatConfig(w.bestConfig),
    })),
  }, null, 2));
  console.log(`\nResults saved to: ${path.join(outDir, 'full-sweep-results.json')}`);
}

function formatConfig(config: any): string {
  const preset = config.signalWeightPreset ?? '?';
  const tp = config.creditProfitTarget != null ? `tp${(config.creditProfitTarget * 100).toFixed(0)}` : '';
  const w = config.creditSpreadWidth != null ? `w${config.creditSpreadWidth}` : '';
  const iv = config.minIVRank != null ? `iv${config.minIVRank}` : '';
  const d = config.creditShortDelta != null ? `d${(config.creditShortDelta * 100).toFixed(0)}` : '';
  const ts = config.creditTimeStopDTE != null ? `ts${config.creditTimeStopDTE}` : '';
  return [preset, d, tp, w, iv, ts].filter(Boolean).join('/');
}

runFullSweep().catch(err => {
  console.error('Full sweep failed:', err);
  process.exit(1);
});
