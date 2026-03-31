import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DYNAMIC_SLIPPAGE,
  type BacktestCandle,
} from '../src/lib/backtest/types';
import { buildUnderlyingHistory, indexUnderlyingHistories } from '../src/lib/backtest/underlying-stop';
import { DEFAULT_SWING_LONG_OPTION_CONFIG, type EntrySignal, type SimConfig } from '../src/lib/backtest/option-sim';
import {
  buildShadowUnderlyingTrade,
  computeSwingLongContracts,
  resolveSwingLongMinExitDTE,
  simulateSwingLongOption,
} from '../src/lib/backtest/swing-long-option';
import type { ChainRow } from '../src/lib/backtest/chain-cache';

function candle(date: string, close: number): BacktestCandle {
  return {
    date,
    timestamp: new Date(`${date}T00:00:00Z`).getTime(),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000_000,
  };
}

function makeRow(date: string, dte: number, stockPrice: number, optionMid: number, delta: number, strike = 95): ChainRow {
  return {
    ticker: 'SPY',
    trade_date: date,
    expir_date: '2024-02-16',
    dte,
    strike,
    stock_price: stockPrice,
    call_bid: optionMid - 0.1,
    call_mid: optionMid,
    call_ask: optionMid + 0.1,
    call_iv: 0.25,
    call_volume: 500,
    call_oi: 800,
    put_bid: 0.5,
    put_mid: 0.6,
    put_ask: 0.7,
    put_iv: 0.28,
    put_volume: 500,
    put_oi: 800,
    delta,
    gamma: 0.02,
    theta: -0.04,
    vega: 0.15,
  };
}

function baseConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  return {
    ...DEFAULT_SWING_LONG_OPTION_CONFIG,
    fillMode: 'mid',
    slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
    swingLongRiskBudgetPct: 0.01,
    ...overrides,
  };
}

function buildHistories(candles: BacktestCandle[]) {
  return indexUnderlyingHistories({
    SPY: buildUnderlyingHistory(candles, [21, 34]),
  });
}

describe('swing long option helpers', () => {
  it('resolves band-specific DTE floors', () => {
    expect(resolveSwingLongMinExitDTE([35, 50])).toBe(14);
    expect(resolveSwingLongMinExitDTE([50, 70])).toBe(21);
  });

  it('sizes contracts from premium-at-risk budget', () => {
    expect(computeSwingLongContracts(100_000, 0.005, 5)).toBe(1);
    expect(computeSwingLongContracts(100_000, 0.01, 5)).toBe(2);
  });
});

