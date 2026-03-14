/**
 * Unit tests for oss-core.ts scoring functions.
 * Known input → output pairs for regression safety.
 */
import { describe, it, expect } from 'vitest';
import {
  compressLambda,
  getThetaPenalty,
  getDeltaBonus,
  getIVRiskFactor,
  normalizeScoreTo100,
  calculateDollarGamma,
  calculateExpectedValue,
  getLOQVegaWeight,
  lerp,
  getBreakevenPenalty,
  calculateSpreadPct,
  calculateLOQRaw,
  calculateCSQRaw,
} from '../oss-core';

describe('compressLambda', () => {
  it('clamps to MIN_LAMBDA=1 for zero/negative', () => {
    expect(compressLambda(0)).toBeCloseTo(1.0, 5);
    expect(compressLambda(-5)).toBeCloseTo(1.0, 5);
  });
  it('lambda=1 → log2(2) = 1.0', () => {
    expect(compressLambda(1)).toBeCloseTo(1.0, 5);
  });
  it('lambda=100 → log2(101) ≈ 6.66', () => {
    expect(compressLambda(100)).toBeCloseTo(Math.log2(101), 5);
  });
});

describe('getThetaPenalty', () => {
  it('zero → 0 (safe zone)', () => {
    expect(getThetaPenalty(0)).toBe(0);
  });
  it('0.005 → 0 (exact boundary)', () => {
    expect(getThetaPenalty(0.005)).toBe(0);
  });
  it('0.01 → (0.5)^2 * 0.5 = 0.125', () => {
    // excess = 0.01 - 0.005 = 0.005, times 100 = 0.5, squared = 0.25, times 0.5 = 0.125
    expect(getThetaPenalty(0.01)).toBeCloseTo(0.125, 5);
  });
  it('caps at 10', () => {
    expect(getThetaPenalty(0.5)).toBe(10);
    expect(getThetaPenalty(1.0)).toBe(10);
  });
});

describe('getDeltaBonus', () => {
  it('deep OTM (delta=0) → -2.0', () => {
    expect(getDeltaBonus(0)).toBe(-2.0);
  });
  it('sweet spot (delta=0.50) → 1.0', () => {
    expect(getDeltaBonus(0.50)).toBeCloseTo(1.0, 5);
  });
  it('uses absolute value for negatives', () => {
    expect(getDeltaBonus(-0.40)).toBeCloseTo(getDeltaBonus(0.40), 10);
  });
  it('extreme ITM (delta=1.0) → 0', () => {
    expect(getDeltaBonus(1.0)).toBeCloseTo(0, 5);
  });
  it('beyond 1.0 → 0', () => {
    expect(getDeltaBonus(1.5)).toBe(0);
  });
});

describe('getIVRiskFactor', () => {
  it('ratio=1.0 (inflection) → ~1.1', () => {
    expect(getIVRiskFactor(1.0)).toBeCloseTo(1.1, 1);
  });
  it('low ratio (contango) → near 0.9', () => {
    expect(getIVRiskFactor(0.5)).toBeGreaterThanOrEqual(0.9);
    expect(getIVRiskFactor(0.5)).toBeLessThan(1.0);
  });
  it('high ratio (backwardation) → near 1.3', () => {
    expect(getIVRiskFactor(2.0)).toBeLessThanOrEqual(1.3);
    expect(getIVRiskFactor(2.0)).toBeGreaterThan(1.1);
  });
  it('clamps extreme values', () => {
    expect(getIVRiskFactor(0)).toBeCloseTo(getIVRiskFactor(0.5), 5);
    expect(getIVRiskFactor(10)).toBeCloseTo(getIVRiskFactor(2.0), 5);
  });
});

describe('normalizeScoreTo100', () => {
  it('Z=0 → 50', () => {
    expect(normalizeScoreTo100(0)).toBe(50);
  });
  it('Z=4 → 100', () => {
    expect(normalizeScoreTo100(4)).toBe(100);
  });
  it('Z=-4 → 0', () => {
    expect(normalizeScoreTo100(-4)).toBe(0);
  });
  it('clamps extreme values', () => {
    expect(normalizeScoreTo100(10)).toBe(100);
    expect(normalizeScoreTo100(-10)).toBe(0);
  });
  it('Z=2 → 75', () => {
    expect(normalizeScoreTo100(2)).toBe(75);
  });
});

