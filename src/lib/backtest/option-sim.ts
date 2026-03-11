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
} from './chain-cache';
import type { DynamicSlippageConfig, FillMode } from './types';
import { DEFAULT_DYNAMIC_SLIPPAGE } from './types';
import { applyFill } from './slippage';

// ── Types ────────────────────────────────────────────────

export type OptionMode = 'LEAP' | 'CREDIT_SPREAD';
export type OptionExitType = 'PROFIT_TARGET' | 'STOP_LOSS' | 'TIME_STOP' | 'SIGNAL_REVERSAL' | 'EXPIRATION' | 'NO_CHAIN' | 'PROFIT_TARGET_2' | 'SL_BREAKEVEN';

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
  pnlPct: number;            // % return on capital at risk
  holdDays: number;
  // IV at entry (optional enrichment)
  ivRank?: number;
  // Execution tracking
  entrySlippage?: number;   // $ adverse fill impact at entry (per spread)
  exitSlippage?: number;    // $ adverse fill impact at exit
  fillMode?: FillMode;      // which fill model was used
  // Daily mark-to-market P&L (unrealized, captured during monitoring loop)
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[];
}

export interface EntrySignal {
  ticker: string;
  date: string;
  direction: 'CALL' | 'PUT';
  score: number;
  ivRank?: number;
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
  creditShortDelta: number;             // 0.27 (absolute)
  creditSpreadWidth: number;            // 5 (dollars)
  creditDTERange: [number, number];     // [30, 50]
  creditProfitTarget: number;           // 0.50 = close at 50% of max profit
  creditStopLossMultiple: number;       // 2.0 = close at 2× credit
  creditTimeStopDTE: number;            // close when DTE < this (7)
  // Monitoring
  monitoringIntervalDays: number;       // check every N trading days (7 LEAP, 3 credit)
  // IV filter for credit spreads
  minIVRank: number;                    // 30 = require IV Rank > 30 for credit entries
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
}

export type SignalPresetKey = 'ema' | 'mom' | 'em' | 'mf';

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
  creditTimeStopDTE: 7,
  monitoringIntervalDays: 1,
  minIVRank: 0,
  fillMode: 'mid' as FillMode,
  slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
};

export const DEFAULT_CREDIT_CONFIG: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'CREDIT_SPREAD',
  monitoringIntervalDays: 1,
  minIVRank: 30,              // Phase 4-5: IV >= 30% structural filter
};

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

  const entryPrice = entry.mid;
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
    const currentPrice = current.mid;

    // Record daily mark-to-market
    dailyMtM.push({
      date: checkDate,
      spreadMid: currentPrice,
      unrealizedPnl: (currentPrice - entryPrice) * 100,
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
      return buildLeapResult(signal, entry, checkDate, currentPrice, currentDTE,
        current.row.stock_price, exitType, dailyMtM);
    }
  }

  // Close at last monitoring date if no exit triggered
  const lastDate = monitorDates[monitorDates.length - 1];
  if (lastDate) {
    const chain = await fetchHistoricalChain(token, signal.ticker, lastDate, [0.01, 0.99]);
    const current = findContract(chain, entry.row.strike, entry.row.expir_date, optionType);
    // At expiry: intrinsic value
    let exitPrice: number;
    if (current) {
      exitPrice = current.mid;
    } else {
      // Compute intrinsic value as fallback
      const lastChain = chain.length > 0 ? chain[0].stock_price : entry.row.stock_price;
      exitPrice = optionType === 'Call'
        ? Math.max(0, lastChain - entry.row.strike)
        : Math.max(0, entry.row.strike - lastChain);
    }

    return buildLeapResult(signal, entry, lastDate, exitPrice,
      current?.row.dte ?? 0, current?.row.stock_price ?? entry.row.stock_price, 'EXPIRATION', dailyMtM);
  }

  return null;
}

