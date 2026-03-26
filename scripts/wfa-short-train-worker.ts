import { parentPort, workerData } from 'node:worker_threads';

import {
  closeDB,
  findContractDirect,
  findSpreadStrikes,
  getCachedChain,
  initDB,
} from '../src/lib/backtest/chain-cache.ts';
import type { IntradayCandle } from '../src/lib/backtest/intraday-cache.ts';
import { evaluateCreditSpread4H } from '../src/lib/backtest/intraday-monitor.ts';
import type { EntrySignal, OptionTrade, SimConfig } from '../src/lib/backtest/option-sim.ts';
import { applyFill } from '../src/lib/backtest/slippage.ts';
import type { FillMode, DirConfTier } from '../src/lib/backtest/types.ts';
import { DIR_CONF_THRESHOLDS } from '../src/lib/backtest/types.ts';
import {
  computePortfolioDailyMetrics,
  evaluateSignalsWithConstraints,
  type PortfolioExecutionConfig,
  type TradeEvaluator,
} from '../src/lib/backtest/wfa-options.ts';
import { signalMapKey } from '../src/lib/backtest/wfa-v3-orchestrator.ts';

interface WorkerInitData {
  signalsByMultPreset: Record<string, EntrySignal[]>;
  tickerCandles130m: Record<string, IntradayCandle[]>;
  allTradingDates: string[];
  fillMode: FillMode;
  executionConfig: PortfolioExecutionConfig;
}

interface TrainWorkItem {
  id: number;
  configIdx: number;
  config: SimConfig;
  trainStart: string;
  trainEnd: string;
}

interface TrainWorkResult {
  type: 'result';
  id: number;
  configIdx: number;
  sharpe: number;
  trades: number;
  error?: string;
}

const {
  signalsByMultPreset,
  tickerCandles130m,
  allTradingDates,
  fillMode,
  executionConfig,
} = workerData as WorkerInitData;

function resolveSignalKey(config: SimConfig): string {
  const presetKey = config.signalWeightPreset ?? 'ema';
  const periodMult = (config as any).indicatorPeriodMultiplier ?? 2.25;
  return signalMapKey(periodMult, presetKey);
}

function makeEvaluator(): TradeEvaluator {
  return (signal, config, tradingDates, maxDate) => {
    const candles = tickerCandles130m[signal.ticker];
    if (!candles) return null;

    if (config.dirConfTier && config.dirConfTier !== 'any' && signal.dirConfidence != null) {
      if (signal.dirConfidence < DIR_CONF_THRESHOLDS[config.dirConfTier as DirConfTier]) return null;
    }

    return evaluateCreditSpread4H(
      signal,
      config,
      candles,
      tradingDates,
      maxDate,
      {
        getChain: (ticker, date) => getCachedChain(ticker, date),
        findSpread: (chain, shortDelta, width, type, dteRange) =>
          findSpreadStrikes(chain, shortDelta, width, type as 'Call' | 'Put', dteRange),
        findContract: (ticker, date, strike, expiry, type) =>
          findContractDirect(ticker, date, strike, expiry, type as 'Call' | 'Put'),
        applyFillFn: (mid, bid, ask, side, cfg, oi, dte) =>
          applyFill(fillMode, mid, bid, ask, side, cfg, oi, dte),
      },
    );
  };
}

initDB();
const evaluator = makeEvaluator();
parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', (msg: TrainWorkItem | { type: 'exit' }) => {
  if ('type' in msg && msg.type === 'exit') {
    closeDB();
    process.exit(0);
  }

  const item = msg as TrainWorkItem;

  try {
    const signals = signalsByMultPreset[resolveSignalKey(item.config)] ?? [];
    const trainSignals = signals.filter(s => s.date >= item.trainStart && s.date <= item.trainEnd);
    const trainTrades: OptionTrade[] = evaluateSignalsWithConstraints(
      trainSignals,
      item.config,
      executionConfig,
      allTradingDates,
      item.trainEnd,
      evaluator,
    );
    const sharpe = computePortfolioDailyMetrics(
      trainTrades,
      allTradingDates,
      item.trainStart,
      item.trainEnd,
      executionConfig.startingCapital,
    ).sharpe;

    parentPort!.postMessage({
      type: 'result',
      id: item.id,
      configIdx: item.configIdx,
      sharpe,
      trades: trainTrades.length,
    } satisfies TrainWorkResult);
  } catch (error) {
    parentPort!.postMessage({
      type: 'result',
      id: item.id,
      configIdx: item.configIdx,
      sharpe: Number.NEGATIVE_INFINITY,
      trades: 0,
      error: error instanceof Error ? error.message : String(error),
    } satisfies TrainWorkResult);
  }
});
