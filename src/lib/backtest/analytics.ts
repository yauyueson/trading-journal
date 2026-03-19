/**
 * Signal Quality Backtester — Analytics
 *
 * Computes all stats from a trade list: win rates, Sharpe, Sortino, Calmar,
 * drawdown, expectancy, consecutive streaks, breakdowns by direction/tier/setup,
 * MFE/MAE averages, and Monte Carlo permutation testing.
 */

import type {
  BacktestTrade,
  BacktestConfig,
  BacktestAnalytics,
  BacktestResult,
  DirectionStats,
  TierStats,
  SetupStats,
  MonteCarloResult,
  GateStats,
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

function pearsonCorr(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = avg(x), my = avg(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : 0;
}

function computeAvgSubScoreCorrelation(trades: BacktestTrade[]): number | undefined {
  const tw = trades.filter(t => t.subScores);
  if (tw.length < 10) return undefined;
  const keys = ['sc_mb', 'sc_bxs', 'sc_bxl', 'sc_ema', 'sc_mom'] as const;
  const data = keys.map(k => tw.map(t => t.subScores![k]));
  let corrSum = 0, pairs = 0;
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      corrSum += Math.abs(pearsonCorr(data[i], data[j]));
      pairs++;
    }
  }
  return corrSum / pairs;
}

/** Downside deviation: std of returns below target (0) */
function downsideDev(returns: number[]): number {
  const downside = returns.filter(r => r < 0);
  if (downside.length < 2) return 0;
  return Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / (downside.length - 1));
}

