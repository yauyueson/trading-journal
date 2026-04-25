/**
 * Fill-diagnostics capture helpers for the BCD and PMCC entry modals.
 *
 * When a user submits a trade, we pair their actual fill price with the
 * chain snapshot that was in front of them (bid/ask/mid/OI/delta from the
 * most recent scan-options fetch) and the slippage model's prediction.
 * Persisted rows let us calibrate src/lib/backtest/slippage.ts against live
 * fills after a few weeks of real trading.
 *
 * The capture is best-effort: if the user typed strikes that don't match
 * any fetched chain option (e.g. they picked a strike that wasn't in the
 * δ window the scan queried), the leg's snapshot is null and the row still
 * records the actual fill — we just can't compute slippage for that leg.
 */
import type { ChainOption } from './chainCandidates';
import { applyFill } from './backtest/slippage';
import { DEFAULT_DYNAMIC_SLIPPAGE } from './backtest/types';

export interface FillDiagnosticsLeg {
  role: 'long' | 'short';
  side: 'buy' | 'sell';
  strike: number;
  type: 'Call' | 'Put';
  expiration: string;
  dte: number | null;
  // Snapshot (null when user entered a strike not found in the fetched chain)
  bid: number | null;
  mid: number | null;
  ask: number | null;
  delta: number | null;
  iv: number | null;
  openInterest: number | null;
  volume: number | null;
  // Model prediction (null when snapshot missing)
  predictedFill: number | null;
  predictedSlippage: number | null;
}

export interface FillDiagnosticsPayload {
  strategyType: 'bcd' | 'pmcc';
  quantity: number;
  chainFetchedAt: string | null;
  actualNetDebit: number;
  actualLongDebit: number | null;
  actualShortCredit: number | null;
  legs: FillDiagnosticsLeg[];
  predictedNetDebit: number | null;
  predictedSlippage: number | null;
  slippageDeltaAbs: number | null;  // actual − predicted (positive = user worse than model)
}

/**
 * Look up a specific strike + expiration in a fetched chain.
 * Returns null if the user's entered strike wasn't in the scanned δ window.
 */
export function findChainOption(
  chain: ChainOption[] | undefined | null,
  strike: number,
  expiration: string,
  type: 'Call' | 'Put',
): ChainOption | null {
  if (!chain) return null;
  for (const opt of chain) {
    if (opt.type === type && opt.strike === strike && opt.expiration === expiration) {
      return opt;
    }
  }
  return null;
}

function buildLegSnapshot(
  role: 'long' | 'short',
  side: 'buy' | 'sell',
  strike: number,
  type: 'Call' | 'Put',
  expiration: string,
  opt: ChainOption | null,
): FillDiagnosticsLeg {
  if (!opt) {
    return {
      role, side, strike, type, expiration,
      dte: null, bid: null, mid: null, ask: null,
      delta: null, iv: null, openInterest: null, volume: null,
      predictedFill: null, predictedSlippage: null,
    };
  }

  const bid = opt.liquidity.bid;
  const ask = opt.liquidity.ask;
  const mid = (bid + ask) / 2;
  // Uses the same bidask-mode + default dynamic slippage config as the
  // backtests the F1 anchors were sealed under, so predictions are directly
  // comparable to the simulator's forecasts.
  const fill = applyFill('bidask', mid, bid, ask, side, DEFAULT_DYNAMIC_SLIPPAGE, opt.liquidity.openInterest, opt.dte);
  return {
    role, side, strike, type, expiration,
    dte: opt.dte,
    bid, mid, ask,
    delta: opt.greeks.delta,
    iv: opt.greeks.iv,
    openInterest: opt.liquidity.openInterest,
    volume: opt.liquidity.volume,
    predictedFill: fill.fillPrice,
    predictedSlippage: fill.slippage,
  };
}

export interface BuildBcdPayloadArgs {
  quantity: number;
  netDebit: number;              // user-entered per-share net debit
  longStrike: number;
  shortStrike: number;
  expiration: string;
  chain: ChainOption[] | undefined | null;
  chainFetchedAt?: string | null;
}

