/**
 * Signal Quality Backtester — Analytics
 *
 * Computes all stats from a trade list: win rates, Sharpe, drawdown,
 * breakdowns by direction/tier/setup, MFE/MAE averages.
 */

import type {
  BacktestTrade,
  BacktestConfig,
  BacktestAnalytics,
  BacktestResult,
  DirectionStats,
  TierStats,
  SetupStats,
} from './types';

// ── Helpers ─────────────────────────────────────────────

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function directionStats(trades: BacktestTrade[]): DirectionStats {
  if (trades.length === 0) return { count: 0, winRate: 0, avgReturn: 0, avgReturnTheta: 0 };
  const wins = trades.filter(t => t.rawReturn > 0).length;
  return {
    count: trades.length,
    winRate: (wins / trades.length) * 100,
    avgReturn: avg(trades.map(t => t.rawReturn)) * 100,
    avgReturnTheta: avg(trades.map(t => t.thetaAdjReturn)) * 100,
  };
}

function tierStats(trades: BacktestTrade[]): TierStats {
  if (trades.length === 0) return { count: 0, winRate: 0, avgReturn: 0, avgReturnTheta: 0, avgHoldDays: 0 };
  const wins = trades.filter(t => t.rawReturn > 0).length;
  return {
    count: trades.length,
    winRate: (wins / trades.length) * 100,
    avgReturn: avg(trades.map(t => t.rawReturn)) * 100,
    avgReturnTheta: avg(trades.map(t => t.thetaAdjReturn)) * 100,
    avgHoldDays: avg(trades.map(t => t.holdDays)),
  };
}

function setupStats(trades: BacktestTrade[]): SetupStats {
  if (trades.length === 0) return { count: 0, winRate: 0, avgReturn: 0, avgReturnTheta: 0, avgHoldDays: 0, tpHits: 0, slHits: 0, timeStops: 0 };
  const wins = trades.filter(t => t.rawReturn > 0).length;
  return {
    count: trades.length,
    winRate: (wins / trades.length) * 100,
    avgReturn: avg(trades.map(t => t.rawReturn)) * 100,
    avgReturnTheta: avg(trades.map(t => t.thetaAdjReturn)) * 100,
    avgHoldDays: avg(trades.map(t => t.holdDays)),
    tpHits: trades.filter(t => t.exitType === 'TP').length,
    slHits: trades.filter(t => t.exitType === 'SL').length,
    timeStops: trades.filter(t => t.exitType === 'TIME_STOP').length,
  };
}

// ── Main Analytics ──────────────────────────────────────

