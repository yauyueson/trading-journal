import React, { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { Position, Transaction, PositionAction, DirectAddItem, RollData } from '../lib/types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { PositionCard } from '../components/PositionCard';
import { RollModal } from '../components/RollModal';
import { DataFooter } from '../components/DataFooter';
import { SETUPS } from '../lib/utils';

interface PortfolioPageProps {
    positions: Position[];
    transactions: Transaction[];
    onAction: (id: string, action: PositionAction) => Promise<void>;
    onUpdateScore: (id: string, score: number) => Promise<void>;
    onUpdatePrice: (id: string, price: number) => Promise<void>;
    onUpdateTarget: (id: string, target: number) => Promise<void>;
    onAddDirect: (item: DirectAddItem) => Promise<void>;
    onRoll: (originalPositionId: string, rollData: RollData) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    loading: boolean;
}

export const PortfolioPage: React.FC<PortfolioPageProps> = ({ positions, transactions, onAction, onUpdateScore, onUpdatePrice, onUpdateTarget, onAddDirect, onRoll, onDelete, loading }) => {
    const [showForm, setShowForm] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [rollingPosition, setRollingPosition] = useState<{ position: Position, qty: number } | null>(null);
    const [sortBy] = useState('expiration');
    const [form, setForm] = useState({ ticker: '', strike: '', type: 'Call', expiration: '', setup: 'Pullback Buy', entry_score: '', stop_reason: '', quantity: '1', entry_price: '' });
    const [lastTimestamp, setLastTimestamp] = useState<string | null>(null);

    const [refreshTrigger, setRefreshTrigger] = useState(0);

    const activePositions = positions.filter(p => p.status === 'active');

    const sortedPositions = [...activePositions].sort((a, b) => {
        switch (sortBy) {
            case 'expiration':
                return new Date(a.expiration).getTime() - new Date(b.expiration).getTime();
            case 'ticker':
                return a.ticker.localeCompare(b.ticker);
            case 'created':
                return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
            default:
                return 0;
        }
    });

    const refreshAllPrices = async () => {
        setRefreshing(true);
        // Increment trigger to signal children to fetch
        setRefreshTrigger(prev => prev + 1);

        // Simulating the loading state for UI feedback
        // The actual fetching happens in the children
        await new Promise(r => setTimeout(r, activePositions.length * 200 + 500));

        setRefreshing(false);
    };

    useEffect(() => {
        refreshAllPrices();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        await onAddDirect({
            ticker: form.ticker,
            strike: parseFloat(form.strike),
            type: form.type,
            expiration: form.expiration,
            setup: form.setup,
            entry_score: parseInt(form.entry_score),
            stop_reason: form.stop_reason,
            quantity: parseInt(form.quantity),
            entry_price: parseFloat(form.entry_price)
        });
        setSubmitting(false);
        setForm({ ticker: '', strike: '', type: 'Call', expiration: '', setup: 'Pullback Buy', entry_score: '', stop_reason: '', quantity: '1', entry_price: '' });
        setShowForm(false);
    };

    if (loading) return <LoadingSpinner />;

    return (
        <div className="fade-in pb-24 sm:pb-0 space-y-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-3xl font-bold bg-gradient-to-r from-text-primary to-text-secondary bg-clip-text text-transparent">
                        Portfolio
                    </h1>
                    <p className="text-text-secondary mt-1">Manage open positions and track performance</p>
                </div>

                <div className="flex items-center gap-3">
                    <button
                        onClick={refreshAllPrices}
                        disabled={refreshing}
                        className={`
                            relative overflow-hidden group flex items-center gap-2 px-4 py-2 rounded-xl border border-border-default/50 
                            bg-bg-secondary/30 backdrop-blur-sm hover:bg-bg-secondary transition-all duration-200
                            ${refreshing ? 'opacity-70 cursor-not-allowed text-text-tertiary' : 'text-text-secondary hover:text-text-primary hover:border-text-secondary/30'}
                        `}
                    >
                        <RefreshCw size={18} className={`transition-transform duration-500 ${refreshing ? 'animate-spin' : 'group-hover:rotate-180'}`} />
                        <span className="font-medium text-sm">{refreshing ? 'Refreshing...' : 'Refresh All'}</span>
                    </button>

                    <button
                        onClick={() => setShowForm(!showForm)}
                        className={`
                            flex items-center gap-2 px-5 py-2 rounded-xl font-medium text-sm text-white shadow-lg transition-all duration-200
                            bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500
                            shadow-emerald-500/20 hover:shadow-emerald-500/30 hover:-translate-y-0.5
                        `}
                    >
                        <span className="text-lg leading-none mb-0.5">+</span>
                        <span>Add Position</span>
                    </button>
                </div>
            </div>

            {/* Quick Add Form */}
            {showForm && (
                <div className="card-elevated p-8 animate-in fade-in slide-in-from-top-4 shadow-2xl relative overflow-hidden group">
                    <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500/50" />
                    <div className="flex justify-between items-center mb-8">
                        <div>
                            <h3 className="text-xl font-bold text-text-primary">Quick Add Position</h3>
                            <p className="text-sm text-text-tertiary">Enter the details of your new option position</p>
                        </div>
                        <button
                            onClick={() => setShowForm(false)}
                            className="p-2 hover:bg-bg-elevated rounded-lg transition-colors text-text-tertiary hover:text-text-primary"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-8">
                        {/* Row 1: Basic Info */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                            <div className="space-y-1.5">
                                <label htmlFor="ticker">Symbol</label>
                                <input
                                    id="ticker"
                                    placeholder="e.g. SPY"
                                    className="input-field"
                                    value={form.ticker}
                                    onChange={e => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
                                    required
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1.5">
                                    <label htmlFor="strike">Strike</label>
                                    <input
                                        id="strike"
                                        type="number"
                                        placeholder="0.00"
                                        className="input-field"
                                        value={form.strike}
                                        onChange={e => setForm({ ...form, strike: e.target.value })}
                                        required
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label htmlFor="type">Type</label>
                                    <select
                                        id="type"
                                        className="input-field"
                                        value={form.type}
                                        onChange={e => setForm({ ...form, type: e.target.value })}
                                    >
                                        <option value="Call">Call</option>
                                        <option value="Put">Put</option>
                                    </select>
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <label htmlFor="expiration">Expiration</label>
                                <input
                                    id="expiration"
                                    type="date"
                                    className="input-field"
                                    value={form.expiration}
                                    onChange={e => setForm({ ...form, expiration: e.target.value })}
                                    required
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label htmlFor="setup">Setup Strategy</label>
                                <select
                                    id="setup"
                                    className="input-field"
                                    value={form.setup}
                                    onChange={e => setForm({ ...form, setup: e.target.value })}
                                >
                                    {SETUPS.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                            </div>
                        </div>

                        {/* Row 2: Analysis & Execution */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                            <div className="space-y-1.5">
                                <label htmlFor="score">Entry Score</label>
                                <input
                                    id="score"
                                    type="number"
                                    placeholder="0-100"
                                    className="input-field"
                                    value={form.entry_score}
                                    onChange={e => setForm({ ...form, entry_score: e.target.value })}
                                />
                            </div>

                            <div className="space-y-1.5 lg:col-span-1">
                                <label htmlFor="stop_reason">Stop Reason / Plan</label>
                                <input
                                    id="stop_reason"
                                    placeholder="Why take this trade?"
                                    className="input-field"
                                    value={form.stop_reason}
                                    onChange={e => setForm({ ...form, stop_reason: e.target.value })}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label htmlFor="quantity">Quantity</label>
                                <input
                                    id="quantity"
                                    type="number"
                                    placeholder="1"
                                    className="input-field"
                                    value={form.quantity}
                                    onChange={e => setForm({ ...form, quantity: e.target.value })}
                                    required
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label htmlFor="price">Entry Price</label>
                                <div className="relative">
                                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary select-none">$</span>
                                    <input
                                        id="price"
                                        type="number"
                                        step="0.01"
                                        placeholder="0.00"
                                        className="input-field pl-8"
                                        value={form.entry_price}
                                        onChange={e => setForm({ ...form, entry_price: e.target.value })}
                                        required
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex justify-end items-center gap-4 pt-4 border-t border-border-default/50">
                            <button
                                type="button"
                                onClick={() => setShowForm(false)}
                                className="px-6 py-2.5 rounded-xl font-medium text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={submitting}
                                className="btn-primary px-8 py-2.5 rounded-xl flex items-center gap-2 shadow-lg shadow-emerald-500/10"
                            >
                                {submitting ? (
                                    <>
                                        <RefreshCw size={18} className="animate-spin" />
                                        <span>Adding...</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-xl leading-none mb-0.5">+</span>
                                        <span>Add Position</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {activePositions.length === 0 ? (
                <div className="text-center py-20 text-text-tertiary">
                    No active positions. Click "Add Position" to start tracking.
                </div>
            ) : (
                <div className="space-y-4">
                    {sortedPositions.map((position, index) => (
                        <PositionCard
                            key={position.id}
                            position={position}
                            transactions={transactions.filter(t => t.position_id === position.id)}
                            onAction={onAction}
                            onUpdateScore={onUpdateScore}
                            onUpdatePrice={onUpdatePrice}
                            onUpdateTarget={onUpdateTarget}
                            onDelete={onDelete}
                            onDataUpdate={setLastTimestamp}
                            refreshTrigger={refreshTrigger}
                            index={index}
                            onRollClick={(qty) => setRollingPosition({ position, qty })}
                        />
                    ))}
                </div>
            )}

            <DataFooter timestamp={lastTimestamp} />

            {rollingPosition && (
                <RollModal
                    position={rollingPosition.position}
                    currentQuantity={rollingPosition.qty}
                    onConfirm={async (closeQty, closePrice, newStrike, newType, newExpiration, newQty, newPrice) => {
                        await onRoll(rollingPosition.position.id, {
                            closeQty,
                            closePrice,
                            newStrike,
                            newType,
                            newExpiration,
                            newQty,
                            newPrice
                        });
                        setRollingPosition(null);
                    }}
                    onCancel={() => setRollingPosition(null)}
                />
            )}
        </div>
    );
};
