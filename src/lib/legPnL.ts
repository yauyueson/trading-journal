/**
 * Leg-based P&L utilities.
 *
 * Closed legs (those with `closedAt` set) contribute realized P&L:
 *   short closed: (openedCredit - closedCost) × 100 × cycleQty
 *   long  closed: (closedCost   - openedDebit) × 100 × cycleQty (sale proceeds − cost)
 *
 * Open legs contribute unrealized P&L when a per-share mark is supplied:
 *   short open: (openedCredit - currentMid) × 100 × qty
 *   long  open: (currentMid   - openedDebit) × 100 × qty
 *
 * Returns undefined contributions where the data is missing — the caller
 * decides whether to fall back to the legacy transaction-based path.
 */
import type { Position, PositionLeg } from './types';
import { CONTRACT_MULTIPLIER } from './utils';

export interface LegPnLEntry {
  legIndex: number;
  status: 'open' | 'closed';
  realized?: number;
  unrealized?: number;
}

export interface LegBasedPnL {
  /** Sum of every leg's realized contribution (skips legs with missing data). */
  realized: number;
  /** Sum of every leg's unrealized contribution (skips legs with missing data). */
  unrealized: number;
  /** Per-leg breakdown in the order legs appear on the position. */
  perLeg: LegPnLEntry[];
  /** True when every leg has enough data to compute its contribution. */
  complete: boolean;
}

export interface LegBasedHeadlinePnL {
  realized: number;
  unrealized: number;
  longUnrealized: number;
  unrealizedPct: number;
  basis: number;
  perLeg: LegPnLEntry[];
}

function legRealized(leg: PositionLeg): number | undefined {
  if (!leg.closedAt) return undefined;
  const qty = leg.cycleQty ?? 1;
  if (leg.side === 'short') {
    if (leg.openedCredit == null || leg.closedCost == null) return undefined;
    return (leg.openedCredit - leg.closedCost) * CONTRACT_MULTIPLIER * qty;
  }
  if (leg.openedDebit == null || leg.closedCost == null) return undefined;
  return (leg.closedCost - leg.openedDebit) * CONTRACT_MULTIPLIER * qty;
}

function legUnrealized(leg: PositionLeg, currentValue: number | undefined): number | undefined {
  if (currentValue == null || !Number.isFinite(currentValue)) return undefined;
  const qty = leg.cycleQty ?? 1;
  if (leg.side === 'short') {
    if (leg.openedCredit == null) return undefined;
    return (leg.openedCredit - currentValue) * CONTRACT_MULTIPLIER * qty;
  }
  if (leg.openedDebit == null) return undefined;
  return (currentValue - leg.openedDebit) * CONTRACT_MULTIPLIER * qty;
}

/**
 * Compute leg-level realized + unrealized P&L for a position.
 *
 * @param position  the position with its legs (jsonb)
 * @param legCurrentValues  per-leg mark prices (per share); index matches position.legs
 * @returns LegBasedPnL, or null if position has no legs at all
 */
export function computeLegBasedPnL(
  position: Position,
  legCurrentValues: Array<number | undefined> = [],
): LegBasedPnL | null {
  const legs = position.legs ?? [];
  if (legs.length === 0) return null;

  let realized = 0;
  let unrealized = 0;
  let complete = true;
  const perLeg: LegPnLEntry[] = [];

  legs.forEach((leg, i) => {
    const status: 'open' | 'closed' = leg.closedAt ? 'closed' : 'open';
    if (status === 'closed') {
      const r = legRealized(leg);
      if (r == null) complete = false;
      else realized += r;
      perLeg.push({ legIndex: i, status, realized: r });
    } else {
      const u = legUnrealized(leg, legCurrentValues[i]);
      if (u == null) complete = false;
      else unrealized += u;
      perLeg.push({ legIndex: i, status, unrealized: u });
    }
  });

  return { realized, unrealized, perLeg, complete };
}

/**
 * Headline P&L for rich leg-based positions.
 *
 * PMCC uses the long LEAP debit as the return denominator. Rolled short cycles
 * are represented as realized P&L, not as changes to the original entry basis.
 */
export function computeLegBasedHeadlinePnL(
  position: Position,
  legCurrentValues: Array<number | undefined> = [],
): LegBasedHeadlinePnL | null {
  const pnl = computeLegBasedPnL(position, legCurrentValues);
  if (!pnl || !pnl.complete) return null;

  const legs = position.legs ?? [];
  let longUnrealized = 0;
  const longDebitBasis = legs.reduce((sum, leg, i) => {
    if (leg.side !== 'long' || leg.openedDebit == null) return sum;
    const mark = legCurrentValues[i];
    if (!leg.closedAt && mark != null && Number.isFinite(mark)) {
      longUnrealized += (mark - leg.openedDebit) * CONTRACT_MULTIPLIER * (leg.cycleQty ?? 1);
    }
    return sum + leg.openedDebit * CONTRACT_MULTIPLIER * (leg.cycleQty ?? 1);
  }, 0);
  if (longDebitBasis <= 0) return null;

  return {
    realized: pnl.realized,
    unrealized: pnl.unrealized,
    longUnrealized,
    unrealizedPct: (pnl.unrealized / longDebitBasis) * 100,
    basis: longDebitBasis,
    perLeg: pnl.perLeg,
  };
}

/**
 * Returns true when a transaction should be excluded from the legacy
 * realized-P&L sum because its cash flow is already captured at the leg
 * level. Currently flags PMCC short rolls and per-leg close transactions.
 */
export function isLegLevelTransaction(note: string | null | undefined): boolean {
  if (!note) return false;
  return note.startsWith('PMCC roll:')
    || note.startsWith('Close leg:')
    || note.startsWith('Roll leg:');
}

/** @deprecated use isLegLevelTransaction — kept for back-compat with older callers. */
export const isCycleRollTransaction = isLegLevelTransaction;

/**
 * Filter leg-level transactions (rolls, per-leg closes) out of a list.
 * PMCC rolls and explicit per-leg closes insert Take-Profit transactions
 * whose net cash flow is captured on position.legs (closedCost,
 * openedCredit, openedDebit). Any aggregator that sums Take-Profit /
 * Close transactions naively will double-count them.
 */
export function filterCycleRolls<T extends { note?: string | null }>(transactions: T[]): T[] {
  return transactions.filter(t => !isLegLevelTransaction(t.note));
}

/**
 * Leg-aware running P&L for an open or closed position. Wraps the legacy
 * cost/proceeds sum but skips cycle-roll transactions and adds leg-level
 * cycle realized. Use for status lines on dashboards, daily recaps, and
 * any place that wants "net cash flow + cycle credits" for the position.
 *
 * Note: this returns a single number (legacy compat); for split realized
 * vs unrealized use computeLegBasedPnL plus a current price.
 */
export function computeLivePnL(
  position: Position,
  transactions: Array<{ quantity: number; price: number; note?: string | null }>,
  kindIsCredit: boolean,
): number {
  const filtered = filterCycleRolls(transactions);
  let cost = 0;
  let proceeds = 0;
  for (const t of filtered) {
    const dollars = t.price * CONTRACT_MULTIPLIER;
    if (t.quantity > 0) cost += t.quantity * dollars;
    else proceeds += Math.abs(t.quantity) * dollars;
  }
  const cashFlow = kindIsCredit ? cost - proceeds : proceeds - cost;
  const cycleRealized = computeLegBasedPnL(position)?.realized ?? 0;
  return cashFlow + cycleRealized;
}
