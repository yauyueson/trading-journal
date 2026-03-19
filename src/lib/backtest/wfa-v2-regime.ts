/**
 * WFA v2 Regime Analysis
 *
 * VIX-based regime classification and per-regime metrics.
 * Diagnostic only — does NOT drive optimization.
 */

import type { OptionTrade } from './option-sim';
import type { VIXRegime, RegimeClassification, PerRegimeMetrics } from './wfa-v2-types';

// ── VIX Classification ──────────────────────────────────

/** Classify a VIX level into a regime */
export function classifyVIX(vixClose: number): VIXRegime {
  if (vixClose < 20) return 'low';
  if (vixClose < 30) return 'mid';
  return 'high';
}

/**
 * Build a date → regime lookup from VIX daily data.
 * VIX data can come from Tiingo stock_candles or ORATS SPY IV30 as proxy.
 */
export function buildRegimeLookup(
  vixData: { date: string; close: number }[],
): Map<string, RegimeClassification> {
  const lookup = new Map<string, RegimeClassification>();
  for (const row of vixData) {
    lookup.set(row.date, {
      date: row.date,
      vixClose: row.close,
      regime: classifyVIX(row.close),
    });
  }
  return lookup;
}

/**
 * Find the regime for a given date by searching for the nearest prior date.
 */
function findRegime(lookup: Map<string, RegimeClassification>, date: string): RegimeClassification | null {
  // Exact match
  const exact = lookup.get(date);
  if (exact) return exact;

  // Search backwards up to 5 days for weekends/holidays
  const d = new Date(date);
  for (let i = 1; i <= 5; i++) {
    d.setDate(d.getDate() - 1);
    const key = d.toISOString().slice(0, 10);
    const found = lookup.get(key);
    if (found) return found;
  }
  return null;
}

// ── Per-Regime Metrics ──────────────────────────────────

/**
 * Classify each trade's entry date into a VIX regime and compute
 * per-regime performance metrics.
 */
export function computeRegimeMetrics(
  trades: OptionTrade[],
  vixLookup: Map<string, RegimeClassification>,
  startingCapital: number = 100_000,
): PerRegimeMetrics[] {
  const regimes: VIXRegime[] = ['low', 'mid', 'high'];
  const buckets = new Map<VIXRegime, OptionTrade[]>();
  for (const r of regimes) buckets.set(r, []);

  // Classify trades
  for (const trade of trades) {
    const rc = findRegime(vixLookup, trade.entryDate);
    const regime = rc?.regime ?? 'mid'; // default to mid if VIX data missing
    buckets.get(regime)!.push(trade);
  }

  return regimes.map(regime => {
    const bucket = buckets.get(regime)!;
    if (bucket.length === 0) {
      return {
        regime,
        tradeCount: 0,
        sharpe: 0,
        winRate: 0,
        avgPnl: 0,
        maxDD: 0,
        avgHoldDays: 0,
        totalPnl: 0,
      };
    }

    const returns = bucket.map(t => t.pnlPct);
    const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const std = Math.sqrt(
      returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / Math.max(1, returns.length - 1)
    );
    const avgHoldDays = bucket.reduce((s, t) => s + t.holdDays, 0) / bucket.length;
    const tradesPerYear = 252 / Math.max(1, avgHoldDays);
    const sharpe = std > 0 ? (avgReturn / std) * Math.sqrt(tradesPerYear) : 0;

    // Max drawdown
    const sorted = [...bucket].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
    let equity = startingCapital;
    let peak = equity;
    let maxDD = 0;
    for (const t of sorted) {
      equity += t.pnl;
      peak = Math.max(peak, equity);
      if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
    }

    const winners = bucket.filter(t => t.pnl > 0);
    const totalPnl = bucket.reduce((s, t) => s + t.pnl, 0);

    return {
      regime,
      tradeCount: bucket.length,
      sharpe,
      winRate: winners.length / bucket.length * 100,
      avgPnl: totalPnl / bucket.length,
      maxDD: maxDD * 100,
      avgHoldDays,
      totalPnl,
    };
  });
}
