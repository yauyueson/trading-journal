/**
 * LegPanel — clickable, expandable card for one leg of a multi-leg position.
 *
 * Workflow modes:
 *   collapsed → summary view
 *   menu      → action chooser (Edit / Close / Roll [if applicable])
 *   edit      → inline form to fix metadata (strike, expiration, fill)
 *   close     → inline form to mark this leg closed (close fill + qty),
 *               leaves the rest of the position open
 *
 * Roll is delegated to a parent-supplied callback (re-uses
 * PMCCRollShortModal for PMCC short legs). Closed legs render read-only.
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronLeft, Check, X as XIcon, ArrowRightLeft, Pencil, LogOut } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Position, PositionLeg } from '../../lib/types';
import { useUpdateLeg, useCloseLeg } from '../../hooks/usePositionMutations';
import { formatDateWithYear, formatCurrency, CONTRACT_MULTIPLIER } from '../../lib/utils';
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
  /** Current per-share mark for this leg (mid or last). Used for unrealized P&L. */
  currentValue?: number;
  /** Optional override for the right-side P&L cell label. */
  pnlLabel?: string;
  /** When set, a Roll button appears in the action menu and calls this on click. */
  onRollClick?: () => void;
}

type Mode = 'collapsed' | 'menu' | 'edit' | 'close';

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

/**
 * Per-leg unrealized P&L (in dollars) for an open leg.
 */
export function legUnrealizedPnL(leg: PositionLeg, currentValue: number | undefined, qty: number): number | undefined {
  if (currentValue == null || !Number.isFinite(currentValue)) return undefined;
  if (leg.side === 'long') {
    if (leg.openedDebit == null) return undefined;
    return (currentValue - leg.openedDebit) * CONTRACT_MULTIPLIER * qty;
  }
  if (leg.openedCredit == null) return undefined;
  return (leg.openedCredit - currentValue) * CONTRACT_MULTIPLIER * qty;
}

