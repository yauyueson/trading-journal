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

import type { SpreadMatch } from './chain-cache';
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
} from './leap-exit';
// Re-export canonical helpers for existing callers (tests + scripts)
export {
  buildLeapTrade,
  computeLeapEntryPrice,
  computeLeapExitPrice,
  computeLeapThresholds,
} from './leap-exit';
import type { DynamicSlippageConfig, FillMode, DirConfTier, SignalPresetKey } from './types';
export type { SignalPresetKey };
import { DEFAULT_DYNAMIC_SLIPPAGE, DIR_CONF_THRESHOLDS } from './types';
import { applyFill, applySpreadFill } from './slippage';

// ── Types ────────────────────────────────────────────────

export type OptionMode = 'LEAP' | 'CREDIT_SPREAD' | 'DEBIT_SPREAD' | 'SWING_LONG_OPTION' | 'BUY_WRITE' | 'DIAGONAL';
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
  // Phase 0.c.9: buy-write (covered call) only. Records the long-stock leg
  // that accompanies the short call. Unset for non-BUY_WRITE trades.
  stockLeg?: {
    shares: number;          // typically 100
    entryPrice: number;      // spot at entry
    exitPrice: number;       // spot at exit OR strike if assigned
    assigned: boolean;       // true if call finished ITM and shares were called away at K
    pnl: number;             // shares × (exitPrice − entryPrice)
    dailyMtM?: { date: string; price: number; pnl: number }[];
  };
  // Phase E1: PMCC (diagonal) only. Long LEAP call + one or more rolled
  // short OTM call cycles. Unset for non-DIAGONAL trades.
  diagonalLegs?: {
    longCall: {
      strike: number;
      entryPrice: number;      // premium paid per contract
      exitPrice: number;       // premium received at exit (or intrinsic if expired)
      entryDate: string;
      exitDate: string;
      entryDelta?: number;
      entryIV?: number;
      entryDTE?: number;
      exitDTE?: number;
      dailyMtM?: { date: string; premium: number; pnl: number }[];
    };
    shortCallCycles: Array<{
      strike: number;
      entryDate: string;
      exitDate: string;
      entryCredit: number;     // premium received per contract (+)
      exitCost: number;        // premium paid to close per contract (0 if expired OTM)
      entryDTE?: number;
      exitDTE?: number;
      entryDelta?: number;
      exitReason: 'EXPIRATION' | 'PROFIT_TARGET' | 'PIN_ROLL' | 'FORCE_CLOSE' | 'ASSIGNED';
      dailyMtM?: { date: string; premium: number; pnl: number }[];
    }>;
  };
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
  // Phase 0.c.9: discrete ex-dividend cashflows used by simulateBuyWrite's
  // stock-leg total-return accounting. Each entry names an ex-date (the
  // day the holder-of-record must have owned the shares) and a
  // per-share amount in dollars. We credit `100 × amount` to the trade
  // on that date, but ONLY if the buy-write cycle was open at that date
  // (signal.date < ex-date <= exitDate).
  //
  // Rationale: CBOE BXM is a total-return index — dividends matter for
  // correlation. A continuous-yield approximation would credit small
  // amounts every month regardless of actual ex-dates, biasing P&L on
  // no-dividend months upward and distorting monthly return stats.
  // Leaving this undefined yields the price-return-only behavior.
  dividendSchedule?: Array<{ date: string; amountPerShare: number }>;
  // Phase 0.c.9: strict monthly-expiry selection for BUY_WRITE. When true,
  // simulateBuyWrite pre-filters the entry chain to rows whose expir_date
  // is a third-Friday (standard CBOE monthly) before calling
  // findStrikeByDelta. On weekly-option underlyings (SPY) the OI-based
  // picker can otherwise land on a weekly expiry, which diverges from the
  // CBOE BXM methodology this mode is designed to replicate.
  requireMonthlyExpiry?: boolean;
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
  // Phase E1: PMCC (long LEAP + rolled short OTM). All required for mode='DIAGONAL'.
  diagLongDeltaRange?: [number, number];      // e.g., [0.65, 0.80]
  diagLongDTERange?: [number, number];        // e.g., [240, 300]
  diagShortDeltaRange?: [number, number];     // e.g., [0.20, 0.30]
  diagShortDTERange?: [number, number];       // e.g., [30, 45]
  diagLongProfitTarget?: number;              // e.g., 0.40 (= +40% on long premium)
  diagLongStopLoss?: number;                  // e.g., 0.35 (= -35% on long premium)
  diagLongTimeStopDTE?: number;              // e.g., 90 (close long when DTE < this)
  diagShortProfitTarget?: number;             // e.g., 0.50 (close short at 50% of credit)
  diagRollTriggerMoneyness?: number;          // e.g., 0.02 (roll when |spot/K - 1| ≤ this with DTE ≤ 2)
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
  // IV-rank gate (matches autoresearch worker path)
  if (config.maxIVRank != null && signal.ivRank != null && signal.ivRank > config.maxIVRank) return null;

  // Entry-day chain
  const entryChain = await fetchHistoricalChain(
    token, signal.ticker, signal.date,
    [0.01, 0.99],
  );
  if (entryChain.length === 0) return null;

  const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Call' : 'Put';
  const targetDelta = (config.leapDeltaRange[0] + config.leapDeltaRange[1]) / 2;
  const entry = findStrikeByDelta(entryChain, targetDelta, optionType, config.leapDTERange);
  if (!entry || entry.mid <= 0) return null;

  // Entry pricing (shared)
  const { entryPrice, entrySlippage } = computeLeapEntryPrice(entry, config);
  const thresholds = computeLeapThresholds(entryPrice, config);

  // Cap monitoring at the option's expiry date (not OOS end)
  const monitorEnd = entry.row.expir_date < maxDate ? entry.row.expir_date : maxDate;
  const forcedClose = maxDate < entry.row.expir_date;

  const monitorDates = getMonitoringDates(
    allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd,
  );

  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
  let trail = createLeapTrailState();
  let missing = createLeapMissingChainState();

  for (const checkDate of monitorDates) {
    const chain = await fetchHistoricalChain(token, signal.ticker, checkDate, [0.01, 0.99]);
    const current = chain.length > 0
      ? findContract(chain, entry.row.strike, entry.row.expir_date, optionType)
      : null;

    if (!current || current.mid <= 0) {
      const step = incrementLeapMissingChain(missing, config);
      missing = step.state;
      if (step.forceExitNow) {
        // NO_CHAIN forced exit: prefer last-known exit price, else intrinsic at checkDate stock
        let exitPrice: number;
        if (missing.lastKnownExitPrice != null) {
          exitPrice = missing.lastKnownExitPrice;
        } else {
          const fallbackStock = chain.length > 0 ? chain[0].stock_price : entry.row.stock_price;
          exitPrice = computeIntrinsicValue(fallbackStock, entry.row.strike, optionType);
        }
        return buildLeapTrade(
          signal, entry, entryPrice, checkDate, exitPrice,
          0, entry.row.stock_price, 'NO_CHAIN', dailyMtM,
          { entrySlippage, exitSlippage: 0, fillMode: config.fillMode },
        );
      }
      continue;
    }

    // Record MtM at fair value (mid). Exit pricing (below) applies slippage.
    dailyMtM.push({
      date: checkDate,
      spreadMid: current.mid,
      unrealizedPnl: (current.mid - entryPrice) * 100,
    });

    // Exit pricing (shared)
    const { exitPrice: currentExitPrice, exitSlippage } = computeLeapExitPrice(current, config);
    missing = resetLeapMissingChain(currentExitPrice);

    // Update trailing lock state
    trail = updateLeapTrailState(trail, currentExitPrice, thresholds);

    // Determine exit (shared logic: TRAILING_LOCK → TP → SL → SIGNAL_REVERSAL → TIME_STOP)
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

  const lastChain = await fetchHistoricalChain(token, signal.ticker, lastDate, [0.01, 0.99]);
  const lastCurrent = lastChain.length > 0
    ? findContract(lastChain, entry.row.strike, entry.row.expir_date, optionType)
    : null;

  let exitPrice: number;
  let exitSlippage = 0;
  if (lastCurrent) {
    const pricing = computeLeapExitPrice(lastCurrent, config);
    exitPrice = pricing.exitPrice;
    exitSlippage = pricing.exitSlippage;
  } else {
    const fallbackStock = lastChain.length > 0 ? lastChain[0].stock_price : entry.row.stock_price;
    exitPrice = computeIntrinsicValue(fallbackStock, entry.row.strike, optionType);
  }

  const endExitType: OptionExitType = forcedClose ? 'FORCE_CLOSE' : 'EXPIRATION';
  return buildLeapTrade(
    signal, entry, entryPrice, lastDate, exitPrice,
    lastCurrent?.row.dte ?? 0, lastCurrent?.row.stock_price ?? entry.row.stock_price,
    endExitType, dailyMtM,
    { entrySlippage, exitSlippage, fillMode: config.fillMode },
  );
}