export function buildBcdFillDiagnostics(args: BuildBcdPayloadArgs): FillDiagnosticsPayload {
  const longOpt  = findChainOption(args.chain, args.longStrike,  args.expiration, 'Call');
  const shortOpt = findChainOption(args.chain, args.shortStrike, args.expiration, 'Call');

  const longLeg  = buildLegSnapshot('long',  'buy',  args.longStrike,  'Call', args.expiration, longOpt);
  const shortLeg = buildLegSnapshot('short', 'sell', args.shortStrike, 'Call', args.expiration, shortOpt);

  let predictedNetDebit: number | null = null;
  let predictedSlippage: number | null = null;
  if (longOpt && shortOpt) {
    // BCD: long is bought (debit), short is sold (credit). applySpreadFill
    // treats the net-debit-side as (short − long), which matches the
    // existing backtest convention for credit spreads. For BCD we want the
    // absolute net debit, so we negate appropriately.
    const longMid  = (longOpt.liquidity.bid  + longOpt.liquidity.ask)  / 2;
    const shortMid = (shortOpt.liquidity.bid + shortOpt.liquidity.ask) / 2;
    predictedNetDebit = (longLeg.predictedFill ?? longMid) - (shortLeg.predictedFill ?? shortMid);
    predictedSlippage = (longLeg.predictedSlippage ?? 0) + (shortLeg.predictedSlippage ?? 0);
  }

  const slippageDeltaAbs = predictedNetDebit != null
    ? args.netDebit - predictedNetDebit
    : null;

  return {
    strategyType: 'bcd',
    quantity: args.quantity,
    chainFetchedAt: args.chainFetchedAt ?? null,
    actualNetDebit: args.netDebit,
    actualLongDebit: null,
    actualShortCredit: null,
    legs: [longLeg, shortLeg],
    predictedNetDebit,
    predictedSlippage,
    slippageDeltaAbs,
  };
}

export interface BuildPmccPayloadArgs {
  quantity: number;
  longDebit: number;            // user-entered per-share long LEAP debit
  shortCredit: number;          // user-entered per-share short credit
  longStrike: number;
  longExpiration: string;
  shortStrike: number;
  shortExpiration: string;
  longChain: ChainOption[] | undefined | null;
  shortChain: ChainOption[] | undefined | null;
  chainFetchedAt?: string | null;
}

export function buildPmccFillDiagnostics(args: BuildPmccPayloadArgs): FillDiagnosticsPayload {
  const longOpt  = findChainOption(args.longChain,  args.longStrike,  args.longExpiration,  'Call');
  const shortOpt = findChainOption(args.shortChain, args.shortStrike, args.shortExpiration, 'Call');

  const longLeg  = buildLegSnapshot('long',  'buy',  args.longStrike,  'Call', args.longExpiration,  longOpt);
  const shortLeg = buildLegSnapshot('short', 'sell', args.shortStrike, 'Call', args.shortExpiration, shortOpt);

  // PMCC legs are on different expirations, so applySpreadFill (which
  // assumes a single effectiveDTE) doesn't cleanly apply. Sum the per-leg
  // predictions instead — same cost as the backtest's DIAGONAL mode does.
  const predictedLong  = longLeg.predictedFill;
  const predictedShort = shortLeg.predictedFill;
  const predictedNetDebit = (predictedLong != null && predictedShort != null)
    ? predictedLong - predictedShort
    : null;
  const predictedSlippage = (longLeg.predictedSlippage ?? 0) + (shortLeg.predictedSlippage ?? 0);

  const actualNetDebit = args.longDebit - args.shortCredit;
  const slippageDeltaAbs = predictedNetDebit != null
    ? actualNetDebit - predictedNetDebit
    : null;

  return {
    strategyType: 'pmcc',
    quantity: args.quantity,
    chainFetchedAt: args.chainFetchedAt ?? null,
    actualNetDebit,
    actualLongDebit: args.longDebit,
    actualShortCredit: args.shortCredit,
    legs: [longLeg, shortLeg],
    predictedNetDebit,
    predictedSlippage,
    slippageDeltaAbs,
  };
}
