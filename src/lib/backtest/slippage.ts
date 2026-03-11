/**
 * Dynamic Slippage Model
 *
 * Computes adverse fill impact based on:
 *   1. Natural bid/ask spread (half-spread baseline)
 *   2. Open interest (liquidity depth — lower OI → wider effective spread)
 *   3. DTE (near-expiry options have wider effective spreads)
 *   4. Base impact (minimum market impact in bps)
 *
 * Formula:
 *   impact = halfSpread + baseImpact × oiFactor × dteFactor
 *
 * Where:
 *   halfSpread = (ask - bid) / 2
 *   oiFactor   = 1 + oiHalfLife / max(oi, 1)    (hyperbolic: OI→∞ gives 1, OI=0 gives big)
 *   dteFactor  = 1 + max(0, (accelDays - dte) / accelDays) × (accelMult - 1)
 *   baseImpact = mid × baseImpactBps / 10000
 */

import type { DynamicSlippageConfig, FillMode } from './types';

export interface FillResult {
  fillPrice: number;
  slippage: number;    // absolute $ adverse impact vs mid
}

/**
 * Compute the adverse slippage amount in dollars for a single leg.
 *
 * @param cfg     Dynamic slippage config
 * @param spread  Bid/ask spread in dollars (ask - bid)
 * @param oi      Open interest for this strike/expiry/type
 * @param dte     Days to expiration
 * @param mid     Mid price of the option
 * @returns       Slippage in dollars (always >= 0)
 */
export function computeSlippage(
  cfg: DynamicSlippageConfig,
  spread: number,
  oi: number,
  dte: number,
  mid: number,
): number {
  if (!cfg.enabled) return 0;

  const halfSpread = Math.max(0, spread) / 2;

  // Base market impact in dollars
  const baseImpact = Math.abs(mid) * cfg.baseImpactBps / 10000;

  // OI factor: hyperbolic decay — low OI amplifies impact
  const effectiveOI = Math.max(oi, 1);
  const oiFactor = 1 + cfg.oiHalfLife / effectiveOI;

  // DTE acceleration: linear ramp inside accelDays window
  let dteFactor = 1;
  if (cfg.dteAccelDays > 0 && dte < cfg.dteAccelDays) {
    const proximity = (cfg.dteAccelDays - dte) / cfg.dteAccelDays;
    dteFactor = 1 + proximity * (cfg.dteAccelMultiplier - 1);
  }

  return halfSpread + baseImpact * oiFactor * dteFactor;
}

/**
 * Apply fill logic to a single option leg.
 *
 * @param fillMode  'mid' (legacy) or 'bidask' (realistic)
 * @param mid       Mid price
 * @param bid       Bid price
 * @param ask       Ask price
 * @param side      'buy' (pay ask + impact) or 'sell' (receive bid - impact)
 * @param cfg       Slippage config
 * @param oi        Open interest
 * @param dte       Days to expiration
 * @returns         Fill result with actual fill price and slippage amount
 */
export function applyFill(
  fillMode: FillMode,
  mid: number,
  bid: number,
  ask: number,
  side: 'buy' | 'sell',
  cfg: DynamicSlippageConfig,
  oi: number,
  dte: number,
): FillResult {
  if (fillMode === 'mid' || !cfg.enabled) {
    return { fillPrice: mid, slippage: 0 };
  }

  const spread = Math.max(0, ask - bid);
  const impact = computeSlippage(cfg, spread, oi, dte, mid);

  if (side === 'sell') {
    // Selling: fill at bid, minus additional impact beyond half-spread
    const fillPrice = Math.max(0, bid - (impact - spread / 2));
    return { fillPrice, slippage: mid - fillPrice };
  } else {
    // Buying: fill at ask, plus additional impact beyond half-spread
    const fillPrice = ask + (impact - spread / 2);
    return { fillPrice, slippage: fillPrice - mid };
  }
}