function buildLeapResult(
  signal: EntrySignal, entry: StrikeMatch, exitDate: string,
  exitPrice: number, exitDTE: number, exitStockPrice: number, exitType: OptionExitType,
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[],
): OptionTrade {
  const entryPrice = entry.mid;
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

  // Apply fill model to entry
  let entryCredit: number;
  let entrySlippage = 0;

  if (config.fillMode === 'bidask' && config.slippage.enabled) {
    const shortFill = applyFill('bidask', spread.short.mid, spread.short.bid,
      spread.short.ask, 'sell', config.slippage, spread.short.oi, spread.short.row.dte);
    const longFill = applyFill('bidask', spread.long.mid, spread.long.bid,
      spread.long.ask, 'buy', config.slippage, spread.long.oi, spread.long.row.dte);
    entryCredit = shortFill.fillPrice - longFill.fillPrice;
    entrySlippage = shortFill.slippage + longFill.slippage;
    if (entryCredit <= 0) return null; // no credit after slippage → skip
  } else {
    entryCredit = spread.netCredit;
  }

  const tpCost = entryCredit * (1 - config.creditProfitTarget); // close when spread costs this much
  const slCost = entryCredit * config.creditStopLossMultiple;    // close when spread costs this much

  // Cap monitoring at the option's expiry date
  const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;

  const monitorDates = getMonitoringDates(
    allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd,
  );

  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

  for (const checkDate of monitorDates) {
    const chain = await fetchHistoricalChain(token, signal.ticker, checkDate, [0.01, 0.99]);
    if (chain.length === 0) continue;

    const shortLeg = findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType);
    if (!shortLeg || !longLeg) continue;

    // Apply fill model to exit monitoring
    let currentSpreadCost: number;
    let exitSlippageAmount = 0;
    if (config.fillMode === 'bidask' && config.slippage.enabled) {
      // To close: buy back short (pay ask), sell long (receive bid)
      const shortClose = applyFill('bidask', shortLeg.mid, shortLeg.bid,
        shortLeg.ask, 'buy', config.slippage, shortLeg.oi, shortLeg.row.dte);
      const longClose = applyFill('bidask', longLeg.mid, longLeg.bid,
        longLeg.ask, 'sell', config.slippage, longLeg.oi, longLeg.row.dte);
      currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
      exitSlippageAmount = shortClose.slippage + longClose.slippage;
    } else {
      currentSpreadCost = shortLeg.mid - longLeg.mid;
    }
    const currentDTE = shortLeg.row.dte;

    // Record daily mark-to-market
    dailyMtM.push({
      date: checkDate,
      spreadMid: currentSpreadCost,
      unrealizedPnl: (entryCredit - currentSpreadCost) * 100,
    });

    let exitType: OptionExitType | null = null;

    if (currentSpreadCost <= tpCost) {
      exitType = 'PROFIT_TARGET';
    } else if (currentSpreadCost >= slCost) {
      exitType = 'STOP_LOSS';
    } else if (currentDTE <= config.creditTimeStopDTE) {
      exitType = 'TIME_STOP';
    }

    if (exitType) {
      return buildCreditResult(signal, spread, entryCredit, checkDate, currentSpreadCost,
        currentDTE, shortLeg.row.stock_price, exitType,
        { dailyMtM, entrySlippage, exitSlippage: exitSlippageAmount, fillMode: config.fillMode });
    }
  }

  // Close at last monitoring date or expiry
  const lastDate = monitorDates[monitorDates.length - 1];
  if (lastDate) {
    const chain = await fetchHistoricalChain(token, signal.ticker, lastDate, [0.01, 0.99]);
    const shortLeg = findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType);

    let currentSpreadCost: number;
    if (shortLeg && longLeg) {
      currentSpreadCost = shortLeg.mid - longLeg.mid;
    } else {
      // At expiry: compute intrinsic spread value
      const stockPrice = (shortLeg || longLeg)?.row.stock_price ?? spread.short.row.stock_price;
      const shortIntrinsic = optionType === 'Put'
        ? Math.max(0, spread.short.row.strike - stockPrice)
        : Math.max(0, stockPrice - spread.short.row.strike);
      const longIntrinsic = optionType === 'Put'
        ? Math.max(0, spread.long.row.strike - stockPrice)
        : Math.max(0, stockPrice - spread.long.row.strike);
      currentSpreadCost = shortIntrinsic - longIntrinsic;
    }

    return buildCreditResult(signal, spread, entryCredit, lastDate, currentSpreadCost,
      shortLeg?.row.dte ?? 0, shortLeg?.row.stock_price ?? spread.short.row.stock_price, 'EXPIRATION',
      { dailyMtM, entrySlippage, fillMode: config.fillMode });
  }

  return null;
}

interface BuildCreditOpts {
  overridePnl?: number;
  overridePnlPct?: number;
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[];
  entrySlippage?: number;
  exitSlippage?: number;
  fillMode?: FillMode;
}

