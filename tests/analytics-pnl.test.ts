import { describe, expect, it } from 'vitest';
import { computeAnalyticsPositionPnL } from '../api/analytics.js';

describe('analytics P&L sign conventions', () => {
  it('computes credit spread P&L as credit received minus debit paid', () => {
    const transactions = [
      { quantity: 1, price: 0.50 },
      { quantity: -1, price: 0.20 },
    ];

    expect(computeAnalyticsPositionPnL(transactions, { type: 'Put Credit Spread' })).toBe(30);
  });

  it('computes debit spread P&L as proceeds minus cost', () => {
    const transactions = [
      { quantity: 1, price: 2.00 },
      { quantity: -1, price: 3.50 },
    ];

    expect(computeAnalyticsPositionPnL(transactions, { strategy_type: 'bcd', type: 'Call Spread' })).toBe(150);
  });

  it('computes single long-option P&L as proceeds minus cost', () => {
    const transactions = [
      { quantity: 2, price: 1.25 },
      { quantity: -2, price: 1.75 },
    ];

    expect(computeAnalyticsPositionPnL(transactions, { type: 'Long Call' })).toBe(100);
  });
});
