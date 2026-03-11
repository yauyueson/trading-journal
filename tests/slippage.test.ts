// tests/slippage.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeSlippage,
  applyFill,
} from '../src/lib/backtest/slippage';
import type { DynamicSlippageConfig } from '../src/lib/backtest/types';

const DEFAULT_CFG: DynamicSlippageConfig = {
  enabled: true,
  fillMode: 'bidask',
  baseImpactBps: 2,
  oiHalfLife: 500,
  dteAccelDays: 7,
  dteAccelMultiplier: 3.0,
};

describe('computeSlippage', () => {
  it('returns 0 when disabled', () => {
    const cfg = { ...DEFAULT_CFG, enabled: false };
    expect(computeSlippage(cfg, 0.10, 100, 30, 2.50)).toBe(0);
  });

  it('base case: liquid, far from expiry', () => {
    // bid/ask spread = $0.10, OI = 5000, DTE = 45, mid = $2.50
    const slip = computeSlippage(DEFAULT_CFG, 0.10, 5000, 45, 2.50);
    // Should be small — just base impact
    expect(slip).toBeGreaterThan(0);
    expect(slip).toBeLessThan(0.06); // small: halfSpread ($0.05) + minimal base impact
  });

  it('wider spread → more slippage', () => {
    const narrow = computeSlippage(DEFAULT_CFG, 0.05, 1000, 30, 2.50);
    const wide = computeSlippage(DEFAULT_CFG, 0.30, 1000, 30, 2.50);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('lower OI → more slippage', () => {
    const liquid = computeSlippage(DEFAULT_CFG, 0.10, 5000, 30, 2.50);
    const illiquid = computeSlippage(DEFAULT_CFG, 0.10, 50, 30, 2.50);
    expect(illiquid).toBeGreaterThan(liquid);
  });

  it('near-expiry DTE → accelerated slippage', () => {
    const farDTE = computeSlippage(DEFAULT_CFG, 0.10, 1000, 30, 2.50);
    const nearDTE = computeSlippage(DEFAULT_CFG, 0.10, 1000, 3, 2.50);
    expect(nearDTE).toBeGreaterThan(farDTE);
  });

  it('zero OI → uses oiHalfLife as floor', () => {
    const slip = computeSlippage(DEFAULT_CFG, 0.10, 0, 30, 2.50);
    expect(slip).toBeGreaterThan(0);
    expect(Number.isFinite(slip)).toBe(true);
  });

  it('zero spread → only base impact', () => {
    const slip = computeSlippage(DEFAULT_CFG, 0, 1000, 30, 2.50);
    expect(slip).toBeGreaterThan(0); // base impact still applies
  });
});

describe('applyFill', () => {
  it('mid mode returns mid price unchanged', () => {
    const result = applyFill('mid', 2.50, 2.40, 2.60, 'sell',
      { ...DEFAULT_CFG, fillMode: 'mid' }, 1000, 30);
    expect(result.fillPrice).toBe(2.50);
    expect(result.slippage).toBe(0);
  });

  it('bidask sell → fills at bid minus impact', () => {
    const result = applyFill('bidask', 2.50, 2.40, 2.60, 'sell',
      DEFAULT_CFG, 1000, 30);
    expect(result.fillPrice).toBeLessThanOrEqual(2.40);
    expect(result.fillPrice).toBeGreaterThan(0);
    expect(result.slippage).toBeGreaterThan(0);
  });

  it('bidask buy → fills at ask plus impact', () => {
    const result = applyFill('bidask', 2.50, 2.40, 2.60, 'buy',
      DEFAULT_CFG, 1000, 30);
    expect(result.fillPrice).toBeGreaterThanOrEqual(2.60);
    expect(result.slippage).toBeGreaterThan(0);
  });

  it('disabled config → fills at mid', () => {
    const result = applyFill('bidask', 2.50, 2.40, 2.60, 'sell',
      { ...DEFAULT_CFG, enabled: false }, 1000, 30);
    expect(result.fillPrice).toBe(2.50);
  });

  it('sell slippage + buy slippage = round-trip cost', () => {
    const sell = applyFill('bidask', 2.50, 2.40, 2.60, 'sell',
      DEFAULT_CFG, 1000, 30);
    const buy = applyFill('bidask', 2.50, 2.40, 2.60, 'buy',
      DEFAULT_CFG, 1000, 30);
    const roundTrip = buy.fillPrice - sell.fillPrice;
    const naturalSpread = 2.60 - 2.40;
    // Round trip cost should be >= natural spread
    expect(roundTrip).toBeGreaterThanOrEqual(naturalSpread - 0.001);
  });
});
