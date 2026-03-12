import React, { useState, useEffect } from 'react';
import { RefreshCw, Crosshair, Calendar, Trash2, ChevronDown, Target, ShieldAlert, StickyNote, TrendingUp } from 'lucide-react';
import { Position } from '../lib/types';
import { formatDate, formatPrice } from '../lib/utils';

interface WatchlistItemProps {
    item: Position;
    onMoveToActive: (item: Position) => void;
    onDelete: (id: string) => Promise<void>;
    onDataUpdate?: (timestamp: string) => void;
    fetchEarningsForTicker?: (ticker: string) => Promise<{ daysUntil: number | null; date: string | null }>;
    /** Pre-fetched price from bulk load — skips the individual API call on mount */
    initialPrice?: number | null;
    /** Controlled expand state (for accordion behavior) */
    isExpanded?: boolean;
    onToggle?: () => void;
}

export const WatchlistItem: React.FC<WatchlistItemProps> = ({ item, onMoveToActive, onDelete, onDataUpdate, fetchEarningsForTicker, initialPrice, isExpanded = false, onToggle }) => {
    const [currentPrice, setCurrentPrice] = useState<number | null>(initialPrice ?? null);
    const [loading, setLoading] = useState(false);
    const [earnings, setEarnings] = useState<{ date: string | null; days: number | null }>({ date: null, days: null });

    const isSpread = !!item.legs && item.legs.length > 0;

    const fetchPrice = async () => {
        setLoading(true);
        try {
            if (isSpread && item.legs) {
                const norm = (exp: string) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(exp?.trim()) ? exp.trim().split('-').map((p, i) => i ? String(Number(p)).padStart(2, '0') : p).join('-') : exp;
                const promises = item.legs.map(leg =>
                    fetch(`/api/option-price?ticker=${item.ticker}&expiration=${encodeURIComponent(norm(leg.expiration))}&strike=${leg.strike}&type=${leg.type}`)
                        .then(res => res.ok ? res.json() : { price: 0 })
                );
                const results = await Promise.all(promises);

                const shortIndex = item.legs.findIndex(l => l.side === 'short');
                const longIndex = item.legs.findIndex(l => l.side === 'long');

                const shortResult = shortIndex >= 0 ? results[shortIndex] : { price: 0 };
                const longResult = longIndex >= 0 ? results[longIndex] : { price: 0 };

                const shortPrice = shortResult.price ?? 0;
                const longPrice = longResult.price ?? 0;

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
                const expNorm = /^\d{4}-\d{1,2}-\d{1,2}$/.test(item.expiration?.trim()) ? item.expiration.trim().split('-').map((p, i) => i ? String(Number(p)).padStart(2, '0') : p).join('-') : item.expiration;
                const params = new URLSearchParams({ ticker: item.ticker, expiration: expNorm, strike: item.strike.toString(), type: item.type });
                const response = await fetch(`/api/option-price?${params}`);
                if (response.ok) {
                    const data = await response.json();
                    setCurrentPrice(data.price ?? 0);
                    if (data.cboeTimestamp && onDataUpdate) {
                        onDataUpdate(data.cboeTimestamp);
                    }
                }
            }
        } catch (e) { console.error(e); }
        setLoading(false);
    };

    useEffect(() => {
        // Skip individual fetch if bulk data was pre-loaded
        if (initialPrice == null) fetchPrice();
        const fetchEarnings = async () => {
            try {
                if (fetchEarningsForTicker) {
                    const result = await fetchEarningsForTicker(item.ticker);
                    if (result.daysUntil != null && result.daysUntil <= 14) {
                        setEarnings({ date: result.date, days: result.daysUntil });
                    }
                } else {
                    const response = await fetch(`/api/earnings?symbol=${item.ticker}`);
                    if (response.ok) {
                        const data = await response.json();
                        if (data.hasUpcomingEarnings && data.daysUntilEarnings <= 14) {
                            setEarnings({ date: data.earningsDate, days: data.daysUntilEarnings });
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        };
        fetchEarnings();
    }, []);

    const priceDiff = currentPrice !== null && item.ideal_entry ? ((currentPrice - item.ideal_entry) / item.ideal_entry * 100) : null;
    const isGoodEntry = priceDiff !== null && (item.type.includes('Credit') ? priceDiff >= -5 : priceDiff <= 5); // Credit: Higher is better (more credit), Debit: Lower is better
    const hasEarningsSoon = earnings.days !== null && earnings.days >= 0 && earnings.days <= 7;

    // DTE calculation
    const dte = item.expiration ? Math.ceil((new Date(item.expiration).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;

    return (
        <div className={`bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl overflow-hidden transition-all duration-300 ${isExpanded ? 'ring-1 ring-accent-green/50 shadow-lg shadow-green-900/10' : 'hover:border-[#444]'} ${isGoodEntry ? 'border-green-500/30' : ''}`}>
            {/* Card Header (Clickable) */}
            <div
                className="p-4 sm:p-5 cursor-pointer flex justify-between items-start gap-3"
                onClick={onToggle}
            >
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 sm:gap-3 mb-1 flex-wrap">
                        <span className="text-lg sm:text-xl font-bold">{item.ticker}</span>
                        {isSpread ? (
                            <div className="flex items-center gap-2">
                                <span className="badge badge-purple text-[10px] sm:text-xs">
                                    {item.type}
                                </span>
                                <span className="font-mono text-[10px] sm:text-xs text-[#8E8E93] bg-[#1C1C1E] px-1.5 py-0.5 rounded border border-[#2A2A2A]">
                                    {item.legs?.find(l => l.side === 'short')?.strike} / {item.legs?.find(l => l.side === 'long')?.strike}
                                </span>
                            </div>
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
                        {item.owner && (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${item.owner === 'Yuchen' ? 'bg-blue-500/15 text-blue-400 border-blue-500/30' : 'bg-pink-500/15 text-pink-400 border-pink-500/30'}`}>
                                {item.owner}
                            </span>
                        )}
                    </div>
                    <div className="text-text-secondary text-xs sm:text-sm mb-2 sm:mb-3">
                        {!isSpread && (
                            <span className="font-mono">${item.strike} · </span>
                        )}
                        <span>{formatDate(item.expiration)}</span>
                        {dte != null && (
                            <span className={`ml-1 font-mono ${dte <= 7 ? 'text-red-400' : dte <= 21 ? 'text-yellow-400' : 'text-gray-500'}`}>
                                ({dte}d)
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-3 sm:gap-4 text-xs sm:text-sm">
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
                                ? (priceDiff >= 0 ? 'text-accent-green' : 'text-accent-red')
                                : (priceDiff <= 0 ? 'text-accent-green' : 'text-accent-red')
                                }`}>
                                ({priceDiff >= 0 ? '+' : ''}{priceDiff.toFixed(1)}%)
                            </span>
                        )}
                        {item.target_price && (
                            <div className="hidden sm:block">
                                <span className="text-text-tertiary">TP: </span>
                                <span className="font-mono text-accent-green">{formatPrice(item.target_price)}</span>
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                    <div className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}>
                        <ChevronDown size={20} className="text-gray-500" />
                    </div>
                    <div className="flex flex-col gap-1.5 sm:gap-2">
                        <button
                            onClick={(e) => { e.stopPropagation(); onMoveToActive(item); }}
                            className="btn-primary px-4 sm:px-5 py-2 rounded-lg cursor-pointer text-sm"
                        >
                            Buy
                        </button>
                        <div className="flex gap-1.5 sm:gap-2">
                            <button
                                onClick={(e) => { e.stopPropagation(); fetchPrice(); }}
                                disabled={loading}
                                className="btn-secondary flex-1 py-2 rounded-lg text-sm flex items-center justify-center cursor-pointer"
                                aria-label="Refresh price"
                            >
                                {loading ? '...' : <RefreshCw size={15} />}
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
                                className="btn-secondary px-2.5 py-2 rounded-lg text-sm flex items-center justify-center cursor-pointer hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/30 transition-colors"
                                aria-label="Delete from watchlist"
                            >
                                <Trash2 size={15} />
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Expanded Details */}
            {isExpanded && (
                <div className="px-4 sm:px-5 pb-4 sm:pb-5 border-t border-[#3A3A3C] bg-black/20">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4">
                        {/* Exit Condition */}
                        {item.stop_reason && (
                            <div className="flex items-start gap-2 p-3 rounded-lg bg-[#252528] border border-[#3A3A3C]">
                                <ShieldAlert size={14} className="text-red-400 shrink-0 mt-0.5" />
                                <div>
                                    <div className="text-[10px] text-gray-500 uppercase font-bold mb-0.5">Exit If</div>
                                    <div className="text-xs sm:text-sm text-gray-300">{item.stop_reason}</div>
                                </div>
                            </div>
                        )}

                        {/* Target Price */}
                        {item.target_price && (
                            <div className="flex items-start gap-2 p-3 rounded-lg bg-[#252528] border border-[#3A3A3C]">
                                <Target size={14} className="text-green-400 shrink-0 mt-0.5" />
                                <div>
                                    <div className="text-[10px] text-gray-500 uppercase font-bold mb-0.5">Target Price</div>
                                    <div className="text-sm font-mono text-accent-green font-bold">{formatPrice(item.target_price)}</div>
                                    {currentPrice != null && item.target_price && (
                                        <div className="text-[10px] text-gray-500 font-mono mt-0.5">
                                            {item.type.includes('Credit')
                                                ? `${((1 - currentPrice / item.target_price) * 100).toFixed(0)}% to target`
                                                : `${((item.target_price / currentPrice - 1) * 100).toFixed(0)}% upside`
                                            }
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Tech Score */}
                        {item.tech_score != null && (
                            <div className="flex items-start gap-2 p-3 rounded-lg bg-[#252528] border border-[#3A3A3C]">
                                <TrendingUp size={14} className="text-blue-400 shrink-0 mt-0.5" />
                                <div>
                                    <div className="text-[10px] text-gray-500 uppercase font-bold mb-0.5">Tech Score</div>
                                    <div className={`text-sm font-mono font-bold ${item.tech_score >= 70 ? 'text-green-400' : item.tech_score >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                                        {item.tech_score}
                                        {item.tech_score_source && (
                                            <span className="text-[10px] text-gray-500 font-normal ml-1">({item.tech_score_source})</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Notes */}
                        {item.notes && (
                            <div className="flex items-start gap-2 p-3 rounded-lg bg-[#252528] border border-[#3A3A3C] sm:col-span-2">
                                <StickyNote size={14} className="text-yellow-400 shrink-0 mt-0.5" />
                                <div>
                                    <div className="text-[10px] text-gray-500 uppercase font-bold mb-0.5">Notes</div>
                                    <div className="text-xs sm:text-sm text-gray-300 whitespace-pre-wrap">{item.notes}</div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Spread Leg Details */}
                    {isSpread && item.legs && (
                        <div className="mt-3 grid grid-cols-2 gap-3">
                            {item.legs.map((leg, i) => (
                                <div key={i} className="p-3 rounded-lg bg-[#252528] border border-[#3A3A3C]">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${leg.side === 'short' ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'}`}>
                                            {leg.side.toUpperCase()}
                                        </span>
                                        <span className="text-xs text-gray-400">{leg.type}</span>
                                    </div>
                                    <div className="text-sm font-mono font-bold text-white">${leg.strike}</div>
                                    <div className="text-[10px] text-gray-500 font-mono">{formatDate(leg.expiration)}</div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Timestamps */}
                    <div className="mt-3 flex items-center gap-4 text-[10px] text-gray-600 font-mono">
                        {item.created_at && <span>Added {formatDate(item.created_at)}</span>}
                        {item.score_updated_at && <span>Score updated {formatDate(item.score_updated_at)}</span>}
                    </div>
                </div>
            )}
        </div>
    );
};
