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
import { applyFill } from '../../src/lib/backtest/slippage';
import {
  buildLeapTrade,
  checkLeapExitType,
  computeIntrinsicValue,
  computeLeapEntryPrice,
  computeLeapExitPrice,
  computeLeapThresholds,
  createLeapMissingChainState,
  createLeapTrailState,
  incrementLeapMissingChain,
  resetLeapMissingChain,
  updateLeapTrailState,
} from '../../src/lib/backtest/leap-exit';
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

  // BUY_WRITE is a benchmark-replication mode (Phase 0.c.9 BXM) and is
  // not supposed to be swept through autoresearch. Fail loud rather than
  // silently emit zero trades.
  if (config.mode === 'BUY_WRITE') {
    throw new Error(
      "BUY_WRITE requires simulateBuyWrite — not dispatchable via autoresearch worker. " +
      "Call simulateBuyWrite directly from the CBOE replication script.",
    );
  }

  if (config.mode === 'DIAGONAL') {
    return makeDiagonalEvaluator(config);
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
    // IV-rank gate (matches option-sim.simulateLeap)
    if (config.maxIVRank != null && signal.ivRank != null && signal.ivRank > config.maxIVRank) return null;

    const entryChain = getCachedChain(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Call' : 'Put';
    const targetDelta = (config.leapDeltaRange[0] + config.leapDeltaRange[1]) / 2;
    const entry = findStrikeByDelta(entryChain, targetDelta, optionType, config.leapDTERange);
    if (!entry || entry.mid <= 0) return null;

    // Entry pricing (shared helper — honors config.fillMode + dynamic slippage)
    const { entryPrice, entrySlippage } = computeLeapEntryPrice(entry, config);
    const thresholds = computeLeapThresholds(entryPrice, config);

    const monitorEnd = entry.row.expir_date < maxDate ? entry.row.expir_date : maxDate;
    const forcedClose = maxDate < entry.row.expir_date;
    const startIdx = allDates.indexOf(signal.date);
    if (startIdx < 0) return null;

    const monitorDates: string[] = [];
    const interval = config.monitoringIntervalDays || 1;
    if (interval !== 1) {
      throw new Error(
        `makeDiagonalEvaluator currently only supports monitoringIntervalDays=1 (got ${interval}). ` +
        `The sync evaluator's inline date loop diverges from the async simulateDiagonal's getMonitoringDates ` +
        `for interval > 1. Unify via shared helper before enabling longer intervals.`
      );
    }
    let dayCount = 0;
    for (let i = startIdx + 1; i < allDates.length; i++) {
      if (allDates[i] > monitorEnd) break;
      dayCount++;
      if (dayCount % interval === 0) monitorDates.push(allDates[i]);
    }

    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
    let trail = createLeapTrailState();
    let missing = createLeapMissingChainState();

    for (const checkDate of monitorDates) {
      const current = findContractDirect(signal.ticker, checkDate, entry.row.strike, entry.row.expir_date, optionType);
      if (!current || current.mid <= 0) {
        const step = incrementLeapMissingChain(missing, config);
        missing = step.state;
        if (step.forceExitNow) {
          let exitPrice: number;
          if (missing.lastKnownExitPrice != null) {
            exitPrice = missing.lastKnownExitPrice;
          } else {
            const fallbackChain = getCachedChain(signal.ticker, checkDate);
            const lastStock = fallbackChain.length > 0 ? fallbackChain[0].stock_price : entry.row.stock_price;
            exitPrice = computeIntrinsicValue(lastStock, entry.row.strike, optionType);
          }
          return buildLeapTrade(
            signal, entry, entryPrice, checkDate, exitPrice,
            0, entry.row.stock_price, 'NO_CHAIN', dailyMtM,
            { entrySlippage, exitSlippage: 0, fillMode: config.fillMode },
          );
        }
        continue;
      }

      // MtM at fair value (mid). Exit pricing (below) applies slippage.
      dailyMtM.push({ date: checkDate, spreadMid: current.mid, unrealizedPnl: (current.mid - entryPrice) * 100 });

      const { exitPrice: currentExitPrice, exitSlippage } = computeLeapExitPrice(current, config);
      missing = resetLeapMissingChain(currentExitPrice);

      trail = updateLeapTrailState(trail, currentExitPrice, thresholds);

      const exitType = checkLeapExitType(
        currentExitPrice, thresholds, current.row.dte, trail, signal, config, checkDate,
      );
      if (exitType) {
        return buildLeapTrade(
          signal, entry, entryPrice, checkDate, currentExitPrice,
          current.row.dte, current.row.stock_price, exitType, dailyMtM,
          { entrySlippage, exitSlippage, fillMode: config.fillMode },
        );
      }
    }

    // Close at last monitoring date
    const lastDate = monitorDates[monitorDates.length - 1];
    if (!lastDate) return null;
    const lastCurrent = findContractDirect(signal.ticker, lastDate, entry.row.strike, entry.row.expir_date, optionType);
    let exitPrice: number;
    let exitSlippage = 0;
    if (lastCurrent) {
      const pricing = computeLeapExitPrice(lastCurrent, config);
      exitPrice = pricing.exitPrice;
      exitSlippage = pricing.exitSlippage;
    } else {
      const fallbackChain = getCachedChain(signal.ticker, lastDate);
      const lastStock = fallbackChain.length > 0 ? fallbackChain[0].stock_price : entry.row.stock_price;
      exitPrice = computeIntrinsicValue(lastStock, entry.row.strike, optionType);
    }
    const endExitType: OptionExitType = forcedClose ? 'FORCE_CLOSE' : 'EXPIRATION';
    return buildLeapTrade(
      signal, entry, entryPrice, lastDate, exitPrice,
      lastCurrent?.row.dte ?? 0, lastCurrent?.row.stock_price ?? entry.row.stock_price,
      endExitType, dailyMtM,
      { entrySlippage, exitSlippage, fillMode: config.fillMode },
    );
  };
}