// buildLeapTrade moved to ./leap-exit and re-exported at the top of this module.

/**
 * Simulate one buy-write (covered call) cycle — Phase 0.c.9.
 *
 * Entry:
 *   - Fetch chain at signal.date, pick the highest-OI expiry in `creditDTERange`.
 *   - Select ATM call via `findStrikeByDelta(chain, 0.50, 'Call', creditDTERange)`.
 *   - Buy 100 shares at stock_price; sell 1 call at call.bid (realistic short fill).
 *
 * Monitor:
 *   - Daily (or interval) mark: stock_price from chain + option mid/ask.
 *   - Records `dailyMtM` for the combined position AND per-leg stockLeg.dailyMtM.
 *   - No TP / SL / trailing — buy-write held strictly to expiry (BXM methodology).
 *
 * Exit at call expiry:
 *   - Spot > strike: call assigned; shares sold at K. Premium kept.
 *   - Spot ≤ strike: call expires worthless. Shares remain; we mark them at spot
 *     on expiry and treat it as the exit price. (The ACTUAL BXM would hold and
 *     roll — we're replicating one monthly cycle per call, so each cycle ends.)
 *
 * Return: OptionTrade with `mode='BUY_WRITE'`, `stockLeg` populated, total `pnl`
 * = short-call P&L + stock P&L. Returns null if no suitable call found.
 *
 * NOTE: signal.direction is ignored (always short CALL). Kept in signature for
 * consistency with sibling simulators.
 */
