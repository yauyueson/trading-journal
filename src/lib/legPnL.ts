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
 * Returns true when a transaction should be excluded from the legacy
 * realized-P&L sum because its cash flow is already captured at the leg
 * level (PMCC roll close + open pair).
 */
export function isCycleRollTransaction(note: string | null | undefined): boolean {
  return !!note && note.startsWith('PMCC roll:');
}
