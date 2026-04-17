/**
 * Option Trade Simulator — LEAP + Credit Spread modes
 *
 * Uses real historical option chain data (from chain-cache.ts) to simulate
 * actual options P&L. No BSM approximations — real bid/ask/mid prices.
 *
 * Two modes:
 *   LEAP (buy-side): Deep ITM, 6-12 month expiry, leveraged directional bet
 *   CREDIT_SPREAD (sell-side): OTM 30-45 DTE, theta/IV harvest
 */

import type { StrikeMatch, SpreadMatch } from './chain-cache';
import {
  fetchHistoricalChain,
  findStrikeByDelta,
  findSpreadStrikes,
  findContract,
  findContractDirect,
} from './chain-cache';
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
} from './credit-spread-exit';
import type { DynamicSlippageConfig, FillMode, DirConfTier, SignalPresetKey } from './types';
export type { SignalPresetKey };
import { DEFAULT_DYNAMIC_SLIPPAGE, DIR_CONF_THRESHOLDS } from './types';
import { applyFill, applySpreadFill } from './slippage';

// ── Types ────────────────────────────────────────────────

export type OptionMode = 'LEAP' | 'CREDIT_SPREAD' | 'DEBIT_SPREAD' | 'SWING_LONG_OPTION';
export type OptionExitType =
  | 'PROFIT_TARGET'
  | 'STOP_LOSS'
  | 'TIME_STOP'
  | 'SIGNAL_REVERSAL'
  | 'EXPIRATION'
  | 'FORCE_CLOSE'
  | 'NO_CHAIN'
  | 'PROFIT_TARGET_2'
  | 'SL_BREAKEVEN'
  | 'DELTA_STOP'
  | 'MAX_LOSS_STOP'
  | 'TRAILING_LOCK';

export interface OptionTrade {
  ticker: string;
  mode: OptionMode;
  direction: 'CALL' | 'PUT';
  entryDate: string;
  entrySignalScore: number;
  // Option details
  strike: number;
  expiry: string;
  entryDTE: number;
  entryPrice: number;         // premium paid (LEAP) or net credit (credit spread)
  entryDelta: number;
  entryIV: number;
  entryStockPrice: number;
  // Spread-specific
  longStrike?: number;
  longEntryPrice?: number;
  requestedSpreadWidth?: number;
  spreadWidth?: number;
  maxProfit?: number;         // = net credit for spread
  maxLoss?: number;           // = width - credit for spread
  // Exit
  exitDate: string;
  exitPrice: number;          // exit premium (LEAP) or spread close cost (credit)
  exitDTE: number;
  exitStockPrice: number;
  exitType: OptionExitType;
  // P&L
  pnl: number;               // $ P&L per contract (× 100 shares)
  grossPnl?: number;         // P&L before explicit slippage / commissions
  pnlPct: number;            // % return on capital at risk
  holdDays: number;
  // IV at entry (optional enrichment)
  ivRank?: number;
  // Execution tracking
  entrySlippage?: number;   // $ adverse fill impact at entry (per spread)
  exitSlippage?: number;    // $ adverse fill impact at exit
  entryCommission?: number; // $ commissions paid to open the spread
  exitCommission?: number;  // $ commissions paid to close the spread
  fillMode?: FillMode;      // which fill model was used
  // Daily mark-to-market P&L (unrealized, captured during monitoring loop)
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[];
  // Effective position size multiplier (1 = default 1 contract notionals)
  positionSize?: number;
}

export interface EntrySignal {
  ticker: string;
  date: string;
  direction: 'CALL' | 'PUT';
  score: number;
  ivRank?: number;
  hv60?: number;
  oratsIV60?: number;
  // v2: ORATS cores enrichment for volatility filters
  vrp?: number;          // IV²-RV² variance risk premium
  contango?: number;     // IV60/IV30 - 1 term structure
  vrpPct?: number;       // rolling percentile rank (0-100)
  contangoPct?: number;  // rolling percentile rank (0-100)
  slope?: number;        // ORATS put skew slope
  smvVol?: number;       // ORATS smoothed vol
  // Direction confidence (0-100) from calcDirConfidence
  dirConfidence?: number;
  // Per-ticker delta overrides (for multi-ticker studies with different deltas)
  configuredDelta?: number;
  configuredLongDelta?: number;
  // Pre-computed invalidation dates for signal-based exits
  invalidation?: {
    macroBreakDate?: string;      // first date SPY < EMA200
    trendBreakDate?: string;      // first date close < EMA55
    momentumBreakDate?: string;   // first date EMA8 < EMA13
    macro3dBreakDate?: string;    // 3 consecutive days SPY < EMA200
    trend3dBreakDate?: string;    // 3 consecutive days close < EMA55
    momentum3dBreakDate?: string; // 3 consecutive days EMA8 < EMA13
  };
}

export interface SimConfig {
  mode: OptionMode;
  // LEAP params
  leapDeltaRange: [number, number];     // [0.65, 0.80]
  leapDTERange: [number, number];       // [180, 365]
  leapProfitTarget: number;             // 0.50 = 50% gain
  leapStopLoss: number;                 // 0.30 = 30% loss
  leapTimeStopDTE: number;              // close when DTE < this (90)
  // Credit spread params
  creditShortDelta: number;             // 0.45 short-term, 0.35 swing
  creditSpreadWidth: number;            // 5 (dollars)
  creditDTERange: [number, number];     // [30, 50]
  creditProfitTarget: number;           // 0.50 = close at 50% of max profit
  creditStopLossMultiple: number;       // 2.0 = close at 2× credit
  creditTimeStopDTE: number;            // close when DTE < this (7)
  // Monitoring
  monitoringIntervalDays: number;       // check every N trading days (7 LEAP, 3 credit)
  // IV filter for credit spreads
  minIVRank: number;                    // 30 = require IV Rank > 30 for credit entries
  // Delta-based early exit (optional)
  creditDeltaStop?: number;             // exit if |short delta| exceeds this (e.g. 0.65 = 65%)
  // % of Max Loss stop — close when unrealized loss >= X% of max possible loss
  creditMaxLossStopPct?: number;        // 0.50 = close at 50% of max loss; undefined = off
  // Trailing Profit Lock — once profit hits activation %, set floor; close if retraces below
  trailingActivatePct?: number;         // 0.50 = activate at 50% of TP target profit
  trailingFloorPct?: number;            // 0.25 = floor at 25% of TP target profit
  // Execution model
  fillMode: FillMode;                       // 'mid' (legacy) or 'bidask' (realistic)
  slippage: DynamicSlippageConfig;          // dynamic slippage config
  // ORATS liquidity & Greeks filters (all optional, defaults = no filter)
  maxBidAskSpreadPct?: number;   // max (ask-bid)/mid for short leg (e.g. 0.10 = 10%)
  minShortOI?: number;           // min open interest on short leg strike
  maxGammaThetaRatio?: number;   // max gamma/|theta| ratio on short leg
  maxIVSkew?: number;            // max |shortIV - longIV| allowed (absolute, e.g. 0.06)
  // Signal selection (determines which tech indicator generates entries)
  signalWeightPreset?: SignalPresetKey;  // 'ema'|'mom'|'em'|'mf' (default: 'ema')
  // v2: Volatility & microstructure filters (from ORATS cores)
  vrpFilter?: number;       // min VRP (IV²-RV²) to enter; 0 or undefined = disabled
  contangoFilter?: number;  // min contango (IV60/IV30-1) to enter; 0 or undefined = disabled
  vrpPctFilter?: number;       // min rolling VRP percentile rank (0-100)
  contangoPctFilter?: number;  // min rolling contango percentile rank (0-100)
  slopeFilter?: number;     // min ORATS slope to enter; 0 or undefined = disabled
  // Regime-based position sizing (optional). If configured, this scales
  // trade notionals by contango bucket instead of hard filtering.
  contangoSizeLow?: number;            // size when contango < contangoSizeMidThreshold
  contangoSizeMid?: number;            // size when midThreshold <= contango < highThreshold
  contangoSizeHigh?: number;           // size when contango >= contangoSizeHighThreshold
  contangoSizeMidThreshold?: number;   // e.g. 0.03
  contangoSizeHighThreshold?: number;  // e.g. 0.06
  useSmvVol?: boolean;      // use smvVol for IV source instead of midIv
  // Direction confidence tier filter
  dirConfTier?: DirConfTier;
  // Use O(1) direct PK lookup instead of full chain fetch in monitoring loops
  useDirectLookup?: boolean;
  // v3 intraday settings
  indicatorPeriodMultiplier?: number;
  bsmKappa?: number;
  bsmRiskFreeRate?: number;
  dailyCalibration?: boolean;
  ivThetaSource?: 'entry_iv' | 'hv60' | 'orats_iv60';
  missingChainExitAfterDays?: number;
  commissionPerLeg?: number;
  // Debit spread params
  debitDTERange?: [number, number];       // e.g. [30, 45]
  debitLongDelta?: number;                // closer to ATM, e.g. 0.50
  debitShortDelta?: number;               // further OTM, e.g. 0.20
  debitProfitTargetPct?: number;          // e.g. 0.50 = 50% of max profit
  debitMaxHoldDays?: number;              // max calendar days to hold
  debitMinExitDTE?: number;               // min DTE before forced time exit
  // Underlying trend exit (shared by debit and underlying strategies)
  underlyingExitEMA?: number;             // exit EMA period (21, 34)
  underlyingExitConfirmDays?: number;     // consecutive bars below EMA
  underlyingExitRequireSlope?: boolean;   // require EMA slope agreement
  // IV filter for debit/option entries
  maxIVRank?: number;                     // max IV rank for debit entries (want low IV)
  // Swing long option params
  swingLongDeltaRange?: [number, number]; // e.g. [0.70, 0.80]
  swingLongDTERange?: [number, number];   // e.g. [35, 50]
  swingLongProfitTargetPct?: number;      // e.g. 0.25 = 25% gain on premium
  swingLongMaxHoldDays?: number;          // max trading days to hold
  swingLongMinExitDTE?: number;           // exit when DTE drops below this
  swingLongMaxIVRank?: number;            // max IV rank for entry (want low IV)
  swingLongMaxRecentGapPct?: number;      // max recent gap % (gap risk filter)
  swingLongMaxFrontBackIVAnomaly?: number; // max front/back IV ratio
  swingLongMinOI?: number;               // min open interest on selected contract
  swingLongMaxBidAskSpreadPct?: number;  // max bid-ask spread as % of mid
  swingLongRiskBudgetPct?: number;       // fraction of capital risked per trade
  // Signal invalidation exit — exit at market when entry conditions break
  signalInvalidation?: {
    type: 'macro' | 'trend' | 'momentum' | 'any';
    graceDays?: number; // 0 = immediate, 3 = 3-day confirmation
  };
}

