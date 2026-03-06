/**
 * BSM Pricing for Backtest Engine — Synthetic Options Repricing
 *
 * Provides Black-Scholes-Merton option pricing and rolling historical
 * volatility computation. Used to convert stock-price-based backtest
 * returns into realistic option returns.
 *
 * Imports normCDF from src/lib/bsm.ts (Abramowitz & Stegun, 7.5e-8 error).
 */

import { normCDF } from '../bsm';

/**
 * Full Black-Scholes-Merton option pricing.
 *
 * @param S     Current underlying price
 * @param K     Strike price
 * @param T     Time to expiration in years (DTE / 365)
 * @param sigma Implied volatility as annualized decimal (0.30 = 30%)
 * @param r     Risk-free rate as decimal (0.04 = 4%)
 * @param isCall true for call, false for put
 * @returns Option theoretical value (premium per share)
 */
export function bsmPrice(
  S: number, K: number, T: number, sigma: number, r: number, isCall: boolean
): number {
  if (T <= 0) {
    return isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  if (sigma <= 0 || S <= 0 || K <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discountK = K * Math.exp(-r * T);

  return isCall
    ? S * normCDF(d1) - discountK * normCDF(d2)
    : discountK * normCDF(-d2) - S * normCDF(-d1);
}

/**
 * BSM delta.
 * Call δ = N(d1), Put δ = N(d1) - 1.
 */
export function bsmDelta(
  S: number, K: number, T: number, sigma: number, r: number, isCall: boolean
): number {
  if (T <= 0) {
    if (isCall) return S > K ? 1 : S < K ? 0 : 0.5;
    return S < K ? -1 : S > K ? 0 : -0.5;
  }
  if (sigma <= 0 || S <= 0 || K <= 0) return isCall ? 0.5 : -0.5;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  return isCall ? normCDF(d1) : normCDF(d1) - 1;
}

/**
 * Ornstein-Uhlenbeck IV evolution (deterministic expected path).
 * sigma_exit = ivEntry × e^(-kappa×T) + theta × (1 - e^(-kappa×T))
 *
 * @param ivEntry  IV at entry (annualized decimal)
 * @param theta    Long-run mean IV (e.g. HV60)
 * @param kappa    Mean reversion speed (annualized, 4.0 = fast)
 * @param holdDays Hold period in calendar days
 * @returns Evolved IV (annualized decimal)
 */
export function ouIVEvolution(
  ivEntry: number, theta: number, kappa: number, holdDays: number
): number {
  const T = holdDays / 365;
  const decay = Math.exp(-kappa * T);
  return ivEntry * decay + theta * (1 - decay);
}

/**
 * Compute rolling historical volatility series from close prices.
 *
 * Uses log returns and population variance (÷N, matching market convention
 * in api/strategy-recommend.js _computeRV30).
 *
 * @param closes Array of daily close prices (chronological)
 * @param window Lookback window in days (default 20)
 * @returns Array of annualized vol as decimals (0.25 = 25%), same length as closes.
 *          First `window` entries are NaN (insufficient data).
 */
export function computeRollingHV(closes: number[], window: number = 20): number[] {
  const n = closes.length;
  const hv = new Array<number>(n).fill(NaN);
  if (n < window + 1) return hv;

  // Pre-compute all log returns
  const logReturns = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      logReturns[i] = Math.log(closes[i] / closes[i - 1]);
    }
  }

  const minValid = Math.max(10, Math.floor(window * 0.5));

  for (let i = window; i < n; i++) {
    // Collect log returns in [i - window + 1 ... i]
    let sum = 0;
    let count = 0;
    for (let j = i - window + 1; j <= i; j++) {
      if (!isNaN(logReturns[j])) {
        sum += logReturns[j];
        count++;
      }
    }
    if (count < minValid) continue;

    const mean = sum / count;
    let varSum = 0;
    for (let j = i - window + 1; j <= i; j++) {
      if (!isNaN(logReturns[j])) {
        varSum += (logReturns[j] - mean) ** 2;
      }
    }
    // Population variance (÷N), annualized
    hv[i] = Math.sqrt((varSum / count) * 252);
  }

  return hv;
}