export const LegPanel: React.FC<LegPanelProps> = ({
  position,
  legIndex,
  role,
  tone = 'dim',
  title,
  hint,
  currentValue,
  pnlLabel,
  onRollClick,
}) => {
  const leg = position.legs?.[legIndex];
  const [mode, setMode] = useState<Mode>('collapsed');
  const isShort = role === 'short' || role === 'active-short';
  const fillFieldLabel = isShort ? 'Open credit' : 'Entry debit';

  // Edit form state
  const [strike, setStrike] = useState(leg?.strike?.toString() ?? '');
  const [expiration, setExpiration] = useState(leg?.expiration ?? '');
  const initialFill = isShort
    ? (leg?.openedCredit?.toString() ?? '')
    : (leg?.openedDebit?.toString() ?? '');
  const [fillPrice, setFillPrice] = useState(initialFill);

  // Close form state
  const [closeFill, setCloseFill] = useState('');
  const [closeQty, setCloseQty] = useState((leg?.cycleQty ?? 1).toString());

  const [error, setError] = useState<string | null>(null);
  const updateLeg = useUpdateLeg();
  const closeLeg = useCloseLeg();

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

  const qty = leg.cycleQty ?? 1;
  const pnl = legUnrealizedPnL(leg, currentValue, qty);
  const isClosed = !!leg.closedAt;

  const fillDisplay = isShort
    ? (leg.openedCredit != null ? `$${leg.openedCredit.toFixed(2)}` : '—')
    : (leg.openedDebit != null ? `$${leg.openedDebit.toFixed(2)}` : '—');
  const fillColor = isShort ? 'text-phosphor-green text-glow-green' : 'text-text-primary';

  const resetEditForm = () => {
    setStrike(leg.strike?.toString() ?? '');
    setExpiration(leg.expiration ?? '');
    setFillPrice(isShort ? (leg.openedCredit?.toString() ?? '') : (leg.openedDebit?.toString() ?? ''));
    setError(null);
  };

  const resetCloseForm = () => {
    setCloseFill('');
    setCloseQty((leg.cycleQty ?? 1).toString());
    setError(null);
  };

  const collapse = () => {
    resetEditForm();
    resetCloseForm();
    setMode('collapsed');
  };

  const handleEditSave = async () => {
    setError(null);
    const strikeNum = parseFloat(strike);
    if (!Number.isFinite(strikeNum) || strikeNum <= 0) { setError('Strike must be a positive number'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) { setError('Expiration must be YYYY-MM-DD'); return; }
    const fillNum = fillPrice === '' ? undefined : parseFloat(fillPrice);
    if (fillPrice !== '' && (!Number.isFinite(fillNum) || (fillNum as number) < 0)) {
      setError(`${fillFieldLabel} must be ≥ 0`);
      return;
    }
    const patch: Partial<PositionLeg> = { strike: strikeNum, expiration };
    if (isShort) patch.openedCredit = fillNum;
    else patch.openedDebit = fillNum;
    try {
      await updateLeg.mutateAsync({ position, legIndex, patch });
      collapse();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCloseSave = async () => {
    setError(null);
    const fillNum = parseFloat(closeFill);
    const qtyNum = parseInt(closeQty, 10);
    if (!Number.isFinite(fillNum) || fillNum < 0) { setError('Close fill must be ≥ 0'); return; }
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) { setError('Quantity must be a positive integer'); return; }
    try {
      await closeLeg.mutateAsync({ position, legIndex, closeFill: fillNum, closeQty: qtyNum });
      collapse();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Estimated realized for the close form preview
  const closePreview = (() => {
    const fillNum = parseFloat(closeFill);
    const qtyNum = parseInt(closeQty, 10) || qty;
    if (!Number.isFinite(fillNum)) return null;
    if (isShort) {
      if (leg.openedCredit == null) return null;
      return (leg.openedCredit - fillNum) * CONTRACT_MULTIPLIER * qtyNum;
    }
    if (leg.openedDebit == null) return null;
    return (fillNum - leg.openedDebit) * CONTRACT_MULTIPLIER * qtyNum;
  })();

  // ─── Closed leg: read-only summary ───────────────────────────────────────
  if (isClosed) {
    return (
      <div className={`terminal-panel p-3 ${TONE_CLASS[tone]} opacity-70`}>
        <div className="flex items-center justify-between mb-2">
          <div className={`text-[11px] font-mono uppercase tracking-widest ${TITLE_CLASS[tone]} flex items-center gap-1.5`}>
            ▌ {title} · CLOSED
          </div>
          <div className="text-[11px] font-mono text-text-tertiary">
            {leg.closedAt?.slice(0, 10)}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs font-mono">
          <SummaryCell label="Strike" value={`$${leg.strike}`} />
          <SummaryCell label="Expiration" value={formatDateWithYear(leg.expiration)} />
          <SummaryCell label="Open" value={fillDisplay} />
          <SummaryCell label="Close" value={leg.closedCost != null ? `$${leg.closedCost.toFixed(2)}` : '—'} />
          <SummaryCell label="Realized" value={(() => {
            if (leg.openedCredit != null && leg.closedCost != null && isShort) {
              const r = (leg.openedCredit - leg.closedCost) * CONTRACT_MULTIPLIER * qty;
              return `${r >= 0 ? '+' : ''}${formatCurrency(r)}`;
            }
            if (leg.openedDebit != null && leg.closedCost != null && !isShort) {
              const r = (leg.closedCost - leg.openedDebit) * CONTRACT_MULTIPLIER * qty;
              return `${r >= 0 ? '+' : ''}${formatCurrency(r)}`;
            }
            return '—';
          })()} />
        </div>
      </div>
    );
  }

  // ─── Open leg ────────────────────────────────────────────────────────────
  const expanded = mode !== 'collapsed';

  return (
    <div className={`terminal-panel p-3 ${TONE_CLASS[tone]} transition-colors ${expanded ? 'ring-1 ring-phosphor-green/30' : ''}`}>
      {/* Summary (always rendered; clickable when collapsed) */}
      {mode === 'collapsed' && (
        <button
          type="button"
          onClick={() => setMode('menu')}
          className="w-full text-left group cursor-pointer"
          aria-label={`Manage ${title}`}
        >
          <SummaryHeader title={title} hint={hint} tone={tone}>
            <ChevronDown
              size={14}
              className="text-text-tertiary group-hover:text-phosphor-dim transition-colors"
              aria-hidden="true"
            />
          </SummaryHeader>
          <SummaryRow leg={leg} dte={dte} dteClass={dteClass} fillFieldLabel={fillFieldLabel} fillDisplay={fillDisplay} fillColor={fillColor} pnl={pnl} pnlLabel={pnlLabel} />
        </button>
      )}

      {/* Expanded views */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key={`expanded-${mode}`}
            initial={{ opacity: 0, y: -6, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -6, height: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            {/* Expanded header — different label per mode, always shows close-X */}
            <div className="flex items-center justify-between pb-2 mb-3 border-b border-phosphor-green/15">
              <div className={`text-[11px] font-mono uppercase tracking-widest ${TITLE_CLASS[tone]} flex items-center gap-1.5`}>
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-phosphor-green animate-pulse" aria-hidden="true" />
                ▌ {title} · {mode === 'menu' ? 'MANAGE' : mode === 'edit' ? 'EDIT' : 'CLOSE LEG'}
              </div>
              <div className="flex items-center gap-2">
                {hint && (
                  <div className="text-[11px] font-mono text-text-tertiary truncate hidden sm:block">{hint}</div>
                )}
                <button
                  type="button"
                  onClick={collapse}
                  className="text-text-tertiary hover:text-phosphor-red transition-colors"
                  aria-label="Close panel"
                >
                  <XIcon size={14} />
                </button>
              </div>
            </div>

            {/* Persistent summary (read-only) inside expanded views — anchors context */}
            <div className="mb-3 px-3 py-2 rounded bg-terminal-black/40 border border-border-default/40">
              <SummaryRow leg={leg} dte={dte} dteClass={dteClass} fillFieldLabel={fillFieldLabel} fillDisplay={fillDisplay} fillColor={fillColor} pnl={pnl} pnlLabel={pnlLabel} compact />
            </div>

            {/* MODE: menu — action chooser */}
            {mode === 'menu' && (
              <ActionMenu
                onEdit={() => { setError(null); setMode('edit'); }}
                onClose={() => { setError(null); setMode('close'); }}
                onRoll={onRollClick ? () => { onRollClick(); collapse(); } : undefined}
                isShort={isShort}
              />
            )}

            {/* MODE: edit — metadata form */}
            {mode === 'edit' && (
              <FormShell
                onSubmit={handleEditSave}
                onBack={() => setMode('menu')}
                submitting={updateLeg.isPending}
                submitLabel={updateLeg.isPending ? 'Saving…' : 'Save edits'}
                error={error}
              >
                <FormGrid>
                  <FormField label="Strike" delay={0.04}>
                    <input
                      type="number" step="0.5" value={strike}
                      onChange={e => setStrike(e.target.value)}
                      className="leg-edit-input" autoFocus
                    />
                  </FormField>
                  <FormField label="Expiration" delay={0.08}>
                    <input
                      type="date" value={expiration}
                      onChange={e => setExpiration(e.target.value)}
                      className="leg-edit-input"
                    />
                  </FormField>
                  <FormField label={fillFieldLabel} delay={0.12}>
                    <input
                      type="number" step="0.01" min="0" value={fillPrice}
                      onChange={e => setFillPrice(e.target.value)}
                      className="leg-edit-input" placeholder="per share"
                    />
                  </FormField>
                </FormGrid>
              </FormShell>
            )}

            {/* MODE: close — record close fill, mark leg closed */}
            {mode === 'close' && (
              <FormShell
                onSubmit={handleCloseSave}
                onBack={() => setMode('menu')}
                submitting={closeLeg.isPending}
                submitLabel={closeLeg.isPending ? 'Closing…' : 'Confirm close'}
                error={error}
              >
                <p className="text-[11px] font-mono text-text-secondary mb-3 leading-relaxed">
                  {isShort
                    ? `Buy back this short leg. Enter the debit you paid per share.`
                    : `Sell this long leg. Enter the credit you received per share.`}
                </p>
                <FormGrid>
                  <FormField label={isShort ? 'Close debit (per share)' : 'Close credit (per share)'} delay={0.04}>
                    <input
                      type="number" step="0.01" min="0" value={closeFill}
                      onChange={e => setCloseFill(e.target.value)}
                      className="leg-edit-input" placeholder="per share" autoFocus
                    />
                  </FormField>
                  <FormField label="Quantity" delay={0.08}>
                    <input
                      type="number" min="1" value={closeQty}
                      onChange={e => setCloseQty(e.target.value)}
                      className="leg-edit-input"
                    />
                  </FormField>
                </FormGrid>
                {closePreview != null && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                    className="mt-3 px-3 py-2 rounded border border-phosphor-green/20 bg-phosphor-green/5 text-xs font-mono"
                  >
                    <span className="text-text-tertiary">Realized this cycle: </span>
                    <span className={`font-bold ${closePreview >= 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'}`}>
                      {closePreview >= 0 ? '+' : ''}{formatCurrency(closePreview)}
                    </span>
                  </motion.div>
                )}
              </FormShell>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// ─── Sub-components ────────────────────────────────────────────────────────

const SummaryHeader: React.FC<{ title: string; hint?: string; tone: NonNullable<LegPanelProps['tone']>; children?: React.ReactNode }> = ({ title, hint, tone, children }) => (
  <div className="flex items-center justify-between mb-2">
    <div className={`text-[11px] font-mono uppercase tracking-widest ${TITLE_CLASS[tone]}`}>
      ▌ {title}
    </div>
    <div className="flex items-center gap-2">
      {hint && <div className="text-[11px] font-mono text-text-tertiary truncate hidden sm:block">{hint}</div>}
      {children}
    </div>
  </div>
);

const SummaryCell: React.FC<{ label: string; value: React.ReactNode; valueClass?: string }> = ({ label, value, valueClass }) => (
  <div>
    <div className="text-text-tertiary uppercase tracking-wider mb-0.5">{label}</div>
    <div className={valueClass ?? 'text-text-primary'}>{value}</div>
  </div>
);

const SummaryRow: React.FC<{
  leg: PositionLeg;
  dte: number | null;
  dteClass: string;
  fillFieldLabel: string;
  fillDisplay: string;
  fillColor: string;
  pnl: number | undefined;
  pnlLabel?: string;
  compact?: boolean;
}> = ({ leg, dte, dteClass, fillFieldLabel, fillDisplay, fillColor, pnl, pnlLabel, compact }) => (
  <div className={`grid grid-cols-2 sm:grid-cols-5 gap-3 ${compact ? 'text-[11px]' : 'text-xs'} font-mono`}>
    <SummaryCell label="Strike" value={<span className={compact ? '' : 'text-base'}>${leg.strike}</span>} />
    <SummaryCell label="Expiration" value={formatDateWithYear(leg.expiration)} />
    <SummaryCell label="DTE" value={dte != null ? `${dte}d` : '—'} valueClass={`${compact ? '' : 'text-base'} font-bold ${dteClass}`} />
    <SummaryCell label={fillFieldLabel} value={fillDisplay} valueClass={fillColor} />
    <SummaryCell
      label={pnlLabel ?? 'Unrealized'}
      value={pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${formatCurrency(pnl)}`}
      valueClass={`font-bold ${pnl == null ? 'text-text-tertiary' : pnl > 0 ? 'text-phosphor-green text-glow-green' : pnl < 0 ? 'text-phosphor-red text-glow-red' : 'text-text-tertiary'}`}
    />
  </div>
);

const ActionMenu: React.FC<{
  onEdit: () => void;
  onClose: () => void;
  onRoll?: () => void;
  isShort: boolean;
}> = ({ onEdit, onClose, onRoll, isShort }) => (
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
    {onRoll && (
      <ActionButton
        onClick={onRoll}
        icon={<ArrowRightLeft size={14} />}
        label="Roll this leg"
        sublabel={isShort ? 'Close + open at new strike / expiry' : 'Roll out + restrike the long leg'}
        delay={0.04}
        accent="warn"
      />
    )}
    <ActionButton
      onClick={onClose}
      icon={<LogOut size={14} />}
      label="Close this leg"
      sublabel={isShort ? 'Buy back at debit' : 'Sell at credit'}
      delay={onRoll ? 0.08 : 0.04}
      accent="danger"
    />
    <ActionButton
      onClick={onEdit}
      icon={<Pencil size={14} />}
      label="Edit metadata"
      sublabel="Fix strike, expiry, or fill"
      delay={onRoll ? 0.12 : 0.08}
      accent="default"
    />
  </div>
);

const ActionButton: React.FC<{
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  delay: number;
  accent: 'default' | 'warn' | 'danger';
}> = ({ onClick, icon, label, sublabel, delay, accent }) => {
  const accentClass = accent === 'warn'
    ? 'border-phosphor-amber/40 hover:border-phosphor-amber/70 text-phosphor-amber hover:text-glow-amber'
    : accent === 'danger'
    ? 'border-phosphor-red/30 hover:border-phosphor-red/60 text-phosphor-red'
    : 'border-phosphor-green/30 hover:border-phosphor-green/60 text-phosphor-green hover:text-glow-green';
  return (
    <motion.button
      type="button"
      onClick={onClick}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay, ease: 'easeOut' }}
      className={`group p-3 rounded-md text-left border bg-terminal-black/30 transition-colors cursor-pointer ${accentClass}`}
    >
      <div className="flex items-center gap-2 mb-0.5 text-[11px] font-mono uppercase tracking-wider">
        {icon}
        <span className="font-bold">{label}</span>
      </div>
      <div className="text-[10px] font-mono text-text-tertiary">{sublabel}</div>
    </motion.button>
  );
};

const FormGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">{children}</div>
);

const FormField: React.FC<{ label: string; delay: number; children: React.ReactNode }> = ({ label, delay, children }) => (
  <motion.div
    initial={{ opacity: 0, y: 4 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.18, delay, ease: 'easeOut' }}
  >
    <label className="label-mono mb-1.5 block">{label}</label>
    {children}
  </motion.div>
);

const FormShell: React.FC<{
  onSubmit: () => void;
  onBack: () => void;
  submitting: boolean;
  submitLabel: string;
  error: string | null;
  children: React.ReactNode;
}> = ({ onSubmit, onBack, submitting, submitLabel, error, children }) => (
  <div>
    {children}
    {error && (
      <motion.div
        initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
        className="mt-3 px-2.5 py-1.5 rounded border border-phosphor-red/30 bg-phosphor-red/5 text-[11px] font-mono text-phosphor-red text-glow-red"
      >
        ▌ {error}
      </motion.div>
    )}
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: 0.18, ease: 'easeOut' }}
      className="flex gap-2 mt-4 pt-3 border-t border-border-default/40"
    >
      <button
        type="button" onClick={onSubmit} disabled={submitting}
        className="btn-terminal flex items-center justify-center gap-1.5 px-4 h-9 text-xs flex-1 sm:flex-none sm:min-w-[140px]"
      >
        <Check size={13} /> {submitLabel}
      </button>
      <button
        type="button" onClick={onBack} disabled={submitting}
        className="btn-terminal flex items-center justify-center gap-1.5 px-3 h-9 text-xs"
      >
        <ChevronLeft size={13} /> Back
      </button>
    </motion.div>
  </div>
);