describe('calculateDollarGamma', () => {
  it('gamma=0 → 0', () => {
    expect(calculateDollarGamma(0, 100)).toBe(0);
  });
  it('gamma=0.01, S=100 → 1.0', () => {
    expect(calculateDollarGamma(0.01, 100)).toBeCloseTo(1.0, 5);
  });
  it('scales with S²', () => {
    const g1 = calculateDollarGamma(0.01, 100);
    const g2 = calculateDollarGamma(0.01, 200);
    expect(g2).toBeCloseTo(g1 * 4, 5); // 200² / 100² = 4
  });
  it('S=0 → 0', () => {
    expect(calculateDollarGamma(0.1, 0)).toBe(0);
  });
});

describe('calculateExpectedValue', () => {
  it('certain win (pop=1) → full credit', () => {
    expect(calculateExpectedValue(1, 1.0, 3.0)).toBeCloseTo(1.0, 5);
  });
  it('certain loss (pop=0) → -maxRisk * 0.92', () => {
    expect(calculateExpectedValue(0, 1.0, 3.0)).toBeCloseTo(-2.76, 5);
  });
  it('even odds, small edge', () => {
    const ev = calculateExpectedValue(0.8, 1.0, 3.0);
    expect(ev).toBeCloseTo(0.8 - 0.2 * 3.0 * 0.92, 5); // 0.248
  });
  it('custom exitMultiplier', () => {
    expect(calculateExpectedValue(0.5, 1.0, 2.0, 1.0)).toBeCloseTo(-0.5, 5);
  });
});

describe('getLOQVegaWeight', () => {
  it('ivAdjustment=0 → 0 (neutral)', () => {
    expect(getLOQVegaWeight(30, 0)).toBe(0);
  });
  it('short DTE + positive IV → small positive weight', () => {
    expect(getLOQVegaWeight(3, 0.1)).toBeCloseTo(0.03, 3);
  });
  it('long DTE + positive IV → max weight ~0.15', () => {
    expect(getLOQVegaWeight(60, 0.1)).toBeCloseTo(0.15, 3);
  });
  it('negative IV → negative weight × 0.6', () => {
    const w = getLOQVegaWeight(60, -0.1);
    expect(w).toBeLessThan(0);
    expect(w).toBeCloseTo(-0.15 * 0.6, 3);
  });
  it('null DTE defaults to 30', () => {
    expect(getLOQVegaWeight(null, 0.5)).toBeCloseTo(getLOQVegaWeight(30, 0.5), 10);
  });
});

describe('lerp', () => {
  it('midpoint interpolation', () => {
    expect(lerp(5, 0, 10, 0, 100)).toBeCloseTo(50, 5);
  });
  it('at boundaries', () => {
    expect(lerp(0, 0, 10, 0, 100)).toBeCloseTo(0, 5);
    expect(lerp(10, 0, 10, 0, 100)).toBeCloseTo(100, 5);
  });
  it('degenerate x1===x2 → midpoint of y', () => {
    expect(lerp(5, 5, 5, 10, 20)).toBeCloseTo(15, 5);
  });
});

describe('getBreakevenPenalty', () => {
  it('small move → positive bonus', () => {
    expect(getBreakevenPenalty(0.01, 30)).toBeGreaterThan(0);
  });
  it('large move → penalty (negative)', () => {
    expect(getBreakevenPenalty(0.25, 30)).toBeLessThan(0);
  });
  it('very large move → capped at -2', () => {
    expect(getBreakevenPenalty(0.5, 30)).toBeGreaterThanOrEqual(-2);
  });
});

describe('calculateSpreadPct', () => {
  it('tight spread', () => {
    expect(calculateSpreadPct(0.95, 1.05)).toBeCloseTo(0.1, 5);
  });
  it('zero bid+ask → returns 1.0 (guard)', () => {
    expect(calculateSpreadPct(0, 0)).toBe(1);
  });
  it('identical bid/ask → 0', () => {
    expect(calculateSpreadPct(1.0, 1.0)).toBe(0);
  });
});

describe('calculateLOQRaw', () => {
  it('all zeros → near zero', () => {
    const raw = calculateLOQRaw(0, 0, 0, 0, 0, 0);
    expect(Math.abs(raw)).toBeLessThan(0.5);
  });
  it('positive z-scores → positive raw', () => {
    const raw = calculateLOQRaw(2, 1, 1, 0.5, 1.0, 0);
    expect(raw).toBeGreaterThan(0);
  });
});

describe('calculateCSQRaw', () => {
  it('all zeros → 0', () => {
    expect(calculateCSQRaw(0, 0, 0, 0)).toBe(0);
  });
  it('positive edge → positive score', () => {
    expect(calculateCSQRaw(2, 0, 0, 0)).toBeCloseTo(1.0, 5);
  });
  it('wide spread penalizes', () => {
    expect(calculateCSQRaw(0, 0, 2, 0)).toBeCloseTo(-0.4, 5);
  });
});
