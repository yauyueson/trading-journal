/**
 * WFA Train Worker
 *
 * Evaluates one candidate config on one train window per work item.
 * Runs in worker_threads so CPU-heavy config sweeps can scale across cores.
 */
import { parentPort, workerData } from 'node:worker_threads';

import {
  initDB,
  closeDB,
  getCachedChain,
  findSpreadStrikes,
  findContractDirect,
} from '../src/lib/backtest/chain-cache';
import type { SpreadMatch } from '../src/lib/backtest/chain-cache';
import { applyFill, applySpreadFill } from '../src/lib/backtest/slippage';
import type { FillMode } from '../src/lib/backtest/types';
import type {
  EntrySignal,
  OptionExitType,
  OptionTrade,
  SignalPresetKey,
  SimConfig,
} from '../src/lib/backtest/option-sim';
import {
  clampSpreadCloseCost,
  computeCreditSpreadThresholds,
  computeIntrinsicSpreadCloseCost,
  createMissingChainState,
  resolveActualSpreadWidth,
  resolveTriggeredCreditExitCost,
  shouldExitNoChain,
  updateMissingChainState,
} from '../src/lib/backtest/credit-spread-exit';
import {
  computePortfolioDailyMetrics,
  evaluateSignalsWithConstraints,
  type PortfolioExecutionConfig,
  type TradeEvaluator,
} from '../src/lib/backtest/wfa-options';
import { computeDSR } from '../src/lib/backtest/wfa-v2-stats';

interface WorkerInitData {
  signalsByPreset: Record<string, EntrySignal[]>;
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
  nTrials: number;
}

interface TrainWorkResult {
  type: 'result';
  id: number;
  configIdx: number;
  sharpe: number;
  trades: number;
  dsr: number;
  robustScore: number;
  error?: string;
}

const { signalsByPreset: signalsByPresetObj, allTradingDates, fillMode, executionConfig } =
  workerData as WorkerInitData;

const signalsByPreset = new Map<SignalPresetKey, EntrySignal[]>(
  Object.entries(signalsByPresetObj) as [SignalPresetKey, EntrySignal[]][],
);

const dateIndex = new Map(allTradingDates.map((d, i) => [d, i]));

// Keep a bounded local chain memo per worker to reduce repeated SQLite reads.
const MAX_CACHE = 200;
const chainMemo = new Map<string, ReturnType<typeof getCachedChain>>();

function getCachedChainMemo(ticker: string, date: string): ReturnType<typeof getCachedChain> {
  const key = `${ticker}|${date}`;
  const cached = chainMemo.get(key);
  if (cached !== undefined) {
    chainMemo.delete(key);
    chainMemo.set(key, cached);
    return cached;
  }

  const rows = getCachedChain(ticker, date);
  if (chainMemo.size >= MAX_CACHE) {
    const oldest = chainMemo.keys().next().value;
    if (oldest) chainMemo.delete(oldest);
  }
  chainMemo.set(key, rows);
  return rows;
}

function advanceTradingDays(fromDate: string, n: number): string | null {
  const idx = dateIndex.get(fromDate) ?? -1;
  if (idx < 0) {
    for (let i = 0; i < allTradingDates.length; i++) {
      if (allTradingDates[i] > fromDate) {
        return allTradingDates[Math.min(i + n - 1, allTradingDates.length - 1)] ?? null;
      }
    }
    return null;
  }
  const targetIdx = idx + n;
  return targetIdx < allTradingDates.length ? allTradingDates[targetIdx] : null;
}

function getMonitoringDates(entryDate: string, intervalDays: number, maxDate: string): string[] {
  const dates: string[] = [];
  let current = entryDate;
  while (true) {
    const next = advanceTradingDays(current, intervalDays);
    if (!next || next > maxDate) break;
    dates.push(next);
    current = next;
  }
  return dates;
}

