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
    const [refreshStatus, setRefreshStatus] = useState('');
    const [autoRefreshed, setAutoRefreshed] = useState(false);
    const [sortBy, setSortBy] = useState('expiration');
    const [form, setForm] = useState({ ticker: '', strike: '', type: 'Call', expiration: '', setup: 'Pullback Buy', entry_score: '', stop_reason: '', quantity: '1', entry_price: '' });

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
        if (activePositions.length === 0) return;
        setRefreshing(true);
        setRefreshStatus('');
        let success = 0, failed = 0;
        for (let i = 0; i < activePositions.length; i++) {
            const position = activePositions[i];
            setRefreshStatus(`${position.ticker} (${i + 1}/${activePositions.length})`);
            try {
                const params = new URLSearchParams({ ticker: position.ticker, expiration: position.expiration, strike: position.strike.toString(), type: position.type });
                const response = await fetch(`/api/option-price?${params}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.price) { await onUpdatePrice(position.id, data.price); success++; }
                    else { failed++; }
                } else { failed++; }
            } catch (e) { failed++; }
            if (i < activePositions.length - 1) await new Promise(r => setTimeout(r, 500));
        }
        setRefreshStatus(failed > 0 ? `✓ ${success} updated, ${failed} failed` : `✓ All prices updated`);
        setRefreshing(false);
        setTimeout(() => setRefreshStatus(''), 3000);
    };

    useEffect(() => {
        if (!loading && activePositions.length > 0 && !autoRefreshed) {
            setAutoRefreshed(true);
            refreshAllPrices();
        }
    }, [loading, activePositions.length]);

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
        <div className="fade-in pb-24 sm:pb-0">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
                <div>
                    <h2 className="text-2xl font-bold">Positions</h2>
                    <p className="text-text-secondary text-sm">{activePositions.length} active</p>
                </div>
                <div className="flex gap-2 items-center flex-wrap">
                    {activePositions.length > 1 && (
                        <select
                            value={sortBy}
                            onChange={e => setSortBy(e.target.value)}
                            className="px-3 py-2 rounded-lg bg-bg-tertiary border border-border-default text-sm flex-shrink-0"
                        >
                            <option value="expiration">Expiration</option>
                            <option value="ticker">Ticker</option>
                            <option value="created">Newest</option>
                        </select>
                    )}
                    {activePositions.length > 0 && (
                        <button onClick={refreshAllPrices} disabled={refreshing} className="btn-secondary px-3 py-2 rounded-lg flex items-center gap-1">
                            {refreshing ? <div className="spinner w-[14px] h-[14px]"></div> : <RefreshCw size={14} />}
                            <span className="hidden sm:inline text-sm">{refreshing ? refreshStatus : 'Refresh'}</span>
                        </button>
                    )}
                    <button onClick={() => setShowForm(!showForm)} className={showForm ? 'btn-secondary px-4 py-2 rounded-lg' : 'btn-primary px-4 py-2 rounded-lg'}>
                        {showForm ? 'Cancel' : '+ New'}
                    </button>
                </div>
            </div>

            {/* Status */}
            {refreshStatus && !refreshing && (
                <div className={`mb-4 p-4 rounded-xl text-sm ${refreshStatus.includes('failed') ? 'bg-accent-redDim text-accent-red' : 'bg-accent-greenDim text-accent-green'}`}>
                    {refreshStatus}
                </div>
            )}

            {/* Add Form */}
            {showForm && (
                <form onSubmit={handleSubmit} className="card p-5 mb-6 space-y-4">
                    <div className="text-sm text-text-secondary mb-2">Quick Entry</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <input type="text" placeholder="Ticker" value={form.ticker} onChange={e => setForm({ ...form, ticker: e.target.value.toUpperCase() })} className="px-4 py-3 rounded-xl font-mono" required />
                        <input type="number" step="0.5" placeholder="Strike" value={form.strike} onChange={e => setForm({ ...form, strike: e.target.value })} className="px-4 py-3 rounded-xl font-mono" required />
                        <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="px-4 py-3 rounded-xl">
                            <option>Call</option><option>Put</option>
                        </select>
                        <input type="date" value={form.expiration} onChange={e => setForm({ ...form, expiration: e.target.value })} className="px-4 py-3 rounded-xl" required />
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <select value={form.setup} onChange={e => setForm({ ...form, setup: e.target.value })} className="px-4 py-3 rounded-xl">
                            {SETUPS.map(s => <option key={s}>{s}</option>)}
                        </select>
                        <input type="number" placeholder="Score" value={form.entry_score} onChange={e => setForm({ ...form, entry_score: e.target.value })} className="px-4 py-3 rounded-xl font-mono" required />
                        <input type="number" min="1" placeholder="Qty" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} className="px-4 py-3 rounded-xl font-mono" required />
                        <input type="number" step="0.01" placeholder="Entry $" value={form.entry_price} onChange={e => setForm({ ...form, entry_price: e.target.value })} className="px-4 py-3 rounded-xl font-mono" required />
                    </div>
                    <input type="text" placeholder="Exit if... (optional)" value={form.stop_reason} onChange={e => setForm({ ...form, stop_reason: e.target.value })} className="w-full px-4 py-3 rounded-xl" />
                    <button type="submit" disabled={submitting} className="btn-primary w-full py-4 rounded-xl text-lg">
                        {submitting ? 'Opening...' : 'Open Position'}
                    </button>
                </form>
            )}

            {/* Positions List */}
            {activePositions.length === 0 && !showForm ? (
                <div className="text-center py-16 text-text-secondary">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-tertiary flex items-center justify-center">
                        <RefreshCw size={32} strokeWidth={1.5} />
                    </div>
                    <p>No active positions</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {sortedPositions.map(p => (
                        <PositionCard key={p.id} position={p} transactions={transactions} onAction={onAction} onUpdateScore={onUpdateScore} onUpdatePrice={onUpdatePrice} />
                    ))}
                </div>
            )}
        </div>
    );
};
