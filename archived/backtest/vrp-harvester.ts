/**
 * VRP Harvester — Systematic variance risk premium harvesting with direction gate.
 *
 * Design principles:
 * - Primary edge: VRP + theta (structural, persists across regimes)
 * - Direction: 2-parameter gate (EMA trend slope + EMA filter), not a score
 * - Sizing: portfolio risk budget (2% max loss per position)
 * - Regime adaptation: VIX-based sizing, not signal switching
 * - No parameter sweeping: single fixed config, validate or reject
 */

import type { VRPHarvesterConfig, FillMode } from './types';
import { DEFAULT_VRP_HARVESTER_CONFIG } from './types';
import type { OptionTrade, EntrySignal, SimConfig, OptionExitType } from './option-sim';
import { DEFAULT_SHORT_CREDIT_CONFIG, computeOptionAnalytics } from './option-sim';
import { vrpGateSeries, type VRPGateResult } from '../tech-analysis';
import type { TickerData } from './signal-data';
import { fetchTickerData } from './signal-data';
import {
  getCachedChain,
  findSpreadStrikes,
  findContractDirect,
} from './chain-cache';
import {
  clampSpreadCloseCost,
  computeCreditSpreadThresholds,
  computeIntrinsicSpreadCloseCost,
  createMissingChainState,
  resolveCreditSpreadCommissions,
  resolveTriggeredCreditExitCost,
  shouldExitNoChain,
  updateMissingChainState,
} from './credit-spread-exit';
import { applyFill, applySpreadFill } from './slippage';
import { syntheticRepriceLeg } from './synthetic-reprice';
import type { RepricingMethod } from './synthetic-reprice';

// ── Signal Generation ───────────────────────────────────

export interface VRPSignal {
  ticker: string;
  date: string;
  barIndex: number;
  direction: 'CALL' | 'PUT';
  gate: VRPGateResult;
  ivRank: number | null;
  vrp?: number;
  contango?: number;
}

/**
 * Generate VRP gate signals for a single ticker.
 * Returns signals where the direction gate fires AND entry quality (d8) is acceptable.
 */
export function generateVRPSignals(
  td: TickerData,
  config: VRPHarvesterConfig,
  periodStart: string,
  periodEnd: string,
): VRPSignal[] {
  const closes = td.candles.map(c => c.close);
  const gates = vrpGateSeries(closes, config.trendEMAPeriod, config.filterEMAPeriod, config.noTradeZonePct);

  const signals: VRPSignal[] = [];
  let waitingForPullback: { startIdx: number; gate: VRPGateResult; direction: 'CALL' | 'PUT' } | null = null;

  for (let i = 0; i < td.candles.length; i++) {
    const candle = td.candles[i];
    if (candle.date < periodStart || candle.date > periodEnd) continue;

    const gate = gates[i];
    if (!gate || gate.direction === 'NO_TRADE') {
      waitingForPullback = null;
      continue;
    }

    // Map VRP direction to credit spread signal direction:
    // PUT_SPREAD (uptrend) → signal direction CALL (sell put credit spread)
    // CALL_SPREAD (downtrend) → signal direction PUT (sell call credit spread)
    const signalDir: 'CALL' | 'PUT' = gate.direction === 'PUT_SPREAD' ? 'CALL' : 'PUT';

    // Entry timing: wait for pullback (d8 < threshold)
    if (!waitingForPullback) {
      // New direction signal — start waiting for pullback
      waitingForPullback = { startIdx: i, gate, direction: signalDir };
    }

    if (waitingForPullback && waitingForPullback.direction === signalDir) {
      const barsWaited = i - waitingForPullback.startIdx;

      if (gate.d8 <= config.maxD8Entry || barsWaited >= config.maxWaitBars) {
        // Entry triggered: either pullback met or max wait exceeded
        const idx = td.dateToIdx.get(candle.date);
        const ivRank = idx != null ? (td.ivRanks[idx] ?? null) : null;
        const regime = td.regimeByDate.get(candle.date);

        signals.push({
          ticker: td.ticker,
          date: candle.date,
          barIndex: i,
          direction: signalDir,
          gate,
          ivRank,
          vrp: regime?.vrp,
          contango: regime?.contango,
        });

        waitingForPullback = null; // Reset after entry
      }
    } else {
      // Direction changed — restart wait
      waitingForPullback = { startIdx: i, gate, direction: signalDir };
    }
  }

  return signals;
}