export const DEFAULT_LEAP_CONFIG: SimConfig = {
  mode: 'LEAP',
  leapDeltaRange: [0.65, 0.80],
  leapDTERange: [180, 365],
  leapProfitTarget: 0.50,
  leapStopLoss: 0.30,
  leapTimeStopDTE: 90,
  creditShortDelta: 0.35,       // Phase 5: d35-d40 optimal (was 0.27)
  creditSpreadWidth: 10,        // Phase 4: $10 width for better utilization (was 5)
  creditDTERange: [45, 65],     // Phase 5: [45,65] +55% Sharpe vs [30,50]
  creditProfitTarget: 0.30,     // Phase 1-5: TP 30% consistent winner (was 0.50)
  creditStopLossMultiple: 100,  // Phase 1-5: no SL, defined risk (was 2.0)
  creditTimeStopDTE: 5,
  monitoringIntervalDays: 1,
  minIVRank: 0,
  // Trust default: realistic fills (bid/ask + dynamic impact), not mid.
  fillMode: 'bidask' as FillMode,
  slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true },
  // Safeguard: force-close after 3 consecutive missing-chain days so the boundary
  // date never lands on sparse coverage and marks the position at intrinsic.
  missingChainExitAfterDays: 3,
  commissionPerLeg: 0,
};

export const DEFAULT_CREDIT_CONFIG: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'CREDIT_SPREAD',
  monitoringIntervalDays: 1,
  minIVRank: 20,              // WFA v2: IV >= 20% structural filter
};

/**
 * Short-term (1-2 week) credit spread config.
 * Targets 7-21 DTE with tighter spreads, further OTM deltas,
 * and faster profit targets. Derived from the validated 45-65 DTE strategy.
 */
export const DEFAULT_SHORT_CREDIT_CONFIG: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'CREDIT_SPREAD',
  creditShortDelta: 0.45,       // WFA validated: d45
  creditSpreadWidth: 10,        // WFA validated: w10
  creditDTERange: [7, 21],      // 1-3 week expiries
  creditProfitTarget: 0.50,     // WFA validated: tp50
  creditStopLossMultiple: 100,  // No SL (defined risk)
  creditTimeStopDTE: 1,         // Close 1 day before expiry (pin risk)
  monitoringIntervalDays: 1,    // Daily monitoring (essential for short DTE)
  minIVRank: 20,                // WFA validated: iv20
  fillMode: 'bidask' as FillMode,
  slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true },
};

// DEFAULT_DEBIT_CONFIG and DEFAULT_SWING_LONG_OPTION_CONFIG removed 2026-03-30
// (retired strategies — archived to archived/backtest/)

// ── Trading Day Helpers ──────────────────────────────────

/**
 * Given a sorted list of all trading dates, find the next N-th trading day after `date`.
 */
function advanceTradingDays(allDates: string[], fromDate: string, n: number): string | null {
  const idx = allDates.indexOf(fromDate);
  if (idx < 0) {
    // Find the next available date after fromDate
    const nextIdx = allDates.findIndex(d => d > fromDate);
    if (nextIdx < 0) return null;
    return allDates[Math.min(nextIdx + n - 1, allDates.length - 1)] ?? null;
  }
  const targetIdx = idx + n;
  return targetIdx < allDates.length ? allDates[targetIdx] : null;
}

/**
 * Get all monitoring dates between entry and a max date.
 */
function getMonitoringDates(
  allDates: string[],
  entryDate: string,
  intervalDays: number,
  maxDate: string,
): string[] {
  const dates: string[] = [];
  let current = entryDate;
  while (true) {
    const next = advanceTradingDays(allDates, current, intervalDays);
    if (!next || next > maxDate) break;
    dates.push(next);
    current = next;
  }
  return dates;
}

// ── Simulation Core ──────────────────────────────────────

/**
 * Simulate a single LEAP trade.
 * Entry: buy deep ITM call/put. Exit: profit target, stop loss, time stop, or expiration.
 */
