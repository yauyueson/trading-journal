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

export interface DiagonalHeadline {
  /**
   * False when the position's open legs lack complete live marks. Callers MUST
   * render the unrealized headline as "—" in this case and must NOT fall back to
   * single-instrument (mark − blendedCost) math — that is meaningless for a
   * two-leg diagonal and fabricates a number (the long leg's mark valued as the
   * whole position, with the short liability and roll cash-flows ignored).
   */
  known: boolean;
  /** Net unrealized across open legs (long + active short). 0 when !known. */
  unrealized: number;
  /** Net unrealized as % of long-debit basis. 0 when !known. */
  unrealizedPct: number;
  /** Open long leg unrealized only (for the long-leg PT bar). 0 when !known. */
  longUnrealized: number;
  /** Long-debit basis. 0 when !known. */
  basis: number;
  /**
   * Realized P&L from closed short cycles. This is valid even when !known —
   * closed legs carry their own openedCredit/closedCost and need no live mark.
   */
  realized: number;
}

/**
 * Single decision point for a PMCC/diagonal position's headline P&L.
 *
 * When every open leg has a live mark, returns the full leg-aware numbers
 * (known: true). When any open leg is missing a mark, returns known: false so
 * the caller shows "—" instead of fabricating a number from the legacy
 * single-instrument path. Realized cycle P&L is always returned.
 */
export function computeDiagonalHeadline(
  position: Position,
  legCurrentValues: Array<number | undefined> = [],
): DiagonalHeadline {
  const headline = computeLegBasedHeadlinePnL(position, legCurrentValues);
  const realized = headline?.realized ?? computeLegBasedPnL(position, legCurrentValues)?.realized ?? 0;
  if (!headline) {
    return { known: false, unrealized: 0, unrealizedPct: 0, longUnrealized: 0, basis: 0, realized };
  }
  return {
    known: true,
    unrealized: headline.unrealized,
    unrealizedPct: headline.unrealizedPct,
    longUnrealized: headline.longUnrealized,
    basis: headline.basis,
    realized,
  };
}

export interface NetSpreadPrice {
  /** Net debit per share at entry across OPEN legs: Σ (long +openedDebit, short −openedCredit). null if any open leg lacks its fill. */
  entry: number | null;
  /** Net debit per share now across OPEN legs: Σ (long +mark, short −mark). null if any open leg lacks a live mark. */
  current: number | null;
}

/**
 * Position-level "spread price" for a multi-leg debit/diagonal: what you paid
 * to open the current open structure (entry) vs what it's worth now (current).
 *
 * Only OPEN legs count — a rolled-off short is realized separately. The current
 * value sums the SAME per-leg marks the Current column shows, so entry → now is
 * verifiable against the leg rows (e.g. BCD long 4.09 − short 0.14 = 3.95).
 */
export function computeNetSpreadPrice(
  position: Position,
  legCurrentValues: Array<number | undefined> = [],
): NetSpreadPrice {
  const legs = position.legs ?? [];
  let entry = 0;
  let current = 0;
  let entryKnown = true;
  let currentKnown = true;
  let sawOpenLeg = false;
  legs.forEach((leg, i) => {
    if (leg.closedAt) return;
    sawOpenLeg = true;
    const sign = leg.side === 'short' ? -1 : 1;
    const fill = leg.side === 'short' ? leg.openedCredit : leg.openedDebit;
    if (fill != null) entry += sign * fill;
    else entryKnown = false;
    const mark = legCurrentValues[i];
    if (mark != null && Number.isFinite(mark)) current += sign * mark;
    else currentKnown = false;
  });
  return {
    entry: sawOpenLeg && entryKnown ? entry : null,
    current: sawOpenLeg && currentKnown ? current : null,
  };
}

/**
 * Take-profit progress (%) for a debit spread (BCD), anchored to the SEALED
 * backtest's exit rule: the target is `tpFraction` of MAX profit (width − net
 * debit), NOT `tpFraction` of the debit paid. Mirrors scripts/autoresearch/
 * worker.ts, which exits when `curSpreadMid − netDebit ≥ debitProfitTargetPct ×
 * (width − netDebit)`. Uses the mid net value (like the worker's curSpreadMid).
 *
 * Returns null when any input is missing or max profit is non-positive — the
 * caller hides the bar rather than showing a wrong number.
 */
export function debitSpreadTpProgress(args: {
  /** Net debit paid per share at entry. */
  entryDebit: number | null;
  /** Current net spread value per share (long mid − short mid). */
  currentValue: number | null;
  /** Strike width per share (|short strike − long strike|). */
  width: number | null;
  /** Profit-target fraction of max profit, e.g. 0.50. */
  tpFraction: number;
}): number | null {
  const { entryDebit, currentValue, width, tpFraction } = args;
  if (entryDebit == null || currentValue == null || width == null) return null;
  if (!(tpFraction > 0)) return null;
  const maxProfit = width - entryDebit;
  if (!(maxProfit > 0)) return null;
  return Math.max(0, ((currentValue - entryDebit) / (tpFraction * maxProfit)) * 100);
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
