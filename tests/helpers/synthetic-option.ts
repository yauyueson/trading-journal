/**
 * Phase 0.c.10 — single-trade synthetic option simulator.
 *
 * Price an option with BSM at entry, settle against the spot at expiry.
 * Designed to be aggressively simple: NO exit logic, NO slippage, NO
 * commission. The only math surface under test is BSM-entry + intrinsic-
 * exit. If the aggregate P&L on zero-drift GBM input is non-zero, a sign
 * error or asymmetry is hiding in one of those two paths.
 */
import { bsmPrice } from '../../src/lib/backtest/bsm-pricing';
import type { GBMPath } from './gbm';

export type Direction = 'LONG' | 'SHORT';

export interface SyntheticTradeOpts {
  path: GBMPath;
  entryDayIdx: number;
  dteDays: number;
  strikeMoneyness: number; // K/S at entry (1.0 = ATM, 0.95 = ITM call / OTM put, etc.)
  isCall: boolean;
  direction: Direction;
  sigma: number;
  r?: number;              // annual continuous rate, default 0
}

export interface SyntheticTradeResult {
  entryIdx: number;
  exitIdx: number;
  entrySpot: number;
  exitSpot: number;
  strike: number;
  entryPremium: number;     // BSM price at entry (always positive)
  exitPayoff: number;       // intrinsic at expiry (always non-negative)
  pnl: number;              // direction × (exitPayoff - entryPremium)
}

/**
 * Settle a European option at expiry: intrinsic value, clamped at zero.
 */
export function settleOption(spotAtExpiry: number, K: number, isCall: boolean): number {
  return isCall
    ? Math.max(0, spotAtExpiry - K)
    : Math.max(0, K - spotAtExpiry);
}

/**
 * Run one synthetic trade on a GBM path. Returns null if entry+dte would
 * land past the path end.
 *
 * Time convention: the companion GBM helper uses dt = 1/252 (trading-day
 * variance), so this simulator uses T = dteDays/252 when pricing BSM. The
 * synthetic world is self-contained; the 365-day convention used by the
 * rest of the codebase doesn't need to match. Any test that mixes GBM
 * variance (per trading day) with BSM time (per calendar day) would
 * silently bias results.
 */
export function simulateSingleOptionTrade(opts: SyntheticTradeOpts): SyntheticTradeResult | null {
  const { path, entryDayIdx, dteDays, strikeMoneyness, isCall, direction, sigma } = opts;
  const r = opts.r ?? 0;
  const exitIdx = entryDayIdx + dteDays;
  if (entryDayIdx < 0 || exitIdx >= path.prices.length) return null;

  const entrySpot = path.prices[entryDayIdx];
  const exitSpot = path.prices[exitIdx];
  const strike = entrySpot * strikeMoneyness;
  const T = dteDays / 252; // trading-day convention (matches GBM's dt)

  const entryPremium = bsmPrice(entrySpot, strike, T, sigma, r, isCall);
  const exitPayoff = settleOption(exitSpot, strike, isCall);
  const sign = direction === 'LONG' ? 1 : -1;
  const pnl = sign * (exitPayoff - entryPremium);

  return { entryIdx: entryDayIdx, exitIdx, entrySpot, exitSpot, strike, entryPremium, exitPayoff, pnl };
}

/**
 * Basic stats helpers — mean + sample stderr.
 */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function stderrOfMean(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  const sd = Math.sqrt(ss / (n - 1));
  return sd / Math.sqrt(n);
}