/**
 * Convert VRP signals to EntrySignal objects compatible with existing simulateCreditSpread.
 */
export function vrpSignalToEntrySignal(signal: VRPSignal): EntrySignal {
  return {
    ticker: signal.ticker,
    date: signal.date,
    direction: signal.direction,
    score: 75, // Fixed score — the VRP gate replaces scoring
    sourcePreset: 'ema', // Use EMA preset weights (closest to our 2-EMA gate)
    ivRank: signal.ivRank ?? undefined,
    vrp: signal.vrp,
    contango: signal.contango,
    d8: signal.gate.d8 * 100, // Convert to percentage
    dirConfidence: 70, // Bypass confidence filter — the gate IS the confidence
  };
}

// ── SimConfig Builder ───────────────────────────────────

/**
 * Build the SimConfig for the VRP Harvester from the harvester config.
 * Maps VRP-specific settings to the existing credit spread SimConfig.
 */
export function buildSimConfig(config: VRPHarvesterConfig): SimConfig {
  return {
    ...DEFAULT_SHORT_CREDIT_CONFIG,
    mode: 'CREDIT_SPREAD',
    creditShortDelta: config.creditShortDelta,
    creditSpreadWidth: config.creditSpreadWidth,
    creditDTERange: config.creditDTERange,
    creditProfitTarget: config.creditProfitTarget,
    creditStopLossMultiple: 100, // No stop loss — defined risk
    creditTimeStopDTE: config.creditTimeStopDTE,
    monitoringIntervalDays: 1,
    minIVRank: config.minIVRank,
    fillMode: config.fillMode,
    slippage: config.slippage,
    commissionPerLeg: config.commissionPerLeg,
    maxPositions: config.maxPositions,
    maxPerTicker: config.maxPerTicker,
    // No delta stop, no trailing lock, no score exits
    creditDeltaStop: undefined,
    trailingActivatePct: undefined,
    trailingFloorPct: undefined,
    creditMaxLossStopPct: undefined,
  };
}

// ── Cache-Only Chain Memo ────────────────────────────────

const MAX_CACHE = 200;
const _chainMemo = new Map<string, ReturnType<typeof getCachedChain>>();

function getCachedChainMemo(ticker: string, date: string): ReturnType<typeof getCachedChain> {
  const key = `${ticker}|${date}`;
  const cached = _chainMemo.get(key);
  if (cached !== undefined) {
    _chainMemo.delete(key);
    _chainMemo.set(key, cached);
    return cached;
  }
  const rows = getCachedChain(ticker, date);
  if (_chainMemo.size >= MAX_CACHE) {
    const oldest = _chainMemo.keys().next().value;
    if (oldest) _chainMemo.delete(oldest);
  }
  _chainMemo.set(key, rows);
  return rows;
}

// ── Date Helpers ────────────────────────────────────────

let _dateIndex: Map<string, number> | null = null;

export function buildDateIndex(allDates: string[]) {
  _dateIndex = new Map(allDates.map((d, i) => [d, i]));
}

function getMonitoringDates(
  allDates: string[], entryDate: string, intervalDays: number, maxDate: string,
): string[] {
  const dates: string[] = [];
  let current = entryDate;
  while (true) {
    const idx = _dateIndex?.get(current) ?? -1;
    if (idx < 0) break;
    const nextIdx = idx + intervalDays;
    if (nextIdx >= allDates.length) break;
    current = allDates[nextIdx];
    if (current > maxDate) break;
    dates.push(current);
  }
  return dates;
}

// ── Cache-Only Trade Evaluator ──────────────────────────

/**
 * Evaluate a single VRP signal using local SQLite chain cache only.
 * Follows the same pattern as wfa-pipeline-swing.ts evaluator.
 * Returns OptionTrade or null if signal is filtered/unfillable.
 */
