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
    call_bid: 2,
    call_mid: 2.1,
    call_ask: 2.2,
    call_iv: 0.2,
    call_volume: 1000,
    call_oi: 1000,
    put_bid: 1.8,
    put_mid: 1.9,
    put_ask: 2.0,
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

function setupEntrySpread(): SpreadMatch {
  return {
    short: makeLeg('2024-01-02', 10, 100, 2.0, -0.35),
    long: makeLeg('2024-01-02', 10, 95, 1.0, -0.15),
    netCredit: 1.0,
    spreadWidth: 5,
    maxLoss: 4,
  };
}

describe('simulateCreditSpread creditDeltaStop', () => {
  const allTradingDates = ['2024-01-02', '2024-01-03', '2024-01-04'];
  const signal: EntrySignal = {
    ticker: 'SPY',
    date: '2024-01-02',
    direction: 'CALL',
    score: 80,
    ivRank: 50,
  };

  const MID_FILLS = {
    fillMode: 'mid' as const,
    slippage: { ...DEFAULT_CREDIT_CONFIG.slippage, enabled: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchHistoricalChainMock.mockResolvedValue([makeRow('2024-01-02', 10)]);
    findSpreadStrikesMock.mockReturnValue(setupEntrySpread());
  });

  it('exits with DELTA_STOP when |short delta| breaches threshold', async () => {
    findContractDirectMock.mockImplementation((_ticker, date, strike) => {
      if (date === '2024-01-03') {
        return strike === 100
          ? makeLeg(date, 9, 100, 1.95, -0.40)
          : makeLeg(date, 9, 95, 1.00, -0.18);
      }
      if (date === '2024-01-04') {
        return strike === 100
          ? makeLeg(date, 8, 100, 2.02, -0.72)
          : makeLeg(date, 8, 95, 1.00, -0.20);
      }
      return null;
    });

    const trade = await simulateCreditSpread(
      'token',
      signal,
      {
        ...DEFAULT_CREDIT_CONFIG,
        ...MID_FILLS,
        useDirectLookup: true,
        creditDeltaStop: 0.65,
        creditStopLossMultiple: 100, // ensure SL does not trigger first
        creditTimeStopDTE: 0, // ensure time stop does not trigger first
      },
      allTradingDates,
      '2024-01-04',
    );

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('DELTA_STOP');
    expect(trade?.exitDate).toBe('2024-01-04');
    expect(trade?.dailyMtM?.length).toBe(2);
  });

  it('does not delta-stop when threshold is disabled', async () => {
    findContractDirectMock.mockImplementation((_ticker, date, strike) => {
      if (date === '2024-01-03') {
        return strike === 100
          ? makeLeg(date, 9, 100, 1.95, -0.80)
          : makeLeg(date, 9, 95, 1.00, -0.20);
      }
      if (date === '2024-01-04') {
        return strike === 100
          ? makeLeg(date, 8, 100, 2.00, -0.85)
          : makeLeg(date, 8, 95, 1.00, -0.25);
      }
      return null;
    });

    const trade = await simulateCreditSpread(
      'token',
      signal,
      {
        ...DEFAULT_CREDIT_CONFIG,
        ...MID_FILLS,
        useDirectLookup: true,
        creditDeltaStop: 0, // treated as disabled
        creditStopLossMultiple: 100,
        creditTimeStopDTE: 0,
      },
      allTradingDates,
      '2024-01-04',
    );

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('EXPIRATION');
  });
});
