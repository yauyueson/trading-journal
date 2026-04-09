import React, { useState } from 'react';
import { RefreshCw, Trash2, ArrowRightLeft } from 'lucide-react';
import type { Position, PositionAction } from '../../lib/types';

interface PositionActionFormProps {
  positionId: string;
  totalQty: number;
  loading: boolean;
  onAction: (id: string, action: PositionAction, exitType?: Position['exit_type']) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRefresh: () => void;
  onRollClick?: (qty: number) => void;
}

export const PositionActionForm: React.FC<PositionActionFormProps> = ({
  positionId,
  totalQty,
  loading,
  onAction,
  onDelete,
  onRefresh,
  onRollClick,
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
        <button onClick={onRefresh} disabled={loading} className="action-btn btn-secondary flex items-center justify-center gap-1.5 cursor-pointer px-2.5 sm:px-3" aria-label="Refresh price">
          {loading ? <div className="spinner w-4 h-4" /> : <RefreshCw size={15} />}
          <span className="hidden sm:inline text-sm">Refresh</span>
        </button>
        <button onClick={() => setActionMode('Add')} className="action-btn btn-secondary text-sm">+ Add</button>
        <button onClick={() => setActionMode('TakeProfit')} className="action-btn btn-secondary text-sm">Profit</button>
        {onRollClick && (
          <button onClick={() => onRollClick(totalQty)} className="action-btn btn-secondary text-text-secondary hover:text-white flex items-center gap-1 text-sm">
            <ArrowRightLeft size={14} /> Roll
          </button>
        )}
        <button onClick={() => setActionMode('Close')} className="action-btn btn-secondary text-text-secondary hover:text-accent-red hover:bg-accent-red/10 text-sm">Close</button>
        <button onClick={() => onDelete(positionId)} className="action-btn btn-secondary text-text-tertiary hover:text-accent-red hover:bg-accent-red/10 px-2.5" aria-label="Delete Position">
          <Trash2 size={15} />
        </button>
      </div>
    );
  }

  const isSubmitting = loading || submitting;

  return (
    <div className="card-elevated p-4 space-y-3">
      <div className="text-sm font-medium text-text-secondary">
        {actionMode === 'Add' ? 'Add to Position' : actionMode === 'TakeProfit' ? 'Take Profit' : 'Close Position'}
      </div>
      <div className="flex gap-3">
        {actionMode !== 'Close' && (
          <input type="number" min="1" value={actionQty} onChange={e => setActionQty(parseInt(e.target.value) || 1)}
            placeholder="Qty" className="w-24 px-4 py-3 rounded-xl font-mono" />
        )}
        <input type="number" step="0.01" value={actionPrice} onChange={e => setActionPrice(e.target.value)}
          placeholder="Price" className="flex-1 px-4 py-3 rounded-xl font-mono" autoFocus />
      </div>
      {actionMode === 'Close' && (
        <div className="space-y-2">
          <p className="text-xs text-text-tertiary">Why are you closing?</p>
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
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                  closeExitType === t
                    ? 'bg-accent-green/20 text-accent-green border-accent-green/40'
                    : 'bg-bg-tertiary text-text-tertiary border-white/[0.1] hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={() => { setActionMode(null); setCloseExitType('MANUAL'); }} className="flex-1 py-3 btn-secondary rounded-xl">Cancel</button>
        {actionMode === 'Close' && (
          <button onClick={() => handleAction('Close', closeExitType)}
            disabled={!actionPrice || isSubmitting} className="flex-1 py-3 btn-primary rounded-xl">
            {isSubmitting ? '...' : 'Confirm Close'}
          </button>
        )}
        {actionMode !== 'Close' && (
          <button onClick={() => handleAction(actionMode === 'Add' ? 'Size Up' : 'Take Profit')}
            disabled={!actionPrice || isSubmitting} className="flex-1 py-3 btn-primary rounded-xl">
            {isSubmitting ? '...' : 'Confirm'}
          </button>
        )}
      </div>
    </div>
  );
};