/** Max consecutive streak of wins or losses */
function maxConsecutive(trades: BacktestTrade[], isWin: boolean): number {
  let max = 0;
  let current = 0;
  for (const t of trades) {
    if ((isWin && t.rawReturn > 0) || (!isWin && t.rawReturn <= 0)) {
      current++;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
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
  totalSignals: number,
  gateStats?: GateStats,
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

  // Profit factor (cap at 999 to avoid Infinity propagation downstream)
  const grossWins = rawReturns.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLosses = Math.abs(rawReturns.filter(r => r < 0).reduce((s, r) => s + r, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;

  // Avg win/loss
  const winReturns = rawReturns.filter(r => r > 0);
  const lossReturns = rawReturns.filter(r => r < 0);

  // TP/SL breakdown
  const tpHits = trades.filter(t => t.exitType === 'TP').length;
  const slHits = trades.filter(t => t.exitType === 'SL').length;
  const timeStops = trades.filter(t => t.exitType === 'TIME_STOP').length;
  const scoreStops = trades.filter(t => t.exitType === 'SCORE_STOP').length;

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
  // Use a separate equity tracker starting at 1.0 so drawdown is computed as
  // % of peak equity rather than an absolute drop on a zero-based cumulative sum.
  // Without this, a strategy with total cumReturn=4.0 that drops 0.2 would report
  // maxDrawdown = 0.2 * 100 = 20%, which is correct — but starting from 0 means
  // early losses produce peak=0 causing division issues; starting at 1.0 is standard.
  let equity = 1.0;
  let peak = 1.0;
  let maxDrawdown = 0;

  // Sort trades by exit date for equity curve
  const sortedTrades = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  for (const t of sortedTrades) {
    cumReturn += t.rawReturn;
    equity += t.rawReturn;
    peak = Math.max(peak, equity);
    // Relative drawdown: % drop from peak equity (prevents inflated % from zero-based peak)
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, dd);
    equityCurve.push({ date: t.exitDate, cumReturn: cumReturn * 100 });
  }

  // Annualized Sharpe (assuming ~252 trading days)
  const avgHoldDaysVal = Math.max(avg(trades.map(t => t.holdDays)), 1);
  const stdVal = std(rawReturns);
  const sharpe = rawReturns.length > 1 && stdVal > 1e-10
    ? (avg(rawReturns) / stdVal) * Math.sqrt(252 / avgHoldDaysVal)
    : 0;

  // Sortino: like Sharpe but uses downside deviation only
  const dd = downsideDev(rawReturns);
  const sortino = (rawReturns.length > 1 && dd > 1e-10)
    ? (avg(rawReturns) / dd) * Math.sqrt(252 / avgHoldDaysVal)
    : 0;

  // Calmar: annualized return / max drawdown (maxDrawdown is now fraction of peak)
  const totalReturnPct = cumReturn * 100;
  const calmar = maxDrawdown > 0 ? totalReturnPct / (maxDrawdown * 100) : 0;

  // Expectancy: expected value per trade (in %)
  const wr = winRate / 100;
  const expectancy = avg(winReturns) * 100 * wr + avg(lossReturns) * 100 * (1 - wr);

  // Consecutive streaks (on chronologically sorted trades)
  const maxConsecutiveWins = maxConsecutive(sortedTrades, true);
  const maxConsecutiveLosses = maxConsecutive(sortedTrades, false);

  // BSM option return analytics — promoted to primary when all trades have optionReturn
  const useOptionReturns = trades.every(t => t.optionReturn != null);

  let optionAnalytics: Partial<BacktestAnalytics> = {};
  if (useOptionReturns) {
    const optReturns = trades.map(t => t.optionReturn!);
    const optWinsArr = optReturns.filter(r => r > 0);
    const optLossesArr = optReturns.filter(r => r < 0);
    const optGrossWins = optWinsArr.reduce((s, r) => s + r, 0);
    const optGrossLosses = Math.abs(optLossesArr.reduce((s, r) => s + r, 0));
    const optPF = optGrossLosses > 0 ? optGrossWins / optGrossLosses : optGrossWins > 0 ? 999 : 0;

    const optStdVal = std(optReturns);
    const optDownDev = downsideDev(optReturns);
    const optSharpe = optStdVal > 1e-10 ? (avg(optReturns) / optStdVal) * Math.sqrt(252 / avgHoldDaysVal) : 0;
    const optSortino = optDownDev > 1e-10 ? (avg(optReturns) / optDownDev) * Math.sqrt(252 / avgHoldDaysVal) : 0;

    const optWR = optReturns.length > 0 ? (optWinsArr.length / optReturns.length) * 100 : 0;
    const optWRFrac = optWR / 100;
    const optExpectancy = avg(optWinsArr) * 100 * optWRFrac + avg(optLossesArr) * 100 * (1 - optWRFrac);

    // Option equity curve & drawdown
    // optionReturn is per-trade premium % (e.g. +0.35 for TP, -0.30 for SL).
    // Cumulating these raw values inflates drawdown to 200%+ because the scale
    // grows with trade count. Instead, track equity starting at 1.0 and compute
    // drawdown as % of peak equity — the standard max drawdown definition.
    let optCum = 0;
    let optEquity = 1.0;
    let optPeak = 1.0;
    let optMaxDD = 0;
    const optEquityCurve: { date: string; cumReturn: number }[] = [];
    for (const t of sortedTrades) {
      optCum += t.optionReturn!;
      optEquity += t.optionReturn!;
      optPeak = Math.max(optPeak, optEquity);
      optMaxDD = Math.max(optMaxDD, optPeak > 0 ? (optPeak - optEquity) / optPeak : 0);
      optEquityCurve.push({ date: t.exitDate, cumReturn: optCum * 100 });
    }

    optionAnalytics = {
      optionMode: true,
      // Option returns become primary
      optionAvgReturn: avg(optReturns) * 100,
      optionWinRate: optWR,
      optionSharpe: isFinite(optSharpe) ? optSharpe : 0,
      optionSortino: isFinite(optSortino) ? optSortino : 0,
      optionProfitFactor: optPF,
      optionExpectancy: isFinite(optExpectancy) ? optExpectancy : 0,
      optionMaxDrawdown: optMaxDD * 100,
      optionEquityCurve: optEquityCurve,
      // Stock returns as secondary reference
      stockWinRate: winRate,
      stockAvgReturn: avg(rawReturns) * 100,
      stockSharpe: isFinite(sharpe) ? sharpe : 0,
      stockSortino: isFinite(sortino) ? sortino : 0,
      stockProfitFactor: profitFactor,
    };
  }

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
    avgHoldDays: avgHoldDaysVal,
    tpHits,
    slHits,
    timeStops,
    scoreStops,
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
    sortino: isFinite(sortino) ? sortino : 0,
    calmar: isFinite(calmar) ? calmar : 0,
    expectancy: isFinite(expectancy) ? expectancy : 0,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    gateStats,
    ...optionAnalytics,
    avgSubScoreCorrelation: computeAvgSubScoreCorrelation(trades),
    monteCarlo: trades.length >= 10 ? monteCarloPermutation(trades, 500) : undefined,
  };
}

// ── Monte Carlo Permutation Test ────────────────────────

/**
 * Shuffle trade order N times, recompute equity curves.
 * Reports percentile bands for Sharpe, max DD, final return.
 * If 5th percentile Sharpe > 0, the strategy has statistical edge.
 */
export function monteCarloPermutation(
  trades: BacktestTrade[],
  iterations: number = 500
): MonteCarloResult {
  if (trades.length < 5) {
    return {
      iterations: 0,
      sharpe: { p5: 0, p50: 0, p95: 0 },
      maxDrawdown: { p5: 0, p50: 0, p95: 0 },
      finalReturn: { p5: 0, p50: 0, p95: 0 },
      isSignificant: false,
    };
  }

  // Use option returns when all trades have BSM repricing data
  const useOption = trades.every(t => t.optionReturn != null);
  const returns = trades.map(t => useOption ? t.optionReturn! : t.rawReturn);
  const sharpes: number[] = [];
  const maxDDs: number[] = [];
  const finalReturns: number[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    // Fisher-Yates shuffle
    const shuffled = [...returns];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Compute equity curve stats on shuffled order
    let cum = 0;
    let peak = 0;
    let maxDD = 0;
    for (const r of shuffled) {
      cum += r;
      peak = Math.max(peak, cum);
      maxDD = Math.max(maxDD, peak - cum);
    }

    const mean = avg(shuffled);
    const s = std(shuffled);
    const avgHold = avg(trades.map(t => t.holdDays));
    const sh = s > 0 ? (mean / s) * Math.sqrt(252 / avgHold) : 0;

    sharpes.push(isFinite(sh) ? sh : 0);
    maxDDs.push(maxDD * 100);
    finalReturns.push(cum * 100);
  }

  // Sort for percentiles
  sharpes.sort((a, b) => a - b);
  maxDDs.sort((a, b) => a - b);
  finalReturns.sort((a, b) => a - b);

  const p = (arr: number[], pct: number) => arr[Math.floor(arr.length * pct)] ?? 0;

  const blockBoot = blockBootstrapMC(trades, iterations);

  return {
    iterations,
    sharpe: { p5: p(sharpes, 0.05), p50: p(sharpes, 0.50), p95: p(sharpes, 0.95) },
    maxDrawdown: { p5: p(maxDDs, 0.05), p50: p(maxDDs, 0.50), p95: p(maxDDs, 0.95) },
    finalReturn: { p5: p(finalReturns, 0.05), p50: p(finalReturns, 0.50), p95: p(finalReturns, 0.95) },
    isSignificant: p(sharpes, 0.05) > 0,
    blockBootstrap: blockBoot,
  };
}

/**
 * Block bootstrap Monte Carlo: resample blocks of consecutive trades.
 * Preserves autocorrelation structure (regime clustering, streaks).
 */
function blockBootstrapMC(
  trades: BacktestTrade[],
  iterations: number = 500
): MonteCarloResult['blockBootstrap'] {
  const n = trades.length;
  if (n < 10) return undefined;

  const blockSize = Math.max(3, Math.min(10, Math.floor(n / 10)));
  const useOption = trades.every(t => t.optionReturn != null);

  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const returns = sorted.map(t => useOption ? t.optionReturn! : t.rawReturn);

  // Build blocks
  const blocks: number[][] = [];
  for (let i = 0; i <= returns.length - blockSize; i += blockSize) {
    blocks.push(returns.slice(i, i + blockSize));
  }
  if (returns.length % blockSize !== 0) {
    blocks.push(returns.slice(-(returns.length % blockSize)));
  }
  if (blocks.length === 0) return undefined;

  const sharpes: number[] = [];
  const maxDDs: number[] = [];
  const finalReturns: number[] = [];
  const avgHold = avg(sorted.map(t => t.holdDays));

  for (let iter = 0; iter < iterations; iter++) {
    const resampled: number[] = [];
    while (resampled.length < n) {
      const blockIdx = Math.floor(Math.random() * blocks.length);
      resampled.push(...blocks[blockIdx]);
    }
    const sample = resampled.slice(0, n);

    let cum = 0, peak = 0, maxDD = 0;
    for (const r of sample) {
      cum += r;
      peak = Math.max(peak, cum);
      maxDD = Math.max(maxDD, peak - cum);
    }

    const mean = avg(sample);
    const s = std(sample);
    const sh = s > 0 ? (mean / s) * Math.sqrt(252 / avgHold) : 0;

    sharpes.push(isFinite(sh) ? sh : 0);
    maxDDs.push(maxDD * 100);
    finalReturns.push(cum * 100);
  }

  sharpes.sort((a, b) => a - b);
  maxDDs.sort((a, b) => a - b);
  finalReturns.sort((a, b) => a - b);

  const p = (arr: number[], pct: number) => arr[Math.floor(arr.length * pct)] ?? 0;

  return {
    blockSize,
    sharpe: { p5: p(sharpes, 0.05), p50: p(sharpes, 0.50), p95: p(sharpes, 0.95) },
    maxDrawdown: { p5: p(maxDDs, 0.05), p50: p(maxDDs, 0.50), p95: p(maxDDs, 0.95) },
    finalReturn: { p5: p(finalReturns, 0.05), p50: p(finalReturns, 0.50), p95: p(finalReturns, 0.95) },
    isSignificant: p(sharpes, 0.05) > 0,
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
  sortino: number;
  maxDrawdown: number;
  avgHoldDays: number;
  tpRate: number;
  slRate: number;
  expectancy: number;
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
    sortino: r.analytics.sortino,
    maxDrawdown: r.analytics.maxDrawdown,
    avgHoldDays: r.analytics.avgHoldDays,
    tpRate: r.analytics.totalTrades > 0 ? (r.analytics.tpHits / r.analytics.totalTrades) * 100 : 0,
    slRate: r.analytics.totalTrades > 0 ? (r.analytics.slHits / r.analytics.totalTrades) * 100 : 0,
    expectancy: r.analytics.expectancy,
  }));
}