export async function simulateLeap(
  token: string,
  signal: EntrySignal,
  config: SimConfig,
  allTradingDates: string[],
  maxDate: string,
): Promise<OptionTrade | null> {
  // Fetch entry day chain
  const entryChain = await fetchHistoricalChain(
    token, signal.ticker, signal.date,
    [0.01, 0.99],  // wide delta range to capture deep ITM/OTM
  );
  if (entryChain.length === 0) return null;

  // Determine option type based on signal direction
  const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Call' : 'Put';

  // Find the target delta strike
  const targetDelta = (config.leapDeltaRange[0] + config.leapDeltaRange[1]) / 2;
  const entry = findStrikeByDelta(entryChain, targetDelta, optionType, config.leapDTERange);
  if (!entry || entry.mid <= 0) return null;

  // Apply fill model to LEAP entry (buyer pays ask + impact)
  let entryPrice: number;
  if (config.fillMode === 'bidask' && config.slippage.enabled) {
    const fill = applyFill('bidask', entry.mid, entry.bid, entry.ask, 'buy',
      config.slippage, entry.oi, entry.row.dte);
    entryPrice = fill.fillPrice;
  } else {
    entryPrice = entry.mid;
  }

  const tpPrice = entryPrice * (1 + config.leapProfitTarget);
  const slPrice = entryPrice * (1 - config.leapStopLoss);

  // Cap monitoring at the option's expiry date (not OOS end)
  const monitorEnd = entry.row.expir_date < maxDate ? entry.row.expir_date : maxDate;

  // Get monitoring dates
  const monitorDates = getMonitoringDates(
    allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd,
  );

  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

  // Monitor the position
  for (const checkDate of monitorDates) {
    const chain = await fetchHistoricalChain(token, signal.ticker, checkDate, [0.01, 0.99]);
    if (chain.length === 0) continue;

    // Find the same contract
    const current = findContract(chain, entry.row.strike, entry.row.expir_date, optionType);
    if (!current) continue;

    const currentDTE = current.row.dte;

    // Apply fill model to exit (seller receives bid - impact)
    let currentPrice: number;
    if (config.fillMode === 'bidask' && config.slippage.enabled) {
      const fill = applyFill('bidask', current.mid, current.bid, current.ask, 'sell',
        config.slippage, current.oi, current.row.dte);
      currentPrice = fill.fillPrice;
    } else {
      currentPrice = current.mid;
    }

    // Record daily mark-to-market at fair value (mid). currentPrice (with
    // exit slippage) is reserved for actual close pricing downstream.
    dailyMtM.push({
      date: checkDate,
      spreadMid: current.mid,
      unrealizedPnl: (current.mid - entryPrice) * 100,
    });

    // Check exit conditions
    let exitType: OptionExitType | null = null;

    if (currentPrice >= tpPrice) {
      exitType = 'PROFIT_TARGET';
    } else if (currentPrice <= slPrice) {
      exitType = 'STOP_LOSS';
    } else if (currentDTE <= config.leapTimeStopDTE) {
      exitType = 'TIME_STOP';
    }

    if (exitType) {
      return buildLeapTrade(
        signal,
        entry,
        entryPrice,
        checkDate,
        currentPrice,
        currentDTE,
        current.row.stock_price,
        exitType,
        dailyMtM,
        {
          entrySlippage: config.fillMode === 'bidask' && config.slippage.enabled ? (entryPrice - entry.mid) : 0,
          exitSlippage: config.fillMode === 'bidask' && config.slippage.enabled ? (current.mid - currentPrice) : 0,
          fillMode: config.fillMode,
        },
      );
    }
  }

  // Close at last monitoring date if no exit triggered
  const lastDate = monitorDates[monitorDates.length - 1];
  if (lastDate) {
    const chain = await fetchHistoricalChain(token, signal.ticker, lastDate, [0.01, 0.99]);
    const current = findContract(chain, entry.row.strike, entry.row.expir_date, optionType);
    // At expiry: intrinsic value
    let exitPrice: number;
    let exitSlippage = 0;
    if (current) {
      if (config.fillMode === 'bidask' && config.slippage.enabled) {
        const fill = applyFill('bidask', current.mid, current.bid, current.ask, 'sell',
          config.slippage, current.oi, current.row.dte);
        exitPrice = fill.fillPrice;
        exitSlippage = fill.slippage;
      } else {
        exitPrice = current.mid;
      }
    } else {
      // Compute intrinsic value as fallback
      const lastChain = chain.length > 0 ? chain[0].stock_price : entry.row.stock_price;
      exitPrice = optionType === 'Call'
        ? Math.max(0, lastChain - entry.row.strike)
        : Math.max(0, entry.row.strike - lastChain);
    }

    return buildLeapTrade(
      signal,
      entry,
      entryPrice,
      lastDate,
      exitPrice,
      current?.row.dte ?? 0,
      current?.row.stock_price ?? entry.row.stock_price,
      'EXPIRATION',
      dailyMtM,
      {
        entrySlippage: config.fillMode === 'bidask' && config.slippage.enabled ? (entryPrice - entry.mid) : 0,
        exitSlippage,
        fillMode: config.fillMode,
      },
    );
  }

  return null;
}

export function buildLeapTrade(
  signal: EntrySignal,
  entry: StrikeMatch,
  entryPrice: number,
  exitDate: string,
  exitPrice: number,
  exitDTE: number,
  exitStockPrice: number,
  exitType: OptionExitType,
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[],
  opts: {
    entrySlippage?: number;
    exitSlippage?: number;
    fillMode?: FillMode;
  } = {},
): OptionTrade {
  const pnl = (exitPrice - entryPrice) * 100;
  const pnlPct = (exitPrice - entryPrice) / entryPrice;
  const holdDays = Math.round(
    (new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000
  );

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
    pnlPct,
    holdDays,
    ivRank: signal.ivRank,
    dailyMtM,
    entrySlippage: opts.entrySlippage,
    exitSlippage: opts.exitSlippage,
    fillMode: opts.fillMode,
  };
}

/**
 * Simulate a single credit spread trade.
 * Entry: sell OTM spread (bull put or bear call). Exit: profit target, stop loss, time stop.
 */
