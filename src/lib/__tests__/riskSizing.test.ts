/**
 * Unit tests for riskSizing.ts — position sizing, Kelly, and portfolio Greeks.
 */
import { describe, it, expect } from 'vitest';
import {
  STOP_OUT_PCT,
  getPositionMaxLossDollars,
  getPositionRiskAtStopOutDollars,
  getMaxLossPerContractDollars,
  getKellyContracts,
  getSuggestedContracts,
  aggregatePortfolioGreeks,
} from '../riskSizing';

// Minimal position stubs
const singleLegPos = (overrides = {}) => ({
  id: '1', ticker: 'AAPL', type: 'Long Call', status: 'active',
  legs: [], expiration: '2026-04-18', ...overrides,
} as any);

const spreadPos = (overrides = {}) => ({
  id: '2', ticker: 'SPY', type: 'Credit Put Spread', status: 'active',
  legs: [
    { strike: 580, type: 'Put', side: 'short', expiration: '2026-04-18' },
    { strike: 575, type: 'Put', side: 'long', expiration: '2026-04-18' },
  ],
  ...overrides,
} as any);

describe('STOP_OUT_PCT', () => {
  it('is 0.5', () => {
    expect(STOP_OUT_PCT).toBe(0.5);
  });
});

describe('getPositionMaxLossDollars', () => {
  it('single leg: cost × 100 × qty', () => {
    const pos = singleLegPos();
    expect(getPositionMaxLossDollars(pos, 2, 3.50)).toBe(3.50 * 100 * 2);
  });

  it('credit spread: (width - credit) × 100 × qty', () => {
    const pos = spreadPos();
    // width = 580 - 575 = 5, credit = 1.20 (entryPrice)
    expect(getPositionMaxLossDollars(pos, 1, 1.20)).toBe((5 - 1.20) * 100 * 1);
  });

  it('qty=0 → 0', () => {
    expect(getPositionMaxLossDollars(singleLegPos(), 0, 5.0)).toBe(0);
  });
});

describe('getPositionRiskAtStopOutDollars', () => {
  it('no stop price → stopOut fraction of max loss', () => {
    const pos = singleLegPos();
    const maxLoss = 3.50 * 100 * 2;
    expect(getPositionRiskAtStopOutDollars(pos, 2, 3.50)).toBe(maxLoss * STOP_OUT_PCT);
  });

  it('with stop price → |entry - stop| × 100 × qty', () => {
    const pos = singleLegPos({ stop_price: 2.00 });
    // |3.50 - 2.00| = 1.50 per share
    expect(getPositionRiskAtStopOutDollars(pos, 2, 3.50)).toBe(1.50 * 100 * 2);
  });
});

describe('getMaxLossPerContractDollars', () => {
  it('spread: maxRisk × 100', () => {
    const rec = { shortLeg: {}, longLeg: {}, maxRisk: 3.80, maxProfit: 1.20, type: 'Credit Put Spread' } as any;
    expect(getMaxLossPerContractDollars(rec)).toBe(380);
  });

  it('single leg: price × 100', () => {
    const rec = { price: 2.50, delta: -0.3, type: 'Long Put' } as any;
    expect(getMaxLossPerContractDollars(rec)).toBe(250);
  });
});

describe('getKellyContracts', () => {
  it('returns null for zero loss', () => {
    expect(getKellyContracts(100, 0, 70, 10000)).toBeNull();
  });

  it('returns null for zero portfolio', () => {
    expect(getKellyContracts(100, 300, 70, 0)).toBeNull();
  });

  it('returns null for negative edge (Kelly ≤ 0)', () => {
    // win=50, loss=300, pop=30% → b=50/300≈0.167, p=0.30, q=0.70 → kelly=(0.167*0.30-0.70)/0.167 = negative
    expect(getKellyContracts(50, 300, 30, 10000)).toBeNull();
  });

  it('positive edge → reasonable contracts', () => {
    // win=120, loss=380, pop=75% → b=0.316, p=0.75, q=0.25
    // kelly = (0.316*0.75 - 0.25)/0.316 ≈ -0.054 → null (edge not enough)
    // Let's use high-POP: win=200, loss=100, pop=70%
    // b=2.0, p=0.70, q=0.30, kelly=(2*0.7-0.3)/2=0.55, frac=0.1375, capital=1375, contracts=floor(1375/100)=13
    const result = getKellyContracts(200, 100, 70, 10000, 0.25);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(20);
  });
});

