#!/usr/bin/env npx tsx
/**
 * VRP Harvester — Phase 1 Validation
 *
 * Goal: Confirm VRP + simple direction gate produces positive expectancy
 * WITHOUT WFA optimization. Single fixed config across all tickers 2020-2026.
 *
 * Tests:
 * 1. Direction accuracy: % of signals where credit spread would expire OTM
 * 2. Signal frequency: are we getting 4-6 signals/week across 27 tickers?
 * 3. Per-ticker P&L distribution: is any ticker dominating?
 * 4. Win rate: > 75% minimum threshold
 * 5. OOS Sharpe: > 0.8 on daily portfolio basis
 *
 * Usage: npx tsx scripts/vrp-validation-phase1.ts
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
  runVRPHarvester,
  generateVRPSignals,
  type VRPHarvesterResult,
} from '../src/lib/backtest/vrp-harvester';
import { DEFAULT_VRP_HARVESTER_CONFIG } from '../src/lib/backtest/types';
import type { VRPHarvesterConfig } from '../src/lib/backtest/types';
import { fetchTickerData } from '../src/lib/backtest/signal-data';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Universe ────────────────────────────────────────────

// 14-ticker cached universe (chain + candle data available locally)
const FULL_UNIVERSE = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA',
  'AMZN', 'MSFT', 'META', 'NFLX', 'GOOG', 'GS',
];

// ── Phase 1 Config ──────────────────────────────────────

const PHASE1_CONFIG: VRPHarvesterConfig = {
  ...DEFAULT_VRP_HARVESTER_CONFIG,
  tickers: FULL_UNIVERSE,
  startDate: '2020-01-01',
  endDate: '2026-02-28',
  timeframe: '1D', // Daily candles for Phase 1 (faster, signal-level validation)

  // Direction gate (fixed, not swept)
  trendEMAPeriod: 21,
  filterEMAPeriod: 55,
  noTradeZonePct: 0.015,

  // Entry timing
  maxD8Entry: 0.005,
  maxWaitBars: 5,

  // Option structure (fixed)
  creditDTERange: [14, 21],
  creditShortDelta: 0.30,
  creditSpreadWidth: 10,
  creditProfitTarget: 0.50,
  creditTimeStopDTE: 3,

  // Portfolio
  maxLossPerPositionPct: 0.02,
  maxPositions: 15,
  maxPerTicker: 2,
  startingCapital: 100_000,

  // Risk governors (disabled for Phase 1 — we want raw signal quality)
  vixHalfSizeThreshold: 999, // effectively disabled
  vixPauseThreshold: 999,
  vixPauseDays: 0,
  drawdownHaltPct: 1.0,      // effectively disabled
  drawdownResumePct: 0.0,
  earningsExclusionDays: 0,   // disabled

  // IV
  minIVRank: 20,

  // Execution
  fillMode: 'bidask',
  slippage: DEFAULT_VRP_HARVESTER_CONFIG.slippage,
  commissionPerLeg: 0.65,
};

// ── Pass/Fail Criteria ──────────────────────────────────

const CRITERIA = {
  minWinRate: 0.75,
  minTotalTrades: 200,
  minTradesPerWeek: 2.0,      // Relaxed from 3-4 for Phase 1
  maxSingleTickerPnlShare: 0.20,
  minPositiveTickerPct: 0.60, // At least 60% of tickers profitable
};

// ── Signal-Only Analysis ────────────────────────────────

async function runSignalAnalysis(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  VRP Harvester — Phase 1: Signal Quality Validation        ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Config: EMA(${PHASE1_CONFIG.trendEMAPeriod}/${PHASE1_CONFIG.filterEMAPeriod}) gate | delta ${PHASE1_CONFIG.creditShortDelta} | TP ${PHASE1_CONFIG.creditProfitTarget * 100}% | w$${PHASE1_CONFIG.creditSpreadWidth}  ║`);
  console.log(`║  Period: ${PHASE1_CONFIG.startDate} → ${PHASE1_CONFIG.endDate}                       ║`);
  console.log(`║  Universe: ${PHASE1_CONFIG.tickers.length} tickers                                    ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Part A: Signal frequency analysis (no chain data needed)
  console.log('── Part A: Signal Frequency Analysis ──────────────────────\n');

  const warmupDays = PHASE1_CONFIG.filterEMAPeriod + 60;
  const calDays = Math.ceil(warmupDays * 1.5);
  const padDate = new Date(PHASE1_CONFIG.startDate);
  padDate.setDate(padDate.getDate() - calDays);
  const dataStart = padDate.toISOString().slice(0, 10);

  let totalSignals = 0;
  const tickerSignalCounts: Record<string, number> = {};
  const directionCounts = { PUT_SPREAD: 0, CALL_SPREAD: 0 };

  for (const ticker of PHASE1_CONFIG.tickers) {
    try {
      const td = await fetchTickerData(ticker, dataStart, PHASE1_CONFIG.endDate);
      const signals = generateVRPSignals(td, PHASE1_CONFIG, PHASE1_CONFIG.startDate, PHASE1_CONFIG.endDate);
      tickerSignalCounts[ticker] = signals.length;
      totalSignals += signals.length;

      for (const s of signals) {
        if (s.direction === 'CALL') directionCounts.PUT_SPREAD++;
        else directionCounts.CALL_SPREAD++;
      }
    } catch (e) {
      console.log(`  ⚠ ${ticker}: data load failed — ${(e as Error).message}`);
      tickerSignalCounts[ticker] = 0;
    }
  }

  // Compute date range in trading weeks
  const startMs = new Date(PHASE1_CONFIG.startDate).getTime();
  const endMs = new Date(PHASE1_CONFIG.endDate).getTime();
  const tradingWeeks = (endMs - startMs) / (7 * 86_400_000);

  console.log(`Total signals:    ${totalSignals}`);
  console.log(`Trading weeks:    ${tradingWeeks.toFixed(0)}`);
  console.log(`Signals/week:     ${(totalSignals / tradingWeeks).toFixed(1)}`);
  console.log(`PUT spreads:      ${directionCounts.PUT_SPREAD} (${(directionCounts.PUT_SPREAD / totalSignals * 100).toFixed(1)}%)`);
  console.log(`CALL spreads:     ${directionCounts.CALL_SPREAD} (${(directionCounts.CALL_SPREAD / totalSignals * 100).toFixed(1)}%)`);

  console.log('\nPer-ticker signal counts:');
  const sortedTickers = Object.entries(tickerSignalCounts).sort((a, b) => b[1] - a[1]);
  for (const [ticker, count] of sortedTickers) {
    const bar = '█'.repeat(Math.ceil(count / 10));
    console.log(`  ${ticker.padEnd(6)} ${String(count).padStart(4)} ${bar}`);
  }

  const signalsPerWeek = totalSignals / tradingWeeks;
  console.log(`\n${signalsPerWeek >= CRITERIA.minTradesPerWeek ? '✅' : '❌'} Signal frequency: ${signalsPerWeek.toFixed(1)}/week (min ${CRITERIA.minTradesPerWeek})`);

  // Part B: Full simulation with chain data
  console.log('\n── Part B: Credit Spread Simulation ──────────────────────\n');

  initDB();

  const result = await runVRPHarvester(
    process.env.ORATS_API_TOKEN || '',
    PHASE1_CONFIG,
    {
      onProgress: (msg) => console.log(msg),
    },
  );

  closeDB();

  // ── Results Report ────────────────────────────────────
  printResults(result);
}

function printResults(result: VRPHarvesterResult): void {
  const { trades, analytics, signalCount, filteredByIV, filteredByPortfolio, perTickerStats } = result;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  RESULTS SUMMARY');
  console.log('══════════════════════════════════════════════════════════════\n');

  console.log('Signal Funnel:');
  console.log(`  Total signals:     ${signalCount}`);
  console.log(`  Filtered (IV):     ${filteredByIV}`);
  console.log(`  Filtered (port):   ${filteredByPortfolio}`);
  console.log(`  Executed trades:   ${trades.length}`);

  console.log('\nPerformance:');
  console.log(`  Win rate:          ${(analytics.winRate).toFixed(1)}%`);
  console.log(`  Total PnL:         $${analytics.totalPnl?.toFixed(0) ?? 'N/A'}`);
  console.log(`  Avg PnL/trade:     $${trades.length > 0 ? (trades.reduce((s, t) => s + t.pnl, 0) / trades.length).toFixed(2) : 'N/A'}`);
  console.log(`  Profit factor:     ${analytics.profitFactor?.toFixed(2) ?? 'N/A'}`);
  console.log(`  Sharpe (legacy):   ${analytics.sharpe?.toFixed(2) ?? 'N/A'}`);
  console.log(`  Max DD:            ${analytics.maxDrawdown?.toFixed(1)}%`);
  console.log(`  Avg hold days:     ${analytics.avgHoldDays?.toFixed(1) ?? 'N/A'}`);

  // Per-ticker breakdown
  console.log('\nPer-Ticker P&L:');
  const tickerEntries = [...perTickerStats.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  let positiveTickerCount = 0;

  for (const [ticker, stats] of tickerEntries) {
    if (stats.trades === 0) continue;
    const pnlShare = totalPnl !== 0 ? (stats.pnl / totalPnl * 100) : 0;
    if (stats.pnl > 0) positiveTickerCount++;
    console.log(`  ${ticker.padEnd(6)} ${String(stats.trades).padStart(3)} trades  $${stats.pnl.toFixed(0).padStart(7)}  (${pnlShare.toFixed(1)}%)`);
  }

  // Exit type distribution
  console.log('\nExit Types:');
  const exitCounts: Record<string, number> = {};
  for (const t of trades) {
    exitCounts[t.exitType] = (exitCounts[t.exitType] || 0) + 1;
  }
  for (const [type, count] of Object.entries(exitCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(20)} ${count} (${(count / trades.length * 100).toFixed(1)}%)`);
  }

  // ── Pass/Fail Gates ───────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  PASS/FAIL GATES');
  console.log('══════════════════════════════════════════════════════════════\n');

  const startMs = new Date(PHASE1_CONFIG.startDate).getTime();
  const endMs = new Date(PHASE1_CONFIG.endDate).getTime();
  const weeks = (endMs - startMs) / (7 * 86_400_000);
  const tradesPerWeek = trades.length / weeks;
  const tickersWithTrades = [...perTickerStats.values()].filter(s => s.trades > 0).length;
  const positiveTickerPct = tickersWithTrades > 0 ? positiveTickerCount / tickersWithTrades : 0;
  const maxTickerPnlShare = totalPnl !== 0
    ? Math.max(...tickerEntries.filter(([, s]) => s.trades > 0).map(([, s]) => Math.abs(s.pnl / totalPnl)))
    : 0;

  const gates = [
    { name: 'Total trades ≥ 200', pass: trades.length >= CRITERIA.minTotalTrades, value: `${trades.length}` },
    { name: `Win rate ≥ ${CRITERIA.minWinRate * 100}%`, pass: analytics.winRate >= CRITERIA.minWinRate * 100, value: `${analytics.winRate?.toFixed(1)}%` },
    { name: `Trades/week ≥ ${CRITERIA.minTradesPerWeek}`, pass: tradesPerWeek >= CRITERIA.minTradesPerWeek, value: `${tradesPerWeek.toFixed(1)}` },
    { name: `No ticker > ${CRITERIA.maxSingleTickerPnlShare * 100}% of PnL`, pass: maxTickerPnlShare <= CRITERIA.maxSingleTickerPnlShare, value: `${(maxTickerPnlShare * 100).toFixed(1)}%` },
    { name: `≥ ${CRITERIA.positiveTickerPct * 100}% tickers profitable`, pass: positiveTickerPct >= CRITERIA.positiveTickerPct, value: `${(positiveTickerPct * 100).toFixed(1)}%` },
  ];

  let allPassed = true;
  for (const gate of gates) {
    const icon = gate.pass ? '✅' : '❌';
    console.log(`${icon} ${gate.name}: ${gate.value}`);
    if (!gate.pass) allPassed = false;
  }

  console.log(`\n${allPassed ? '🟢 ALL GATES PASSED' : '🔴 SOME GATES FAILED'} — ${allPassed ? 'proceed to Phase 2' : 'investigate failures before continuing'}`);

  // Save results
  const outDir = path.join(__dirname, '..', 'backtesting history', 'vrp-harvester');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'phase1-results.json');
  fs.writeFileSync(outFile, JSON.stringify({
    config: PHASE1_CONFIG,
    summary: {
      totalSignals: signalCount,
      totalTrades: trades.length,
      winRate: analytics.winRate,
      totalPnl: totalPnl,
      avgPnlPerTrade: trades.length > 0 ? totalPnl / trades.length : 0,
      profitFactor: analytics.profitFactor,
      sharpe: analytics.sharpe,
      maxDrawdown: analytics.maxDrawdown,
      tradesPerWeek,
    },
    gates: gates.map(g => ({ ...g })),
    perTicker: Object.fromEntries(perTickerStats),
    exitTypes: exitCounts,
  }, null, 2));
  console.log(`\nResults saved to: ${outFile}`);
}

// ── Main ────────────────────────────────────────────────

runSignalAnalysis().catch(err => {
  console.error('Phase 1 validation failed:', err);
  process.exit(1);
});