export async function simulateCreditSpread(
  token: string,
  signal: EntrySignal,
  config: SimConfig,
  allTradingDates: string[],
  maxDate: string,
): Promise<OptionTrade | null> {
  // IV rank filter
  if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) {
    return null;
  }

  // v2: Volatility & microstructure filters (from ORATS cores enrichment)
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

  // Direction confidence tier gate
  if (config.dirConfTier && config.dirConfTier !== 'any' && signal.dirConfidence != null) {
    if (signal.dirConfidence < DIR_CONF_THRESHOLDS[config.dirConfTier]) return null;
  }

  // Fetch entry day chain
  const entryChain = await fetchHistoricalChain(
    token, signal.ticker, signal.date,
    [0.01, 0.99],
  );
  if (entryChain.length === 0) return null;

  // Credit spread: sell puts in uptrend (CALL signal), sell calls in downtrend (PUT signal)
  const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';

  const spread = findSpreadStrikes(
    entryChain,
    config.creditShortDelta,
    config.creditSpreadWidth,
    optionType,
    config.creditDTERange,
  );
  if (!spread || spread.netCredit <= 0) return null;

  // --- ORATS liquidity & Greeks filters (sweepable via WFASweepDimension) ---
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
      const ratio = spread.short.row.gamma / theta;
      if (ratio > config.maxGammaThetaRatio) return null;
    }
  }

  if (config.maxIVSkew != null && config.maxIVSkew !== Infinity) {
    const skew = Math.abs(spread.short.iv - spread.long.iv);
    if (skew > config.maxIVSkew) return null;
  }

  // Apply fill model to entry
  let entryCredit: number;
  let entrySlippage = 0;
  const grossEntryCredit = spread.netCredit;
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
    if (entryCredit <= 0) return null; // no credit after slippage → skip
  } else {
    entryCredit = spread.netCredit;
  }

  const thresholds = computeCreditSpreadThresholds(config, spread, entryCredit);

  // Trailing profit lock state
  let trailingFloorActive = false;
  let trailingFloorCost = Infinity;
  let missingChainState = createMissingChainState();
  let lastValidSpreadCost: number | null = null;
  let lastKnownStockPrice = spread.short.row.stock_price;

  // Cap monitoring at the option's expiry date
  const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;

  const monitorDates = getMonitoringDates(
    allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd,
  );

  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

  for (const checkDate of monitorDates) {
    let shortLeg, longLeg;
    let chain: Awaited<ReturnType<typeof fetchHistoricalChain>> | null = null;
    if (config.useDirectLookup) {
      shortLeg = findContractDirect(signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      longLeg = findContractDirect(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    } else {
      chain = await fetchHistoricalChain(token, signal.ticker, checkDate, [0.01, 0.99]);
      shortLeg = chain.length > 0
        ? findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType)
        : null;
      longLeg = chain.length > 0
        ? findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType)
        : null;
    }
    if ((!shortLeg || !longLeg) && config.useDirectLookup) {
      chain = await fetchHistoricalChain(token, signal.ticker, checkDate, [0.01, 0.99]);
    }
    const monitoringStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? chain?.[0]?.stock_price;
    if (monitoringStockPrice != null && Number.isFinite(monitoringStockPrice)) {
      lastKnownStockPrice = monitoringStockPrice;
    }

    const hasValidLegs = Boolean(shortLeg && longLeg);
    missingChainState = updateMissingChainState(missingChainState, hasValidLegs);
    if (!hasValidLegs) {
      if (shouldExitNoChain(config, missingChainState)) {
        const intrinsicCost = monitoringStockPrice != null && Number.isFinite(monitoringStockPrice)
          ? computeIntrinsicSpreadCloseCost(
              optionType,
              spread.short.row.strike,
              spread.long.row.strike,
              monitoringStockPrice,
              thresholds.actualWidth,
            )
          : null;
        const noChainMark = Math.max(
          lastValidSpreadCost ?? thresholds.boundedEntryCredit,
          intrinsicCost ?? thresholds.boundedEntryCredit,
        );
        const grossExitCost = resolveTriggeredCreditExitCost('NO_CHAIN', noChainMark, thresholds);
        return buildCreditResult(
          signal,
          spread,
          entryCredit,
          checkDate,
          grossExitCost,
          shortLeg?.row.dte ?? longLeg?.row.dte ?? chain?.[0]?.dte ?? 0,
          lastResortStockPrice(spread.short.row.stock_price, monitoringStockPrice ?? lastKnownStockPrice),
          'NO_CHAIN',
          {
            grossEntryCredit,
            grossExitSpreadCost: grossExitCost,
            dailyMtM,
            entrySlippage,
            entryCommission,
            exitCommission,
            fillMode: config.fillMode,
          },
        );
      }
      continue;
    }
    const resolvedShortLeg = shortLeg!;
    const resolvedLongLeg = longLeg!;

    // Apply fill model to exit monitoring
    const grossCurrentSpreadCost = clampSpreadCloseCost(
      resolvedShortLeg.mid - resolvedLongLeg.mid,
      thresholds.actualWidth,
    );
    let currentSpreadCost: number;
    let exitSlippageAmount = 0;
    if (config.fillMode === 'bidask' && config.slippage.enabled) {
      if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
        const spreadFill = applySpreadFill(
          'bidask',
          { ...resolvedShortLeg, dte: resolvedShortLeg.row.dte },
          { ...resolvedLongLeg, dte: resolvedLongLeg.row.dte },
          'close',
          config.slippage,
        );
        currentSpreadCost = spreadFill.fillPrice;
        exitSlippageAmount = spreadFill.slippage;
      } else {
        // To close: buy back short (pay ask), sell long (receive bid)
        const shortClose = applyFill('bidask', resolvedShortLeg.mid, resolvedShortLeg.bid,
          resolvedShortLeg.ask, 'buy', config.slippage, resolvedShortLeg.oi, resolvedShortLeg.row.dte);
        const longClose = applyFill('bidask', resolvedLongLeg.mid, resolvedLongLeg.bid,
          resolvedLongLeg.ask, 'sell', config.slippage, resolvedLongLeg.oi, resolvedLongLeg.row.dte);
        currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
        exitSlippageAmount = shortClose.slippage + longClose.slippage;
      }
    } else {
      currentSpreadCost = grossCurrentSpreadCost;
    }
    currentSpreadCost = clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth);
    const currentDTE = resolvedShortLeg.row.dte;
    lastValidSpreadCost = currentSpreadCost;

    // Record daily mark-to-market at fair value (mid). Exit slippage is
    // realized only when the trade actually closes — baking it into every
    // monitoring day would double-count it and systematically depress
    // daily Sharpe / inflate MaxDD under bid/ask fills.
    dailyMtM.push({
      date: checkDate,
      spreadMid: grossCurrentSpreadCost,
      unrealizedPnl: (entryCredit - grossCurrentSpreadCost) * 100,
    });

    let exitType: OptionExitType | null = null;

    // Update trailing lock state (must happen before exit checks)
    if (config.trailingActivatePct != null && config.trailingFloorPct != null) {
      const unrealizedProfit = entryCredit - grossCurrentSpreadCost;
      const activationProfit = config.trailingActivatePct * thresholds.tpProfit;
      if (!trailingFloorActive && unrealizedProfit >= activationProfit) {
        trailingFloorActive = true;
        trailingFloorCost = clampSpreadCloseCost(
          thresholds.boundedEntryCredit - (config.trailingFloorPct * thresholds.tpProfit),
          thresholds.actualWidth,
        );
      }
    }

    if (grossCurrentSpreadCost <= thresholds.tpCost) {
      exitType = 'PROFIT_TARGET';
    } else if (grossCurrentSpreadCost >= thresholds.slCost) {
      exitType = 'STOP_LOSS';
    } else if (grossCurrentSpreadCost >= thresholds.maxLossStopCost) {
      exitType = 'MAX_LOSS_STOP';
    } else if (
      config.creditDeltaStop != null &&
      Number.isFinite(config.creditDeltaStop) &&
      config.creditDeltaStop > 0 &&
      Math.abs(resolvedShortLeg.delta) >= config.creditDeltaStop
    ) {
      exitType = 'DELTA_STOP';
    } else if (trailingFloorActive && grossCurrentSpreadCost > trailingFloorCost) {
      exitType = 'TRAILING_LOCK';
    } else if (currentDTE <= config.creditTimeStopDTE) {
      exitType = 'TIME_STOP';
    }

    if (exitType) {
      const grossExitCost = resolveTriggeredCreditExitCost(exitType, grossCurrentSpreadCost, thresholds, {
        trailingFloorCost,
      });
      const exitCost = clampSpreadCloseCost(grossExitCost + exitSlippageAmount, thresholds.actualWidth);
      return buildCreditResult(signal, spread, entryCredit, checkDate, exitCost,
        currentDTE, resolvedShortLeg.row.stock_price, exitType,
        {
          grossEntryCredit,
          grossExitSpreadCost: grossExitCost,
          dailyMtM,
          entrySlippage,
          exitSlippage: exitSlippageAmount,
          entryCommission,
          exitCommission,
          fillMode: config.fillMode,
        });
    }
  }

  // Close at last monitoring date or expiry
  const lastDate = monitorDates[monitorDates.length - 1] ?? monitorEnd;
  if (lastDate) {
    let shortLeg, longLeg;
    let chain: Awaited<ReturnType<typeof fetchHistoricalChain>> | null = null;
    if (config.useDirectLookup) {
      shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    } else {
      chain = await fetchHistoricalChain(token, signal.ticker, lastDate, [0.01, 0.99]);
      shortLeg = findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType);
      longLeg = findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType);
    }
    if ((!shortLeg || !longLeg) && config.useDirectLookup) {
      chain = await fetchHistoricalChain(token, signal.ticker, lastDate, [0.01, 0.99]);
    }
    const fallbackStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? chain?.[0]?.stock_price;

    let grossCurrentSpreadCost: number;
    let currentSpreadCost: number;
    let exitSlippageAmount = 0;
    if (shortLeg && longLeg) {
      grossCurrentSpreadCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, thresholds.actualWidth);
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
      } else {
        currentSpreadCost = grossCurrentSpreadCost;
      }
    } else {
      const stockPrice = lastResortStockPrice(
        spread.short.row.stock_price,
        fallbackStockPrice ?? lastKnownStockPrice,
      );
      grossCurrentSpreadCost = computeIntrinsicSpreadCloseCost(
        optionType,
        spread.short.row.strike,
        spread.long.row.strike,
        stockPrice,
        thresholds.actualWidth,
      );
      currentSpreadCost = grossCurrentSpreadCost;
    }

    return buildCreditResult(signal, spread, entryCredit, lastDate, currentSpreadCost,
      shortLeg?.row.dte ?? longLeg?.row.dte ?? chain?.[0]?.dte ?? 0,
      lastResortStockPrice(spread.short.row.stock_price, fallbackStockPrice ?? lastKnownStockPrice),
      'EXPIRATION',
      {
        grossEntryCredit,
        grossExitSpreadCost: grossCurrentSpreadCost,
        dailyMtM,
        entrySlippage,
        exitSlippage: exitSlippageAmount,
        entryCommission,
        exitCommission,
        fillMode: config.fillMode,
      });
  }

  return null;
}

interface BuildCreditOpts {
  grossEntryCredit?: number;
  grossExitSpreadCost?: number;
  overrideGrossPnl?: number;
  overrideNetPnl?: number;
  overrideNetPnlPct?: number;
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[];
  entrySlippage?: number;
  exitSlippage?: number;
  entryCommission?: number;
  exitCommission?: number;
  fillMode?: FillMode;
}

function lastResortStockPrice(
  fallbackStockPrice: number,
  overrideStockPrice?: number,
): number {
  return overrideStockPrice != null && Number.isFinite(overrideStockPrice)
    ? overrideStockPrice
    : fallbackStockPrice;
}

