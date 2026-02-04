import React, { useState } from 'react';
import { Position } from '../lib/types';
import { formatDate } from '../lib/utils';

interface BuyModalProps {
    position: Position;
    onConfirm: (qty: number, price: number) => Promise<void>;
    onCancel: () => void;
}

export const BuyModal: React.FC<BuyModalProps> = ({ position, onConfirm, onCancel }) => {
    const [quantity, setQuantity] = useState(1);
    const [price, setPrice] = useState('');
    const [loading, setLoading] = useState(false);

    return (
        <div className="fixed inset-0 modal-overlay flex items-center justify-center p-4 z-[100]">
            <div className="card p-6 w-full max-w-md fade-in">
                <h3 className="text-xl font-bold mb-4">Open Position</h3>
                <div className="mb-4 p-4 bg-bg-tertiary rounded-xl">
                    <div className="flex items-center gap-3">
                        <span className="text-lg font-bold">{position.ticker}</span>
                        <span className={`badge ${position.type === 'Call' ? 'badge-green' : 'badge-red'}`}>{position.type}</span>
                    </div>
                    <div className="text-text-secondary text-sm">
                        ${position.strike} · {formatDate(position.expiration)}
                    </div>
                </div>
                <div className="space-y-4 mb-6">
                    <div>
                        <label className="text-sm text-text-secondary block mb-2">Quantity</label>
                        <input type="number" min="1" value={quantity} onChange={e => setQuantity(parseInt(e.target.value) || 1)} className="w-full px-4 py-3 rounded-xl font-mono" aria-label="Quantity" />
                    </div>
                    <div>
                        <label className="text-sm text-text-secondary block mb-2">Entry Price</label>
                        <input type="number" step="0.01" value={price} onChange={e => setPrice(e.target.value)} className="w-full px-4 py-3 rounded-xl font-mono" aria-label="Entry price" autoFocus required />
                    </div>
                </div>
                <div className="flex gap-3">
                    <button onClick={onCancel} className="flex-1 py-3 btn-secondary rounded-xl cursor-pointer">Cancel</button>
                    <button onClick={async () => { setLoading(true); await onConfirm(quantity, parseFloat(price)); setLoading(false); }} disabled={!price || loading} className="flex-1 py-3 btn-primary rounded-xl cursor-pointer">
                        {loading ? '...' : 'Confirm'}
                    </button>
                </div>
            </div>
        </div>
    );
};
