/**
 * Unit tests for computeEffectiveSampleSize — Phase 2.a.
 *
 * The helper reports a Newey-West effective sample size for a scalar
 * return series. It's exposed on the autoresearch leaderboard as a
 * diagnostic so human reviewers can flag strategies whose daily-return
 * series is so autocorrelated that the bootstrap CI / deflated Sharpe
 * might be optimistic.
 */
import { describe, it, expect } from 'vitest';
import { computeEffectiveSampleSize } from '../scripts/autoresearch/lib/effective-sample-size';

// Deterministic LCG so test results are stable across runs.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Box-Muller → approximately standard-normal draws from uniform rng.
function boxMuller(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function genIID(n: number, rng: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(boxMuller(rng));
  return out;
}

/** AR(1): x_t = phi * x_{t-1} + eps_t. */
function genAR1(n: number, phi: number, rng: () => number): number[] {
  const out: number[] = [0];
  for (let i = 1; i < n; i++) {
    out.push(phi * out[i - 1] + boxMuller(rng));
  }
  return out;
}

describe('computeEffectiveSampleSize', () => {
  it('returns n for degenerate input (length < 3)', () => {
    expect(computeEffectiveSampleSize([])).toBe(0);
    expect(computeEffectiveSampleSize([0.01])).toBe(1);
    expect(computeEffectiveSampleSize([0.01, 0.02])).toBe(2);
  });

  it('returns n when variance is zero (constant series)', () => {
    expect(computeEffectiveSampleSize([0.05, 0.05, 0.05, 0.05, 0.05])).toBe(5);
  });

  it('reports N_eff ≈ n for an IID series (±20% band over multiple seeds)', () => {
    const n = 500;
    let pass = 0;
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const s of seeds) {
      const rng = makeRng(s);
      const ret = genIID(n, rng);
      const nEff = computeEffectiveSampleSize(ret, 20);
      if (nEff >= 0.8 * n && nEff <= 1.2 * n) pass++;
    }
    // At least 6 of 8 seeds should land in band — allows for sampling noise.
    expect(pass).toBeGreaterThanOrEqual(6);
  });

  it('reports N_eff < n for strongly positively-autocorrelated series', () => {
    const n = 500;
    const rng = makeRng(42);
    const ret = genAR1(n, 0.5, rng);
    const nEff = computeEffectiveSampleSize(ret, 20);
    // AR(1) with phi=0.5 has long-run variance inflation ≈ (1+phi)/(1-phi) = 3.
    // N_eff should be materially below n. Asymptotic value ≈ n/3.
    expect(nEff).toBeLessThan(0.6 * n);
    expect(nEff).toBeGreaterThan(100); // but not absurdly small
  });

  it('reports N_eff substantially smaller as phi grows', () => {
    const n = 500;
    const rng1 = makeRng(7);
    const rng2 = makeRng(7);
    const weak = genAR1(n, 0.2, rng1);
    const strong = genAR1(n, 0.8, rng2);
    const nEffWeak = computeEffectiveSampleSize(weak, 20);
    const nEffStrong = computeEffectiveSampleSize(strong, 20);
    expect(nEffStrong).toBeLessThan(nEffWeak);
  });

  it('reports N_eff > n for mean-reverting (negative autocorrelation) series', () => {
    // Sign-alternating series: x_t = -0.5 * x_{t-1} + eps_t
    const n = 500;
    const rng = makeRng(9);
    const out: number[] = [0];
    for (let i = 1; i < n; i++) out.push(-0.5 * out[i - 1] + boxMuller(rng));
    const nEff = computeEffectiveSampleSize(out, 20);
    // Diagnostic semantics: we surface N_eff > n honestly for mean-revert.
    expect(nEff).toBeGreaterThan(n);
  });

  it('never returns NaN, Infinity, zero, or negative for pathological input', () => {
    // All-zero: var0 = 0 → early-return n.
    expect(computeEffectiveSampleSize(Array(100).fill(0), 20)).toBe(100);
    // Tiny wiggles around a huge mean: mostly numerical noise.
    const tiny = Array.from({ length: 50 }, (_, i) => 1e6 + i * 1e-12);
    const nEff = computeEffectiveSampleSize(tiny, 10);
    expect(Number.isFinite(nEff)).toBe(true);
    expect(nEff).toBeGreaterThan(0);
  });

  it('respects short-series bandwidth auto-shrink', () => {
    const rng = makeRng(11);
    const ret = genIID(5, rng);
    // maxLag 20 requested but series has 5 obs → helper internally caps lag.
    const nEff = computeEffectiveSampleSize(ret, 20);
    expect(Number.isFinite(nEff)).toBe(true);
    expect(nEff).toBeGreaterThan(0);
  });
});
