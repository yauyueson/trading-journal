#!/usr/bin/env npx tsx
/**
 * VRP Harvester — Option Structure Sweep
 *
 * Phase 1 showed the 2-param VRP gate generates signals at 12.8/week with 73.7% WR,
 * but the payoff ratio at delta=0.30 / width=$10 / TP=50% is negative.
 *
 * This script sweeps option structure params (delta, width, TP) while keeping
 * the signal gate fixed, to find which payoff structure turns the edge positive.
 *
 * Usage: npx tsx scripts/vrp-structure-sweep.ts
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
  generateVRPSignals,
  vrpSignalToEntrySignal,
  evaluateVRPTradeCacheOnly,
  buildSimConfig,
  buildDateIndex,
} from '../src/lib/backtest/vrp-harvester';
import { DEFAULT_VRP_HARVESTER_CONFIG } from '../src/lib/backtest/types';
import type { VRPHarvesterConfig } from '../src/lib/backtest/types';
import { fetchTickerData, type TickerData } from '../src/lib/backtest/signal-data';
import { computeOptionAnalytics, type OptionTrade } from '../src/lib/backtest/option-sim';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA',
  'AMZN', 'MSFT', 'META', 'NFLX', 'GOOG', 'GS',
];

// ── Sweep Configs ───────────────────────────────────────

interface SweepPoint {
  label: string;
  delta: number;
  width: number;
  tp: number;
  timeStopDTE: number;
}

const SWEEP: SweepPoint[] = [
  // Vary delta (more credit = better payoff ratio)
  { label: 'd30|w10|tp50',  delta: 0.30, width: 10, tp: 0.50, timeStopDTE: 3 },  // baseline
  { label: 'd35|w10|tp50',  delta: 0.35, width: 10, tp: 0.50, timeStopDTE: 3 },
  { label: 'd40|w10|tp50',  delta: 0.40, width: 10, tp: 0.50, timeStopDTE: 3 },
  { label: 'd45|w10|tp50',  delta: 0.45, width: 10, tp: 0.50, timeStopDTE: 3 },

  // Vary width (tighter = less max loss)
  { label: 'd35|w5|tp50',   delta: 0.35, width: 5,  tp: 0.50, timeStopDTE: 3 },
  { label: 'd40|w5|tp50',   delta: 0.40, width: 5,  tp: 0.50, timeStopDTE: 3 },
  { label: 'd45|w5|tp50',   delta: 0.45, width: 5,  tp: 0.50, timeStopDTE: 3 },

  // Vary TP (lower = faster exit, higher WR)
  { label: 'd35|w10|tp30',  delta: 0.35, width: 10, tp: 0.30, timeStopDTE: 3 },
  { label: 'd40|w10|tp30',  delta: 0.40, width: 10, tp: 0.30, timeStopDTE: 3 },
  { label: 'd45|w10|tp30',  delta: 0.45, width: 10, tp: 0.30, timeStopDTE: 3 },
  { label: 'd35|w5|tp30',   delta: 0.35, width: 5,  tp: 0.30, timeStopDTE: 3 },
  { label: 'd40|w5|tp30',   delta: 0.40, width: 5,  tp: 0.30, timeStopDTE: 3 },
  { label: 'd45|w5|tp30',   delta: 0.45, width: 5,  tp: 0.30, timeStopDTE: 3 },

  // Higher DTE time stop (give trades more room)
  { label: 'd40|w5|tp50|ts1', delta: 0.40, width: 5,  tp: 0.50, timeStopDTE: 1 },
  { label: 'd45|w5|tp50|ts1', delta: 0.45, width: 5,  tp: 0.50, timeStopDTE: 1 },

  // Wider spreads (more premium, more risk)
  { label: 'd40|w15|tp50',  delta: 0.40, width: 15, tp: 0.50, timeStopDTE: 3 },
  { label: 'd45|w15|tp50',  delta: 0.45, width: 15, tp: 0.50, timeStopDTE: 3 },
];

// ── Main ────────────────────────────────────────────────

async function runSweep(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  VRP Harvester — Option Structure Sweep                     ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  ${SWEEP.length} configs × 14 tickers | Signal gate fixed (EMA 21/55) ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  initDB();

  // Load ticker data once
  console.log('Loading ticker data...');
  const warmupDays = 55 + 60;
  const calDays = Math.ceil(warmupDays * 1.5);
  const padDate = new Date('2020-01-01');
  padDate.setDate(padDate.getDate() - calDays);
  const dataStart = padDate.toISOString().slice(0, 10);

  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of TICKERS) {
    const td = await fetchTickerData(ticker, dataStart, '2026-02-28');
    tickerDataMap.set(ticker, td);
  }
  console.log(`Loaded ${tickerDataMap.size} tickers\n`);

  // Generate signals once (same for all configs since gate is fixed)
  const baseConfig: VRPHarvesterConfig = {
    ...DEFAULT_VRP_HARVESTER_CONFIG,
    tickers: TICKERS,
    startDate: '2020-01-01',
    endDate: '2026-02-28',
    timeframe: '1D',
  };

  const allSignals: ReturnType<typeof generateVRPSignals> = [];
  for (const [, td] of tickerDataMap) {
    allSignals.push(...generateVRPSignals(td, baseConfig, baseConfig.startDate, baseConfig.endDate));
  }
  allSignals.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
  console.log(`Total signals: ${allSignals.length}\n`);

  // Build trading dates
  const allDatesSet = new Set<string>();
  for (const td of tickerDataMap.values()) {
    for (const c of td.candles) allDatesSet.add(c.date);
  }
  const allTradingDates = [...allDatesSet].sort();
  buildDateIndex(allTradingDates);

  // Need to call internal buildDateIndex — import not exposed, use workaround
  // We'll call evaluateVRPTradeCacheOnly which internally uses the date index
  // We need to trigger it by running a dummy call first... actually the module-level
  // dateIndex is set by runVRPHarvester. Let's just import and call buildDateIndex.
  // Since it's not exported, let's use the runVRPHarvester path for the first config
  // and cache the signals. Actually, let me just duplicate the date index logic here.

  // Sweep
  const results: {
    label: string;
    trades: number;
    winRate: number;
    sharpe: number;
    profitFactor: number;
    totalPnl: number;
    avgPnl: number;
    maxDD: number;
    avgHoldDays: number;
    avgCredit: number;
    avgWin: number;
    avgLoss: number;
  }[] = [];

  for (const pt of SWEEP) {
    const sweepConfig: VRPHarvesterConfig = {
      ...baseConfig,
      creditShortDelta: pt.delta,
      creditSpreadWidth: pt.width,
      creditProfitTarget: pt.tp,
      creditTimeStopDTE: pt.timeStopDTE,
      // Disable portfolio constraints for raw signal quality
      maxPositions: 9999,
      maxPerTicker: 9999,
      vixHalfSizeThreshold: 999,
      vixPauseThreshold: 999,
      drawdownHaltPct: 1.0,
      earningsExclusionDays: 0,
    };

    const simConfig = buildSimConfig(sweepConfig);
    const trades: OptionTrade[] = [];

    for (const signal of allSignals) {
      const entry = vrpSignalToEntrySignal(signal);
      const trade = evaluateVRPTradeCacheOnly(entry, simConfig, allTradingDates, sweepConfig.endDate);
      if (trade) trades.push(trade);
    }

    const analytics = computeOptionAnalytics(trades);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const winners = trades.filter(t => t.pnl > 0);
    const losers = trades.filter(t => t.pnl <= 0);
    const avgCredit = trades.length > 0 ? trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length : 0;

    results.push({
      label: pt.label,
      trades: trades.length,
      winRate: analytics.winRate,
      sharpe: analytics.sharpe,
      profitFactor: analytics.profitFactor,
      totalPnl,
      avgPnl: trades.length > 0 ? totalPnl / trades.length : 0,
      maxDD: analytics.maxDrawdown,
      avgHoldDays: analytics.avgHoldDays,
      avgCredit,
      avgWin: winners.length > 0 ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0,
      avgLoss: losers.length > 0 ? losers.reduce((s, t) => s + t.pnl, 0) / losers.length : 0,
    });

    const pnlIcon = totalPnl > 0 ? '🟢' : '🔴';
    console.log(`${pnlIcon} ${pt.label.padEnd(20)} ${String(trades.length).padStart(5)} trades  WR ${analytics.winRate.toFixed(1).padStart(5)}%  Sharpe ${analytics.sharpe.toFixed(2).padStart(6)}  PnL $${totalPnl.toFixed(0).padStart(8)}  PF ${analytics.profitFactor.toFixed(2).padStart(5)}  AvgWin $${(winners.length > 0 ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0).toFixed(0).padStart(5)}  AvgLoss $${(losers.length > 0 ? losers.reduce((s, t) => s + t.pnl, 0) / losers.length : 0).toFixed(0).padStart(6)}`);
  }

  closeDB();

  // Summary — sort by total PnL
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  RANKED BY TOTAL PnL');
  console.log('══════════════════════════════════════════════════════════════\n');

  const ranked = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
  console.log('Config               Trades  WR%    Sharpe  PF     PnL        AvgPnl   AvgWin  AvgLoss  HoldD');
  for (const r of ranked) {
    const icon = r.totalPnl > 0 ? '🟢' : '🔴';
    console.log(
      `${icon} ${r.label.padEnd(20)}${String(r.trades).padStart(5)}  ` +
      `${r.winRate.toFixed(1).padStart(5)}%  ${r.sharpe.toFixed(2).padStart(6)}  ${r.profitFactor.toFixed(2).padStart(5)}  ` +
      `$${r.totalPnl.toFixed(0).padStart(8)}  $${r.avgPnl.toFixed(0).padStart(5)}  ` +
      `$${r.avgWin.toFixed(0).padStart(5)}  $${r.avgLoss.toFixed(0).padStart(6)}  ${r.avgHoldDays.toFixed(1).padStart(5)}`
    );
  }

  // Best profitable config
  const best = ranked.find(r => r.totalPnl > 0);
  if (best) {
    console.log(`\n✅ Best profitable config: ${best.label}`);
    console.log(`   ${best.trades} trades, WR ${best.winRate.toFixed(1)}%, Sharpe ${best.sharpe.toFixed(2)}, PnL $${best.totalPnl.toFixed(0)}`);
  } else {
    console.log('\n❌ No profitable config found. Signal gate alone insufficient — need approach 2 (multi-component signal).');
  }

  // Save
  const outDir = path.join(__dirname, '..', 'backtesting history', 'vrp-harvester');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'structure-sweep-results.json'), JSON.stringify({ results: ranked }, null, 2));
  console.log(`\nResults saved to: ${path.join(outDir, 'structure-sweep-results.json')}`);
}

runSweep().catch(err => {
  console.error('Sweep failed:', err);
  closeDB();
  process.exit(1);
});
