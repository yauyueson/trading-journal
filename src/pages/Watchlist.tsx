import React, { useState } from 'react';
import { List } from 'lucide-react';
import { Position } from '../lib/types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { WatchlistItem } from '../components/WatchlistItem';
import { SETUPS } from '../lib/utils';

interface WatchlistPageProps {
    positions: Position[];
    onAddToWatchlist: (item: any) => Promise<void>;
    onMoveToActive: (item: Position) => void;
    onDelete: (id: string) => Promise<void>;
    loading: boolean;
}

export const WatchlistPage: React.FC<WatchlistPageProps> = ({ positions, onAddToWatchlist, onMoveToActive, onDelete, loading }) => {
    const [showForm, setShowForm] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [form, setForm] = useState({ ticker: '', strike: '', type: 'Call', expiration: '', setup: 'Pullback Buy', entry_score: '', ideal_entry: '', stop_reason: '', target_price: '', notes: '' });
    const watchlistItems = positions.filter(p => p.status === 'watchlist');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        try {
            await onAddToWatchlist({
                ...form,
                strike: parseFloat(form.strike),
                entry_score: form.entry_score ? parseInt(form.entry_score) : null,
                ideal_entry: form.ideal_entry ? parseFloat(form.ideal_entry) : null,
                target_price: form.target_price ? parseFloat(form.target_price) : null
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
                    {watchlistItems.map(item => <WatchlistItem key={item.id} item={item} onMoveToActive={onMoveToActive} onDelete={onDelete} />)}
                </div>
            )}
        </div>
    );
};