export async function simulateBuyWrite(
  token: string,
  signal: EntrySignal,
  config: SimConfig,
  allTradingDates: string[],
  maxDate: string,
): Promise<OptionTrade | null> {
  // 1. Entry chain + ATM call selection.
  //
  // Prerequisite: the SQLite cache must have been prefetched with a DTE
  // range that covers `config.creditDTERange`. fetchHistoricalChain's
  // cache key is `(ticker, date)` and does NOT track which DTE slice was
  // loaded — a cache populated via `prefetch-chains.ts --dte-range 60,330`
  // (LEAP default) will return only LEAP rows even when the caller asks
  // for a 5-45 DTE slice, and findStrikeByDelta will see nothing and
  // return null. For BXM replication, prefetch across 5-60 DTE first.
  // (Codex round-8 P1 — documented limitation rather than an architectural
  // cache-key change, which would touch every other simulator.)
  const rawChain = await fetchHistoricalChain(
    token, signal.ticker, signal.date, undefined, config.creditDTERange,
  );
  if (rawChain.length === 0) return null;

  // BXM methodology: short the ATM call on the standard MONTHLY expiry
  // (3rd Friday). On SPY's weekly-option chain, findStrikeByDelta's
  // highest-OI tiebreak can pick a weekly expiry that has temporarily
  // heavy flow, which materially distorts the replication. When
  // `requireMonthlyExpiry` is on, pre-filter to third-Friday expiries only
  // so the OI pick stays inside the standard monthly series.
  // (Codex round-10 P1.)
  const entryChain = config.requireMonthlyExpiry
    ? rawChain.filter(r => isThirdFriday(r.expir_date))
    : rawChain;
  if (entryChain.length === 0) return null;

  const atmMatch = findStrikeByDelta(
    entryChain, 0.50, 'Call', config.creditDTERange, 0,
  );
  if (!atmMatch) return null;

  const { row: entryRow } = atmMatch;
  const entryStockPrice = entryRow.stock_price;
  const strike = entryRow.strike;
  const expiry = entryRow.expir_date;
  const entryDTE = entryRow.dte;
  const entryIV = entryRow.call_iv;
  const entryDelta = entryRow.delta ?? 0.5;
  // Short-call entry fill: route through applyFill so BUY_WRITE honors the
  // same fillMode + dynamic-slippage model the rest of the engine uses.
  // 'sell' side → receive bid minus impact (or mid under 'mid' mode).
  const entryFill = applyFill(
    config.fillMode,
    entryRow.call_mid,
    entryRow.call_bid,
    entryRow.call_ask,
    'sell',
    config.slippage,
    entryRow.call_oi,
    entryRow.dte,
  );
  const premiumPerShare = entryFill.fillPrice;
  if (!Number.isFinite(premiumPerShare) || premiumPerShare <= 0) return null;

  // 2. Monitoring loop — hold to expiry.
  // getMonitoringDates signature: (allDates, entryDate, intervalDays, maxDate).
  // Cap the monitoring window at min(expiry, maxDate) so we don't mark past it.
  const monitorCap = expiry < maxDate ? expiry : maxDate;
  const monitorDates = getMonitoringDates(
    allTradingDates, signal.date, config.monitoringIntervalDays, monitorCap,
  ).filter(d => d > signal.date);

  const stockDaily: { date: string; price: number; pnl: number }[] = [];
  const combinedDaily: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

  // Filter the dividend schedule to entries that could accrue during this
  // trade's lifetime. Each entry is an ex-date; if signal.date < ex-date
  // the holder-of-record has the shares and gets the cash. We credit on
  // the ex-date itself (standard accrual convention).
  //
  // Upper bound: we only credit ex-dates on or before the earliest
  // possible exit (min of option expiry and caller's maxDate). This
  // bounds `divs` to what could actually accrue — a reusable yearly
  // schedule with ex-dates that all fall after maxDate/expiry becomes an
  // empty list and doesn't trigger the monitoring guard below
  // (Codex round-11 P2).
  const divWindowEnd = expiry <= maxDate ? expiry : maxDate;
  const divs = (config.dividendSchedule ?? [])
    .filter(ev => ev.date > signal.date && ev.date <= divWindowEnd && Number.isFinite(ev.amountPerShare))
    .sort((a, b) => a.date.localeCompare(b.date));
  // If a dividend schedule actually has ex-dates inside this window,
  // require daily monitoring so each ex-date lands on its own dailyMtM
  // entry. With a sparser monitor the dividend lump would only show up
  // on the next sampled day, delaying the cashflow by several days and
  // distorting daily Sharpe/DD (Codex round-9 P2 b). Daily monitoring is
  // BXM replication's natural use case; reject the combination loudly
  // rather than silently accept incorrect path stats.
  if (divs.length > 0 && config.monitoringIntervalDays !== 1) {
    throw new Error(
      `simulateBuyWrite: dividendSchedule requires monitoringIntervalDays === 1, ` +
      `got ${config.monitoringIntervalDays}. A sparser monitor would defer ` +
      `dividend cashflows to the next sampled day and distort daily P&L.`,
    );
  }
  function accruedDividends(throughDate: string): number {
    let total = 0;
    for (const ev of divs) {
      if (ev.date > throughDate) break;
      total += 100 * ev.amountPerShare;
    }
    return total;
  }

  let lastMonitorDate = signal.date;
  let lastStockPrice = entryStockPrice;

  for (const d of monitorDates) {
    // Mirror simulateCreditSpread's monitoring pattern: prefer direct
    // lookup when the caller opts in (pre-warmed SQLite cache), but fall
    // back to fetching the day's chain otherwise. Without the fallback,
    // uncached runs would leave `dailyMtM` empty and degrade analytics
    // to a single exit-day point.
    let contract = config.useDirectLookup
      ? findContractDirect(signal.ticker, d, strike, expiry, 'Call')
      : null;
    if (!contract) {
      const chain = await fetchHistoricalChain(token, signal.ticker, d);
      if (chain.length > 0) {
        contract = findContract(chain, strike, expiry, 'Call');
      }
    }
    if (contract) {
      lastStockPrice = contract.row.stock_price;
      const callMid = contract.mid;
      const stockPnl = 100 * (lastStockPrice - entryStockPrice);
      // Daily MtM uses fair value (mid), not ask. Charging the close
      // spread every monitoring day would be paid once at exit and is
      // already captured by the applyFill path at force-close or exit.
      // The other simulators (simulateLeap, simulateCreditSpread) also
      // mark dailyMtM at fair value; mixing mid/ask across modes would
      // distort computePortfolioDailyMetrics / computeCorrelationStress.
      const shortCallPnl = 100 * (premiumPerShare - callMid);
      // Include accrued dividends in daily unrealized P&L so Sharpe/DD
      // see the cashflow on the ex-date rather than as a single
      // exit-day jump (Codex round-7 P2).
      const divAccrued = accruedDividends(d);
      stockDaily.push({ date: d, price: lastStockPrice, pnl: stockPnl + divAccrued });
      combinedDaily.push({ date: d, spreadMid: callMid, unrealizedPnl: stockPnl + shortCallPnl + divAccrued });
    }
    lastMonitorDate = d;
    if (d >= expiry) break;
  }

  // 3. Exit. Distinguish a true expiration (exit at or after option expiry)
  // from a forced early close (window or data cutoff before expiry). Sister
  // simulators (simulateLeap, simulateCreditSpread) do the same thing —
  // pricing a forced close at intrinsic would systematically discard time
  // value and manufacture "assignment" before the option has expired.
  //
  // Clamp both the target and the walk-back to min(expiry, maxDate) —
  // otherwise a maxDate on a non-trading day (weekend/holiday) would
  // silently roll the exit forward past the requested cutoff, sometimes
  // all the way to expiry, turning a forced close into an assignment.
  const exitCap = expiry <= maxDate ? expiry : maxDate;
  let exitDate = exitCap;
  let exitIdx = allTradingDates.lastIndexOf(exitDate);
  if (exitIdx < 0) {
    for (let i = allTradingDates.length - 1; i >= 0; i--) {
      if (allTradingDates[i] <= exitCap) { exitIdx = i; exitDate = allTradingDates[i]; break; }
    }
    if (exitIdx < 0) return null;
  }

  // The "effective expiry" on the trading calendar: the last trading day
  // on or before `expiry`. When expir_date is a non-trading Saturday
  // (historical BXM monthlies) there is no Saturday row to fetch, so the
  // settlement uses the preceding Friday's close. This is NOT a forced
  // close — the option has reached its effective expiration.
  let effectiveExpiryIdx = allTradingDates.lastIndexOf(expiry);
  if (effectiveExpiryIdx < 0) {
    for (let i = allTradingDates.length - 1; i >= 0; i--) {
      if (allTradingDates[i] <= expiry) { effectiveExpiryIdx = i; break; }
    }
  }
  const effectiveExpiryDate = effectiveExpiryIdx >= 0 ? allTradingDates[effectiveExpiryIdx] : expiry;

  // Walk `exitDate` back through the calendar until we find a day that
  // actually has chain data. Missing exit-day data + reuse of a stale
  // monitor price would silently freeze the stock leg at an earlier mark
  // and produce the wrong final P&L. Fall through to NO_CHAIN if we run
  // out of trading days to look at.
  let exitChain = await fetchHistoricalChain(token, signal.ticker, exitDate);
  while (exitChain.length === 0 && exitIdx > 0) {
    exitIdx -= 1;
    exitDate = allTradingDates[exitIdx];
    if (exitDate < signal.date) break;
    exitChain = await fetchHistoricalChain(token, signal.ticker, exitDate);
  }
  if (exitChain.length === 0) {
    return null; // no usable chain day — treat as unfetchable (caller skips)
  }
  const exitStockPrice = exitChain[0].stock_price;

  // Forced-close vs expiration. The walk-back behavior means a caller who
  // intended expiration-style settlement can legitimately end up on a
  // pre-expiry trading day (e.g., Saturday expiry → Friday close). We
  // must not classify that as FORCE_CLOSE — it reaches effective expiry.
  // Rule: forcedClose iff maxDate is strictly before the effective expiry
  // trading day (meaning the caller's window ended before any reasonable
  // expiration settlement could occur).
  const forcedClose = maxDate < effectiveExpiryDate;

  let assigned: boolean;
  let stockExitPrice: number;
  let callExitPrice: number;      // what we pay per share to close short
  let exitType: OptionTrade['exitType'];

  if (forcedClose) {
    // Early close: mark both legs at market.
    //   Stock: mark at spot (no assignment before expiry).
    //   Short call: buy-to-close via applyFill so BUY_WRITE honors the
    //               configured fill model and dynamic-slippage penalty.
    //               Prefer the already-loaded exitChain (uncached-run
    //               friendly); only fall back to findContractDirect when
    //               the chain came up empty, and to intrinsic when even
    //               the strike row is missing.
    const contract = exitChain.length > 0
      ? findContract(exitChain, strike, expiry, 'Call')
      : findContractDirect(signal.ticker, exitDate, strike, expiry, 'Call');
    assigned = false;
    stockExitPrice = exitStockPrice;
    if (contract) {
      const fill = applyFill(
        config.fillMode,
        contract.mid,
        contract.bid,
        contract.ask,
        'buy',
        config.slippage,
        contract.oi,
        contract.row.dte,
      );
      callExitPrice = fill.fillPrice;
    } else {
      callExitPrice = Math.max(0, exitStockPrice - strike);
    }
    exitType = 'FORCE_CLOSE';
  } else {
    // True expiration. `exitDate` may have been walked back from a
    // non-trading expiry (e.g., Saturday monthly expiries) to the prior
    // trading day — use that day's close as the settlement spot, which
    // is how CBOE BXM replication handles Saturday expiries historically.
    //
    // Economics at expiration (no cash close of the short call):
    //   ITM  → shares assigned away at strike; short call settles at 0.
    //   OTM  → short call expires worthless; shares marked at spot.
    // In both branches the short leg's cash P&L is just the kept premium
    // (callExitPrice = 0). Charging intrinsic on top of capping the stock
    // leg at strike would double-count the upside — the ITM cash flow is
    // already captured by delivering shares at K instead of spot.
    assigned = exitStockPrice > strike;
    stockExitPrice = assigned ? strike : exitStockPrice;
    callExitPrice = 0;
    exitType = 'EXPIRATION';
  }

  const stockPnl = 100 * (stockExitPrice - entryStockPrice);
  const shortCallPnl = 100 * (premiumPerShare - callExitPrice);
  // Dividends realized during the holding period — only the ex-dates that
  // actually fall inside (signal.date, exitDate] are credited. A trade
  // that crosses no ex-date receives 0. This replaces the earlier
  // continuous-yield approximation, which systematically overstated
  // no-dividend months (Codex round-7 P1).
  const dividendCredit = accruedDividends(exitDate);
  const totalPnl = stockPnl + shortCallPnl + dividendCredit;

  // Reconcile stockLeg.dailyMtM with the settled stock value (Codex round-8 P2).
  // During monitoring we record `100 × (spot - entrySpot) + divAccrued`; on an
  // assigned expiration the stock delivers at K, not final spot, so the
  // last daily mark must be snapped to the settled value or the returned
  // leg-level series is inconsistent with stockLeg.pnl. Append/replace a
  // terminal entry representing true settlement.
  {
    const terminalStockPnl = stockPnl + dividendCredit;
    const terminalCombinedPnl = totalPnl;
    const last = stockDaily[stockDaily.length - 1];
    if (last && last.date === exitDate) {
      last.price = stockExitPrice;
      last.pnl = terminalStockPnl;
    } else {
      stockDaily.push({ date: exitDate, price: stockExitPrice, pnl: terminalStockPnl });
    }
    const lastCombined = combinedDaily[combinedDaily.length - 1];
    if (lastCombined && lastCombined.date === exitDate) {
      lastCombined.unrealizedPnl = terminalCombinedPnl;
      lastCombined.spreadMid = callExitPrice;
    } else {
      combinedDaily.push({ date: exitDate, spreadMid: callExitPrice, unrealizedPnl: terminalCombinedPnl });
    }
  }

  const holdDays = countCalendarDays(signal.date, exitDate);
  const entryNotional = 100 * entryStockPrice;
  const pnlPct = entryNotional > 0 ? totalPnl / entryNotional : 0;
  const exitDTE = Math.max(0, countCalendarDays(exitDate, expiry));

  const trade: OptionTrade = {
    ticker: signal.ticker,
    mode: 'BUY_WRITE',
    direction: 'CALL',
    entryDate: signal.date,
    entrySignalScore: signal.score,
    strike,
    expiry,
    entryDTE,
    entryPrice: premiumPerShare,            // credit received per share
    entryDelta,
    entryIV,
    entryStockPrice,
    exitDate,
    exitPrice: callExitPrice,               // per-share cost to close short leg
    exitDTE,
    exitStockPrice,
    exitType,
    pnl: totalPnl,
    pnlPct,
    holdDays,
    fillMode: config.fillMode,
    dailyMtM: combinedDaily,
    stockLeg: {
      shares: 100,
      entryPrice: entryStockPrice,
      exitPrice: stockExitPrice,
      assigned,
      // Stock leg's realized P&L INCLUDES dividends accrued during the
      // holding period — dividends are a stock-ownership cashflow, not a
      // separate account. trade.pnl and stockLeg.dailyMtM terminal point
      // already reflect this; keeping stockLeg.pnl price-only would make
      // the returned leg breakdown internally inconsistent (Codex
      // round-9 P2 a).
      pnl: stockPnl + dividendCredit,
      dailyMtM: stockDaily,
    },
  };
  // Suppress unused-variable lint.
  void lastMonitorDate;
  return trade;
}

