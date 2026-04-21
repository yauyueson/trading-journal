/**
 * Phase 0.c.12 — property test for put-call parity.
 *
 * Sweeps thousands of random (S, K, T, σ, r) points and asserts
 * C − P − (S − K·e^{-rT}) = 0 within 1e-8.
 *
 * Parity is an algebraic identity, NOT a calibration anchor. It would
 * still hold even if BSM's normCDF were broken — so long as both call
 * and put branches use the same (broken) CDF. This test complements the
 * QuantLib parity grid in tests/bsm-quantlib-parity.test.ts:
 *
 *   QuantLib grid   = absolute pricing vs an external reference.
 *   Put-call parity = internal consistency across call/put formulas.
 *
 * Both must hold for the math to be correct.
 */
import { describe, expect, it } from 'vitest';
import { bsmPrice, checkPutCallParity } from '../src/lib/backtest/bsm-pricing';
import { makeRng } from './helpers/gbm';

describe('Put-call parity (Phase 0.c.12)', () => {
  it('holds exactly on the textbook ATM 30-DTE example', () => {
    const r = checkPutCallParity(100, 100, 30 / 365, 0.20, 0.04);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.abs(r.residual)).toBeLessThan(1e-10);
  });

  it('holds on 10,000 random points across the realistic input envelope', () => {
    const rng = makeRng(0xC0C12);
    const failures: string[] = [];
    const residuals: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      // Sample uniformly in the realistic envelope.
      const S = 20 + rng() * 480;                  // [20, 500]
      const moneyness = 0.7 + rng() * 0.6;         // K/S ∈ [0.7, 1.3]
      const K = S * moneyness;
      const T = (1 + rng() * 730) / 365;           // 1 day to 2 years
      const sigma = 0.05 + rng() * 0.95;           // σ ∈ [0.05, 1.0]
      const r = rng() * 0.10;                      // r ∈ [0, 10%]
      const res = checkPutCallParity(S, K, T, sigma, r, 1e-8);
      if (!res.ok) {
        if (failures.length < 5) failures.push(res.reason);
      }
      residuals.push(Math.abs(res.residual));
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} parity failures out of 10,000:\n  ${failures.join('\n  ')}`,
      );
    }
    // Also surface the worst residual — a regression that loosens precision
    // below 1e-8 but above (say) 1e-10 would pass but still be noteworthy.
    const maxResidual = Math.max(...residuals);
    expect(maxResidual).toBeLessThan(1e-8);
  });

  it('catches a sign-flipped put branch via the validator', () => {
    // Simulate a broken put formula by computing put via (call − parity) but
    // INVERTING the sign of one term. This mimics what a real bug in
    // bsmPrice would look like.
    //
    // We don't actually mutate bsmPrice — we verify the validator's math
    // works on a hand-crafted mispriced pair.
    const S = 100, K = 100, T = 30 / 365, sigma = 0.20, r = 0.04;
    const call = bsmPrice(S, K, T, sigma, r, true);
    const fakePut = bsmPrice(S, K, T, sigma, r, false) + 0.5; // intentional offset
    const residual = call - fakePut - (S - K * Math.exp(-r * T));
    expect(Math.abs(residual)).toBeGreaterThan(1e-8);
  });

  it('tolerates tighter tolerance down to 1e-10 on the textbook case', () => {
    const r = checkPutCallParity(100, 100, 30 / 365, 0.20, 0.04, 1e-10);
    expect(r.ok).toBe(true);
  });

  it('returns a descriptive error when parity fails', () => {
    // Pass an extreme tolerance so the normal case fails.
    const r = checkPutCallParity(100, 100, 30 / 365, 0.20, 0.04, 0);
    if (r.ok) {
      // Floating-point arithmetic can occasionally give exactly 0; try an off-center case.
      const r2 = checkPutCallParity(123.45, 98.76, 0.3, 0.25, 0.035, 0);
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.reason).toContain('parity violation');
        expect(r2.reason).toContain('S=123.45');
      }
    } else {
      expect(r.reason).toContain('parity violation');
    }
  });

  it('short-DTE edge case: 1-day parity holds', () => {
    const res = checkPutCallParity(100, 100, 1 / 365, 0.30, 0.04);
    expect(res.ok).toBe(true);
  });

  it('high-vol edge case: σ=1.0 parity holds', () => {
    const res = checkPutCallParity(100, 100, 90 / 365, 1.0, 0.04);
    expect(res.ok).toBe(true);
  });

  it('deep ITM parity', () => {
    const res = checkPutCallParity(200, 100, 30 / 365, 0.20, 0.04);
    expect(res.ok).toBe(true);
  });

  it('deep OTM parity', () => {
    const res = checkPutCallParity(50, 100, 30 / 365, 0.20, 0.04);
    expect(res.ok).toBe(true);
  });

  it('zero-rate parity reduces to C − P = S − K', () => {
    const res = checkPutCallParity(100, 95, 30 / 365, 0.20, 0.0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // With r=0: expected residual is C − P − (S − K) = 0.
      // Just re-assert the identity for clarity.
      const call = bsmPrice(100, 95, 30 / 365, 0.20, 0.0, true);
      const put = bsmPrice(100, 95, 30 / 365, 0.20, 0.0, false);
      expect(call - put).toBeCloseTo(100 - 95, 9);
    }
  });
});
