import { describe, expect, it } from 'vitest';
import {
  computeOptionAnalytics,
  projectTradesToGrossPnlView,
  type OptionTrade,
} from '../src/lib/backtest/option-sim';

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

  it('falls back to legacy trade metrics when observed MtM dates are sparse', () => {
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
        exitDate: '2024-01-12',
        exitPrice: 0.3,
        exitDTE: 20,
        exitStockPrice: 482,
        exitType: 'PROFIT_TARGET',
        pnl: 70,
        pnlPct: 0.175,
        holdDays: 8,
        dailyMtM: [
          { date: '2024-01-05', spreadMid: 0.9, unrealizedPnl: 10 },
          { date: '2024-01-10', spreadMid: 0.5, unrealizedPnl: 50 },
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
        exitDate: '2024-01-15',
        exitPrice: 1.8,
        exitDTE: 15,
        exitStockPrice: 398,
        exitType: 'STOP_LOSS',
        pnl: -80,
        pnlPct: -0.2,
        holdDays: 8,
        dailyMtM: [
          { date: '2024-01-08', spreadMid: 1.1, unrealizedPnl: -10 },
          { date: '2024-01-12', spreadMid: 1.5, unrealizedPnl: -50 },
        ],
      },
    ];

    const analytics = computeOptionAnalytics(trades);

    expect(analytics.metricBasis).toBe('trade_hold_legacy');
    expect(analytics.sharpe).toBe(analytics.tradeSharpeLegacy);
    expect(analytics.dailyPortfolioSharpe).toBeUndefined();
    expect(analytics.dailyMtMDrawdownPct).toBeUndefined();
  });

  it('projects trades back to gross pnl for reporting without mutating max-loss basis', () => {
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
        entryPrice: 0.9,
        entryDelta: -0.3,
        entryIV: 0.2,
        entryStockPrice: 480,
        requestedSpreadWidth: 5,
        spreadWidth: 5,
        maxProfit: 0.9,
        maxLoss: 4.1,
        exitDate: '2024-01-05',
        exitPrice: 0.4,
        exitDTE: 27,
        exitStockPrice: 482,
        exitType: 'PROFIT_TARGET',
        pnl: 38.7,
        grossPnl: 60,
        pnlPct: 38.7 / 410,
        holdDays: 3,
        entrySlippage: 0.1,
        entryCommission: 1.3,
        exitCommission: 1.3,
        dailyMtM: [
          { date: '2024-01-03', spreadMid: 0.8, unrealizedPnl: 10 },
          { date: '2024-01-04', spreadMid: 0.6, unrealizedPnl: 30 },
        ],
      },
    ];

    const projected = projectTradesToGrossPnlView(trades);

    expect(projected[0].pnl).toBe(60);
    expect(projected[0].pnlPct).toBeCloseTo(60 / 400, 8);
    expect(projected[0].dailyMtM?.[0].unrealizedPnl).toBe(20);
    expect(projected[0].dailyMtM?.[1].unrealizedPnl).toBe(40);
    expect(trades[0].pnl).toBe(38.7);
    expect(trades[0].dailyMtM?.[0].unrealizedPnl).toBe(10);
  });
});
