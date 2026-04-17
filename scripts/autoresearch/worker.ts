/**
 * Autoresearch Worker — evaluates a strategy's signals across WFA windows.
 *
 * Supports two evaluator modes:
 * - 'standard': dispatches to simulateCreditSpread / simulateLeap based on config.mode
 * - 'custom': uses a strategy-provided evaluator function (not yet wired — requires
 *   serialization of custom evaluator, which is handled by bundling strategy.ts into the worker)
 *
 * Adapted from wfa-dte5-tp-sl-worker.ts but strategy-agnostic.
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  initDB, closeDB,
  getCachedChain, getCachedChainFiltered,
  findSpreadStrikes, findStrikeByDelta, findContractDirect,
  findContract,
} from '../../src/lib/backtest/chain-cache';
import type { SpreadMatch, StrikeMatch } from '../../src/lib/backtest/chain-cache';
import {
  simulateLeap, simulateCreditSpread,
  computeOptionAnalytics,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionExitType,
} from '../../src/lib/backtest/option-sim';
import {
  evaluateConfiguredSignalsWithConstraints,
  evaluateConfiguredSignalsWithState,
  createConstraintState,
  computePortfolioDailyMetrics,
  type PortfolioExecutionConfig,
  type PortfolioConstraintState,
  type TradeEvaluator,
  type ConfiguredSignal,
} from '../../src/lib/backtest/wfa-options';
import type {
  WorkerInitData, WorkItem, WorkResult, WindowResult, WindowDef, ChainLookup,
} from './types';

// ── Worker Init ──────────────────────────────────────────

const {
  signals,
  allTradingDates,
  executionConfig,
  startingCapital,
  evaluatorMode,
} = workerData as WorkerInitData;

initDB(undefined, /* readonly= */ true);

// ── Chain Lookup for Custom Evaluators ───────────────────

const chainLookup: ChainLookup = {
  getCachedChain,
  getCachedChainFiltered,
  findStrikeByDelta,
  findSpreadStrikes,
  findContractDirect,
};

// ── Standard Evaluator Factory ──────────────────────────

/**
 * Build a TradeEvaluator that dispatches to the appropriate simulator
 * based on config.mode. This covers CREDIT_SPREAD, LEAP, and
 * SWING_LONG_OPTION via the existing engine.
 *
 * Uses synchronous chain-cache lookups (getCachedChain, findContractDirect)
 * so it works as a synchronous TradeEvaluator.
 */
function makeStandardEvaluator(config: SimConfig): TradeEvaluator {
  // For CREDIT_SPREAD, build a synchronous evaluator similar to DTE5
  if (config.mode === 'CREDIT_SPREAD') {
    return makeCreditSpreadEvaluator(config);
  }

  // For LEAP and SWING_LONG_OPTION, use the async simulators
  // wrapped in a sync shim (the chain data is pre-cached, so
  // fetchHistoricalChain returns immediately from SQLite)
  if (config.mode === 'LEAP') {
    return makeLeapEvaluator(config);
  }

  // Fallback: null (no trade)
  return () => null;
}

// ── Credit Spread Evaluator ─────────────────────────────

import {
  clampSpreadCloseCost,
  computeCreditSpreadThresholds,
  computeIntrinsicSpreadCloseCost,
  createMissingChainState,
  resolveActualSpreadWidth,
  resolveTriggeredCreditExitCost,
  shouldExitNoChain,
  updateMissingChainState,
} from '../../src/lib/backtest/credit-spread-exit';

