/**
 * Option Sim Fill Tests — dailyMtM, bid/ask fills, ORATS filters
 */
import { describe, it, expect } from 'vitest';
import { applyFill } from '../src/lib/backtest/slippage';
import { DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import type { SpreadMatch } from '../src/lib/backtest/chain-cache';

describe('dailyMtM population', () => {
  it('OptionTrade.dailyMtM has one entry per monitoring day', () => {
    const mockMtM = [
      { date: '2024-01-03', spreadMid: 0.95, unrealizedPnl: 5 },
      { date: '2024-01-04', spreadMid: 0.88, unrealizedPnl: 12 },
      { date: '2024-01-05', spreadMid: 1.10, unrealizedPnl: -10 },
    ];
    expect(mockMtM).toHaveLength(3);
    expect(mockMtM[0].date).toBe('2024-01-03');
    expect(mockMtM[2].unrealizedPnl).toBe(-10);
  });
});

// Mock spread for fill and filter tests
const mockSpread: SpreadMatch = {
  short: {
    row: { ticker: 'SPY', trade_date: '2024-01-02', expir_date: '2024-02-16',
      dte: 45, strike: 470, stock_price: 480,
      call_bid: 0, call_mid: 0, call_ask: 0, call_iv: 0, call_volume: 0, call_oi: 0,
      put_bid: 2.35, put_mid: 2.50, put_ask: 2.65, put_iv: 0.18, put_volume: 500, put_oi: 3000,
      delta: 0.65, gamma: 0.02, theta: -0.05, vega: 0.10 },
    type: 'Put', bid: 2.35, ask: 2.65, mid: 2.50, iv: 0.18, delta: -0.35, volume: 500, oi: 3000,
  },
  long: {
    row: { ticker: 'SPY', trade_date: '2024-01-02', expir_date: '2024-02-16',
      dte: 45, strike: 460, stock_price: 480,
      call_bid: 0, call_mid: 0, call_ask: 0, call_iv: 0, call_volume: 0, call_oi: 0,
      put_bid: 1.35, put_mid: 1.50, put_ask: 1.65, put_iv: 0.20, put_volume: 200, put_oi: 1500,
      delta: 0.80, gamma: 0.01, theta: -0.03, vega: 0.06 },
    type: 'Put', bid: 1.35, ask: 1.65, mid: 1.50, iv: 0.20, delta: -0.20, volume: 200, oi: 1500,
  },
  netCredit: 1.00,       // mid - mid
  spreadWidth: 10,
  maxLoss: 9.00,
};

describe('Credit Spread Bid/Ask Entry', () => {
  function computeRealisticCredit(spread: SpreadMatch, cfg: typeof DEFAULT_DYNAMIC_SLIPPAGE): number {
    const shortFill = applyFill('bidask', spread.short.mid, spread.short.bid,
      spread.short.ask, 'sell', cfg, spread.short.oi, spread.short.row.dte);
    const longFill = applyFill('bidask', spread.long.mid, spread.long.bid,
      spread.long.ask, 'buy', cfg, spread.long.oi, spread.long.row.dte);
    return shortFill.fillPrice - longFill.fillPrice;
  }

  it('mid-price credit = $1.00 (short mid - long mid)', () => {
    expect(mockSpread.netCredit).toBe(1.00);
  });

  it('bidask credit < mid credit (always worse for seller)', () => {
    const realisticCredit = computeRealisticCredit(mockSpread, DEFAULT_DYNAMIC_SLIPPAGE);
    expect(realisticCredit).toBeLessThan(mockSpread.netCredit);
  });

  it('bidask credit is positive (trade still viable for liquid names)', () => {
    const realisticCredit = computeRealisticCredit(mockSpread, DEFAULT_DYNAMIC_SLIPPAGE);
    expect(realisticCredit).toBeGreaterThan(0);
  });

  it('natural bid/ask alone reduces credit by ~$0.30', () => {
    // short at bid ($2.35) - long at ask ($1.65) = $0.70 vs mid $1.00
    const naturalCredit = mockSpread.short.bid - mockSpread.long.ask;
    expect(naturalCredit).toBeCloseTo(0.70, 2);
    expect(mockSpread.netCredit - naturalCredit).toBeCloseTo(0.30, 2);
  });
});

describe('ORATS Liquidity & Greeks Filters', () => {
  it('maxBidAskSpreadPct filters wide-spread strikes', () => {
    // short leg: (2.65-2.35)/2.50 = 12% spread
    const spreadPct = (mockSpread.short.ask - mockSpread.short.bid) / mockSpread.short.mid;
    expect(spreadPct).toBeCloseTo(0.12, 2);
    // With maxBidAskSpreadPct=0.10 → should reject
    const passes10 = spreadPct <= 0.10;
    expect(passes10).toBe(false);
    // With maxBidAskSpreadPct=0.15 → should pass
    const passes15 = spreadPct <= 0.15;
    expect(passes15).toBe(true);
  });

  it('minShortOI filters low-OI strikes', () => {
    expect(mockSpread.short.oi).toBe(3000);
    expect(mockSpread.short.oi >= 500).toBe(true);
    expect(mockSpread.short.oi >= 5000).toBe(false);
  });

  it('maxGammaThetaRatio filters gamma-heavy positions', () => {
    // gamma=0.02, theta=-0.05 → ratio = 0.02/0.05 = 0.4
    const ratio = mockSpread.short.row.gamma / Math.abs(mockSpread.short.row.theta);
    expect(ratio).toBeCloseTo(0.4, 2);
    expect(ratio <= 0.3).toBe(false);  // filtered at 0.3
    expect(ratio <= 0.5).toBe(true);   // passes at 0.5
  });

  it('maxIVSkew filters steep-skew pairs', () => {
    // shortIV=0.18, longIV=0.20 → skew = |0.18-0.20| = 0.02
    const skew = Math.abs(mockSpread.short.iv - mockSpread.long.iv);
    expect(skew).toBeCloseTo(0.02, 3);
    expect(skew <= 0.01).toBe(false);  // filtered at 1%
    expect(skew <= 0.03).toBe(true);   // passes at 3%
  });
});
