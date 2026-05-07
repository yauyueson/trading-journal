/**
 * PMCC short-leg cycle utilities.
 *
 * A PMCC position has one long LEAP + a rotating short call. Each "cycle" is
 * one short-call lifetime: opened at credit X, closed at debit Y (when rolled).
 * Cycles are stored inline on `position.legs` as historical short legs whose
 * `closedAt` is set; the active short is the one short-side leg without
 * `closedAt`.
 */
import type { Position, PositionLeg } from './types';
import { CONTRACT_MULTIPLIER } from './utils';

export interface PMCCSplit {
  longLeg: PositionLeg | undefined;
  activeShort: PositionLeg | undefined;
  closedShorts: PositionLeg[];
}

/** Split PMCC legs into long anchor, current short, and closed shorts. */
export function splitPMCCLegs(position: Position): PMCCSplit {
  const legs = position.legs ?? [];
  const longLeg = legs.find(l => l.side === 'long');
  const shortLegs = legs.filter(l => l.side === 'short');
  const activeShort = shortLegs.find(l => !l.closedAt);
  const closedShorts = shortLegs
    .filter(l => l.closedAt)
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  return { longLeg, activeShort, closedShorts };
}

/** Realized P&L (per contract, in dollars) for one closed short cycle. */
export function cycleRealizedPnL(leg: PositionLeg): number | undefined {
  if (leg.openedCredit == null || leg.closedCost == null) return undefined;
  return (leg.openedCredit - leg.closedCost) * CONTRACT_MULTIPLIER * (leg.cycleQty ?? 1);
}

/** Sum of realized P&L across all closed short cycles for this PMCC. */
export function totalRealizedShortPnL(position: Position): number {
  const { closedShorts } = splitPMCCLegs(position);
  return closedShorts.reduce((sum, leg) => sum + (cycleRealizedPnL(leg) ?? 0), 0);
}

/** DTE in days for a leg's expiration; returns null if no expiration. */
export function legDte(leg: PositionLeg | undefined): number | null {
  if (!leg?.expiration) return null;
  const ms = new Date(leg.expiration + 'T16:00:00').getTime() - Date.now();
  return Math.round(ms / 86_400_000);
}
