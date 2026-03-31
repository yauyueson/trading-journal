import { describe, expect, it } from 'vitest';

import { findDebitSpreadStrikes, type ChainRow } from '../src/lib/backtest/chain-cache';

function makeRow(overrides: Partial<ChainRow>): ChainRow {
  return {
    ticker: 'SPY',
    trade_date: '2024-01-02',
    expir_date: '2024-02-16',
    dte: 35,
    strike: 100,
    stock_price: 103,
    call_bid: 1,
    call_mid: 1.1,
    call_ask: 1.2,
    call_iv: 0.2,
    call_volume: 1000,
    call_oi: 1000,
    put_bid: 1,
    put_mid: 1.1,
    put_ask: 1.2,
    put_iv: 0.22,
    put_volume: 1000,
    put_oi: 1000,
    delta: 0.5,
    gamma: 0.02,
    theta: -0.03,
    vega: 0.1,
    ...overrides,
  };
}

describe('findDebitSpreadStrikes', () => {
  it('builds a bullish call debit spread with long strike below short strike', () => {
    const chain: ChainRow[] = [
      makeRow({ strike: 100, call_mid: 4.2, call_bid: 4.1, call_ask: 4.3, delta: 0.62 }),
      makeRow({ strike: 105, call_mid: 1.8, call_bid: 1.7, call_ask: 1.9, delta: 0.24 }),
      makeRow({ strike: 110, call_mid: 0.9, call_bid: 0.8, call_ask: 1.0, delta: 0.12 }),
    ];

    const spread = findDebitSpreadStrikes(chain, 0.5, 0.2, 'Call', [30, 45]);

    expect(spread).not.toBeNull();
    expect(spread?.long.row.strike).toBe(100);
    expect(spread?.short.row.strike).toBe(105);
    expect(spread?.long.row.strike).toBeLessThan(spread!.short.row.strike);
    expect(spread?.netDebit).toBeCloseTo(2.4, 8);
    expect(spread?.maxProfit).toBeCloseTo(2.6, 8);
  });

  it('builds a bearish put debit spread with long strike above short strike', () => {
    const chain: ChainRow[] = [
      makeRow({ strike: 100, put_mid: 1.3, put_bid: 1.2, put_ask: 1.4, delta: 0.80 }),
      makeRow({ strike: 105, put_mid: 3.6, put_bid: 3.5, put_ask: 3.7, delta: 0.40 }),
      makeRow({ strike: 110, put_mid: 6.0, put_bid: 5.9, put_ask: 6.1, delta: 0.20 }),
    ];

    const spread = findDebitSpreadStrikes(chain, 0.6, 0.2, 'Put', [30, 45]);

    expect(spread).not.toBeNull();
    expect(spread?.long.row.strike).toBe(105);
    expect(spread?.short.row.strike).toBe(100);
    expect(spread?.long.row.strike).toBeGreaterThan(spread!.short.row.strike);
    expect(spread?.netDebit).toBeCloseTo(2.3, 8);
    expect(spread?.maxProfit).toBeCloseTo(2.7, 8);
  });
});
