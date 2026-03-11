/**
 * Portfolio Correlation Stress Testing
 *
 * Measures aggregate portfolio drawdowns across a multi-ticker basket
 * using DAILY UNREALIZED P&L (from OptionTrade.dailyMtM), not just
 * terminal exit-day realized P&L.
 *
 * Why unrealized matters: A 45-day credit spread that ultimately loses $900
 * doesn't lose $900 on day 45 and $0 on days 1-44. The spread widens
 * gradually as the underlying moves against you. To measure correlation
 * between simultaneous positions, we need the daily mark-to-market.
 */

import type { OptionTrade } from './option-sim';
import type { CorrelationStressResult } from './types';

export interface DailyPnLMatrix {
  dates: string[];
  byTicker: Record<string, number[]>;   // ticker → daily CHANGE in unrealized P&L
  aggregate: number[];                    // sum across all tickers per day
}

/**
 * Build a daily P&L matrix from option trades using dailyMtM data.
 *
 * For each trade, the DAILY CHANGE in unrealized P&L is computed from
 * the dailyMtM array (populated by option-sim.ts during monitoring).
 *
 * Falls back to exit-date attribution if dailyMtM is not populated
 * (backward compatibility with old trade data).
 */
export function buildDailyPnLMatrix(
  trades: OptionTrade[],
  startDate: string,
  endDate: string,
): DailyPnLMatrix {
  // Generate trading dates (weekdays)
  const dates: string[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow > 0 && dow < 6) {
      dates.push(d.toISOString().slice(0, 10));
    }
  }

  // Build date → index lookup for O(1) access
  const dateIdx = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) dateIdx.set(dates[i], i);

  // Initialize matrix
  const tickers = [...new Set(trades.map(t => t.ticker))];
  const byTicker: Record<string, number[]> = {};
  for (const t of tickers) {
    byTicker[t] = new Array(dates.length).fill(0);
  }
  const aggregate = new Array(dates.length).fill(0);

  for (const trade of trades) {
    const tickerArr = byTicker[trade.ticker];
    if (!tickerArr) continue;

    if (trade.dailyMtM && trade.dailyMtM.length > 0) {
      // Use daily mark-to-market: compute daily CHANGE in unrealized P&L
      let prevUnrealized = 0;
      for (const mtm of trade.dailyMtM) {
        const idx = dateIdx.get(mtm.date);
        if (idx === undefined) continue;
        const dailyChange = mtm.unrealizedPnl - prevUnrealized;
        tickerArr[idx] += dailyChange;
        aggregate[idx] += dailyChange;
        prevUnrealized = mtm.unrealizedPnl;
      }
    } else {
      // Fallback: attribute full P&L to exit date (legacy behavior)
      const exitIdx = dateIdx.get(trade.exitDate);
      if (exitIdx !== undefined) {
        tickerArr[exitIdx] += trade.pnl;
        aggregate[exitIdx] += trade.pnl;
      }
    }
  }

  return { dates, byTicker, aggregate };
}

/**
 * Compute correlation stress metrics from trades.
 */
export function computeCorrelationStress(
  trades: OptionTrade[],
  startDate: string,
  endDate: string,
  startingCapital: number,
): CorrelationStressResult {
  const matrix = buildDailyPnLMatrix(trades, startDate, endDate);
  const tickers = Object.keys(matrix.byTicker);

  // Find worst aggregate day
  let worstDayLoss = 0;
  let worstDayIdx = 0;
  for (let i = 0; i < matrix.aggregate.length; i++) {
    if (matrix.aggregate[i] < worstDayLoss) {
      worstDayLoss = matrix.aggregate[i];
      worstDayIdx = i;
    }
  }

  // Count tickers in drawdown on worst day
  let tickersInDD = 0;
  const perTickerDD: Record<string, number> = {};
  for (const ticker of tickers) {
    const pnl = matrix.byTicker[ticker][worstDayIdx] ?? 0;
    perTickerDD[ticker] = pnl;
    if (pnl < 0) tickersInDD++;
  }

  // Peak correlated drawdown (cumulative equity drawdown)
  let equity = startingCapital;
  let peak = equity;
  let peakDD = 0;
  let peakDDIdx = 0;
  for (let i = 0; i < matrix.aggregate.length; i++) {
    equity += matrix.aggregate[i];
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > peakDD) {
      peakDD = dd;
      peakDDIdx = i;
    }
  }

  // Avg pairwise correlation of daily P&L
  let corrSum = 0;
  let corrCount = 0;
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const corr = pearsonCorr(matrix.byTicker[tickers[i]], matrix.byTicker[tickers[j]]);
      if (Number.isFinite(corr)) {
        corrSum += corr;
        corrCount++;
      }
    }
  }
  const avgCorr = corrCount > 0 ? corrSum / corrCount : 0;

  // Correlation penalty
  const correlationPenalty = avgCorr > 0.01
    ? peakDD * Math.sqrt(avgCorr)
    : peakDD * 0.1;

  return {
    peakCorrelatedDD: peakDD * 100,
    peakCorrelatedDDDate: matrix.dates[peakDDIdx] ?? startDate,
    tickersInDDOnWorstDay: tickersInDD,
    avgPairwiseCorrelation: avgCorr,
    worstDayLoss,
    worstDayLossDate: matrix.dates[worstDayIdx] ?? startDate,
    correlationPenalty,
    perTickerDD,
  };
}

// ── Helpers ──────────────────────────────────────────────

function pearsonCorr(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
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
