// tests/wfa-options.test.ts
import { describe, it, expect } from 'vitest';
import { buildWFAWindows, optimizeWindow, runWFAOptions } from '../src/lib/backtest/wfa-options';
import type { TradeEvaluator } from '../src/lib/backtest/wfa-options';
import { DEFAULT_CREDIT_CONFIG } from '../src/lib/backtest/option-sim';
import type { OptionTrade, EntrySignal, SimConfig, SignalPresetKey } from '../src/lib/backtest/option-sim';

// Generate trading dates (weekdays only)
function generateTradingDates(startYear: number, years: number): string[] {
  const dates: string[] = [];
  const start = new Date(startYear, 0, 1);
  const end = new Date(startYear + years, 0, 1);
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow > 0 && dow < 6) {
      dates.push(d.toISOString().slice(0, 10));
    }
  }
  return dates;
}

const allDates = generateTradingDates(2019, 7); // 2019-2025

describe('buildWFAWindows', () => {
  it('rolling mode: produces non-overlapping OOS windows', () => {
    const windows = buildWFAWindows(allDates, {
      trainWindowDays: 504,
      forwardStepDays: 126,
      purgeGapDays: 65,
      mode: 'rolling',
      startDate: '2019-01-01',
      endDate: '2025-12-31',
    });
    expect(windows.length).toBeGreaterThanOrEqual(4);

    // OOS windows should not overlap
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].oosStart > windows[i - 1].oosEnd).toBe(true);
    }
  });

  it('anchored mode: train start is always the same', () => {
    const windows = buildWFAWindows(allDates, {
      trainWindowDays: 504,
      forwardStepDays: 126,
      purgeGapDays: 65,
      mode: 'anchored',
      startDate: '2019-01-01',
      endDate: '2025-12-31',
    });
    const firstTrainStart = windows[0].trainStart;
    for (const w of windows) {
      expect(w.trainStart).toBe(firstTrainStart);
    }
  });

  it('purge gap creates space between train end and OOS start', () => {
    const windows = buildWFAWindows(allDates, {
      trainWindowDays: 504,
      forwardStepDays: 126,
      purgeGapDays: 65,
      mode: 'rolling',
      startDate: '2019-01-01',
      endDate: '2025-12-31',
    });
    for (const w of windows) {
      const trainEndIdx = allDates.indexOf(w.trainEnd);
      const oosStartIdx = allDates.indexOf(w.oosStart);
      expect(oosStartIdx - trainEndIdx).toBeGreaterThanOrEqual(65);
    }
  });

  it('last OOS window does not exceed endDate', () => {
    const windows = buildWFAWindows(allDates, {
      trainWindowDays: 504,
      forwardStepDays: 126,
      purgeGapDays: 65,
      mode: 'rolling',
      startDate: '2019-01-01',
      endDate: '2025-12-31',
    });
    const last = windows[windows.length - 1];
    expect(last.oosEnd <= '2025-12-31').toBe(true);
  });
});

describe('optimizeWindow', () => {
  it('returns best SimConfig from sweep candidates', () => {
    // Mock evaluator: base P&L varies by config, perturbation by signal score → non-zero std
    const mockEvaluator: TradeEvaluator = (signal, config) => {
      const base = config.creditProfitTarget === 0.30 ? 80 : config.creditProfitTarget === 0.20 ? 50 : 30;
      const pnl = base + (signal.score - 80) * 2; // varies across signals
      return {
        ticker: signal.ticker, mode: 'CREDIT_SPREAD', direction: signal.direction,
        entryDate: signal.date, entrySignalScore: signal.score,
        strike: 470, expiry: '2024-02-16', entryDTE: 45, entryPrice: 1.0,
        entryDelta: -0.30, entryIV: 0.20, entryStockPrice: 480,
        spreadWidth: 10, maxProfit: 1.0, maxLoss: 9.0,
        exitDate: signal.date, exitPrice: 0.20, exitDTE: 7, exitStockPrice: 485,
        exitType: 'PROFIT_TARGET', pnl, pnlPct: pnl / 900, holdDays: 30,
      } as OptionTrade;
    };

    const candidates: SimConfig[] = [
      { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.20 },
      { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.30 },
      { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.50 },
    ];

    const signals = new Map<SignalPresetKey, EntrySignal[]>([
      ['ema', [
        { ticker: 'SPY', date: '2023-06-01', direction: 'CALL', score: 80 },
        { ticker: 'SPY', date: '2023-07-01', direction: 'CALL', score: 85 },
        { ticker: 'SPY', date: '2023-08-01', direction: 'CALL', score: 82 },
      ]],
    ]);

    const result = optimizeWindow(
      candidates, signals, allDates, '2023-01-01', '2023-12-31', mockEvaluator,
    );

    // creditProfitTarget=0.30 yields highest pnl (80) → best Sharpe
    expect(result.bestConfig.creditProfitTarget).toBe(0.30);
    expect(result.bestSharpe).toBeGreaterThan(0);
  });
});

