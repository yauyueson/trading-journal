/**
 * Normal CDF via Abramowitz & Stegun rational erf approximation (7.1.26):
 * N(x) = 0.5 · (1 + erf(x/√2)). Max error on erf is 1.5e-7.
 *
 * Shared between strategy-recommend.js and option-prices.js.
 *
 * Phase 0.c.8 (2026-04-19): fixed. Previous implementation mixed 7.1.26
 * erf coefficients with a 26.2.17-style direct-CDF form using exp(-x²/2),
 * giving N(0) = 0.601 (vs 0.5) and N(1) = 0.897 (vs 0.8413). All BSM
 * prices/deltas produced by the API routes were materially wrong. The
 * TypeScript copy at src/lib/bsm.ts had the same bug; both fixed together.
 * Caught by the QuantLib parity fixture in tests/bsm-quantlib-parity.test.ts.
 */
export function normCDF(x) {
    if (x < -8) return 0;
    if (x > 8) return 1;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    // Scale |x| by 1/√2 so the A&S 7.1.26 polynomial approximates erf(|x|/√2).
    const absX = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * absX);
    const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
    const erf = 1.0 - poly * Math.exp(-absX * absX);
    return 0.5 * (1.0 + sign * erf);
}

/**
 * BSM delta: Call = N(d1), Put = N(d1) - 1
 * d1 = (ln(S/K) + (r + 0.5*σ²)*T) / (σ*√T)
 *
 * Phase 0.c.8 (2026-04-19): added risk-free rate parameter. Previous
 * signature omitted r entirely, so delta diverged from the vendor's
 * rate-inclusive delta for longer-dated / higher-rate options. The
 * api/option-prices.js::validateGreeks() path auto-overrode any vendor
 * delta differing by >0.15, which could replace a correct vendor delta
 * with a worse approximation on LEAPS. Default r=0.045 matches current
 * US short-rate conventions in the project.
 */
export function bsmDelta(S, K, T, sigma, isCall, r = 0.045) {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return isCall ? 0.5 : -0.5;
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    return isCall ? normCDF(d1) : normCDF(d1) - 1;
}

/**
 * BSM P(S > K at expiry) via N(d2). Uses risk-free rate for accurate POP at longer DTE.
 * d2 = (ln(S/K) + (r - 0.5*sigma^2)*T) / (sigma*sqrt(T))
 */
export function bsmN2(S, K, T, sigma, r = 0.045) {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0.5;
    const d2 = (Math.log(S / K) + (r - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    return normCDF(d2);
}
