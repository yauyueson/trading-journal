/**
 * Phase 0.c.8 — direct parity for the JS copy of BSM utilities.
 *
 * lib/_shared/bsm-util.js powers Vercel API routes (api/strategy-recommend.js,
 * api/option-prices.js) and cannot be refactored to import from src/lib/bsm.ts
 * without crossing a build boundary. This test directly imports the JS
 * module and anchors its normCDF + bsmDelta + bsmN2 against hardcoded
 * reference values, so a regression in either copy fails CI.
 *
 * Reference values computed against QuantLib 1.42.1 to ~1e-6 precision;
 * see tests/fixtures/bsm-quantlib-golden.json for the broader grid on
 * the TypeScript copy.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module, no type declarations.
import { normCDF, bsmDelta, bsmN2 } from '../lib/_shared/bsm-util.js';

describe('lib/_shared/bsm-util.js — normCDF', () => {
  const cases: Array<[number, number]> = [
    [0.0, 0.5],
    [1.0, 0.8413447460685429],
    [-1.0, 0.15865525393145707],
    [1.96, 0.9750021048517795],
    [-1.96, 0.024997895148220435],
    [2.0, 0.9772498680518207],
    [3.0, 0.9986501019683699],
    [-3.0, 0.0013498980316301057],
    [0.5, 0.6914624612740131],
    [0.25, 0.5987063256829237],
  ];
  for (const [x, expected] of cases) {
    it(`N(${x}) ≈ ${expected}`, () => {
      const got = normCDF(x);
      expect(Math.abs(got - expected)).toBeLessThan(1e-6);
    });
  }

  it('N(-8) clips to 0 and N(8) clips to 1', () => {
    expect(normCDF(-10)).toBe(0);
    expect(normCDF(10)).toBe(1);
  });
});

describe('lib/_shared/bsm-util.js — bsmDelta', () => {
  // Phase 0.c.8 round-2 F1: bsmDelta now takes a risk-free rate. Defaults
  // to 0.045 when omitted. Exact QuantLib-anchored values below with
  // explicit r=0.04 to match the fixture generator.

  it('ATM 30-DTE call delta = 0.5343 (QuantLib anchor, r=0.04)', () => {
    const d = bsmDelta(100, 100, 30 / 365, 0.20, true, 0.04);
    expect(Math.abs(d - 0.5342697035912664)).toBeLessThan(1e-4);
  });

  it('ATM 30-DTE put delta = -0.4657 (QuantLib anchor, r=0.04)', () => {
    const d = bsmDelta(100, 100, 30 / 365, 0.20, false, 0.04);
    expect(Math.abs(d - (-0.4657302964087338))).toBeLessThan(1e-4);
  });

  it('LEAP 2-year call delta responds correctly to rate', () => {
    // ATM 2-year call, 20% vol — rate matters a lot at this DTE.
    const rateFree = bsmDelta(100, 100, 2.0, 0.20, true, 0.0);
    const r4 = bsmDelta(100, 100, 2.0, 0.20, true, 0.04);
    expect(r4).toBeGreaterThan(rateFree + 0.05); // rate shifts delta materially
  });

  it('default rate (0.045) is applied when r is omitted', () => {
    const explicit = bsmDelta(100, 100, 1.0, 0.20, true, 0.045);
    const implicit = bsmDelta(100, 100, 1.0, 0.20, true);
    expect(implicit).toBeCloseTo(explicit, 10);
  });

  it('call delta + |put delta| = 1 (exact identity)', () => {
    const c = bsmDelta(100, 105, 45 / 365, 0.25, true, 0.04);
    const p = bsmDelta(100, 105, 45 / 365, 0.25, false, 0.04);
    expect(c + Math.abs(p)).toBeCloseTo(1.0, 10);
  });

  it('deep ITM call delta → 1', () => {
    expect(bsmDelta(130, 100, 30 / 365, 0.20, true, 0.04)).toBeGreaterThan(0.98);
  });

  it('deep OTM call delta → 0', () => {
    expect(bsmDelta(80, 100, 30 / 365, 0.20, true, 0.04)).toBeLessThan(0.02);
  });

  it('T<=0 returns boundary sentinels', () => {
    expect(bsmDelta(100, 100, 0, 0.20, true)).toBe(0.5);
    expect(bsmDelta(100, 100, 0, 0.20, false)).toBe(-0.5);
  });
});

describe('lib/_shared/bsm-util.js — bsmN2', () => {
  // Phase 0.c.8 round-2 F2: a d1-for-d2 regression in this formula would
  // silently produce wrong POP estimates. These anchors use cases where
  // N(d1) and N(d2) differ by enough to detect the swap.

  it('ATM 1-year high-vol: N(d2) ≈ 0.408, distinguishable from N(d1) ≈ 0.643', () => {
    // S=100 K=100 T=1 σ=60% r=4%.
    //   d1 = (0 + (0.04 + 0.18) * 1) / 0.6 = 0.366667 → N(d1) ≈ 0.6430
    //   d2 = d1 - 0.6 = -0.233333                    → N(d2) ≈ 0.4077
    // A regression using d1 instead of d2 would return ~0.643 and fail.
    const pop = bsmN2(100, 100, 1.0, 0.60, 0.04);
    expect(pop).toBeGreaterThan(0.40);
    expect(pop).toBeLessThan(0.415);
  });

  it('ATM 30-DTE σ=20% r=4%: N(d2) ≈ 0.5114', () => {
    // d2 = (0 + (0.04 - 0.02)*(30/365)) / (0.2*√(30/365)) = 0.02867
    // N(0.02867) ≈ 0.5114 (QuantLib-consistent).
    const pop = bsmN2(100, 100, 30 / 365, 0.20, 0.04);
    expect(pop).toBeGreaterThan(0.509);
    expect(pop).toBeLessThan(0.514);
  });

  it('OTM long-dated low-vol: N(d2) well below 0.5 and distinct from N(d1)', () => {
    // S=100 K=120 T=0.5 σ=15% r=4%.
    //   d1 ≈ -1.515 → N(d1) ≈ 0.0649
    //   d2 ≈ -1.621 → N(d2) ≈ 0.0525
    const pop = bsmN2(100, 120, 0.5, 0.15, 0.04);
    expect(pop).toBeGreaterThan(0.048);
    expect(pop).toBeLessThan(0.058);
  });

  it('deep ITM returns near 1', () => {
    expect(bsmN2(130, 100, 30 / 365, 0.20, 0.04)).toBeGreaterThan(0.98);
  });

  it('deep OTM returns near 0', () => {
    expect(bsmN2(80, 100, 30 / 365, 0.20, 0.04)).toBeLessThan(0.02);
  });

  it('T<=0 / sigma<=0 returns 0.5 (ambiguous boundary)', () => {
    expect(bsmN2(100, 100, 0, 0.20, 0.04)).toBe(0.5);
    expect(bsmN2(100, 100, 30 / 365, 0, 0.04)).toBe(0.5);
  });
});
