/**
 * Worker thread for WFA Full Sweep — evaluates a single config across all windows.
 * Supports multiple signal sets keyed by (preset, periodMultiplier).
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  initDB, closeDB,
  getCachedChain, findSpreadStrikes, findContractDirect,
} from '../src/lib/backtest/chain-cache';
import type { SpreadMatch } from '../src/lib/backtest/chain-cache';
import {
  computeOptionAnalytics,
  projectTradesToGrossPnlView,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionExitType,
} from '../src/lib/backtest/option-sim';
import {
  buildCreditSpreadTrade,
  clampSpreadCloseCost,
  computeCreditSpreadThresholds,
  computeIntrinsicSpreadCloseCost,
  createMissingChainState,
  resolveCreditSpreadCommissions,
  resolveTriggeredCreditExitCost,
  shouldExitNoChain,
  updateMissingChainState,
} from '../src/lib/backtest/credit-spread-exit';
import type { FillMode } from '../src/lib/backtest/types';
import { DIR_CONF_THRESHOLDS } from '../src/lib/backtest/types';
import { applyFill, applySpreadFill } from '../src/lib/backtest/slippage';
import {
  evaluateConfiguredSignalsWithConstraints,
  computePortfolioDailyMetrics,
  type PortfolioExecutionConfig,
  type TradeEvaluator,
  type ConfiguredSignal,
} from '../src/lib/backtest/wfa-options';

// ── Types ────────────────────────────────────────────────

interface WorkItem {
  type: 'eval';
  id: number;
  configLabel: string;
  config: SimConfig;
  signalKey: string;  // key into signalSets map
  selectionWindows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>;
  holdoutWindows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>;
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
  // Aggregated metrics (not raw trades — avoids OOM on worker→main transfer)
  oosSharpe: number;
  oosGrossSharpe: number;
  oosMaxDD: number;
  oosWinRate: number;
  oosTotalPnl: number;
  oosGrossTotalPnl: number;
  oosTradeCount: number;
  oosExitTypes: Record<string, number>;
  holdoutSharpe: number;
  holdoutGrossSharpe: number;
  holdoutMaxDD: number;
  holdoutTotalPnl: number;
  holdoutGrossTotalPnl: number;
  holdoutTradeCount: number;
  error?: string;
}

// ── Worker Init ──────────────────────────────────────────

const {
  signalSets,        // Map<signalKey, EntrySignal[]>
  allTradingDates,
  executionConfig,
  startingCapital,
  startDate,
  endDate,
} = workerData as {
  signalSets: Record<string, EntrySignal[]>;
  allTradingDates: string[];
  executionConfig: PortfolioExecutionConfig;
  startingCapital: number;
  startDate: string;
  endDate: string;
};

// Init chain cache (each worker gets its own read-only connection)
initDB();

function buildTrade(
  signal: EntrySignal,
  spread: SpreadMatch,
  entryCredit: number,
  exitDate: string,
  exitSpreadCost: number,
  exitDTE: number,
  exitStockPrice: number,
  exitType: OptionExitType,
  dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[],
  grossEntryCredit?: number,
  grossExitSpreadCost?: number,
  entrySlippage?: number,
  exitSlippage?: number,
  entryCommission?: number,
  exitCommission?: number,
  fillMode?: FillMode,
): OptionTrade {
  return buildCreditSpreadTrade({
    signal,
    spread,
    entryCredit,
    grossEntryCredit,
    exitDate,
    exitSpreadCost,
    grossExitSpreadCost,
    exitDTE,
    exitStockPrice,
    exitType,
    dailyMtM,
    entrySlippage,
    exitSlippage,
    entryCommission,
    exitCommission,
    fillMode,
  });
}

// ── Evaluator (EOD chain-based, no BSM) ─────────────────

function makeChainEvaluator(): TradeEvaluator {
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

    const grossEntryCredit = spread.netCredit;
    let entryCredit = grossEntryCredit;
    let entrySlippage = 0;
    const { entryCommission, exitCommission } = resolveCreditSpreadCommissions(config);
    if (config.fillMode === 'bidask' && config.slippage.enabled) {
      if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
        const spreadFill = applySpreadFill(
          'bidask',
          { ...spread.short, dte: spread.short.row.dte },
          { ...spread.long, dte: spread.long.row.dte },
          'open',
          config.slippage,
        );
        entryCredit = spreadFill.fillPrice;
        entrySlippage = spreadFill.slippage;
      } else {
        const shortFill = applyFill('bidask', spread.short.mid, spread.short.bid,
          spread.short.ask, 'sell', config.slippage, spread.short.oi, spread.short.row.dte);
        const longFill = applyFill('bidask', spread.long.mid, spread.long.bid,
          spread.long.ask, 'buy', config.slippage, spread.long.oi, spread.long.row.dte);
        entryCredit = shortFill.fillPrice - longFill.fillPrice;
        entrySlippage = shortFill.slippage + longFill.slippage;
      }
      if (entryCredit <= 0) return null;
    }
    const thresholds = computeCreditSpreadThresholds(config, spread, entryCredit);
    let trailingFloorActive = false;
    let trailingFloorCost = Infinity;
    let missingChainState = createMissingChainState();
    let lastValidSpreadCost: number | null = null;

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
      const fallbackChain = (!shortLeg || !longLeg) ? getCachedChain(signal.ticker, checkDate) : [];
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
          return buildTrade(
            signal,
            spread,
            entryCredit,
            checkDate,
            exitCost,
            shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
            monitoringStockPrice ?? spread.short.row.stock_price,
            'NO_CHAIN',
            dailyMtM,
          );
        }
        continue;
      }

      const grossCurrentSpreadCost = clampSpreadCloseCost(
        shortLeg.mid - longLeg.mid,
        thresholds.actualWidth,
      );
      let currentSpreadCost = grossCurrentSpreadCost;
      let exitSlippageAmount = 0;
      if (config.fillMode === 'bidask' && config.slippage.enabled) {
        if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
          const spreadFill = applySpreadFill(
            'bidask',
            { ...shortLeg, dte: shortLeg.row.dte },
            { ...longLeg, dte: longLeg.row.dte },
            'close',
            config.slippage,
          );
          currentSpreadCost = clampSpreadCloseCost(spreadFill.fillPrice, thresholds.actualWidth);
          exitSlippageAmount = spreadFill.slippage;
        } else {
          const shortClose = applyFill('bidask', shortLeg.mid, shortLeg.bid,
            shortLeg.ask, 'buy', config.slippage, shortLeg.oi, shortLeg.row.dte);
          const longClose = applyFill('bidask', longLeg.mid, longLeg.bid,
            longLeg.ask, 'sell', config.slippage, longLeg.oi, longLeg.row.dte);
          currentSpreadCost = clampSpreadCloseCost(shortClose.fillPrice - longClose.fillPrice, thresholds.actualWidth);
          exitSlippageAmount = shortClose.slippage + longClose.slippage;
        }
      }
      const currentDTE = shortLeg.row.dte;
      lastValidSpreadCost = currentSpreadCost;
      dailyMtM.push({ date: checkDate, spreadMid: currentSpreadCost, unrealizedPnl: (entryCredit - currentSpreadCost) * 100 });

      // Trailing lock state
      if (config.trailingActivatePct != null && config.trailingFloorPct != null) {
        const unrealizedProfit = entryCredit - grossCurrentSpreadCost;
        if (!trailingFloorActive && unrealizedProfit >= config.trailingActivatePct * thresholds.tpProfit) {
          trailingFloorActive = true;
          trailingFloorCost = clampSpreadCloseCost(
            thresholds.boundedEntryCredit - (config.trailingFloorPct * thresholds.tpProfit),
            thresholds.actualWidth,
          );
        }
      }

      // Exit checks
      let exitType: OptionExitType | null = null;
      if (grossCurrentSpreadCost <= thresholds.tpCost) exitType = 'PROFIT_TARGET';
      else if (grossCurrentSpreadCost >= thresholds.slCost) exitType = 'STOP_LOSS';
      else if (grossCurrentSpreadCost >= thresholds.maxLossStopCost) exitType = 'MAX_LOSS_STOP';
      else if (config.creditDeltaStop != null && isFinite(config.creditDeltaStop) &&
               config.creditDeltaStop > 0 && Math.abs(shortLeg.delta) >= config.creditDeltaStop) exitType = 'DELTA_STOP';
      else if (trailingFloorActive && grossCurrentSpreadCost > trailingFloorCost) exitType = 'TRAILING_LOCK';
      else if (currentDTE <= (config.creditTimeStopDTE || 1)) exitType = 'TIME_STOP';

      if (exitType) {
        const grossExitCost = resolveTriggeredCreditExitCost(exitType, grossCurrentSpreadCost, thresholds, {
          trailingFloorCost,
        });
        const exitCost = clampSpreadCloseCost(grossExitCost + exitSlippageAmount, thresholds.actualWidth);
        return buildTrade(
          signal,
          spread,
          entryCredit,
          checkDate,
          exitCost,
          currentDTE,
          shortLeg.row.stock_price,
          exitType,
          dailyMtM,
          grossEntryCredit,
          grossExitCost,
          entrySlippage,
          exitSlippageAmount,
          entryCommission,
          exitCommission,
          config.fillMode,
        );
      }
    }

    // Expiration fallback
    const lastDate = monitorDates[monitorDates.length - 1];
    if (!lastDate) return null;
    const shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    const fallbackChain = (!shortLeg || !longLeg) ? getCachedChain(signal.ticker, lastDate) : [];
    let grossFinalCost: number;
    let finalCost: number;
    let exitSlippageAmount = 0;
    if (shortLeg && longLeg) {
      grossFinalCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, thresholds.actualWidth);
      if (config.fillMode === 'bidask' && config.slippage.enabled) {
        if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
          const spreadFill = applySpreadFill(
            'bidask',
            { ...shortLeg, dte: shortLeg.row.dte },
            { ...longLeg, dte: longLeg.row.dte },
            'close',
            config.slippage,
          );
          finalCost = clampSpreadCloseCost(spreadFill.fillPrice, thresholds.actualWidth);
          exitSlippageAmount = spreadFill.slippage;
        } else {
          const shortClose = applyFill('bidask', shortLeg.mid, shortLeg.bid,
            shortLeg.ask, 'buy', config.slippage, shortLeg.oi, shortLeg.row.dte);
          const longClose = applyFill('bidask', longLeg.mid, longLeg.bid,
            longLeg.ask, 'sell', config.slippage, longLeg.oi, longLeg.row.dte);
          finalCost = clampSpreadCloseCost(shortClose.fillPrice - longClose.fillPrice, thresholds.actualWidth);
          exitSlippageAmount = shortClose.slippage + longClose.slippage;
        }
      } else {
        finalCost = grossFinalCost;
      }
    } else {
      const stockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price;
      grossFinalCost = computeIntrinsicSpreadCloseCost(
        optionType,
        spread.short.row.strike,
        spread.long.row.strike,
        stockPrice,
        thresholds.actualWidth,
      );
      finalCost = grossFinalCost;
    }
    return buildTrade(
      signal,
      spread,
      entryCredit,
      lastDate,
      finalCost,
      shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
      shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price,
      'EXPIRATION',
      dailyMtM,
      grossEntryCredit,
      grossFinalCost,
      entrySlippage,
      exitSlippageAmount,
      entryCommission,
      exitCommission,
      config.fillMode,
    );
  };
}

const evaluator = makeChainEvaluator();

// ── Evaluate Config on Windows ───────────────────────────

function evaluateOnWindows(
  config: SimConfig,
  signals: EntrySignal[],
  windows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>,
): { results: Array<{ windowIdx: number; trainSharpe: number; oosSharpe: number; oosWR: number; oosMaxDD: number; oosTradeCount: number; oosTrades: OptionTrade[] }>; allOOSTrades: OptionTrade[] } {
  const results: any[] = [];
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
      const signals = signalSets[msg.signalKey] || [];
      const { results: selectionResults, allOOSTrades } = evaluateOnWindows(msg.config, signals, msg.selectionWindows);
      const { allOOSTrades: holdoutTrades } = evaluateOnWindows(msg.config, signals, msg.holdoutWindows);
      const selectionStart = msg.selectionWindows[0]?.oosStart ?? startDate;
      const selectionEnd = msg.selectionWindows[msg.selectionWindows.length - 1]?.oosEnd ?? endDate;
      const holdoutStart = msg.holdoutWindows[0]?.oosStart ?? startDate;
      const holdoutEnd = msg.holdoutWindows[msg.holdoutWindows.length - 1]?.oosEnd ?? endDate;

      // Compute aggregated metrics inside worker to avoid OOM on transfer
      const oosMetrics = computePortfolioDailyMetrics(
        allOOSTrades, allTradingDates, selectionStart, selectionEnd, startingCapital,
      );
      const grossOOSTrades = projectTradesToGrossPnlView(allOOSTrades);
      const grossOOSMetrics = computePortfolioDailyMetrics(
        grossOOSTrades, allTradingDates, selectionStart, selectionEnd, startingCapital,
      );
      const oosAnalytics = computeOptionAnalytics(allOOSTrades);
      const holdoutMetrics = computePortfolioDailyMetrics(
        holdoutTrades, allTradingDates, holdoutStart, holdoutEnd, startingCapital,
      );
      const grossHoldoutTrades = projectTradesToGrossPnlView(holdoutTrades);
      const grossHoldoutMetrics = computePortfolioDailyMetrics(
        grossHoldoutTrades, allTradingDates, holdoutStart, holdoutEnd, startingCapital,
      );

      const exitTypes: Record<string, number> = {};
      for (const t of allOOSTrades) {
        exitTypes[t.exitType] = (exitTypes[t.exitType] ?? 0) + 1;
      }

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
        oosSharpe: oosMetrics.sharpe,
        oosGrossSharpe: grossOOSMetrics.sharpe,
        oosMaxDD: oosMetrics.maxDrawdownPct,
        oosWinRate: oosAnalytics.winRate,
        oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
        oosGrossTotalPnl: grossOOSTrades.reduce((s, t) => s + t.pnl, 0),
        oosTradeCount: allOOSTrades.length,
        oosExitTypes: exitTypes,
        holdoutSharpe: holdoutMetrics.sharpe,
        holdoutGrossSharpe: grossHoldoutMetrics.sharpe,
        holdoutMaxDD: holdoutMetrics.maxDrawdownPct,
        holdoutTotalPnl: holdoutTrades.reduce((s, t) => s + t.pnl, 0),
        holdoutGrossTotalPnl: grossHoldoutTrades.reduce((s, t) => s + t.pnl, 0),
        holdoutTradeCount: holdoutTrades.length,
      } satisfies WorkResult);
    } catch (err: any) {
      parentPort!.postMessage({
        type: 'result',
        id: msg.id,
        configLabel: msg.configLabel,
        selectionResults: [],
        oosSharpe: 0, oosGrossSharpe: 0, oosMaxDD: 0, oosWinRate: 0, oosTotalPnl: 0, oosGrossTotalPnl: 0,
        oosTradeCount: 0, oosExitTypes: {},
        holdoutSharpe: 0, holdoutGrossSharpe: 0, holdoutMaxDD: 0, holdoutTotalPnl: 0, holdoutGrossTotalPnl: 0, holdoutTradeCount: 0,
        error: err.message,
      } satisfies WorkResult);
    }
  }
});

parentPort!.postMessage({ type: 'ready' });
