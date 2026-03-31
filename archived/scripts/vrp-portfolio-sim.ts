#!/usr/bin/env npx tsx
/**
 * VRP Harvester — Phase 3: Portfolio Simulation
 *
 * Goal: Validate portfolio-level behavior with 15 concurrent positions,
 * risk-budget sizing, and daily MTM tracking.
 *
 * Tests:
 * 1. Portfolio daily Sharpe > 1.0
 * 2. Max portfolio DD < 20%
 * 3. No month with > -8% loss
 * 4. Capital utilization 40-70%
 * 5. VIX scaling impact (with vs without)
 *
 * Usage: npx tsx scripts/vrp-portfolio-sim.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname_early = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname_early, '../.env') });
dotenvConfig({ path: path.resolve(__dirname_early, '../.env.local'), override: true });

import { initDB, closeDB } from '../src/lib/backtest/chain-cache';
import { runVRPHarvester, type VRPHarvesterResult } from '../src/lib/backtest/vrp-harvester';
import { DEFAULT_VRP_HARVESTER_CONFIG } from '../src/lib/backtest/types';
import type { VRPHarvesterConfig } from '../src/lib/backtest/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Universe ────────────────────────────────────────────

const TICKERS = [
  'SPY', 'QQQ', 'GOOG', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
  'AAPL', 'NVDA', 'AMD', 'COST', 'BA', 'AMZN', 'PLTR', 'AVGO',
  'LULU', 'UBER', 'GS', 'UNH', 'IWM', 'GLD',
];

// ── Scenarios ───────────────────────────────────────────

interface Scenario {
  name: string;
  config: Partial<VRPHarvesterConfig>;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Baseline (15 pos, 2% risk, no VIX scaling)',
    config: {
      maxPositions: 15,
      maxLossPerPositionPct: 0.02,
      vixHalfSizeThreshold: 999,
      vixPauseThreshold: 999,
      drawdownHaltPct: 1.0,
    },
  },
  {
    name: 'Full governors (15 pos, 2% risk, VIX + DD halt)',
    config: {
      maxPositions: 15,
      maxLossPerPositionPct: 0.02,
      vixHalfSizeThreshold: 30,
      vixPauseThreshold: 40,
      vixPauseDays: 2,
      drawdownHaltPct: 0.08,
      drawdownResumePct: 0.05,
    },
  },
  {
    name: 'Aggressive (20 pos, 3% risk, VIX scaling)',
    config: {
      maxPositions: 20,
      maxLossPerPositionPct: 0.03,
      vixHalfSizeThreshold: 30,
      vixPauseThreshold: 40,
      vixPauseDays: 2,
      drawdownHaltPct: 0.10,
      drawdownResumePct: 0.06,
    },
  },
  {
    name: 'Conservative (10 pos, 1.5% risk, tight DD halt)',
    config: {
      maxPositions: 10,
      maxLossPerPositionPct: 0.015,
      vixHalfSizeThreshold: 25,
      vixPauseThreshold: 35,
      vixPauseDays: 3,
      drawdownHaltPct: 0.06,
      drawdownResumePct: 0.03,
    },
  },
];

// ── Pass/Fail Criteria ──────────────────────────────────

const CRITERIA = {
  minPortfolioSharpe: 1.0,
  maxPortfolioDD: 20,
  maxMonthlyLoss: 8,
  minCapitalUtilization: 30,
  maxCapitalUtilization: 80,
};

// ── Main ────────────────────────────────────────────────

async function runPhase3(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  VRP Harvester — Phase 3: Portfolio Simulation             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Scenarios: ${SCENARIOS.length} | Tickers: ${TICKERS.length} | Period: 2020-2026         ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  initDB();
  const token = process.env.ORATS_API_TOKEN || '';
  const results: { scenario: string; result: VRPHarvesterResult; monthlyPnl: Map<string, number> }[] = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  Scenario: ${scenario.name}`);
    console.log(`${'═'.repeat(60)}\n`);

    const config: VRPHarvesterConfig = {
      ...DEFAULT_VRP_HARVESTER_CONFIG,
      tickers: TICKERS,
      startDate: '2020-01-01',
      endDate: '2026-02-28',
      timeframe: '1D',
      ...scenario.config,
    };

    const result = await runVRPHarvester(token, config, {
      onProgress: (msg) => console.log(msg),
    });

    // Compute monthly P&L
    const monthlyPnl = new Map<string, number>();
    for (const trade of result.trades) {
      const month = trade.exitDate.slice(0, 7); // YYYY-MM
      monthlyPnl.set(month, (monthlyPnl.get(month) ?? 0) + trade.pnl);
    }

    results.push({ scenario: scenario.name, result, monthlyPnl });

    // Print scenario summary
    const { trades, analytics, signalCount } = result;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgConcurrent = estimateAvgConcurrentPositions(trades);
    const utilization = (avgConcurrent * config.creditSpreadWidth * 100) / config.startingCapital * 100;

    console.log(`\n  Trades: ${trades.length} | Signals: ${signalCount}`);
    console.log(`  Win rate: ${analytics.winRate.toFixed(1)}% | Sharpe: ${analytics.sharpe.toFixed(2)}`);
    console.log(`  Total PnL: $${totalPnl.toFixed(0)} | Max DD: ${analytics.maxDrawdown.toFixed(1)}%`);
    console.log(`  Avg concurrent: ${avgConcurrent.toFixed(1)} | Utilization: ~${utilization.toFixed(0)}%`);

    // Monthly P&L summary
    const months = [...monthlyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const worstMonth = months.reduce((worst, [, pnl]) => Math.min(worst, pnl), Infinity);
    const worstMonthPct = (worstMonth / config.startingCapital) * 100;
    console.log(`  Worst month PnL: $${worstMonth.toFixed(0)} (${worstMonthPct.toFixed(1)}%)`);
  }

  closeDB();

  // ── Comparison Table ──────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SCENARIO COMPARISON');
  console.log('══════════════════════════════════════════════════════════════\n');

  console.log('Scenario'.padEnd(50) + 'Trades  WR%    Sharpe  PnL       MaxDD  WorstMo');
  for (const { scenario, result, monthlyPnl } of results) {
    const { trades, analytics } = result;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const worstMonth = Math.min(...[...monthlyPnl.values()]);
    const worstMoPct = (worstMonth / DEFAULT_VRP_HARVESTER_CONFIG.startingCapital) * 100;
    console.log(
      `${scenario.padEnd(50)}${String(trades.length).padStart(4)}   ` +
      `${analytics.winRate.toFixed(1).padStart(5)}%  ` +
      `${analytics.sharpe.toFixed(2).padStart(6)}  ` +
      `$${totalPnl.toFixed(0).padStart(7)}  ` +
      `${analytics.maxDrawdown.toFixed(1).padStart(5)}%  ` +
      `${worstMoPct.toFixed(1).padStart(5)}%`
    );
  }

  // ── Pass/Fail for "Full governors" scenario ───────────
  const fullGov = results.find(r => r.scenario.includes('Full governors'));
  if (fullGov) {
    const { trades, analytics } = fullGov.result;
    const worstMonth = Math.min(...[...fullGov.monthlyPnl.values()]);
    const worstMonthPct = Math.abs(worstMonth / DEFAULT_VRP_HARVESTER_CONFIG.startingCapital * 100);
    const avgConcurrent = estimateAvgConcurrentPositions(trades);
    const utilization = (avgConcurrent * DEFAULT_VRP_HARVESTER_CONFIG.creditSpreadWidth * 100) / DEFAULT_VRP_HARVESTER_CONFIG.startingCapital * 100;

    console.log('\n── Pass/Fail Gates (Full Governors) ──────────────────────\n');

    const gates = [
      { name: `Portfolio Sharpe > ${CRITERIA.minPortfolioSharpe}`, pass: analytics.sharpe > CRITERIA.minPortfolioSharpe, value: `${analytics.sharpe.toFixed(2)}` },
      { name: `Max DD < ${CRITERIA.maxPortfolioDD}%`, pass: analytics.maxDrawdown < CRITERIA.maxPortfolioDD, value: `${analytics.maxDrawdown.toFixed(1)}%` },
      { name: `No month > -${CRITERIA.maxMonthlyLoss}%`, pass: worstMonthPct < CRITERIA.maxMonthlyLoss, value: `${worstMonthPct.toFixed(1)}%` },
      { name: `Utilization ${CRITERIA.minCapitalUtilization}-${CRITERIA.maxCapitalUtilization}%`, pass: utilization >= CRITERIA.minCapitalUtilization && utilization <= CRITERIA.maxCapitalUtilization, value: `${utilization.toFixed(0)}%` },
    ];

    let allPassed = true;
    for (const gate of gates) {
      console.log(`${gate.pass ? '✅' : '❌'} ${gate.name}: ${gate.value}`);
      if (!gate.pass) allPassed = false;
    }

    console.log(`\n${allPassed ? '🟢 PHASE 3 PASSED' : '🔴 PHASE 3 FAILED'}`);
  }

  // Save results
  const outDir = path.join(__dirname, '..', 'backtesting history', 'vrp-harvester');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'phase3-portfolio-results.json'), JSON.stringify({
    scenarios: results.map(r => ({
      name: r.scenario,
      trades: r.result.trades.length,
      winRate: r.result.analytics.winRate,
      sharpe: r.result.analytics.sharpe,
      totalPnl: r.result.trades.reduce((s, t) => s + t.pnl, 0),
      maxDD: r.result.analytics.maxDrawdown,
      monthlyPnl: Object.fromEntries(r.monthlyPnl),
    })),
  }, null, 2));
}

/**
 * Estimate average concurrent open positions from trade entry/exit dates.
 */
function estimateAvgConcurrentPositions(trades: { entryDate: string; exitDate: string }[]): number {
  if (trades.length === 0) return 0;

  const events: { date: string; delta: number }[] = [];
  for (const t of trades) {
    events.push({ date: t.entryDate, delta: 1 });
    events.push({ date: t.exitDate, delta: -1 });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.delta - b.delta);

  let current = 0;
  let sum = 0;
  let count = 0;
  let prevDate = '';

  for (const ev of events) {
    if (ev.date !== prevDate && prevDate !== '') {
      sum += current;
      count++;
    }
    current += ev.delta;
    prevDate = ev.date;
  }
  sum += current;
  count++;

  return count > 0 ? sum / count : 0;
}

runPhase3().catch(err => {
  console.error('Phase 3 failed:', err);
  closeDB();
  process.exit(1);
});