function buildCreditResult(
  signal: EntrySignal, spread: SpreadMatch, entryCredit: number,
  exitDate: string, exitSpreadCost: number, exitDTE: number,
  exitStockPrice: number, exitType: OptionExitType,
  opts: BuildCreditOpts = {},
): OptionTrade {
  const pnl = opts.overridePnl ?? (entryCredit - exitSpreadCost) * 100;
  const pnlPct = opts.overridePnlPct ?? (spread.maxLoss > 0 ? pnl / (spread.maxLoss * 100) : 0);
  const holdDays = Math.round(
    (new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000
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
    spreadWidth: spread.spreadWidth,
    maxProfit: entryCredit,
    maxLoss: spread.maxLoss,
    exitDate,
    exitPrice: exitSpreadCost,
    exitDTE,
    exitStockPrice,
    exitType,
    pnl,
    pnlPct,
    holdDays,
    ivRank: signal.ivRank,
    entrySlippage: opts.entrySlippage,
    exitSlippage: opts.exitSlippage,
    fillMode: opts.fillMode,
    dailyMtM: opts.dailyMtM,
  };
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

  const entryCredit = spread.netCredit;
  const tp1Cost = entryCredit * (1 - phasedConfig.tp1);   // spread cost at TP1
  const tp2Cost = entryCredit * (1 - phasedConfig.tp2);   // spread cost at TP2
  const slCost = entryCredit * config.creditStopLossMultiple;  // original SL (before TP1)

  const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;
  const monitorDates = getMonitoringDates(
    allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd,
  );

  // Phase tracking
  let phase: 'FULL' | 'HALF' = 'FULL';
  let halfPnl = 0;             // P&L from the first half (set when TP1 hit)

  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

  for (const checkDate of monitorDates) {
    const chain = await fetchHistoricalChain(token, signal.ticker, checkDate, [0.01, 0.99]);
    if (chain.length === 0) continue;

    const shortLeg = findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType);
    if (!shortLeg || !longLeg) continue;

    const currentSpreadCost = shortLeg.mid - longLeg.mid;
    const currentDTE = shortLeg.row.dte;

    // Record daily mark-to-market (phase-aware)
    dailyMtM.push({
      date: checkDate,
      spreadMid: currentSpreadCost,
      unrealizedPnl: phase === 'FULL'
        ? (entryCredit - currentSpreadCost) * 100
        : halfPnl + (entryCredit - currentSpreadCost) * 0.5 * 100,
    });

    if (phase === 'FULL') {
      // Check TP1 (close half)
      if (currentSpreadCost <= tp1Cost) {
        phase = 'HALF';
        halfPnl = (entryCredit - currentSpreadCost) * 0.5 * 100;  // half position P&L
        // (date/type tracked by phase state)
        continue;  // keep monitoring the remaining half
      }

      // Check original SL (full position)
      if (currentSpreadCost >= slCost) {
        const pnl = (entryCredit - currentSpreadCost) * 100;
        return buildCreditResult(
          signal, spread, entryCredit, checkDate, currentSpreadCost,
          currentDTE, shortLeg.row.stock_price, 'STOP_LOSS',
          { overridePnl: pnl, overridePnlPct: spread.maxLoss > 0 ? pnl / (spread.maxLoss * 100) : 0, dailyMtM },
        );
      }

      // Check time stop (full position)
      if (currentDTE <= config.creditTimeStopDTE) {
        const pnl = (entryCredit - currentSpreadCost) * 100;
        return buildCreditResult(
          signal, spread, entryCredit, checkDate, currentSpreadCost,
          currentDTE, shortLeg.row.stock_price, 'TIME_STOP',
          { overridePnl: pnl, overridePnlPct: spread.maxLoss > 0 ? pnl / (spread.maxLoss * 100) : 0, dailyMtM },
        );
      }
    } else {
      // phase === 'HALF' — remaining half with breakeven SL

      // Check TP2 (close remaining half)
      if (currentSpreadCost <= tp2Cost) {
        const secondHalfPnl = (entryCredit - currentSpreadCost) * 0.5 * 100;
        const totalPnl = halfPnl + secondHalfPnl;
        return buildCreditResult(
          signal, spread, entryCredit, checkDate, currentSpreadCost,
          currentDTE, shortLeg.row.stock_price, 'PROFIT_TARGET_2',
          { overridePnl: totalPnl, overridePnlPct: spread.maxLoss > 0 ? totalPnl / (spread.maxLoss * 100) : 0, dailyMtM },
        );
      }

      // Check after-TP1 SL on remaining half
      const afterTP1SLCost = entryCredit * (1 - phasedConfig.afterTP1SL);
      if (phasedConfig.afterTP1SL >= 0 && currentSpreadCost >= afterTP1SLCost) {
        const secondHalfPnl = (entryCredit - currentSpreadCost) * 0.5 * 100;
        const totalPnl = halfPnl + secondHalfPnl;
        return buildCreditResult(
          signal, spread, entryCredit, checkDate, currentSpreadCost,
          currentDTE, shortLeg.row.stock_price, 'SL_BREAKEVEN',
          { overridePnl: totalPnl, overridePnlPct: spread.maxLoss > 0 ? totalPnl / (spread.maxLoss * 100) : 0, dailyMtM },
        );
      }

      // Check time stop (remaining half)
      if (currentDTE <= config.creditTimeStopDTE) {
        const secondHalfPnl = (entryCredit - currentSpreadCost) * 0.5 * 100;
        const totalPnl = halfPnl + secondHalfPnl;
        return buildCreditResult(
          signal, spread, entryCredit, checkDate, currentSpreadCost,
          currentDTE, shortLeg.row.stock_price, 'TIME_STOP',
          { overridePnl: totalPnl, overridePnlPct: spread.maxLoss > 0 ? totalPnl / (spread.maxLoss * 100) : 0, dailyMtM },
        );
      }
    }
  }

  // Close at last monitoring date
  const lastDate = monitorDates[monitorDates.length - 1];
  if (lastDate) {
    const chain = await fetchHistoricalChain(token, signal.ticker, lastDate, [0.01, 0.99]);
    const shortLeg = findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType);

    let currentSpreadCost: number;
    if (shortLeg && longLeg) {
      currentSpreadCost = shortLeg.mid - longLeg.mid;
    } else {
      const stockPrice = (shortLeg || longLeg)?.row.stock_price ?? spread.short.row.stock_price;
      const shortIntrinsic = optionType === 'Put'
        ? Math.max(0, spread.short.row.strike - stockPrice)
        : Math.max(0, stockPrice - spread.short.row.strike);
      const longIntrinsic = optionType === 'Put'
        ? Math.max(0, spread.long.row.strike - stockPrice)
        : Math.max(0, stockPrice - spread.long.row.strike);
      currentSpreadCost = shortIntrinsic - longIntrinsic;
    }

    if (phase === 'HALF') {
      const secondHalfPnl = (entryCredit - currentSpreadCost) * 0.5 * 100;
      const totalPnl = halfPnl + secondHalfPnl;
      return buildCreditResult(
        signal, spread, entryCredit, lastDate, currentSpreadCost,
        shortLeg?.row.dte ?? 0, shortLeg?.row.stock_price ?? spread.short.row.stock_price,
        'EXPIRATION', { overridePnl: totalPnl, overridePnlPct: spread.maxLoss > 0 ? totalPnl / (spread.maxLoss * 100) : 0, dailyMtM },
      );
    } else {
      const pnl = (entryCredit - currentSpreadCost) * 100;
      return buildCreditResult(
        signal, spread, entryCredit, lastDate, currentSpreadCost,
        shortLeg?.row.dte ?? 0, shortLeg?.row.stock_price ?? spread.short.row.stock_price,
        'EXPIRATION', { overridePnl: pnl, overridePnlPct: spread.maxLoss > 0 ? pnl / (spread.maxLoss * 100) : 0, dailyMtM },
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
  sharpe: number;
  maxDrawdown: number;
  avgHoldDays: number;
  avgEntryDelta: number;
  avgEntryDTE: number;
  avgCapitalPerTrade: number; // avg $ at risk per trade
  byExit: Record<string, number>;
}

export function computeOptionAnalytics(trades: OptionTrade[]): OptionSimAnalytics {
  if (trades.length === 0) {
    return {
      mode: 'LEAP', totalTrades: 0, winners: 0, losers: 0, winRate: 0,
      avgPnlPct: 0, totalPnl: 0, totalCapitalDeployed: 0, returnOnCapital: 0,
      profitFactor: 0, sharpe: 0, maxDrawdown: 0,
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
  const sharpe = std > 0 ? (avgReturn / std) * Math.sqrt(tradesPerYear) : 0;

  // Max drawdown (on $100K notional equity curve)
  const STARTING_CAPITAL = 100_000;
  let equity = STARTING_CAPITAL, peak = STARTING_CAPITAL, maxDD = 0;
  for (const t of trades) {
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
    sharpe,
    maxDrawdown: maxDD * 100,
    avgHoldDays,
    avgEntryDelta: trades.reduce((s, t) => s + Math.abs(t.entryDelta), 0) / trades.length,
    avgEntryDTE: trades.reduce((s, t) => s + t.entryDTE, 0) / trades.length,
    avgCapitalPerTrade: totalCapitalDeployed / trades.length,
    byExit,
  };
}
