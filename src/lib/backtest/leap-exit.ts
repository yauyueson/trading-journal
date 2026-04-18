/**
 * leap-exit.ts — shared pure helpers for LEAP trade evaluation.
 *
 * Extracted in 2026-04-18 (commit post-Codex adversarial review) to eliminate
 * the LEAP evaluator fork between:
 *   - src/lib/backtest/option-sim.ts simulateLeap (async, external callers)
 *   - scripts/autoresearch/worker.ts makeLeapEvaluator (sync, autoresearch)
 *
 * Both paths now call the same exit-logic helpers defined here. The two sim
 * entry points keep their own monitor loops (one async for ORATS fetcher, one
 * sync for the SQLite cache) but all threshold computation, fill pricing,
 * trailing lock state management, missing-chain handling, signal-invalidation
 * detection, and exit-type determination live here.
 *
 * See docs/backtest-trust-gotchas.md gotcha #40 for the rationale.
 */
import type { StrikeMatch } from './chain-cache';
import type { EntrySignal, OptionExitType, OptionTrade, SimConfig } from './option-sim';
import type { FillMode } from './types';
import { applyFill } from './slippage';

// ── Types ──────────────────────────────────────

export interface LeapThresholds {
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  /** null when trailing lock is disabled in config */
  trailActivatePrice: number | null;
  /** null when trailing lock is disabled in config */
  trailFloorPct: number | null;
}

export interface LeapTrailState {
  active: boolean;
  peak: number;
  floor: number;
}

export interface LeapMissingChainState {
  streak: number;
  lastKnownExitPrice: number | null;
}

export interface LeapEntryPricing {
  entryPrice: number;
  entrySlippage: number;
}

export interface LeapExitPricing {
  exitPrice: number;
  exitSlippage: number;
  currentMid: number;
}

// ── Fill pricing helpers ──────────────────────

export function computeLeapEntryPrice(entry: StrikeMatch, config: SimConfig): LeapEntryPricing {
  if (config.fillMode === 'bidask' && config.slippage.enabled) {
    const fill = applyFill('bidask', entry.mid, entry.bid, entry.ask, 'buy',
      config.slippage, entry.oi, entry.row.dte);
    return { entryPrice: fill.fillPrice, entrySlippage: fill.slippage };
  }
  return { entryPrice: entry.mid, entrySlippage: 0 };
}

export function computeLeapExitPrice(current: StrikeMatch, config: SimConfig): LeapExitPricing {
  if (config.fillMode === 'bidask' && config.slippage.enabled) {
    const fill = applyFill('bidask', current.mid, current.bid, current.ask, 'sell',
      config.slippage, current.oi, current.row.dte);
    return { exitPrice: fill.fillPrice, exitSlippage: fill.slippage, currentMid: current.mid };
  }
  return { exitPrice: current.mid, exitSlippage: 0, currentMid: current.mid };
}

// ── Threshold + state factories ───────────────

export function computeLeapThresholds(entryPrice: number, config: SimConfig): LeapThresholds {
  const tpPrice = entryPrice * (1 + config.leapProfitTarget);
  const slPrice = entryPrice * (1 - config.leapStopLoss);
  const trailActivatePct = config.trailingActivatePct ?? null;
  const trailFloorPct = config.trailingFloorPct ?? null;
  const trailActivatePrice = (trailActivatePct != null)
    ? entryPrice + entryPrice * config.leapProfitTarget * trailActivatePct
    : null;
  return { entryPrice, tpPrice, slPrice, trailActivatePrice, trailFloorPct };
}

export function createLeapTrailState(): LeapTrailState {
  return { active: false, peak: 0, floor: 0 };
}

export function createLeapMissingChainState(): LeapMissingChainState {
  return { streak: 0, lastKnownExitPrice: null };
}

// ── Pure state transitions ────────────────────

export function updateLeapTrailState(
  state: LeapTrailState,
  currentExitPrice: number,
  thresholds: LeapThresholds,
): LeapTrailState {
  if (thresholds.trailActivatePrice == null || thresholds.trailFloorPct == null) return state;
  let { active, peak, floor } = state;
  if (!active && currentExitPrice >= thresholds.trailActivatePrice) {
    active = true;
    peak = currentExitPrice;
    floor = currentExitPrice * (1 - thresholds.trailFloorPct);
  } else if (active && currentExitPrice > peak) {
    peak = currentExitPrice;
    floor = currentExitPrice * (1 - thresholds.trailFloorPct);
  }
  return { active, peak, floor };
}

/** Increment missing-chain streak. Returns new state and whether to force exit. */
export function incrementLeapMissingChain(
  state: LeapMissingChainState,
  config: SimConfig,
): { state: LeapMissingChainState; forceExitNow: boolean } {
  const missingExitAfter = config.missingChainExitAfterDays ?? Number.POSITIVE_INFINITY;
  const streak = state.streak + 1;
  const forceExitNow = missingExitAfter !== Infinity && missingExitAfter > 0 && streak >= missingExitAfter;
  return { state: { ...state, streak }, forceExitNow };
}

export function resetLeapMissingChain(lastKnownExitPrice: number): LeapMissingChainState {
  return { streak: 0, lastKnownExitPrice };
}

// ── Exit detection ────────────────────────────

/** Check signal-invalidation gate (returns true if position should exit via SIGNAL_REVERSAL). */
export function shouldExitOnSignalInvalidation(
  checkDate: string,
  signal: EntrySignal,
  config: SimConfig,
): boolean {
  if (!config.signalInvalidation || !signal.invalidation) return false;
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
  return !!invalidDate && checkDate >= invalidDate;
}

/**
 * Determine LEAP exit type for a given monitoring date.
 * Exit priority: TRAILING_LOCK → PROFIT_TARGET → STOP_LOSS → SIGNAL_REVERSAL → TIME_STOP.
 * Returns null if no exit triggered on this date.
 */
export function checkLeapExitType(
  currentExitPrice: number,
  thresholds: LeapThresholds,
  currentDTE: number,
  trail: LeapTrailState,
  signal: EntrySignal,
  config: SimConfig,
  checkDate: string,
): OptionExitType | null {
  if (trail.active && currentExitPrice < trail.floor) return 'TRAILING_LOCK';
  if (currentExitPrice >= thresholds.tpPrice) return 'PROFIT_TARGET';
  if (currentExitPrice <= thresholds.slPrice) return 'STOP_LOSS';
  if (shouldExitOnSignalInvalidation(checkDate, signal, config)) return 'SIGNAL_REVERSAL';
  if (currentDTE <= config.leapTimeStopDTE) return 'TIME_STOP';
  return null;
}

// ── Intrinsic value fallback ──────────────────

/** Intrinsic value of an option given current stock price. */
export function computeIntrinsicValue(stockPrice: number, strike: number, optionType: 'Call' | 'Put'): number {
  return optionType === 'Call'
    ? Math.max(0, stockPrice - strike)
    : Math.max(0, strike - stockPrice);
}

// ── Trade builder (canonical; was previously duplicated) ─────

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
  opts: { entrySlippage?: number; exitSlippage?: number; fillMode?: FillMode } = {},
): OptionTrade {
  const pnl = (exitPrice - entryPrice) * 100;
  const pnlPct = entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : 0;
  const holdDays = Math.round(
    (new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000,
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