export function evaluateVRPTradeCacheOnly(
  signal: EntrySignal,
  config: SimConfig,
  allTradingDates: string[],
  maxDate: string,
): OptionTrade | null {
  // IV rank filter
  if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) return null;

  // Fetch entry chain from local cache
  const entryChain = getCachedChainMemo(signal.ticker, signal.date);
  if (entryChain.length === 0) return null;

  // Credit spread: sell puts in uptrend (CALL signal), sell calls in downtrend (PUT signal)
  const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';

  const spread = findSpreadStrikes(
    entryChain, config.creditShortDelta, config.creditSpreadWidth,
    optionType, config.creditDTERange,
  );
  if (!spread || spread.netCredit <= 0) return null;

  const fillMode = config.fillMode;
  const { entryCommission, exitCommission } = resolveCreditSpreadCommissions(config);

  // Apply fill model to entry
  let entryCredit: number;
  let entrySlippage = 0;

  if (fillMode === 'bidask' && config.slippage.enabled) {
    if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
      const spreadFill = applySpreadFill('bidask', { ...spread.short, dte: spread.short.row.dte }, { ...spread.long, dte: spread.long.row.dte }, 'open', config.slippage);
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
  } else {
    entryCredit = spread.netCredit;
  }

  const thresholds = computeCreditSpreadThresholds(config, spread, entryCredit);
  const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;
  const monitorDates = getMonitoringDates(allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd);
  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
  let missingChainState = createMissingChainState();
  let lastValidSpreadCost: number | null = null;
  let lastShortIV: number | null = spread.short.iv > 0 ? spread.short.iv : null;
  let lastLongIV: number | null = spread.long.iv > 0 ? spread.long.iv : null;
  let lastKnownStockPrice = spread.short.row.stock_price;
  let syntheticDayCount = 0;
  let lastRepricingMethod: RepricingMethod = 'exact';
  const bsmR = config.bsmRiskFreeRate ?? 0.04;
  const bsmKappa = config.bsmKappa ?? 4.0;
  const ivTheta = signal.oratsIV60 ?? signal.hv60 ?? spread.short.iv;

  // Monitoring loop
  for (const checkDate of monitorDates) {
    let shortLeg = findContractDirect(signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
    let longLeg = findContractDirect(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    const fallbackChain = (!shortLeg || !longLeg) ? getCachedChainMemo(signal.ticker, checkDate) : [];
    const monitoringStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price;
    if (monitoringStockPrice != null && Number.isFinite(monitoringStockPrice)) lastKnownStockPrice = monitoringStockPrice;

    // Synthetic fallback for missing legs
    let dayUsedSynthetic = false;
    if (!shortLeg) {
      const synthShort = syntheticRepriceLeg({
        ticker: signal.ticker, date: checkDate, strike: spread.short.row.strike,
        expiry: spread.short.row.expir_date, type: optionType,
        entryIV: spread.short.iv, entryDate: signal.date,
        lastValidIV: lastShortIV, ivTheta, kappa: bsmKappa, r: bsmR,
      }, monitoringStockPrice ?? lastKnownStockPrice);
      if (synthShort) { shortLeg = synthShort; lastRepricingMethod = synthShort.repricingMethod; dayUsedSynthetic = true; }
    }
    if (!longLeg) {
      const synthLong = syntheticRepriceLeg({
        ticker: signal.ticker, date: checkDate, strike: spread.long.row.strike,
        expiry: spread.short.row.expir_date, type: optionType,
        entryIV: spread.long.iv, entryDate: signal.date,
        lastValidIV: lastLongIV, ivTheta, kappa: bsmKappa, r: bsmR,
      }, monitoringStockPrice ?? lastKnownStockPrice);
      if (synthLong) { longLeg = synthLong; lastRepricingMethod = synthLong.repricingMethod; dayUsedSynthetic = true; }
    }

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
        return buildVRPTrade(signal, spread, entryCredit, checkDate, exitCost,
          shortLeg?.row.dte ?? longLeg?.row.dte ?? 0, monitoringStockPrice ?? spread.short.row.stock_price,
          'NO_CHAIN', dailyMtM, entrySlippage, 0, fillMode, entryCommission, exitCommission);
      }
      continue;
    }
    if (dayUsedSynthetic) syntheticDayCount++;

    // Compute current spread cost
    let currentSpreadCost: number;
    let exitSlippageAmount = 0;
    if (fillMode === 'bidask' && config.slippage.enabled) {
      if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
        const spreadFill = applySpreadFill('bidask', { ...shortLeg!, dte: shortLeg!.row.dte }, { ...longLeg!, dte: longLeg!.row.dte }, 'close', config.slippage);
        currentSpreadCost = spreadFill.fillPrice;
        exitSlippageAmount = spreadFill.slippage;
      } else {
        const shortClose = applyFill('bidask', shortLeg!.mid, shortLeg!.bid, shortLeg!.ask, 'buy', config.slippage, shortLeg!.oi, shortLeg!.row.dte);
        const longClose = applyFill('bidask', longLeg!.mid, longLeg!.bid, longLeg!.ask, 'sell', config.slippage, longLeg!.oi, longLeg!.row.dte);
        currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
        exitSlippageAmount = shortClose.slippage + longClose.slippage;
      }
    } else {
      currentSpreadCost = shortLeg!.mid - longLeg!.mid;
    }
    currentSpreadCost = clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth);
    const currentDTE = shortLeg!.row.dte;
    lastValidSpreadCost = currentSpreadCost;
    if (shortLeg!.iv > 0) lastShortIV = shortLeg!.iv;
    if (longLeg!.iv > 0) lastLongIV = longLeg!.iv;

    dailyMtM.push({ date: checkDate, spreadMid: currentSpreadCost, unrealizedPnl: (entryCredit - currentSpreadCost) * 100 });

    // Exit checks
    let exitType: OptionExitType | null = null;
    if (currentSpreadCost <= thresholds.tpCost) exitType = 'PROFIT_TARGET';
    else if (currentSpreadCost >= thresholds.slCost) exitType = 'STOP_LOSS';
    else if (currentDTE <= config.creditTimeStopDTE) exitType = 'TIME_STOP';

    if (exitType) {
      const exitCost = resolveTriggeredCreditExitCost(exitType, currentSpreadCost, thresholds);
      const trade = buildVRPTrade(signal, spread, entryCredit, checkDate, exitCost,
        currentDTE, shortLeg!.row.stock_price, exitType, dailyMtM,
        entrySlippage, exitSlippageAmount, fillMode, entryCommission, exitCommission);
      if (syntheticDayCount > 0) { trade.repricingMethod = lastRepricingMethod; trade.syntheticDays = syntheticDayCount; }
      return trade;
    }
  }

  // Expiry exit
  const lastDate = monitorDates[monitorDates.length - 1];
  if (lastDate) {
    let shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
    let longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    const fallbackChain = (!shortLeg || !longLeg) ? getCachedChainMemo(signal.ticker, lastDate) : [];
    const lastStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? lastKnownStockPrice;

    if (!shortLeg) {
      const s = syntheticRepriceLeg({ ticker: signal.ticker, date: lastDate, strike: spread.short.row.strike, expiry: spread.short.row.expir_date, type: optionType, entryIV: spread.short.iv, entryDate: signal.date, lastValidIV: lastShortIV, ivTheta, kappa: bsmKappa, r: bsmR }, lastStockPrice);
      if (s) shortLeg = s;
    }
    if (!longLeg) {
      const l = syntheticRepriceLeg({ ticker: signal.ticker, date: lastDate, strike: spread.long.row.strike, expiry: spread.short.row.expir_date, type: optionType, entryIV: spread.long.iv, entryDate: signal.date, lastValidIV: lastLongIV, ivTheta, kappa: bsmKappa, r: bsmR }, lastStockPrice);
      if (l) longLeg = l;
    }

    let currentSpreadCost: number;
    if (shortLeg && longLeg) {
      currentSpreadCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, thresholds.actualWidth);
    } else {
      currentSpreadCost = computeIntrinsicSpreadCloseCost(optionType, spread.short.row.strike, spread.long.row.strike, lastStockPrice, thresholds.actualWidth);
    }
    const trade = buildVRPTrade(signal, spread, entryCredit, lastDate, currentSpreadCost,
      shortLeg?.row.dte ?? longLeg?.row.dte ?? 0, lastStockPrice,
      'EXPIRATION', dailyMtM, entrySlippage, 0, fillMode, entryCommission, exitCommission);
    if (syntheticDayCount > 0) { trade.repricingMethod = lastRepricingMethod; trade.syntheticDays = syntheticDayCount; }
    return trade;
  }
  return null;
}

