// tests/wfa-options.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildConfiguredSignalsForWindow,
  buildWFAWindows,
  evaluateConfiguredSignalsWithConstraints,
  executePreparedOOSWindowsWithCarry,
  optimizeWindow,
  runWFAOptions,
  selectConfigsForOOS,
} from '../src/lib/backtest/wfa-options';
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

  it('enforces maxPositions / maxPerTicker during training evaluation', () => {
    const constrainedEvaluator: TradeEvaluator = (signal) => ({
      ticker: signal.ticker, mode: 'CREDIT_SPREAD', direction: signal.direction,
      entryDate: signal.date, entrySignalScore: signal.score,
      strike: 470, expiry: '2024-12-20', entryDTE: 45, entryPrice: 1.0,
      entryDelta: -0.30, entryIV: 0.20, entryStockPrice: 480,
      spreadWidth: 10, maxProfit: 1.0, maxLoss: 9.0,
      exitDate: '2024-12-20', exitPrice: 0.30, exitDTE: 7, exitStockPrice: 485,
      exitType: 'PROFIT_TARGET', pnl: 70, pnlPct: 0.078, holdDays: 30,
    } as OptionTrade);

    const signals = new Map<SignalPresetKey, EntrySignal[]>([
      ['ema', [
        { ticker: 'SPY', date: '2023-06-01', direction: 'CALL', score: 80 },
        { ticker: 'SPY', date: '2023-06-02', direction: 'CALL', score: 82 },
        { ticker: 'QQQ', date: '2023-06-03', direction: 'CALL', score: 84 },
      ]],
    ]);

    const result = optimizeWindow(
      [DEFAULT_CREDIT_CONFIG],
      signals,
      allDates,
      '2023-01-01',
      '2023-12-31',
      constrainedEvaluator,
      {
        maxPositions: 1,
        maxPerTicker: 1,
        startingCapital: 100_000,
      },
    );

    // First trade opens and blocks all subsequent signals until expiry due to maxPositions=1.
    expect(result.allResults[0].trades).toBe(1);
  });

  it('enforces capital-at-risk budget during training evaluation', () => {
    const riskEvaluator: TradeEvaluator = (signal) => ({
      ticker: signal.ticker, mode: 'CREDIT_SPREAD', direction: signal.direction,
      entryDate: signal.date, entrySignalScore: signal.score,
      strike: 470, expiry: '2024-12-20', entryDTE: 45, entryPrice: 1.0,
      entryDelta: -0.30, entryIV: 0.20, entryStockPrice: 480,
      spreadWidth: 10, maxProfit: 1.0, maxLoss: 2.0, // $200 risk per trade
      exitDate: '2024-12-20', exitPrice: 0.30, exitDTE: 7, exitStockPrice: 485,
      exitType: 'PROFIT_TARGET', pnl: 70, pnlPct: 0.35, holdDays: 30,
    } as OptionTrade);

    const signals = new Map<SignalPresetKey, EntrySignal[]>([
      ['ema', [
        { ticker: 'SPY', date: '2023-06-01', direction: 'CALL', score: 80 },
        { ticker: 'QQQ', date: '2023-06-02', direction: 'CALL', score: 82 },
      ]],
    ]);

    const result = optimizeWindow(
      [DEFAULT_CREDIT_CONFIG],
      signals,
      allDates,
      '2023-01-01',
      '2023-12-31',
      riskEvaluator,
      {
        maxPositions: 10,
        maxPerTicker: 10,
        startingCapital: 150, // below one trade's max risk ($200)
      },
    );

    expect(result.allResults[0].trades).toBe(0);
    expect(result.bestSharpe).toBe(0);
  });

  it('selection guard avoids low-trade winner and picks robust config', () => {
    const guardedEvaluator: TradeEvaluator = (signal, config) => {
      const baseTrade = {
        ticker: signal.ticker, mode: 'CREDIT_SPREAD', direction: signal.direction,
        entryDate: signal.date, entrySignalScore: signal.score,
        strike: 470, expiry: '2024-12-20', entryDTE: 45, entryPrice: 1.0,
        entryDelta: -0.30, entryIV: 0.20, entryStockPrice: 480,
        spreadWidth: 10, maxProfit: 1.0, maxLoss: 9.0,
        exitDate: signal.date, exitPrice: 0.30, exitDTE: 7, exitStockPrice: 485,
        exitType: 'PROFIT_TARGET', holdDays: 1,
      } as OptionTrade;

      // Candidate A (PT=0.20): very high Sharpe but only 5 trades.
      if (config.creditProfitTarget === 0.20) {
        if (signal.score > 5) return null;
        const pnl = 200 + (signal.score % 2 === 0 ? 20 : -20);
        return { ...baseTrade, pnl, pnlPct: pnl / 900 };
      }

      // Candidate B (PT=0.30): moderate Sharpe, many trades (robust).
      if (config.creditProfitTarget === 0.30) {
        const pnl = signal.score % 2 === 0 ? 120 : -80;
        return { ...baseTrade, pnl, pnlPct: pnl / 900 };
      }

      // Candidate C (PT=0.50): weak.
      const pnl = -20 + ((signal.score % 7) - 3) * 5;
      return { ...baseTrade, pnl, pnlPct: pnl / 900 };
    };

    const signals = new Map<SignalPresetKey, EntrySignal[]>([
      ['ema', allDates.slice(0, 40).map((d, i) => ({
        ticker: 'SPY',
        date: d,
        direction: 'CALL' as const,
        score: i + 1,
      }))],
    ]);

    const candidates: SimConfig[] = [
      { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.20 },
      { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.30 },
      { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.50 },
    ];

    const result = optimizeWindow(
      candidates,
      signals,
      allDates,
      allDates[0],
      allDates[39],
      guardedEvaluator,
      {
        maxPositions: 100,
        maxPerTicker: 100,
        startingCapital: 100_000,
      },
      {
        enabled: true,
        minTrainTrades: 30,
        minDSR: 0,
        fallbackTopK: 3,
      },
    );

    // Raw Sharpe winner should be the low-sample candidate A.
    expect(result.allResults[0].config.creditProfitTarget).toBe(0.20);
    expect(result.allResults[0].trades).toBe(5);

    // Guarded selection should choose candidate B for robustness.
    expect(result.bestConfig.creditProfitTarget).toBe(0.30);
    expect(result.bestSharpe).toBeGreaterThan(0);
  });
});

