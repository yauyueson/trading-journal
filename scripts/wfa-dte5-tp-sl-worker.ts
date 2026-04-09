/**
 * Worker thread for DTE5 TP/SL Study — evaluates a single TP/SL config across all windows.
 * Adapted from wfa-sl-worker.ts for DTE5 specifics:
 *   - DTE [2,7], delta 0.30/0.20, width $10, EMA34 gate
 *   - Daily monitoring (monitoringIntervalDays=1)
 *   - Cache-based chain lookups (findContractDirect)
 *   - Phased TP evaluator for Phase 3
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  initDB, closeDB,
  getCachedChain, findSpreadStrikes, findContractDirect,
} from '../src/lib/backtest/chain-cache';
import type { SpreadMatch } from '../src/lib/backtest/chain-cache';
import {
  computeOptionAnalytics,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionExitType,
} from '../src/lib/backtest/option-sim';
import {
  buildCreditSpreadTrade,
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
  mechanism: string;
  simConfig: SimConfig;
  phasedConfig?: PhasedTPConfig;
  selectionWindows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>;
  holdoutWindows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>;
}

export interface PhasedTPConfig {
  tp1: number;
  tp2: number;
  afterTP1SL: number; // -1 = none, 0 = breakeven, 0.25 = lock 25% profit
}

interface WindowResult {
  windowIdx: number;
  trainSharpe: number;
  oosSharpe: number;
  oosWR: number;
  oosMaxDD: number;
  oosTradeCount: number;
}

interface WorkResult {
  type: 'result';
  id: number;
  configLabel: string;
  mechanism: string;
  selectionResults: WindowResult[];
  allOOSTrades: OptionTrade[];
  holdoutTrades: OptionTrade[];
  error?: string;
}

// ── Worker Init ──────────────────────────────────────────

const {
  signals,
  allTradingDates,
  executionConfig,
  startingCapital,
} = workerData as {
  signals: EntrySignal[];
  allTradingDates: string[];
  executionConfig: PortfolioExecutionConfig;
  startingCapital: number;
};

initDB();

// ── Trade Builder ────────────────────────────────────────

function buildDTE5Trade(
  signal: EntrySignal,
  spread: SpreadMatch,
  entryCredit: number,
  exitDate: string,
  exitSpreadCost: number,
  exitDTE: number,
  exitStockPrice: number,
  exitType: OptionExitType,
  dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[],
  exitDelta?: number,
): OptionTrade {
  const actualWidth = resolveActualSpreadWidth(spread);
  const boundedEntryCredit = clampSpreadCloseCost(entryCredit, actualWidth);
  const boundedExitCost = clampSpreadCloseCost(exitSpreadCost, actualWidth);
  const maxLoss = Math.max(0, actualWidth - boundedEntryCredit);
  const pnl = Math.max(
    -maxLoss * 100,
    Math.min((boundedEntryCredit - boundedExitCost) * 100, boundedEntryCredit * 100),
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
    pnlPct: maxLoss > 0 ? pnl / (maxLoss * 100) : 0,
    holdDays: Math.round(
      (new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000,
    ),
    ivRank: signal.ivRank,
    dailyMtM,
    exitDelta,
  } as OptionTrade;
}

// ── DTE5 Evaluator ───────────────────────────────────────

function makeDTE5Evaluator(): TradeEvaluator {
  return (signal, config, allDates, maxDate) => {
    // Entry-level regime filters — skip signals that don't meet vol criteria
    if (config.vrpFilter && config.vrpFilter > 0 && (signal.vrp == null || signal.vrp < config.vrpFilter)) return null;
    if (config.contangoFilter && config.contangoFilter > 0 && (signal.contango == null || signal.contango < config.contangoFilter)) return null;
    if (config.vrpPctFilter && config.vrpPctFilter > 0 && (signal.vrpPct == null || signal.vrpPct < config.vrpPctFilter)) return null;
    if (config.contangoPctFilter && config.contangoPctFilter > 0 && (signal.contangoPct == null || signal.contangoPct < config.contangoPctFilter)) return null;
    if (config.slopeFilter && config.slopeFilter > 0 && (signal.slope == null || signal.slope < config.slopeFilter)) return null;
    if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) return null;

    const entryChain = getCachedChain(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';
    const effectiveDelta = signal.configuredDelta ?? config.creditShortDelta;
    const spread = findSpreadStrikes(
      entryChain, effectiveDelta, config.creditSpreadWidth,
      optionType, config.creditDTERange,
    );
    if (!spread || spread.netCredit <= 0) return null;

    const entryCredit = spread.netCredit;
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
    // Track monitoring day index for first-day-only SL
    let monitorDayIdx = 0;
    // slActiveDays: if set, SL only checked on first N monitoring days (0=always, 1=first day only)
    const slActiveDays = (config as any).slActiveDays as number | undefined;

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
            ? computeIntrinsicSpreadCloseCost(optionType, spread.short.row.strike, spread.long.row.strike, monitoringStockPrice, thresholds.actualWidth)
            : null;
          const exitCost = resolveTriggeredCreditExitCost(
            'NO_CHAIN',
            Math.max(lastValidSpreadCost ?? thresholds.boundedEntryCredit, intrinsicCost ?? thresholds.boundedEntryCredit),
            thresholds,
          );
          return buildDTE5Trade(signal, spread, entryCredit, checkDate, exitCost,
            shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
            monitoringStockPrice ?? spread.short.row.stock_price, 'NO_CHAIN', dailyMtM);
        }
        continue;
      }

      const currentSpreadCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, thresholds.actualWidth);
      const currentDTE = shortLeg.row.dte;
      const currentShortDelta = shortLeg.delta;
      lastValidSpreadCost = currentSpreadCost;
      dailyMtM.push({ date: checkDate, spreadMid: currentSpreadCost, unrealizedPnl: (entryCredit - currentSpreadCost) * 100 });

      // Trailing lock state update
      if (config.trailingActivatePct != null && config.trailingFloorPct != null) {
        const unrealizedProfit = entryCredit - currentSpreadCost;
        const activationProfit = config.trailingActivatePct * thresholds.tpProfit;
        if (!trailingFloorActive && unrealizedProfit >= activationProfit) {
          trailingFloorActive = true;
          trailingFloorCost = clampSpreadCloseCost(
            thresholds.boundedEntryCredit - (config.trailingFloorPct * thresholds.tpProfit),
            thresholds.actualWidth,
          );
        }
      }

      // Determine if SL checks are active on this monitoring day
      const slActiveToday = slActiveDays == null || slActiveDays === 0 || monitorDayIdx < slActiveDays;
      monitorDayIdx++;

      // Exit priority chain
      let exitType: OptionExitType | null = null;
      if (currentSpreadCost <= thresholds.tpCost) exitType = 'PROFIT_TARGET';
      else if (slActiveToday && currentSpreadCost >= thresholds.slCost) exitType = 'STOP_LOSS';
      else if (slActiveToday && currentSpreadCost >= thresholds.maxLossStopCost) exitType = 'MAX_LOSS_STOP';
      else if (slActiveToday && config.creditDeltaStop != null && isFinite(config.creditDeltaStop) &&
               config.creditDeltaStop > 0 && Math.abs(currentShortDelta) >= config.creditDeltaStop) exitType = 'DELTA_STOP';
      else if (trailingFloorActive && currentSpreadCost > trailingFloorCost) exitType = 'TRAILING_LOCK';
      else if (config.creditTimeStopDTE > 0 && currentDTE <= config.creditTimeStopDTE) exitType = 'TIME_STOP';

      if (exitType) {
        // Conservative exit pricing: for SL/MAX_LOSS exits, use the ACTUAL market
        // spread cost (which may have gapped past the threshold), not the threshold.
        // With daily monitoring at DTE 2-7, gamma can move spreads far past SL
        // overnight. You close at market, not at your limit.
        // For TP exits, the threshold is fine (spread cost is below TP → you fill at mid or better).
        let exitCost: number;
        if (exitType === 'STOP_LOSS' || exitType === 'MAX_LOSS_STOP') {
          exitCost = clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth);
        } else {
          exitCost = resolveTriggeredCreditExitCost(exitType, currentSpreadCost, thresholds, { trailingFloorCost });
        }
        return buildDTE5Trade(signal, spread, entryCredit, checkDate, exitCost,
          currentDTE, shortLeg.row.stock_price, exitType, dailyMtM, currentShortDelta);
      }
    }

    // Expiration
    const lastDate = monitorDates[monitorDates.length - 1];
    if (!lastDate) return null;
    const shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    const fallbackChain = (!shortLeg || !longLeg) ? getCachedChain(signal.ticker, lastDate) : [];
    let finalCost: number;
    if (shortLeg && longLeg) {
      finalCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, thresholds.actualWidth);
    } else {
      const stockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price;
      finalCost = computeIntrinsicSpreadCloseCost(optionType, spread.short.row.strike, spread.long.row.strike, stockPrice, thresholds.actualWidth);
    }
    return buildDTE5Trade(signal, spread, entryCredit, lastDate, finalCost,
      shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
      shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price,
      'EXPIRATION', dailyMtM, shortLeg?.delta);
  };
}

// ── Phased TP Evaluator ──────────────────────────────────

function makeDTE5PhasedEvaluator(phasedConfig: PhasedTPConfig): TradeEvaluator {
  return (signal, config, allDates, maxDate) => {
    const entryChain = getCachedChain(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';
    const effectiveDelta = signal.configuredDelta ?? config.creditShortDelta;
    const spread = findSpreadStrikes(
      entryChain, effectiveDelta, config.creditSpreadWidth,
      optionType, config.creditDTERange,
    );
    if (!spread || spread.netCredit <= 0) return null;

    const entryCredit = spread.netCredit;
    const thresholds = computeCreditSpreadThresholds(config, spread, entryCredit);
    const actualWidth = resolveActualSpreadWidth(spread);

    const tp1Cost = clampSpreadCloseCost(thresholds.boundedEntryCredit * (1 - phasedConfig.tp1), actualWidth);
    const tp2Cost = clampSpreadCloseCost(thresholds.boundedEntryCredit * (1 - phasedConfig.tp2), actualWidth);
    const afterTP1SLCost = phasedConfig.afterTP1SL >= 0
      ? clampSpreadCloseCost(thresholds.boundedEntryCredit * (1 - phasedConfig.afterTP1SL), actualWidth)
      : Infinity;

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

    let phase: 'FULL' | 'HALF' = 'FULL';
    let halfPnl = 0;
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
            ? computeIntrinsicSpreadCloseCost(optionType, spread.short.row.strike, spread.long.row.strike, monitoringStockPrice, actualWidth)
            : null;
          const exitCost = Math.max(lastValidSpreadCost ?? thresholds.boundedEntryCredit, intrinsicCost ?? thresholds.boundedEntryCredit);
          const finalPnl = phase === 'HALF'
            ? halfPnl + ((entryCredit - clampSpreadCloseCost(exitCost, actualWidth)) * 100 * 0.5)
            : (entryCredit - clampSpreadCloseCost(exitCost, actualWidth)) * 100;
          const trade = buildDTE5Trade(signal, spread, entryCredit, checkDate, exitCost,
            shortLeg?.row.dte ?? 0, monitoringStockPrice ?? spread.short.row.stock_price, 'NO_CHAIN', dailyMtM);
          (trade as any).pnl = finalPnl;
          return trade;
        }
        continue;
      }

      const currentSpreadCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, actualWidth);
      const currentDTE = shortLeg.row.dte;
      lastValidSpreadCost = currentSpreadCost;
      const totalUnrealizedPnl = phase === 'HALF'
        ? halfPnl + ((entryCredit - currentSpreadCost) * 100 * 0.5)
        : (entryCredit - currentSpreadCost) * 100;
      dailyMtM.push({ date: checkDate, spreadMid: currentSpreadCost, unrealizedPnl: totalUnrealizedPnl });

      if (phase === 'FULL') {
        // Check TP1
        if (currentSpreadCost <= tp1Cost) {
          halfPnl = (entryCredit - tp1Cost) * 100 * 0.5;
          phase = 'HALF';
          continue; // Proceed to monitor remaining half
        }
        // Check SL on full position — use actual market cost (conservative)
        if (currentSpreadCost >= thresholds.slCost) {
          return buildDTE5Trade(signal, spread, entryCredit, checkDate,
            clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth),
            currentDTE, shortLeg.row.stock_price, 'STOP_LOSS', dailyMtM, shortLeg.delta);
        }
        if (currentSpreadCost >= thresholds.maxLossStopCost) {
          return buildDTE5Trade(signal, spread, entryCredit, checkDate,
            clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth),
            currentDTE, shortLeg.row.stock_price, 'MAX_LOSS_STOP', dailyMtM, shortLeg.delta);
        }
        if (config.creditDeltaStop != null && isFinite(config.creditDeltaStop) &&
            config.creditDeltaStop > 0 && Math.abs(shortLeg.delta) >= config.creditDeltaStop) {
          return buildDTE5Trade(signal, spread, entryCredit, checkDate, currentSpreadCost,
            currentDTE, shortLeg.row.stock_price, 'DELTA_STOP', dailyMtM, shortLeg.delta);
        }
      } else {
        // HALF position — check TP2 or post-TP1 SL
        if (currentSpreadCost <= tp2Cost) {
          const secondHalfPnl = (entryCredit - tp2Cost) * 100 * 0.5;
          const totalPnl = halfPnl + secondHalfPnl;
          const trade = buildDTE5Trade(signal, spread, entryCredit, checkDate, tp2Cost,
            currentDTE, shortLeg.row.stock_price, 'PROFIT_TARGET_2', dailyMtM, shortLeg.delta);
          (trade as any).pnl = totalPnl;
          return trade;
        }
        if (phasedConfig.afterTP1SL >= 0 && currentSpreadCost >= afterTP1SLCost) {
          const secondHalfPnl = (entryCredit - clampSpreadCloseCost(afterTP1SLCost, actualWidth)) * 100 * 0.5;
          const totalPnl = halfPnl + secondHalfPnl;
          const trade = buildDTE5Trade(signal, spread, entryCredit, checkDate, afterTP1SLCost,
            currentDTE, shortLeg.row.stock_price, 'SL_BREAKEVEN', dailyMtM, shortLeg.delta);
          (trade as any).pnl = totalPnl;
          return trade;
        }
      }
    }

    // Expiration
    const lastDate = monitorDates[monitorDates.length - 1];
    if (!lastDate) return null;
    const shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    const fallbackChain = (!shortLeg || !longLeg) ? getCachedChain(signal.ticker, lastDate) : [];
    let finalCost: number;
    if (shortLeg && longLeg) {
      finalCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, actualWidth);
    } else {
      const stockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price;
      finalCost = computeIntrinsicSpreadCloseCost(optionType, spread.short.row.strike, spread.long.row.strike, stockPrice, actualWidth);
    }
    if (phase === 'HALF') {
      const secondHalfPnl = (entryCredit - finalCost) * 100 * 0.5;
      const totalPnl = halfPnl + secondHalfPnl;
      const trade = buildDTE5Trade(signal, spread, entryCredit, lastDate, finalCost,
        shortLeg?.row.dte ?? 0,
        shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price,
        'EXPIRATION', dailyMtM, shortLeg?.delta);
      (trade as any).pnl = totalPnl;
      return trade;
    }
    return buildDTE5Trade(signal, spread, entryCredit, lastDate, finalCost,
      shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
      shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price,
      'EXPIRATION', dailyMtM, shortLeg?.delta);
  };
}

// ── Evaluate Config on Windows ───────────────────────────

function evaluateOnWindows(
  config: SimConfig,
  windows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>,
  evaluator: TradeEvaluator,
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
      const evaluator = msg.phasedConfig
        ? makeDTE5PhasedEvaluator(msg.phasedConfig)
        : makeDTE5Evaluator();

      const { results: selectionResults, allOOSTrades } = evaluateOnWindows(msg.simConfig, msg.selectionWindows, evaluator);
      const { allOOSTrades: holdoutTrades } = evaluateOnWindows(msg.simConfig, msg.holdoutWindows, evaluator);

      parentPort!.postMessage({
        type: 'result',
        id: msg.id,
        configLabel: msg.configLabel,
        mechanism: msg.mechanism,
        selectionResults,
        allOOSTrades,
        holdoutTrades,
      } satisfies WorkResult);
    } catch (err: any) {
      parentPort!.postMessage({
        type: 'result',
        id: msg.id,
        configLabel: msg.configLabel,
        mechanism: msg.mechanism,
        selectionResults: [],
        allOOSTrades: [],
        holdoutTrades: [],
        error: err.message,
      } satisfies WorkResult);
    }
  }
});

parentPort!.postMessage({ type: 'ready' });
