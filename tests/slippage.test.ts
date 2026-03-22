// tests/slippage.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeSlippage,
  applyFill,
  applySpreadFill,
} from '../src/lib/backtest/slippage';
import type { DynamicSlippageConfig } from '../src/lib/backtest/types';

const DEFAULT_CFG: DynamicSlippageConfig = {
  enabled: true,
  fillMode: 'bidask',
  executionStyle: 'combo',
  baseImpactBps: 2,
  oiHalfLife: 500,
  maxOiFactor: 6,
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

  it('low OI amplification is capped by maxOiFactor', () => {
    const slipNearZero = computeSlippage(DEFAULT_CFG, 0.10, 1, 30, 2.50);
    const slipAtTen = computeSlippage(DEFAULT_CFG, 0.10, 10, 30, 2.50);
    expect(slipNearZero).toBeGreaterThanOrEqual(slipAtTen);
    expect(Number.isFinite(slipNearZero)).toBe(true);
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

describe('applySpreadFill', () => {
  const shortLeg = { mid: 2.50, bid: 2.40, ask: 2.60, oi: 3000, dte: 30 };
  const longLeg = { mid: 1.50, bid: 1.40, ask: 1.60, oi: 2500, dte: 30 };

  it('mid mode returns net mid', () => {
    const result = applySpreadFill('mid', shortLeg, longLeg, 'open', DEFAULT_CFG);
    expect(result.fillPrice).toBe(1.00);
    expect(result.slippage).toBe(0);
  });

  it('combo entry is less punitive than legging the same spread', () => {
    const combo = applySpreadFill('bidask', shortLeg, longLeg, 'open', DEFAULT_CFG);
    const leggedSell = applyFill('bidask', shortLeg.mid, shortLeg.bid, shortLeg.ask, 'sell', DEFAULT_CFG, shortLeg.oi, shortLeg.dte);
    const leggedBuy = applyFill('bidask', longLeg.mid, longLeg.bid, longLeg.ask, 'buy', DEFAULT_CFG, longLeg.oi, longLeg.dte);
    const leggedCredit = leggedSell.fillPrice - leggedBuy.fillPrice;
    expect(combo.fillPrice).toBeGreaterThan(leggedCredit);
  });
});
