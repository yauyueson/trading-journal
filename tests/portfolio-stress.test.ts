// tests/portfolio-stress.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildDailyPnLMatrix,
  computeCorrelationStress,
} from '../src/lib/backtest/portfolio-stress';
import type { OptionTrade } from '../src/lib/backtest/option-sim';

/**
 * Helper: build a trade with dailyMtM populated.
 * Each day from entry to exit gets an unrealized P&L entry (linear interp).
 */
function makeTrade(
  ticker: string, entryDate: string, exitDate: string, pnl: number,
  holdDays: number, maxLoss: number = 900,
): OptionTrade {
  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
  const start = new Date(entryDate);
  const end = new Date(exitDate);
  let dayCount = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    dayCount++;
    const progress = holdDays > 0 ? dayCount / holdDays : 1;
    dailyMtM.push({
      date: d.toISOString().slice(0, 10),
      spreadMid: 1.00 - (pnl / 100) * progress,
      unrealizedPnl: pnl * progress,
    });
  }

  return {
    ticker, mode: 'CREDIT_SPREAD', direction: 'CALL',
    entryDate, entrySignalScore: 80,
    strike: 100, expiry: '2024-06-21', entryDTE: 45,
    entryPrice: 1.00, entryDelta: -0.30, entryIV: 0.20,
    entryStockPrice: 105, spreadWidth: 10, maxLoss, maxProfit: 100,
    exitDate, exitPrice: pnl > 0 ? 0.30 : 5.00,
    exitDTE: 7, exitStockPrice: pnl > 0 ? 108 : 95,
    exitType: pnl > 0 ? 'PROFIT_TARGET' : 'STOP_LOSS',
    pnl, pnlPct: pnl / (maxLoss * 100), holdDays,
    dailyMtM,
  } as OptionTrade;
}

describe('buildDailyPnLMatrix', () => {
  it('uses dailyMtM for unrealized P&L, not just exit-day realized', () => {
    const trades = [
      makeTrade('SPY', '2024-01-02', '2024-01-10', -500, 6),
    ];
    const matrix = buildDailyPnLMatrix(trades, '2024-01-02', '2024-01-15');
    const midIdx = matrix.dates.indexOf('2024-01-05');
    if (midIdx >= 0) {
      expect(matrix.byTicker['SPY'][midIdx]).not.toBe(0);
    }
  });

  it('returns daily P&L per ticker', () => {
    const trades = [
      makeTrade('SPY', '2024-01-02', '2024-01-10', 70, 8),
      makeTrade('QQQ', '2024-01-03', '2024-01-12', -400, 9),
    ];
    const matrix = buildDailyPnLMatrix(trades, '2024-01-02', '2024-01-15');
    expect(Object.keys(matrix.byTicker)).toContain('SPY');
    expect(Object.keys(matrix.byTicker)).toContain('QQQ');
    expect(matrix.dates.length).toBeGreaterThan(0);
  });

  it('multiple open trades on same day sum their unrealized changes', () => {
    const trades = [
      makeTrade('SPY', '2024-01-02', '2024-01-10', -500, 6),
      makeTrade('SPY', '2024-01-02', '2024-01-10', -300, 6),
    ];
    const matrix = buildDailyPnLMatrix(trades, '2024-01-02', '2024-01-15');
    const midIdx = matrix.dates.indexOf('2024-01-05');
    if (midIdx >= 0) {
      expect(matrix.byTicker['SPY'][midIdx]).toBeLessThan(0);
    }
  });
});

describe('computeCorrelationStress', () => {
  it('detects correlated drawdown across tickers using daily MTM', () => {
    const trades = [
      makeTrade('SPY', '2024-01-02', '2024-01-10', -500, 6),
      makeTrade('QQQ', '2024-01-02', '2024-01-10', -600, 6),
      makeTrade('AAPL', '2024-01-02', '2024-01-10', -400, 6),
    ];
    const stress = computeCorrelationStress(trades, '2024-01-02', '2024-01-15', 100_000);
    expect(stress.peakCorrelatedDD).toBeGreaterThan(0);
    expect(stress.tickersInDDOnWorstDay).toBe(3);
    expect(stress.worstDayLoss).toBeLessThan(0);
  });

  it('uncorrelated losses have lower peak drawdown than correlated', () => {
    const uncorrelated = [
      makeTrade('SPY', '2024-01-02', '2024-01-05', -500, 3),
      makeTrade('QQQ', '2024-01-08', '2024-01-12', -500, 4),
      makeTrade('AAPL', '2024-01-15', '2024-01-19', -500, 4),
    ];
    const correlated = [
      makeTrade('SPY', '2024-01-02', '2024-01-05', -500, 3),
      makeTrade('QQQ', '2024-01-02', '2024-01-05', -500, 3),
      makeTrade('AAPL', '2024-01-02', '2024-01-05', -500, 3),
    ];
    const stressUncorr = computeCorrelationStress(uncorrelated, '2024-01-02', '2024-01-31', 100_000);
    const stressCorr = computeCorrelationStress(correlated, '2024-01-02', '2024-01-31', 100_000);

    expect(stressCorr.peakCorrelatedDD).toBeGreaterThan(stressUncorr.peakCorrelatedDD);
  });

  it('penalizes no-SL configs more during systemic shocks', () => {
    const noSL = [
      makeTrade('SPY', '2024-01-02', '2024-01-10', -900, 6, 900),
      makeTrade('QQQ', '2024-01-02', '2024-01-10', -900, 6, 900),
      makeTrade('AAPL', '2024-01-02', '2024-01-10', -900, 6, 900),
    ];
    const withSL = [
      makeTrade('SPY', '2024-01-02', '2024-01-05', -200, 3, 200),
      makeTrade('QQQ', '2024-01-02', '2024-01-05', -200, 3, 200),
      makeTrade('AAPL', '2024-01-02', '2024-01-05', -200, 3, 200),
    ];
    const stressNoSL = computeCorrelationStress(noSL, '2024-01-02', '2024-01-15', 100_000);
    const stressSL = computeCorrelationStress(withSL, '2024-01-02', '2024-01-15', 100_000);
    expect(Math.abs(stressNoSL.worstDayLoss)).toBeGreaterThan(Math.abs(stressSL.worstDayLoss));
  });
});
