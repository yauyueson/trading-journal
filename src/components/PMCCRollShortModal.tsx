/**
 * PMCCRollShortModal — focused roll workflow for the PMCC short leg.
 *
 * Closes the current active short and opens a new one in a single atomic
 * mutation. Long LEAP is untouched. Records both legs of the cycle on the
 * position and inserts paired transactions for audit.
 */
import React, { useState } from 'react';
import { X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useRollPMCCShort } from '../hooks/usePositionMutations';
import { splitPMCCLegs } from '../lib/pmccCycles';
import { formatDate } from '../lib/utils';
import type { Position } from '../lib/types';

interface Props {
  position: Position;
  isOpen: boolean;
  onClose: () => void;
}

export const PMCCRollShortModal: React.FC<Props> = ({ position, isOpen, onClose }) => {
  const rollShort = useRollPMCCShort();
  const { activeShort } = splitPMCCLegs(position);

  const [closeCost, setCloseCost] = useState('');
  const [newStrike, setNewStrike] = useState('');
  const [newExpiration, setNewExpiration] = useState('');
  const [newCredit, setNewCredit] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  if (!activeShort) {
    return (
      <div className="fixed inset-0 modal-overlay flex items-center justify-center p-4 z-[100]" role="dialog" aria-modal="true">
        <div className="terminal-panel p-6 w-full max-w-md">
          <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-amber mb-3">▌ NO_ACTIVE_SHORT</h3>
          <p className="text-sm text-text-secondary font-mono mb-4">This PMCC has no active short leg to roll. Use Manage to add a new short manually.</p>
          <button onClick={onClose} className="btn-terminal w-full">Close</button>
        </div>
      </div>
    );
  }

  const closeCostNum = parseFloat(closeCost);
  const newCreditNum = parseFloat(newCredit);
  const newStrikeNum = parseFloat(newStrike);
  const valid = Number.isFinite(closeCostNum) && closeCostNum >= 0
    && Number.isFinite(newCreditNum) && newCreditNum > 0
    && Number.isFinite(newStrikeNum) && newStrikeNum > 0
    && newExpiration.length === 10;

  const cycleRealizedPerContract = activeShort.openedCredit != null && Number.isFinite(closeCostNum)
    ? (activeShort.openedCredit - closeCostNum) * 100
    : null;
  const netCredit = Number.isFinite(closeCostNum) && Number.isFinite(newCreditNum)
    ? newCreditNum - closeCostNum
    : null;

  const handleConfirm = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      await rollShort.mutateAsync({
        position,
        closeCost: closeCostNum,
        newStrike: newStrikeNum,
        newExpiration,
        newCredit: newCreditNum,
        cycleQty: activeShort.cycleQty,
      });
      onClose();
      setCloseCost('');
      setNewStrike('');
      setNewExpiration('');
      setNewCredit('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 modal-overlay flex items-center justify-center p-4 z-[100]" role="dialog" aria-modal="true" aria-label="Roll PMCC short leg">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="terminal-panel p-6 w-full max-w-2xl fade-in max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">▌ ROLL_PMCC_SHORT</h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-phosphor-red" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <p className="text-xs font-mono text-text-secondary mb-4 leading-relaxed">
          Long LEAP stays in place. Closes the current short call and opens a new one. Cycle realized P&L is recorded against the position.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Close Existing Short */}
          <div className="terminal-panel terminal-panel-red p-4">
            <h4 className="text-xs font-mono font-bold text-phosphor-red text-glow-red mb-2 uppercase tracking-widest">▌ CLOSE_CURRENT_SHORT</h4>
            <div className="text-xs font-mono text-text-secondary mb-3 tabular-nums">
              K={activeShort.strike} {activeShort.type} · {formatDate(activeShort.expiration)}
              {activeShort.openedCredit != null && (
                <span className="ml-2 text-phosphor-green">credit ${activeShort.openedCredit.toFixed(2)}</span>
              )}
            </div>
            <label className="label-mono mb-1 block">CLOSE COST (per share, debit)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={closeCost}
              onChange={e => setCloseCost(e.target.value)}
              className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
              placeholder="e.g. 1.20"
            />
            {cycleRealizedPerContract != null && (
              <div className="mt-2 text-[11px] font-mono text-text-tertiary">
                Cycle realized: <span className={cycleRealizedPerContract >= 0 ? 'text-phosphor-green' : 'text-phosphor-red'}>
                  {cycleRealizedPerContract >= 0 ? '+' : ''}${cycleRealizedPerContract.toFixed(2)}/contract
                </span>
              </div>
            )}
          </div>

          {/* Open New Short */}
          <div className="terminal-panel border-phosphor-green/45 p-4">
            <h4 className="text-xs font-mono font-bold text-phosphor-green text-glow-green mb-2 uppercase tracking-widest">▌ OPEN_NEW_SHORT</h4>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className="label-mono mb-1 block">EXPIRATION</label>
                <input
                  type="date"
                  value={newExpiration}
                  onChange={e => setNewExpiration(e.target.value)}
                  className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white text-xs"
                />
              </div>
              <div>
                <label className="label-mono mb-1 block">STRIKE</label>
                <input
                  type="number"
                  step="0.5"
                  value={newStrike}
                  onChange={e => setNewStrike(e.target.value)}
                  className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white text-xs"
                  placeholder="K"
                />
              </div>
            </div>
            <label className="label-mono mb-1 block">CREDIT (per share)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={newCredit}
              onChange={e => setNewCredit(e.target.value)}
              className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
              placeholder="e.g. 4.20"
            />
          </div>
        </div>

        {netCredit != null && (
          <div className="mt-4 terminal-panel p-3 text-center text-xs font-mono uppercase tracking-wider">
            <span className="text-text-tertiary">▌ NET CREDIT THIS ROLL: </span>
            <span className={`font-mono font-bold ${netCredit >= 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'}`}>
              {netCredit >= 0 ? '+' : ''}${netCredit.toFixed(2)}/share ({netCredit >= 0 ? '+' : ''}${(netCredit * 100).toFixed(0)}/contract)
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
            {submitting ? '▌ ROLLING...' : '▌ CONFIRM ROLL'}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
