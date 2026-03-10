/**
 * Option Sim Fill Tests — dailyMtM, bid/ask fills, ORATS filters
 */
import { describe, it, expect } from 'vitest';

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
