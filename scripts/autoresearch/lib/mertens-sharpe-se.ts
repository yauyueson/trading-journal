/**
 * Mertens (2002) closed-form standard error for the Sharpe ratio with
 * optional correction for effective sample size.
 *
 * Reference: Elmar Mertens, "Comments on variance of the IID estimator
 * in Lo (2002)" (2002). The formula accounts for departures from
 * normality (skewness, kurtosis) that the textbook `1/√T` normal-returns
 * SE misses:
 *
 *   SE(SR_hat) = √((1 + ½·SR² − SR·γ₃ + ¼·(γ₄−3)·SR²) / T_eff)
 *
 *   where SR is the un-annualized Sharpe on `returns`,
 *   γ₃ is the sample skewness, γ₄ is the sample kurtosis (raw,
 *   not excess — we subtract 3 internally).
 *
 * Annualized SE is obtained by multiplying by √252 (or the supplied
 * `annualizationFactor`), matching the annualization of the SR itself.
 *
 * We pass T_eff = N_eff (from `computeEffectiveSampleSize`) when the
 * caller wants an autocorrelation-adjusted SE. Passing T_eff = n
 * recovers the IID formula.
 *
 * Phase 2.c (2026-04-20): Ships as a DIAGNOSTIC alongside the bootstrap
 * CI — it gives humans a closed-form SE to compare against the
 * bootstrap-CI-derived SE. If they diverge materially, something is
 * wrong (either the bootstrap is under-covering or the parametric SE
 * is biased by extreme higher moments). Does NOT yet drive deflated
 * Sharpe; promoting it to authoritative is a separate policy change.
 */
export interface MertensSharpeSE {
  /** Un-annualized Sharpe (mean/std of input returns). */
  sharpe: number;
  /** Un-annualized Mertens SE. */
  se: number;
  /** Annualized Sharpe = sharpe * √annualizationFactor. */
  annualizedSharpe: number;
  /** Annualized SE = se * √annualizationFactor. */
  annualizedSe: number;
  /** Sample skewness (γ₃). */
  skewness: number;
  /** Sample kurtosis (γ₄, raw — not excess). */
  kurtosis: number;
  /** Effective sample size used in the formula. */
  tEff: number;
}

export function computeMertensSharpeSE(
  returns: number[],
  tEff: number,
  annualizationFactor = 252,
): MertensSharpeSE {
  const n = returns.length;
  const empty: MertensSharpeSE = {
    sharpe: 0, se: 0, annualizedSharpe: 0, annualizedSe: 0,
    skewness: 0, kurtosis: 3, tEff,
  };
  if (n < 3 || !(tEff > 1)) return empty;

  const mean = returns.reduce((s, x) => s + x, 0) / n;
  const dev = returns.map(r => r - mean);
  const m2 = dev.reduce((s, x) => s + x * x, 0) / n;
  // Guard against a near-constant series: naive `m2 > 0` admits floating-
  // point residue (e.g. [0.05, 0.05, 0.05] accumulates a non-zero m2 of
  // ~1e-18 from 0.05's inexact binary representation). Treat variance as
  // zero when it's vanishingly small relative to the squared mean, or
  // absolutely below machine epsilon on typical return scales.
  const varFloor = Math.max(1e-30, 1e-12 * mean * mean);
  if (!(m2 > varFloor) || !Number.isFinite(m2)) return empty;
  const sd = Math.sqrt(m2);
  const m3 = dev.reduce((s, x) => s + x * x * x, 0) / n;
  const m4 = dev.reduce((s, x) => s + x * x * x * x, 0) / n;
  const skewness = m3 / Math.pow(m2, 1.5);
  const kurtosis = m4 / (m2 * m2); // raw kurtosis; normal = 3
  const sharpe = mean / sd;

  // Mertens (2002): un-annualized SE of Sharpe estimator.
  // excess kurtosis = kurtosis - 3
  const excessKurt = kurtosis - 3;
  const varSr =
    (1 + 0.5 * sharpe * sharpe - sharpe * skewness + 0.25 * excessKurt * sharpe * sharpe) / tEff;
  const se = varSr > 0 && Number.isFinite(varSr) ? Math.sqrt(varSr) : 0;

  const sqrtAnnual = Math.sqrt(annualizationFactor);
  return {
    sharpe,
    se,
    annualizedSharpe: sharpe * sqrtAnnual,
    annualizedSe: se * sqrtAnnual,
    skewness,
    kurtosis,
    tEff,
  };
}
