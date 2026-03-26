import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  executePreparedOOSWindowsWithCarry,
  computePortfolioDailyMetrics,
  evaluateSignalsWithConstraints,
  type TradeEvaluator,
} from '../src/lib/backtest/wfa-options';
import {
  DEFAULT_SHORT_CREDIT_CONFIG,
  type EntrySignal,
  type OptionTrade,
  type SimConfig,
} from '../src/lib/backtest/option-sim';
import { signalMapKey } from '../src/lib/backtest/wfa-v3-orchestrator';
import {
  __testHooks,
  type ShortPipelineConfig,
} from '../scripts/wfa-pipeline-short';

const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);

afterEach(() => {
  writeSpy.mockClear();
});

afterAll(() => {
  writeSpy.mockRestore();
});

function buildShortTrade(
  signal: EntrySignal,
  pnl: number,
): OptionTrade {
  return {
    ticker: signal.ticker,
    mode: 'CREDIT_SPREAD',
    direction: signal.direction,
    entryDate: signal.date,
    entrySignalScore: signal.score,
    strike: 470,
    expiry: '2024-01-19',
    entryDTE: 10,
    entryPrice: 1.0,
    entryDelta: -0.30,
    entryIV: 0.20,
    entryStockPrice: 480,
    spreadWidth: 5,
    maxProfit: 1.0,
    maxLoss: 4.0,
    exitDate: signal.date,
    exitPrice: pnl >= 0 ? 0.5 : 1.5,
    exitDTE: 9,
    exitStockPrice: 481,
    exitType: pnl >= 0 ? 'PROFIT_TARGET' : 'STOP_LOSS',
    pnl,
    pnlPct: pnl / 400,
    holdDays: 0,
  };
}

function buildCarriedShortTrade(
  signal: EntrySignal,
  pnl: number,
  exitDate: string,
  maxLoss = 4.0,
): OptionTrade {
  return {
    ...buildShortTrade(signal, pnl),
    exitDate,
    exitDTE: 5,
    maxLoss,
    pnlPct: pnl / (maxLoss * 100),
  };
}

function summarizePreparedWindows(prepared: ReturnType<typeof __testHooks.prepareShortWindowsSingleThread>) {
  return prepared.map(window => ({
    windowIndex: window.windowIndex,
    bestPreset: window.bestConfig.signalWeightPreset,
    bestProfitTarget: window.bestConfig.creditProfitTarget,
    bestTrainSharpe: Number(window.bestTrainSharpe.toFixed(12)),
    configuredSignals: window.configuredSignals.map(item => ({
      ticker: item.signal.ticker,
      date: item.signal.date,
      direction: item.signal.direction,
      preset: item.config.signalWeightPreset,
    })),
  }));
}

function summarizeTrades(trades: OptionTrade[]) {
  return trades.map(trade => ({
    ticker: trade.ticker,
    entryDate: trade.entryDate,
    exitDate: trade.exitDate,
    exitType: trade.exitType,
    pnl: trade.pnl,
  }));
}