function buildCreditResult(
  signal: EntrySignal, spread: SpreadMatch, entryCredit: number,
  exitDate: string, exitSpreadCost: number, exitDTE: number,
  exitStockPrice: number, exitType: OptionExitType,
  opts: BuildCreditOpts = {},
): OptionTrade {
  return buildCreditSpreadTrade({
    signal,
    spread,
    entryCredit,
    grossEntryCredit: opts.grossEntryCredit,
    exitDate,
    exitSpreadCost,
    grossExitSpreadCost: opts.grossExitSpreadCost,
    exitDTE,
    exitStockPrice,
    exitType,
    dailyMtM: opts.dailyMtM,
    entrySlippage: opts.entrySlippage,
    exitSlippage: opts.exitSlippage,
    entryCommission: opts.entryCommission,
    exitCommission: opts.exitCommission,
    fillMode: opts.fillMode,
    overrideGrossPnl: opts.overrideGrossPnl,
    overrideNetPnl: opts.overrideNetPnl,
    overrideNetPnlPct: opts.overrideNetPnlPct,
  });
}

// ── Phased Take-Profit ───────────────────────────────────

export interface PhasedTPConfig {
  tp1: number;              // first TP level (e.g. 0.30 = 30% of max profit)
  tp2: number;              // second TP level (e.g. 0.50 = 50% of max profit)
  afterTP1SL: number;       // SL level after TP1 hit (-1 = no SL, 0 = breakeven, 0.25 = 25% profit)
}

/**
 * Simulate a credit spread with phased take-profit.
 *
 * Phase 1: Close half the position at TP1. Move SL to breakeven on remaining half.
 * Phase 2: Close remaining half at TP2, or at breakeven SL if it reverses.
 *
 * Returns a single OptionTrade with blended P&L from both phases.
 */