describe('getSuggestedContracts', () => {
  it('basic spread sizing', () => {
    const rec = {
      shortLeg: { strike: 580 }, longLeg: { strike: 575 },
      maxRisk: 3.80, maxProfit: 1.20, pop: 72, type: 'Credit Put Spread',
    } as any;
    const result = getSuggestedContracts(rec, 50000, 2);
    expect(result.riskCapDollars).toBe(1000); // 50000 * 2%
    expect(result.maxLossPerContractDollars).toBe(380);
    expect(result.riskPerContractAtStopOutDollars).toBe(190); // 380 * 0.5
    expect(result.contractsCap).toBe(5); // floor(1000 / 190)
    expect(result.suggestedContracts).toBe(5);
  });

  it('single leg sizing', () => {
    const rec = { price: 2.50, delta: -0.3, type: 'Long Put' } as any;
    const result = getSuggestedContracts(rec, 50000, 2);
    expect(result.maxLossPerContractDollars).toBe(250);
    expect(result.riskPerContractAtStopOutDollars).toBe(125);
    expect(result.contractsCap).toBe(8); // floor(1000/125)
  });

  it('Kelly caps below risk cap', () => {
    const rec = {
      shortLeg: { strike: 580 }, longLeg: { strike: 575 },
      maxRisk: 3.80, maxProfit: 1.20, pop: 72, type: 'Credit Put Spread',
    } as any;
    const result = getSuggestedContracts(rec, 50000, 2, { useKelly: true });
    expect(result.suggestedContracts).toBeLessThanOrEqual(result.contractsCap);
  });
});

describe('aggregatePortfolioGreeks', () => {
  it('returns null for no positions', () => {
    expect(aggregatePortfolioGreeks([], [], {}, 50000)).toBeNull();
  });

  it('returns null when no bulk data matches', () => {
    const pos = singleLegPos();
    const txns = [{ position_id: '1', quantity: 1, price: 3.5 }] as any[];
    expect(aggregatePortfolioGreeks([pos], txns, {}, 50000)).toBeNull();
  });

  it('aggregates single position Greeks', () => {
    const pos = singleLegPos({ id: 'p1' });
    const txns = [{ position_id: 'p1', quantity: 2, price: 3.5 }] as any[];
    const bulk = {
      p1: [{ delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.1 }],
    };
    const result = aggregatePortfolioGreeks([pos], txns, bulk, 50000);
    expect(result).not.toBeNull();
    expect(result!.positionsWithData).toBe(1);
    // delta = 0.5 * 2 * 100 = 100
    expect(result!.netDelta).toBeCloseTo(100, 2);
  });

  it('concentration warnings fire for >25% single ticker', () => {
    // 1 position with huge risk relative to portfolio
    const pos = singleLegPos({ id: 'p1', ticker: 'TSLA' });
    const txns = [{ position_id: 'p1', quantity: 10, price: 20.0 }] as any[];
    const bulk = {
      p1: [{ delta: 0.5, gamma: 0.01, theta: -0.02, vega: 0.05 }],
    };
    // maxLoss = 20 * 100 * 10 = 20000, stopOutRisk = 10000, portfolio = 30000 → 33% > 25%
    const result = aggregatePortfolioGreeks([pos], txns, bulk, 30000);
    expect(result).not.toBeNull();
    expect(result!.concentrationWarnings.length).toBeGreaterThan(0);
    expect(result!.concentrationWarnings[0].type).toBe('ticker');
    expect(result!.concentrationWarnings[0].label).toBe('TSLA');
  });
});
