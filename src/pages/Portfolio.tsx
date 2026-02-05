import React, { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { Position, Transaction } from '../lib/types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { PositionCard } from '../components/PositionCard';
import { SETUPS } from '../lib/utils';
// Helper for icons if needed, but I'll use Lucide directly 



interface PortfolioPageProps {
    positions: Position[];
    transactions: Transaction[];
    onAction: (id: string, action: any) => Promise<void>;
    onUpdateScore: (id: string, score: number) => Promise<void>;
    onUpdatePrice: (id: string, price: number) => Promise<void>;
    onAddDirect: (item: any) => Promise<void>;
    loading: boolean;
}

export const PortfolioPage: React.FC<PortfolioPageProps> = ({ positions, transactions, onAction, onUpdateScore, onUpdatePrice, onAddDirect, loading }) => {
    const [showForm, setShowForm] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [sortBy] = useState('expiration');
    const [form, setForm] = useState({ ticker: '', strike: '', type: 'Call', expiration: '', setup: 'Pullback Buy', entry_score: '', stop_reason: '', quantity: '1', entry_price: '' });

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
        // This useEffect is no longer needed as refreshAllPrices is now a parent-level trigger
        // and children will handle their own price fetching based on refreshTrigger.
        // If auto-refresh on load is still desired, it should be implemented within PositionCard
        // or a separate mechanism that doesn't rely on the parent iterating.
        // For now, removing the auto-refresh logic from here.
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
        <div className="space-y-6 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
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
                <div className="card-elevated p-6 animate-in fade-in slide-in-from-top-4">
                    <h3 className="text-lg font-bold mb-4">Quick Add Position</h3>
                    <form onSubmit={handleSubmit} className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                        <input
                            placeholder="Ticker (e.g. SPY)"
                            className="input-field"
                            value={form.ticker}
                            onChange={e => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
                            required
                        />
                        <div className="flex gap-2">
                            <input
                                type="number"
                                placeholder="Strike"
                                className="input-field"
                                value={form.strike}
                                onChange={e => setForm({ ...form, strike: e.target.value })}
                                required
                            />
                            <select
                                className="input-field w-24"
                                value={form.type}
                                onChange={e => setForm({ ...form, type: e.target.value })}
                            >
                                <option value="Call">Call</option>
                                <option value="Put">Put</option>
                            </select>
                        </div>
                        <input
                            type="date"
                            className="input-field"
                            value={form.expiration}
                            onChange={e => setForm({ ...form, expiration: e.target.value })}
                            required
                        />
                        <select
                            className="input-field"
                            value={form.setup}
                            onChange={e => setForm({ ...form, setup: e.target.value })}
                        >
                            {SETUPS.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <div className="flex gap-2">
                            <input
                                type="number"
                                placeholder="Score"
                                className="input-field w-20"
                                value={form.entry_score}
                                onChange={e => setForm({ ...form, entry_score: e.target.value })}
                            />
                            <input
                                placeholder="Stop Reason"
                                className="input-field flex-1"
                                value={form.stop_reason}
                                onChange={e => setForm({ ...form, stop_reason: e.target.value })}
                            />
                        </div>
                        <div className="flex gap-2">
                            <input
                                type="number"
                                placeholder="Qty"
                                className="input-field w-20"
                                value={form.quantity}
                                onChange={e => setForm({ ...form, quantity: e.target.value })}
                                required
                            />
                            <input
                                type="number"
                                step="0.01"
                                placeholder="Price"
                                className="input-field flex-1"
                                value={form.entry_price}
                                onChange={e => setForm({ ...form, entry_price: e.target.value })}
                                required
                            />
                        </div>
                        <div className="col-span-2 md:col-span-4 lg:col-span-5 flex justify-end gap-2 mt-2">
                            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
                            <button type="submit" disabled={submitting} className="btn-primary">
                                {submitting ? 'Adding...' : 'Add Position'}
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
                            refreshTrigger={refreshTrigger}
                            index={index}
                        />
                    ))}
                </div>
            )}

        </div>
    );
};
