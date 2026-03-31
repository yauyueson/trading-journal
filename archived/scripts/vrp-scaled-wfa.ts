#!/usr/bin/env npx tsx
/**
 * VRP Scaled WFA — WFA config selection + portfolio scaling
 *
 * Lesson from Phase 1: the signal + WFA config selection IS the edge.
 * A fixed config at any option structure loses money.
 *
 * This script runs the validated WFA pipeline and then applies VRP
 * portfolio management on top:
 *   - Scale from 5 to 10-15 concurrent positions
 *   - Risk-budget sizing (multiple contracts per trade)
 *   - Drawdown governor
 *   - Compare capital utilization and absolute return vs baseline
 *
 * Usage: npx tsx scripts/vrp-scaled-wfa.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname_early = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname_early, '../.env') });
dotenvConfig({ path: path.resolve(__dirname_early, '../.env.local'), override: true });

import { initDB, closeDB } from '../src/lib/backtest/chain-cache';
import {
  runSwingPipeline,
  SWING_DEFAULTS,
  type SwingPipelineConfig,
} from './wfa-pipeline-swing';
import { computeOptionAnalytics, type OptionTrade } from '../src/lib/backtest/option-sim';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Scenarios ───────────────────────────────────────────

interface Scenario {
  name: string;
  maxPositions: number;
  maxPerTicker: number;
  contracts: number;      // contracts per trade
  drawdownHaltPct: number;  // halt new entries when unrealized loss > this % of capital
  drawdownResumePct: number;
}

const SCENARIOS: Scenario[] = [
  // Baseline: match prior validated config
  { name: 'Baseline (5 pos, 1 contract)',
    maxPositions: 5, maxPerTicker: 2, contracts: 1,
    drawdownHaltPct: 1.0, drawdownResumePct: 0.0 },

  // Scale positions
  { name: 'Scale 10 pos, 1 contract',
    maxPositions: 10, maxPerTicker: 3, contracts: 1,
    drawdownHaltPct: 1.0, drawdownResumePct: 0.0 },

  { name: 'Scale 15 pos, 1 contract',
    maxPositions: 15, maxPerTicker: 3, contracts: 1,
    drawdownHaltPct: 1.0, drawdownResumePct: 0.0 },

  // Scale contracts (risk budget: $100K × 2% = $2K max loss, $15 width → 1 contract; $10 width → 2 contracts)
  { name: 'Scale 10 pos, 2 contracts',
    maxPositions: 10, maxPerTicker: 3, contracts: 2,
    drawdownHaltPct: 1.0, drawdownResumePct: 0.0 },

  { name: 'Scale 15 pos, 2 contracts',
    maxPositions: 15, maxPerTicker: 3, contracts: 2,
    drawdownHaltPct: 1.0, drawdownResumePct: 0.0 },

  // With drawdown governor
  { name: 'Scale 10 pos, 2c + DD halt 8%',
    maxPositions: 10, maxPerTicker: 3, contracts: 2,
    drawdownHaltPct: 0.08, drawdownResumePct: 0.05 },

  { name: 'Scale 15 pos, 2c + DD halt 8%',
    maxPositions: 15, maxPerTicker: 3, contracts: 2,
    drawdownHaltPct: 0.08, drawdownResumePct: 0.05 },

  // Aggressive
  { name: 'Scale 20 pos, 3 contracts',
    maxPositions: 20, maxPerTicker: 4, contracts: 3,
    drawdownHaltPct: 1.0, drawdownResumePct: 0.0 },
];

// ── Main ────────────────────────────────────────────────

async function runScaledWFA(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  VRP Scaled WFA — WFA Config Selection + Portfolio Scaling  ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  ${SCENARIOS.length} scenarios | EM+MOM+EMA presets | 14 tickers          ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const results: {
    name: string;
    trades: number;
    winRate: number;
    sharpe: number;
    profitFactor: number;
    totalPnl: number;
    maxDD: number;
    avgPnl: number;
    avgHoldDays: number;
    capitalUtilPct: number;
    cagr: number;
  }[] = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${scenario.name}`);
    console.log(`${'═'.repeat(60)}\n`);

    // Run WFA pipeline with this scenario's position limits
    const pipeConfig: SwingPipelineConfig = {
      ...SWING_DEFAULTS,
      maxPositions: scenario.maxPositions,
      maxPerTicker: scenario.maxPerTicker,
      presets: ['em', 'mom', 'ema'],
      numWorkers: 1, // single-threaded for consistency
      sweepOverrides: {
        profitTargets: [0.30, 0.50],
        spreadWidths: [10, 15],
        ivRankMins: [0, 30],
        deltaStops: [Infinity],       // no delta stop
        timeStopDTEs: [5],            // single time stop
        creditShortDeltas: [0.35],    // validated delta
      },
    };

    const pipeResult = await runSwingPipeline(pipeConfig);
    const rawTrades = pipeResult.wfa.allOOSTrades;

    // Apply contract scaling and drawdown governor
    const scaledTrades = applyPortfolioScaling(rawTrades, scenario, 100_000);

    const analytics = computeOptionAnalytics(scaledTrades);
    const totalPnl = scaledTrades.reduce((s, t) => s + t.pnl, 0);
    const years = (new Date('2026-02-28').getTime() - new Date('2018-01-01').getTime()) / (365.25 * 86_400_000);
    const cagr = 100_000 > 0 ? ((100_000 + totalPnl) / 100_000) ** (1 / years) - 1 : 0;

    // Estimate capital utilization
    const avgConcurrent = estimateAvgConcurrent(scaledTrades);
    const avgWidth = scaledTrades.length > 0
      ? scaledTrades.reduce((s, t) => s + (t.spreadWidth ?? 10), 0) / scaledTrades.length
      : 10;
    const capitalUtilPct = (avgConcurrent * avgWidth * 100 * scenario.contracts) / 100_000 * 100;

    results.push({
      name: scenario.name,
      trades: scaledTrades.length,
      winRate: analytics.winRate,
      sharpe: analytics.sharpe,
      profitFactor: analytics.profitFactor,
      totalPnl,
      maxDD: analytics.maxDrawdown,
      avgPnl: scaledTrades.length > 0 ? totalPnl / scaledTrades.length : 0,
      avgHoldDays: analytics.avgHoldDays,
      capitalUtilPct,
      cagr: cagr * 100,
    });

    console.log(`  Trades: ${scaledTrades.length} | WR: ${analytics.winRate.toFixed(1)}% | Sharpe: ${analytics.sharpe.toFixed(2)} | PnL: $${totalPnl.toFixed(0)} | CAGR: ${(cagr * 100).toFixed(1)}%`);
  }

  // Comparison table
  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log('  SCENARIO COMPARISON');
  console.log('══════════════════════════════════════════════════════════════════════════════\n');

  console.log('Scenario'.padEnd(38) + 'Trades  WR%    Sharpe  PF     PnL        MaxDD   CAGR    Util');
  for (const r of results) {
    const icon = r.totalPnl > 0 ? '🟢' : '🔴';
    console.log(
      `${icon} ${r.name.padEnd(36)}${String(r.trades).padStart(5)}  ` +
      `${r.winRate.toFixed(1).padStart(5)}%  ${r.sharpe.toFixed(2).padStart(6)}  ${r.profitFactor.toFixed(2).padStart(5)}  ` +
      `$${r.totalPnl.toFixed(0).padStart(8)}  ${r.maxDD.toFixed(1).padStart(5)}%  ` +
      `${r.cagr.toFixed(1).padStart(5)}%  ~${r.capitalUtilPct.toFixed(0)}%`
    );
  }

  // SPY benchmark
  // SPY 2018-2026 CAGR ≈ 12-14%
  const spyCagr = 13;
  console.log(`\nSPY B&H benchmark CAGR: ~${spyCagr}%`);
  const beaters = results.filter(r => r.cagr > spyCagr);
  if (beaters.length > 0) {
    console.log(`✅ ${beaters.length} scenarios beat SPY:`);
    for (const b of beaters) {
      console.log(`   ${b.name}: CAGR ${b.cagr.toFixed(1)}% (${((b.cagr / spyCagr - 1) * 100).toFixed(0)}% over SPY)`);
    }
  } else {
    console.log('❌ No scenarios beat SPY on CAGR');
  }

  // Save
  const outDir = path.join(__dirname, '..', 'backtesting history', 'vrp-harvester');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'scaled-wfa-results.json'), JSON.stringify({ results }, null, 2));
  console.log(`\nResults saved to: ${path.join(outDir, 'scaled-wfa-results.json')}`);
}

// ── Portfolio Scaling ───────────────────────────────────

function applyPortfolioScaling(
  trades: OptionTrade[],
  scenario: Scenario,
  startingCapital: number,
): OptionTrade[] {
  if (scenario.contracts <= 1 && scenario.drawdownHaltPct >= 1.0) {
    return trades; // No scaling needed
  }

  const scaled: OptionTrade[] = [];
  let cumulativePnl = 0;
  let halted = false;

  for (const trade of trades) {
    // Drawdown governor
    const currentLossPct = -cumulativePnl / startingCapital;
    if (currentLossPct > scenario.drawdownHaltPct) {
      halted = true;
    }
    if (halted) {
      if (currentLossPct > scenario.drawdownResumePct) continue;
      halted = false;
    }

    // Scale by contracts
    const scaledTrade = { ...trade };
    if (scenario.contracts > 1) {
      scaledTrade.contracts = scenario.contracts;
      scaledTrade.positionSize = scenario.contracts;
      scaledTrade.pnl = trade.pnl * scenario.contracts;
      if (scaledTrade.grossPnl != null) scaledTrade.grossPnl = trade.grossPnl! * scenario.contracts;
    }

    scaled.push(scaledTrade);
    cumulativePnl += scaledTrade.pnl;
  }

  return scaled;
}

function estimateAvgConcurrent(trades: { entryDate: string; exitDate: string }[]): number {
  if (trades.length === 0) return 0;
  const events: { date: string; delta: number }[] = [];
  for (const t of trades) {
    events.push({ date: t.entryDate, delta: 1 }, { date: t.exitDate, delta: -1 });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  let current = 0, sum = 0, count = 0, prev = '';
  for (const ev of events) {
    if (ev.date !== prev && prev !== '') { sum += current; count++; }
    current += ev.delta;
    prev = ev.date;
  }
  return count > 0 ? sum / count : 0;
}

runScaledWFA().catch(err => {
  console.error('Scaled WFA failed:', err);
  process.exit(1);
});