describe('short pipeline window selection parity', () => {
  it('produces identical prepared windows and OOS trades for single-thread and worker-style paths', async () => {
    const pipelineConfig: ShortPipelineConfig = {
      tickers: ['SPY', 'QQQ'],
      dataStart: '2024-01-02',
      startDate: '2024-01-02',
      endDate: '2024-01-09',
      trainWindowDays: 2,
      forwardStepDays: 1,
      purgeGapDays: 0,
      mode: 'rolling',
      maxPositions: 2,
      maxPerTicker: 2,
      startingCapital: 100_000,
      fillMode: 'mid',
      numWorkers: 2,
      presets: ['ema', 'mom'],
      periodMultipliers: [2.25],
    };

    const candidates: SimConfig[] = [
      {
        ...DEFAULT_SHORT_CREDIT_CONFIG,
        signalWeightPreset: 'ema',
        indicatorPeriodMultiplier: 2.25,
        creditProfitTarget: 0.30,
      },
      {
        ...DEFAULT_SHORT_CREDIT_CONFIG,
        signalWeightPreset: 'mom',
        indicatorPeriodMultiplier: 2.25,
        creditProfitTarget: 0.50,
      },
    ];

    const emaSignals: EntrySignal[] = [
      { ticker: 'SPY', date: '2024-01-02', direction: 'CALL', score: 80 },
      { ticker: 'SPY', date: '2024-01-03', direction: 'CALL', score: 81 },
      { ticker: 'SPY', date: '2024-01-04', direction: 'CALL', score: 82 },
      { ticker: 'SPY', date: '2024-01-05', direction: 'CALL', score: 83 },
    ];
    const momSignals: EntrySignal[] = [
      { ticker: 'QQQ', date: '2024-01-02', direction: 'CALL', score: 75 },
      { ticker: 'QQQ', date: '2024-01-03', direction: 'CALL', score: 76 },
      { ticker: 'QQQ', date: '2024-01-04', direction: 'CALL', score: 77 },
      { ticker: 'QQQ', date: '2024-01-05', direction: 'CALL', score: 78 },
    ];
    const signalsByMultPreset = new Map<string, EntrySignal[]>([
      [signalMapKey(2.25, 'ema'), emaSignals],
      [signalMapKey(2.25, 'mom'), momSignals],
    ]);

    const allTradingDates = [
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
      '2024-01-05',
      '2024-01-08',
      '2024-01-09',
    ];
    const windowDefs = [
      {
        trainStart: '2024-01-02',
        trainEnd: '2024-01-03',
        oosStart: '2024-01-04',
        oosEnd: '2024-01-04',
      },
      {
        trainStart: '2024-01-03',
        trainEnd: '2024-01-04',
        oosStart: '2024-01-05',
        oosEnd: '2024-01-05',
      },
    ];

    const pnlByPresetDate: Record<string, Record<string, number>> = {
      ema: {
        '2024-01-02': 120,
        '2024-01-03': 60,
        '2024-01-04': -40,
        '2024-01-05': 25,
      },
      mom: {
        '2024-01-02': -30,
        '2024-01-03': 10,
        '2024-01-04': 90,
        '2024-01-05': 35,
      },
    };
    const evaluator: TradeEvaluator = (signal, config) => {
      const preset = config.signalWeightPreset ?? 'ema';
      return buildShortTrade(signal, pnlByPresetDate[preset]?.[signal.date] ?? 0);
    };

    const singlePrepared = __testHooks.prepareShortWindowsSingleThread(
      candidates,
      signalsByMultPreset,
      allTradingDates,
      windowDefs,
      evaluator,
      pipelineConfig,
    );

    const fakeTrainWorkRunner = async (_workers: unknown[], workItems: Array<{
      id: number;
      configIdx: number;
      config: SimConfig;
      trainStart: string;
      trainEnd: string;
    }>) => {
      return workItems.map(item => {
        const signals = signalsByMultPreset.get(__testHooks.resolveShortSignalKey(item.config)) ?? [];
        const trainSignals = signals.filter(signal =>
          signal.date >= item.trainStart && signal.date <= item.trainEnd,
        );
        const trainTrades = evaluateSignalsWithConstraints(
          trainSignals,
          item.config,
          __testHooks.buildShortExecutionConfig(pipelineConfig),
          allTradingDates,
          item.trainEnd,
          evaluator,
        );
        const trainSharpe = computePortfolioDailyMetrics(
          trainTrades,
          allTradingDates,
          item.trainStart,
          item.trainEnd,
          pipelineConfig.startingCapital,
        ).sharpe;
        return {
          type: 'result' as const,
          id: item.id,
          configIdx: item.configIdx,
          sharpe: trainSharpe,
          trades: trainTrades.length,
        };
      });
    };

    const parallelPrepared = await __testHooks.prepareShortWindowsParallel(
      [] as any,
      candidates,
      signalsByMultPreset,
      windowDefs,
      fakeTrainWorkRunner as any,
    );

    expect(summarizePreparedWindows(parallelPrepared)).toEqual(summarizePreparedWindows(singlePrepared));

    const executionConfig = __testHooks.buildShortExecutionConfig(pipelineConfig);
    const singleExecution = executePreparedOOSWindowsWithCarry(
      singlePrepared,
      executionConfig,
      allTradingDates,
      pipelineConfig.endDate,
      evaluator,
      'strict',
      pipelineConfig.startingCapital,
    );
    const parallelExecution = executePreparedOOSWindowsWithCarry(
      parallelPrepared,
      executionConfig,
      allTradingDates,
      pipelineConfig.endDate,
      evaluator,
      'strict',
      pipelineConfig.startingCapital,
    );

    expect(summarizeTrades(parallelExecution.allOOSTrades)).toEqual(
      summarizeTrades(singleExecution.allOOSTrades),
    );
    expect(parallelExecution.windows.map(window => ({
      bestPreset: window.bestConfig.signalWeightPreset,
      oosTradeCount: window.oosTrades.length,
      oosSharpe: Number(window.oosSharpe.toFixed(12)),
    }))).toEqual(
      singleExecution.windows.map(window => ({
        bestPreset: window.bestConfig.signalWeightPreset,
        oosTradeCount: window.oosTrades.length,
        oosSharpe: Number(window.oosSharpe.toFixed(12)),
      })),
    );
  });

  it('preserves carried capital-at-risk parity between single-thread and worker-style preparation', async () => {
    const pipelineConfig: ShortPipelineConfig = {
      tickers: ['SPY', 'QQQ'],
      dataStart: '2024-01-02',
      startDate: '2024-01-02',
      endDate: '2024-01-09',
      trainWindowDays: 2,
      forwardStepDays: 1,
      purgeGapDays: 0,
      mode: 'rolling',
      maxPositions: 2,
      maxPerTicker: 2,
      startingCapital: 450,
      fillMode: 'mid',
      numWorkers: 2,
      presets: ['ema', 'mom'],
      periodMultipliers: [2.25],
    };

    const candidates: SimConfig[] = [
      {
        ...DEFAULT_SHORT_CREDIT_CONFIG,
        signalWeightPreset: 'ema',
        indicatorPeriodMultiplier: 2.25,
        creditProfitTarget: 0.30,
      },
      {
        ...DEFAULT_SHORT_CREDIT_CONFIG,
        signalWeightPreset: 'mom',
        indicatorPeriodMultiplier: 2.25,
        creditProfitTarget: 0.50,
      },
    ];

    const emaSignals: EntrySignal[] = [
      { ticker: 'SPY', date: '2024-01-02', direction: 'CALL', score: 80 },
      { ticker: 'SPY', date: '2024-01-03', direction: 'CALL', score: 81 },
      { ticker: 'SPY', date: '2024-01-04', direction: 'CALL', score: 82 },
      { ticker: 'SPY', date: '2024-01-05', direction: 'CALL', score: 83 },
    ];
    const momSignals: EntrySignal[] = [
      { ticker: 'QQQ', date: '2024-01-02', direction: 'CALL', score: 75 },
      { ticker: 'QQQ', date: '2024-01-03', direction: 'CALL', score: 76 },
      { ticker: 'QQQ', date: '2024-01-04', direction: 'CALL', score: 77 },
      { ticker: 'QQQ', date: '2024-01-05', direction: 'CALL', score: 78 },
    ];
    const signalsByMultPreset = new Map<string, EntrySignal[]>([
      [signalMapKey(2.25, 'ema'), emaSignals],
      [signalMapKey(2.25, 'mom'), momSignals],
    ]);

    const allTradingDates = [
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
      '2024-01-05',
      '2024-01-08',
      '2024-01-09',
    ];
    const windowDefs = [
      {
        trainStart: '2024-01-02',
        trainEnd: '2024-01-03',
        oosStart: '2024-01-04',
        oosEnd: '2024-01-04',
      },
      {
        trainStart: '2024-01-03',
        trainEnd: '2024-01-04',
        oosStart: '2024-01-05',
        oosEnd: '2024-01-05',
      },
    ];

    const pnlByPresetDate: Record<string, Record<string, number>> = {
      ema: {
        '2024-01-02': 120,
        '2024-01-03': 60,
        '2024-01-04': 50,
        '2024-01-05': 30,
      },
      mom: {
        '2024-01-02': -30,
        '2024-01-03': 10,
        '2024-01-04': 90,
        '2024-01-05': 35,
      },
    };
    const evaluator: TradeEvaluator = (signal, config) => {
      const preset = config.signalWeightPreset ?? 'ema';
      const pnl = pnlByPresetDate[preset]?.[signal.date] ?? 0;
      return buildCarriedShortTrade(
        signal,
        pnl,
        signal.date === '2024-01-04' ? '2024-01-08' : signal.date,
      );
    };

    const singlePrepared = __testHooks.prepareShortWindowsSingleThread(
      candidates,
      signalsByMultPreset,
      allTradingDates,
      windowDefs,
      evaluator,
      pipelineConfig,
    );

    const fakeTrainWorkRunner = async (_workers: unknown[], workItems: Array<{
      id: number;
      configIdx: number;
      config: SimConfig;
      trainStart: string;
      trainEnd: string;
    }>) => {
      return workItems.map(item => {
        const signals = signalsByMultPreset.get(__testHooks.resolveShortSignalKey(item.config)) ?? [];
        const trainSignals = signals.filter(signal =>
          signal.date >= item.trainStart && signal.date <= item.trainEnd,
        );
        const trainTrades = evaluateSignalsWithConstraints(
          trainSignals,
          item.config,
          __testHooks.buildShortExecutionConfig(pipelineConfig),
          allTradingDates,
          item.trainEnd,
          evaluator,
        );
        return {
          type: 'result' as const,
          id: item.id,
          configIdx: item.configIdx,
          sharpe: computePortfolioDailyMetrics(
            trainTrades,
            allTradingDates,
            item.trainStart,
            item.trainEnd,
            pipelineConfig.startingCapital,
          ).sharpe,
          trades: trainTrades.length,
        };
      });
    };

    const parallelPrepared = await __testHooks.prepareShortWindowsParallel(
      [] as any,
      candidates,
      signalsByMultPreset,
      windowDefs,
      fakeTrainWorkRunner as any,
    );

    const executionConfig = __testHooks.buildShortExecutionConfig(pipelineConfig);
    const singleExecution = executePreparedOOSWindowsWithCarry(
      singlePrepared,
      executionConfig,
      allTradingDates,
      pipelineConfig.endDate,
      evaluator,
      'strict',
      pipelineConfig.startingCapital,
    );
    const parallelExecution = executePreparedOOSWindowsWithCarry(
      parallelPrepared,
      executionConfig,
      allTradingDates,
      pipelineConfig.endDate,
      evaluator,
      'strict',
      pipelineConfig.startingCapital,
    );

    expect(summarizeTrades(parallelExecution.allOOSTrades)).toEqual(
      summarizeTrades(singleExecution.allOOSTrades),
    );
    expect(parallelExecution.allOOSTrades).toHaveLength(1);
    expect(singleExecution.windows.map(window => window.oosTrades.length)).toEqual([1, 0]);
    expect(parallelExecution.windows.map(window => window.oosTrades.length)).toEqual([1, 0]);
  });
});
