import { describe, expect, it } from 'vitest';

import { buildIndexedUnderlyingHistory, simulateUnderlyingTrade } from '../src/lib/backtest/underlying-sim';
import type { EntrySignal } from '../src/lib/backtest/option-sim';
import type { BacktestCandle } from '../src/lib/backtest/types';

function makeCandles(closes: number[]): BacktestCandle[] {
  return closes.map((close, index) => ({
    date: `2024-01-${String(index + 1).padStart(2, '0')}`,
    timestamp: Date.UTC(2024, 0, index + 1),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000_000,
  }));
}

describe('simulateUnderlyingTrade', () => {
  it('exits long trades on underlying trend failure', () => {
    const candles = makeCandles([100, 101, 102, 104, 103, 97, 94, 92]);
    const history = buildIndexedUnderlyingHistory(candles, [3]);
    const signal: EntrySignal = {
      ticker: 'SPY',
      date: '2024-01-04',
      direction: 'CALL',
      score: 82,
    };

    const trade = simulateUnderlyingTrade(signal, candles, history, {
      signalWeightPreset: 'pb',
      underlyingExitEMA: 3,
      underlyingExitConfirmDays: 2,
      underlyingExitRequireSlope: true,
      maxHoldDays: 10,
    }, '2024-01-08');

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('UNDERLYING_EXIT');
  });

  it('exits short trades on underlying trend failure', () => {
    const candles = makeCandles([110, 109, 108, 106, 107, 112, 116, 118]);
    const history = buildIndexedUnderlyingHistory(candles, [3]);
    const signal: EntrySignal = {
      ticker: 'QQQ',
      date: '2024-01-04',
      direction: 'PUT',
      score: 78,
    };

    const trade = simulateUnderlyingTrade(signal, candles, history, {
      signalWeightPreset: 'pb',
      underlyingExitEMA: 3,
      underlyingExitConfirmDays: 2,
      underlyingExitRequireSlope: true,
      maxHoldDays: 10,
    }, '2024-01-08');

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('UNDERLYING_EXIT');
  });

  it('falls back to time stop when the trend exit never triggers', () => {
    const candles = makeCandles([100, 101, 102, 103, 104, 105, 106]);
    const history = buildIndexedUnderlyingHistory(candles, [3]);
    const signal: EntrySignal = {
      ticker: 'IWM',
      date: '2024-01-02',
      direction: 'CALL',
      score: 75,
    };

    const trade = simulateUnderlyingTrade(signal, candles, history, {
      signalWeightPreset: 'pb',
      underlyingExitEMA: 3,
      underlyingExitConfirmDays: 2,
      underlyingExitRequireSlope: true,
      maxHoldDays: 2,
    }, '2024-01-07');

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('TIME_STOP');
  });

  it('closes at end of window if no exit condition fires', () => {
    const candles = makeCandles([100, 101, 102, 103, 104, 105]);
    const history = buildIndexedUnderlyingHistory(candles, [3]);
    const signal: EntrySignal = {
      ticker: 'SPY',
      date: '2024-01-02',
      direction: 'CALL',
      score: 75,
    };

    const trade = simulateUnderlyingTrade(signal, candles, history, {
      signalWeightPreset: 'pb',
      underlyingExitEMA: 3,
      underlyingExitConfirmDays: 2,
      underlyingExitRequireSlope: true,
      maxHoldDays: 10,
    }, '2024-01-04');

    expect(trade).not.toBeNull();
    expect(trade?.exitType).toBe('END_OF_WINDOW');
    expect(trade?.exitDate).toBe('2024-01-04');
  });
});
