import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainRow, SpreadMatch, StrikeMatch } from '../src/lib/backtest/chain-cache';

vi.mock('../src/lib/backtest/chain-cache', () => ({
  fetchHistoricalChain: vi.fn(),
  findStrikeByDelta: vi.fn(),
  findSpreadStrikes: vi.fn(),
  findContract: vi.fn(),
  findContractDirect: vi.fn(),
}));

import {
  DEFAULT_CREDIT_CONFIG,
  simulateCreditSpread,
  type EntrySignal,
} from '../src/lib/backtest/option-sim';
import {
  fetchHistoricalChain,
  findSpreadStrikes,
  findContractDirect,
} from '../src/lib/backtest/chain-cache';

const fetchHistoricalChainMock = vi.mocked(fetchHistoricalChain);
const findSpreadStrikesMock = vi.mocked(findSpreadStrikes);
const findContractDirectMock = vi.mocked(findContractDirect);

function makeRow(tradeDate: string, dte: number): ChainRow {
  return {
    ticker: 'SPY',
    trade_date: tradeDate,
    expir_date: '2024-01-19',
    dte,
    strike: 100,
    stock_price: 102,
    call_bid: 2, call_mid: 2.1, call_ask: 2.2, call_iv: 0.2, call_volume: 1000, call_oi: 1000,
    put_bid: 1.8, put_mid: 1.9, put_ask: 2.0, put_iv: 0.22, put_volume: 1000, put_oi: 1000,
    delta: 0.4, gamma: 0.02, theta: -0.03, vega: 0.1,
  };
}

function makeLeg(date: string, dte: number, strike: number, mid: number, delta: number): StrikeMatch {
  return {
    row: { ...makeRow(date, dte), strike },
    type: 'Put',
    bid: mid - 0.05,
    ask: mid + 0.05,
    mid,
    iv: 0.22,
    delta,
    volume: 1000,
    oi: 1000,
  };
}

// Entry: short 100 at 2.0, long 95 at 1.0 → credit=1.0, width=5, maxLoss=4
function setupEntrySpread(): SpreadMatch {
  return {
    short: makeLeg('2024-01-02', 10, 100, 2.0, -0.35),
    long: makeLeg('2024-01-02', 10, 95, 1.0, -0.15),
    netCredit: 1.0,
    spreadWidth: 5,
    maxLoss: 4,
  };
}

const allTradingDates = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'];
const signal: EntrySignal = {
  ticker: 'SPY',
  date: '2024-01-02',
  direction: 'CALL',
  score: 80,
  ivRank: 50,
};

describe('simulateCreditSpread MAX_LOSS_STOP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchHistoricalChainMock.mockResolvedValue([makeRow('2024-01-02', 10)]);
    findSpreadStrikesMock.mockReturnValue(setupEntrySpread());
  });

  it('exits with MAX_LOSS_STOP when loss exceeds % of max loss', async () => {
    // entry credit=1.0, width=5, maxLoss=4
    // creditMaxLossStopPct=0.50 → threshold = 1.0 + 0.50*4 = 3.0
    // Day 1: spread cost 2.5 (below 3.0, no exit)
    // Day 2: spread cost 3.5 (above 3.0, MAX_LOSS_STOP)
    findContractDirectMock.mockImplementation((_ticker, date, strike) => {
      if (date === '2024-01-03') {
        return strike === 100
          ? makeLeg(date, 9, 100, 2.75, -0.50)   // short mid
          : makeLeg(date, 9, 95, 0.25, -0.10);     // long mid → spread cost=2.5
      }
      if (date === '2024-01-04') {
        return strike === 100
          ? makeLeg(date, 8, 100, 3.75, -0.60)
          : makeLeg(date, 8, 95, 0.25, -0.08);     // spread cost=3.5
      }
      return null;
    });

    const trade = await simulateCreditSpread(
      'token', signal,
      {
        ...DEFAULT_CREDIT_CONFIG,
        useDirectLookup: true,
        creditSpreadWidth: 5,
        creditMaxLossStopPct: 0.50,
        creditStopLossMultiple: 100,
        creditTimeStopDTE: 0,
      },
      allTradingDates, '2024-01-05',
    );

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('MAX_LOSS_STOP');
    expect(trade?.exitDate).toBe('2024-01-04');
  });

  it('does not trigger MAX_LOSS_STOP when disabled (undefined)', async () => {
    findContractDirectMock.mockImplementation((_ticker, date, strike) => {
      if (date === '2024-01-03') {
        return strike === 100
          ? makeLeg(date, 9, 100, 3.75, -0.60)
          : makeLeg(date, 9, 95, 0.25, -0.08);     // spread cost=3.5 (big loss)
      }
      if (date === '2024-01-04') {
        return strike === 100
          ? makeLeg(date, 8, 100, 4.25, -0.70)
          : makeLeg(date, 8, 95, 0.25, -0.05);     // spread cost=4.0
      }
      return null;
    });

    const trade = await simulateCreditSpread(
      'token', signal,
      {
        ...DEFAULT_CREDIT_CONFIG,
        useDirectLookup: true,
        creditSpreadWidth: 5,
        // creditMaxLossStopPct not set → disabled
        creditStopLossMultiple: 100,
        creditTimeStopDTE: 0,
      },
      allTradingDates, '2024-01-05',
    );

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('EXPIRATION');
  });
});