function makeCreditSpreadEvaluator(config: SimConfig): TradeEvaluator {
  return (signal, _config, allDates, maxDate) => {
    // Entry-level regime filters
    if (config.vrpFilter && config.vrpFilter > 0 && (signal.vrp == null || signal.vrp < config.vrpFilter)) return null;
    if (config.contangoFilter && config.contangoFilter > 0 && (signal.contango == null || signal.contango < config.contangoFilter)) return null;
    if (config.vrpPctFilter && config.vrpPctFilter > 0 && (signal.vrpPct == null || signal.vrpPct < config.vrpPctFilter)) return null;
    if (config.contangoPctFilter && config.contangoPctFilter > 0 && (signal.contangoPct == null || signal.contangoPct < config.contangoPctFilter)) return null;
    if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) return null;

    const entryChain = getCachedChain(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';
    const effectiveDelta = signal.configuredDelta ?? config.creditShortDelta;
    const effectiveLongDelta = signal.configuredLongDelta;
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
          return buildTrade(signal, spread, entryCredit, checkDate, exitCost,
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

      // Trailing lock
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

      // Exit priority chain
      let exitType: OptionExitType | null = null;
      if (currentSpreadCost <= thresholds.tpCost) exitType = 'PROFIT_TARGET';
      else if (currentSpreadCost >= thresholds.slCost) exitType = 'STOP_LOSS';
      else if (currentSpreadCost >= thresholds.maxLossStopCost) exitType = 'MAX_LOSS_STOP';
      else if (config.creditDeltaStop != null && isFinite(config.creditDeltaStop) &&
               config.creditDeltaStop > 0 && Math.abs(currentShortDelta) >= config.creditDeltaStop) exitType = 'DELTA_STOP';
      else if (trailingFloorActive && currentSpreadCost > trailingFloorCost) exitType = 'TRAILING_LOCK';
      else if (config.creditTimeStopDTE > 0 && currentDTE <= config.creditTimeStopDTE) exitType = 'TIME_STOP';

      if (exitType) {
        let exitCost: number;
        if (exitType === 'STOP_LOSS' || exitType === 'MAX_LOSS_STOP') {
          exitCost = clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth);
        } else {
          exitCost = resolveTriggeredCreditExitCost(exitType, currentSpreadCost, thresholds, { trailingFloorCost });
        }
        return buildTrade(signal, spread, entryCredit, checkDate, exitCost,
          currentDTE, shortLeg.row.stock_price, exitType, dailyMtM, currentShortDelta);
      }
    }

    // Expiration / forced close at evaluation horizon
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
    const endExitType: OptionExitType = maxDate < spread.short.row.expir_date ? 'FORCE_CLOSE' : 'EXPIRATION';
    return buildTrade(signal, spread, entryCredit, lastDate, finalCost,
      shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
      shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price,
      endExitType, dailyMtM, shortLeg?.delta);
  };
}

function buildTrade(
  signal: EntrySignal, spread: SpreadMatch, entryCredit: number,
  exitDate: string, exitSpreadCost: number, exitDTE: number,
  exitStockPrice: number, exitType: OptionExitType,
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
    holdDays: Math.round((new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000),
    ivRank: signal.ivRank,
    dailyMtM,
    exitDelta,
  } as OptionTrade;
}

// ── LEAP Evaluator ──────────────────────────────────────

