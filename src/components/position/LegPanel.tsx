/**
 * LegPanel — clickable, expandable card for one leg of a multi-leg position.
 *
 * Collapsed state shows summary (strike, expiration, DTE, credit/debit, P&L).
 * Click to expand → inline edit form for strike / expiration / opened
 * credit-or-debit. Save persists via useUpdateLeg; cancel reverts.
 */
import React, { useState } from 'react';
import { Pencil, Check, X as XIcon } from 'lucide-react';
import type { Position, PositionLeg } from '../../lib/types';
import { useUpdateLeg } from '../../hooks/usePositionMutations';
import { formatDateWithYear, formatCurrency } from '../../lib/utils';
import { legDte } from '../../lib/pmccCycles';

export type LegRole = 'leap' | 'active-short' | 'long' | 'short';

export interface LegPanelProps {
  position: Position;
  legIndex: number;
  role: LegRole;
  /** Tone for the panel border. */
  tone?: 'green' | 'amber' | 'dim';
  /** Header label, e.g., 'LEAP_ANCHOR', 'ACTIVE_SHORT', 'LONG_LEG'. */
  title: string;
  /** Right-side hint text describing strategy parameters for this leg. */
  hint?: string;
  /** Currency-formatted P&L for this leg, if known. Undefined → render '—'. */
  legPnL?: number;
  /** Right-side P&L label (e.g., "Unrealized" / "Realized"). */
  pnlLabel?: string;
}

const TONE_CLASS: Record<NonNullable<LegPanelProps['tone']>, string> = {
  green: 'border-phosphor-green/25',
  amber: 'border-phosphor-amber/30',
  dim: 'border-border-default',
};

const TITLE_CLASS: Record<NonNullable<LegPanelProps['tone']>, string> = {
  green: 'text-phosphor-green text-glow-green',
  amber: 'text-phosphor-amber text-glow-amber',
  dim: 'text-text-secondary',
};