function buildVRPTrade(
  signal: EntrySignal, spread: ReturnType<typeof findSpreadStrikes> & {},
  entryCredit: number, exitDate: string, exitCost: number,
  exitDTE: number, exitStockPrice: number,
  exitType: OptionExitType, dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[],
  entrySlippage: number, exitSlippage: number, fillMode: FillMode,
  entryCommission: number, exitCommission: number,
): OptionTrade {
  const actualWidth = Math.abs(spread!.short.row.strike - spread!.long.row.strike);
  const boundedCredit = Math.max(0, Math.min(entryCredit, actualWidth));
  const maxLoss = actualWidth - boundedCredit;
  const rawPnl = (boundedCredit - exitCost) * 100;
  const totalCommissions = entryCommission + exitCommission;
  const netPnl = rawPnl - totalCommissions;

  return {
    ticker: signal.ticker,
    mode: 'CREDIT_SPREAD',
    direction: signal.direction,
    entryDate: signal.date,
    entrySignalScore: signal.score,
    strike: spread!.short.row.strike,
    expiry: spread!.short.row.expir_date,
    entryDTE: spread!.short.row.dte,
    entryPrice: boundedCredit,
    entryDelta: spread!.short.delta,
    entryIV: spread!.short.iv,
    entryStockPrice: spread!.short.row.stock_price,
    longStrike: spread!.long.row.strike,
    longEntryPrice: spread!.long.mid,
    spreadWidth: actualWidth,
    maxProfit: boundedCredit * 100,
    maxLoss: maxLoss * 100,
    exitDate,
    exitPrice: exitCost,
    exitDTE,
    exitStockPrice,
    exitType,
    pnl: netPnl,
    grossPnl: rawPnl,
    pnlPct: maxLoss > 0 ? (netPnl / (maxLoss * 100)) * 100 : 0,
    holdDays: Math.round((new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86_400_000),
    ivRank: signal.ivRank,
    entrySlippage,
    exitSlippage,
    entryCommission,
    exitCommission,
    fillMode,
    dailyMtM,
  };
}

// ── Portfolio-Level Execution ───────────────────────────

export interface VRPPortfolioState {
  openPositions: { trade: OptionTrade; riskCapital: number }[];
  openCountByTicker: Map<string, number>;
  totalRiskCapital: number;
  currentNAV: number;
  /** Trading days since VIX pause triggered (0 = not paused) */
  vixPauseDaysRemaining: number;
  /** Whether drawdown halt is active */
  drawdownHalted: boolean;
}

export interface VRPHarvesterResult {
  trades: OptionTrade[];
  analytics: ReturnType<typeof computeOptionAnalytics>;
  signalCount: number;
  filteredByIV: number;
  filteredByPortfolio: number;
  filteredByVIX: number;
  filteredByDrawdown: number;
  filteredByEarnings: number;
  perTickerStats: Map<string, { signals: number; trades: number; pnl: number }>;
}

/**
 * Run the full VRP Harvester simulation across all tickers.
 *
 * Flow:
 * 1. Load candle data for all tickers
 * 2. Generate VRP gate signals per ticker
 * 3. Merge and sort signals chronologically
 * 4. Execute each signal through the credit spread simulator
 * 5. Apply portfolio constraints, drawdown governor, VIX scaling
 * 6. Compute analytics
 */
export async function runVRPHarvester(
  _oatsToken: string,
  config: VRPHarvesterConfig = DEFAULT_VRP_HARVESTER_CONFIG,
  options?: {
    /** Override VIX data: map of date → VIX close. If not provided, VIX scaling is disabled. */
    vixData?: Map<string, number>;
    /** Override earnings dates: map of ticker → set of earnings dates. */
    earningsDates?: Map<string, Set<string>>;
    /** Progress callback */
    onProgress?: (msg: string) => void;
    /** Pre-loaded ticker data (skip Supabase fetch) */
    tickerDataMap?: Map<string, TickerData>;
  },
): Promise<VRPHarvesterResult> {
  const log = options?.onProgress ?? (() => {});
  const simConfig = buildSimConfig(config);

  // Step 1: Load data for all tickers
  let tickerDataMap: Map<string, TickerData>;
  if (options?.tickerDataMap) {
    tickerDataMap = options.tickerDataMap;
    log(`Using pre-loaded data for ${tickerDataMap.size} tickers`);
  } else {
    log(`Loading data for ${config.tickers.length} tickers...`);
    tickerDataMap = new Map<string, TickerData>();
    const warmupDays = config.filterEMAPeriod + 60;
    const dataStartDate = subtractTradingDays(config.startDate, warmupDays);
    for (const ticker of config.tickers) {
      const td = await fetchTickerData(ticker, dataStartDate, config.endDate);
      tickerDataMap.set(ticker, td);
      log(`  ${ticker}: ${td.candles.length} candles loaded`);
    }
  }

  // Step 2: Generate signals per ticker
  log('Generating VRP gate signals...');
  const allSignals: VRPSignal[] = [];
  const perTickerStats = new Map<string, { signals: number; trades: number; pnl: number }>();

  for (const ticker of config.tickers) {
    const td = tickerDataMap.get(ticker)!;
    const signals = generateVRPSignals(td, config, config.startDate, config.endDate);
    allSignals.push(...signals);
    perTickerStats.set(ticker, { signals: signals.length, trades: 0, pnl: 0 });
    log(`  ${ticker}: ${signals.length} signals`);
  }

  // Step 3: Sort signals chronologically (date → ticker → direction)
  allSignals.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.ticker.localeCompare(b.ticker) ||
    (a.direction === 'CALL' ? 0 : 1) - (b.direction === 'CALL' ? 0 : 1)
  );

  log(`Total signals: ${allSignals.length}`);

  // Step 4: Execute with portfolio constraints
  const state: VRPPortfolioState = {
    openPositions: [],
    openCountByTicker: new Map(),
    totalRiskCapital: 0,
    currentNAV: config.startingCapital,
    vixPauseDaysRemaining: 0,
    drawdownHalted: false,
  };

  const trades: OptionTrade[] = [];
  let filteredByIV = 0;
  let filteredByPortfolio = 0;
  let filteredByVIX = 0;
  let filteredByDrawdown = 0;
  let filteredByEarnings = 0;

  // Build trading dates from all loaded candles
  const allDatesSet = new Set<string>();
  for (const td of tickerDataMap.values()) {
    for (const c of td.candles) allDatesSet.add(c.date);
  }
  const allTradingDates = [...allDatesSet].sort();
  buildDateIndex(allTradingDates);

  for (const signal of allSignals) {
    // Retire closed positions
    retireClosedPositions(state, signal.date);

    // Check VIX pause
    if (options?.vixData) {
      const vix = options.vixData.get(signal.date);
      if (vix != null) {
        if (vix >= config.vixPauseThreshold) {
          state.vixPauseDaysRemaining = config.vixPauseDays;
        }
      }
      if (state.vixPauseDaysRemaining > 0) {
        state.vixPauseDaysRemaining--;
        filteredByVIX++;
        continue;
      }
    }

    // Check drawdown governor
    updateUnrealizedPnL(state, signal.date);
    const unrealizedLossPct = (config.startingCapital - state.currentNAV) / config.startingCapital;
    if (unrealizedLossPct > config.drawdownHaltPct) {
      state.drawdownHalted = true;
    }
    if (state.drawdownHalted) {
      if (unrealizedLossPct > config.drawdownResumePct) {
        filteredByDrawdown++;
        continue;
      }
      state.drawdownHalted = false;
    }

    // Check earnings exclusion
    if (options?.earningsDates) {
      const tickerEarnings = options.earningsDates.get(signal.ticker);
      if (tickerEarnings && isNearEarnings(signal.date, tickerEarnings, config.earningsExclusionDays, config.creditDTERange[1])) {
        filteredByEarnings++;
        continue;
      }
    }

    // Check portfolio constraints
    if (state.openPositions.length >= config.maxPositions) {
      filteredByPortfolio++;
      continue;
    }
    const tickerCount = state.openCountByTicker.get(signal.ticker) ?? 0;
    if (tickerCount >= config.maxPerTicker) {
      filteredByPortfolio++;
      continue;
    }

    // Determine position size based on risk budget
    const maxLossPerPosition = config.startingCapital * config.maxLossPerPositionPct;
    const contracts = Math.max(1, Math.floor(maxLossPerPosition / (config.creditSpreadWidth * 100)));

    // VIX-based size scaling
    let sizeMultiplier = 1.0;
    if (options?.vixData) {
      const vix = options.vixData.get(signal.date);
      if (vix != null && vix >= config.vixHalfSizeThreshold) {
        sizeMultiplier = 0.5;
      }
    }
    const scaledContracts = Math.max(1, Math.round(contracts * sizeMultiplier));

    // Convert to EntrySignal and execute (cache-only, no API calls)
    const entrySignal = vrpSignalToEntrySignal(signal);

    const trade = evaluateVRPTradeCacheOnly(
      entrySignal,
      simConfig,
      allTradingDates,
      config.endDate,
    );

    if (!trade) {
      filteredByIV++; // Filtered by IV rank, chain unavailability, or no credit
      continue;
    }

    // Apply position sizing
    trade.contracts = scaledContracts;
    trade.positionSize = scaledContracts;
    trade.pnl = trade.pnl * scaledContracts;

    // Track portfolio state
    const riskCapital = (trade.maxLoss ?? trade.entryPrice) * 100 * scaledContracts;
    state.openPositions.push({ trade, riskCapital });
    state.openCountByTicker.set(signal.ticker, tickerCount + 1);
    state.totalRiskCapital += riskCapital;

    trades.push(trade);

    // Update per-ticker stats
    const stats = perTickerStats.get(signal.ticker)!;
    stats.trades++;
    stats.pnl += trade.pnl;
  }

  // Step 5: Compute analytics
  log(`\nExecuted ${trades.length} trades from ${allSignals.length} signals`);
  const analytics = computeOptionAnalytics(trades);

  return {
    trades,
    analytics,
    signalCount: allSignals.length,
    filteredByIV,
    filteredByPortfolio,
    filteredByVIX,
    filteredByDrawdown,
    filteredByEarnings,
    perTickerStats,
  };
}

