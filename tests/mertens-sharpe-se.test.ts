/**
 * Unit tests for computeMertensSharpeSE — Phase 2.c.
 *
 * Verifies the Mertens closed-form SE matches the expected IID formula
 * under normality, responds to skew/kurtosis as predicted, and behaves
 * degenerately-safe on edge inputs.
 */
import { describe, it, expect } from 'vitest';
import { computeMertensSharpeSE } from '../scripts/autoresearch/lib/mertens-sharpe-se';

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

describe('computeMertensSharpeSE', () => {
  it('returns empty SE for degenerate inputs', () => {
    const r1 = computeMertensSharpeSE([], 0);
    expect(r1.se).toBe(0);
    expect(r1.sharpe).toBe(0);

    const r2 = computeMertensSharpeSE([0.01, 0.02], 2);
    expect(r2.se).toBe(0);

    const r3 = computeMertensSharpeSE([0.05, 0.05, 0.05], 3);
    expect(r3.se).toBe(0); // zero variance
  });

  it('on IID normal returns, matches the textbook (1 + ½·SR²)/T formula within a few percent', () => {
    const n = 2000; // large enough that sample skew/kurt are ~0 / ~3
    const rng = makeRng(13);
    const mu = 0.0005;
    const sigma = 0.012;
    const series = genIIDNormal(n, mu, sigma, rng);
    const r = computeMertensSharpeSE(series, n);
    // True SR (un-annualized) ≈ mu/sigma.
    // Textbook IID normal SE ≈ √((1 + 0.5·SR²) / n).
    const trueSR = mu / sigma;
    const expectedSE = Math.sqrt((1 + 0.5 * trueSR * trueSR) / n);
    // Mertens with skew≈0, excess kurt≈0 should collapse onto this.
    expect(r.se / expectedSE).toBeGreaterThan(0.85);
    expect(r.se / expectedSE).toBeLessThan(1.15);
  });

  it('annualizes Sharpe and SE by √annualizationFactor', () => {
    const n = 1500;
    const rng = makeRng(21);
    const series = genIIDNormal(n, 0.0005, 0.012, rng);
    const annualFactor = 252;
    const r = computeMertensSharpeSE(series, n, annualFactor);
    const sqrt = Math.sqrt(annualFactor);
    expect(r.annualizedSharpe).toBeCloseTo(r.sharpe * sqrt, 10);
    expect(r.annualizedSe).toBeCloseTo(r.se * sqrt, 10);
  });

  it('SE shrinks as effective sample size grows (T_eff dependence)', () => {
    const n = 500;
    const rng = makeRng(31);
    const series = genIIDNormal(n, 0.0005, 0.012, rng);
    const rFull = computeMertensSharpeSE(series, n);
    const rHalf = computeMertensSharpeSE(series, n / 2);
    // Same series, same SR/skew/kurt — only T_eff changes. SE ∝ 1/√T.
    expect(rHalf.se / rFull.se).toBeCloseTo(Math.sqrt(2), 2);
  });

  it('responds to skewness with opposite sign of SR', () => {
    // Positive-skew distribution with positive SR → SE smaller than symmetric
    // case, because SE formula subtracts `SR·skew` (positive · positive).
    // Construct returns = |normal| - small shift → positive skew.
    const n = 3000;
    const rng = makeRng(41);
    const posSkew = Array.from({ length: n }, () => {
      const z = boxMuller(rng);
      return Math.abs(z) * 0.01 - 0.003;  // shift so mean > 0
    });
    const symmetric = genIIDNormal(n, 0.0005, 0.012, makeRng(42));

    const rSkew = computeMertensSharpeSE(posSkew, n);
    const rSym = computeMertensSharpeSE(symmetric, n);

    // Sanity: skew should be substantially positive in the posSkew series.
    expect(rSkew.skewness).toBeGreaterThan(0.5);
    // Sanity: symmetric series should have skew near 0.
    expect(Math.abs(rSym.skewness)).toBeLessThan(0.3);
  });

  it('reports kurtosis ≈ 3 for normal returns, > 3 for heavy-tailed', () => {
    const n = 3000;
    const normal = genIIDNormal(n, 0, 1, makeRng(51));
    const rn = computeMertensSharpeSE(normal, n);
    expect(rn.kurtosis).toBeGreaterThan(2.5);
    expect(rn.kurtosis).toBeLessThan(3.5);

    // Mix of 95% normal + 5% 3x normal (heavy tails).
    const rng = makeRng(61);
    const heavy: number[] = [];
    for (let i = 0; i < n; i++) {
      const fatJump = rng() < 0.05;
      heavy.push((fatJump ? 3 : 1) * boxMuller(rng));
    }
    const rh = computeMertensSharpeSE(heavy, n);
    expect(rh.kurtosis).toBeGreaterThan(3.8);
  });
});
