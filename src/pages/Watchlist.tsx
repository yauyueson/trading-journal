import { useState, useEffect } from 'react';
import { List } from 'lucide-react';
import { Position, WatchlistItem as WatchlistItemType } from '../lib/types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { WatchlistItem } from '../components/WatchlistItem';
import { DataFooter } from '../components/DataFooter';
import { SETUPS } from '../lib/utils';

interface WatchlistPageProps {
    positions: Position[];
    onAddToWatchlist: (item: WatchlistItemType) => Promise<void>;
    onMoveToActive: (item: Position) => void;
    onDelete: (id: string) => Promise<void>;
    loading: boolean;
    fetchEarningsForTicker?: (ticker: string) => Promise<{ daysUntil: number | null; date: string | null }>;
}

export const WatchlistPage: React.FC<WatchlistPageProps> = ({ positions, onAddToWatchlist, onMoveToActive, onDelete, loading, fetchEarningsForTicker }) => {
    const [showForm, setShowForm] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [formOwner, setFormOwner] = useState<'Yuchen' | 'Annie'>('Yuchen');
    const [form, setForm] = useState({ ticker: '', strike: '', type: 'Call', expiration: '', setup: 'Pullback Buy', entry_score: '', ideal_entry: '', stop_reason: '', target_price: '', notes: '' });
    const [lastTimestamp, setLastTimestamp] = useState<string | null>(null);
    const [bulkPrices, setBulkPrices] = useState<Record<string, number>>({});
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const watchlistItems = positions.filter(p => p.status === 'watchlist');

    // Bulk fetch prices for all watchlist items on mount (one POST instead of N GETs)
    useEffect(() => {
        if (watchlistItems.length === 0) return;
        const legs: any[] = [];
        watchlistItems.forEach(item => {
            const norm = (exp: string) => exp?.trim().replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (_, y, m, d) =>
                `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
            if (item.legs && item.legs.length > 0) {
                item.legs.forEach(leg => legs.push({
                    ticker: item.ticker, expiration: norm(leg.expiration),
                    strike: leg.strike, type: leg.type, id: item.id, side: leg.side
                }));
            } else {
                legs.push({
                    ticker: item.ticker, expiration: norm(item.expiration),
                    strike: item.strike, type: item.type, id: item.id
                });
            }
        });
        fetch('/api/option-prices-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ legs })
        })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data?.success || !data.results) return;
                // Compute net price per position id
                const pricesByPos: Record<string, { short: number; long: number; single: number; isCreditType: boolean }> = {};
                data.results.forEach((r: any) => {
                    if (!r.id || !r.success) return;
                    if (!pricesByPos[r.id]) {
                        const item = watchlistItems.find(i => i.id === r.id);
                        pricesByPos[r.id] = { short: 0, long: 0, single: 0, isCreditType: !!(item?.type?.includes('Credit') || item?.type?.includes('Short')) };
                    }
                    const p = r.price ?? 0;
                    if (r.side === 'short') pricesByPos[r.id].short = p;
                    else if (r.side === 'long') pricesByPos[r.id].long = p;
                    else pricesByPos[r.id].single = p;
                });
                const prices: Record<string, number> = {};
                Object.entries(pricesByPos).forEach(([id, v]) => {
                    if (v.short || v.long) {
                        prices[id] = v.isCreditType ? v.short - v.long : v.long - v.short;
                    } else {
                        prices[id] = v.single;
                    }
                });
                setBulkPrices(prices);
                setLastTimestamp(new Date().toISOString());
            })
            .catch(() => { /* fall back to individual fetches */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        try {
            await onAddToWatchlist({
                ...form,
                strike: parseFloat(form.strike),
                entry_score: form.entry_score ? parseInt(form.entry_score) : null,
                ideal_entry: form.ideal_entry ? parseFloat(form.ideal_entry) : null,
                target_price: form.target_price ? parseFloat(form.target_price) : null,
                owner: formOwner
            });
            setForm({ ticker: '', strike: '', type: 'Call', expiration: '', setup: 'Pullback Buy', entry_score: '', ideal_entry: '', stop_reason: '', target_price: '', notes: '' });
            setShowForm(false);
        } catch (e) {
            console.error("Error in form submit:", e);
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) return <LoadingSpinner />;

    return (
        <div className="fade-in pb-24 sm:pb-0">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h2 className="text-2xl font-bold">Watchlist</h2>
                    <p className="text-text-secondary text-sm">{watchlistItems.length} items</p>
                </div>
                <button onClick={() => setShowForm(!showForm)} className={showForm ? 'btn-secondary px-5 py-3 rounded-xl' : 'btn-primary px-5 py-3 rounded-xl'}>
                    {showForm ? 'Cancel' : '+ Add'}
                </button>
            </div>

            {showForm && (
                <form onSubmit={handleSubmit} className="card p-5 mb-6 space-y-4">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <input type="text" placeholder="Ticker" value={form.ticker} onChange={e => setForm({ ...form, ticker: e.target.value.toUpperCase() })} className="px-4 py-3 rounded-xl font-mono" aria-label="Ticker symbol" required />
                        <input type="number" step="0.5" placeholder="Strike" value={form.strike} onChange={e => setForm({ ...form, strike: e.target.value })} className="px-4 py-3 rounded-xl font-mono" aria-label="Strike price" required />
                        <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="px-4 py-3 rounded-xl" aria-label="Option type">
                            <option>Call</option><option>Put</option>
                        </select>
                        <input type="date" value={form.expiration} onChange={e => setForm({ ...form, expiration: e.target.value })} className="px-4 py-3 rounded-xl" aria-label="Expiration date" required />
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <select value={form.setup} onChange={e => setForm({ ...form, setup: e.target.value })} className="px-4 py-3 rounded-xl" aria-label="Setup type">
                            {SETUPS.map(s => <option key={s}>{s}</option>)}
                        </select>
                        <input type="number" placeholder="Score" value={form.entry_score} onChange={e => setForm({ ...form, entry_score: e.target.value })} className="px-4 py-3 rounded-xl font-mono" aria-label="Entry score" required />
                        <input type="number" step="0.01" placeholder="Ideal Entry $" value={form.ideal_entry} onChange={e => setForm({ ...form, ideal_entry: e.target.value })} className="px-4 py-3 rounded-xl font-mono" aria-label="Ideal entry price" />
                        <input type="number" step="0.01" placeholder="Target $" value={form.target_price} onChange={e => setForm({ ...form, target_price: e.target.value })} className="px-4 py-3 rounded-xl font-mono" aria-label="Target price" />
                    </div>
                    <input type="text" placeholder="Exit if... (e.g., MB flips red)" value={form.stop_reason} onChange={e => setForm({ ...form, stop_reason: e.target.value })} className="w-full px-4 py-3 rounded-xl" aria-label="Exit condition" />
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-text-tertiary">Owner:</span>
                        {(['Yuchen', 'Annie'] as const).map(name => (
                            <button
                                key={name}
                                type="button"
                                onClick={() => setFormOwner(name)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                    formOwner === name
                                        ? name === 'Yuchen'
                                            ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                                            : 'bg-pink-500/20 text-pink-400 border border-pink-500/40'
                                        : 'bg-bg-secondary/30 text-text-tertiary border border-border-default/50 hover:text-text-secondary'
                                }`}
                            >
                                {name}
                            </button>
                        ))}
                    </div>
                    <button type="submit" disabled={submitting} className="btn-primary w-full py-4 rounded-xl text-lg cursor-pointer">
                        {submitting ? 'Adding...' : 'Add to Watchlist'}
                    </button>
                </form>
            )}

            {watchlistItems.length === 0 ? (
                <div className="text-center py-16 text-text-secondary">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-tertiary flex items-center justify-center">
                        <List size={32} strokeWidth={1.5} />
                    </div>
                    <p>Your watchlist is empty</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {watchlistItems.map(item => (
                        <WatchlistItem
                            key={item.id}
                            item={item}
                            onMoveToActive={onMoveToActive}
                            onDelete={onDelete}
                            onDataUpdate={setLastTimestamp}
                            fetchEarningsForTicker={fetchEarningsForTicker}
                            initialPrice={bulkPrices[item.id] ?? null}
                            isExpanded={expandedId === item.id}
                            onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                        />
                    ))}
                </div>
            )}

            <DataFooter timestamp={lastTimestamp} />
        </div>
    );
};
