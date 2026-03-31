/**
 * Synthetic Repricing — Layered fallback when exact chain strike is missing
 *
 * When a monitoring day's ORATS chain doesn't include the exact strike
 * (deep OTM contracts dropping off), this module provides:
 *
 * 1. Same-day interpolation from neighboring strikes
 * 2. BSM repricing with last known IV
 * 3. BSM repricing with OU-evolved IV from entry
 *
 * Each layer is tried in order; the first success is used.
 * The repricing method is tracked for auditability.
 */

import type { ChainRow, StrikeMatch } from './chain-cache';
import { findNeighborStrikes, hasExpiryOnDate } from './chain-cache';
import { bsmPrice, bsmDelta, ouIVEvolution } from './bsm-pricing';

export type RepricingMethod = 'exact' | 'interpolated' | 'bsm_last_iv' | 'bsm_ou_iv';

export interface SyntheticLeg extends StrikeMatch {
  repricingMethod: RepricingMethod;
}

export interface LegFallbackContext {
  ticker: string;
  date: string;
  strike: number;
  expiry: string;
  type: 'Call' | 'Put';
  entryIV: number;
  entryDate: string;
  /** Last observed IV for this leg (updated each monitoring day) */
  lastValidIV: number | null;
  /** Long-run mean for OU evolution: oratsIV60 or hv60 or entry IV */
  ivTheta: number;
  /** OU mean-reversion speed */
  kappa: number;
  /** Risk-free rate */
  r: number;
}

/**
 * Attempt to reprice a missing leg using the layered fallback.
 * Returns null only when no fallback is possible (hard NO_CHAIN).
 */
export function syntheticRepriceLeg(
  ctx: LegFallbackContext,
  stockPrice: number | null,
): SyntheticLeg | null {
  // Layer 1: Interpolation from same-day neighboring strikes
  const interpolated = tryInterpolateLeg(ctx, stockPrice);
  if (interpolated) return interpolated;

  // Layer 2: BSM with last known IV
  if (ctx.lastValidIV != null && ctx.lastValidIV > 0 && stockPrice != null && stockPrice > 0) {
    return bsmRepriceLeg(ctx, stockPrice, ctx.lastValidIV, 'bsm_last_iv');
  }

  // Layer 3: BSM with OU-evolved IV from entry
  if (ctx.entryIV > 0 && stockPrice != null && stockPrice > 0) {
    const holdDays = daysBetween(ctx.entryDate, ctx.date);
    const evolvedIV = ouIVEvolution(ctx.entryIV, ctx.ivTheta, ctx.kappa, holdDays);
    if (evolvedIV > 0) {
      return bsmRepriceLeg(ctx, stockPrice, evolvedIV, 'bsm_ou_iv');
    }
  }

  // Hard NO_CHAIN — insufficient data for any fallback
  return null;
}

/**
 * Try interpolation from neighboring strikes on the same date/expiry.
 */
function tryInterpolateLeg(
  ctx: LegFallbackContext,
  fallbackStockPrice: number | null,
): SyntheticLeg | null {
  // Check chain exists for this date+expiry at all
  if (!hasExpiryOnDate(ctx.ticker, ctx.date, ctx.expiry)) return null;

  const { below, above, stockPrice: neighborStockPrice } = findNeighborStrikes(
    ctx.ticker, ctx.date, ctx.strike, ctx.expiry,
  );

  if (!below && !above) return null;

  const sp = neighborStockPrice ?? fallbackStockPrice;
  if (sp == null || sp <= 0) return null;

  const isCall = ctx.type === 'Call';

  // If only one neighbor, extrapolate from it using BSM
  if (!below || !above) {
    const neighbor = (below ?? above)!;
    const neighborIV = isCall ? neighbor.call_iv : neighbor.put_iv;
    if (neighborIV > 0) {
      return bsmRepriceLeg(ctx, sp, neighborIV, 'interpolated');
    }
    return null;
  }

  // Both neighbors available — linear interpolation
  const belowIV = isCall ? below.call_iv : below.put_iv;
  const aboveIV = isCall ? above.call_iv : above.put_iv;

  if (belowIV <= 0 && aboveIV <= 0) return null;

  // Use the valid one if only one is available
  let interpIV: number;
  if (belowIV <= 0) {
    interpIV = aboveIV;
  } else if (aboveIV <= 0) {
    interpIV = belowIV;
  } else {
    // Linear interpolation by strike distance
    const totalDist = above.strike - below.strike;
    const frac = totalDist > 0 ? (ctx.strike - below.strike) / totalDist : 0.5;
    interpIV = belowIV + frac * (aboveIV - belowIV);
  }

  if (interpIV <= 0) return null;

  return bsmRepriceLeg(ctx, sp, interpIV, 'interpolated');
}

/**
 * Price a leg using BSM given a stock price and IV.
 */
function bsmRepriceLeg(
  ctx: LegFallbackContext,
  stockPrice: number,
  iv: number,
  method: RepricingMethod,
): SyntheticLeg {
  const dte = daysBetween(ctx.date, ctx.expiry);
  const T = Math.max(dte, 0) / 365;
  const isCall = ctx.type === 'Call';

  const price = bsmPrice(stockPrice, ctx.strike, T, iv, ctx.r, isCall);
  const delta = bsmDelta(stockPrice, ctx.strike, T, iv, ctx.r, isCall);

  // Synthesize a ChainRow with the BSM-derived values
  const syntheticRow: ChainRow = {
    ticker: ctx.ticker,
    trade_date: ctx.date,
    expir_date: ctx.expiry,
    dte,
    strike: ctx.strike,
    stock_price: stockPrice,
    call_bid: isCall ? price * 0.95 : 0,
    call_mid: isCall ? price : 0,
    call_ask: isCall ? price * 1.05 : 0,
    call_iv: isCall ? iv : 0,
    call_volume: 0,
    call_oi: 0,
    put_bid: !isCall ? price * 0.95 : 0,
    put_mid: !isCall ? price : 0,
    put_ask: !isCall ? price * 1.05 : 0,
    put_iv: !isCall ? iv : 0,
    put_volume: 0,
    put_oi: 0,
    delta: isCall ? delta : delta + 1, // ChainRow stores call-side delta
    gamma: 0,
    theta: 0,
    vega: 0,
  };

  return {
    row: syntheticRow,
    type: ctx.type,
    bid: isCall ? syntheticRow.call_bid : syntheticRow.put_bid,
    ask: isCall ? syntheticRow.call_ask : syntheticRow.put_ask,
    mid: price,
    iv,
    delta: isCall ? delta : delta, // signed delta
    volume: 0,
    oi: 0,
    repricingMethod: method,
  };
}

function daysBetween(dateA: string, dateB: string): number {
  return Math.round(
    (new Date(dateB).getTime() - new Date(dateA).getTime()) / 86400000,
  );
}
