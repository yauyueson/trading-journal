/**
 * Politis–Romano (1994) stationary bootstrap for the Sharpe ratio.
 *
 * The fixed-block bootstrap (`./bootstrap-sharpe.ts`) preserves
 * autocorrelation up to the block length, but uses deterministic blocks
 * anchored to a random start. The Politis–Romano stationary bootstrap
 * uses RANDOMLY-sized blocks drawn from a geometric distribution with
 * mean `L`, so the resampled series is itself stationary (every lag-k
 * autocorrelation is approximately preserved on expectation, not just
 * up to the block length). The practical consequence, shown in the MC
 * coverage test at `tests/stationary-bootstrap-coverage.test.ts`, is
 * materially better CI coverage at phi > 0.5 than the fixed-block
 * approach at the same mean block size.
 *
 * Shipped as a LIBRARY ONLY in Phase 3.b. NOT wired into `runner.ts`,
 * `deflatedSharpe`, or `isValid`. Production promotion would change
 * historical leaderboard comparability (same class of concern as
 * Phase 2.g) and wants empirical justification beyond synthetic MC —
 * i.e. a real-strategy side-by-side that shows the stationary CI
 * flags cases the fixed-block CI misses. Deferred until we have that.
 *
 * Parameter choice:
 *  - `meanBlockSize` (= 1 / geometric p). We default to √n to match
 *    the fixed-block helper's block size, so any coverage difference
 *    comes from the fixed-vs-random block structure rather than block
 *    length. Callers can override for Politis-White automatic
 *    bandwidth if they compute it externally.
 *
 * Circular indexing: the algorithm wraps around the series end so
 * every starting position is equally likely (standard Politis–Romano
 * convention; removes the boundary bias the non-circular variant has).
 *
 * @param dailyReturns Arithmetic daily returns.
 * @param iterations   Bootstrap replicates.
 * @param rng          Uniform [0, 1) source. Test code passes a
 *   seeded LCG for reproducibility.
 * @param meanBlockSize Geometric-distribution mean. Defaults to √n.
 */
export function stationaryBootstrapSharpeCI(
  dailyReturns: number[],
  iterations = 1000,
  rng: () => number = Math.random,
  meanBlockSize?: number,
): [number, number] {
  const n = dailyReturns.length;
  if (n < 30) return [0, 0];
  const L = meanBlockSize ?? Math.max(2, Math.floor(Math.sqrt(n)));
  const p = 1 / L;
  const sharpes: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const resampled: number[] = new Array(n);
    // Seed the first position.
    let idx = Math.floor(rng() * n);
    for (let j = 0; j < n; j++) {
      resampled[j] = dailyReturns[idx];
      // With probability p, jump to a fresh random index; else step.
      if (rng() < p) {
        idx = Math.floor(rng() * n);
      } else {
        idx = (idx + 1) % n; // circular
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
