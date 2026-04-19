/**
 * Black-Scholes Math Utilities
 * ═══════════════════════════════════════════════════════════════
 * Lightweight BSM helpers for POP fallback calculations.
 * Used when market-provided probabilities (probITMAtBE, deltaAtBE) are unavailable.
 */

/**
 * Normal CDF via Abramowitz & Stegun rational erf approximation (7.1.26),
 * using N(x) = 0.5 · (1 + erf(x/√2)). Max error on erf is 1.5e-7; CDF
 * accuracy is within that.
 *
 * Phase 0.c.8 (2026-04-19): this function previously mixed 7.1.26 erf
 * coefficients with a 26.2.17-style direct-CDF form (using exp(-x²/2) and
 * dividing by √(2π)). The result was N(0) = 0.601 (vs. correct 0.5) and
 * N(1) = 0.897 (vs. 0.8413) — every BSM price/delta in the project was
 * materially wrong. The project's internal-parity tests (put-call, delta
 * reciprocal) passed because those identities hold for ANY consistent-
 * but-wrong CDF. The bug was first detected by the QuantLib grid fixture
 * in tests/bsm-quantlib-parity.test.ts.
 */
export function normCDF(x: number): number {
    if (x < -8) return 0;
    if (x > 8) return 1;
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    // Scale |x| by 1/√2 so the A&S 7.1.26 polynomial approximates erf(|x|/√2).
    const absX = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * absX);
    const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
    const erf = 1.0 - poly * Math.exp(-absX * absX);
    return 0.5 * (1.0 + sign * erf);
}

/**
 * BSM N(d2) — risk-neutral probability that the option expires ITM.
 *
 * d2 = (ln(S/K) - 0.5 * σ² * T) / (σ * √T)   [with r≈0 for short-dated options]
 *
 * For a call: P(ITM at expiry) ≈ N(d2)
 * For a put:  P(ITM at expiry) ≈ N(-d2) = 1 - N(d2)
 *
 * @param S  - Current underlying price
 * @param K  - Strike price (or breakeven price)
 * @param T  - Time to expiration in years (dte / 365)
 * @param sigma - Implied volatility as a decimal (0.30 = 30%)
 * @returns N(d2), the BSM probability of expiring ITM for a call
 */
export function bsmN2(S: number, K: number, T: number, sigma: number): number {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0.5;
    const d2 = (Math.log(S / K) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
    return normCDF(d2);
}
