/**
 * Benchmark Strategies — Naive baselines for WFA comparison.
 *
 * All option-based benchmarks route through the real chain-cache +
 * option-sim evaluator pipeline (same slippage, BSM pricing, and
 * portfolio constraints as the strategy being compared).
 *
 * 1. Buy-and-hold SPY (candle-based, no options)
 * 2. Mechanical ATM put-selling on SPY (real chain evaluator)
 * 3. Random-entry credit spreads (real chain evaluator, Monte Carlo)
 */

import type { BacktestCandle } from './types';
import { DEFAULT_DYNAMIC_SLIPPAGE } from './types';
import {
  DEFAULT_CREDIT_CONFIG,
  type EntrySignal, type SimConfig,
} from './option-sim';
import type { FillMode } from './types';
import {
  evaluateSignalsWithConstraints,
  computePortfolioDailyMetrics,
  type TradeEvaluator,
  type PortfolioExecutionConfig,
} from './wfa-options';

export interface BenchmarkResult {
  name: string;
  sharpe: number;
  maxDrawdownPct: number;
  totalPnl: number;
  totalReturnPct: number;
  winRate: number;
  trades: number;
}

// ── 1. Buy-and-Hold SPY ──────────────────────────────────

/**
 * Computes buy-and-hold metrics from daily candles.
 * Assumes $100K invested at startDate, held to endDate.
 */
export function buyAndHoldBenchmark(
  candles: BacktestCandle[],
  startDate: string,
  endDate: string,
  startingCapital: number = 100_000,
): BenchmarkResult {
  const filtered = candles.filter(c => c.date >= startDate && c.date <= endDate);
  if (filtered.length < 2) {
    return { name: 'Buy & Hold SPY', sharpe: 0, maxDrawdownPct: 0, totalPnl: 0, totalReturnPct: 0, winRate: 0, trades: 0 };
  }

  const dailyReturns: number[] = [];
  let equity = startingCapital;
  let peak = equity;
  let maxDD = 0;
  let winDays = 0;

  for (let i = 1; i < filtered.length; i++) {
    const ret = (filtered[i].close - filtered[i - 1].close) / filtered[i - 1].close;
    dailyReturns.push(ret);
    equity *= (1 + ret);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
    if (ret > 0) winDays++;
  }

  const totalPnl = equity - startingCapital;
  const avgDaily = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const stdDaily = Math.sqrt(
    dailyReturns.reduce((s, r) => s + (r - avgDaily) ** 2, 0) / Math.max(1, dailyReturns.length - 1)
  );
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  return {
    name: 'Buy & Hold SPY',
    sharpe,
    maxDrawdownPct: maxDD * 100,
    totalPnl,
    totalReturnPct: (totalPnl / startingCapital) * 100,
    winRate: dailyReturns.length > 0 ? (winDays / dailyReturns.length) * 100 : 0,
    trades: 1,
  };
}

// ── 2. Mechanical ATM Put-Selling ────────────────────────

/**
 * Mechanical put-selling on SPY using the real chain-cache evaluator.
 * Generates a synthetic CALL signal every `intervalDays` trading days
 * (CALL direction → evaluator sells PUT spreads). No technical filters.
 */