export function computeAnalytics(
  trades: BacktestTrade[],
  config: BacktestConfig,
  totalSignals: number
): BacktestAnalytics {
  const n = trades.length;

  // Win rates
  const rawWins = trades.filter(t => t.rawReturn > 0);
  const thetaWins = trades.filter(t => t.thetaAdjReturn > 0);
  const winRate = n > 0 ? (rawWins.length / n) * 100 : 0;
  const winRateTheta = n > 0 ? (thetaWins.length / n) * 100 : 0;

  // Returns
  const rawReturns = trades.map(t => t.rawReturn);
  const thetaReturns = trades.map(t => t.thetaAdjReturn);

  // Profit factor
  const grossWins = rawReturns.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLosses = Math.abs(rawReturns.filter(r => r < 0).reduce((s, r) => s + r, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  // Avg win/loss
  const winReturns = rawReturns.filter(r => r > 0);
  const lossReturns = rawReturns.filter(r => r < 0);

  // TP/SL breakdown
  const tpHits = trades.filter(t => t.exitType === 'TP').length;
  const slHits = trades.filter(t => t.exitType === 'SL').length;
  const timeStops = trades.filter(t => t.exitType === 'TIME_STOP').length;

  // By direction
  const callTrades = trades.filter(t => t.direction === 'CALL');
  const putTrades = trades.filter(t => t.direction === 'PUT');

  // By tier
  const sTrades = trades.filter(t => t.tier === 'S');
  const aTrades = trades.filter(t => t.tier === 'A');
  const bTrades = trades.filter(t => t.tier === 'B');

  // By setup
  const bySetup: Record<string, SetupStats> = {};
  const setupNames = [...new Set(trades.map(t => t.setup))];
  for (const name of setupNames) {
    bySetup[name] = setupStats(trades.filter(t => t.setup === name));
  }

  // MFE/MAE averages per window
  const avgMfe: Record<number, number> = {};
  const avgMae: Record<number, number> = {};
  for (const w of config.mfeWindows) {
    const mfeVals = trades.map(t => t.mfe[w]).filter(v => v !== undefined);
    const maeVals = trades.map(t => t.mae[w]).filter(v => v !== undefined);
    avgMfe[w] = avg(mfeVals) * 100;
    avgMae[w] = avg(maeVals) * 100;
  }

  // Equity curve + Sharpe + max drawdown
  const equityCurve: { date: string; cumReturn: number }[] = [];
  let cumReturn = 0;
  let peak = 0;
  let maxDrawdown = 0;

  // Sort trades by exit date for equity curve
  const sortedTrades = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  for (const t of sortedTrades) {
    cumReturn += t.rawReturn;
    peak = Math.max(peak, cumReturn);
    const dd = peak - cumReturn;
    maxDrawdown = Math.max(maxDrawdown, dd);
    equityCurve.push({ date: t.exitDate, cumReturn: cumReturn * 100 });
  }

  // Annualized Sharpe (assuming ~252 trading days)
  const sharpe = rawReturns.length > 1
    ? (avg(rawReturns) / std(rawReturns)) * Math.sqrt(252 / avg(trades.map(t => t.holdDays)))
    : 0;

  return {
    totalSignals,
    totalTrades: n,
    winRate,
    winRateTheta,
    avgReturn: avg(rawReturns) * 100,
    avgReturnTheta: avg(thetaReturns) * 100,
    profitFactor,
    avgWin: avg(winReturns) * 100,
    avgLoss: avg(lossReturns) * 100,
    avgHoldDays: avg(trades.map(t => t.holdDays)),
    tpHits,
    slHits,
    timeStops,
    callStats: directionStats(callTrades),
    putStats: directionStats(putTrades),
    tierS: tierStats(sTrades),
    tierA: tierStats(aTrades),
    tierB: tierStats(bTrades),
    bySetup,
    avgMfe,
    avgMae,
    equityCurve,
    sharpe: isFinite(sharpe) ? sharpe : 0,
    maxDrawdown: maxDrawdown * 100,
  };
}

// ── Sweep Comparison ────────────────────────────────────

export interface ComparisonRow {
  config: BacktestConfig;
  trades: number;
  winRate: number;
  winRateTheta: number;
  avgReturn: number;
  avgReturnTheta: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdown: number;
  avgHoldDays: number;
  tpRate: number;
  slRate: number;
}

export function buildComparisonTable(results: BacktestResult[]): ComparisonRow[] {
  return results.map(r => ({
    config: r.config,
    trades: r.analytics.totalTrades,
    winRate: r.analytics.winRate,
    winRateTheta: r.analytics.winRateTheta,
    avgReturn: r.analytics.avgReturn,
    avgReturnTheta: r.analytics.avgReturnTheta,
    profitFactor: r.analytics.profitFactor,
    sharpe: r.analytics.sharpe,
    maxDrawdown: r.analytics.maxDrawdown,
    avgHoldDays: r.analytics.avgHoldDays,
    tpRate: r.analytics.totalTrades > 0 ? (r.analytics.tpHits / r.analytics.totalTrades) * 100 : 0,
    slRate: r.analytics.totalTrades > 0 ? (r.analytics.slHits / r.analytics.totalTrades) * 100 : 0,
  }));
}