describe('simulateSwingLongOption', () => {
  const signal: EntrySignal = {
    ticker: 'SPY',
    date: '2024-01-02',
    direction: 'CALL',
    score: 85,
    dirConfidence: 75,
    d8: 0.3,
    ivRank: 40,
    recentMaxGapPct10: 2,
    frontBackIVAnomaly: 1.05,
  };

  it('exits at the profit target when the option premium appreciates', () => {
    const candles = [
      candle('2023-12-20', 95),
      candle('2023-12-21', 95.5),
      candle('2023-12-22', 96),
      candle('2023-12-26', 96.5),
      candle('2023-12-27', 97),
      candle('2023-12-28', 97.5),
      candle('2023-12-29', 98),
      candle('2024-01-02', 100),
      candle('2024-01-03', 103),
      candle('2024-01-04', 104),
    ];
    const chainByDate: Record<string, ChainRow[]> = {
      '2024-01-02': [makeRow('2024-01-02', 45, 100, 8, 0.75)],
      '2024-01-03': [makeRow('2024-01-03', 44, 103, 10.5, 0.82)],
      '2024-01-04': [makeRow('2024-01-04', 43, 104, 11, 0.84)],
    };

    const result = simulateSwingLongOption(
      signal,
      baseConfig({ swingLongProfitTargetPct: 0.25 }),
      ['2024-01-02', '2024-01-03', '2024-01-04'],
      '2024-01-04',
      (_ticker, date) => chainByDate[date] ?? [],
      buildHistories(candles),
      100_000,
      (_ticker, date, strike, expiry, type) =>
        (chainByDate[date] ?? []).find(row =>
          row.expir_date === expiry &&
          Math.abs(row.strike - strike) < 0.01 &&
          type === 'Call'
        )
          ? {
              row: (chainByDate[date] ?? []).find(row =>
                row.expir_date === expiry && Math.abs(row.strike - strike) < 0.01,
              )!,
              type,
              bid: (chainByDate[date] ?? [])[0].call_bid,
              ask: (chainByDate[date] ?? [])[0].call_ask,
              mid: (chainByDate[date] ?? [])[0].call_mid,
              iv: (chainByDate[date] ?? [])[0].call_iv,
              delta: (chainByDate[date] ?? [])[0].delta,
              volume: (chainByDate[date] ?? [])[0].call_volume,
              oi: (chainByDate[date] ?? [])[0].call_oi,
            }
          : null,
    );

    expect(result.trade).not.toBeNull();
    expect(result.trade!.exitType).toBe('PROFIT_TARGET');
    expect(result.trade!.contracts).toBe(1);
    expect(result.trade!.dailyDiagnostics?.length).toBeGreaterThan(0);
  });

  it('forces a time stop when the position reaches the DTE floor', () => {
    const candles = [
      candle('2023-12-20', 99),
      candle('2023-12-21', 99),
      candle('2023-12-22', 99),
      candle('2023-12-26', 99),
      candle('2023-12-27', 99),
      candle('2023-12-28', 99),
      candle('2023-12-29', 99),
      candle('2024-01-02', 100),
      candle('2024-01-03', 100),
      candle('2024-01-04', 100),
    ];
    const chainByDate: Record<string, ChainRow[]> = {
      '2024-01-02': [makeRow('2024-01-02', 40, 100, 8, 0.74)],
      '2024-01-03': [makeRow('2024-01-03', 14, 100, 7.8, 0.72)],
      '2024-01-04': [makeRow('2024-01-04', 13, 100, 7.6, 0.70)],
    };

    const result = simulateSwingLongOption(
      signal,
      baseConfig({
        swingLongDTERange: [35, 50],
        swingLongProfitTargetPct: 0.5,
        swingLongMaxHoldDays: 20,
        swingLongMinExitDTE: 14,
      }),
      ['2024-01-02', '2024-01-03', '2024-01-04'],
      '2024-01-04',
      (_ticker, date) => chainByDate[date] ?? [],
      buildHistories(candles),
      100_000,
      (_ticker, date, strike, expiry, type) =>
        (chainByDate[date] ?? []).find(row =>
          row.expir_date === expiry &&
          Math.abs(row.strike - strike) < 0.01 &&
          type === 'Call'
        )
          ? {
              row: (chainByDate[date] ?? []).find(row =>
                row.expir_date === expiry && Math.abs(row.strike - strike) < 0.01,
              )!,
              type,
              bid: (chainByDate[date] ?? [])[0].call_bid,
              ask: (chainByDate[date] ?? [])[0].call_ask,
              mid: (chainByDate[date] ?? [])[0].call_mid,
              iv: (chainByDate[date] ?? [])[0].call_iv,
              delta: (chainByDate[date] ?? [])[0].delta,
              volume: (chainByDate[date] ?? [])[0].call_volume,
              oi: (chainByDate[date] ?? [])[0].call_oi,
            }
          : null,
    );

    expect(result.trade).not.toBeNull();
    expect(result.trade!.exitType).toBe('TIME_STOP');
    expect(result.trade!.exitDTE).toBe(14);
  });

  it('builds a matched shadow-underlying trade from an accepted option trade', () => {
    const candles = [
      candle('2023-12-20', 95),
      candle('2023-12-21', 95.5),
      candle('2023-12-22', 96),
      candle('2023-12-26', 96.5),
      candle('2023-12-27', 97),
      candle('2023-12-28', 97.5),
      candle('2023-12-29', 98),
      candle('2024-01-02', 100),
      candle('2024-01-03', 103),
      candle('2024-01-04', 104),
    ];
    const chainByDate: Record<string, ChainRow[]> = {
      '2024-01-02': [makeRow('2024-01-02', 45, 100, 8, 0.75)],
      '2024-01-03': [makeRow('2024-01-03', 44, 103, 10.5, 0.82)],
      '2024-01-04': [makeRow('2024-01-04', 43, 104, 11, 0.84)],
    };

    const evaluation = simulateSwingLongOption(
      signal,
      baseConfig({ swingLongProfitTargetPct: 0.25 }),
      ['2024-01-02', '2024-01-03', '2024-01-04'],
      '2024-01-04',
      (_ticker, date) => chainByDate[date] ?? [],
      buildHistories(candles),
      100_000,
      (_ticker, date, strike, expiry, type) =>
        (chainByDate[date] ?? []).find(row =>
          row.expir_date === expiry &&
          Math.abs(row.strike - strike) < 0.01 &&
          type === 'Call'
        )
          ? {
              row: (chainByDate[date] ?? []).find(row =>
                row.expir_date === expiry && Math.abs(row.strike - strike) < 0.01,
              )!,
              type,
              bid: (chainByDate[date] ?? [])[0].call_bid,
              ask: (chainByDate[date] ?? [])[0].call_ask,
              mid: (chainByDate[date] ?? [])[0].call_mid,
              iv: (chainByDate[date] ?? [])[0].call_iv,
              delta: (chainByDate[date] ?? [])[0].delta,
              volume: (chainByDate[date] ?? [])[0].call_volume,
              oi: (chainByDate[date] ?? [])[0].call_oi,
            }
          : null,
    );

    const shadow = buildShadowUnderlyingTrade(evaluation.trade!);

    expect(shadow.shares).toBeCloseTo(75, 5);
    expect(shadow.pnl).toBeGreaterThan(0);
    expect(shadow.dailyMtM.length).toBeGreaterThan(0);
  });
});