export async function simulateCreditSpreadPhased(
  token: string,
  signal: EntrySignal,
  config: SimConfig,
  phasedConfig: PhasedTPConfig,
  allTradingDates: string[],
  maxDate: string,
): Promise<OptionTrade | null> {
  // IV rank filter
  if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) {
    return null;
  }

  const entryChain = await fetchHistoricalChain(token, signal.ticker, signal.date, [0.01, 0.99]);
  if (entryChain.length === 0) return null;

  const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';

  const spread = findSpreadStrikes(
    entryChain, config.creditShortDelta, config.creditSpreadWidth,
    optionType, config.creditDTERange,
  );
  if (!spread || spread.netCredit <= 0) return null;

  // --- ORATS liquidity & Greeks filters (mirror simulateCreditSpread) ---
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
      const ratio = spread.short.row.gamma / theta;
      if (ratio > config.maxGammaThetaRatio) return null;
    }
  }

  if (config.maxIVSkew != null && config.maxIVSkew !== Infinity) {
    const skew = Math.abs(spread.short.iv - spread.long.iv);
    if (skew > config.maxIVSkew) return null;
  }

  const grossEntryCredit = spread.netCredit;
  const { entryCommission, exitCommission } = resolveCreditSpreadCommissions(config);
  let entryCredit = spread.netCredit;
  let entrySlippage = 0;
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
      const shortFill = applyFill(
        'bidask',
        spread.short.mid,
        spread.short.bid,
        spread.short.ask,
        'sell',
        config.slippage,
        spread.short.oi,
        spread.short.row.dte,
      );
      const longFill = applyFill(
        'bidask',
        spread.long.mid,
        spread.long.bid,
        spread.long.ask,
        'buy',
        config.slippage,
        spread.long.oi,
        spread.long.row.dte,
      );
      entryCredit = shortFill.fillPrice - longFill.fillPrice;
      entrySlippage = shortFill.slippage + longFill.slippage;
    }
    if (entryCredit <= 0) return null;
  }

  const thresholds = computeCreditSpreadThresholds(config, spread, entryCredit);
  const tp1Cost = clampSpreadCloseCost(
    thresholds.boundedEntryCredit * (1 - phasedConfig.tp1),
    thresholds.actualWidth,
  );
  const tp2Cost = clampSpreadCloseCost(
    thresholds.boundedEntryCredit * (1 - phasedConfig.tp2),
    thresholds.actualWidth,
  );
  const afterTP1SLCost = clampSpreadCloseCost(
    thresholds.boundedEntryCredit * (1 - phasedConfig.afterTP1SL),
    thresholds.actualWidth,
  );

  const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;
  const monitorDates = getMonitoringDates(
    allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd,
  );

  // Phase tracking
  let phase: 'FULL' | 'HALF' = 'FULL';
  let halfGrossPnl = 0;        // Gross P&L from the first half (set when TP1 hit)
  let halfNetPnl = 0;          // Net P&L before commissions from the first half
  let totalExitSlippage = 0;   // Weighted total exit slippage across both half-closes
  let missingChainState = createMissingChainState();
  let lastValidSpreadCost: number | null = null;
  let lastKnownStockPrice = spread.short.row.stock_price;

  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

  for (const checkDate of monitorDates) {
    let shortLeg, longLeg;
    let chain: Awaited<ReturnType<typeof fetchHistoricalChain>> | null = null;
    if (config.useDirectLookup) {
      shortLeg = findContractDirect(signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      longLeg = findContractDirect(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    } else {
      chain = await fetchHistoricalChain(token, signal.ticker, checkDate, [0.01, 0.99]);
      shortLeg = chain.length > 0
        ? findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType)
        : null;
      longLeg = chain.length > 0
        ? findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType)
        : null;
    }
    if ((!shortLeg || !longLeg) && config.useDirectLookup) {
      chain = await fetchHistoricalChain(token, signal.ticker, checkDate, [0.01, 0.99]);
    }
    const monitoringStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? chain?.[0]?.stock_price;
    if (monitoringStockPrice != null && Number.isFinite(monitoringStockPrice)) {
      lastKnownStockPrice = monitoringStockPrice;
    }
    const hasValidLegs = Boolean(shortLeg && longLeg);
    missingChainState = updateMissingChainState(missingChainState, hasValidLegs);
    if (!hasValidLegs) {
      if (shouldExitNoChain(config, missingChainState)) {
        const intrinsicCost = monitoringStockPrice != null && Number.isFinite(monitoringStockPrice)
          ? computeIntrinsicSpreadCloseCost(
              optionType,
              spread.short.row.strike,
              spread.long.row.strike,
              monitoringStockPrice,
              thresholds.actualWidth,
            )
          : null;
        const noChainCost = resolveTriggeredCreditExitCost(
          'NO_CHAIN',
          Math.max(
            lastValidSpreadCost ?? thresholds.boundedEntryCredit,
            intrinsicCost ?? thresholds.boundedEntryCredit,
          ),
          thresholds,
        );
        const secondHalfGrossPnl = phase === 'HALF'
          ? (grossEntryCredit - noChainCost) * 0.5 * 100
          : 0;
        const secondHalfNetPnl = phase === 'HALF'
          ? (entryCredit - noChainCost) * 0.5 * 100
          : 0;
        const totalGrossPnl = phase === 'HALF'
          ? halfGrossPnl + secondHalfGrossPnl
          : (grossEntryCredit - noChainCost) * 100;
        const totalPnl = phase === 'HALF'
          ? halfNetPnl + secondHalfNetPnl - entryCommission - exitCommission
          : (entryCredit - noChainCost) * 100 - entryCommission - exitCommission;
        return buildCreditResult(
          signal,
          spread,
          entryCredit,
          checkDate,
          noChainCost,
          shortLeg?.row.dte ?? longLeg?.row.dte ?? chain?.[0]?.dte ?? 0,
          lastResortStockPrice(spread.short.row.stock_price, monitoringStockPrice ?? lastKnownStockPrice),
          'NO_CHAIN',
          {
            grossEntryCredit,
            grossExitSpreadCost: noChainCost,
            overrideNetPnl: totalPnl,
            overrideGrossPnl: totalGrossPnl,
            overrideNetPnlPct: thresholds.maxLoss > 0 ? totalPnl / (thresholds.maxLoss * 100) : 0,
            dailyMtM,
            entrySlippage,
            exitSlippage: totalExitSlippage,
            entryCommission,
            exitCommission,
            fillMode: config.fillMode,
          },
        );
      }
      continue;
    }
    const resolvedShortLeg = shortLeg!;
    const resolvedLongLeg = longLeg!;

    const grossCurrentSpreadCost = clampSpreadCloseCost(
      resolvedShortLeg.mid - resolvedLongLeg.mid,
      thresholds.actualWidth,
    );
    let currentSpreadCost = grossCurrentSpreadCost;
    let exitSlippageAmount = 0;
    if (config.fillMode === 'bidask' && config.slippage.enabled) {
      if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
        const spreadFill = applySpreadFill(
          'bidask',
          { ...resolvedShortLeg, dte: resolvedShortLeg.row.dte },
          { ...resolvedLongLeg, dte: resolvedLongLeg.row.dte },
          'close',
          config.slippage,
        );
        currentSpreadCost = spreadFill.fillPrice;
        exitSlippageAmount = spreadFill.slippage;
      } else {
        const shortClose = applyFill(
          'bidask',
          resolvedShortLeg.mid,
          resolvedShortLeg.bid,
          resolvedShortLeg.ask,
          'buy',
          config.slippage,
          resolvedShortLeg.oi,
          resolvedShortLeg.row.dte,
        );
        const longClose = applyFill(
          'bidask',
          resolvedLongLeg.mid,
          resolvedLongLeg.bid,
          resolvedLongLeg.ask,
          'sell',
          config.slippage,
          resolvedLongLeg.oi,
          resolvedLongLeg.row.dte,
        );
        currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
        exitSlippageAmount = shortClose.slippage + longClose.slippage;
      }
    }
    currentSpreadCost = clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth);
    const currentDTE = resolvedShortLeg.row.dte;
    lastValidSpreadCost = currentSpreadCost;

    // Record daily mark-to-market at fair value (phase-aware). Same
    // reasoning as the standard path: slippage applies only on actual close.
    dailyMtM.push({
      date: checkDate,
      spreadMid: grossCurrentSpreadCost,
      unrealizedPnl: phase === 'FULL'
        ? (entryCredit - grossCurrentSpreadCost) * 100
        : halfNetPnl + (entryCredit - grossCurrentSpreadCost) * 0.5 * 100,
    });

    if (phase === 'FULL') {
      // Check TP1 (close half)
      if (grossCurrentSpreadCost <= tp1Cost) {
        phase = 'HALF';
        const tp1ExitCost = clampSpreadCloseCost(tp1Cost + exitSlippageAmount, thresholds.actualWidth);
        halfGrossPnl = (grossEntryCredit - tp1Cost) * 0.5 * 100;
        halfNetPnl = (entryCredit - tp1ExitCost) * 0.5 * 100;
        totalExitSlippage += exitSlippageAmount * 0.5;
        // (date/type tracked by phase state)
        continue;  // keep monitoring the remaining half
      }

      // Check original SL (full position)
      if (grossCurrentSpreadCost >= thresholds.slCost) {
        const grossExitCost = resolveTriggeredCreditExitCost('STOP_LOSS', grossCurrentSpreadCost, thresholds);
        const exitCost = clampSpreadCloseCost(grossExitCost + exitSlippageAmount, thresholds.actualWidth);
        const grossPnl = (grossEntryCredit - grossExitCost) * 100;
        const pnl = (entryCredit - exitCost) * 100 - entryCommission - exitCommission;
        return buildCreditResult(
          signal, spread, entryCredit, checkDate, exitCost,
          currentDTE, resolvedShortLeg.row.stock_price, 'STOP_LOSS',
          {
            grossEntryCredit,
            grossExitSpreadCost: grossExitCost,
            dailyMtM,
            entrySlippage,
            exitSlippage: exitSlippageAmount,
            entryCommission,
            exitCommission,
            fillMode: config.fillMode,
            overrideGrossPnl: grossPnl,
            overrideNetPnl: pnl,
            overrideNetPnlPct: thresholds.maxLoss > 0 ? pnl / (thresholds.maxLoss * 100) : 0,
          },
        );
      }

      // Check time stop (full position)
      if (currentDTE <= config.creditTimeStopDTE) {
        const grossExitCost = resolveTriggeredCreditExitCost('TIME_STOP', grossCurrentSpreadCost, thresholds);
        const exitCost = clampSpreadCloseCost(grossExitCost + exitSlippageAmount, thresholds.actualWidth);
        const grossPnl = (grossEntryCredit - grossExitCost) * 100;
        const pnl = (entryCredit - exitCost) * 100 - entryCommission - exitCommission;
        return buildCreditResult(
          signal, spread, entryCredit, checkDate, exitCost,
          currentDTE, resolvedShortLeg.row.stock_price, 'TIME_STOP',
          {
            grossEntryCredit,
            grossExitSpreadCost: grossExitCost,
            dailyMtM,
            entrySlippage,
            exitSlippage: exitSlippageAmount,
            entryCommission,
            exitCommission,
            fillMode: config.fillMode,
            overrideGrossPnl: grossPnl,
            overrideNetPnl: pnl,
            overrideNetPnlPct: thresholds.maxLoss > 0 ? pnl / (thresholds.maxLoss * 100) : 0,
          },
        );
      }
    } else {
      // phase === 'HALF' — remaining half with breakeven SL

      // Check TP2 (close remaining half)
      if (grossCurrentSpreadCost <= tp2Cost) {
        const grossExitCost = resolveTriggeredCreditExitCost('PROFIT_TARGET_2', grossCurrentSpreadCost, thresholds, {
          overrideThresholdCost: tp2Cost,
        });
        const exitCost = clampSpreadCloseCost(grossExitCost + exitSlippageAmount, thresholds.actualWidth);
        const secondHalfGrossPnl = (grossEntryCredit - grossExitCost) * 0.5 * 100;
        const secondHalfNetPnl = (entryCredit - exitCost) * 0.5 * 100;
        const totalGrossPnl = halfGrossPnl + secondHalfGrossPnl;
        const totalPnl = halfNetPnl + secondHalfNetPnl - entryCommission - exitCommission;
        return buildCreditResult(
          signal, spread, entryCredit, checkDate, exitCost,
          currentDTE, resolvedShortLeg.row.stock_price, 'PROFIT_TARGET_2',
          {
            grossEntryCredit,
            grossExitSpreadCost: grossExitCost,
            dailyMtM,
            entrySlippage,
            exitSlippage: totalExitSlippage + (exitSlippageAmount * 0.5),
            entryCommission,
            exitCommission,
            fillMode: config.fillMode,
            overrideGrossPnl: totalGrossPnl,
            overrideNetPnl: totalPnl,
            overrideNetPnlPct: thresholds.maxLoss > 0 ? totalPnl / (thresholds.maxLoss * 100) : 0,
          },
        );
      }

      // Check after-TP1 SL on remaining half
      if (phasedConfig.afterTP1SL >= 0 && grossCurrentSpreadCost >= afterTP1SLCost) {
        const grossExitCost = resolveTriggeredCreditExitCost('SL_BREAKEVEN', grossCurrentSpreadCost, thresholds, {
          overrideThresholdCost: afterTP1SLCost,
        });
        const exitCost = clampSpreadCloseCost(grossExitCost + exitSlippageAmount, thresholds.actualWidth);
        const secondHalfGrossPnl = (grossEntryCredit - grossExitCost) * 0.5 * 100;
        const secondHalfNetPnl = (entryCredit - exitCost) * 0.5 * 100;
        const totalGrossPnl = halfGrossPnl + secondHalfGrossPnl;
        const totalPnl = halfNetPnl + secondHalfNetPnl - entryCommission - exitCommission;
        return buildCreditResult(
          signal, spread, entryCredit, checkDate, exitCost,
          currentDTE, resolvedShortLeg.row.stock_price, 'SL_BREAKEVEN',
          {
            grossEntryCredit,
            grossExitSpreadCost: grossExitCost,
            dailyMtM,
            entrySlippage,
            exitSlippage: totalExitSlippage + (exitSlippageAmount * 0.5),
            entryCommission,
            exitCommission,
            fillMode: config.fillMode,
            overrideGrossPnl: totalGrossPnl,
            overrideNetPnl: totalPnl,
            overrideNetPnlPct: thresholds.maxLoss > 0 ? totalPnl / (thresholds.maxLoss * 100) : 0,
          },
        );
      }

      // Check time stop (remaining half)
      if (currentDTE <= config.creditTimeStopDTE) {
        const grossExitCost = resolveTriggeredCreditExitCost('TIME_STOP', grossCurrentSpreadCost, thresholds);
        const exitCost = clampSpreadCloseCost(grossExitCost + exitSlippageAmount, thresholds.actualWidth);
        const secondHalfGrossPnl = (grossEntryCredit - grossExitCost) * 0.5 * 100;
        const secondHalfNetPnl = (entryCredit - exitCost) * 0.5 * 100;
        const totalGrossPnl = halfGrossPnl + secondHalfGrossPnl;
        const totalPnl = halfNetPnl + secondHalfNetPnl - entryCommission - exitCommission;
        return buildCreditResult(
          signal, spread, entryCredit, checkDate, exitCost,
          currentDTE, resolvedShortLeg.row.stock_price, 'TIME_STOP',
          {
            grossEntryCredit,
            grossExitSpreadCost: grossExitCost,
            dailyMtM,
            entrySlippage,
            exitSlippage: totalExitSlippage + (exitSlippageAmount * 0.5),
            entryCommission,
            exitCommission,
            fillMode: config.fillMode,
            overrideGrossPnl: totalGrossPnl,
            overrideNetPnl: totalPnl,
            overrideNetPnlPct: thresholds.maxLoss > 0 ? totalPnl / (thresholds.maxLoss * 100) : 0,
          },
        );
      }
    }
  }

  // Close at last monitoring date
  const lastDate = monitorDates[monitorDates.length - 1] ?? monitorEnd;
  if (lastDate) {
    let shortLeg, longLeg;
    let chain: Awaited<ReturnType<typeof fetchHistoricalChain>> | null = null;
    if (config.useDirectLookup) {
      shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    } else {
      chain = await fetchHistoricalChain(token, signal.ticker, lastDate, [0.01, 0.99]);
      shortLeg = findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType);
      longLeg = findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType);
    }
    if ((!shortLeg || !longLeg) && config.useDirectLookup) {
      chain = await fetchHistoricalChain(token, signal.ticker, lastDate, [0.01, 0.99]);
    }
    const fallbackStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? chain?.[0]?.stock_price;

    let grossCurrentSpreadCost: number;
    let currentSpreadCost: number;
    let exitSlippageAmount = 0;
    if (shortLeg && longLeg) {
      grossCurrentSpreadCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, thresholds.actualWidth);
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
          const shortClose = applyFill(
            'bidask',
            shortLeg.mid,
            shortLeg.bid,
            shortLeg.ask,
            'buy',
            config.slippage,
            shortLeg.oi,
            shortLeg.row.dte,
          );
          const longClose = applyFill(
            'bidask',
            longLeg.mid,
            longLeg.bid,
            longLeg.ask,
            'sell',
            config.slippage,
            longLeg.oi,
            longLeg.row.dte,
          );
          currentSpreadCost = clampSpreadCloseCost(shortClose.fillPrice - longClose.fillPrice, thresholds.actualWidth);
          exitSlippageAmount = shortClose.slippage + longClose.slippage;
        }
      } else {
        currentSpreadCost = grossCurrentSpreadCost;
      }
    } else {
      const stockPrice = lastResortStockPrice(
        spread.short.row.stock_price,
        fallbackStockPrice ?? lastKnownStockPrice,
      );
      grossCurrentSpreadCost = computeIntrinsicSpreadCloseCost(
        optionType,
        spread.short.row.strike,
        spread.long.row.strike,
        stockPrice,
        thresholds.actualWidth,
      );
      currentSpreadCost = grossCurrentSpreadCost;
    }

    if (phase === 'HALF') {
      const secondHalfGrossPnl = (grossEntryCredit - grossCurrentSpreadCost) * 0.5 * 100;
      const secondHalfNetPnl = (entryCredit - currentSpreadCost) * 0.5 * 100;
      const totalGrossPnl = halfGrossPnl + secondHalfGrossPnl;
      const totalPnl = halfNetPnl + secondHalfNetPnl - entryCommission - exitCommission;
      return buildCreditResult(
        signal, spread, entryCredit, lastDate, currentSpreadCost,
        shortLeg?.row.dte ?? longLeg?.row.dte ?? chain?.[0]?.dte ?? 0,
        lastResortStockPrice(spread.short.row.stock_price, fallbackStockPrice ?? lastKnownStockPrice),
        'EXPIRATION',
        {
          grossEntryCredit,
          grossExitSpreadCost: grossCurrentSpreadCost,
          dailyMtM,
          entrySlippage,
          exitSlippage: totalExitSlippage + (exitSlippageAmount * 0.5),
          entryCommission,
          exitCommission,
          fillMode: config.fillMode,
          overrideGrossPnl: totalGrossPnl,
          overrideNetPnl: totalPnl,
          overrideNetPnlPct: thresholds.maxLoss > 0 ? totalPnl / (thresholds.maxLoss * 100) : 0,
        },
      );
    } else {
      const grossPnl = (grossEntryCredit - grossCurrentSpreadCost) * 100;
      const pnl = (entryCredit - currentSpreadCost) * 100 - entryCommission - exitCommission;
      return buildCreditResult(
        signal, spread, entryCredit, lastDate, currentSpreadCost,
        shortLeg?.row.dte ?? longLeg?.row.dte ?? chain?.[0]?.dte ?? 0,
        lastResortStockPrice(spread.short.row.stock_price, fallbackStockPrice ?? lastKnownStockPrice),
        'EXPIRATION',
        {
          grossEntryCredit,
          grossExitSpreadCost: grossCurrentSpreadCost,
          dailyMtM,
          entrySlippage,
          exitSlippage: exitSlippageAmount,
          entryCommission,
          exitCommission,
          fillMode: config.fillMode,
          overrideGrossPnl: grossPnl,
          overrideNetPnl: pnl,
          overrideNetPnlPct: thresholds.maxLoss > 0 ? pnl / (thresholds.maxLoss * 100) : 0,
        },
      );
    }
  }

  return null;
}

