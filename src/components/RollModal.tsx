import React, { useState } from 'react';
import { Position } from '../lib/types';
import { formatDate } from '../lib/utils';

interface RollModalProps {
    position: Position;
    currentQuantity: number; // Current active quantity of the position
    onConfirm: (
        closeQty: number,
        closePrice: number,
        newStrike: number | string,
        newType: 'Call' | 'Put',
        newExpiration: string,
        newQty: number,
        newPrice: number
    ) => Promise<void>;
    onCancel: () => void;
}

export const RollModal: React.FC<RollModalProps> = ({ position, currentQuantity, onConfirm, onCancel }) => {
    const [loading, setLoading] = useState(false);

    // Close Leg State
    const [closeQty, setCloseQty] = useState(currentQuantity);
    const [closePrice, setClosePrice] = useState('');

    // Open Leg State
    const [newStrike, setNewStrike] = useState(position.strike);
    const [newType, setNewType] = useState(position.type);
    const [newExpiration, setNewExpiration] = useState(position.expiration);
    const [newQty, setNewQty] = useState(currentQuantity); // Default to rolling same size
    const [newPrice, setNewPrice] = useState('');

    const handleConfirm = async () => {
        setLoading(true);
        await onConfirm(
            closeQty,
            parseFloat(closePrice),
            newStrike,
            newType,
            newExpiration,
            newQty,
            parseFloat(newPrice)
        );
        setLoading(false);
    };

    return (
        <div className="fixed inset-0 modal-overlay flex items-center justify-center p-4 z-[100]">
            <div className="card p-6 w-full max-w-2xl fade-in max-h-[90vh] overflow-y-auto">
                <h3 className="text-xl font-bold mb-4">Roll Position</h3>

                <div className="flex flex-col md:flex-row gap-6">
                    {/* Close Existing Leg */}
                    <div className="flex-1 space-y-4">
                        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                            <h4 className="text-sm font-bold text-red-400 mb-2 uppercase tracking-wide">Close Legs</h4>
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-lg font-bold">{position.ticker}</span>
                                <span className={`badge ${position.type === 'Call' ? 'badge-green' : 'badge-red'}`}>{position.type}</span>
                            </div>
                            <div className="text-text-secondary text-xs mb-3">
                                ${position.strike} · {formatDate(position.expiration)}
                            </div>

                            <div className="space-y-3">
                                <div>
                                    <label className="text-xs text-text-secondary block mb-1">Close Qty (Max {currentQuantity})</label>
                                    <input
                                        type="number"
                                        min="1"
                                        max={currentQuantity}
                                        value={closeQty}
                                        onChange={e => setCloseQty(Math.min(currentQuantity, parseInt(e.target.value) || 1))}
                                        className="w-full px-3 py-2 rounded-lg font-mono bg-[#2C2C2E] border border-border-default text-white"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-text-secondary block mb-1">Close Price</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={closePrice}
                                        onChange={e => setClosePrice(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg font-mono bg-[#2C2C2E] border border-border-default text-white"
                                        placeholder="Price you close at"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Open New Leg */}
                    <div className="flex-1 space-y-4">
                        <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-xl">
                            <h4 className="text-sm font-bold text-green-400 mb-2 uppercase tracking-wide">Open New Legs</h4>

                            <div className="space-y-3">
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="text-xs text-text-secondary block mb-1">New Expiration</label>
                                        <input
                                            type="date"
                                            value={newExpiration}
                                            onChange={e => setNewExpiration(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg font-mono bg-[#2C2C2E] border border-border-default text-white text-xs"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs text-text-secondary block mb-1">Type</label>
                                        <select
                                            className="w-full px-3 py-2 rounded-lg font-mono bg-[#2C2C2E] border border-border-default text-white text-xs h-[34px]"
                                            value={newType}
                                            onChange={e => setNewType(e.target.value as 'Call' | 'Put')}
                                        >
                                            <option value="Call">Call</option>
                                            <option value="Put">Put</option>
                                        </select>
                                    </div>
                                </div>

                                <div>
                                    <label className="text-xs text-text-secondary block mb-1">New Strike</label>
                                    <input
                                        type="number"
                                        step="0.5"
                                        value={newStrike}
                                        onChange={e => setNewStrike(parseFloat(e.target.value) || 0)}
                                        className="w-full px-3 py-2 rounded-lg font-mono bg-[#2C2C2E] border border-border-default text-white"
                                    />
                                </div>

                                <div>
                                    <label className="text-xs text-text-secondary block mb-1">Open Qty</label>
                                    <input
                                        type="number"
                                        min="1"
                                        value={newQty}
                                        onChange={e => setNewQty(parseInt(e.target.value) || 1)}
                                        className="w-full px-3 py-2 rounded-lg font-mono bg-[#2C2C2E] border border-border-default text-white"
                                        placeholder="Same or less to scale down"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-text-secondary block mb-1">Open Price</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={newPrice}
                                        onChange={e => setNewPrice(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg font-mono bg-[#2C2C2E] border border-border-default text-white"
                                        placeholder="Price you open at"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Net Calculation (Optional Visual) */}
                {(closePrice && newPrice) && (
                    <div className="mt-4 p-3 bg-bg-secondary rounded-lg text-center text-sm">
                        <span className="text-text-secondary">Net: </span>
                        <span className="font-mono font-bold text-white">
                            {/* Simple approximation, doesn't account for credit/debit strategies direction precisely without knowing signs, 
                                but usually Rolling Credit: Buy Close (Debit) + Sell Open (Credit). 
                                Rolling Debit: Sell Close (Credit) + Buy Open (Debit).
                            */}
                            Rolling Position
                        </span>
                    </div>
                )}

                <div className="flex gap-3 mt-6">
                    <button onClick={onCancel} className="flex-1 py-3 btn-secondary rounded-xl cursor-pointer">Cancel</button>
                    <button
                        onClick={handleConfirm}
                        disabled={!closePrice || !newPrice || loading}
                        className="flex-1 py-3 btn-primary rounded-xl cursor-pointer"
                    >
                        {loading ? 'Rolling...' : 'Confirm Roll'}
                    </button>
                </div>
            </div>
        </div>
    );
};
