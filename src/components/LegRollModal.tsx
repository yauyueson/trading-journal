/**
 * LegRollModal — generic per-leg roll: close current leg + open new leg
 * (same side, same option type) in one mutation. Works for any leg —
 * short tenants (PMCC short), long anchors (LEAPs), debit/credit spread
 * legs, or naked options.
 */
import React, { useMemo, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useRollLeg } from '../hooks/usePositionMutations';
import { useChainCandidates } from '../hooks/useChainCandidates';
import { STRATEGY_PROFILES } from '../lib/strategyProfiles';
import { formatDate, formatDateWithYear, CONTRACT_MULTIPLIER } from '../lib/utils';
import {
  buildPMCCRollShortCandidates,
  type ChainOption,
} from '../lib/chainCandidates';
import type { Position } from '../lib/types';

interface Props {
  position: Position;
  legIndex: number;
  isOpen: boolean;
  onClose: () => void;
}

export const LegRollModal: React.FC<Props> = ({ position, legIndex, isOpen, onClose }) => {
  const rollLeg = useRollLeg();
  const profile = STRATEGY_PROFILES.pmcc;
  const leg = position.legs?.[legIndex];
  const longLeg = position.legs?.find(l => l.side === 'long');
  const isPMCCShortRoll = position.strategy_type === 'pmcc' && leg?.side === 'short' && leg.type === 'Call';

  const [closeFill, setCloseFill] = useState('');
  const [newStrike, setNewStrike] = useState('');
  const [newExpiration, setNewExpiration] = useState('');
  const [newFill, setNewFill] = useState('');
  const [pickedCandidate, setPickedCandidate] = useState<ChainOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shortQuery = useChainCandidates(isOpen && isPMCCShortRoll && position.ticker ? {
    ticker: position.ticker,
    direction: 'call',
    strategy: 'long',
    dteMin: profile.shortDteMin ?? 30,
    dteMax: profile.shortDteMax ?? 45,
    minDelta: profile.shortDeltaMin ?? 0.20,
    maxDelta: profile.shortDeltaMax ?? 0.30,
    strikeRange: 0.25,
    minVolume: 0,
  } : null);

  const rollCandidates = useMemo(() => {
    if (!isPMCCShortRoll || !leg) return [];
    return buildPMCCRollShortCandidates(shortQuery.data ?? [], {
      leapStrike: longLeg?.strike ?? 0,
      currentShortStrike: leg.strike,
      targetDelta: 0.25,
    }).slice(0, 5);
  }, [isPMCCShortRoll, leg, longLeg, shortQuery.data]);

  const applyCandidate = (opt: ChainOption) => {
    setNewExpiration(opt.expiration);
    setNewStrike(String(opt.strike));
    setNewFill(opt.price.toFixed(2));
    setPickedCandidate(opt);
  };

  if (!isOpen) return null;

  if (!leg || leg.closedAt) {
    return (
      <div className="fixed inset-0 modal-overlay flex items-center justify-center p-4 z-[100]" role="dialog" aria-modal="true">
        <div className="terminal-panel p-6 w-full max-w-md">
          <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-amber mb-3">▌ LEG_NOT_AVAILABLE</h3>
          <p className="text-sm text-text-secondary font-mono mb-4">This leg is not available to roll (missing or already closed).</p>
          <button onClick={onClose} className="btn-terminal w-full">Close</button>
        </div>
      </div>
    );
  }

  const isShort = leg.side === 'short';
  const closeFieldLabel = isShort ? 'Close debit (per share)' : 'Close credit (per share)';
  const openFieldLabel = isShort ? 'New credit (per share)' : 'New debit (per share)';
  const heading = isShort ? '▌ ROLL_SHORT' : '▌ ROLL_LONG';

  const closeFillNum = parseFloat(closeFill);
  const newFillNum = parseFloat(newFill);
  const newStrikeNum = parseFloat(newStrike);
  const valid = Number.isFinite(closeFillNum) && closeFillNum >= 0
    && Number.isFinite(newFillNum) && newFillNum > 0
    && Number.isFinite(newStrikeNum) && newStrikeNum > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(newExpiration);

  // Cycle realized preview
  const cyclePnL = (() => {
    if (!Number.isFinite(closeFillNum)) return null;
    const qty = leg.cycleQty ?? 1;
    if (isShort) {
      if (leg.openedCredit == null) return null;
      return (leg.openedCredit - closeFillNum) * CONTRACT_MULTIPLIER * qty;
    }
    if (leg.openedDebit == null) return null;
    return (closeFillNum - leg.openedDebit) * CONTRACT_MULTIPLIER * qty;
  })();

  const netCash = Number.isFinite(closeFillNum) && Number.isFinite(newFillNum)
    ? (isShort ? newFillNum - closeFillNum : closeFillNum - newFillNum)
    : null;

  const handleConfirm = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      await rollLeg.mutateAsync({
        position,
        legIndex,
        closeFill: closeFillNum,
        newStrike: newStrikeNum,
        newExpiration,
        newFill: newFillNum,
        cycleQty: leg.cycleQty,
      });
      onClose();
      setCloseFill('');
      setNewStrike('');
      setNewExpiration('');
      setNewFill('');
      setPickedCandidate(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 modal-overlay flex items-center justify-center p-4 z-[100]" role="dialog" aria-modal="true" aria-label={`Roll ${leg.side} leg`}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="terminal-panel p-6 w-full max-w-2xl fade-in max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">{heading}</h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-phosphor-red" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <p className="text-xs font-mono text-text-secondary mb-4 leading-relaxed">
          Closes the current {leg.side} leg and opens a new {leg.side} {leg.type.toLowerCase()} in its place. Other legs on this position are untouched. Cycle realized P&L is recorded.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Close existing */}
          <div className="terminal-panel terminal-panel-red p-4">
            <h4 className="text-xs font-mono font-bold text-phosphor-red text-glow-red mb-2 uppercase tracking-widest">▌ CLOSE_CURRENT</h4>
            <div className="text-xs font-mono text-text-secondary mb-3 tabular-nums">
              {leg.side} K={leg.strike} {leg.type} · {formatDateWithYear(leg.expiration)}
              {isShort && leg.openedCredit != null && (
                <span className="ml-2 text-phosphor-green">credit ${leg.openedCredit.toFixed(2)}</span>
              )}
              {!isShort && leg.openedDebit != null && (
                <span className="ml-2 text-text-primary">debit ${leg.openedDebit.toFixed(2)}</span>
              )}
            </div>
            <label className="label-mono mb-1 block">{closeFieldLabel}</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={closeFill}
              onChange={e => setCloseFill(e.target.value)}
              className="leg-edit-input"
              placeholder="per share"
              autoFocus
            />
            {cyclePnL != null && (
              <div className="mt-2 text-[11px] font-mono text-text-tertiary">
                Cycle realized: <span className={cyclePnL >= 0 ? 'text-phosphor-green' : 'text-phosphor-red'}>
                  {cyclePnL >= 0 ? '+' : ''}${cyclePnL.toFixed(2)}
                </span>
              </div>
            )}
          </div>

          {/* Open new */}
          <div className="terminal-panel border-phosphor-green/45 p-4">
            <h4 className="text-xs font-mono font-bold text-phosphor-green text-glow-green mb-2 uppercase tracking-widest">▌ OPEN_NEW</h4>
            {isPMCCShortRoll && (
              <>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] text-text-tertiary font-mono uppercase tracking-wider">
                    δ {profile.shortDeltaMin?.toFixed(2)}-{profile.shortDeltaMax?.toFixed(2)} · {profile.shortDteMin}-{profile.shortDteMax}d
                  </p>
                  {shortQuery.isFetching && (
                    <span className="text-[10px] text-phosphor-dim font-mono uppercase tracking-wider">Loading...</span>
                  )}
                </div>
                {rollCandidates.length > 0 && (
                  <div className="space-y-1 mb-3">
                    <div className="flex items-center gap-1 text-[10px] text-text-tertiary font-mono uppercase tracking-wider">
                      <Sparkles size={10} className="text-phosphor-green" /> suggested roll shorts (K &gt; ${leg.strike})
                    </div>
                    {rollCandidates.map(opt => {
                      const isPicked = pickedCandidate?.strike === opt.strike && pickedCandidate?.expiration === opt.expiration;
                      return (
                        <button
                          key={`${opt.expiration}-${opt.strike}`}
                          type="button"
                          onClick={() => applyCandidate(opt)}
                          className={`w-full text-left rounded-md px-2 py-1.5 text-[11px] font-mono transition-colors cursor-pointer ${isPicked ? 'bg-phosphor-green/10 border border-phosphor-green/45 text-glow-green' : 'bg-terminal-panel border border-border-default/50 hover:border-phosphor-green/30'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-text-primary tabular-nums">
                              ${opt.strike} · {formatDate(opt.expiration)} ({opt.dte}d)
                            </span>
                            <span className="font-mono text-phosphor-green tabular-nums">δ{Math.abs(opt.greeks.delta).toFixed(2)} · ${opt.price.toFixed(2)}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {shortQuery.isError && (
                  <p className="text-[10px] text-phosphor-amber font-mono mb-2">Couldn't load roll candidates — enter manually.</p>
                )}
                {!shortQuery.isFetching && !shortQuery.isError && rollCandidates.length === 0 && (
                  <p className="text-[10px] text-text-tertiary font-mono mb-2">No strategy-band roll candidates found — enter manually.</p>
                )}
              </>
            )}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className="label-mono mb-1 block">Expiration</label>
                <input
                  type="date"
                  value={newExpiration}
                  onChange={e => {
                    setNewExpiration(e.target.value);
                    setPickedCandidate(null);
                  }}
                  className="leg-edit-input"
                />
              </div>
              <div>
                <label className="label-mono mb-1 block">Strike</label>
                <input
                  type="number"
                  step="0.5"
                  value={newStrike}
                  onChange={e => {
                    setNewStrike(e.target.value);
                    setPickedCandidate(null);
                  }}
                  className="leg-edit-input"
                  placeholder="K"
                />
              </div>
            </div>
            <label className="label-mono mb-1 block">{openFieldLabel}</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={newFill}
              onChange={e => {
                setNewFill(e.target.value);
                setPickedCandidate(null);
              }}
              className="leg-edit-input"
              placeholder="per share"
            />
          </div>
        </div>

        {netCash != null && (
          <div className="mt-4 terminal-panel p-3 text-center text-xs font-mono uppercase tracking-wider">
            <span className="text-text-tertiary">▌ NET CASH ({isShort ? 'credit-credit' : 'sale-buy'}): </span>
            <span className={`font-mono font-bold ${netCash >= 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'}`}>
              {netCash >= 0 ? '+' : ''}${netCash.toFixed(2)}/share ({netCash >= 0 ? '+' : ''}${(netCash * 100).toFixed(0)}/contract)
            </span>
          </div>
        )}

        {error && (
          <div className="mt-3 text-xs font-mono text-phosphor-red text-glow-red">▌ {error}</div>
        )}

        <div className="flex gap-3 mt-5">
          <button onClick={onClose} className="btn-terminal-danger flex-1" disabled={submitting}>CANCEL</button>
          <button
            onClick={handleConfirm}
            disabled={!valid || submitting}
            className="btn-terminal flex-1"
          >
            {submitting ? '▌ ROLLING…' : '▌ CONFIRM ROLL'}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
