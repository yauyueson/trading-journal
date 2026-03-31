#!/usr/bin/env npx tsx
/**
 * VRP Harvester — Hybrid Test (Approach 2)
 *
 * Findings from structure sweep: 2-param EMA gate alone loses money across ALL
 * option structures. The signal IS the edge, not just a filter.
 *
 * Hybrid approach: Use validated EM (EMA+Momentum) signal for entries,
 * but apply VRP harvester portfolio management:
 *   - 15 concurrent positions (vs prior 5-10)
 *   - 2% risk budget per position
 *   - Multiple contracts for capital utilization
 *   - Drawdown governor
 *
 * Sweep: EM signal × {d35/d40/d45} × {w5/w10} × {tp30/tp50}
 * Compares against prior best: em|tp50|w10|iv20
 *
 * Usage: npx tsx scripts/vrp-hybrid-test.ts
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
  evaluateVRPTradeCacheOnly,
  buildSimConfig,
  buildDateIndex,
} from '../src/lib/backtest/vrp-harvester';
import { DEFAULT_VRP_HARVESTER_CONFIG } from '../src/lib/backtest/types';
import type { VRPHarvesterConfig } from '../src/lib/backtest/types';
import { fetchTickerData, generateSignalsForPreset, type TickerData } from '../src/lib/backtest/signal-data';
import type { SignalPresetKey } from '../src/lib/backtest/types';
import { computeOptionAnalytics, type OptionTrade, type EntrySignal } from '../src/lib/backtest/option-sim';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA',
  'AMZN', 'MSFT', 'META', 'NFLX', 'GOOG', 'GS',
];

// ── Sweep ───────────────────────────────────────────────

interface HybridConfig {
  label: string;
  preset: SignalPresetKey;
  delta: number;
  width: number;
  tp: number;
  ivMin: number;
  maxPositions: number;
  maxPerTicker: number;
  riskPct: number;  // max loss per position as % of capital
}

const CONFIGS: HybridConfig[] = [
  // EM signal (validated best) × option structure variations
  // Lower delta, wider spread (prior production-like)
  { label: 'em|d35|w10|tp50|iv20',  preset: 'em', delta: 0.35, width: 10, tp: 0.50, ivMin: 20, maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },
  { label: 'em|d45|w10|tp50|iv20',  preset: 'em', delta: 0.45, width: 10, tp: 0.50, ivMin: 20, maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },
  { label: 'em|d35|w10|tp30|iv20',  preset: 'em', delta: 0.35, width: 10, tp: 0.30, ivMin: 20, maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },
  { label: 'em|d45|w10|tp30|iv20',  preset: 'em', delta: 0.45, width: 10, tp: 0.30, ivMin: 20, maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },

  // Tighter $5 spreads
  { label: 'em|d35|w5|tp50|iv20',   preset: 'em', delta: 0.35, width: 5, tp: 0.50, ivMin: 20, maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },
  { label: 'em|d45|w5|tp50|iv20',   preset: 'em', delta: 0.45, width: 5, tp: 0.50, ivMin: 20, maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },
  { label: 'em|d45|w5|tp30|iv20',   preset: 'em', delta: 0.45, width: 5, tp: 0.30, ivMin: 20, maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },

  // No IV filter (more trades)
  { label: 'em|d45|w10|tp50|iv0',   preset: 'em', delta: 0.45, width: 10, tp: 0.50, ivMin: 0,  maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },
  { label: 'em|d45|w5|tp50|iv0',    preset: 'em', delta: 0.45, width: 5, tp: 0.50, ivMin: 0,   maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },

  // Higher utilization (20 positions, 3% risk)
  { label: 'em|d45|w10|tp50|iv20|p20', preset: 'em', delta: 0.45, width: 10, tp: 0.50, ivMin: 20, maxPositions: 20, maxPerTicker: 3, riskPct: 0.03 },

  // MOM signal for comparison
  { label: 'mom|d45|w10|tp50|iv20', preset: 'mom', delta: 0.45, width: 10, tp: 0.50, ivMin: 20, maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },

  // EMA-only signal for comparison
  { label: 'ema|d45|w10|tp50|iv20', preset: 'ema', delta: 0.45, width: 10, tp: 0.50, ivMin: 20, maxPositions: 15, maxPerTicker: 2, riskPct: 0.02 },
];

// ── Main ────────────────────────────────────────────────

async function runHybrid(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  VRP Harvester — Hybrid Test (EM Signal + VRP Portfolio)    ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  ${CONFIGS.length} configs × 14 tickers | 2020-01 → 2026-02            ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  initDB();

  // Load data
  console.log('Loading ticker data...');
  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of TICKERS) {
    const td = await fetchTickerData(ticker, '2019-01-01', '2026-02-28');
    tickerDataMap.set(ticker, td);
  }
  console.log(`Loaded ${tickerDataMap.size} tickers\n`);

  // Build trading dates
  const allDatesSet = new Set<string>();
  for (const td of tickerDataMap.values()) {
    for (const c of td.candles) allDatesSet.add(c.date);
  }
  const allTradingDates = [...allDatesSet].sort();
  buildDateIndex(allTradingDates);

  // Pre-generate signals for each preset
  const signalsByPreset = new Map<string, EntrySignal[]>();
  for (const preset of ['em', 'mom', 'ema'] as SignalPresetKey[]) {
    const signals: EntrySignal[] = [];
    for (const [, td] of tickerDataMap) {
      signals.push(...generateSignalsForPreset(td, preset, '2020-01-01', '2026-02-28'));
    }
    signals.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
    signalsByPreset.set(preset, signals);
    console.log(`${preset} preset: ${signals.length} signals`);
  }
  console.log('');

  // Run sweep
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
    avgWin: number;
    avgLoss: number;
    tickersPositive: number;
    capitalDeployedPct: number;
  }[] = [];

  for (const cfg of CONFIGS) {
    const signals = signalsByPreset.get(cfg.preset) ?? [];

    const harvesterConfig: VRPHarvesterConfig = {
      ...DEFAULT_VRP_HARVESTER_CONFIG,
      tickers: TICKERS,
      startDate: '2020-01-01',
      endDate: '2026-02-28',
      creditShortDelta: cfg.delta,
      creditSpreadWidth: cfg.width,
      creditProfitTarget: cfg.tp,
      creditTimeStopDTE: 3,
      minIVRank: cfg.ivMin,
      maxPositions: cfg.maxPositions,
      maxPerTicker: cfg.maxPerTicker,
      maxLossPerPositionPct: cfg.riskPct,
    };
    const simConfig = buildSimConfig(harvesterConfig);

    // Portfolio-constrained execution
    const openPositions: { trade: OptionTrade; ticker: string; exitDate: string }[] = [];
    const openByTicker = new Map<string, number>();
    const trades: OptionTrade[] = [];
    const pnlByTicker = new Map<string, number>();

    for (const signal of signals) {
      // Retire closed
      for (let i = openPositions.length - 1; i >= 0; i--) {
        if (openPositions[i].exitDate <= signal.date) {
          const closed = openPositions.splice(i, 1)[0];
          const prev = openByTicker.get(closed.ticker) ?? 0;
          if (prev <= 1) openByTicker.delete(closed.ticker);
          else openByTicker.set(closed.ticker, prev - 1);
        }
      }

      // Portfolio constraints
      if (openPositions.length >= cfg.maxPositions) continue;
      if ((openByTicker.get(signal.ticker) ?? 0) >= cfg.maxPerTicker) continue;

      // Execute trade (cache-only)
      const trade = evaluateVRPTradeCacheOnly(signal, simConfig, allTradingDates, '2026-02-28');
      if (!trade) continue;

      // Size by risk budget
      const maxLossPerPos = 100_000 * cfg.riskPct;
      const contractsFromRisk = Math.max(1, Math.floor(maxLossPerPos / (cfg.width * 100)));
      trade.contracts = contractsFromRisk;
      trade.positionSize = contractsFromRisk;
      trade.pnl = trade.pnl * contractsFromRisk;

      trades.push(trade);
      openPositions.push({ trade, ticker: signal.ticker, exitDate: trade.exitDate });
      openByTicker.set(signal.ticker, (openByTicker.get(signal.ticker) ?? 0) + 1);
      pnlByTicker.set(signal.ticker, (pnlByTicker.get(signal.ticker) ?? 0) + trade.pnl);
    }

    const analytics = computeOptionAnalytics(trades);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const winners = trades.filter(t => t.pnl > 0);
    const losers = trades.filter(t => t.pnl <= 0);
    const tickersPositive = [...pnlByTicker.values()].filter(v => v > 0).length;

    // Estimate capital utilization
    const avgConcurrent = estimateAvgConcurrent(trades);
    const capitalDeployedPct = (avgConcurrent * cfg.width * 100 * Math.max(1, Math.floor(100_000 * cfg.riskPct / (cfg.width * 100)))) / 100_000 * 100;

    results.push({
      label: cfg.label,
      trades: trades.length,
      winRate: analytics.winRate,
      sharpe: analytics.sharpe,
      profitFactor: analytics.profitFactor,
      totalPnl,
      avgPnl: trades.length > 0 ? totalPnl / trades.length : 0,
      maxDD: analytics.maxDrawdown,
      avgHoldDays: analytics.avgHoldDays,
      avgWin: winners.length > 0 ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0,
      avgLoss: losers.length > 0 ? losers.reduce((s, t) => s + t.pnl, 0) / losers.length : 0,
      tickersPositive,
      capitalDeployedPct,
    });

    const icon = totalPnl > 0 ? '🟢' : '🔴';
    console.log(`${icon} ${cfg.label.padEnd(28)} ${String(trades.length).padStart(4)} trades  WR ${analytics.winRate.toFixed(1).padStart(5)}%  Sharpe ${analytics.sharpe.toFixed(2).padStart(6)}  PnL $${totalPnl.toFixed(0).padStart(8)}  PF ${analytics.profitFactor.toFixed(2).padStart(5)}  ${tickersPositive}/${TICKERS.length} tickers+  ~${capitalDeployedPct.toFixed(0)}% util`);
  }

  closeDB();

  // Ranked summary
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  RANKED BY SHARPE');
  console.log('══════════════════════════════════════════════════════════════\n');

  const ranked = [...results].sort((a, b) => b.sharpe - a.sharpe);
  console.log('Config                       Trades  WR%    Sharpe  PF     PnL        AvgWin  AvgLoss  Tickers+  Util');
  for (const r of ranked) {
    const icon = r.totalPnl > 0 ? '🟢' : '🔴';
    console.log(
      `${icon} ${r.label.padEnd(28)}${String(r.trades).padStart(4)}  ` +
      `${r.winRate.toFixed(1).padStart(5)}%  ${r.sharpe.toFixed(2).padStart(6)}  ${r.profitFactor.toFixed(2).padStart(5)}  ` +
      `$${r.totalPnl.toFixed(0).padStart(8)}  $${r.avgWin.toFixed(0).padStart(5)}  $${r.avgLoss.toFixed(0).padStart(6)}  ` +
      `${r.tickersPositive}/${TICKERS.length}       ~${r.capitalDeployedPct.toFixed(0)}%`
    );
  }

  const profitable = ranked.filter(r => r.totalPnl > 0);
  if (profitable.length > 0) {
    console.log(`\n✅ ${profitable.length} profitable configs found. Best: ${profitable[0].label}`);
  } else {
    console.log('\n❌ No profitable configs. Even EM signal insufficient at this DTE/structure.');
  }

  // Save
  const outDir = path.join(__dirname, '..', 'backtesting history', 'vrp-harvester');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'hybrid-test-results.json'), JSON.stringify({ results: ranked }, null, 2));
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

runHybrid().catch(err => {
  console.error('Hybrid test failed:', err);
  closeDB();
  process.exit(1);
});
