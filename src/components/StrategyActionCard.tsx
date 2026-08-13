import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { StrategyStatus } from '../hooks/useStrategyStatus';
import type { Transaction } from '../lib/types';
import { formatCurrency, formatPrice, getStrategyKind } from '../lib/utils';
import { computeLivePnL, computeLegBasedPnL, computeDiagonalHeadline, computeNetSpreadPrice } from '../lib/legPnL';
import { evaluateExitProximity } from '../lib/exitProximity';

interface Props {
  status: StrategyStatus;
  /** Transactions for the open position only (already filtered). */
  positionTransactions: Transaction[];
  /**
   * Live per-share marks indexed to match `openPosition.legs` (closed legs
   * undefined). Omit — or leave an open leg undefined — and the card falls back
   * to its mark-free view rather than fabricating a P&L.
   */
  legMarks?: Array<number | undefined>;
  onEnter: () => void;
  onManage?: () => void;
}

const PILL_BY_STATE = {
  open: {
    bg: 'bg-phosphor-amber/10',
    text: 'text-phosphor-amber text-glow-amber',
    ring: 'ring-phosphor-amber/40',
    dot: 'bg-phosphor-amber pulse-glow',
  },
  ready: {
    bg: 'bg-phosphor-green/10',
    text: 'text-phosphor-green text-glow-green',
    ring: 'ring-phosphor-green/40',
    dot: 'bg-phosphor-green pulse-glow',
  },
  waiting: {
    bg: 'bg-white/[0.04]',
    text: 'text-text-tertiary',
    ring: 'ring-white/[0.06]',
    dot: 'bg-text-tertiary/30',
  },
} as const;

