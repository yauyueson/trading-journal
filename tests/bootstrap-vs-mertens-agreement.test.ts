/**
 * Cross-validation: bootstrap Sharpe SE vs. Mertens closed-form SE.
 * Phase 2.d (2026-04-20).
 *
 * Both methods estimate the same quantity (standard error of the
 * annualized Sharpe), via different routes:
 *   - `bootstrapSharpeCI` resamples blocks of daily returns.
 *   - `computeMertensSharpeSE` plugs the sample's first four moments
 *     into Mertens's closed-form formula.
 *
 * On well-behaved synthetic return streams (IID normal, low-phi AR(1)),
 * both methods SHOULD produce SE estimates within roughly a factor of
 * two. Any future refactor of either routine that breaks this expected
 * agreement is a red flag worth catching in CI.
 *
 * The runner already flags divergence > 1.5x at print time. This test
 * just locks in "on synthetic data the two methods DO agree."
 */
import { describe, it, expect } from 'vitest';
import { bootstrapSharpeCI } from '../scripts/autoresearch/lib/bootstrap-sharpe';
import { computeMertensSharpeSE } from '../scripts/autoresearch/lib/mertens-sharpe-se';
import { computeEffectiveSampleSize } from '../scripts/autoresearch/lib/effective-sample-size';

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function boxMuller(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function genIIDNormal(n: number, mu: number, sigma: number, rng: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(mu + sigma * boxMuller(rng));
  return out;
}

function genAR1(n: number, phi: number, mu: number, sigma: number, rng: () => number): number[] {
  const shockSd = sigma * Math.sqrt(1 - phi * phi);
  const out: number[] = [mu + sigma * boxMuller(rng)];
  for (let i = 1; i < n; i++) {
    out.push(mu + phi * (out[i - 1] - mu) + shockSd * boxMuller(rng));
  }
  return out;
}

// Derive SE from the 95% CI the way the runner does: (hi-lo)/(2*1.96).
function seFromCI(ci: [number, number]): number {
  return (ci[1] - ci[0]) / (2 * 1.96);
}

describe('bootstrap SE vs Mertens SE — agreement on synthetic regimes', () => {
  it('IID normal returns: agreement within 2x', () => {
    const n = 252;
    const series = genIIDNormal(n, 0.0005, 0.012, makeRng(7));
    const bsSE = seFromCI(bootstrapSharpeCI(series, 500, makeRng(700)));
    const nEff = computeEffectiveSampleSize(series, 20);
    const mertens = computeMertensSharpeSE(series, nEff, 252);
    expect(bsSE).toBeGreaterThan(0);
    expect(mertens.annualizedSe).toBeGreaterThan(0);
    const ratio = mertens.annualizedSe / bsSE;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });

  it('AR(1) phi=0.2: agreement within 2x (realistic daily-return persistence)', () => {
    const n = 252;
    const series = genAR1(n, 0.2, 0.0005, 0.012, makeRng(11));
    const bsSE = seFromCI(bootstrapSharpeCI(series, 500, makeRng(1100)));
    const nEff = computeEffectiveSampleSize(series, 20);
    const mertens = computeMertensSharpeSE(series, nEff, 252);
    const ratio = mertens.annualizedSe / bsSE;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });

  it('500-day IID series: both SEs shrink by ~√2 when sample doubles from 250', () => {
    // Asymptotic behavior: SE ∝ 1/√T. Both methods should respect this.
    const rng1 = makeRng(23);
    const rng2 = makeRng(23);
    const short = genIIDNormal(250, 0.0005, 0.012, rng1);
    const long = genIIDNormal(500, 0.0005, 0.012, rng2);

    const bsShort = seFromCI(bootstrapSharpeCI(short, 500, makeRng(2300)));
    const bsLong = seFromCI(bootstrapSharpeCI(long, 500, makeRng(2301)));
    const mShort = computeMertensSharpeSE(short, computeEffectiveSampleSize(short, 20), 252);
    const mLong = computeMertensSharpeSE(long, computeEffectiveSampleSize(long, 20), 252);

    // Both should decrease (SE ∝ 1/√T). Loose band because sample SE
    // estimates are noisy — we just want directional check.
    expect(bsLong).toBeLessThan(bsShort * 1.1);
    expect(mLong.annualizedSe).toBeLessThan(mShort.annualizedSe * 1.1);
    // And they should decrease by similar factor (~√2 ≈ 1.41).
    const bsShrink = bsShort / bsLong;
    const mShrink = mShort.annualizedSe / mLong.annualizedSe;
    expect(bsShrink).toBeGreaterThan(1.0);
    expect(mShrink).toBeGreaterThan(1.1);
    // Don't assert exact √2 — sample estimates of SE are noisy.
  });
});
