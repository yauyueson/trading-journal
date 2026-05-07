/**
 * AddLegModal — append a new leg to a position. Used to convert a naked option
 * into a spread, or to add a third leg to an existing 2-leg structure.
 *
 * For naked → spread conversion the original leg is inferred as long (the
 * common case). Users who held a naked short can edit the inferred leg's
 * side via the existing LegPanel edit affordance afterward.
 */
import React, { useState } from 'react';
import { X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAddLeg } from '../hooks/usePositionMutations';
import type { Position, PositionLeg } from '../lib/types';

interface Props {
  position: Position;
  isOpen: boolean;
  onClose: () => void;
}

export const AddLegModal: React.FC<Props> = ({ position, isOpen, onClose }) => {
  const addLeg = useAddLeg();

  const [side, setSide] = useState<'long' | 'short'>('short');
  const [optType, setOptType] = useState<'Call' | 'Put'>('Call');
  const [strike, setStrike] = useState('');
  const [expiration, setExpiration] = useState(position.expiration ?? '');
  const [fillPrice, setFillPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const strikeNum = parseFloat(strike);
  const fillNum = parseFloat(fillPrice);
  const qtyNum = parseInt(qty, 10);
  const valid = Number.isFinite(strikeNum) && strikeNum > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(expiration)
    && Number.isFinite(fillNum) && fillNum > 0
    && Number.isInteger(qtyNum) && qtyNum > 0;

  const fillLabel = side === 'short' ? 'Credit received (per share)' : 'Debit paid (per share)';

  const handleConfirm = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const newLeg: PositionLeg = {
        strike: strikeNum,
        type: optType,
        side,
        expiration,
        ...(side === 'short' ? { openedCredit: fillNum } : { openedDebit: fillNum }),
        cycleQty: qtyNum,
      };
      await addLeg.mutateAsync({ position, newLeg, fillPrice: fillNum, qty: qtyNum });
      onClose();
      setStrike('');
      setFillPrice('');
      setQty('1');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const willConvertNaked = (position.legs ?? []).length === 0;

  return (
    <div className="fixed inset-0 modal-overlay flex items-center justify-center p-4 z-[100]" role="dialog" aria-modal="true" aria-label="Add leg to position">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="terminal-panel p-6 w-full max-w-xl fade-in max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">▌ ADD_LEG</h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-phosphor-red" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {willConvertNaked && (
          <p className="text-[11px] font-mono text-phosphor-amber text-glow-amber mb-3 leading-relaxed">
            ▌ This will convert the naked option into a multi-leg position. The existing {position.type} K=${position.strike} is treated as the long leg; you can flip its side via the leg edit form afterwards.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="label-mono mb-1 block">Side</label>
            <div className="flex gap-2">
              {(['long', 'short'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className={`flex-1 px-3 py-2 rounded-md text-xs font-mono uppercase tracking-wider border transition-colors ${
                    side === s
                      ? 'bg-phosphor-green/15 text-phosphor-green text-glow-green border-phosphor-green/45'
                      : 'bg-terminal-panel text-text-tertiary border-border-default/50 hover:text-phosphor-dim'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label-mono mb-1 block">Type</label>
            <div className="flex gap-2">
              {(['Call', 'Put'] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setOptType(t)}
                  className={`flex-1 px-3 py-2 rounded-md text-xs font-mono uppercase tracking-wider border transition-colors ${
                    optType === t
                      ? 'bg-phosphor-green/15 text-phosphor-green text-glow-green border-phosphor-green/45'
                      : 'bg-terminal-panel text-text-tertiary border-border-default/50 hover:text-phosphor-dim'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="label-mono mb-1 block">Strike</label>
            <input
              type="number"
              step="0.5"
              value={strike}
              onChange={e => setStrike(e.target.value)}
              className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
              placeholder="K"
            />
          </div>
          <div>
            <label className="label-mono mb-1 block">Expiration</label>
            <input
              type="date"
              value={expiration}
              onChange={e => setExpiration(e.target.value)}
              className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white text-xs"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="label-mono mb-1 block">Quantity</label>
            <input
              type="number"
              min="1"
              value={qty}
              onChange={e => setQty(e.target.value)}
              className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
            />
          </div>
          <div>
            <label className="label-mono mb-1 block">{fillLabel}</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={fillPrice}
              onChange={e => setFillPrice(e.target.value)}
              className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
              placeholder="per share"
            />
          </div>
        </div>

        {error && (
          <div className="mb-3 text-[11px] font-mono text-phosphor-red text-glow-red">▌ {error}</div>
        )}

        <div className="flex gap-3">
          <button onClick={onClose} className="btn-terminal-danger flex-1" disabled={submitting}>CANCEL</button>
          <button
            onClick={handleConfirm}
            disabled={!valid || submitting}
            className="btn-terminal flex-1"
          >
            {submitting ? '▌ ADDING…' : '▌ ADD LEG'}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
