import { describe, expect, it } from 'vitest';

import {
  computeFrontBackIVAnomaly,
  findLongOptionInBand,
  type ChainRow,
} from '../src/lib/backtest/chain-cache';

function row(overrides: Partial<ChainRow>): ChainRow {
  return {
    ticker: 'SPY',
    trade_date: '2024-01-02',
    expir_date: '2024-02-16',
    dte: 45,
    strike: 100,
    stock_price: 105,
    call_bid: 5.8,
    call_mid: 6,
    call_ask: 6.2,
    call_iv: 0.24,
    call_volume: 1000,
    call_oi: 500,
    put_bid: 0.9,
    put_mid: 1,
    put_ask: 1.1,
    put_iv: 0.26,
    put_volume: 1000,
    put_oi: 500,
    delta: 0.72,
    gamma: 0.02,
    theta: -0.03,
    vega: 0.15,
    ...overrides,
  };
}

describe('findLongOptionInBand', () => {
  it('selects the contract nearest the delta midpoint and DTE midpoint', () => {
    const chain = [
      row({ expir_date: '2024-02-09', dte: 38, strike: 102, call_mid: 5.6, call_bid: 5.4, call_ask: 5.8, delta: 0.70, call_oi: 300 }),
      row({ expir_date: '2024-02-16', dte: 45, strike: 100, call_mid: 6.0, call_bid: 5.9, call_ask: 6.1, delta: 0.74, call_oi: 900 }),
      row({ expir_date: '2024-03-15', dte: 73, strike: 95, call_mid: 9.2, call_bid: 9.0, call_ask: 9.4, delta: 0.79, call_oi: 1500 }),
    ];

    const result = findLongOptionInBand(chain, [0.70, 0.80], 'Call', [35, 50], {
      minMid: 1,
      minOI: 100,
      maxSpreadPct: 0.06,
    });

    expect(result).not.toBeNull();
    expect(result!.contract.row.expir_date).toBe('2024-02-16');
    expect(result!.contract.row.strike).toBe(100);
  });

  it('rejects contracts wider than the max spread filter', () => {
    const chain = [
      row({ call_bid: 5, call_mid: 6, call_ask: 7.5, call_oi: 800 }),
    ];

    const result = findLongOptionInBand(chain, [0.70, 0.80], 'Call', [35, 50], {
      minMid: 1,
      minOI: 100,
      maxSpreadPct: 0.10,
    });

    expect(result).toBeNull();
  });
});

describe('computeFrontBackIVAnomaly', () => {
  it('computes near/back IV ratio from representative strikes', () => {
    const chain = [
      row({ expir_date: '2024-01-26', dte: 24, delta: 0.52, call_iv: 0.42, put_iv: 0.40 }),
      row({ expir_date: '2024-02-16', dte: 45, delta: 0.49, call_iv: 0.30, put_iv: 0.28 }),
      row({ expir_date: '2024-03-15', dte: 73, delta: 0.50, call_iv: 0.29, put_iv: 0.27 }),
    ];

    const ratio = computeFrontBackIVAnomaly(chain);

    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThan(1.3);
    expect(ratio!).toBeLessThan(1.6);
  });
});
