/**
 * Newey-West effective sample size for an autocorrelated scalar series.
 *
 * `N_eff = n / (1 + 2 · Σ_{k=1..L} w_k · ρ_k)` where w_k is the Bartlett
 * kernel `1 − k/(L+1)` and ρ_k is the lag-k autocorrelation of `returns`.
 *
 * Semantics:
 *  - IID series → autocorrelation sum ≈ 0 → N_eff ≈ n.
 *  - Positive autocorrelation (persistent returns) → N_eff < n. Each new
 *    obs carries less independent information than iid would suggest.
 *  - Negative autocorrelation (mean-reverting) → N_eff > n. We surface
 *    this honestly as a diagnostic; callers that need a conservative
 *    floor should clip at `n`.
 *
 * Exposed on the leaderboard as a diagnostic via `nEffOosDaily`. NOT
 * currently used to adjust `computeDeflatedSharpe` — the bootstrap CI
 * backing DSR's `sharpeSE` is already autocorrelation-aware via block
 * bootstrapping. Replacing it with a closed-form Mertens-corrected SE
 * scaled by N_eff would be a policy change tracked separately.
 *
 * @param returns Daily returns (arithmetic). De-meaned internally.
 * @param maxLag Newey-West bandwidth in observations. Default 20 ≈ one
 *   month of trading days. Automatically shrunk if the series is short.
 */
export function computeEffectiveSampleSize(returns: number[], maxLag = 20): number {
  const n = returns.length;
  if (n < 3) return n;
  const lag = Math.max(1, Math.min(maxLag, n - 2));
  const mean = returns.reduce((s, x) => s + x, 0) / n;
  const centered = returns.map(r => r - mean);
  const var0 = centered.reduce((s, x) => s + x * x, 0) / n;
  if (!(var0 > 0) || !Number.isFinite(var0)) return n;
  let autocorrSum = 0;
  for (let k = 1; k <= lag; k++) {
    let cov = 0;
    for (let i = 0; i < n - k; i++) {
      cov += centered[i] * centered[i + k];
    }
    cov /= n;
    const rho = cov / var0;
    const weight = 1 - k / (lag + 1);
    autocorrSum += weight * rho;
  }
  const denom = 1 + 2 * autocorrSum;
  // Degenerate / pathological: if negative autocorrelation over-dominates
  // (denom ≤ 0), fall back to n rather than blowing up to a huge value.
  if (!(denom > 0) || !Number.isFinite(denom)) return n;
  const nEff = n / denom;
  if (!Number.isFinite(nEff) || nEff <= 0) return n;
  return nEff;
}