// ── Analytics ────────────────────────────────────────────

export interface OptionSimAnalytics {
  mode: OptionMode;
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  avgPnlPct: number;
  totalPnl: number;           // total $ P&L (per contract × 100)
  totalCapitalDeployed: number; // sum of capital at risk per trade
  returnOnCapital: number;    // totalPnl / totalCapitalDeployed × 100
  profitFactor: number;
  tradeSharpeLegacy: number;
  dailyPortfolioSharpe?: number;
  // Deprecated transitional field: legacy trade-hold Sharpe.
  // Prefer `dailyPortfolioSharpe` when available, otherwise `tradeSharpeLegacy`.
  sharpe: number;
  realizedExitDrawdownPct: number;
  dailyMtMDrawdownPct?: number;
  metricBasis: 'trade_hold_legacy' | 'daily_portfolio';
  maxDrawdown: number;
  avgHoldDays: number;
  avgEntryDelta: number;
  avgEntryDTE: number;
  avgCapitalPerTrade: number; // avg $ at risk per trade
  byExit: Record<string, number>;
}

export function projectTradeToGrossPnlView(trade: OptionTrade): OptionTrade {
  const grossPnl = trade.grossPnl ?? trade.pnl;
  const actualWidth = trade.spreadWidth ?? ((trade.maxLoss ?? 0) + trade.entryPrice);
  const grossEntryCredit = Math.min(
    Math.max(0, trade.entryPrice + (trade.entrySlippage ?? 0)),
    actualWidth,
  );
  const grossMaxLoss = Math.max(0, actualWidth - grossEntryCredit);
  return {
    ...trade,
    pnl: grossPnl,
    pnlPct: grossMaxLoss > 0 ? grossPnl / (grossMaxLoss * 100) : trade.pnlPct,
    dailyMtM: trade.dailyMtM?.map(point => ({
      ...point,
      unrealizedPnl: point.unrealizedPnl + ((trade.entrySlippage ?? 0) * 100),
    })),
  };
}

export function projectTradesToGrossPnlView(trades: OptionTrade[]): OptionTrade[] {
  return trades.map(projectTradeToGrossPnlView);
}

function countWeekdaysInclusive(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return 0;

  let businessDays = 0;
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) businessDays++;
  }
  return businessDays;
}

function hasDenseDailyCoverage(observedDates: string[]): boolean {
  if (observedDates.length < 2) return false;
  const expectedDays = countWeekdaysInclusive(observedDates[0], observedDates[observedDates.length - 1]);
  if (expectedDays <= 0) return false;
  return observedDates.length / expectedDays >= 0.8;
}

