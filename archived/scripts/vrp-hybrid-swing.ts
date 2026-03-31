#!/usr/bin/env npx tsx
/**
 * VRP Harvester — Hybrid Swing Test
 *
 * Prior tests failed because we used short DTE (14-21d) with daily signals.
 * The validated research shows daily EM signal works at swing DTE (45-65d).
 *
 * This test: EM signal + swing DTE + VRP portfolio management (15 pos, risk budget)
 * Compares signal presets × option structures at the VALIDATED DTE range.
 *
 * Usage: npx tsx scripts/vrp-hybrid-swing.ts
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

interface SwingConfig {
  label: string;
  preset: SignalPresetKey;
  delta: number;
  width: number;
  tp: number;
  ivMin: number;
  dteRange: [number, number];
  timeStopDTE: number;
  maxPositions: number;
  maxPerTicker: number;
  contracts: number;  // fixed contracts per trade (for comparison)
}

const CONFIGS: SwingConfig[] = [
  // === Validated baseline recreations (from CLAUDE.md) ===
  // Prior best swing: em|tp30|w15|iv30 → Sharpe 1.42, WR 86.6%
  { label: 'em|d35|w15|tp30|iv30 (baseline)', preset: 'em', delta: 0.35, width: 15, tp: 0.30, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 5, maxPerTicker: 2, contracts: 1 },

  // === Same signal, scale positions (VRP harvester improvement) ===
  { label: 'em|d35|w15|tp30|iv30|p10',  preset: 'em', delta: 0.35, width: 15, tp: 0.30, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 10, maxPerTicker: 2, contracts: 1 },
  { label: 'em|d35|w15|tp30|iv30|p15',  preset: 'em', delta: 0.35, width: 15, tp: 0.30, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 15, maxPerTicker: 2, contracts: 1 },

  // === Scale with multiple contracts (risk budget) ===
  { label: 'em|d35|w15|tp30|iv30|p10|c2', preset: 'em', delta: 0.35, width: 15, tp: 0.30, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 10, maxPerTicker: 2, contracts: 2 },
  { label: 'em|d35|w10|tp30|iv30|p15|c2', preset: 'em', delta: 0.35, width: 10, tp: 0.30, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 15, maxPerTicker: 2, contracts: 2 },

  // === TP50 variant (validated in 130M study) ===
  { label: 'em|d35|w15|tp50|iv30|p10',    preset: 'em', delta: 0.35, width: 15, tp: 0.50, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 10, maxPerTicker: 2, contracts: 1 },
  { label: 'em|d35|w15|tp50|iv30|p15|c2', preset: 'em', delta: 0.35, width: 15, tp: 0.50, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 15, maxPerTicker: 2, contracts: 2 },

  // === Relax IV filter (more trades) ===
  { label: 'em|d35|w15|tp30|iv20|p15',    preset: 'em', delta: 0.35, width: 15, tp: 0.30, ivMin: 20, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 15, maxPerTicker: 2, contracts: 1 },
  { label: 'em|d35|w15|tp50|iv20|p15|c2', preset: 'em', delta: 0.35, width: 15, tp: 0.50, ivMin: 20, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 15, maxPerTicker: 2, contracts: 2 },

  // === Higher delta (more credit) ===
  { label: 'em|d40|w15|tp30|iv30|p10',    preset: 'em', delta: 0.40, width: 15, tp: 0.30, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 10, maxPerTicker: 2, contracts: 1 },
  { label: 'em|d40|w15|tp50|iv30|p15|c2', preset: 'em', delta: 0.40, width: 15, tp: 0.50, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 15, maxPerTicker: 2, contracts: 2 },

  // === Comparison: MOM and EMA signals ===
  { label: 'mom|d35|w15|tp30|iv30|p10',   preset: 'mom', delta: 0.35, width: 15, tp: 0.30, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 10, maxPerTicker: 2, contracts: 1 },
  { label: 'ema|d35|w15|tp30|iv30|p10',   preset: 'ema', delta: 0.35, width: 15, tp: 0.30, ivMin: 30, dteRange: [45, 65], timeStopDTE: 5, maxPositions: 10, maxPerTicker: 2, contracts: 1 },
];

async function runSwingHybrid(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  VRP Harvester — Hybrid Swing (EM + 45-65 DTE)             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  ${CONFIGS.length} configs × 14 tickers | DTE [45-65] validated range  ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  initDB();

  console.log('Loading ticker data...');
  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of TICKERS) {
    const td = await fetchTickerData(ticker, '2019-01-01', '2026-02-28');
    tickerDataMap.set(ticker, td);
  }

  const allDatesSet = new Set<string>();
  for (const td of tickerDataMap.values()) {
    for (const c of td.candles) allDatesSet.add(c.date);
  }
  const allTradingDates = [...allDatesSet].sort();
  buildDateIndex(allTradingDates);

  // Pre-generate signals
  const signalsByPreset = new Map<string, EntrySignal[]>();
  for (const preset of ['em', 'mom', 'ema'] as SignalPresetKey[]) {
    const signals: EntrySignal[] = [];
    for (const [, td] of tickerDataMap) {
      signals.push(...generateSignalsForPreset(td, preset, '2020-01-01', '2026-02-28'));
    }
    signals.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
    signalsByPreset.set(preset, signals);
    console.log(`${preset}: ${signals.length} signals`);
  }
  console.log('');

  const results: any[] = [];

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
      creditDTERange: cfg.dteRange,
      creditTimeStopDTE: cfg.timeStopDTE,
      minIVRank: cfg.ivMin,
      maxPositions: cfg.maxPositions,
      maxPerTicker: cfg.maxPerTicker,
    };
    const simConfig = buildSimConfig(harvesterConfig);

    const openPositions: { ticker: string; exitDate: string }[] = [];
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

      if (openPositions.length >= cfg.maxPositions) continue;
      if ((openByTicker.get(signal.ticker) ?? 0) >= cfg.maxPerTicker) continue;

      const trade = evaluateVRPTradeCacheOnly(signal, simConfig, allTradingDates, '2026-02-28');
      if (!trade) continue;

      // Scale by contracts
      if (cfg.contracts > 1) {
        trade.contracts = cfg.contracts;
        trade.positionSize = cfg.contracts;
        trade.pnl = trade.pnl * cfg.contracts;
      }

      trades.push(trade);
      openPositions.push({ ticker: signal.ticker, exitDate: trade.exitDate });
      openByTicker.set(signal.ticker, (openByTicker.get(signal.ticker) ?? 0) + 1);
      pnlByTicker.set(signal.ticker, (pnlByTicker.get(signal.ticker) ?? 0) + trade.pnl);
    }

    const analytics = computeOptionAnalytics(trades);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const winners = trades.filter(t => t.pnl > 0);
    const losers = trades.filter(t => t.pnl <= 0);
    const tickersPositive = [...pnlByTicker.values()].filter(v => v > 0).length;

    results.push({
      label: cfg.label,
      trades: trades.length,
      winRate: analytics.winRate,
      sharpe: analytics.sharpe,
      profitFactor: analytics.profitFactor,
      totalPnl,
      avgPnl: trades.length > 0 ? totalPnl / trades.length : 0,
      maxDD: analytics.maxDrawdown,
      avgWin: winners.length > 0 ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0,
      avgLoss: losers.length > 0 ? losers.reduce((s, t) => s + t.pnl, 0) / losers.length : 0,
      tickersPositive,
      avgHoldDays: analytics.avgHoldDays,
    });

    const icon = totalPnl > 0 ? '🟢' : '🔴';
    console.log(`${icon} ${cfg.label.padEnd(35)} ${String(trades.length).padStart(4)} trades  WR ${analytics.winRate.toFixed(1).padStart(5)}%  Sharpe ${analytics.sharpe.toFixed(2).padStart(6)}  PnL $${totalPnl.toFixed(0).padStart(8)}  PF ${analytics.profitFactor.toFixed(2).padStart(5)}  ${tickersPositive}/${TICKERS.length}+  hold ${analytics.avgHoldDays.toFixed(0)}d`);
  }

  closeDB();

  // Ranked
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  RANKED BY SHARPE');
  console.log('══════════════════════════════════════════════════════════════\n');

  const ranked = [...results].sort((a: any, b: any) => b.sharpe - a.sharpe);
  for (const r of ranked) {
    const icon = r.totalPnl > 0 ? '🟢' : '🔴';
    console.log(
      `${icon} ${r.label.padEnd(35)}${String(r.trades).padStart(4)}  ` +
      `WR ${r.winRate.toFixed(1).padStart(5)}%  Sharpe ${r.sharpe.toFixed(2).padStart(6)}  PF ${r.profitFactor.toFixed(2).padStart(5)}  ` +
      `$${r.totalPnl.toFixed(0).padStart(8)}  W $${r.avgWin.toFixed(0).padStart(5)} / L $${r.avgLoss.toFixed(0).padStart(6)}  ${r.tickersPositive}/${TICKERS.length}+`
    );
  }

  const best = ranked.find((r: any) => r.totalPnl > 0);
  if (best) {
    console.log(`\n✅ Best: ${best.label}`);
    console.log(`   Trades: ${best.trades}, WR: ${best.winRate.toFixed(1)}%, Sharpe: ${best.sharpe.toFixed(2)}, PnL: $${best.totalPnl.toFixed(0)}`);
    console.log(`   Avg Win: $${best.avgWin.toFixed(0)}, Avg Loss: $${best.avgLoss.toFixed(0)}, Tickers+: ${best.tickersPositive}/${TICKERS.length}`);
  } else {
    console.log('\n❌ No profitable configs at swing DTE either.');
  }

  const outDir = path.join(__dirname, '..', 'backtesting history', 'vrp-harvester');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'hybrid-swing-results.json'), JSON.stringify({ results: ranked }, null, 2));
}

runSwingHybrid().catch(err => {
  console.error('Failed:', err);
  closeDB();
  process.exit(1);
});