/**
 * True if the given `YYYY-MM-DD` date is a standard CBOE monthly
 * expiration date: the third Friday of its month OR the Saturday
 * immediately following.
 *
 * CBOE options listed before Feb 2015 carried a `Saturday` expiration
 * date in chain data (the day after expiration Friday) — BXM historical
 * chains record those monthlies with Saturday `expir_date`. Post-2015
 * monthlies record Friday. Any replication that covers pre-2015 data
 * (the committed CBOE BXM series starts in 1988) must accept both.
 */
export function isThirdFriday(dateStr: string): boolean {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay();
  if (dow !== 5 && dow !== 6) return false;
  const dayOfMonth = d.getUTCDate();
  // 3rd Friday: day 15-21 inclusive. 3rd-Saturday (= day after 3rd Friday):
  // day 16-22 inclusive.
  if (dow === 5) return dayOfMonth >= 15 && dayOfMonth <= 21;
  return dayOfMonth >= 16 && dayOfMonth <= 22;
}

function countCalendarDays(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
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

  // Capital deployed per trade:
  //   CREDIT_SPREAD → max loss per contract (width − credit)
  //   BUY_WRITE     → stock notional (shares × entry spot); the short call
  //                    premium is a credit, not capital. Using entryPrice
  //                    (~$3.49) here would underreport capital ~129× and
  //                    inflate ROC for covered-call positions.
  //   LEAP / other  → premium paid per contract (100 × premium/share)
  const capitalPerTrade = trades.map(t => {
    if (t.mode === 'CREDIT_SPREAD') {
      return (t.maxLoss ?? t.entryPrice) * 100; // max loss per contract
    }
    if (t.mode === 'BUY_WRITE') {
      const stockEntry = t.stockLeg?.entryPrice ?? t.entryStockPrice ?? 0;
      const shares = t.stockLeg?.shares ?? 100;
      return stockEntry * shares;
    }
    if (t.mode === 'DIAGONAL') {
      // PMCC capital = net debit × 100. Short premium is real cash received
      // at entry, so it reduces capital at risk; using full long premium
      // would overstate by ~5-8% on a typical PMCC.
      const longPrem = t.diagonalLegs?.longCall.entryPrice ?? 0;
      // Invariant: simulateDiagonal always populates shortCallCycles[0] at entry.
      const firstShortCredit = t.diagonalLegs?.shortCallCycles[0]?.entryCredit ?? 0;
      const netDebit = Math.max(0, longPrem - firstShortCredit);
      return netDebit * 100;
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