/**
 * Options for computeOptionAnalytics.
 *
 * Pass `allTradingDates` to compute Sharpe/DD on the FULL trading calendar
 * (zero-PnL days padded for flat sessions). This is the correct behavior for
 * any strategy with `monitoringIntervalDays > 1` or sparse signal coverage —
 * see Codex finding T3-1 in .prompts/codex-trust-followups.md.
 *
 * Without `allTradingDates`, the function builds the calendar from observed
 * MtM/exit dates only (sparse-coverage fallback). This drops real flat days
 * and inflates annualized Sharpe; preserved for back-compat with legacy callers.
 */
export interface ComputeOptionAnalyticsOptions {
  /** Full trading calendar. When provided, drives Sharpe/DD on padded zero days. */
  allTradingDates?: string[];
  /** Restrict calendar to [start, end] inclusive. Defaults to min/max trade date. */
  range?: { start: string; end: string };
}

export function computeOptionAnalytics(
  trades: OptionTrade[],
  opts: ComputeOptionAnalyticsOptions = {},
): OptionSimAnalytics {
  if (trades.length === 0) {
    return {
      mode: 'LEAP', totalTrades: 0, winners: 0, losers: 0, winRate: 0,
      avgPnlPct: 0, totalPnl: 0, totalCapitalDeployed: 0, returnOnCapital: 0,
      profitFactor: 0, tradeSharpeLegacy: 0, dailyPortfolioSharpe: undefined,
      sharpe: 0, realizedExitDrawdownPct: 0, dailyMtMDrawdownPct: undefined,
      metricBasis: 'trade_hold_legacy', maxDrawdown: 0,
      avgHoldDays: 0, avgEntryDelta: 0, avgEntryDTE: 0, avgCapitalPerTrade: 0, byExit: {},
    };
  }

  const mode = trades[0].mode;
  const returns = trades.map(t => t.pnlPct);
  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);

  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(
    returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / Math.max(1, returns.length - 1)
  );

  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  // Sharpe: annualize assuming ~20 trades/year avg holding
  const avgHoldDays = trades.reduce((s, t) => s + t.holdDays, 0) / trades.length;
  const tradesPerYear = 252 / Math.max(1, avgHoldDays);
  const tradeSharpeLegacy = std > 0 ? (avgReturn / std) * Math.sqrt(tradesPerYear) : 0;

  // Max drawdown — sort by exit date so the equity curve reflects chronological PnL realization
  const STARTING_CAPITAL = 100_000;
  const tradesByExit = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  let equity = STARTING_CAPITAL, peak = STARTING_CAPITAL, maxDD = 0;
  for (const t of tradesByExit) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
  }

  // Exit type breakdown
  const byExit: Record<string, number> = {};
  for (const t of trades) {
    byExit[t.exitType] = (byExit[t.exitType] || 0) + 1;
  }

  // Capital deployed per trade: premium paid (LEAP) or max loss (credit spread)
  const capitalPerTrade = trades.map(t => {
    if (t.mode === 'CREDIT_SPREAD') {
      return (t.maxLoss ?? t.entryPrice) * 100; // max loss per contract
    }
    return t.entryPrice * 100; // premium paid per contract
  });
  const totalCapitalDeployed = capitalPerTrade.reduce((s, c) => s + c, 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Build the daily date axis. When `allTradingDates` is supplied, use the full
  // trading calendar (clipped to range); otherwise fall back to observed dates
  // from MtM/exit (legacy sparse behavior — drops flat days).
  let dailyDates: string[] = [];
  let usingFullCalendar = false;
  if (opts.allTradingDates && opts.allTradingDates.length > 0) {
    const observedDates = trades.flatMap(t => [
      ...(t.dailyMtM?.map(m => m.date.slice(0, 10)) ?? []),
      t.exitDate.slice(0, 10),
      t.entryDate.slice(0, 10),
    ]).sort();
    const rangeStart = opts.range?.start ?? observedDates[0];
    const rangeEnd = opts.range?.end ?? observedDates[observedDates.length - 1];
    dailyDates = opts.allTradingDates
      .map(d => d.slice(0, 10))
      .filter(d => d >= rangeStart && d <= rangeEnd);
    usingFullCalendar = dailyDates.length > 0;
  }
  if (!usingFullCalendar) {
    dailyDates = [...new Set(
      trades.flatMap(t => [
        ...(t.dailyMtM?.map(m => m.date.slice(0, 10)) ?? []),
        t.exitDate.slice(0, 10),
      ]),
    )].sort();
  }

  let dailyPortfolioSharpe: number | undefined;
  let dailyMtMDrawdownPct: number | undefined;
  const hasDailyMtM = trades.some(t => (t.dailyMtM?.length ?? 0) > 0);
  // When the full calendar is supplied we already have dense coverage by
  // construction; skip the heuristic check that gates the legacy path.
  if (hasDailyMtM && (usingFullCalendar || hasDenseDailyCoverage(dailyDates))) {
    const dateIdx = new Map<string, number>(dailyDates.map((d, i) => [d, i]));
    const dailyPnl = new Array<number>(dailyDates.length).fill(0);

    for (const trade of trades) {
      let contributed = 0;
      let prevUnrealized = 0;
      for (const mtm of trade.dailyMtM ?? []) {
        const day = mtm.date.slice(0, 10);
        const idx = dateIdx.get(day);
        const change = mtm.unrealizedPnl - prevUnrealized;
        if (idx !== undefined) {
          dailyPnl[idx] += change;
          contributed += change;
        }
        prevUnrealized = mtm.unrealizedPnl;
      }

      const residual = trade.pnl - contributed;
      const exitIdx = dateIdx.get(trade.exitDate.slice(0, 10));
      if (exitIdx !== undefined) dailyPnl[exitIdx] += residual;
    }

    let equityDaily = STARTING_CAPITAL;
    let peakDaily = STARTING_CAPITAL;
    let maxDailyDD = 0;
    const returnsDaily: number[] = [];
    for (const pnl of dailyPnl) {
      const prevEquity = equityDaily;
      equityDaily += pnl;
      returnsDaily.push(prevEquity > 0 ? pnl / prevEquity : 0);
      peakDaily = Math.max(peakDaily, equityDaily);
      if (peakDaily > 0) maxDailyDD = Math.max(maxDailyDD, (peakDaily - equityDaily) / peakDaily);
    }

    const avgDaily = returnsDaily.length > 0
      ? returnsDaily.reduce((s, r) => s + r, 0) / returnsDaily.length
      : 0;
    const stdDaily = returnsDaily.length > 1
      ? Math.sqrt(
        returnsDaily.reduce((s, r) => s + (r - avgDaily) ** 2, 0) /
        Math.max(1, returnsDaily.length - 1),
      )
      : 0;
    dailyPortfolioSharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;
    dailyMtMDrawdownPct = maxDailyDD * 100;
  }

  return {
    mode,
    totalTrades: trades.length,
    winners: winners.length,
    losers: losers.length,
    winRate: winners.length / trades.length * 100,
    avgPnlPct: avgReturn * 100,
    totalPnl,
    totalCapitalDeployed,
    returnOnCapital: totalCapitalDeployed > 0 ? (totalPnl / totalCapitalDeployed) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    tradeSharpeLegacy: tradeSharpeLegacy,
    dailyPortfolioSharpe: dailyPortfolioSharpe != null && isFinite(dailyPortfolioSharpe) ? dailyPortfolioSharpe : undefined,
    sharpe: dailyPortfolioSharpe != null && isFinite(dailyPortfolioSharpe)
      ? dailyPortfolioSharpe
      : tradeSharpeLegacy,
    realizedExitDrawdownPct: maxDD * 100,
    dailyMtMDrawdownPct: dailyMtMDrawdownPct != null && isFinite(dailyMtMDrawdownPct) ? dailyMtMDrawdownPct : undefined,
    metricBasis: dailyPortfolioSharpe != null ? 'daily_portfolio' : 'trade_hold_legacy',
    maxDrawdown: maxDD * 100,
    avgHoldDays,
    avgEntryDelta: trades.reduce((s, t) => s + Math.abs(t.entryDelta), 0) / trades.length,
    avgEntryDTE: trades.reduce((s, t) => s + t.entryDTE, 0) / trades.length,
    avgCapitalPerTrade: totalCapitalDeployed / trades.length,
    byExit,
  };
}