// ── Helpers ─────────────────────────────────────────────

function retireClosedPositions(state: VRPPortfolioState, currentDate: string): void {
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];
    if (pos.trade.exitDate <= currentDate) {
      state.openPositions.splice(i, 1);
      state.totalRiskCapital = Math.max(0, state.totalRiskCapital - pos.riskCapital);
      const prev = state.openCountByTicker.get(pos.trade.ticker) ?? 0;
      if (prev <= 1) state.openCountByTicker.delete(pos.trade.ticker);
      else state.openCountByTicker.set(pos.trade.ticker, prev - 1);
    }
  }
}

function updateUnrealizedPnL(state: VRPPortfolioState, currentDate: string): void {
  let unrealizedPnl = 0;
  for (const pos of state.openPositions) {
    if (pos.trade.dailyMtM && pos.trade.dailyMtM.length > 0) {
      // Find most recent MTM entry at or before currentDate
      const mtm = pos.trade.dailyMtM.filter(m => m.date <= currentDate).pop();
      if (mtm) {
        unrealizedPnl += mtm.unrealizedPnl * (pos.trade.contracts ?? 1);
      }
    }
  }

  // Realized PnL from closed trades is tracked via startingCapital + cumulative
  // For simplicity, just track unrealized from open positions
  state.currentNAV = state.totalRiskCapital > 0
    ? state.totalRiskCapital + unrealizedPnl
    : state.currentNAV; // No open positions → NAV unchanged
}

function isNearEarnings(
  signalDate: string,
  earningsDates: Set<string>,
  exclusionDays: number,
  maxDTE: number,
): boolean {
  const signalMs = new Date(signalDate).getTime();
  const futureMs = signalMs + (maxDTE + exclusionDays) * 86_400_000;

  for (const ed of earningsDates) {
    const edMs = new Date(ed).getTime();
    // Earnings within the position's likely lifetime
    if (edMs >= signalMs && edMs <= futureMs) {
      return true;
    }
  }
  return false;
}

function subtractTradingDays(dateStr: string, tradingDays: number): string {
  // Approximate: 1.5 calendar days per trading day
  const calendarDays = Math.ceil(tradingDays * 1.5);
  const date = new Date(dateStr);
  date.setDate(date.getDate() - calendarDays);
  return date.toISOString().slice(0, 10);
}
