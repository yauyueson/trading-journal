/**
 * Block bootstrap 95% confidence interval on annualized Sharpe ratio
 * for a daily-return series.
 *
 * Uses an overlapping fixed-block bootstrap with block size ~⌈√n⌉. The
 * block structure preserves lag-k autocorrelation up to roughly the
 * block length; beyond that, autocorrelation is destroyed in each
 * resample. For typical credit-spread strategies (autocorrelation decays
 * within ~5-10 days via trade-life overlap), this is adequate. For
 * strongly persistent series (phi > 0.6), fixed-block undercovers the
 * true Sharpe — see `tests/bootstrap-sharpe-coverage.test.ts` for the
 * Monte Carlo coverage characterization.
 *
 * Extracted from runner.ts in Phase 2.b (2026-04-20) so that:
 *   1. Coverage validation tests can import it without pulling runner.ts.
 *   2. A future stationary-bootstrap replacement can be a drop-in swap.
 *
 * @param dailyReturns Arithmetic daily returns.
 * @param iterations   Number of bootstrap replicates. Defaults to 1000 —
 *   caller typically passes `adoption-gates.json :: bootstrapIterations`.
 * @param rng          Uniform [0,1) source. Defaults to `Math.random`.
 *   Tests pass a seeded LCG for reproducibility.
 */
export function bootstrapSharpeCI(
  dailyReturns: number[],
  iterations = 1000,
  rng: () => number = Math.random,
): [number, number] {
  if (dailyReturns.length < 30) return [0, 0];
  const n = dailyReturns.length;
  const blockSize = Math.max(5, Math.floor(Math.sqrt(n)));
  const sharpes: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const resampled: number[] = [];
    while (resampled.length < n) {
      const startIdx = Math.floor(rng() * (n - blockSize + 1));
      for (let j = 0; j < blockSize && resampled.length < n; j++) {
        resampled.push(dailyReturns[startIdx + j]);
      }
    }

    let sum = 0, sumSq = 0;
    for (let j = 0; j < n; j++) {
      sum += resampled[j];
      sumSq += resampled[j] * resampled[j];
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    const std = Math.sqrt(Math.max(0, variance));
    sharpes.push(std > 0 ? (mean / std) * Math.sqrt(252) : 0);
  }

  sharpes.sort((a, b) => a - b);
  const lo = sharpes[Math.floor(iterations * 0.025)];
  const hi = sharpes[Math.floor(iterations * 0.975)];
  return [lo, hi];
}
