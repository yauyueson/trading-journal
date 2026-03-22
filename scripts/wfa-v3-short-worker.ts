import { parentPort, workerData } from 'node:worker_threads';

import {
  closeDB,
  findContractDirect,
  findSpreadStrikes,
  getCachedChain,
  initDB,
} from '../src/lib/backtest/chain-cache.ts';
import { type IntradayCandle } from '../src/lib/backtest/intraday-cache.ts';
import { evaluateCreditSpread4H } from '../src/lib/backtest/intraday-monitor.ts';
import { computeOptionAnalytics, type EntrySignal, type OptionTrade } from '../src/lib/backtest/option-sim.ts';
import { applyFill } from '../src/lib/backtest/slippage.ts';
import type { FillMode } from '../src/lib/backtest/types.ts';
import { signalMapKey } from '../src/lib/backtest/wfa-v3-orchestrator.ts';
import { extractPeriodMultiplier, v3ParamsToSimConfig } from '../src/lib/backtest/wfa-v3-optimizer.ts';

interface WindowDef {
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
}

interface WorkerInit {
  signalsByMultPreset: Record<string, EntrySignal[]>;
  tickerCandles4h: Record<string, IntradayCandle[]>;
  allTradingDates: string[];
  windowDefs: WindowDef[];
  endDate: string;
  fillMode: FillMode;
}

interface WorkItem {
  id: number;
  params: Record<string, number | string | boolean>;
}

const {
  signalsByMultPreset,
  tickerCandles4h,
  allTradingDates,
  windowDefs,
  endDate,
  fillMode,
} = workerData as WorkerInit;

function evaluateSignal(
  signal: EntrySignal,
  config: ReturnType<typeof v3ParamsToSimConfig>,
  maxDate: string,
): OptionTrade | null {
  const candles4h = tickerCandles4h[signal.ticker];
  if (!candles4h) return null;

  return evaluateCreditSpread4H(
    signal,
    config,
    candles4h,
    allTradingDates,
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
}

initDB();
parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', (msg: WorkItem | { type: 'exit' }) => {
  if ('type' in msg && msg.type === 'exit') {
    closeDB();
    process.exit(0);
  }

  const item = msg as WorkItem;

  try {
    const simConfig = v3ParamsToSimConfig(item.params);
    const periodMult = extractPeriodMultiplier(item.params);
    const presetKey = simConfig.signalWeightPreset ?? 'ema';
    const allSignals = signalsByMultPreset[signalMapKey(periodMult, presetKey)] ?? [];
    const maxPerTicker = (item.params.maxPerTicker as number) ?? 5;
    const maxPositions = (item.params.maxPositions as number) ?? 10;

    const windows = [];
    const allOOSTrades: OptionTrade[] = [];
    let totalTrainSharpe = 0;

    for (let i = 0; i < windowDefs.length; i++) {
      const window = windowDefs[i];

      const trainSignals = allSignals.filter(s => s.date >= window.trainStart && s.date <= window.trainEnd);
      const trainTrades: OptionTrade[] = [];
      for (const signal of trainSignals) {
        const trade = evaluateSignal(signal, simConfig, window.trainEnd);
        if (trade) trainTrades.push(trade);
      }
      const trainAnalytics = computeOptionAnalytics(trainTrades);
      const trainSharpe = trainAnalytics.dailyPortfolioSharpe ?? trainAnalytics.tradeSharpeLegacy;

      const oosSignals = allSignals.filter(s => s.date >= window.oosStart && s.date <= window.oosEnd);
      const oosTrades: OptionTrade[] = [];
      const openPositions: OptionTrade[] = [];

      for (const signal of oosSignals) {
        for (let j = openPositions.length - 1; j >= 0; j--) {
          if (openPositions[j].exitDate <= signal.date) openPositions.splice(j, 1);
        }
        if (openPositions.length >= maxPositions) continue;
        if (openPositions.filter(t => t.ticker === signal.ticker).length >= maxPerTicker) continue;

        const trade = evaluateSignal(signal, simConfig, endDate);
        if (trade) {
          oosTrades.push(trade);
          openPositions.push(trade);
        }
      }

      const oosAnalytics = computeOptionAnalytics(oosTrades);
      const oosSharpe = oosAnalytics.dailyPortfolioSharpe ?? oosAnalytics.tradeSharpeLegacy;
      const oosMaxDD = oosAnalytics.dailyMtMDrawdownPct ?? oosAnalytics.realizedExitDrawdownPct;
      totalTrainSharpe += trainSharpe;

      windows.push({
        windowIndex: i,
        trainStart: window.trainStart,
        trainEnd: window.trainEnd,
        oosStart: window.oosStart,
        oosEnd: window.oosEnd,
        bestConfig: simConfig,
        bestTrainSharpe: trainSharpe,
        trainTradeCount: trainTrades.length,
        oosTrades,
        oosSharpe,
        oosWinRate: oosAnalytics.winRate,
        oosMaxDD,
        oosTradeCount: oosTrades.length,
      });

      allOOSTrades.push(...oosTrades);
    }

    const oosAnalytics = computeOptionAnalytics(allOOSTrades);
    const oosSharpe = oosAnalytics.dailyPortfolioSharpe ?? oosAnalytics.tradeSharpeLegacy;
    const oosMaxDD = oosAnalytics.dailyMtMDrawdownPct ?? oosAnalytics.realizedExitDrawdownPct;
    const avgTrainSharpe = windowDefs.length > 0 ? totalTrainSharpe / windowDefs.length : 0;

    parentPort!.postMessage({
      type: 'result',
      id: item.id,
      result: {
        trialId: item.id,
        params: item.params,
        windows,
        oosTrades: allOOSTrades,
        oosSharpe,
        oosWinRate: oosAnalytics.winRate,
        oosMaxDD,
        oosTotalPnl: allOOSTrades.reduce((sum, trade) => sum + trade.pnl, 0),
        avgTrainSharpe,
        wfEfficiency: avgTrainSharpe >= 0.1 ? oosSharpe / avgTrainSharpe : 0,
      },
    });
  } catch (error) {
    parentPort!.postMessage({
      type: 'result',
      id: item.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
