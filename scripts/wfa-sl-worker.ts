/**
 * Worker thread for WFA SL Study — evaluates a single SL config across all windows.
 * Each worker initializes its own chain cache DB connection (read-only, safe to share).
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  initDB, closeDB,
  getCachedChain, findSpreadStrikes, findContractDirect,
} from '../src/lib/backtest/chain-cache';
import {
  DEFAULT_CREDIT_CONFIG,
  DEFAULT_SHORT_CREDIT_CONFIG,
  computeOptionAnalytics,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionExitType,
} from '../src/lib/backtest/option-sim';
import type { FillMode, DirConfTier } from '../src/lib/backtest/types';
import { DEFAULT_DYNAMIC_SLIPPAGE, DIR_CONF_THRESHOLDS } from '../src/lib/backtest/types';
import { applyFill } from '../src/lib/backtest/slippage';
import {
  evaluateConfiguredSignalsWithConstraints,
  computePortfolioDailyMetrics,
  type PortfolioExecutionConfig,
  type TradeEvaluator,
  type ConfiguredSignal,
} from '../src/lib/backtest/wfa-options';
import { evaluateCreditSpread4H } from '../src/lib/backtest/intraday-monitor';
import type { IntradayCandle } from '../src/lib/backtest/intraday-cache';

// ── Types ────────────────────────────────────────────────

interface WorkItem {
  type: 'eval';
  id: number;
  configLabel: string;
  slConfig: SimConfig;
  selectionWindows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>;
  holdoutWindows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>;
}

interface WindowResult {
  windowIdx: number;
  trainSharpe: number;
  oosSharpe: number;
  oosWR: number;
  oosMaxDD: number;
  oosTradeCount: number;
  oosTrades: OptionTrade[];
}

interface WorkResult {
  type: 'result';
  id: number;
  configLabel: string;
  selectionResults: Array<{
    windowIdx: number;
    trainSharpe: number;
    oosSharpe: number;
    oosWR: number;
    oosMaxDD: number;
    oosTradeCount: number;
  }>;
  allOOSTrades: OptionTrade[];
  holdoutTrades: OptionTrade[];
  error?: string;
}

// ── Worker Init ──────────────────────────────────────────

const {
  signals,
  allTradingDates,
  strategy,
  executionConfig,
  startingCapital,
  startDate,
  endDate,
  // Short-term specific
  tickerCandles130m,
  tickerIvData,
} = workerData as {
  signals: EntrySignal[];
  allTradingDates: string[];
  strategy: 'swing' | 'short';
  executionConfig: PortfolioExecutionConfig;
  startingCapital: number;
  startDate: string;
  endDate: string;
  tickerCandles130m?: Record<string, IntradayCandle[]>;
  tickerIvData?: Record<string, any[]>;
};

// Init chain cache (each worker gets its own read-only connection)
initDB();

// ── Evaluators ───────────────────────────────────────────

function makeSwingEvaluator(): TradeEvaluator {
  return (signal, config, allDates, maxDate) => {
    const entryChain = getCachedChain(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';
    const spread = findSpreadStrikes(
      entryChain, config.creditShortDelta, config.creditSpreadWidth,
      optionType, config.creditDTERange,
    );
    if (!spread || spread.netCredit <= 0) return null;
    if (config.minIVRank > 0 && signal.ivRank != null && signal.ivRank < config.minIVRank) return null;
    if (config.dirConfTier && config.dirConfTier !== 'any' && signal.dirConfidence != null) {
      if (signal.dirConfidence < DIR_CONF_THRESHOLDS[config.dirConfTier]) return null;
    }

    let entryCredit = spread.netCredit;
    const tpCost = entryCredit * (1 - config.creditProfitTarget);
    const slCost = entryCredit * config.creditStopLossMultiple;
    const maxLoss = config.creditSpreadWidth - entryCredit;
    const maxLossStopCost = (config.creditMaxLossStopPct != null && config.creditMaxLossStopPct < 1.0)
      ? entryCredit + (config.creditMaxLossStopPct * maxLoss) : Infinity;
    let trailingFloorActive = false;
    let trailingFloorCost = Infinity;
    const tpProfit = entryCredit * config.creditProfitTarget;

    const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;
    const startIdx = allDates.indexOf(signal.date);
    if (startIdx < 0) return null;
    const monitorDates: string[] = [];
    for (let i = startIdx + 1; i < allDates.length; i++) {
      if (allDates[i] > monitorEnd) break;
      monitorDates.push(allDates[i]);
    }

    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

    for (const checkDate of monitorDates) {
      const shortLeg = findContractDirect(signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      const longLeg = findContractDirect(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
      if (!shortLeg || !longLeg) continue;

      const currentSpreadCost = shortLeg.mid - longLeg.mid;
      const currentDTE = shortLeg.row.dte;
      dailyMtM.push({ date: checkDate, spreadMid: currentSpreadCost, unrealizedPnl: (entryCredit - currentSpreadCost) * 100 });

      if (config.trailingActivatePct != null && config.trailingFloorPct != null) {
        const unrealizedProfit = entryCredit - currentSpreadCost;
        if (!trailingFloorActive && unrealizedProfit >= config.trailingActivatePct * tpProfit) {
          trailingFloorActive = true;
          trailingFloorCost = entryCredit - (config.trailingFloorPct * tpProfit);
        }
      }

      let exitType: OptionExitType | null = null;
      if (currentSpreadCost <= tpCost) exitType = 'PROFIT_TARGET';
      else if (currentSpreadCost >= slCost) exitType = 'STOP_LOSS';
      else if (currentSpreadCost >= maxLossStopCost) exitType = 'MAX_LOSS_STOP';
      else if (config.creditDeltaStop != null && isFinite(config.creditDeltaStop) &&
               config.creditDeltaStop > 0 && Math.abs(shortLeg.delta) >= config.creditDeltaStop) exitType = 'DELTA_STOP';
      else if (trailingFloorActive && currentSpreadCost > trailingFloorCost) exitType = 'TRAILING_LOCK';
      else if (currentDTE <= config.creditTimeStopDTE) exitType = 'TIME_STOP';

      if (exitType) {
        const pnl = (entryCredit - currentSpreadCost) * 100;
        return {
          ticker: signal.ticker, mode: 'CREDIT_SPREAD' as const, direction: signal.direction as 'CALL' | 'PUT',
          entryDate: signal.date, exitDate: checkDate, entryPrice: entryCredit, exitPrice: currentSpreadCost,
          pnl, pnlPct: spread.maxLoss > 0 ? pnl / (spread.maxLoss * 100) : 0,
          holdingDays: dailyMtM.length, exitType, entryDTE: spread.short.row.dte, exitDTE: currentDTE,
          spreadWidth: config.creditSpreadWidth, maxLoss: spread.maxLoss,
          entryStockPrice: spread.short.row.stock_price, exitStockPrice: shortLeg.row.stock_price, dailyMtM,
        };
      }
    }

    // Expiration
    const lastDate = monitorDates[monitorDates.length - 1];
    if (!lastDate) return null;
    const shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    let finalCost: number;
    if (shortLeg && longLeg) {
      finalCost = shortLeg.mid - longLeg.mid;
    } else {
      const stockPrice = (shortLeg || longLeg)?.row.stock_price ?? spread.short.row.stock_price;
      const si = optionType === 'Put' ? Math.max(0, spread.short.row.strike - stockPrice) : Math.max(0, stockPrice - spread.short.row.strike);
      const li = optionType === 'Put' ? Math.max(0, spread.long.row.strike - stockPrice) : Math.max(0, stockPrice - spread.long.row.strike);
      finalCost = si - li;
    }
    const pnl = (entryCredit - finalCost) * 100;
    return {
      ticker: signal.ticker, mode: 'CREDIT_SPREAD' as const, direction: signal.direction as 'CALL' | 'PUT',
      entryDate: signal.date, exitDate: lastDate, entryPrice: entryCredit, exitPrice: finalCost,
      pnl, pnlPct: spread.maxLoss > 0 ? pnl / (spread.maxLoss * 100) : 0,
      holdingDays: dailyMtM.length, exitType: 'EXPIRATION' as OptionExitType,
      entryDTE: spread.short.row.dte, exitDTE: 0, spreadWidth: config.creditSpreadWidth, maxLoss: spread.maxLoss,
      entryStockPrice: spread.short.row.stock_price, exitStockPrice: shortLeg?.row.stock_price ?? spread.short.row.stock_price, dailyMtM,
    };
  };
}

function makeShortEvaluator(): TradeEvaluator {
  return (signal, config, tradingDates, maxDate) => {
    const candles = tickerCandles130m?.[signal.ticker];
    if (!candles) return null;
    if (config.minIVRank > 0 && signal.ivRank != null && signal.ivRank < config.minIVRank) return null;

    return evaluateCreditSpread4H(
      signal, config, candles, tradingDates, maxDate,
      {
        getChain: (ticker, date) => getCachedChain(ticker, date),
        findSpread: (chain, shortDelta, width, type, dteRange) =>
          findSpreadStrikes(chain, shortDelta, width, type as 'Call' | 'Put', dteRange),
        findContract: (ticker, date, strike, expiry, type) =>
          findContractDirect(ticker, date, strike, expiry, type as 'Call' | 'Put'),
        applyFillFn: (mid, bid, ask, side, cfg, oi, dte) =>
          applyFill('mid' as FillMode, mid, bid, ask, side, cfg, oi, dte),
      },
    );
  };
}

const evaluator = strategy === 'swing' ? makeSwingEvaluator() : makeShortEvaluator();

// ── Evaluate Config on Windows ───────────────────────────

function evaluateOnWindows(
  config: SimConfig,
  windows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>,
): { results: WindowResult[]; allOOSTrades: OptionTrade[] } {
  const results: WindowResult[] = [];
  const allOOSTrades: OptionTrade[] = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];

    const trainSigs = signals.filter(s => s.date >= w.trainStart && s.date <= w.trainEnd);
    const trainConfigured: ConfiguredSignal[] = trainSigs.map(s => ({ signal: s, config }));
    const trainTrades = evaluateConfiguredSignalsWithConstraints(
      trainConfigured, executionConfig, allTradingDates, w.trainEnd, evaluator,
    );
    const trainMetrics = computePortfolioDailyMetrics(
      trainTrades, allTradingDates, w.trainStart, w.trainEnd, startingCapital,
    );

    const oosSigs = signals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const oosConfigured: ConfiguredSignal[] = oosSigs.map(s => ({ signal: s, config }));
    const oosTrades = evaluateConfiguredSignalsWithConstraints(
      oosConfigured, executionConfig, allTradingDates, w.oosEnd, evaluator,
    );
    const oosMetrics = computePortfolioDailyMetrics(
      oosTrades, allTradingDates, w.oosStart, w.oosEnd, startingCapital,
    );
    const oosAnalytics = computeOptionAnalytics(oosTrades);

    results.push({
      windowIdx: i,
      trainSharpe: trainMetrics.sharpe,
      oosSharpe: oosMetrics.sharpe,
      oosWR: oosAnalytics.winRate,
      oosMaxDD: oosMetrics.maxDrawdownPct,
      oosTradeCount: oosTrades.length,
      oosTrades,
    });
    allOOSTrades.push(...oosTrades);
  }
  return { results, allOOSTrades };
}

// ── Message Handler ──────────────────────────────────────

parentPort!.on('message', (msg: WorkItem | { type: 'exit' }) => {
  if (msg.type === 'exit') {
    closeDB();
    process.exit(0);
  }

  if (msg.type === 'eval') {
    try {
      const { results: selectionResults, allOOSTrades } = evaluateOnWindows(msg.slConfig, msg.selectionWindows);
      const { allOOSTrades: holdoutTrades } = evaluateOnWindows(msg.slConfig, msg.holdoutWindows);

      parentPort!.postMessage({
        type: 'result',
        id: msg.id,
        configLabel: msg.configLabel,
        selectionResults: selectionResults.map(w => ({
          windowIdx: w.windowIdx,
          trainSharpe: w.trainSharpe,
          oosSharpe: w.oosSharpe,
          oosWR: w.oosWR,
          oosMaxDD: w.oosMaxDD,
          oosTradeCount: w.oosTradeCount,
        })),
        allOOSTrades,
        holdoutTrades,
      } satisfies WorkResult);
    } catch (err: any) {
      parentPort!.postMessage({
        type: 'result',
        id: msg.id,
        configLabel: msg.configLabel,
        selectionResults: [],
        allOOSTrades: [],
        holdoutTrades: [],
        error: err.message,
      } satisfies WorkResult);
    }
  }
});

// Signal ready
parentPort!.postMessage({ type: 'ready' });
