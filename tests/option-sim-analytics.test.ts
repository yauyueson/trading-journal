import { describe, expect, it } from 'vitest';
import { computeOptionAnalytics, type OptionTrade } from '../src/lib/backtest/option-sim';

describe('computeOptionAnalytics metric surfaces', () => {
  it('preserves legacy trade sharpe and emits daily portfolio metrics when dailyMtM exists', () => {
    const trades: OptionTrade[] = [
      {
        ticker: 'SPY',
        mode: 'CREDIT_SPREAD',
        direction: 'CALL',
        entryDate: '2024-01-02',
        entrySignalScore: 80,
        strike: 470,
        expiry: '2024-02-16',
        entryDTE: 30,
        entryPrice: 1.0,
        entryDelta: -0.3,
        entryIV: 0.2,
        entryStockPrice: 480,
        requestedSpreadWidth: 5,
        spreadWidth: 5,
        maxProfit: 1,
        maxLoss: 4,
        exitDate: '2024-01-05',
        exitPrice: 0.3,
        exitDTE: 27,
        exitStockPrice: 482,
        exitType: 'PROFIT_TARGET',
        pnl: 70,
        pnlPct: 0.175,
        holdDays: 3,
        dailyMtM: [
          { date: '2024-01-03', spreadMid: 0.9, unrealizedPnl: 10 },
          { date: '2024-01-04', spreadMid: 0.5, unrealizedPnl: 50 },
        ],
      },
      {
        ticker: 'QQQ',
        mode: 'CREDIT_SPREAD',
        direction: 'CALL',
        entryDate: '2024-01-03',
        entrySignalScore: 78,
        strike: 400,
        expiry: '2024-02-16',
        entryDTE: 25,
        entryPrice: 1.0,
        entryDelta: -0.28,
        entryIV: 0.22,
        entryStockPrice: 410,
        requestedSpreadWidth: 5,
        spreadWidth: 5,
        maxProfit: 1,
        maxLoss: 4,
        exitDate: '2024-01-08',
        exitPrice: 1.8,
        exitDTE: 20,
        exitStockPrice: 398,
        exitType: 'STOP_LOSS',
        pnl: -80,
        pnlPct: -0.2,
        holdDays: 5,
        dailyMtM: [
          { date: '2024-01-04', spreadMid: 1.1, unrealizedPnl: -10 },
          { date: '2024-01-05', spreadMid: 1.5, unrealizedPnl: -50 },
        ],
      },
    ];

    const analytics = computeOptionAnalytics(trades);

    // sharpe now prefers dailyPortfolioSharpe when dailyMtM is available
    expect(analytics.sharpe).toBe(analytics.dailyPortfolioSharpe);
    expect(analytics.metricBasis).toBe('daily_portfolio');
    expect(analytics.dailyPortfolioSharpe).toBeTypeOf('number');
    expect(analytics.dailyMtMDrawdownPct).toBeTypeOf('number');
    expect(analytics.realizedExitDrawdownPct).toBe(analytics.maxDrawdown);
  });
});
