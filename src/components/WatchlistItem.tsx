import React, { useState, useEffect } from 'react';
import { RefreshCw, Crosshair, Calendar } from 'lucide-react';
import { Position } from '../lib/types';
import { formatDate, formatPrice } from '../lib/utils';

interface WatchlistItemProps {
    item: Position;
    onMoveToActive: (item: Position) => void;
}

export const WatchlistItem: React.FC<WatchlistItemProps> = ({ item, onMoveToActive }) => {
    const [currentPrice, setCurrentPrice] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [earnings, setEarnings] = useState<{ date: string | null; days: number | null }>({ date: null, days: null });

    const fetchPrice = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ ticker: item.ticker, expiration: item.expiration, strike: item.strike.toString(), type: item.type });
            const response = await fetch(`/api/option-price?${params}`);
            if (response.ok) {
                const data = await response.json();
                setCurrentPrice(data.price);
            }
        } catch (e) { console.error(e); }
        setLoading(false);
    };

    useEffect(() => {
        fetchPrice();
        const fetchEarnings = async () => {
            try {
                const response = await fetch(`/api/earnings?symbol=${item.ticker}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.hasUpcomingEarnings && data.daysUntilEarnings <= 14) {
                        setEarnings({ date: data.earningsDate, days: data.daysUntilEarnings });
                    }
                }
            } catch (e) { /* ignore */ }
        };
        fetchEarnings();
    }, []);

    const priceDiff = currentPrice && item.ideal_entry ? ((currentPrice - item.ideal_entry) / item.ideal_entry * 100) : null;
    const isGoodEntry = priceDiff !== null && priceDiff <= 5;
    const hasEarningsSoon = earnings.days !== null && earnings.days >= 0 && earnings.days <= 7;

    return (
        <div className={`card p-5 fade-in ${isGoodEntry ? 'card-success' : ''}`}>
            <div className="flex justify-between items-start">
                <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <span className="text-xl font-bold">{item.ticker}</span>
                        <span className={`badge ${item.type === 'Call' ? 'badge-green' : 'badge-red'}`}>{item.type}</span>
                        <span className={`badge ${item.entry_score >= 70 ? 'badge-green' : item.entry_score >= 60 ? 'badge-yellow' : 'badge-red'}`}>
                            {item.entry_score}
                        </span>
                        {isGoodEntry && <span className="badge badge-green flex items-center gap-1"><Crosshair size={12} /> Entry</span>}
                        {hasEarningsSoon && (
                            <span className="badge badge-blue flex items-center gap-1">
                                <Calendar size={12} /> ER {earnings.days === 0 ? 'Today' : `${earnings.days}d`}
                            </span>
                        )}
                    </div>
                    <div className="text-text-secondary text-sm mb-3">
                        <span className="font-mono">${item.strike}</span>
                        <span className="mx-2">·</span>
                        <span>{formatDate(item.expiration)}</span>
                        <span className="mx-2">·</span>
                        <span>{item.setup}</span>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                        <div>
                            <span className="text-text-tertiary">Now: </span>
                            <span className="font-mono font-medium">
                                {loading ? '...' : currentPrice ? formatPrice(currentPrice) : '—'}
                            </span>
                        </div>
                        {item.ideal_entry && (
                            <div>
                                <span className="text-text-tertiary">Ideal: </span>
                                <span className="font-mono text-accent-yellow">{formatPrice(item.ideal_entry)}</span>
                            </div>
                        )}
                        {priceDiff !== null && (
                            <span className={`font-mono ${priceDiff <= 0 ? 'text-accent-green' : priceDiff <= 10 ? 'text-accent-yellow' : 'text-accent-red'}`}>
                                ({priceDiff >= 0 ? '+' : ''}{priceDiff.toFixed(1)}%)
                            </span>
                        )}
                    </div>
                    {item.stop_reason && <div className="text-sm text-text-tertiary mt-2">Exit if: {item.stop_reason}</div>}
                </div>
                <div className="flex flex-col gap-2 ml-4">
                    <button onClick={() => onMoveToActive(item)} className="btn-primary px-5 py-2 rounded-lg">
                        Buy
                    </button>
                    <button onClick={fetchPrice} disabled={loading} className="btn-secondary px-5 py-2 rounded-lg text-sm flex items-center justify-center">
                        {loading ? '...' : <RefreshCw size={16} />}
                    </button>
                </div>
            </div>
        </div>
    );
};
