import { describe, it, expect } from 'vitest';
import { computeAnalytics } from '../src/lib/backtest/analytics';
import type { BacktestTrade, BacktestConfig } from '../src/lib/backtest/types';

// Minimal config for analytics
const minConfig: BacktestConfig = {
  timeframe: '1D',
  minScore: 60,
  tpMultiplier: 1.5,
  slMultiplier: 1.0,
  maxHoldBars: 20,
  thetaDecayRate: 0.01,
  mfeWindows: [5, 10],
  signalPreset: 'ema',
  qualityGates: { minADX: 15, minRVOL: 0.5, useCoherence: true, useSqueeze: true },
};

function makeTrade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    entryDate: '2024-01-01',
    entryPrice: 100,
    entryBar: 0,
    direction: 'CALL',
    setup: 'test',
    score: 80,
    confidence: 0.8,
    tier: 'A',
    entryQuality: 'LIMIT',
    atrAtEntry: 2,
    tpPrice: 103,
    slPrice: 98,
    exitDate: '2024-01-15',
    exitPrice: 103,
    exitType: 'TP',
    holdDays: 14,
    rawReturn: 0.03,
    thetaAdjReturn: 0.028,
    mfe: { 5: 0.02, 10: 0.03 },
    mae: { 5: -0.005, 10: -0.008 },
    ...overrides,
  };
}

describe('computeAnalytics edge cases', () => {
  it('handles zero trades without NaN', () => {
    const result = computeAnalytics([], minConfig, 0);
    expect(result.sharpe).toBe(0);
    expect(result.sortino).toBe(0);
    expect(result.calmar).toBe(0);
    expect(result.profitFactor).toBe(0);
    expect(result.expectancy).toBe(0);
    expect(Number.isFinite(result.sharpe)).toBe(true);
  });

  it('handles single trade without NaN', () => {
    const result = computeAnalytics([makeTrade()], minConfig, 1);
    expect(Number.isFinite(result.sharpe)).toBe(true);
    expect(Number.isFinite(result.sortino)).toBe(true);
    expect(Number.isFinite(result.calmar)).toBe(true);
  });

  it('handles zero-variance returns (all identical) without NaN', () => {
    const trades = Array.from({ length: 10 }, () =>
      makeTrade({ rawReturn: 0.05, thetaAdjReturn: 0.05 })
    );
    const result = computeAnalytics(trades, minConfig, 10);
    // std(rawReturns) === 0, so Sharpe should be 0 (not NaN)
    expect(result.sharpe).toBe(0);
    expect(Number.isFinite(result.sharpe)).toBe(true);
    // Sortino: all positive returns, downsideDev === 0
    expect(Number.isFinite(result.sortino)).toBe(true);
  });

  it('handles same-day closes (holdDays=0) without Infinity', () => {
    const trades = Array.from({ length: 5 }, (_, i) =>
      makeTrade({
        holdDays: 0,
        rawReturn: i % 2 === 0 ? 0.02 : -0.01,
        thetaAdjReturn: i % 2 === 0 ? 0.02 : -0.01,
      })
    );
    const result = computeAnalytics(trades, minConfig, 5);
    // avgHoldDaysVal clamped to 1, so no Infinity from Math.sqrt(252/0)
    expect(Number.isFinite(result.sharpe)).toBe(true);
    expect(Number.isFinite(result.sortino)).toBe(true);
  });

  it('caps profitFactor at 999 when no losses exist', () => {
    const trades = Array.from({ length: 5 }, () =>
      makeTrade({ rawReturn: 0.05, thetaAdjReturn: 0.05 })
    );
    const result = computeAnalytics(trades, minConfig, 5);
    expect(result.profitFactor).toBe(999);
    expect(Number.isFinite(result.profitFactor)).toBe(true);
  });

  it('handles all-loss scenario correctly', () => {
    const trades = Array.from({ length: 5 }, () =>
      makeTrade({
        rawReturn: -0.05,
        thetaAdjReturn: -0.04,
        exitType: 'SL',
        exitPrice: 95,
      })
    );
    const result = computeAnalytics(trades, minConfig, 5);
    expect(result.winRate).toBe(0);
    expect(result.profitFactor).toBe(0);
    expect(Number.isFinite(result.sharpe)).toBe(true);
    expect(Number.isFinite(result.maxDrawdown)).toBe(true);
    expect(result.maxDrawdown).toBeGreaterThan(0);
  });

  it('option profitFactor caps at 999 when no option losses', () => {
    const trades = Array.from({ length: 5 }, () =>
      makeTrade({ optionReturn: 0.30 })
    );
    const result = computeAnalytics(trades, minConfig, 5);
    expect(result.optionProfitFactor).toBe(999);
    expect(Number.isFinite(result.optionProfitFactor!)).toBe(true);
  });

  it('monteCarlo returns valid result for exactly 5 trades', () => {
    const trades = Array.from({ length: 5 }, (_, i) =>
      makeTrade({ rawReturn: i % 2 === 0 ? 0.03 : -0.02 })
    );
    const result = computeAnalytics(trades, minConfig, 5);
    // 5 trades is below the 10-trade threshold for monteCarlo
    expect(result.monteCarlo).toBeUndefined();
  });

  it('monteCarlo works for 10+ trades', () => {
    const trades = Array.from({ length: 15 }, (_, i) =>
      makeTrade({
        rawReturn: i % 3 === 0 ? -0.02 : 0.03,
        entryDate: `2024-01-${String(i + 1).padStart(2, '0')}`,
        exitDate: `2024-01-${String(i + 15).padStart(2, '0')}`,
      })
    );
    const result = computeAnalytics(trades, minConfig, 15);
    expect(result.monteCarlo).toBeDefined();
    expect(Number.isFinite(result.monteCarlo!.sharpe.p50)).toBe(true);
    expect(Number.isFinite(result.monteCarlo!.maxDrawdown.p50)).toBe(true);
  });
});
