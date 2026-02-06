import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Calendar, ChevronDown, Trash2 } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { Position, Transaction, LiveData, GreeksHistory } from '../lib/types';
import { GreeksHistoryChart } from './GreeksHistoryChart';
import { saveGreeksHistory, fetchGreeksHistory } from '../lib/greeksHistory';
import { formatDate, formatCurrency, formatPercent, daysUntil, formatPrice, CONTRACT_MULTIPLIER } from '../lib/utils';
import { calculateCreditSpreadScore, calculateDebitSpreadScore } from '../lib/scoring';

interface PositionCardProps {
    position: Position;
    transactions: Transaction[];
    onAction: (id: string, action: any) => Promise<void>;
    onUpdateScore: (id: string, score: number) => Promise<void>; // Kept for interface compatibility
    onUpdatePrice: (id: string, price: number) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    refreshTrigger?: number;
    index?: number;
}

export const PositionCard: React.FC<PositionCardProps> = ({ position, transactions, onAction, onUpdateScore, onUpdatePrice, onDelete, refreshTrigger = 0, index = 0 }) => {
    const [loading, setLoading] = useState(false);
    const [liveData, setLiveData] = useState<LiveData>({ delta: undefined, iv: undefined, gamma: undefined, theta: undefined, vega: undefined, score: undefined });
    const [earnings, setEarnings] = useState<{ loading: boolean; date: string | null; days: number | null }>({ loading: true, date: null, days: null });
    const [actionMode, setActionMode] = useState<'Add' | 'TakeProfit' | 'Close' | null>(null);
    const [actionQty, setActionQty] = useState(1);
    const [actionPrice, setActionPrice] = useState('');
    const [isEditingScore, setIsEditingScore] = useState(false);
    const [scoreInput, setScoreInput] = useState('');
    const [isExpanded, setIsExpanded] = useState(false);
    const [historyData, setHistoryData] = useState<GreeksHistory[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    const isSpread = !!position.legs && position.legs.length > 0;
    const isCreditStrategy = position.type.includes('Credit') || position.type.includes('Short');

    // Fetch Earnings
    useEffect(() => {
        const fetchEarnings = async () => {
            try {
                const response = await fetch(`/api/earnings?symbol=${position.ticker}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.hasUpcomingEarnings && data.daysUntilEarnings <= 14) {
                        setEarnings({ loading: false, date: data.earningsDate, days: data.daysUntilEarnings });
                    } else {
                        setEarnings({ loading: false, date: null, days: null });
                    }
                } else {
                    setEarnings({ loading: false, date: null, days: null });
                }
            } catch (e) {
                setEarnings({ loading: false, date: null, days: null });
            }
        };
        fetchEarnings();
    }, [position.ticker]);

    // Fetch Greeks and price
    const fetchGreeksAndPrice = useCallback(async () => {
        setLoading(true);
        try {
            if (isSpread && position.legs) {
                const promises = position.legs.map(async (leg) => {
                    const params = new URLSearchParams({ ticker: position.ticker, expiration: leg.expiration, strike: leg.strike.toString(), type: leg.type });
                    const res = await fetch(`/api/option-price?${params}`);
                    return res.ok ? await res.json() : null;
                });
                const results = await Promise.all(promises);

                // Prevent partial data update (wiping Greeks) if some requests failed
                if (results.some(r => r === null)) {
                    setLoading(false);
                    return;
                }

                let netDelta = 0, netGamma = 0, netTheta = 0, netVega = 0;
                let netIv = 0;
                let netPrice = 0;
                let validLegs = 0;

                const shortIndex = position.legs.findIndex(l => l.side === 'short');
                const longIndex = position.legs.findIndex(l => l.side === 'long');

                // Ensure we have data for both legs
                const shortData = shortIndex >= 0 ? results[shortIndex] : null;
                const longData = longIndex >= 0 ? results[longIndex] : null;

                if (shortData && longData) {
                    // 1. Valuation Formula: Cost to Close = Short Price - Long Price
                    // Always use positive prices from API
                    const shortPrice = Math.abs(shortData.price || 0);
                    const longPrice = Math.abs(longData.price || 0);

                    if (isCreditStrategy) {
                        // For Credit Spread: Cost to Close = Short - Long
                        // e.g. Sold @ 10, Bought @ 9.2. Net = 0.8.
                        netPrice = shortPrice - longPrice;
                    } else {
                        // For Debit Spread: Liquidation Value = Long - Short (usually) or just Spread Value
                        // Actually standard spread value is always Long - Short? 
                        // No, Debit Call Spread: Long 660 ($10), Short 665 ($8). Value = $2.
                        // So always Long - Short for "Value".
                        // Wait, for Credit Spread, "Value" (Cost to Close) is Short - Long.
                        // Let's stick to the User's Formula for Credit: Spread = Short - Long.
                        netPrice = longPrice - shortPrice; // Default for debit
                    }
                }

                // Greeks Calculation
                // Net Delta = ShortDelta * -1 + LongDelta
                results.forEach((data, i) => {
                    if (!data) return;
                    validLegs++;
                    const side = position.legs![i].side;
                    // Multiplier: Short = -1, Long = 1
                    const mult = side === 'short' ? -1 : 1;

                    netDelta += (data.delta || 0) * mult;
                    netGamma += (data.gamma || 0) * mult;
                    netTheta += (data.theta || 0) * mult; // Short accumulates positive theta
                    netVega += (data.vega || 0) * mult;   // Short benefits from IV crush
                    netIv += (data.iv || 0);
                });
                netIv = validLegs > 0 ? netIv / validLegs : 0;

                // Fix: If Credit Strategy, the 'netPrice' calculated above is 'Cost to Close' (positive).
                // If Debit Strategy, 'netPrice' is 'Liquidation Value' (positive).
                // However, my previous logic might have mixed signs.
                if (isCreditStrategy && shortData && longData) {
                    netPrice = Math.abs(shortData.price) - Math.abs(longData.price);
                } else if (!isCreditStrategy && shortData && longData) {
                    netPrice = Math.abs(longData.price) - Math.abs(shortData.price);
                }

                // Determine effective score
                let compositeScore = undefined;
                const underlyingPrice = shortData?.underlyingPrice || longData?.underlyingPrice || 0;

                if (isCreditStrategy && shortData && longData && underlyingPrice > 0) {
                    // Credit Spread Score
                    const shortLeg = position.legs?.find(l => l.side === 'short');
                    const longLeg = position.legs?.find(l => l.side === 'long');
                    const shortStrike = shortLeg ? shortLeg.strike : 0;
                    const longStrike = longLeg ? longLeg.strike : 0;

                    const width = Math.abs(Math.abs(shortStrike) - Math.abs(longStrike));
                    // Current Credit (Cost to Close) effectively represents the premium a NEW seller would get roughly
                    const currentCredit = Math.abs(shortData.price) - Math.abs(longData.price);

                    compositeScore = calculateCreditSpreadScore({
                        credit: currentCredit,
                        width: width,
                        shortDelta: shortData.delta || 0,
                        shortStrike: shortStrike,
                        currentPrice: underlyingPrice
                    });
                } else if (!isCreditStrategy && shortData && longData && underlyingPrice > 0) {
                    // Debit Spread Score
                    const shortLeg = position.legs?.find(l => l.side === 'short');
                    const longLeg = position.legs?.find(l => l.side === 'long');
                    const shortStrike = shortLeg ? shortLeg.strike : 0;
                    const longStrike = longLeg ? longLeg.strike : 0;

                    const width = Math.abs(Math.abs(shortStrike) - Math.abs(longStrike));
                    const currentDebit = Math.abs(longData.price) - Math.abs(shortData.price);

                    compositeScore = calculateDebitSpreadScore({
                        debit: currentDebit,
                        width: width,
                        longDelta: longData.delta || 0,
                        longPrice: Math.abs(longData.price),
                        currentPrice: underlyingPrice
                    });
                } else if (isCreditStrategy && shortData) {
                    compositeScore = shortData.score;
                } else if (!isCreditStrategy && longData) {
                    compositeScore = longData.score;
                }

                setLiveData({
                    delta: netDelta,
                    gamma: netGamma,
                    theta: netTheta,
                    vega: netVega,
                    iv: netIv,
                    price: netPrice,
                    score: compositeScore
                });

                if (netDelta !== 0) saveGreeksHistory(position.id, netIv, netDelta);

                // IMPORTANT: For Credit Spreads, this 'netPrice' is Cost to Close.
                // For Debit Spreads, it is Liquidation Value.
                if (results.some(r => r !== null)) {
                    // Optimized: Only update if price changed significantly to prevent infinite loops
                    if (Math.abs((position.current_price || 0) - netPrice) > 0.01) {
                        await onUpdatePrice(position.id, netPrice);
                    }
                }

            } else {
                // Single Leg Logic
                const params = new URLSearchParams({ ticker: position.ticker, expiration: position.expiration, strike: position.strike.toString(), type: position.type });
                const response = await fetch(`/api/option-price?${params}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.price) {
                        await onUpdatePrice(position.id, data.price);
                        setLiveData({
                            delta: data.delta,
                            iv: data.iv,
                            gamma: data.gamma,
                            theta: data.theta,
                            vega: data.vega,
                            score: data.score,
                            isDayTrade: data.metrics?.isDayTrade,
                            ivRatio: data.metrics?.ivRatio
                        });
                        saveGreeksHistory(position.id, data.iv, data.delta);
                    }
                }
            }
        } catch (e) { console.error(e); }
        setLoading(false);
    }, [position.id, position.ticker, position.expiration, position.strike, position.type, isSpread, isCreditStrategy, position.legs, onUpdatePrice]);

    useEffect(() => {
        fetchGreeksAndPrice();
    }, [fetchGreeksAndPrice]);

    // Global Refresh Trigger
    useEffect(() => {
        if (refreshTrigger > 0) {
            const delay = index * 200;
            setTimeout(() => {
                fetchGreeksAndPrice();
            }, delay);
        }
    }, [refreshTrigger, index, fetchGreeksAndPrice]);

    // Fetch history when expanded
    useEffect(() => {
        if (isExpanded && historyData.length === 0) {
            setHistoryLoading(true);
            fetchGreeksHistory(position.id).then(data => {
                setHistoryData(data);
                setHistoryLoading(false);
            });
        }
    }, [isExpanded, position.id, historyData.length]);

    const positionTxns = transactions.filter(t => t.position_id === position.id);

    let totalQtyBought = 0, totalCostBasis = 0, totalQtySold = 0;
    positionTxns.forEach(t => {
        const qty = t.quantity;
        // Logic: Usually we buy positive qty.
        // For credit spreads, if we enter with positive Qty meaning "1 Lot",
        // Cost Basis should be Credit Received.
        // Let's assume input was positive Quantity and positive Price.
        const price = t.price * CONTRACT_MULTIPLIER;
        if (qty > 0) { totalQtyBought += qty; totalCostBasis += qty * price; }
        else { totalQtySold += Math.abs(qty); }
    });

    const totalQty = totalQtyBought - totalQtySold;
    const avgCostPerContract = totalQtyBought > 0 ? totalCostBasis / totalQtyBought : 0;
    const firstBuy = positionTxns.find(t => t.quantity > 0);
    const entryPrice = firstBuy ? Math.abs(firstBuy.price) : 0;

    const hasTakenProfit = positionTxns.some(t => t.type === 'Take Profit');
    // Todo: Adjust for credit spreads
    const currentStopLoss = hasTakenProfit ? entryPrice * 0.75 : entryPrice * 0.5;

    const currentPrice = liveData.price !== undefined ? liveData.price : (position.current_price || 0);

    // P&L Calculation Logic
    let unrealizedPnL = 0;
    let unrealizedPnLPct = 0;

    if (totalQty > 0 && currentPrice) {
        if (isCreditStrategy) {
            // Credit Spread P&L = (Entry Credit - Current Cost to Close) * Qty * 100
            // Example: Entry $1.01, Current $0.80. PnL = (1.01 - 0.80) * 100 = $21.5
            unrealizedPnL = (entryPrice - currentPrice) * totalQty * CONTRACT_MULTIPLIER;
            // ROI based on Credit Received (or margin? User asked for ROI based on credit)
            // User formula: roi = (pnlPerShare / entryCredit) * 100
            unrealizedPnLPct = entryPrice > 0 ? (unrealizedPnL / (entryPrice * totalQty * CONTRACT_MULTIPLIER)) * 100 : 0;
        } else {
            const totalValue = totalQty * currentPrice * CONTRACT_MULTIPLIER;
            const totalCost = totalQty * avgCostPerContract;
            // Profit = Value - Cost
            unrealizedPnL = totalValue - totalCost;
            unrealizedPnLPct = (totalCost > 0) ? (unrealizedPnL / totalCost) * 100 : 0;
        }
    }

    const targetPrice = isCreditStrategy ? entryPrice * 0.5 : entryPrice * 1.25; // 50% max profit for credit, 25% for debit

    const daysToExp = daysUntil(position.expiration);
    const currentScore = position.current_score || position.entry_score;

    // Alert logic
    let alertLevel: 'none' | 'danger' | 'warning' = 'none';
    const alerts: string[] = [];
    if (currentScore < 60) { alerts.push('Low Score'); alertLevel = 'danger'; }
    // Stop check
    if (isCreditStrategy) {
        if (currentPrice && currentPrice >= entryPrice * 2) { alerts.push('Hit Stop'); alertLevel = 'danger'; } // 2x credit stop loss
    } else {
        if (currentPrice && currentPrice <= currentStopLoss) { alerts.push('Hit Stop'); alertLevel = 'danger'; }
    }

    if (unrealizedPnLPct <= -50) { alerts.push('Heavy Loss'); alertLevel = 'danger'; }
    if (alertLevel !== 'danger') {
        if (currentScore < 70) { alerts.push('Score Warning'); alertLevel = 'warning'; }
        if (daysToExp <= 7 && daysToExp > 0) { alerts.push(`${daysToExp}d left`); alertLevel = 'warning'; }
    }

    const earningsWarning = earnings.days !== null && earnings.days >= 0 && earnings.days <= 7;
    const earningsImminent = earnings.days !== null && earnings.days >= 0 && earnings.days <= 3;

    // Card style
    let cardClass = 'card';
    if (alertLevel === 'danger') cardClass = 'card-danger';
    else if (earningsImminent) cardClass = 'card-earnings';
    else if (alertLevel === 'warning') cardClass = 'card-warning';
    else if (earningsWarning) cardClass = 'card-earnings-soon';

    const pnlColor = unrealizedPnL >= 0 ? 'text-accent-green' : 'text-accent-red';

    const handleAction = async (type: 'Size Up' | 'Take Profit' | 'Close') => {
        if (!actionPrice) return;
        setLoading(true);
        const qty = ['Size Down', 'Take Profit', 'Close'].includes(type) ? -Math.abs(actionQty) : Math.abs(actionQty);
        await onAction(position.id, {
            type,
            quantity: type === 'Close' ? -totalQty : qty,
            price: parseFloat(actionPrice) // Input price is always positive absolute price
        });
        setLoading(false);
        setActionMode(null);
        setActionPrice('');
        setActionQty(1);
    };

    const handleScoreSave = async () => {
        const newScore = parseInt(scoreInput);
        if (!isNaN(newScore)) {
            await onUpdateScore(position.id, newScore);
            setIsEditingScore(false);
        }
    };

    return (
        <div className={`${cardClass} p-5 fade-in`}>
            {/* Header */}
            <div className="flex justify-between items-start mb-4">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <span className="text-2xl font-bold">{position.ticker}</span>
                        {isSpread ? (
                            <>
                                <span className={`badge ${isCreditStrategy ? 'badge-green' : 'badge-blue'}`}>
                                    {isCreditStrategy ? 'Credit' : 'Debit'}
                                </span>
                                <span className="badge badge-purple">Spread</span>
                            </>
                        ) : (
                            <span className={`badge ${position.type === 'Call' ? 'badge-green' : 'badge-red'}`}>
                                {position.type}
                            </span>
                        )}
                    </div>
                    <div className="text-text-secondary">
                        {isSpread ? (
                            <div className="flex items-center gap-2 mt-1 mb-1">
                                <span className="flex items-center gap-1.5 text-accent-red bg-accent-red/10 px-2 py-0.5 rounded text-xs font-mono border border-accent-red/20" title="Short Leg">
                                    <span className="font-bold">-</span>
                                    {position.legs?.find(l => l.side === 'short')?.strike}
                                    <span className="opacity-70">{position.legs?.[0]?.type?.charAt(0)}</span>
                                </span>
                                <span className="text-text-tertiary text-xs">/</span>
                                <span className="flex items-center gap-1.5 text-accent-green bg-accent-green/10 px-2 py-0.5 rounded text-xs font-mono border border-accent-green/20" title="Long Leg">
                                    <span className="font-bold">+</span>
                                    {position.legs?.find(l => l.side === 'long')?.strike}
                                    <span className="opacity-70">{position.legs?.[0]?.type?.charAt(0)}</span>
                                </span>
                            </div>
                        ) : (
                            <span className="font-mono">${position.strike}</span>
                        )}
                        {!isSpread && <span className="mx-2">·</span>}
                        <span>{formatDate(position.expiration)}</span>
                        <span className="mx-2">·</span>
                        <span>{totalQty} contract{totalQty !== 1 ? 's' : ''}</span>
                        {liveData.ivRatio !== undefined && (
                            <span className="ml-3 px-2 py-0.5 rounded text-xs font-mono font-medium bg-bg-tertiary border border-border-default/50 text-text-secondary" title="IV Ratio">
                                IVR: <span className={liveData.ivRatio > 1.05 ? 'text-accent-green' : liveData.ivRatio < 0.95 ? 'text-accent-red' : 'text-text-primary'}>
                                    {liveData.ivRatio.toFixed(2)}
                                </span>
                            </span>
                        )}
                    </div>
                </div>
                <div className="text-right">
                    <div className={`big-number ${pnlColor}`}>
                        {formatPercent(unrealizedPnLPct)}
                    </div>
                    <div className={`text-sm font-mono ${pnlColor}`}>
                        {unrealizedPnL >= 0 ? '+' : ''}{formatCurrency(unrealizedPnL)}
                    </div>
                </div>
            </div>

            {/* Earnings Banner */}
            {earningsWarning && (
                <div className={`mb-4 p-3 rounded-xl flex items-center justify-between ${earningsImminent ? 'bg-bg-secondary border border-purple-500/20' : 'bg-bg-secondary border border-blue-500/20'}`}>
                    <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${earningsImminent ? 'bg-purple-500/10' : 'bg-blue-500/10'}`}>
                            <Calendar size={18} className={earningsImminent ? 'text-purple-300/70' : 'text-blue-300/70'} />
                        </div>
                        <div>
                            <div className={`font-semibold ${earningsImminent ? 'text-text-primary' : 'text-text-primary'}`}>
                                {earnings.days === 0 ? 'Earnings TODAY' : earnings.days === 1 ? 'Earnings TOMORROW' : `Earnings in ${earnings.days} days`}
                            </div>
                            <div className="text-sm text-text-secondary">
                                {formatDate(earnings.date)} · Consider position sizing
                            </div>
                        </div>
                    </div>
                    {earningsImminent && (
                        <span className="px-3 py-1 bg-purple-500/30 text-purple-300 rounded-lg text-sm font-semibold animate-pulse">
                            ACTION NEEDED
                        </span>
                    )}
                </div>
            )}

            {/* Alerts */}
            {alerts.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4">
                    {alerts.map((a, i) => (
                        <span key={i} className={`badge ${alertLevel === 'danger' ? 'badge-red' : 'badge-yellow'}`}>
                            {a}
                        </span>
                    ))}
                </div>
            )}

            {/* Metrics Grid */}
            <div className="flex flex-col gap-4 mb-4 py-4 border-y border-border-default">
                {/* Row 1: Trade Management & Technicals */}
                <div className="grid grid-cols-2 xs:grid-cols-3 sm:grid-cols-6 gap-4">
                    {/* Entry */}
                    <div>
                        <div className="mb-1 flex items-center h-5">
                            <Tooltip label="Entry" explanation="Original entry price/credit per contract." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value">{formatPrice(entryPrice)}</div>
                    </div>
                    {/* Avg */}
                    <div>
                        <div className="mb-1 flex items-center h-5">
                            <Tooltip label="Avg" explanation="Average Cost Basis." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value">{formatPrice(avgCostPerContract / CONTRACT_MULTIPLIER)}</div>
                    </div>
                    {/* Target */}
                    <div>
                        <div className="mb-1 flex items-center h-5">
                            <Tooltip label="Target" explanation="Profit Target (1.25x or 50% max profit)." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value text-accent-green">{formatPrice(targetPrice)}</div>
                    </div>
                    {/* Current */}
                    <div>
                        <div className="mb-1 flex items-center h-5">
                            <Tooltip label="Current" explanation={isCreditStrategy ? "Cost to Close" : "Liquidation Value"} className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value text-text-primary">{currentPrice ? formatPrice(currentPrice) : '—'}</div>
                    </div>
                    {/* Stop */}
                    <div>
                        <div className="mb-1 flex items-center h-5">
                            <Tooltip label="Stop" explanation="Stop Loss Level." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value text-accent-red">{formatPrice(currentStopLoss)}</div>
                    </div>
                    {/* Tech Score */}
                    <div>
                        <div className="mb-1 flex items-center gap-1 h-5">
                            <Tooltip label="Tech Score" explanation="Manual Technical Analysis Score (0-100)." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                            <button
                                onClick={() => { setIsEditingScore(true); setScoreInput(currentScore ? currentScore.toString() : ''); }}
                                className="text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
                                aria-label="Edit score"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                            </button>
                        </div>
                        {isEditingScore ? (
                            <div className="flex items-center gap-1">
                                <input
                                    type="number"
                                    value={scoreInput}
                                    onChange={e => setScoreInput(e.target.value)}
                                    className="w-12 px-1 py-0.5 text-sm bg-bg-secondary rounded border border-border-default font-mono"
                                    autoFocus
                                />
                                <button onClick={handleScoreSave} className="text-accent-green hover:bg-accent-green/10 p-0.5 rounded cursor-pointer">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                </button>
                                <button onClick={() => setIsEditingScore(false)} className="text-accent-red hover:bg-accent-red/10 p-0.5 rounded cursor-pointer">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                </button>
                            </div>
                        ) : (
                            <div className="flex flex-col">
                                <span className={`metric-value ${currentScore ? (currentScore >= 70 ? 'text-accent-green' : currentScore >= 60 ? 'text-accent-yellow' : 'text-accent-red') : 'text-text-primary'}`}>
                                    {currentScore || '—'}
                                </span>
                                {position.current_score && position.current_score !== position.entry_score && (
                                    <span className="text-xs text-text-tertiary flex items-center">
                                        from {position.entry_score}
                                        {position.current_score < position.entry_score && <span className="ml-1 text-accent-red">↓</span>}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Row 2: Mechanics & Option Score */}
                <div className="grid grid-cols-2 xs:grid-cols-3 sm:grid-cols-6 gap-4 pt-4 border-t border-border-light/50">
                    <div>
                        <div className="mb-1">
                            <Tooltip label="Delta" explanation="Net Position Delta." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value text-text-primary">
                            {liveData.delta !== undefined ? liveData.delta.toFixed(2) : '—'}
                        </div>
                    </div>
                    <div>
                        <div className="mb-1">
                            <Tooltip label="Gamma" explanation="Rate of change of Delta." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value text-text-primary">
                            {liveData.gamma !== undefined ? liveData.gamma.toFixed(3) : '—'}
                        </div>
                    </div>
                    <div>
                        <div className="mb-1">
                            <Tooltip label="Theta" explanation="Time decay." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value text-text-primary">
                            {liveData.theta !== undefined ? liveData.theta.toFixed(3) : '—'}
                        </div>
                    </div>
                    <div>
                        <div className="mb-1">
                            <Tooltip label="Vega" explanation="Sensitivity to changes in Implied Volatility." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value text-text-primary">
                            {liveData.vega !== undefined ? liveData.vega.toFixed(3) : '—'}
                        </div>
                    </div>
                    <div>
                        <div className="mb-1">
                            <Tooltip label="IV" explanation="Avg Implied Volatility." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value text-text-primary">
                            {liveData.iv !== undefined ? (liveData.iv * 100).toFixed(1) + '%' : '—'}
                        </div>
                    </div>

                    <div>
                        <div className="mb-1">
                            <Tooltip label="Opt Score" explanation="Calculated Option Quality." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="flex flex-col">
                            <div className={`metric-value font-bold ${liveData.score === undefined ? 'text-text-tertiary' :
                                liveData.score >= 70 ? 'text-accent-green' :
                                    liveData.score >= 50 ? 'text-accent-yellow' : 'text-accent-red'
                                }`}>
                                {liveData.score !== undefined ? liveData.score : '—'}
                            </div>
                            {(liveData.score && liveData.isDayTrade) && (
                                <span className="mt-0.5 px-1 pb-0.5 text-[8px] font-bold uppercase tracking-wider text-purple-300 bg-purple-500/10 rounded w-fit">
                                    Day Trade
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Setup info */}
            <div className="text-sm text-text-secondary mb-4 flex flex-wrap gap-x-2 gap-y-1">
                <span><span className="text-text-tertiary">Setup:</span> {position.setup}</span>
                {position.stop_reason && (
                    <span className="flex items-center gap-2 min-w-0">
                        <span className="text-text-tertiary">·</span>
                        <span className="text-text-tertiary shrink-0">Exit if:</span>
                        <span className="truncate max-w-[200px] sm:max-w-[300px]" title={position.stop_reason}>{position.stop_reason}</span>
                    </span>
                )}
            </div>

            {/* Expandable Greeks History */}
            <div className="mb-4">
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="w-full flex items-center justify-between py-2 px-3 rounded-lg bg-bg-secondary/50 hover:bg-bg-secondary transition-colors text-sm text-text-secondary cursor-pointer"
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? 'Collapse IV & Delta history' : 'Expand IV & Delta history'}
                >
                    <span>IV & Delta History</span>
                    <ChevronDown
                        size={16}
                        className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                    />
                </button>
                {
                    isExpanded && (
                        <div className="mt-3 p-3 rounded-lg bg-bg-secondary/30 border border-border-default">
                            <GreeksHistoryChart data={historyData} loading={historyLoading} />
                        </div>
                    )
                }
            </div>

            {/* Action Buttons */}
            {
                !actionMode ? (
                    <div className="flex gap-2">
                        <button onClick={fetchGreeksAndPrice} disabled={loading} className="action-btn btn-secondary flex items-center justify-center gap-2 cursor-pointer" aria-label="Refresh price">
                            {loading ? <div className="spinner w-4 h-4" /> : <RefreshCw size={16} />}
                            <span className="hidden sm:inline">Refresh</span>
                        </button>
                        <button onClick={() => setActionMode('Add')} className="action-btn btn-secondary">+ Add</button>
                        <button onClick={() => setActionMode('TakeProfit')} className="action-btn btn-secondary">Profit</button>
                        <button onClick={() => setActionMode('Close')} className="action-btn btn-secondary text-text-secondary hover:text-accent-red hover:bg-accent-red/10">Close</button>
                        <button onClick={() => onDelete(position.id)} className="action-btn btn-secondary text-text-tertiary hover:text-accent-red hover:bg-accent-red/10 px-3" aria-label="Delete Position">
                            <Trash2 size={16} />
                        </button>
                    </div>
                ) : (
                    <div className="card-elevated p-4 space-y-3">
                        <div className="text-sm font-medium text-text-secondary">
                            {actionMode === 'Add' ? 'Add to Position' : actionMode === 'TakeProfit' ? 'Take Profit' : 'Close Position'}
                        </div>
                        <div className="flex gap-3">
                            {actionMode !== 'Close' && (
                                <input type="number" min="1" value={actionQty} onChange={e => setActionQty(parseInt(e.target.value) || 1)}
                                    placeholder="Qty" className="w-24 px-4 py-3 rounded-xl font-mono" />
                            )}
                            <input type="number" step="0.01" value={actionPrice} onChange={e => setActionPrice(e.target.value)}
                                placeholder="Price" className="flex-1 px-4 py-3 rounded-xl font-mono" autoFocus />
                        </div>
                        <div className="flex gap-2">
                            <button onClick={() => setActionMode(null)} className="flex-1 py-3 btn-secondary rounded-xl">Cancel</button>
                            <button onClick={() => handleAction(actionMode === 'Add' ? 'Size Up' : actionMode === 'TakeProfit' ? 'Take Profit' : 'Close')}
                                disabled={!actionPrice || loading} className="flex-1 py-3 btn-primary rounded-xl">
                                {loading ? '...' : 'Confirm'}
                            </button>
                        </div>
                    </div>
                )
            }
        </div >
    );
};