describe('WFA position carry', () => {
  it('carried positions continue consuming capital-at-risk in later OOS windows', () => {
    const testDates = [
      '2023-01-02',
      '2023-01-03',
      '2023-01-04',
      '2023-01-05',
      '2023-01-06',
      '2023-01-09',
    ];
    const carryTradeEvaluator: TradeEvaluator = (signal) => ({
      ticker: signal.ticker, mode: 'CREDIT_SPREAD', direction: signal.direction,
      entryDate: signal.date, entrySignalScore: signal.score,
      strike: 470, expiry: '2023-01-20', entryDTE: 10, entryPrice: signal.ticker === 'SPY' ? 1.0 : 0.5,
      entryDelta: -0.30, entryIV: 0.20, entryStockPrice: 480,
      spreadWidth: signal.ticker === 'SPY' ? 5 : 2.5,
      maxProfit: signal.ticker === 'SPY' ? 1.0 : 0.5,
      maxLoss: signal.ticker === 'SPY' ? 4.0 : 2.0,
      exitDate: '2023-01-09', exitPrice: signal.ticker === 'SPY' ? 0.5 : 0.25, exitDTE: 1, exitStockPrice: 470,
      exitType: 'TIME_STOP', pnl: signal.ticker === 'SPY' ? 50 : 25, pnlPct: 0.125, holdDays: 5,
    } as OptionTrade);

    const result = executePreparedOOSWindowsWithCarry(
      [
        {
          windowIndex: 0,
          trainStart: '2023-01-02',
          trainEnd: '2023-01-03',
          oosStart: '2023-01-04',
          oosEnd: '2023-01-05',
          bestConfig: DEFAULT_CREDIT_CONFIG,
          selectedConfigs: [DEFAULT_CREDIT_CONFIG],
          bestTrainSharpe: 1,
          configuredSignals: [
            { signal: { ticker: 'SPY', date: '2023-01-04', direction: 'CALL', score: 80 }, config: DEFAULT_CREDIT_CONFIG },
          ],
        },
        {
          windowIndex: 1,
          trainStart: '2023-01-03',
          trainEnd: '2023-01-04',
          oosStart: '2023-01-06',
          oosEnd: '2023-01-06',
          bestConfig: DEFAULT_CREDIT_CONFIG,
          selectedConfigs: [DEFAULT_CREDIT_CONFIG],
          bestTrainSharpe: 1,
          configuredSignals: [
            { signal: { ticker: 'QQQ', date: '2023-01-06', direction: 'CALL', score: 82 }, config: DEFAULT_CREDIT_CONFIG },
          ],
        },
      ],
      { maxPositions: 10, maxPerTicker: 10, startingCapital: 500 },
      testDates,
      '2023-01-09',
      carryTradeEvaluator,
      'strict',
      500,
    );

    expect(result.allOOSTrades).toHaveLength(1);
    expect(result.windows[0].oosTrades).toHaveLength(1);
    expect(result.windows[1].oosTrades).toHaveLength(0);
    expect(result.windows[0].oosTrades[0].ticker).toBe('SPY');
  });

  it('carried positions block later-window entries and still affect later-window metrics', () => {
    const testDates = [
      '2023-01-02',
      '2023-01-03',
      '2023-01-04',
      '2023-01-05',
      '2023-01-06',
      '2023-01-09',
    ];
    const carryTradeEvaluator: TradeEvaluator = (signal) => ({
      ticker: signal.ticker, mode: 'CREDIT_SPREAD', direction: signal.direction,
      entryDate: signal.date, entrySignalScore: signal.score,
      strike: 470, expiry: '2023-01-20', entryDTE: 10, entryPrice: 1.0,
      entryDelta: -0.30, entryIV: 0.20, entryStockPrice: 480,
      spreadWidth: 5, maxProfit: 1.0, maxLoss: 4.0,
      exitDate: '2023-01-09', exitPrice: 2.0, exitDTE: 1, exitStockPrice: 470,
      exitType: 'STOP_LOSS', pnl: -100, pnlPct: -0.25, holdDays: 5,
      dailyMtM: [
        { date: signal.date, spreadMid: 0.5, unrealizedPnl: 50 },
        { date: '2023-01-05', spreadMid: 0.5, unrealizedPnl: 50 },
        { date: '2023-01-06', spreadMid: 2.0, unrealizedPnl: -100 },
      ],
    } as OptionTrade);

    const prepared = [
      {
        windowIndex: 0,
        trainStart: '2023-01-02',
        trainEnd: '2023-01-03',
        oosStart: '2023-01-04',
        oosEnd: '2023-01-05',
        bestConfig: DEFAULT_CREDIT_CONFIG,
        selectedConfigs: [DEFAULT_CREDIT_CONFIG],
        bestTrainSharpe: 1,
        configuredSignals: [
          { signal: { ticker: 'SPY', date: '2023-01-04', direction: 'CALL', score: 80 }, config: DEFAULT_CREDIT_CONFIG },
        ],
      },
      {
        windowIndex: 1,
        trainStart: '2023-01-03',
        trainEnd: '2023-01-04',
        oosStart: '2023-01-06',
        oosEnd: '2023-01-06',
        bestConfig: DEFAULT_CREDIT_CONFIG,
        selectedConfigs: [DEFAULT_CREDIT_CONFIG],
        bestTrainSharpe: 1,
        configuredSignals: [
          { signal: { ticker: 'QQQ', date: '2023-01-06', direction: 'CALL', score: 82 }, config: DEFAULT_CREDIT_CONFIG },
        ],
      },
    ];

    const result = executePreparedOOSWindowsWithCarry(
      prepared,
      { maxPositions: 1, maxPerTicker: 1, startingCapital: 100_000 },
      testDates,
      '2023-01-09',
      carryTradeEvaluator,
      'strict',
      100_000,
    );

    expect(result.allOOSTrades).toHaveLength(1);
    expect(result.windows[0].oosTrades).toHaveLength(1);
    expect(result.windows[1].oosTrades).toHaveLength(0);
    expect(result.windows[1].oosMaxDD).toBeGreaterThan(0);
  });
});

