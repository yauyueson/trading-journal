import React, { useState, useEffect } from 'react';
import { RefreshCw, Crosshair, Calendar, Trash2 } from 'lucide-react';
import { Position } from '../lib/types';
import { formatDate, formatPrice } from '../lib/utils';

interface WatchlistItemProps {
    item: Position;
    onMoveToActive: (item: Position) => void;
    onDelete: (id: string) => Promise<void>;
    onDataUpdate?: (timestamp: string) => void;
}

export const WatchlistItem: React.FC<WatchlistItemProps> = ({ item, onMoveToActive, onDelete, onDataUpdate }) => {
    const [currentPrice, setCurrentPrice] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [earnings, setEarnings] = useState<{ date: string | null; days: number | null }>({ date: null, days: null });

    const isSpread = !!item.legs && item.legs.length > 0;

    const fetchPrice = async () => {
        setLoading(true);
        try {
            if (isSpread && item.legs) {
                const promises = item.legs.map(leg =>
                    fetch(`/api/option-price?ticker=${item.ticker}&expiration=${leg.expiration}&strike=${leg.strike}&type=${leg.type}`)
                        .then(res => res.ok ? res.json() : { price: 0 })
                );
                const results = await Promise.all(promises);

                const shortIndex = item.legs.findIndex(l => l.side === 'short');
                const longIndex = item.legs.findIndex(l => l.side === 'long');

                const shortResult = shortIndex >= 0 ? results[shortIndex] : { price: 0 };
                const longResult = longIndex >= 0 ? results[longIndex] : { price: 0 };

                const shortPrice = shortResult.price || 0;
                const longPrice = longResult.price || 0;

                // Report timestamp
                const firstValid = results.find(r => r && r.cboeTimestamp);
                if (firstValid && onDataUpdate) {
                    onDataUpdate(firstValid.cboeTimestamp);
                }

                let net = 0;
                if (item.type.includes('Credit') || item.type.includes('Short')) {
                    net = shortPrice - longPrice;
                } else {
                    net = longPrice - shortPrice;
                }
                setCurrentPrice(net);
            } else {
                const params = new URLSearchParams({ ticker: item.ticker, expiration: item.expiration, strike: item.strike.toString(), type: item.type });
                const response = await fetch(`/api/option-price?${params}`);
                if (response.ok) {
                    const data = await response.json();
                    setCurrentPrice(data.price);
                    if (data.cboeTimestamp && onDataUpdate) {
                        onDataUpdate(data.cboeTimestamp);
                    }
                }
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

    const priceDiff = currentPrice !== null && item.ideal_entry ? ((currentPrice - item.ideal_entry) / item.ideal_entry * 100) : null;
    const isGoodEntry = priceDiff !== null && (item.type.includes('Credit') ? priceDiff >= -5 : priceDiff <= 5); // Credit: Higher is better (more credit), Debit: Lower is better
    const hasEarningsSoon = earnings.days !== null && earnings.days >= 0 && earnings.days <= 7;

    return (
        <div className={`card p-5 fade-in ${isGoodEntry ? 'card-success' : ''}`}>
            <div className="flex justify-between items-start">
                <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <span className="text-xl font-bold">{item.ticker}</span>
                        {isSpread ? (
                            <>
                                <span className="badge badge-purple">Spread</span>
                                <span className={`badge ${item.type.includes('Credit') ? 'badge-green' : 'badge-blue'}`}>
                                    {item.type.includes('Credit') ? 'Credit' : 'Debit'}
                                </span>
                            </>
                        ) : (
                            <span className={`badge ${item.type === 'Call' ? 'badge-green' : 'badge-red'}`}>{item.type}</span>
                        )}
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
                        {isSpread ? (
                            <span className="font-mono">
                                {item.legs?.find(l => l.side === 'short')?.strike} / {item.legs?.find(l => l.side === 'long')?.strike}
                            </span>
                        ) : (
                            <span className="font-mono">${item.strike}</span>
                        )}
                        <span className="mx-2">·</span>
                        <span>{formatDate(item.expiration)}</span>
                        <span className="mx-2">·</span>
                        <span>{item.setup}</span>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                        <div>
                            <span className="text-text-tertiary">Now: </span>
                            <span className="font-mono font-medium">
                                {loading ? '...' : currentPrice !== null ? formatPrice(currentPrice) : '—'}
                            </span>
                        </div>
                        {item.ideal_entry && (
                            <div>
                                <span className="text-text-tertiary">Ideal: </span>
                                <span className="font-mono text-accent-yellow">{formatPrice(item.ideal_entry)}</span>
                            </div>
                        )}
                        {priceDiff !== null && (
                            <span className={`font-mono ${item.type.includes('Credit')
                                ? (priceDiff >= 0 ? 'text-accent-green' : 'text-accent-red') // Credit: More is better
                                : (priceDiff <= 0 ? 'text-accent-green' : 'text-accent-red') // Debit: Less is better
                                }`}>
                                ({priceDiff >= 0 ? '+' : ''}{priceDiff.toFixed(1)}%)
                            </span>
                        )}
                    </div>
                    {item.stop_reason && <div className="text-sm text-text-tertiary mt-2 line-clamp-2" title={item.stop_reason}>Exit if: {item.stop_reason}</div>}
                </div>
                <div className="flex flex-col gap-2 ml-4">
                    <button onClick={() => onMoveToActive(item)} className="btn-primary px-5 py-2 rounded-lg cursor-pointer">
                        Buy
                    </button>
                    <div className="flex gap-2">
                        <button
                            onClick={fetchPrice}
                            disabled={loading}
                            className="btn-secondary flex-1 py-2 rounded-lg text-sm flex items-center justify-center cursor-pointer"
                            aria-label="Refresh price"
                        >
                            {loading ? '...' : <RefreshCw size={16} />}
                        </button>
                        <button
                            onClick={() => onDelete(item.id)}
                            className="btn-secondary px-3 py-2 rounded-lg text-sm flex items-center justify-center cursor-pointer hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/30 transition-colors"
                            aria-label="Delete from watchlist"
                        >
                            <Trash2 size={16} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
