/**
 * Standard normal CDF approximation (Abramowitz & Stegun, max error 7.5e-8).
 * Shared between strategy-recommend.js and option-prices.js.
 */
export function normCDF(x) {
    if (x < -8) return 0;
    if (x > 8) return 1;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1.0 / (1.0 + p * Math.abs(x));
    const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
    const cdf = 1.0 - poly * Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
    return 0.5 * (1.0 + sign * (2 * cdf - 1));
}

/**
 * BSM delta: Call = N(d1), Put = N(d1) - 1
 * d1 = (ln(S/K) + 0.5*sigma^2*T) / (sigma*sqrt(T))
 */
export function bsmDelta(S, K, T, sigma, isCall) {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return isCall ? 0.5 : -0.5;
    const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
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
