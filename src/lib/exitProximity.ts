/**
 * Exit-proximity evaluation for the dashboard summary.
 *
 * The position card computes exit badges from a live per-leg quote fetch, but
 * the dashboard's StrategyActionCard has no live marks. This evaluates what's
 * reliably knowable from the position row alone:
 *   - Time stop: purely DTE-based (expiration + profile.timeStopDTE) — exact.
 *   - Take profit (debit spreads / BCD): from the last-persisted net price
 *     (position.current_price) against the sealed-backtest target
 *     (tpFraction of max profit). A "near" heads-up, not a fill signal.
 *
 * PMCC (diagonal) long-leg exits, mirroring worker.ts (LEAP return on its own
 * debit, mid mark):
 *   - LEAP time stop: LEAP leg DTE ≤ profile.longTimeStopDTE — exact, no marks.
 *   - LEAP SL / PT: need the LEAP mark, so only when `opts.legMarks` (indexed
 *     like position.legs) is passed. Short-roll signals stay on the card.
 */
import type { Position } from './types';
import type { StrategyProfile } from './strategyProfiles';
import { daysUntil } from './utils';
import { computeNetSpreadPrice, debitSpreadTpProgress } from './legPnL';

export type ExitLevel = 'met' | 'close' | 'none';

export interface ExitProximity {
  level: ExitLevel;
  /** Short badge label, e.g. "TIME STOP · DTE 7", "EXIT IN 2d", "TP READY", "TP 88%". */
  label: string;
  reason: 'time' | 'tp' | 'sl' | null;
}

const NONE: ExitProximity = { level: 'none', label: '', reason: null };

export function evaluateExitProximity(
  position: Position,
  profile: StrategyProfile,
  opts: { timeCloseBufferDays?: number; tpNearPct?: number; legMarks?: Array<number | undefined> } = {},
): ExitProximity {
  if (profile.kind === 'diagonal') return evaluateDiagonalLongExit(position, profile, opts);
  const timeCloseBuffer = opts.timeCloseBufferDays ?? 3;
  const tpNearPct = opts.tpNearPct ?? 85;

  // --- Time stop (exact, no live marks) ---
  const dte = position.expiration ? daysUntil(position.expiration) : null;
  const timeStopDTE = profile.timeStopDTE ?? 0;
  let timeProx: ExitProximity = NONE;
  if (timeStopDTE > 0 && dte != null && dte >= 0) {
    if (dte <= timeStopDTE) {
      timeProx = { level: 'met', label: `TIME STOP · DTE ${dte}`, reason: 'time' };
    } else if (dte <= timeStopDTE + timeCloseBuffer) {
      timeProx = { level: 'close', label: `EXIT IN ${dte - timeStopDTE}d`, reason: 'time' };
    }
  }

  // --- Take profit (debit spread only; last-persisted net price) ---
  let tpProx: ExitProximity = NONE;
  if (profile.kind === 'debit_spread') {
    const legs = position.legs ?? [];
    const longLeg = legs.find(l => l.side === 'long' && !l.closedAt);
    const shortLeg = legs.find(l => l.side === 'short' && !l.closedAt);
    const width = longLeg && shortLeg ? Math.abs(shortLeg.strike - longLeg.strike) : null;
    const current = position.current_price != null && position.current_price > 0
      ? position.current_price
      : null;
    const tp = debitSpreadTpProgress({
      entryDebit: computeNetSpreadPrice(position).entry,
      currentValue: current,
      width,
      tpFraction: profile.profitTarget,
    });
    if (tp != null) {
      if (tp >= 100) tpProx = { level: 'met', label: 'TP READY', reason: 'tp' };
      else if (tp >= tpNearPct) tpProx = { level: 'close', label: `TP ${Math.round(tp)}%`, reason: 'tp' };
    }
  }

  // Most urgent wins: a met signal beats a close one; TP is preferred when tied.
  const candidates = [tpProx, timeProx].filter(p => p.level !== 'none');
  if (candidates.length === 0) return NONE;
  return candidates.find(p => p.level === 'met') ?? candidates[0];
}

function evaluateDiagonalLongExit(
  position: Position,
  profile: StrategyProfile,
  opts: { timeCloseBufferDays?: number; legMarks?: Array<number | undefined> },
): ExitProximity {
  const timeCloseBuffer = opts.timeCloseBufferDays ?? 3;
  const legs = position.legs ?? [];
  const longIdx = legs.findIndex(l => l.side === 'long' && !l.closedAt);
  if (longIdx < 0) return NONE;
  const longLeg = legs[longIdx];

  let priceProx: ExitProximity = NONE;
  const mark = opts.legMarks?.[longIdx];
  const debit = longLeg.openedDebit;
  if (mark != null && Number.isFinite(mark) && debit != null && debit > 0) {
    const ret = (mark - debit) / debit;
    if (profile.longProfitTarget != null && ret >= profile.longProfitTarget) {
      priceProx = { level: 'met', label: 'LEAP TP READY', reason: 'tp' };
    } else if (profile.longStopLoss != null && ret <= -profile.longStopLoss) {
      priceProx = { level: 'met', label: `LEAP STOP · ${Math.round(ret * 100)}%`, reason: 'sl' };
    }
  }

  let timeProx: ExitProximity = NONE;
  const stopDte = profile.longTimeStopDTE ?? 0;
  if (stopDte > 0 && longLeg.expiration) {
    const dte = daysUntil(longLeg.expiration);
    if (dte <= stopDte) timeProx = { level: 'met', label: `LEAP TIME STOP · DTE ${dte}`, reason: 'time' };
    else if (dte <= stopDte + timeCloseBuffer) timeProx = { level: 'close', label: `EXIT IN ${dte - stopDte}d`, reason: 'time' };
  }

  const candidates = [priceProx, timeProx].filter(p => p.level !== 'none');
  if (candidates.length === 0) return NONE;
  return candidates.find(p => p.level === 'met') ?? candidates[0];
}
