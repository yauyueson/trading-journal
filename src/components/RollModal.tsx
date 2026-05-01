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
    const [newType, setNewType] = useState<'Call' | 'Put'>(position.type as 'Call' | 'Put');
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
        <div className="fixed inset-0 modal-overlay flex items-center justify-center p-4 z-[100]" role="dialog" aria-modal="true" aria-label="Roll position">
            <div className="terminal-panel p-6 w-full max-w-2xl fade-in max-h-[90vh] overflow-y-auto">
                <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4">▌ ROLL_POSITION</h3>

                <div className="flex flex-col md:flex-row gap-6">
                    {/* Close Existing Leg */}
                    <div className="flex-1 space-y-4">
                        <div className="terminal-panel terminal-panel-red p-4">
                            <h4 className="text-xs font-mono font-bold text-phosphor-red text-glow-red mb-2 uppercase tracking-widest">▌ CLOSE_LEG</h4>
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-lg font-mono font-bold uppercase tracking-wider text-phosphor-green text-glow-green">{position.ticker}</span>
                                <span className={`badge font-mono uppercase tracking-wider text-[10px] ${position.type === 'Call' ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/30' : 'bg-phosphor-red/10 text-phosphor-red text-glow-red border border-phosphor-red/30'}`}>{position.type}</span>
                            </div>
                            <div className="text-text-secondary text-xs font-mono mb-3 tabular-nums">
                                ${position.strike} · {formatDate(position.expiration)}
                            </div>

                            <div className="space-y-3">
                                <div>
                                    <label className="label-mono mb-1 block">CLOSE QTY (MAX {currentQuantity})</label>
                                    <input
                                        type="number"
                                        min="1"
                                        max={currentQuantity}
                                        value={closeQty}
                                        onChange={e => setCloseQty(Math.min(currentQuantity, parseInt(e.target.value) || 1))}
                                        className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
                                    />
                                </div>
                                <div>
                                    <label className="label-mono mb-1 block">CLOSE PRICE</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={closePrice}
                                        onChange={e => setClosePrice(e.target.value)}
                                        className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
                                        placeholder="Price you close at"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Open New Leg */}
                    <div className="flex-1 space-y-4">
                        <div className="terminal-panel border-phosphor-green/45 p-4">
                            <h4 className="text-xs font-mono font-bold text-phosphor-green text-glow-green mb-2 uppercase tracking-widest">▌ OPEN_NEW_LEG</h4>

                            <div className="space-y-3">
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="label-mono mb-1 block">NEW EXPIRATION</label>
                                        <input
                                            type="date"
                                            value={newExpiration}
                                            onChange={e => setNewExpiration(e.target.value)}
                                            className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white text-xs"
                                        />
                                    </div>
                                    <div>
                                        <label className="label-mono mb-1 block">TYPE</label>
                                        <select
                                            className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white text-xs h-[34px]"
                                            value={newType}
                                            onChange={e => setNewType(e.target.value as 'Call' | 'Put')}
                                        >
                                            <option value="Call">Call</option>
                                            <option value="Put">Put</option>
                                        </select>
                                    </div>
                                </div>

                                <div>
                                    <label className="label-mono mb-1 block">NEW STRIKE</label>
                                    <input
                                        type="number"
                                        step="0.5"
                                        value={newStrike}
                                        onChange={e => setNewStrike(parseFloat(e.target.value) || 0)}
                                        className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
                                    />
                                </div>

                                <div>
                                    <label className="label-mono mb-1 block">OPEN QTY</label>
                                    <input
                                        type="number"
                                        min="1"
                                        value={newQty}
                                        onChange={e => setNewQty(parseInt(e.target.value) || 1)}
                                        className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
                                        placeholder="Same or less to scale down"
                                    />
                                </div>
                                <div>
                                    <label className="label-mono mb-1 block">OPEN PRICE</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={newPrice}
                                        onChange={e => setNewPrice(e.target.value)}
                                        className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
                                        placeholder="Price you open at"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Net Calculation (Optional Visual) */}
                {(closePrice && newPrice) && (
                    <div className="mt-4 terminal-panel p-3 text-center text-xs font-mono uppercase tracking-wider">
                        <span className="text-text-tertiary">▌ NET: </span>
                        <span className="font-mono font-bold text-phosphor-green text-glow-green">
                            ROLLING POSITION
                        </span>
                    </div>
                )}

                <div className="flex gap-3 mt-6">
                    <button onClick={onCancel} className="btn-terminal-danger flex-1">CANCEL</button>
                    <button
                        onClick={handleConfirm}
                        disabled={!closePrice || !newPrice || loading}
                        className="btn-terminal flex-1"
                    >
                        {loading ? '▌ ROLLING...' : '▌ CONFIRM ROLL'}
                    </button>
                </div>
            </div>
        </div>
    );
};