function makeLeapEvaluator(config: SimConfig): TradeEvaluator {
  return (signal, _config, allDates, maxDate) => {
    // IV rank filter (want low IV for buying options)
    if (config.maxIVRank != null && signal.ivRank != null && signal.ivRank > config.maxIVRank) return null;

    const entryChain = getCachedChain(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Call' : 'Put';
    const targetDelta = (config.leapDeltaRange[0] + config.leapDeltaRange[1]) / 2;
    const entry = findStrikeByDelta(entryChain, targetDelta, optionType, config.leapDTERange);
    if (!entry || entry.mid <= 0) return null;

    // Realistic fill: buyer pays ask (or mid + half-spread as conservative estimate)
    // Deep ITM LEAPs are illiquid — mid fills overstate performance
    const halfSpread = (entry.ask > 0 && entry.bid > 0) ? (entry.ask - entry.bid) / 2 : entry.mid * 0.01;
    const entryPrice = entry.mid + halfSpread; // pay above mid (buyer's cost)
    const tpPrice = entryPrice * (1 + config.leapProfitTarget);
    const slPrice = entryPrice * (1 - config.leapStopLoss);

    const monitorEnd = entry.row.expir_date < maxDate ? entry.row.expir_date : maxDate;
    const forcedClose = maxDate < entry.row.expir_date;
    const startIdx = allDates.indexOf(signal.date);
    if (startIdx < 0) return null;

    const monitorDates: string[] = [];
    const interval = config.monitoringIntervalDays || 1;
    let dayCount = 0;
    for (let i = startIdx + 1; i < allDates.length; i++) {
      if (allDates[i] > monitorEnd) break;
      dayCount++;
      if (dayCount % interval === 0) monitorDates.push(allDates[i]);
    }

    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

    // Trailing lock state for LEAP
    // Activate when gain >= trailingActivatePct * (entryPrice * leapProfitTarget)
    // Floor: trail peak, exit if price drops trailingFloorPct below peak
    const trailActivatePct = config.trailingActivatePct ?? null;
    const trailFloorPct = config.trailingFloorPct ?? null;
    let trailActive = false;
    let trailPeak = 0;
    let trailFloor = 0;
    const trailActivatePrice = (trailActivatePct != null)
      ? entryPrice + entryPrice * config.leapProfitTarget * trailActivatePct
      : Infinity;

    const missingExitAfter = config.missingChainExitAfterDays ?? Number.POSITIVE_INFINITY;
    let missingStreak = 0;
    let lastKnownExitPrice: number | null = null;
    for (const checkDate of monitorDates) {
      // O(1) direct PK lookup — critical for daily monitoring on long-dated options
      const current = findContractDirect(signal.ticker, checkDate, entry.row.strike, entry.row.expir_date, optionType);
      if (!current || current.mid <= 0) {
        missingStreak++;
        if (missingExitAfter !== Infinity && missingExitAfter > 0 && missingStreak >= missingExitAfter) {
          // Best-effort forced exit when the chain is missing for too long.
          // Prefer the last known executable exit price; otherwise use intrinsic.
          let exitPrice: number;
          if (lastKnownExitPrice != null) {
            exitPrice = lastKnownExitPrice;
          } else {
            const fallbackChain = getCachedChain(signal.ticker, checkDate);
            const lastStock = fallbackChain.length > 0 ? fallbackChain[0].stock_price : entry.row.stock_price;
            exitPrice = optionType === 'Call'
              ? Math.max(0, lastStock - entry.row.strike)
              : Math.max(0, entry.row.strike - lastStock);
          }
          return buildLeapTrade(signal, entry, optionType, entryPrice, checkDate, exitPrice,
            0, entry.row.stock_price, 'NO_CHAIN', dailyMtM);
        }
        continue;
      }
      missingStreak = 0;

      // Mark-to-market at mid (fair value), but exit fills at bid (seller's cost)
      const currentMid = current.mid;
      const currentDTE = current.row.dte;
      // Use mid for MtM tracking (fair value for portfolio metrics)
      dailyMtM.push({ date: checkDate, spreadMid: currentMid, unrealizedPnl: (currentMid - entryPrice) * 100 });
      // Exit price accounts for spread: seller receives below mid
      const exitHalfSpread = (current.ask > 0 && current.bid > 0) ? (current.ask - current.bid) / 2 : currentMid * 0.01;
      const currentExitPrice = currentMid - exitHalfSpread;
      lastKnownExitPrice = currentExitPrice;

      // Update trailing lock state
      if (trailActivatePct != null && trailFloorPct != null) {
        if (!trailActive && currentExitPrice >= trailActivatePrice) {
          trailActive = true;
          trailPeak = currentExitPrice;
          trailFloor = currentExitPrice * (1 - trailFloorPct);
        }
        if (trailActive) {
          if (currentExitPrice > trailPeak) {
            trailPeak = currentExitPrice;
            trailFloor = currentExitPrice * (1 - trailFloorPct);
          }
        }
      }

      let exitType: OptionExitType | null = null;
      if (trailActive && currentExitPrice < trailFloor) exitType = 'TRAILING_LOCK';
      else if (currentExitPrice >= tpPrice) exitType = 'PROFIT_TARGET';
      else if (currentExitPrice <= slPrice) exitType = 'STOP_LOSS';
      else if (config.signalInvalidation && signal.invalidation) {
        const inv = signal.invalidation;
        const grace = config.signalInvalidation.graceDays ?? 0;
        const typ = config.signalInvalidation.type;
        let invalidDate: string | undefined;
        if (typ === 'macro') invalidDate = grace >= 3 ? inv.macro3dBreakDate : inv.macroBreakDate;
        else if (typ === 'trend') invalidDate = grace >= 3 ? inv.trend3dBreakDate : inv.trendBreakDate;
        else if (typ === 'momentum') invalidDate = grace >= 3 ? inv.momentum3dBreakDate : inv.momentumBreakDate;
        else if (typ === 'any') {
          const dates = [
            grace >= 3 ? inv.macro3dBreakDate : inv.macroBreakDate,
            grace >= 3 ? inv.trend3dBreakDate : inv.trendBreakDate,
            grace >= 3 ? inv.momentum3dBreakDate : inv.momentumBreakDate,
          ].filter(Boolean) as string[];
          invalidDate = dates.length > 0 ? dates.sort()[0] : undefined;
        }
        if (invalidDate && checkDate >= invalidDate) exitType = 'SIGNAL_REVERSAL';
      }
      if (!exitType && currentDTE <= config.leapTimeStopDTE) exitType = 'TIME_STOP';

      if (exitType) {
        return buildLeapTrade(signal, entry, optionType, entryPrice, checkDate, currentExitPrice, currentDTE,
          current.row.stock_price, exitType, dailyMtM);
      }
    }

    // Close at last monitoring date (expiry or evaluation horizon)
    const lastDate = monitorDates[monitorDates.length - 1];
    if (!lastDate) return null;
    const current = findContractDirect(signal.ticker, lastDate, entry.row.strike, entry.row.expir_date, optionType);
    let exitPrice: number;
    if (current) {
      // Seller receives bid side
      const hs = (current.ask > 0 && current.bid > 0) ? (current.ask - current.bid) / 2 : current.mid * 0.01;
      exitPrice = current.mid - hs;
    } else {
      // Fallback to intrinsic value
      const fallbackChain = getCachedChain(signal.ticker, lastDate);
      const lastStock = fallbackChain.length > 0 ? fallbackChain[0].stock_price : entry.row.stock_price;
      exitPrice = optionType === 'Call'
        ? Math.max(0, lastStock - entry.row.strike)
        : Math.max(0, entry.row.strike - lastStock);
    }
    const endExitType: OptionExitType = forcedClose ? 'FORCE_CLOSE' : 'EXPIRATION';
    return buildLeapTrade(signal, entry, optionType, entryPrice, lastDate, exitPrice,
      current?.row.dte ?? 0, current?.row.stock_price ?? entry.row.stock_price, endExitType, dailyMtM);
  };
}

function buildLeapTrade(
  signal: EntrySignal, entry: StrikeMatch, optionType: 'Call' | 'Put',
  entryPrice: number, exitDate: string, exitPrice: number,
  exitDTE: number, exitStockPrice: number, exitType: OptionExitType,
  dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[],
): OptionTrade {
  const pnl = (exitPrice - entryPrice) * 100;
  return {
    ticker: signal.ticker,
    mode: 'LEAP',
    direction: signal.direction,
    entryDate: signal.date,
    entrySignalScore: signal.score,
    strike: entry.row.strike,
    expiry: entry.row.expir_date,
    entryDTE: entry.row.dte,
    entryPrice,
    entryDelta: entry.delta,
    entryIV: entry.iv,
    entryStockPrice: entry.row.stock_price,
    exitDate,
    exitPrice,
    exitDTE,
    exitStockPrice,
    exitType,
    pnl,
    pnlPct: entryPrice > 0 ? pnl / (entryPrice * 100) : 0,
    holdDays: Math.round((new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000),
    ivRank: signal.ivRank,
    dailyMtM,
  } as OptionTrade;
}

// ── Evaluate Config on Windows ──────────────────────────

function evaluateOnWindows(
  config: SimConfig,
  windows: WindowDef[],
  evaluator: TradeEvaluator,
  putConfig?: SimConfig,
  putEvaluator?: TradeEvaluator,
): { results: WindowResult[]; allOOSTrades: OptionTrade[] } {
  const results: WindowResult[] = [];
  const allOOSTrades: OptionTrade[] = [];

  // Helper: pick config/evaluator based on signal direction
  const configFor  = (s: EntrySignal) => (s.direction === 'PUT' && putConfig)  ? putConfig  : config;
  const evalFor    = (s: EntrySignal) => (s.direction === 'PUT' && putEvaluator) ? putEvaluator : evaluator;

  // Determine the final maxDate for OOS — positions can live until the last window ends.
  // This prevents truncating 180-270 DTE LEAPs at window boundaries.
  const oosMaxDate = windows.length > 0
    ? windows[windows.length - 1].oosEnd
    : allTradingDates[allTradingDates.length - 1];

  // Carry portfolio state across OOS windows so positions survive boundaries.
  let oosState: PortfolioConstraintState = createConstraintState();

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];

    // Training: independent per window (no carry — correct for optimization)
    const trainSigs = signals.filter(s => s.date >= w.trainStart && s.date <= w.trainEnd);
    const trainConfigured: ConfiguredSignal[] = trainSigs.map(s => ({ signal: s, config: configFor(s) }));
    const trainEvaluatorMixed = trainConfigured.length > 0 && putConfig
      ? (sig: EntrySignal, cfg: SimConfig, dates: string[], maxDate: string, lookup: ChainLookup) =>
          evalFor(sig)(sig, cfg, dates, maxDate, lookup)
      : evaluator;
    const trainTrades = evaluateConfiguredSignalsWithConstraints(
      trainConfigured, executionConfig, allTradingDates, w.trainEnd, trainEvaluatorMixed,
    );
    const trainMetrics = computePortfolioDailyMetrics(
      trainTrades, allTradingDates, w.trainStart, w.trainEnd, startingCapital,
    );

    // OOS: carry state across windows, maxDate = final window end
    const oosSigs = signals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const oosConfigured: ConfiguredSignal[] = oosSigs.map(s => ({ signal: s, config: configFor(s) }));
    const oosEvaluatorMixed = oosConfigured.length > 0 && putConfig
      ? (sig: EntrySignal, cfg: SimConfig, dates: string[], maxDate: string, lookup: ChainLookup) =>
          evalFor(sig)(sig, cfg, dates, maxDate, lookup)
      : evaluator;
    const oosExecution = evaluateConfiguredSignalsWithState(
      oosConfigured, executionConfig, allTradingDates, oosMaxDate, oosEvaluatorMixed, oosState,
    );
    const oosTrades = oosExecution.trades;
    oosState = oosExecution.state;

    // Per-window OOS metrics should include carried positions (MtM) from prior windows.
    const cumulativeTrades = allOOSTrades.concat(oosTrades);
    const oosMetrics = computePortfolioDailyMetrics(
      cumulativeTrades, allTradingDates, w.oosStart, w.oosEnd, startingCapital,
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

// ── Message Handler ─────────────────────────────────────

parentPort!.on('message', (msg: WorkItem | { type: 'exit' }) => {
  if (msg.type === 'exit') {
    closeDB();
    process.exit(0);
  }

  if (msg.type === 'eval') {
    try {
      const evaluator = makeStandardEvaluator(msg.simConfig);
      const putEvaluator = msg.putSimConfig ? makeStandardEvaluator(msg.putSimConfig) : undefined;
      // Evaluate selection + holdout in a single pass so portfolio carry state
      // and the OOS maxDate span the entire selection/holdout range. Splitting
      // the call resets carry at the boundary and truncates dailyMtM at the
      // last selection window end, dropping any selection-entered trade's
      // in-holdout P&L (e.g. a 180-270 DTE LEAP opened late in selection).
      const combinedWindows = [...msg.selectionWindows, ...msg.holdoutWindows];
      const { results: allResults, allOOSTrades: allTrades } = evaluateOnWindows(
        msg.simConfig, combinedWindows, evaluator, msg.putSimConfig, putEvaluator,
      );
      const selectionResults = allResults.slice(0, msg.selectionWindows.length);
      const firstHoldoutStart = msg.holdoutWindows[0]?.oosStart;
      const allOOSTrades  = firstHoldoutStart ? allTrades.filter(t => t.entryDate <  firstHoldoutStart) : allTrades;
      const holdoutTrades = firstHoldoutStart ? allTrades.filter(t => t.entryDate >= firstHoldoutStart) : [];

      parentPort!.postMessage({
        type: 'result',
        id: msg.id,
        selectionResults,
        allOOSTrades,
        holdoutTrades,
      } satisfies WorkResult);
    } catch (err: any) {
      parentPort!.postMessage({
        type: 'result',
        id: msg.id,
        selectionResults: [],
        allOOSTrades: [],
        holdoutTrades: [],
        error: err.message,
      } satisfies WorkResult);
    }
  }
});

parentPort!.postMessage({ type: 'ready' });
