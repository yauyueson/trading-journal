import { describe, expect, it } from 'vitest';

import {
  hasUnderlyingStop,
  indexUnderlyingHistories,
  shouldExitUnderlyingStop,
  type SerializedUnderlyingHistory,
} from '../src/lib/backtest/underlying-stop';

function history(data: SerializedUnderlyingHistory): Record<string, SerializedUnderlyingHistory> {
  return { SPY: data };
}

describe('underlying trend stop', () => {
  it('treats missing stop config as disabled', () => {
    expect(hasUnderlyingStop({})).toBe(false);
  });

  it('fires bullish breach stop after consecutive closes below EMA and below short strike', () => {
    const histories = indexUnderlyingHistories(history({
      dates: ['2024-01-02', '2024-01-03', '2024-01-04'],
      closes: [101, 99, 98],
      atr14: [1.2, 1.1, 1.0],
      emaByPeriod: {
        '34': [100.5, 100.0, 99.5],
      },
    }));

    const triggered = shouldExitUnderlyingStop(
      'SPY',
      '2024-01-04',
      'CALL',
      100,
      {
        underlyingStopEMA: 34,
        underlyingStopConfirmDays: 2,
        underlyingStopDangerMode: 'breach',
        underlyingStopRequireSlope: true,
      },
      histories,
    );

    expect(triggered).toBe(true);
  });

  it('blocks stop when adverse EMA slope confirmation is required but absent', () => {
    const histories = indexUnderlyingHistories(history({
      dates: ['2024-01-02', '2024-01-03', '2024-01-04'],
      closes: [101, 99, 98],
      atr14: [1.2, 1.1, 1.0],
      emaByPeriod: {
        '34': [97.0, 97.5, 98.2],
      },
    }));

    const triggered = shouldExitUnderlyingStop(
      'SPY',
      '2024-01-04',
      'CALL',
      100,
      {
        underlyingStopEMA: 34,
        underlyingStopConfirmDays: 2,
        underlyingStopDangerMode: 'breach',
        underlyingStopRequireSlope: true,
      },
      histories,
    );

    expect(triggered).toBe(false);
  });

  it('fires bearish ATR danger stop when price is above EMA and inside ATR danger zone', () => {
    const histories = indexUnderlyingHistories(history({
      dates: ['2024-01-02', '2024-01-03', '2024-01-04'],
      closes: [96, 99, 100.5],
      atr14: [2.0, 2.0, 2.0],
      emaByPeriod: {
        '21': [94.0, 95.0, 96.0],
      },
    }));

    const triggered = shouldExitUnderlyingStop(
      'SPY',
      '2024-01-04',
      'PUT',
      100,
      {
        underlyingStopEMA: 21,
        underlyingStopConfirmDays: 2,
        underlyingStopDangerMode: 'atr',
        underlyingStopRequireSlope: true,
        underlyingStopAtrMultiple: 1,
      },
      histories,
    );

    expect(triggered).toBe(true);
  });
});
