import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChainRow, DebitSpreadMatch, StrikeMatch } from '../src/lib/backtest/chain-cache';

vi.mock('../src/lib/backtest/chain-cache', () => ({
  fetchHistoricalChain: vi.fn(),
  findStrikeByDelta: vi.fn(),
  findSpreadStrikes: vi.fn(),
  findDebitSpreadStrikes: vi.fn(),
  findContract: vi.fn(),
  findContractDirect: vi.fn(),
}));

import {
  DEFAULT_DEBIT_CONFIG,
  simulateDebitSpread,
  type EntrySignal,
} from '../src/lib/backtest/option-sim';
import {
  fetchHistoricalChain,
  findContractDirect,
  findDebitSpreadStrikes,
} from '../src/lib/backtest/chain-cache';
import { buildIndexedUnderlyingHistory } from '../src/lib/backtest/underlying-sim';
import type { BacktestCandle } from '../src/lib/backtest/types';

const fetchHistoricalChainMock = vi.mocked(fetchHistoricalChain);
const findDebitSpreadStrikesMock = vi.mocked(findDebitSpreadStrikes);
const findContractDirectMock = vi.mocked(findContractDirect);

function makeRow(tradeDate: string, dte: number): ChainRow {
  return {
    ticker: 'SPY',
    trade_date: tradeDate,
    expir_date: '2024-02-16',
    dte,
    strike: 100,
    stock_price: 103,
    call_bid: 2,
    call_mid: 2.1,
    call_ask: 2.2,
    call_iv: 0.2,
    call_volume: 1000,
    call_oi: 1000,
    put_bid: 2,
    put_mid: 2.1,
    put_ask: 2.2,
    put_iv: 0.22,
    put_volume: 1000,
    put_oi: 1000,
    delta: 0.4,
    gamma: 0.02,
    theta: -0.03,
    vega: 0.1,
  };
}

function makeLeg(date: string, dte: number, strike: number, mid: number, delta: number): StrikeMatch {
  return {
    row: { ...makeRow(date, dte), strike, stock_price: strike < 103 ? 103 : 97 },
    type: 'Call',
    bid: mid - 0.05,
    ask: mid + 0.05,
    mid,
    iv: 0.2,
    delta,
    volume: 1000,
    oi: 1000,
  };
}

function setupEntrySpread(): DebitSpreadMatch {
  return {
    long: makeLeg('2024-01-02', 30, 100, 4.0, 0.55),
    short: makeLeg('2024-01-02', 30, 105, 1.5, 0.25),
    netDebit: 2.5,
    requestedLongDelta: 0.5,
    requestedShortDelta: 0.2,
    spreadWidth: 5,
    maxProfit: 2.5,
    maxLoss: 2.5,
  };
}

function makeCandles(closes: number[]): BacktestCandle[] {
  return closes.map((close, index) => ({
    date: `2024-01-0${index + 1}`,
    timestamp: Date.UTC(2024, 0, index + 1),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000_000,
  }));
}

describe('simulateDebitSpread', () => {
  const allTradingDates = ['2024-01-02', '2024-01-03', '2024-01-04'];
  const signal: EntrySignal = {
    ticker: 'SPY',
    date: '2024-01-02',
    direction: 'CALL',
    score: 80,
    ivRank: 35,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchHistoricalChainMock.mockResolvedValue([makeRow('2024-01-02', 30)]);
    findDebitSpreadStrikesMock.mockReturnValue(setupEntrySpread());
  });

  it('exits at the profit target when spread value reaches the target threshold', async () => {
    findContractDirectMock.mockImplementation((_ticker, date, strike) => {
      if (date === '2024-01-03') {
        return strike === 100
          ? makeLeg(date, 29, 100, 5.0, 0.65)
          : makeLeg(date, 29, 105, 1.0, 0.15);
      }
      return null;
    });

    const trade = await simulateDebitSpread(
      'token',
      signal,
      {
        ...DEFAULT_DEBIT_CONFIG,
        useDirectLookup: true,
        debitProfitTargetPct: 0.5,
        debitMaxHoldDays: 10,
        debitMinExitDTE: 0,
      },
      allTradingDates,
      '2024-01-04',
    );

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('PROFIT_TARGET');
    expect(trade?.exitPrice).toBeCloseTo(3.75, 8);
    expect(trade?.maxProfit).toBeCloseTo(2.5, 8);
    expect(trade?.maxLoss).toBeCloseTo(2.5, 8);
  });

  it('prefers underlying exit over time stop when both would fire on the same day', async () => {
    findContractDirectMock.mockImplementation((_ticker, date, strike) => {
      if (date === '2024-01-03') {
        return strike === 100
          ? makeLeg(date, 29, 100, 2.4, 0.48)
          : makeLeg(date, 29, 105, 1.0, 0.20);
      }
      return null;
    });
    const history = buildIndexedUnderlyingHistory(makeCandles([100, 101, 99]), [2]);

    const trade = await simulateDebitSpread(
      'token',
      signal,
      {
        ...DEFAULT_DEBIT_CONFIG,
        useDirectLookup: true,
        underlyingExitEMA: 2,
        underlyingExitConfirmDays: 1,
        underlyingExitRequireSlope: true,
        debitMaxHoldDays: 1,
        debitMinExitDTE: 0,
      },
      allTradingDates,
      '2024-01-04',
      { SPY: history },
    );

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('UNDERLYING_EXIT');
  });

  it('uses time stop when DTE hits the configured minimum exit DTE', async () => {
    findContractDirectMock.mockImplementation((_ticker, date, strike) => {
      if (date === '2024-01-03') {
        return strike === 100
          ? makeLeg(date, 14, 100, 2.8, 0.50)
          : makeLeg(date, 14, 105, 1.0, 0.20);
      }
      return null;
    });

    const trade = await simulateDebitSpread(
      'token',
      signal,
      {
        ...DEFAULT_DEBIT_CONFIG,
        useDirectLookup: true,
        debitMaxHoldDays: 10,
        debitMinExitDTE: 14,
      },
      allTradingDates,
      '2024-01-04',
    );

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('TIME_STOP');
  });
});