function buildResult(
  signal: EntrySignal,
  spread: SpreadMatch,
  entryCredit: number,
  exitDate: string,
  exitSpreadCost: number,
  exitDTE: number,
  exitStockPrice: number,
  exitType: OptionExitType,
  dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[],
  entrySlippage: number,
  exitSlippage: number,
  activeFillMode: FillMode,
): OptionTrade {
  const actualWidth = resolveActualSpreadWidth(spread);
  const boundedEntryCredit = clampSpreadCloseCost(entryCredit, actualWidth);
  const boundedExitCost = clampSpreadCloseCost(exitSpreadCost, actualWidth);
  const maxLoss = Math.max(0, actualWidth - boundedEntryCredit);
  const pnl = Math.max(
    -maxLoss * 100,
    Math.min((boundedEntryCredit - boundedExitCost) * 100, boundedEntryCredit * 100),
  );
  const pnlPct = maxLoss > 0 ? pnl / (maxLoss * 100) : 0;
  const holdDays = Math.round(
    (new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000,
  );

  return {
    ticker: signal.ticker,
    mode: 'CREDIT_SPREAD',
    direction: signal.direction,
    entryDate: signal.date,
    entrySignalScore: signal.score,
    strike: spread.short.row.strike,
    expiry: spread.short.row.expir_date,
    entryDTE: spread.short.row.dte,
    entryPrice: entryCredit,
    entryDelta: spread.short.delta,
    entryIV: spread.short.iv,
    entryStockPrice: spread.short.row.stock_price,
    longStrike: spread.long.row.strike,
    longEntryPrice: spread.long.mid,
    requestedSpreadWidth: spread.requestedSpreadWidth,
    spreadWidth: actualWidth,
    maxProfit: boundedEntryCredit,
    maxLoss,
    exitDate,
    exitPrice: boundedExitCost,
    exitDTE,
    exitStockPrice,
    exitType,
    pnl,
    pnlPct,
    holdDays,
    ivRank: signal.ivRank,
    entrySlippage: entrySlippage > 0 ? entrySlippage : undefined,
    exitSlippage: exitSlippage > 0 ? exitSlippage : undefined,
    fillMode: activeFillMode,
    dailyMtM,
    positionSize: 1,
  };
}

function resolveContangoSizeMultiplier(signal: EntrySignal, config: SimConfig): number {
  const low = config.contangoSizeLow;
  const mid = config.contangoSizeMid;
  const high = config.contangoSizeHigh;
  const midTh = config.contangoSizeMidThreshold;
  const highTh = config.contangoSizeHighThreshold;
  const sizingEnabled = [low, mid, high, midTh, highTh].every(v => v != null && Number.isFinite(v));
  if (!sizingEnabled) return 1;

  const lowV = Number(low);
  const midV = Number(mid);
  const highV = Number(high);
  const midThV = Number(midTh);
  const highThV = Number(highTh);
  if (highThV < midThV) return 1;

  const c = signal.contango;
  if (c == null || !Number.isFinite(c)) return midV;
  if (c >= highThV) return highV;
  if (c >= midThV) return midV;
  return lowV;
}

function scaleTradeByMultiplier(trade: OptionTrade, multiplier: number): OptionTrade | null {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
  if (Math.abs(multiplier - 1) < 1e-9) {
    return { ...trade, positionSize: trade.positionSize ?? 1 };
  }
  return {
    ...trade,
    pnl: trade.pnl * multiplier,
    maxProfit: trade.maxProfit != null ? trade.maxProfit * multiplier : trade.maxProfit,
    maxLoss: trade.maxLoss != null ? trade.maxLoss * multiplier : trade.maxLoss,
    entrySlippage: trade.entrySlippage != null ? trade.entrySlippage * multiplier : trade.entrySlippage,
    exitSlippage: trade.exitSlippage != null ? trade.exitSlippage * multiplier : trade.exitSlippage,
    dailyMtM: trade.dailyMtM?.map(m => ({
      ...m,
      unrealizedPnl: m.unrealizedPnl * multiplier,
    })),
    positionSize: (trade.positionSize ?? 1) * multiplier,
  };
}

function makeCachedEvaluator(activeFillMode: FillMode): TradeEvaluator {
  return (signal, config, _, maxDate) => {
    if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) {
      return null;
    }
    if (config.vrpFilter && config.vrpFilter > 0 && (signal.vrp == null || signal.vrp < config.vrpFilter)) {
      return null;
    }
    if (config.contangoFilter && config.contangoFilter > 0 && (signal.contango == null || signal.contango < config.contangoFilter)) {
      return null;
    }
    if (config.vrpPctFilter && config.vrpPctFilter > 0 && (signal.vrpPct == null || signal.vrpPct < config.vrpPctFilter)) {
      return null;
    }
    if (config.contangoPctFilter && config.contangoPctFilter > 0 && (signal.contangoPct == null || signal.contangoPct < config.contangoPctFilter)) {
      return null;
    }
    if (config.slopeFilter && config.slopeFilter > 0 && (signal.slope == null || signal.slope < config.slopeFilter)) {
      return null;
    }
    const sizeMultiplier = resolveContangoSizeMultiplier(signal, config);
    if (sizeMultiplier <= 0) return null;

    const entryChain = getCachedChainMemo(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';
    const spread = findSpreadStrikes(
      entryChain, config.creditShortDelta, config.creditSpreadWidth, optionType, config.creditDTERange,
    );
    if (!spread || spread.netCredit <= 0) return null;

    if (config.maxBidAskSpreadPct != null && config.maxBidAskSpreadPct !== Infinity) {
      const shortSpreadPct = spread.short.mid > 0.10
        ? (spread.short.ask - spread.short.bid) / spread.short.mid : 0;
      if (shortSpreadPct > config.maxBidAskSpreadPct) return null;
    }
    if (config.minShortOI != null && config.minShortOI > 0) {
      if (spread.short.oi < config.minShortOI) return null;
    }
    if (config.maxGammaThetaRatio != null && config.maxGammaThetaRatio !== Infinity) {
      const theta = Math.abs(spread.short.row.theta);
      if (theta > 0.001) {
        if (spread.short.row.gamma / theta > config.maxGammaThetaRatio) return null;
      }
    }
    if (config.maxIVSkew != null && config.maxIVSkew !== Infinity) {
      if (Math.abs(spread.short.iv - spread.long.iv) > config.maxIVSkew) return null;
    }

    let entryCredit: number;
    let entrySlippage = 0;
    if (activeFillMode === 'bidask' && config.slippage.enabled) {
      if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
        const spreadFill = applySpreadFill('bidask', spread.short, spread.long, 'open', config.slippage);
        entryCredit = spreadFill.fillPrice;
        entrySlippage = spreadFill.slippage;
      } else {
        const shortFill = applyFill(
          'bidask', spread.short.mid, spread.short.bid, spread.short.ask, 'sell',
          config.slippage, spread.short.oi, spread.short.row.dte,
        );
        const longFill = applyFill(
          'bidask', spread.long.mid, spread.long.bid, spread.long.ask, 'buy',
          config.slippage, spread.long.oi, spread.long.row.dte,
        );
        entryCredit = shortFill.fillPrice - longFill.fillPrice;
        entrySlippage = shortFill.slippage + longFill.slippage;
      }
      if (entryCredit <= 0) return null;
    } else {
      entryCredit = spread.netCredit;
    }

    const thresholds = computeCreditSpreadThresholds(config, spread, entryCredit);
    const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;
    const monitorDates = getMonitoringDates(signal.date, config.monitoringIntervalDays, monitorEnd);
    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
    let missingChainState = createMissingChainState();
    let lastValidSpreadCost: number | null = null;

    for (const checkDate of monitorDates) {
      const shortLeg = findContractDirect(
        signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType,
      );
      const longLeg = findContractDirect(
        signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType,
      );
      const fallbackChain = (!shortLeg || !longLeg) ? getCachedChainMemo(signal.ticker, checkDate) : [];
      const monitoringStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price;
      const hasValidLegs = Boolean(shortLeg && longLeg);
      missingChainState = updateMissingChainState(missingChainState, hasValidLegs);
      if (!hasValidLegs) {
        if (shouldExitNoChain(config, missingChainState)) {
          const intrinsicCost = monitoringStockPrice != null
            ? computeIntrinsicSpreadCloseCost(
                optionType,
                spread.short.row.strike,
                spread.long.row.strike,
                monitoringStockPrice,
                thresholds.actualWidth,
              )
            : null;
          const exitCost = resolveTriggeredCreditExitCost(
            'NO_CHAIN',
            Math.max(
              lastValidSpreadCost ?? thresholds.boundedEntryCredit,
              intrinsicCost ?? thresholds.boundedEntryCredit,
            ),
            thresholds,
          );
          const trade = buildResult(
            signal,
            spread,
            entryCredit,
            checkDate,
            exitCost,
            shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
            monitoringStockPrice ?? spread.short.row.stock_price,
            'NO_CHAIN',
            dailyMtM,
            entrySlippage,
            0,
            activeFillMode,
          );
          return scaleTradeByMultiplier(trade, sizeMultiplier);
        }
        continue;
      }

      let currentSpreadCost: number;
      let exitSlippageAmount = 0;
      if (activeFillMode === 'bidask' && config.slippage.enabled) {
        if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
          const spreadFill = applySpreadFill('bidask', shortLeg, longLeg, 'close', config.slippage);
          currentSpreadCost = spreadFill.fillPrice;
          exitSlippageAmount = spreadFill.slippage;
        } else {
          const shortClose = applyFill(
            'bidask', shortLeg.mid, shortLeg.bid, shortLeg.ask, 'buy',
            config.slippage, shortLeg.oi, shortLeg.row.dte,
          );
          const longClose = applyFill(
            'bidask', longLeg.mid, longLeg.bid, longLeg.ask, 'sell',
            config.slippage, longLeg.oi, longLeg.row.dte,
          );
          currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
          exitSlippageAmount = shortClose.slippage + longClose.slippage;
        }
      } else {
        currentSpreadCost = shortLeg.mid - longLeg.mid;
      }
      currentSpreadCost = clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth);
      const currentDTE = shortLeg.row.dte;
      lastValidSpreadCost = currentSpreadCost;

      dailyMtM.push({
        date: checkDate,
        spreadMid: currentSpreadCost,
        unrealizedPnl: (entryCredit - currentSpreadCost) * 100,
      });

      let exitType: OptionExitType | null = null;
      if (currentSpreadCost <= thresholds.tpCost) exitType = 'PROFIT_TARGET';
      else if (currentSpreadCost >= thresholds.slCost) exitType = 'STOP_LOSS';
      else if (config.creditDeltaStop != null && isFinite(config.creditDeltaStop) &&
        Math.abs(shortLeg.delta) >= config.creditDeltaStop) exitType = 'DELTA_STOP';
      else if (currentDTE <= config.creditTimeStopDTE) exitType = 'TIME_STOP';

      if (exitType) {
        const exitCost = resolveTriggeredCreditExitCost(exitType, currentSpreadCost, thresholds);
        const trade = buildResult(
          signal, spread, entryCredit, checkDate, exitCost, currentDTE, shortLeg.row.stock_price,
          exitType, dailyMtM, entrySlippage, exitSlippageAmount, activeFillMode,
        );
        return scaleTradeByMultiplier(trade, sizeMultiplier);
      }
    }

    const lastDate = monitorDates[monitorDates.length - 1];
    if (lastDate) {
      const shortLeg = findContractDirect(
        signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType,
      );
      const longLeg = findContractDirect(
        signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType,
      );
      const fallbackChain = (!shortLeg || !longLeg) ? getCachedChainMemo(signal.ticker, lastDate) : [];

      let currentSpreadCost: number;
      if (shortLeg && longLeg) {
        currentSpreadCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, thresholds.actualWidth);
      } else {
        const stockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price;
        currentSpreadCost = computeIntrinsicSpreadCloseCost(
          optionType,
          spread.short.row.strike,
          spread.long.row.strike,
          stockPrice,
          thresholds.actualWidth,
        );
      }

      const trade = buildResult(
        signal,
        spread,
        entryCredit,
        lastDate,
        currentSpreadCost,
        shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
        shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price,
        'EXPIRATION',
        dailyMtM,
        entrySlippage,
        0,
        activeFillMode,
      );
      return scaleTradeByMultiplier(trade, sizeMultiplier);
    }
    return null;
  };
}

