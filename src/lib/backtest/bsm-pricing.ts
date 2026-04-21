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
 * Full Black-Scholes-Merton option pricing with optional dividend yield.
 *
 * @param S     Current underlying price
 * @param K     Strike price
 * @param T     Time to expiration in years (DTE / 365)
 * @param sigma Implied volatility as annualized decimal (0.30 = 30%)
 * @param r     Risk-free rate as decimal (0.04 = 4%)
 * @param isCall true for call, false for put
 * @param q     Dividend yield as annualized continuous decimal (0.014 = 1.4% SPY).
 *              Optional, default 0. Added in Phase 0.c.9 for BXM replication —
 *              SPY pays ~1.4%, and ignoring it biases prices and deltas.
 *              All pre-Phase-0.c.9 callers rely on the q=0 default and keep
 *              their existing behavior.
 * @returns Option theoretical value (premium per share)
 *
 * Formula (Merton 1973 generalization):
 *   d1 = (ln(S/K) + (r − q + 0.5σ²)·T) / (σ·√T)
 *   d2 = d1 − σ·√T
 *   C  = S·e^{−qT}·N(d1) − K·e^{−rT}·N(d2)
 *   P  = K·e^{−rT}·N(−d2) − S·e^{−qT}·N(−d1)
 *   Parity: C − P = S·e^{−qT} − K·e^{−rT}.
 */
export function bsmPrice(
  S: number, K: number, T: number, sigma: number, r: number, isCall: boolean, q: number = 0,
): number {
  if (T <= 0) {
    return isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  if (sigma <= 0 || S <= 0 || K <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discountK = K * Math.exp(-r * T);
  const discountS = S * Math.exp(-q * T);

  return isCall
    ? discountS * normCDF(d1) - discountK * normCDF(d2)
    : discountK * normCDF(-d2) - discountS * normCDF(-d1);
}

/**
 * Verify put-call parity holds for a single (S, K, T, σ, r) point.
 *
 * Parity: C − P = S − K·e^{-rT}. Rearranged: residual = C − P − (S − K·e^{-rT}).
 * A correct BSM formula produces residual ~ 0 modulo numerical noise.
 *
 * This is a PROPERTY validator intended for tests, not a runtime check.
 * Calling it in production would double the cost of every BSM price; the
 * engine is already anchored to QuantLib via tests/bsm-quantlib-parity.test.ts.
 *
 * @param tolerance maximum |residual|. Default 1e-8 is achievable at q=0,
 *   where the identity N(x)+N(−x)=1 cancels the A&S erf approximation
 *   error (1.5e-7) through the ds·N(d1) − ds·N(−d1) structure exactly.
 *   For q>0 the cancellation imperfectly tracks the approximation and
 *   residuals can reach ~1e-7 at S~100. Callers with q>0 should pass a
 *   tolerance of ~1e-6.
 */
export function checkPutCallParity(
  S: number, K: number, T: number, sigma: number, r: number, tolerance = 1e-8, q: number = 0,
): { ok: true; residual: number } | { ok: false; residual: number; reason: string } {
  const call = bsmPrice(S, K, T, sigma, r, true, q);
  const put = bsmPrice(S, K, T, sigma, r, false, q);
  // Merton-generalized parity: C − P = S·e^{−qT} − K·e^{−rT}.
  const expected = S * Math.exp(-q * T) - K * Math.exp(-r * T);
  const residual = call - put - expected;
  if (Math.abs(residual) > tolerance) {
    return {
      ok: false,
      residual,
      reason: `put-call parity violation at S=${S} K=${K} T=${T} σ=${sigma} r=${r} q=${q}: ` +
        `residual=${residual.toExponential(3)} (tolerance ${tolerance.toExponential(1)}).`,
    };
  }
  return { ok: true, residual };
}

/**
 * BSM delta with optional dividend yield.
 *
 * With q > 0:
 *   d1 = (ln(S/K) + (r − q + 0.5σ²)·T) / (σ·√T)
 *   Call δ = e^{−qT}·N(d1), Put δ = e^{−qT}·(N(d1) − 1).
 * With q = 0 (default): reduces to the standard form.
 */
export function bsmDelta(
  S: number, K: number, T: number, sigma: number, r: number, isCall: boolean, q: number = 0,
): number {
  if (T <= 0) {
    if (isCall) return S > K ? 1 : S < K ? 0 : 0.5;
    return S < K ? -1 : S > K ? 0 : -0.5;
  }
  if (sigma <= 0 || S <= 0 || K <= 0) return isCall ? 0.5 : -0.5;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const eqT = Math.exp(-q * T);
  return isCall ? eqT * normCDF(d1) : eqT * (normCDF(d1) - 1);
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