describe('simulateCreditSpread TRAILING_LOCK', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchHistoricalChainMock.mockResolvedValue([makeRow('2024-01-02', 10)]);
    findSpreadStrikesMock.mockReturnValue(setupEntrySpread());
  });

  it('activates trailing floor and exits on retrace', async () => {
    // entry credit=1.0, TP=0.30, tpProfit=0.30
    // trailingActivatePct=0.50 → activate at profit 0.15 → spread cost <= 0.85
    // trailingFloorPct=0.25 → floor at profit 0.075 → spread cost 0.925
    // Day 1: spread cost 0.80 → profit=0.20, activates floor (0.20 >= 0.15)
    // Day 2: spread cost 0.95 → profit=0.05, below floor (0.95 > 0.925) → TRAILING_LOCK
    findContractDirectMock.mockImplementation((_ticker, date, strike) => {
      if (date === '2024-01-03') {
        return strike === 100
          ? makeLeg(date, 9, 100, 1.10, -0.25)
          : makeLeg(date, 9, 95, 0.30, -0.08);     // spread cost=0.80
      }
      if (date === '2024-01-04') {
        return strike === 100
          ? makeLeg(date, 8, 100, 1.50, -0.35)
          : makeLeg(date, 8, 95, 0.55, -0.12);     // spread cost=0.95
      }
      return null;
    });

    const trade = await simulateCreditSpread(
      'token', signal,
      {
        ...DEFAULT_CREDIT_CONFIG,
        useDirectLookup: true,
        creditProfitTarget: 0.30,
        trailingActivatePct: 0.50,
        trailingFloorPct: 0.25,
        creditStopLossMultiple: 100,
        creditTimeStopDTE: 0,
      },
      allTradingDates, '2024-01-05',
    );

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('TRAILING_LOCK');
    expect(trade?.exitDate).toBe('2024-01-04');
  });

  it('does not trigger trailing lock if profit never reaches activation', async () => {
    // trailingActivatePct=0.75 → activate at profit 0.225 → spread cost <= 0.775
    // Day 1: spread cost 0.85 → profit=0.15, NOT activated (0.15 < 0.225)
    // Day 2: spread cost 0.90 → profit=0.10, still NOT activated
    // → exits at expiration, not trailing lock
    findContractDirectMock.mockImplementation((_ticker, date, strike) => {
      if (date === '2024-01-03') {
        return strike === 100
          ? makeLeg(date, 9, 100, 1.15, -0.28)
          : makeLeg(date, 9, 95, 0.30, -0.08);     // spread cost=0.85
      }
      if (date === '2024-01-04') {
        return strike === 100
          ? makeLeg(date, 8, 100, 1.20, -0.30)
          : makeLeg(date, 8, 95, 0.30, -0.08);     // spread cost=0.90
      }
      return null;
    });

    const trade = await simulateCreditSpread(
      'token', signal,
      {
        ...DEFAULT_CREDIT_CONFIG,
        useDirectLookup: true,
        creditProfitTarget: 0.30,
        trailingActivatePct: 0.75,
        trailingFloorPct: 0.25,
        creditStopLossMultiple: 100,
        creditTimeStopDTE: 0,
      },
      allTradingDates, '2024-01-05',
    );

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('EXPIRATION');
  });

  it('TP wins over trailing lock when both would trigger on same bar', async () => {
    // entry credit=1.0, TP=0.30 → tpCost=0.70
    // trailing activate at 50% of TP → profit 0.15 → spread cost <=0.85
    // trailing floor at 50% of TP → profit 0.15 → floor cost = 0.85
    // Day 1: spread cost 0.65 → hits TP (0.65 <= 0.70) AND would activate trailing
    // → TP should win (checked first)
    findContractDirectMock.mockImplementation((_ticker, date, strike) => {
      if (date === '2024-01-03') {
        return strike === 100
          ? makeLeg(date, 9, 100, 0.90, -0.15)
          : makeLeg(date, 9, 95, 0.25, -0.05);     // spread cost=0.65
      }
      return null;
    });

    const trade = await simulateCreditSpread(
      'token', signal,
      {
        ...DEFAULT_CREDIT_CONFIG,
        useDirectLookup: true,
        creditProfitTarget: 0.30,
        trailingActivatePct: 0.50,
        trailingFloorPct: 0.50,
        creditStopLossMultiple: 100,
        creditTimeStopDTE: 0,
      },
      allTradingDates, '2024-01-05',
    );

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('PROFIT_TARGET');
  });
});