initDB();
const evaluator = makeCachedEvaluator(fillMode);
parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', (msg: TrainWorkItem | { type: 'exit' }) => {
  if ('type' in msg && msg.type === 'exit') {
    closeDB();
    process.exit(0);
  }

  const item = msg as TrainWorkItem;
  try {
    const presetKey = item.config.signalWeightPreset ?? 'ema';
    const presetSignals = signalsByPreset.get(presetKey) ?? [];
    const trainSignals = presetSignals.filter(s => s.date >= item.trainStart && s.date <= item.trainEnd);

    const trades = evaluateSignalsWithConstraints(
      trainSignals,
      item.config,
      executionConfig,
      allTradingDates,
      item.trainEnd,
      evaluator,
    );
    const portfolioMetrics = computePortfolioDailyMetrics(
      trades,
      allTradingDates,
      item.trainStart,
      item.trainEnd,
      executionConfig.startingCapital,
    );
    const dsr = computeDSR(
      portfolioMetrics.sharpe,
      Math.max(1, item.nTrials),
      portfolioMetrics.dailyReturns,
    ).dsr;
    const tradeWeight = 1 + Math.log1p(Math.max(0, trades.length)) / 4;
    const robustScore = portfolioMetrics.sharpe * (0.5 + dsr) * tradeWeight;

    const result: TrainWorkResult = {
      type: 'result',
      id: item.id,
      configIdx: item.configIdx,
      sharpe: portfolioMetrics.sharpe,
      trades: trades.length,
      dsr,
      robustScore,
    };
    parentPort!.postMessage(result);
  } catch (err: any) {
    const result: TrainWorkResult = {
      type: 'result',
      id: item.id,
      configIdx: item.configIdx,
      sharpe: Number.NEGATIVE_INFINITY,
      trades: 0,
      dsr: 0,
      robustScore: Number.NEGATIVE_INFINITY,
      error: err?.message ?? 'Unknown worker error',
    };
    parentPort!.postMessage(result);
  }
});