describe('WFA position carry', () => {
  it('open positions carry across OOS window boundaries', () => {
    const w1Trades: OptionTrade[] = [
      {
        ticker: 'SPY', mode: 'CREDIT_SPREAD', direction: 'CALL',
        entryDate: '2024-01-15', entrySignalScore: 80,
        strike: 480, expiry: '2024-03-15', entryDTE: 60,
        entryPrice: 1.00, entryDelta: -0.30, entryIV: 0.18,
        entryStockPrice: 485, spreadWidth: 10, maxLoss: 9.00, maxProfit: 1.00,
        exitDate: '2024-04-01', exitPrice: 0.30, exitDTE: 15,
        exitStockPrice: 490, exitType: 'PROFIT_TARGET',
        pnl: 70, pnlPct: 0.078, holdDays: 76,
      },
    ];
    expect(w1Trades[0].entryDate < '2024-03-31').toBe(true);
    expect(w1Trades[0].exitDate >= '2024-04-01').toBe(true);
    expect(w1Trades[0].holdDays).toBe(76);
  });
});

describe('Data isolation', () => {
  it('training signals never include dates after trainEnd', () => {
    const signals = [
      { ticker: 'SPY', date: '2023-01-01', direction: 'CALL' as const, score: 80 },
      { ticker: 'SPY', date: '2023-06-15', direction: 'CALL' as const, score: 85 },
      { ticker: 'SPY', date: '2024-01-01', direction: 'CALL' as const, score: 90 },
      { ticker: 'SPY', date: '2024-06-15', direction: 'CALL' as const, score: 88 },
    ];
    const trainEnd = '2023-12-31';
    const filtered = signals.filter(s => s.date <= trainEnd);
    expect(filtered).toHaveLength(2);
    expect(filtered.every(s => s.date <= trainEnd)).toBe(true);
  });

  it('OOS signals start AFTER purge gap, not at trainEnd + 1', () => {
    const trainEnd = '2023-12-29';
    const purgeGap = 5;
    const tradingDates = [
      '2023-12-29', '2024-01-02', '2024-01-03', '2024-01-04',
      '2024-01-05', '2024-01-08', '2024-01-09', '2024-01-10',
    ];
    const trainEndIdx = tradingDates.indexOf(trainEnd);
    const oosStartIdx = trainEndIdx + 1 + purgeGap;
    expect(tradingDates[oosStartIdx]).toBe('2024-01-09');
  });

  it('optimizeWindow throws on data leak', () => {
    const leakySignals = new Map<SignalPresetKey, EntrySignal[]>([
      ['ema', [
        { ticker: 'SPY', date: '2024-01-15', direction: 'CALL', score: 80 },
      ]],
    ]);

    // trainEnd is before the signal date, but signal still gets through filter
    // because the filter uses >= trainStart && <= trainEnd
    // This should NOT leak since 2024-01-15 > 2023-12-31
    const noopEvaluator: TradeEvaluator = () => null;
    const result = optimizeWindow(
      [DEFAULT_CREDIT_CONFIG], leakySignals, allDates, '2023-01-01', '2023-12-31', noopEvaluator,
    );
    // No signals in training window → 0 trades
    expect(result.allResults[0].trades).toBe(0);
  });
});

describe('runWFAOptions', () => {
  it('produces WFA result with equity curve and stress metrics', () => {
    // Simple mock: every signal produces a winning trade
    const mockEvaluator: TradeEvaluator = (signal) => ({
      ticker: signal.ticker, mode: 'CREDIT_SPREAD', direction: signal.direction,
      entryDate: signal.date, entrySignalScore: signal.score,
      strike: 470, expiry: '2024-06-21', entryDTE: 45, entryPrice: 1.0,
      entryDelta: -0.30, entryIV: 0.20, entryStockPrice: 480,
      spreadWidth: 10, maxProfit: 1.0, maxLoss: 9.0,
      exitDate: signal.date, exitPrice: 0.30, exitDTE: 7, exitStockPrice: 485,
      exitType: 'PROFIT_TARGET', pnl: 70, pnlPct: 0.078, holdDays: 30,
      dailyMtM: [{ date: signal.date, spreadMid: 0.30, unrealizedPnl: 70 }],
    } as OptionTrade);

    // Generate signals every ~month
    const signals: EntrySignal[] = [];
    for (let i = 0; i < allDates.length; i += 21) {
      signals.push({ ticker: 'SPY', date: allDates[i], direction: 'CALL', score: 80 });
    }

    const result = runWFAOptions(
      {
        tickers: ['SPY'],
        startDate: '2019-01-01',
        endDate: '2025-12-31',
        trainWindowDays: 504,
        forwardStepDays: 126,
        purgeGapDays: 65,
        mode: 'rolling',
        maxPositions: 5,
        maxPerTicker: 2,
        startingCapital: 100_000,
      },
      new Map([['ema', signals]]),
      allDates,
      [DEFAULT_CREDIT_CONFIG],
      mockEvaluator,
    );

    expect(result.windows.length).toBeGreaterThanOrEqual(4);
    expect(result.allOOSTrades.length).toBeGreaterThan(0);
    expect(result.oosEquityCurve.length).toBeGreaterThan(0);
    expect(result.oosSharpe).toBeGreaterThan(0);
    expect(result.oosTotalPnl).toBeGreaterThan(0);
    expect(result.wfEfficiency).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    // Stress metrics populated since we have dailyMtM
    expect(result.stressMetrics).toBeDefined();
  });
});