export function mechanicalPutSellBenchmark(
  allTradingDates: string[],
  evaluator: TradeEvaluator,
  startDate: string,
  endDate: string,
  opts: {
    startingCapital?: number;
    maxPositions?: number;
    fillMode?: FillMode;
    intervalDays?: number;
    delta?: number;
    spreadWidth?: number;
    profitTarget?: number;
  } = {},
): BenchmarkResult {
  const {
    startingCapital = 100_000,
    maxPositions = 10,
    // Trust default: realistic fills (bid/ask + dynamic impact). 'mid' is debug-only.
    fillMode = 'bidask',
    intervalDays = 5,
    delta = 0.35,
    spreadWidth = 15,
    profitTarget = 0.30,
  } = opts;

  const dates = allTradingDates.filter(d => d >= startDate && d <= endDate);
  if (dates.length < 20) {
    return { name: 'Mechanical Put Sell', sharpe: 0, maxDrawdownPct: 0, totalPnl: 0, totalReturnPct: 0, winRate: 0, trades: 0 };
  }

  // Generate synthetic signals: sell puts on SPY every N days
  const signals: EntrySignal[] = [];
  for (let i = 0; i < dates.length; i += intervalDays) {
    signals.push({
      ticker: 'SPY',
      date: dates[i],
      direction: 'CALL', // CALL → evaluator sells PUT spreads
      score: 100,
    });
  }

  const config: SimConfig = {
    ...DEFAULT_CREDIT_CONFIG,
    creditShortDelta: delta,
    creditSpreadWidth: spreadWidth,
    creditProfitTarget: profitTarget,
    creditStopLossMultiple: 100, // no stop loss
    creditTimeStopDTE: 5,
    monitoringIntervalDays: 1,
    minIVRank: 0, // no IV filter — mechanical
    fillMode,
    slippage: fillMode === 'bidask'
      ? { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true }
      : { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
  };

  const execConfig: PortfolioExecutionConfig = {
    maxPositions,
    maxPerTicker: maxPositions, // single ticker, allow full capacity
    startingCapital,
  };

  const trades = evaluateSignalsWithConstraints(
    signals, config, execConfig, allTradingDates, endDate, evaluator,
  );

  if (trades.length === 0) {
    return { name: 'Mechanical Put Sell', sharpe: 0, maxDrawdownPct: 0, totalPnl: 0, totalReturnPct: 0, winRate: 0, trades: 0 };
  }

  const metrics = computePortfolioDailyMetrics(
    trades, allTradingDates, startDate, endDate, startingCapital,
  );
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;

  return {
    name: 'Mechanical Put Sell',
    sharpe: metrics.sharpe,
    maxDrawdownPct: metrics.maxDrawdownPct,
    totalPnl,
    totalReturnPct: (totalPnl / startingCapital) * 100,
    winRate: (wins / trades.length) * 100,
    trades: trades.length,
  };
}

// ── 3. Random Entry ──────────────────────────────────────

/**
 * Random-entry credit spreads using the real chain-cache evaluator.
 * Generates signals on random dates with random direction for SPY,
 * runs N simulations, and averages portfolio daily M2M Sharpe.
 */
export function randomEntryBenchmark(
  allTradingDates: string[],
  evaluator: TradeEvaluator,
  startDate: string,
  endDate: string,
  opts: {
    startingCapital?: number;
    maxPositions?: number;
    fillMode?: FillMode;
    nSimulations?: number;
    signalsPerSim?: number;
    delta?: number;
    spreadWidth?: number;
    profitTarget?: number;
    seed?: number;
  } = {},
): BenchmarkResult {
  const {
    startingCapital = 100_000,
    maxPositions = 10,
    // Trust default: realistic fills (bid/ask + dynamic impact). 'mid' is debug-only.
    fillMode = 'bidask',
    nSimulations = 10,
    signalsPerSim = 100,
    delta = 0.35,
    spreadWidth = 15,
    profitTarget = 0.30,
    seed = 42,
  } = opts;

  const dates = allTradingDates.filter(d => d >= startDate && d <= endDate);
  if (dates.length < 20) {
    return { name: 'Random Entry', sharpe: 0, maxDrawdownPct: 0, totalPnl: 0, totalReturnPct: 0, winRate: 0, trades: 0 };
  }

  // Seeded RNG
  let s = seed | 0 || 1;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  const config: SimConfig = {
    ...DEFAULT_CREDIT_CONFIG,
    creditShortDelta: delta,
    creditSpreadWidth: spreadWidth,
    creditProfitTarget: profitTarget,
    creditStopLossMultiple: 100,
    creditTimeStopDTE: 5,
    monitoringIntervalDays: 1,
    minIVRank: 0, // no IV filter — random
    fillMode,
    slippage: fillMode === 'bidask'
      ? { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true }
      : { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
  };

  const execConfig: PortfolioExecutionConfig = {
    maxPositions,
    maxPerTicker: maxPositions,
    startingCapital,
  };

  const sharpes: number[] = [];
  let totalWins = 0;
  let totalTrades = 0;
  let totalPnlSum = 0;
  let maxDDSum = 0;

  for (let sim = 0; sim < nSimulations; sim++) {
    // Generate random signals for SPY
    const signals: EntrySignal[] = [];
    for (let i = 0; i < signalsPerSim; i++) {
      const dateIdx = Math.floor(rng() * dates.length);
      signals.push({
        ticker: 'SPY',
        date: dates[dateIdx],
        direction: rng() > 0.5 ? 'CALL' : 'PUT',
        score: 50,
      });
    }
    // Sort by date for evaluator
    signals.sort((a, b) => a.date.localeCompare(b.date));

    const trades = evaluateSignalsWithConstraints(
      signals, config, execConfig, allTradingDates, endDate, evaluator,
    );

    if (trades.length > 0) {
      const metrics = computePortfolioDailyMetrics(
        trades, allTradingDates, startDate, endDate, startingCapital,
      );
      sharpes.push(metrics.sharpe);
      maxDDSum += metrics.maxDrawdownPct;

      const simPnl = trades.reduce((s, t) => s + t.pnl, 0);
      totalPnlSum += simPnl;
      totalWins += trades.filter(t => t.pnl > 0).length;
      totalTrades += trades.length;
    } else {
      sharpes.push(0);
    }
  }

  const avgSharpe = sharpes.length > 0
    ? sharpes.reduce((s, v) => s + v, 0) / sharpes.length : 0;
  const avgMaxDD = nSimulations > 0 ? maxDDSum / nSimulations : 0;
  const avgPnl = nSimulations > 0 ? totalPnlSum / nSimulations : 0;

  return {
    name: 'Random Entry (MC avg)',
    sharpe: avgSharpe,
    maxDrawdownPct: avgMaxDD,
    totalPnl: avgPnl,
    totalReturnPct: (avgPnl / startingCapital) * 100,
    winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
    trades: totalTrades > 0 ? Math.round(totalTrades / nSimulations) : 0,
  };
}

// ── Comparison Table ─────────────────────────────────────

export function printBenchmarkComparison(strategy: BenchmarkResult, benchmarks: BenchmarkResult[]) {
  const all = [strategy, ...benchmarks];
  console.log('\n' + '═'.repeat(85));
  console.log('  BENCHMARK COMPARISON');
  console.log('═'.repeat(85));
  console.log('  Strategy                      Sharpe   Max DD    Win Rate   Trades   Total PnL');
  console.log('  ' + '─'.repeat(83));

  for (const r of all) {
    const sharpeStr = r.sharpe.toFixed(2).padStart(6);
    const ddStr = (r.maxDrawdownPct.toFixed(1) + '%').padStart(7);
    const wrStr = (r.winRate.toFixed(1) + '%').padStart(8);
    const tradesStr = String(r.trades).padStart(7);
    const pnlStr = ('$' + r.totalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })).padStart(10);
    console.log(`  ${r.name.padEnd(30)} ${sharpeStr} ${ddStr} ${wrStr} ${tradesStr} ${pnlStr}`);
  }
  console.log('═'.repeat(85) + '\n');
}
