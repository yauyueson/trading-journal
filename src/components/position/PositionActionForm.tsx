import React, { useState } from 'react';
import { RefreshCw, Trash2, ArrowRightLeft, Plus } from 'lucide-react';
import type { Position, PositionAction } from '../../lib/types';

interface PositionActionFormProps {
  positionId: string;
  totalQty: number;
  loading: boolean;
  onAction: (id: string, action: PositionAction, exitType?: Position['exit_type']) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRefresh: () => void;
  onRollClick?: (qty: number) => void;
  onAddLegClick?: () => void;
}

export const PositionActionForm: React.FC<PositionActionFormProps> = ({
  positionId,
  totalQty,
  loading,
  onAction,
  onDelete,
  onRefresh,
  onRollClick,
  onAddLegClick,
}) => {
  const [actionMode, setActionMode] = useState<'Add' | 'TakeProfit' | 'Close' | null>(null);
  const [actionQty, setActionQty] = useState(1);
  const [actionPrice, setActionPrice] = useState('');
  const [closeExitType, setCloseExitType] = useState<Position['exit_type']>('MANUAL');
  const [submitting, setSubmitting] = useState(false);

  const handleAction = async (type: 'Size Up' | 'Take Profit' | 'Close', exitTypeOverride?: Position['exit_type']) => {
    if (!actionPrice) return;
    setSubmitting(true);
    const qty = ['Size Down', 'Take Profit', 'Close'].includes(type) ? -Math.abs(actionQty) : Math.abs(actionQty);
    await onAction(positionId, {
      type,
      quantity: type === 'Close' ? -totalQty : qty,
      price: parseFloat(actionPrice)
    }, exitTypeOverride);
    setSubmitting(false);
    setActionMode(null);
    setActionPrice('');
    setActionQty(1);
    setCloseExitType('MANUAL');
  };

  if (!actionMode) {
    return (
      <div className="flex flex-wrap gap-2">
        <button onClick={onRefresh} disabled={loading} className="btn-terminal flex items-center justify-center gap-1.5 px-2.5 sm:px-3" aria-label="Refresh price">
          {loading ? <div className="spinner w-4 h-4" /> : <RefreshCw size={14} />}
          <span className="hidden sm:inline">Refresh</span>
        </button>
        <button onClick={() => setActionMode('Add')} className="btn-terminal">+ Add</button>
        {onAddLegClick && (
          <button onClick={onAddLegClick} className="btn-terminal flex items-center gap-1" title="Append a new leg to this position">
            <Plus size={14} /> Add Leg
          </button>
        )}
        <button onClick={() => setActionMode('TakeProfit')} className="btn-terminal">Profit</button>
        {onRollClick && (
          <button onClick={() => onRollClick(totalQty)} className="btn-terminal-warn flex items-center gap-1">
            <ArrowRightLeft size={14} /> Roll
          </button>
        )}
        <button onClick={() => setActionMode('Close')} className="btn-terminal-danger">Close</button>
        <button onClick={() => onDelete(positionId)} className="btn-terminal-danger px-2.5" aria-label="Delete Position">
          <Trash2 size={14} />
        </button>
      </div>
    );
  }

  const isSubmitting = loading || submitting;

  return (
    <div className="terminal-panel p-4 space-y-3">
      <div className="text-xs font-mono font-bold text-phosphor-green text-glow-green uppercase tracking-widest">
        ▌ {actionMode === 'Add' ? 'ADD_TO_POSITION' : actionMode === 'TakeProfit' ? 'TAKE_PROFIT' : 'CLOSE_POSITION'}
      </div>
      <div className="flex gap-3">
        {actionMode !== 'Close' && (
          <input type="number" min="1" value={actionQty} onChange={e => setActionQty(parseInt(e.target.value) || 1)}
            placeholder="Qty" className="w-24 px-4 py-3 rounded-md font-mono" />
        )}
        <input type="number" step="0.01" value={actionPrice} onChange={e => setActionPrice(e.target.value)}
          placeholder="Price" className="flex-1 px-4 py-3 rounded-md font-mono" autoFocus />
      </div>
      {actionMode === 'Close' && (
        <div className="space-y-2">
          <p className="label-mono">▌ EXIT_REASON</p>
          <div className="flex flex-wrap gap-2">
            {([
              ['EXP_PROFIT', 'Expired +'],
              ['EXP_LOSS', 'Expired −'],
              ['EARLY_PROFIT', 'Early Profit'],
              ['EARLY_DEFENSE', 'Early Defense'],
              ['TP', 'Profit Target'],
              ['SL', 'Stop Loss'],
              ['TIME', 'Time Stop'],
              ['MANUAL', 'Manual'],
              ['ROLL', 'Rolled'],
            ] as const).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setCloseExitType(t)}
                className={`px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border transition-colors cursor-pointer ${
                  closeExitType === t
                    ? 'bg-phosphor-green/15 text-phosphor-green text-glow-green border-phosphor-green/45'
                    : 'bg-terminal-panel text-text-tertiary border-border-default/50 hover:text-phosphor-dim hover:border-phosphor-green/20'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={() => { setActionMode(null); setCloseExitType('MANUAL'); }} className="flex-1 py-3 btn-terminal">Cancel</button>
        {actionMode === 'Close' && (
          <button onClick={() => handleAction('Close', closeExitType)}
            disabled={!actionPrice || isSubmitting} className="flex-1 py-3 btn-terminal-danger">
            {isSubmitting ? '...' : 'Confirm Close'}
          </button>
        )}
        {actionMode !== 'Close' && (
          <button onClick={() => handleAction(actionMode === 'Add' ? 'Size Up' : 'Take Profit')}
            disabled={!actionPrice || isSubmitting} className="flex-1 py-3 btn-terminal">
            {isSubmitting ? '...' : 'Confirm'}
          </button>
        )}
      </div>
    </div>
  );
};