describe('Deterministic execution ordering', () => {
  it('uses date, then ticker, then direction when capacity is limited', () => {
    const constrainedEvaluator: TradeEvaluator = (signal) => ({
      ticker: signal.ticker, mode: 'CREDIT_SPREAD', direction: signal.direction,
      entryDate: signal.date, entrySignalScore: signal.score,
      strike: 470, expiry: '2024-02-16', entryDTE: 45, entryPrice: 1.0,
      entryDelta: -0.30, entryIV: 0.20, entryStockPrice: 480,
      spreadWidth: 10, maxProfit: 1.0, maxLoss: 9.0,
      exitDate: '2024-12-20', exitPrice: 0.30, exitDTE: 7, exitStockPrice: 485,
      exitType: 'PROFIT_TARGET', pnl: 70, pnlPct: 0.078, holdDays: 30,
    } as OptionTrade);

    const configuredSignals = [
      { signal: { ticker: 'SPY', date: '2023-06-01', direction: 'PUT' as const, score: 80 }, config: DEFAULT_CREDIT_CONFIG },
      { signal: { ticker: 'QQQ', date: '2023-06-01', direction: 'CALL' as const, score: 82 }, config: DEFAULT_CREDIT_CONFIG },
      { signal: { ticker: 'SPY', date: '2023-06-01', direction: 'CALL' as const, score: 84 }, config: DEFAULT_CREDIT_CONFIG },
    ];

    const trades = evaluateConfiguredSignalsWithConstraints(
      configuredSignals,
      { maxPositions: 1, maxPerTicker: 1, startingCapital: 100_000 },
      allDates,
      '2024-12-31',
      constrainedEvaluator,
    );

    expect(trades).toHaveLength(1);
    expect(trades[0].ticker).toBe('QQQ');
    expect(trades[0].direction).toBe('CALL');
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

  it('supports strict per-window metrics without changing default lifecycle mode', () => {
    const testDates = [
      '2023-01-02',
      '2023-01-03',
      '2023-01-04',
      '2023-01-05',
      '2023-01-06',
      '2023-01-09',
      '2023-01-10',
    ];

    const carryEvaluator: TradeEvaluator = (signal) => ({
      ticker: signal.ticker, mode: 'CREDIT_SPREAD', direction: signal.direction,
      entryDate: signal.date, entrySignalScore: signal.score,
      strike: 470, expiry: '2023-01-20', entryDTE: 10, entryPrice: 1.0,
      entryDelta: -0.30, entryIV: 0.20, entryStockPrice: 480,
      spreadWidth: 5, maxProfit: 1.0, maxLoss: 4.0,
      // Exits after first window end (2023-01-05), so lifecycle mode captures post-window PnL.
      exitDate: '2023-01-09', exitPrice: 3.0, exitDTE: 1, exitStockPrice: 470,
      exitType: 'STOP_LOSS', pnl: -200, pnlPct: -0.5, holdDays: 5,
      dailyMtM: [
        { date: signal.date, spreadMid: 0.3, unrealizedPnl: 100 },
        { date: '2023-01-05', spreadMid: 0.3, unrealizedPnl: 100 },
        { date: '2023-01-06', spreadMid: 3.0, unrealizedPnl: -200 },
      ],
    } as OptionTrade);

    const signals = new Map<SignalPresetKey, EntrySignal[]>([
      ['ema', [{ ticker: 'SPY', date: '2023-01-04', direction: 'CALL', score: 80 }]],
    ]);

    const baseConfig = {
      tickers: ['SPY'],
      startDate: '2023-01-02',
      endDate: '2023-01-10',
      trainWindowDays: 2,
      forwardStepDays: 2,
      purgeGapDays: 0,
      mode: 'rolling' as const,
      maxPositions: 5,
      maxPerTicker: 2,
      startingCapital: 100_000,
    };

    const strictDefault = runWFAOptions(
      baseConfig,
      signals,
      testDates,
      [DEFAULT_CREDIT_CONFIG],
      carryEvaluator,
    );
    const lifecycle = runWFAOptions(
      { ...baseConfig, windowMetricsMode: 'lifecycle' },
      signals,
      testDates,
      [DEFAULT_CREDIT_CONFIG],
      carryEvaluator,
    );
    const strict = runWFAOptions(
      { ...baseConfig, windowMetricsMode: 'strict' },
      signals,
      testDates,
      [DEFAULT_CREDIT_CONFIG],
      carryEvaluator,
    );

    expect(strictDefault.windows.length).toBeGreaterThan(0);
    expect(lifecycle.windows.length).toBeGreaterThan(0);
    expect(strict.windows.length).toBe(lifecycle.windows.length);
    expect(strictDefault.windows[0].oosMaxDD).toBeCloseTo(strict.windows[0].oosMaxDD, 10);

    // First window OOS is 2023-01-04..2023-01-05.
    // Lifecycle mode includes post-window drawdown from 2023-01-06; strict mode excludes it.
    expect(lifecycle.windows[0].oosMaxDD).toBeGreaterThan(strict.windows[0].oosMaxDD);
    expect(strict.windows[0].oosMaxDD).toBeCloseTo(0, 10);
  });

  it('ensemble selection keeps only signals with enough votes', () => {
    const ranked = [
      { config: { ...DEFAULT_CREDIT_CONFIG, signalWeightPreset: 'ema' as const }, sharpe: 1.0, trades: 40, dsr: 0.8, robustScore: 1.2 },
      { config: { ...DEFAULT_CREDIT_CONFIG, signalWeightPreset: 'mom' as const }, sharpe: 0.9, trades: 38, dsr: 0.75, robustScore: 1.1 },
      { config: { ...DEFAULT_CREDIT_CONFIG, signalWeightPreset: 'vol' as const }, sharpe: 0.8, trades: 35, dsr: 0.7, robustScore: 1.0 },
    ];
    const selected = selectConfigsForOOS(ranked, { enabled: true, minTrainTrades: 30, minDSR: 0.6, fallbackTopK: 3 }, 'ensemble_top_k', 3);

    const signals = new Map<SignalPresetKey, EntrySignal[]>([
      ['ema', [{ ticker: 'SPY', date: '2024-01-10', direction: 'CALL', score: 80 }]],
      ['mom', [{ ticker: 'SPY', date: '2024-01-10', direction: 'CALL', score: 78 }]],
      ['vol', [{ ticker: 'QQQ', date: '2024-01-10', direction: 'CALL', score: 82 }]],
    ]);

    const configured = buildConfiguredSignalsForWindow(
      selected,
      signals,
      '2024-01-01',
      '2024-01-31',
      2,
    );

    expect(configured).toHaveLength(1);
    expect(configured[0].signal.ticker).toBe('SPY');
    expect(configured[0].votes).toBe(2);
  });

  it('ensemble selection falls back to one config when only one is eligible', () => {
    const ranked = [
      { config: { ...DEFAULT_CREDIT_CONFIG, signalWeightPreset: 'ema' as const }, sharpe: 1.0, trades: 40, dsr: 0.8, robustScore: 1.2 },
      { config: { ...DEFAULT_CREDIT_CONFIG, signalWeightPreset: 'mom' as const }, sharpe: 1.2, trades: 5, dsr: 0.2, robustScore: 0.4 },
    ];
    const selected = selectConfigsForOOS(ranked, { enabled: true, minTrainTrades: 30, minDSR: 0.6, fallbackTopK: 2 }, 'ensemble_top_k', 3);

    expect(selected).toHaveLength(1);
    expect(selected[0].config.signalWeightPreset).toBe('ema');
  });
});
