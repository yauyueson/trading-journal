#!/usr/bin/env npx tsx
/**
 * VRP Harvester — Phase 2: Single-Config Walk-Forward Validation
 *
 * Goal: Validate the fixed VRP Harvester config across rolling WFA windows
 * WITHOUT config selection. One config, many windows, no optimization.
 *
 * WFA setup:
 *   - Train: 252 trading days (1 year) — confirm direction filter has positive hit rate
 *   - OOS: 63 trading days (1 quarter) — execute and measure
 *   - Purge: 21 days — prevents look-ahead bias for 14-21 DTE options
 *   - Mode: rolling
 *   - Minimum 8 windows
 *
 * Pass criteria:
 *   - OOS Sharpe > 0.8 (daily portfolio)
 *   - Win rate > 75%
 *   - At least 15 trades per window
 *   - No single window with > 15% portfolio loss
 *
 * Usage: npx tsx scripts/vrp-wfa-single-config.ts
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
  vrpSignalToEntrySignal,
  buildSimConfig,
} from '../src/lib/backtest/vrp-harvester';
import { DEFAULT_VRP_HARVESTER_CONFIG } from '../src/lib/backtest/types';
import type { VRPHarvesterConfig } from '../src/lib/backtest/types';
import { fetchTickerData, type TickerData } from '../src/lib/backtest/signal-data';
import { simulateCreditSpread, computeOptionAnalytics, type OptionTrade } from '../src/lib/backtest/option-sim';
import { buildWFAWindows, type WindowDef } from '../src/lib/backtest/wfa-options';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Universe ────────────────────────────────────────────

const TICKERS = [
  'SPY', 'QQQ', 'GOOG', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
  'AAPL', 'NVDA', 'AMD', 'COST', 'BA', 'AMZN', 'PLTR', 'AVGO',
  'LULU', 'UBER', 'GS', 'UNH', 'IWM', 'GLD',
];

// ── WFA Window Config ───────────────────────────────────

const WFA_CONFIG = {
  trainWindowDays: 252,    // 1 year
  forwardStepDays: 63,     // 1 quarter
  purgeGapDays: 21,        // > max DTE (21)
  mode: 'rolling' as const,
  startDate: '2020-01-01',
  endDate: '2026-02-28',
};

const HARVESTER_CONFIG: VRPHarvesterConfig = {
  ...DEFAULT_VRP_HARVESTER_CONFIG,
  tickers: TICKERS,
  startDate: WFA_CONFIG.startDate,
  endDate: WFA_CONFIG.endDate,
  timeframe: '1D',
};

// ── Pass/Fail Criteria ──────────────────────────────────

const CRITERIA = {
  minOOSSharpe: 0.8,
  minOOSWinRate: 75,
  minTradesPerWindow: 15,
  maxWindowLossPct: 15,
  minWindows: 8,
};

// ── Main ────────────────────────────────────────────────

interface WindowResult {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  // Train metrics (for WF efficiency)
  trainTrades: number;
  trainWinRate: number;
  trainSharpe: number;
  // OOS metrics
  oosTrades: number;
  oosWinRate: number;
  oosSharpe: number;
  oosTotalPnl: number;
  oosMaxDD: number;
}

async function runPhase2(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  VRP Harvester — Phase 2: Single-Config Walk-Forward       ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Train: ${WFA_CONFIG.trainWindowDays}d | OOS: ${WFA_CONFIG.forwardStepDays}d | Purge: ${WFA_CONFIG.purgeGapDays}d | Rolling       ║`);
  console.log(`║  Period: ${WFA_CONFIG.startDate} → ${WFA_CONFIG.endDate}                       ║`);
  console.log(`║  Universe: ${TICKERS.length} tickers | NO config selection            ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  initDB();

  // Load all ticker data
  console.log('Loading ticker data...');
  const warmupDays = HARVESTER_CONFIG.filterEMAPeriod + 60;
  const calDays = Math.ceil(warmupDays * 1.5);
  const padDate = new Date(WFA_CONFIG.startDate);
  padDate.setDate(padDate.getDate() - calDays);
  const dataStart = padDate.toISOString().slice(0, 10);

  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of TICKERS) {
    try {
      const td = await fetchTickerData(ticker, dataStart, WFA_CONFIG.endDate);
      tickerDataMap.set(ticker, td);
    } catch (e) {
      console.log(`  ⚠ ${ticker}: skipped — ${(e as Error).message}`);
    }
  }

  // Build trading dates from all candles
  const allDatesSet = new Set<string>();
  for (const td of tickerDataMap.values()) {
    for (const c of td.candles) {
      if (c.date >= WFA_CONFIG.startDate && c.date <= WFA_CONFIG.endDate) {
        allDatesSet.add(c.date);
      }
    }
  }
  const allTradingDates = [...allDatesSet].sort();

  // Build WFA windows
  const windows = buildWFAWindows(allTradingDates, {
    trainWindowDays: WFA_CONFIG.trainWindowDays,
    forwardStepDays: WFA_CONFIG.forwardStepDays,
    purgeGapDays: WFA_CONFIG.purgeGapDays,
    mode: WFA_CONFIG.mode,
    startDate: WFA_CONFIG.startDate,
    endDate: WFA_CONFIG.endDate,
  });

  console.log(`Built ${windows.length} WFA windows\n`);
  if (windows.length < CRITERIA.minWindows) {
    console.log(`❌ Insufficient windows: ${windows.length} < ${CRITERIA.minWindows}`);
    closeDB();
    return;
  }

  // Run each window
  const simConfig = buildSimConfig(HARVESTER_CONFIG);
  const token = process.env.ORATS_API_TOKEN || '';
  const windowResults: WindowResult[] = [];
  const allOOSTrades: OptionTrade[] = [];

  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    console.log(`\n── Window ${wi} ──────────────────────────────────────────`);
    console.log(`  Train: ${w.trainStart} → ${w.trainEnd}`);
    console.log(`  OOS:   ${w.oosStart} → ${w.oosEnd}`);

    // Generate signals for train and OOS periods
    const trainTrades: OptionTrade[] = [];
    const oosTrades: OptionTrade[] = [];

    for (const [ticker, td] of tickerDataMap) {
      // Train period signals
      const trainSignals = generateVRPSignals(td, HARVESTER_CONFIG, w.trainStart, w.trainEnd);
      for (const sig of trainSignals) {
        const entry = vrpSignalToEntrySignal(sig);
        const trade = await simulateCreditSpread(token, entry, simConfig, allTradingDates, w.trainEnd);
        if (trade) trainTrades.push(trade);
      }

      // OOS period signals
      const oosSignals = generateVRPSignals(td, HARVESTER_CONFIG, w.oosStart, w.oosEnd);
      for (const sig of oosSignals) {
        const entry = vrpSignalToEntrySignal(sig);
        const trade = await simulateCreditSpread(token, entry, simConfig, allTradingDates, w.oosEnd);
        if (trade) oosTrades.push(trade);
      }
    }

    const trainAnalytics = computeOptionAnalytics(trainTrades);
    const oosAnalytics = computeOptionAnalytics(oosTrades);

    const result: WindowResult = {
      windowIndex: wi,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      trainTrades: trainTrades.length,
      trainWinRate: trainAnalytics.winRate,
      trainSharpe: trainAnalytics.sharpe,
      oosTrades: oosTrades.length,
      oosWinRate: oosAnalytics.winRate,
      oosSharpe: oosAnalytics.sharpe,
      oosTotalPnl: oosTrades.reduce((s, t) => s + t.pnl, 0),
      oosMaxDD: oosAnalytics.maxDrawdown,
    };
    windowResults.push(result);
    allOOSTrades.push(...oosTrades);

    console.log(`  Train: ${trainTrades.length} trades, WR ${trainAnalytics.winRate.toFixed(1)}%, Sharpe ${trainAnalytics.sharpe.toFixed(2)}`);
    console.log(`  OOS:   ${oosTrades.length} trades, WR ${oosAnalytics.winRate.toFixed(1)}%, Sharpe ${oosAnalytics.sharpe.toFixed(2)}, PnL $${result.oosTotalPnl.toFixed(0)}`);
  }

  closeDB();

  // ── Aggregate Results ─────────────────────────────────
  const aggAnalytics = computeOptionAnalytics(allOOSTrades);
  const avgOOSSharpe = windowResults.reduce((s, w) => s + w.oosSharpe, 0) / windowResults.length;
  const avgTrainSharpe = windowResults.reduce((s, w) => s + w.trainSharpe, 0) / windowResults.length;
  const wfEfficiency = avgTrainSharpe > 0 ? avgOOSSharpe / avgTrainSharpe : 0;
  const positiveWindows = windowResults.filter(w => w.oosTotalPnl > 0).length;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  WALK-FORWARD RESULTS');
  console.log('══════════════════════════════════════════════════════════════\n');

  console.log('Per-window OOS:');
  console.log('  Window   Trades  WR%    Sharpe  PnL      MaxDD');
  for (const w of windowResults) {
    console.log(`  W${String(w.windowIndex).padStart(2)}      ${String(w.oosTrades).padStart(4)}   ${w.oosWinRate.toFixed(1).padStart(5)}%  ${w.oosSharpe.toFixed(2).padStart(6)}  $${w.oosTotalPnl.toFixed(0).padStart(7)}  ${w.oosMaxDD.toFixed(1).padStart(5)}%`);
  }

  console.log('\nAggregated OOS:');
  console.log(`  Total trades:      ${allOOSTrades.length}`);
  console.log(`  Win rate:          ${aggAnalytics.winRate.toFixed(1)}%`);
  console.log(`  Sharpe (legacy):   ${aggAnalytics.sharpe.toFixed(2)}`);
  console.log(`  Avg window Sharpe: ${avgOOSSharpe.toFixed(2)}`);
  console.log(`  WF Efficiency:     ${wfEfficiency.toFixed(2)}`);
  console.log(`  Positive windows:  ${positiveWindows}/${windowResults.length}`);
  console.log(`  Total PnL:         $${allOOSTrades.reduce((s, t) => s + t.pnl, 0).toFixed(0)}`);
  console.log(`  Max DD:            ${aggAnalytics.maxDrawdown.toFixed(1)}%`);

  // ── Pass/Fail Gates ───────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  PASS/FAIL GATES');
  console.log('══════════════════════════════════════════════════════════════\n');

  const minWindowTrades = Math.min(...windowResults.map(w => w.oosTrades));
  const maxWindowLoss = Math.max(...windowResults.map(w => w.oosMaxDD));

  const gates = [
    { name: `OOS Sharpe > ${CRITERIA.minOOSSharpe}`, pass: avgOOSSharpe > CRITERIA.minOOSSharpe, value: `${avgOOSSharpe.toFixed(2)}` },
    { name: `Win rate > ${CRITERIA.minOOSWinRate}%`, pass: aggAnalytics.winRate > CRITERIA.minOOSWinRate, value: `${aggAnalytics.winRate.toFixed(1)}%` },
    { name: `Min ${CRITERIA.minTradesPerWindow} trades/window`, pass: minWindowTrades >= CRITERIA.minTradesPerWindow, value: `min=${minWindowTrades}` },
    { name: `No window > ${CRITERIA.maxWindowLossPct}% loss`, pass: maxWindowLoss <= CRITERIA.maxWindowLossPct, value: `max=${maxWindowLoss.toFixed(1)}%` },
    { name: `≥ ${CRITERIA.minWindows} windows`, pass: windowResults.length >= CRITERIA.minWindows, value: `${windowResults.length}` },
  ];

  let allPassed = true;
  for (const gate of gates) {
    const icon = gate.pass ? '✅' : '❌';
    console.log(`${icon} ${gate.name}: ${gate.value}`);
    if (!gate.pass) allPassed = false;
  }

  console.log(`\n${allPassed ? '🟢 PHASE 2 PASSED' : '🔴 PHASE 2 FAILED'} — ${allPassed ? 'proceed to Phase 3 (portfolio simulation)' : 'investigate before continuing'}`);

  // Save results
  const outDir = path.join(__dirname, '..', 'backtesting history', 'vrp-harvester');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'phase2-wfa-results.json'), JSON.stringify({
    wfaConfig: WFA_CONFIG,
    harvesterConfig: HARVESTER_CONFIG,
    windows: windowResults,
    aggregate: {
      totalTrades: allOOSTrades.length,
      winRate: aggAnalytics.winRate,
      avgOOSSharpe,
      wfEfficiency,
      positiveWindows: `${positiveWindows}/${windowResults.length}`,
      totalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
      maxDD: aggAnalytics.maxDrawdown,
    },
    gates: gates.map(g => ({ ...g })),
  }, null, 2));
}

runPhase2().catch(err => {
  console.error('Phase 2 failed:', err);
  closeDB();
  process.exit(1);
});