// ── Diagonal (PMCC) Evaluator ────────────────────────────
//
// Synchronous mirror of simulateDiagonal (option-sim.ts). Uses chain-cache
// directly so it satisfies the synchronous TradeEvaluator contract.
// Known duplication: intentional, same pattern as makeLeapEvaluator.

function makeDiagonalEvaluator(config: SimConfig): TradeEvaluator {
  return (signal, _config, allDates, maxDate) => {
    // Validate config
    if (!config.diagLongDeltaRange || !config.diagLongDTERange
        || !config.diagShortDeltaRange || !config.diagShortDTERange
        || config.diagLongProfitTarget == null || config.diagLongStopLoss == null
        || config.diagLongTimeStopDTE == null || config.diagShortProfitTarget == null
        || config.diagRollTriggerMoneyness == null) {
      throw new Error('makeDiagonalEvaluator requires all diag* config fields');
    }

    // Entry: pick long + short from cached chain
    const entryChain = getCachedChain(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const longMidDelta = (config.diagLongDeltaRange[0] + config.diagLongDeltaRange[1]) / 2;
    const longMatch = findStrikeByDelta(entryChain, longMidDelta, 'Call', config.diagLongDTERange, 0);
    if (!longMatch) return null;

    const shortMidDelta = (config.diagShortDeltaRange[0] + config.diagShortDeltaRange[1]) / 2;
    const shortMatch = findStrikeByDelta(entryChain, shortMidDelta, 'Call', config.diagShortDTERange, 0);
    if (!shortMatch || shortMatch.row.strike <= longMatch.row.strike) return null;

    const longRow = longMatch.row;
    const shortRow = shortMatch.row;
    const entryStockPrice = longRow.stock_price;

    // Mirror simulateDiagonal's entry fills
    const longPremium = applyFill(
      config.fillMode, longRow.call_mid, longRow.call_bid, longRow.call_ask,
      'buy', config.slippage, longRow.call_oi, longRow.dte,
    ).fillPrice;
    const shortCredit = applyFill(
      config.fillMode, shortRow.call_mid, shortRow.call_bid, shortRow.call_ask,
      'sell', config.slippage, shortRow.call_oi, shortRow.dte,
    ).fillPrice;

    if (!Number.isFinite(longPremium) || longPremium <= 0) return null;
    if (!Number.isFinite(shortCredit) || shortCredit <= 0) return null;

    const longExpiry = longRow.expir_date;
    const longStrike = longRow.strike;

    // Active short cycle state + closed cycles list
    type ShortCycle = NonNullable<OptionTrade['diagonalLegs']>['shortCallCycles'][number];
    const shortCycles: ShortCycle[] = [];
    let curShort: {
      strike: number; expiry: string; entryDate: string; entryDTE: number;
      entryCredit: number; entryDelta: number;
      dailyMtM: { date: string; premium: number; pnl: number }[];
    } | null = {
      strike: shortRow.strike, expiry: shortRow.expir_date, entryDate: signal.date,
      entryDTE: shortRow.dte, entryCredit: shortCredit, entryDelta: shortRow.delta ?? shortMidDelta,
      dailyMtM: [],
    };

    const longDailyMtM: { date: string; premium: number; pnl: number }[] = [];

    // Monitoring loop
    const monitorCap = longExpiry < maxDate ? longExpiry : maxDate;
    const startIdx = allDates.indexOf(signal.date);
    if (startIdx < 0) return null;

    const monitorDates: string[] = [];
    const interval = config.monitoringIntervalDays || 1;
    if (interval !== 1) {
      throw new Error(
        `makeDiagonalEvaluator currently only supports monitoringIntervalDays=1 (got ${interval}). ` +
        `The sync evaluator's inline date loop diverges from the async simulateDiagonal's getMonitoringDates ` +
        `for interval > 1. Unify via shared helper before enabling longer intervals.`
      );
    }
    let dayCount = 0;
    for (let i = startIdx + 1; i < allDates.length; i++) {
      if (allDates[i] > monitorCap) break;
      dayCount++;
      if (dayCount % interval === 0) monitorDates.push(allDates[i]);
    }

    let longExitReason: OptionExitType = 'TIME_STOP';
    let longExitDate = monitorCap;
    let longExitPremium = longPremium;
    let longExitDTE = 0;
    let lastSpot = entryStockPrice;
    let stop = false;

    for (const d of monitorDates) {
      if (stop) break;

      // Mark long leg
      const longContract = findContractDirect(signal.ticker, d, longStrike, longExpiry, 'Call');
      if (longContract) {
        const longMid = longContract.mid;
        const longPnl = 100 * (longMid - longPremium);
        longDailyMtM.push({ date: d, premium: longMid, pnl: longPnl });
        longExitPremium = longMid;
        longExitDTE = longContract.row.dte;
        lastSpot = longContract.row.stock_price;

        const longRet = (longMid - longPremium) / longPremium;
        if (longRet >= config.diagLongProfitTarget) { longExitReason = 'PROFIT_TARGET'; longExitDate = d; stop = true; }
        else if (longRet <= -config.diagLongStopLoss) { longExitReason = 'STOP_LOSS'; longExitDate = d; stop = true; }
        else if (longContract.row.dte <= config.diagLongTimeStopDTE) { longExitReason = 'TIME_STOP'; longExitDate = d; stop = true; }
      }

      // Mark + close short cycle
      if (curShort) {
        const shortContract = findContractDirect(signal.ticker, d, curShort.strike, curShort.expiry, 'Call');
        if (shortContract) {
          const shortMid = shortContract.mid;
          const shortPnl = 100 * (curShort.entryCredit - shortMid);
          curShort.dailyMtM.push({ date: d, premium: shortMid, pnl: shortPnl });

          // Mirror decideShortAction inline (sync)
          let action: 'hold' | 'close_pt' | 'close_pin' | 'close_expired' = 'hold';
          if (d >= curShort.expiry) {
            action = 'close_expired';
          } else {
            const moneyness = Math.abs(shortContract.row.stock_price / curShort.strike - 1);
            if (shortContract.row.dte <= 2 && moneyness <= config.diagRollTriggerMoneyness!) {
              action = 'close_pin';
            } else {
              const pnlPct = (curShort.entryCredit - shortMid) / curShort.entryCredit;
              if (pnlPct >= config.diagShortProfitTarget!) action = 'close_pt';
            }
          }

          if (action !== 'hold') {
            let exitCost: number;
            let exitReason: ShortCycle['exitReason'];
            if (action === 'close_expired') {
              const assigned = shortContract.row.stock_price >= curShort.strike;
              exitCost = assigned ? Math.max(0, shortContract.row.stock_price - curShort.strike) : 0;
              exitReason = assigned ? 'ASSIGNED' : 'EXPIRATION';
            } else {
              exitCost = applyFill(
                config.fillMode, shortContract.row.call_mid, shortContract.row.call_bid, shortContract.row.call_ask,
                'buy', config.slippage, shortContract.row.call_oi, shortContract.row.dte,
              ).fillPrice;
              exitReason = action === 'close_pt' ? 'PROFIT_TARGET' : 'PIN_ROLL';
            }
            shortCycles.push({
              strike: curShort.strike, entryDate: curShort.entryDate, exitDate: d,
              entryCredit: curShort.entryCredit, exitCost,
              entryDTE: curShort.entryDTE, exitDTE: shortContract.row.dte,
              entryDelta: curShort.entryDelta,
              exitReason,
              dailyMtM: curShort.dailyMtM,
            });
            curShort = null;

            // Rolling: open a new short if long is still alive
            if (!stop) {
              const nextChain = getCachedChainFiltered(signal.ticker, d, undefined, config.diagShortDTERange!);
              const nextMatch = findStrikeByDelta(nextChain, shortMidDelta, 'Call', config.diagShortDTERange!, 0);
              if (nextMatch && nextMatch.row.strike > longStrike) {
                const nextCredit = applyFill(
                  config.fillMode, nextMatch.row.call_mid, nextMatch.row.call_bid, nextMatch.row.call_ask,
                  'sell', config.slippage, nextMatch.row.call_oi, nextMatch.row.dte,
                ).fillPrice;
                if (Number.isFinite(nextCredit) && nextCredit > 0) {
                  curShort = {
                    strike: nextMatch.row.strike, expiry: nextMatch.row.expir_date,
                    entryDate: d, entryDTE: nextMatch.row.dte,
                    entryCredit: nextCredit, entryDelta: nextMatch.row.delta ?? shortMidDelta,
                    dailyMtM: [],
                  };
                }
              }
            }
          }
        }
      }
    }

    // Settle open short at long exit
    if (curShort) {
      const closingContract = findContractDirect(signal.ticker, longExitDate, curShort.strike, curShort.expiry, 'Call');
      const buyBackCost = closingContract ? applyFill(
        config.fillMode, closingContract.mid, closingContract.row.call_bid, closingContract.row.call_ask,
        'buy', config.slippage, closingContract.row.call_oi, closingContract.row.dte,
      ).fillPrice : 0;
      shortCycles.push({
        strike: curShort.strike, entryDate: curShort.entryDate, exitDate: longExitDate,
        entryCredit: curShort.entryCredit, exitCost: buyBackCost,
        entryDTE: curShort.entryDTE, exitDTE: closingContract?.row.dte ?? 0,
        entryDelta: curShort.entryDelta,
        exitReason: 'FORCE_CLOSE',
        dailyMtM: curShort.dailyMtM,
      });
    }

    // Long exit fill (synthetic ±$0.05 spread — matches simulateDiagonal's TODO)
    const longExitFillPrice = applyFill(
      config.fillMode, longExitPremium, longExitPremium - 0.05, longExitPremium + 0.05,
      'sell', config.slippage, 0, longExitDTE,
    ).fillPrice;
    const longPnl = 100 * (longExitFillPrice - longPremium);
    const shortsPnl = shortCycles.reduce((s, c) => s + 100 * (c.entryCredit - c.exitCost), 0);
    const totalPnl = longPnl + shortsPnl;
    const firstCredit = shortCycles.length > 0 ? shortCycles[0].entryCredit : 0;
    const capital = Math.max(1, (longPremium - firstCredit) * 100);

    // Build combined dailyMtM with realized short P&L accumulation (mirrors Task 10 fix)
    const combinedDaily: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
    const longByDate = new Map(longDailyMtM.map(r => [r.date, r]));
    const openShortMarkByDate = new Map<string, number>();
    const realizations = shortCycles.map(c => ({ date: c.exitDate, pnl: 100 * (c.entryCredit - c.exitCost) }));
    realizations.sort((a, b) => a.date.localeCompare(b.date));
    for (const c of shortCycles) {
      for (const m of c.dailyMtM ?? []) {
        if (m.date < c.exitDate) openShortMarkByDate.set(m.date, m.pnl);
      }
    }
    const realizedAsOf = (d: string): number => {
      let cum = 0;
      for (const r of realizations) {
        if (r.date <= d) cum += r.pnl;
        else break;
      }
      return cum;
    };
    for (const [d, lrow] of longByDate) {
      const openMark = openShortMarkByDate.get(d) ?? 0;
      const realized = realizedAsOf(d);
      combinedDaily.push({ date: d, spreadMid: lrow.premium, unrealizedPnl: lrow.pnl + openMark + realized });
    }

    const holdDays = allDates.filter(d => d > signal.date && d <= longExitDate).length;

    const trade: OptionTrade = {
      ticker: signal.ticker, mode: 'DIAGONAL', direction: 'CALL',
      entryDate: signal.date, entrySignalScore: signal.score,
      strike: longStrike, expiry: longExpiry,
      entryDTE: longRow.dte, entryPrice: longPremium - shortCredit,
      entryDelta: longRow.delta ?? longMidDelta, entryIV: longRow.call_iv, entryStockPrice,
      exitDate: longExitDate, exitPrice: longExitFillPrice, exitDTE: longExitDTE,
      exitStockPrice: lastSpot,
      exitType: longExitReason,
      pnl: totalPnl, pnlPct: totalPnl / capital,
      holdDays,
      fillMode: config.fillMode,
      dailyMtM: combinedDaily,
      diagonalLegs: {
        longCall: {
          strike: longStrike, entryPrice: longPremium, exitPrice: longExitFillPrice,
          entryDate: signal.date, exitDate: longExitDate,
          entryDelta: longRow.delta ?? longMidDelta, entryIV: longRow.call_iv,
          entryDTE: longRow.dte, exitDTE: longExitDTE,
          dailyMtM: longDailyMtM,
        },
        shortCallCycles: shortCycles,
      },
    };
    return trade;
  };
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