export const LegPanel: React.FC<LegPanelProps> = ({
  position,
  legIndex,
  role,
  tone = 'dim',
  title,
  hint,
  legPnL,
  pnlLabel,
}) => {
  const leg = position.legs?.[legIndex];
  const [editing, setEditing] = useState(false);
  const [strike, setStrike] = useState(leg?.strike?.toString() ?? '');
  const [expiration, setExpiration] = useState(leg?.expiration ?? '');
  const isShort = role === 'short' || role === 'active-short';
  const fillFieldLabel = isShort ? 'Open credit' : 'Entry debit';
  const [fillPrice, setFillPrice] = useState(
    isShort
      ? (leg?.openedCredit?.toString() ?? '')
      : '',
  );
  const updateLeg = useUpdateLeg();
  const [error, setError] = useState<string | null>(null);

  if (!leg) {
    return (
      <div className={`terminal-panel p-3 ${TONE_CLASS[tone]} opacity-50`}>
        <div className="text-xs font-mono text-text-tertiary">{title} (leg missing)</div>
      </div>
    );
  }

  const dte = legDte(leg);
  const dteClass = dte == null ? 'text-text-tertiary'
    : dte <= 7 ? 'text-phosphor-red text-glow-red'
    : dte <= 21 ? 'text-phosphor-amber text-glow-amber'
    : 'text-phosphor-green text-glow-green';

  const reset = () => {
    setStrike(leg.strike?.toString() ?? '');
    setExpiration(leg.expiration ?? '');
    setFillPrice(isShort ? (leg.openedCredit?.toString() ?? '') : '');
    setError(null);
  };

  const handleSave = async () => {
    setError(null);
    const strikeNum = parseFloat(strike);
    if (!Number.isFinite(strikeNum) || strikeNum <= 0) {
      setError('Strike must be a positive number');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
      setError('Expiration must be YYYY-MM-DD');
      return;
    }
    const fillNum = fillPrice === '' ? undefined : parseFloat(fillPrice);
    if (fillPrice !== '' && (!Number.isFinite(fillNum) || (fillNum as number) < 0)) {
      setError(`${fillFieldLabel} must be ≥ 0`);
      return;
    }
    const patch: Partial<PositionLeg> = { strike: strikeNum, expiration };
    if (isShort) patch.openedCredit = fillNum;
    try {
      await updateLeg.mutateAsync({ position, legIndex, patch });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancel = () => {
    reset();
    setEditing(false);
  };

  return (
    <div className={`terminal-panel p-3 ${TONE_CLASS[tone]} transition-colors ${editing ? 'ring-1 ring-phosphor-green/30' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => !editing && setEditing(true)}
          className={`text-[11px] font-mono uppercase tracking-widest ${TITLE_CLASS[tone]} flex items-center gap-1.5 hover:underline`}
          aria-label={`Edit ${title}`}
        >
          ▌ {title}
          {!editing && <Pencil size={10} className="opacity-60" />}
        </button>
        {hint && <div className="text-[11px] font-mono text-text-tertiary truncate">{hint}</div>}
      </div>

      {!editing && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs font-mono">
          <div>
            <div className="text-text-tertiary uppercase tracking-wider mb-0.5">Strike</div>
            <div className="text-text-primary text-base">${leg.strike}</div>
          </div>
          <div>
            <div className="text-text-tertiary uppercase tracking-wider mb-0.5">Expiration</div>
            <div className="text-text-primary">{formatDateWithYear(leg.expiration)}</div>
          </div>
          <div>
            <div className="text-text-tertiary uppercase tracking-wider mb-0.5">DTE</div>
            <div className={`text-base font-bold ${dteClass}`}>
              {dte != null ? `${dte}d` : '—'}
            </div>
          </div>
          <div>
            <div className="text-text-tertiary uppercase tracking-wider mb-0.5">{fillFieldLabel}</div>
            <div className={isShort ? 'text-phosphor-green text-glow-green' : 'text-text-primary'}>
              {isShort
                ? (leg.openedCredit != null ? `$${leg.openedCredit.toFixed(2)}` : '—')
                : '—'}
            </div>
          </div>
          <div>
            <div className="text-text-tertiary uppercase tracking-wider mb-0.5">{pnlLabel ?? 'P&L'}</div>
            <div className={`font-bold ${legPnL == null ? 'text-text-tertiary' : legPnL > 0 ? 'text-phosphor-green text-glow-green' : legPnL < 0 ? 'text-phosphor-red text-glow-red' : 'text-text-tertiary'}`}>
              {legPnL == null ? '—' : `${legPnL >= 0 ? '+' : ''}${formatCurrency(legPnL)}`}
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="space-y-2 pt-1">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label className="label-mono mb-1 block">Strike</label>
              <input
                type="number"
                step="0.5"
                value={strike}
                onChange={e => setStrike(e.target.value)}
                className="w-full px-3 py-2 rounded-md font-mono text-sm bg-terminal-black border border-border-default text-white"
              />
            </div>
            <div>
              <label className="label-mono mb-1 block">Expiration</label>
              <input
                type="date"
                value={expiration}
                onChange={e => setExpiration(e.target.value)}
                className="w-full px-3 py-2 rounded-md font-mono text-sm bg-terminal-black border border-border-default text-white"
              />
            </div>
            {isShort && (
              <div>
                <label className="label-mono mb-1 block">{fillFieldLabel}</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={fillPrice}
                  onChange={e => setFillPrice(e.target.value)}
                  className="w-full px-3 py-2 rounded-md font-mono text-sm bg-terminal-black border border-border-default text-white"
                  placeholder="per share"
                />
              </div>
            )}
          </div>
          {error && (
            <div className="text-[11px] font-mono text-phosphor-red text-glow-red">▌ {error}</div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={updateLeg.isPending}
              className="btn-terminal flex items-center gap-1.5 px-3 py-1.5 text-xs"
            >
              <Check size={12} /> {updateLeg.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={updateLeg.isPending}
              className="btn-terminal-danger flex items-center gap-1.5 px-3 py-1.5 text-xs"
            >
              <XIcon size={12} /> Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