export const StrategyActionCard: React.FC<Props> = ({
  status,
  positionTransactions,
  legMarks,
  onEnter,
  onManage,
}) => {
  const { strategy, profile, openPosition, state } = status;
  const ticker = profile.tickers?.[0] ?? 'QQQ';

  // A credit strategy banks premium up front, so its cash-flow figure is a
  // meaningful P&L with or without marks. A debit/diagonal open position can
  // only be marked-to-market when `legMarks` covers every open leg —
  // computeLivePnL would otherwise surface the unrecovered entry debit as a
  // phantom loss (e.g. an open PMCC showing −$9.8K). Without complete marks we
  // fall back to realized-to-date and render the total as "—", as PositionCard does.
  const kind = openPosition ? getStrategyKind(openPosition) : null;
  const cashFlowIsPnL = kind === 'credit';
  const livePnl = openPosition && cashFlowIsPnL
    ? computeLivePnL(openPosition, positionTransactions, true)
    : 0;
  const realizedToDate = openPosition ? (computeLegBasedPnL(openPosition)?.realized ?? 0) : 0;

  // Leg-mark view: net unrealized across the open legs, plus the position-level
  // spread price (entry → now). `known` is false the moment any open leg lacks
  // a mark, which is what keeps the fallback above honest.
  const headline = openPosition && !cashFlowIsPnL
    ? computeDiagonalHeadline(openPosition, legMarks ?? [])
    : null;
  const markedUnrealized = headline?.known ? headline.unrealized : null;
  const netSpread = openPosition && !cashFlowIsPnL
    ? computeNetSpreadPrice(openPosition, legMarks ?? [])
    : null;

  // Exit-proximity heads-up. The summary has no live marks, so this is the
  // reliable-from-the-row view: exact time stop (DTE) + last-known-price TP for
  // BCD. PMCC returns 'none' (its PT/SL/roll signals stay on the card).
  const exit = state === 'open' && openPosition ? evaluateExitProximity(openPosition, profile) : null;
  const exitChipClass = exit?.level === 'met'
    ? (exit.reason === 'tp'
        ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green ring-phosphor-green/40'
        : 'bg-phosphor-red/10 text-phosphor-red text-glow-red ring-phosphor-red/40')
    : 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber ring-phosphor-amber/40';

  const pill = PILL_BY_STATE[state];
  const pillLabel =
    state === 'open'
      ? 'OPEN'
      : state === 'ready'
        ? 'READY'
        : status.daysUntilEmission != null && status.daysUntilEmission > 0
          ? `WAITING ${status.daysUntilEmission}d`
          : 'WAITING';

  let contextLine: string;
  if (state === 'open' && openPosition) {
    const date = status.openSinceDate ?? '?';
    if (cashFlowIsPnL) {
      const pnlSign = livePnl >= 0 ? '+' : '−';
      contextLine = `Open since ${date} · ${pnlSign}${formatCurrency(Math.abs(livePnl))}`;
    } else if (markedUnrealized != null) {
      const sign = markedUnrealized >= 0 ? '+' : '−';
      const realizedSuffix = realizedToDate !== 0
        ? ` · ${realizedToDate > 0 ? '+' : '−'}${formatCurrency(Math.abs(realizedToDate))} realized`
        : '';
      contextLine = `Open since ${date} · ${sign}${formatCurrency(Math.abs(markedUnrealized))}${realizedSuffix}`;
    } else if (realizedToDate !== 0) {
      const sign = realizedToDate > 0 ? '+' : '−';
      contextLine = `Open since ${date} · ${sign}${formatCurrency(Math.abs(realizedToDate))} realized`;
    } else {
      contextLine = `Open since ${date} · P&L —`;
    }
  } else if (state === 'ready') {
    contextLine =
      strategy === 'pmcc'
        ? 'Always-in — flat. Open long LEAP + short cycle.'
        : 'Eligible to enter on next trading day.';
  } else {
    contextLine = `${status.tradingDaysSince ?? 0} trading days since last close · Next: ${status.nextEmissionDate ?? '?'}`;
  }

  return (
    <div className="terminal-panel px-4 py-4 flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <span className="text-text-primary font-mono text-sm font-bold uppercase tracking-wider">
          {profile.shortLabel} {ticker}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase ring-1 ${pill.bg} ${pill.text} ${pill.ring}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${pill.dot}`} />
          {pillLabel}
        </span>
      </div>

      {exit && exit.level !== 'none' && (
        <div className={`inline-flex items-center gap-1.5 self-start px-2 py-0.5 mb-2 rounded text-[10px] font-mono font-bold tracking-wider uppercase ring-1 ${exitChipClass}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-current pulse-glow" aria-hidden="true" />
          {exit.label}
        </div>
      )}

      <p className="text-text-secondary text-xs font-mono mb-2 min-h-[18px]">{contextLine}</p>

      {netSpread?.entry != null && (
        <p className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider mb-3">
          <span className="text-text-tertiary">Net debit</span>
          <span className="text-text-primary font-bold">{formatPrice(netSpread.entry)}</span>
          <span className="text-text-tertiary" aria-hidden="true">→</span>
          <span className={netSpread.current == null
            ? 'text-text-tertiary'
            : netSpread.current >= netSpread.entry
              ? 'text-phosphor-green text-glow-green font-bold'
              : 'text-phosphor-red text-glow-red font-bold'}>
            {netSpread.current != null ? formatPrice(netSpread.current) : '—'}
          </span>
        </p>
      )}

      <p className="text-text-tertiary text-[10px] font-mono uppercase tracking-wider mb-3 truncate">
        {profile.subtitle}
      </p>

      <div className="mt-auto">
        {state === 'open' ? (
          onManage ? (
            <button type="button" onClick={onManage} className="btn-terminal w-full">
              ▌ MANAGE <ChevronRight size={12} className="inline ml-1" />
            </button>
          ) : (
            <div className="text-text-tertiary text-[10px] font-mono uppercase tracking-wider text-center py-2">
              Tracked below
            </div>
          )
        ) : state === 'ready' ? (
          <button type="button" onClick={onEnter} className="btn-terminal w-full">
            ▌ ENTER {profile.shortLabel} <ChevronRight size={12} className="inline ml-1" />
          </button>
        ) : (
          <div className="text-text-tertiary text-[10px] font-mono uppercase tracking-wider text-center py-2 ring-1 ring-white/[0.06] rounded">
            ▌ NEXT EMISSION IN {status.daysUntilEmission ?? '?'}d
          </div>
        )}
      </div>
    </div>
  );
};
