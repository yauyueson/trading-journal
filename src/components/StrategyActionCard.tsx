import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { StrategyStatus } from '../hooks/useStrategyStatus';
import type { Transaction } from '../lib/types';
import { formatCurrency, getStrategyKind } from '../lib/utils';
import { computeLivePnL, computeLegBasedPnL } from '../lib/legPnL';

interface Props {
  status: StrategyStatus;
  /** Transactions for the open position only (already filtered). */
  positionTransactions: Transaction[];
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
  onEnter,
  onManage,
}) => {
  const { strategy, profile, openPosition, state } = status;
  const ticker = profile.tickers?.[0] ?? 'QQQ';

  // This card has no live option marks. A credit strategy banks premium up front,
  // so its cash-flow figure is a meaningful P&L without marks. A debit/diagonal
  // open position CANNOT be marked-to-market here — computeLivePnL would surface
  // the unrecovered entry debit as a phantom loss (e.g. an open PMCC showing
  // −$9.8K). For those we only show realized-to-date (closed roll cycles) and
  // render the unmarkable total as "—", consistent with PositionCard.
  const kind = openPosition ? getStrategyKind(openPosition) : null;
  const cashFlowIsPnL = kind === 'credit';
  const livePnl = openPosition && cashFlowIsPnL
    ? computeLivePnL(openPosition, positionTransactions, true)
    : 0;
  const realizedToDate = openPosition ? (computeLegBasedPnL(openPosition)?.realized ?? 0) : 0;

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

      <p className="text-text-secondary text-xs font-mono mb-3 min-h-[18px]">{contextLine}</p>

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
