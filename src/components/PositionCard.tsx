import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronDown, Trash2, TrendingUp, Target, AlertOctagon, Clock, ArrowRightLeft } from 'lucide-react';

import { Position, Transaction, LiveData, GreeksHistory } from '../lib/types';
import { GreeksHistoryChart } from './GreeksHistoryChart';
import { saveGreeksHistory, fetchGreeksHistory } from '../lib/greeksHistory';
import { formatDate, formatCurrency, formatPercent, daysUntil, formatPrice, CONTRACT_MULTIPLIER } from '../lib/utils';
import { calculateCreditSpreadScore, calculateDebitSpreadScore, calculateSingleLOQ } from '../lib/scoring';

interface PositionCardProps {
    position: Position;
    transactions: Transaction[];
    onAction: (id: string, action: any) => Promise<void>;
    onUpdateScore: (id: string, score: number) => Promise<void>;
    onUpdatePrice: (id: string, price: number) => Promise<void>;
    onUpdateTarget: (id: string, target: number) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    onDataUpdate?: (timestamp: string) => void;
    index?: number;
    onRollClick?: (qty: number) => void;
    preFetchedData?: any[];
}

export const PositionCard: React.FC<PositionCardProps> = ({ position, transactions, onAction, onUpdateScore, onUpdatePrice, onUpdateTarget, onDelete, onDataUpdate, index = 0, onRollClick, preFetchedData }) => {

    const [loading, setLoading] = useState(false);
    const [liveData, setLiveData] = useState<LiveData>({ delta: undefined, iv: undefined, gamma: undefined, theta: undefined, vega: undefined, score: undefined });
    const [earnings, setEarnings] = useState<{ loading: boolean; date: string | null; days: number | null }>({ loading: true, date: null, days: null });
    const [actionMode, setActionMode] = useState<'Add' | 'TakeProfit' | 'Close' | null>(null);
    const [actionQty, setActionQty] = useState(1);
    const [actionPrice, setActionPrice] = useState('');
    const [isEditingScore, setIsEditingScore] = useState(false);
    const [scoreInput, setScoreInput] = useState('');
    const [isEditingTarget, setIsEditingTarget] = useState(false);
    const [targetInput, setTargetInput] = useState('');
    const [isExpanded, setIsExpanded] = useState(false);
    const [historyData, setHistoryData] = useState<GreeksHistory[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    const isSpread = !!position.legs && position.legs.length > 0;
    const isCreditStrategy = position.type.includes('Credit') || position.type.includes('Short');

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

    const processOptionData = useCallback(async (results: any[]) => {
        if (results.some(r => r === null || r.error)) return;

        let netDelta = 0, netGamma = 0, netTheta = 0, netVega = 0;
        let netIv = 0;
        let netPrice = 0;
        let validLegs = 0;
        let compositeScore = undefined;
        let netIvRatio = undefined;
        let isDayTrade = false;
        let underlyingPrice = 0;

        if (isSpread && position.legs) {
            const shortIndex = position.legs.findIndex(l => l.side === 'short');
            const longIndex = position.legs.findIndex(l => l.side === 'long');
            const shortData = shortIndex >= 0 ? results[shortIndex] : null;
            const longData = longIndex >= 0 ? results[longIndex] : null;

            underlyingPrice = shortData?.underlyingPrice || longData?.underlyingPrice || 0;

            results.forEach((data, i) => {
                if (!data) return;
                validLegs++;
                const side = position.legs![i].side;
                const mult = side === 'short' ? -1 : 1;
                netDelta += (data.delta || 0) * mult;
                netGamma += (data.gamma || 0) * mult;
                netTheta += (data.theta || 0) * mult;
                netVega += (data.vega || 0) * mult;
                netIv += (data.iv || 0);
            });
            netIv = validLegs > 0 ? netIv / validLegs : 0;

            if (shortData && longData) {
                const shortPrice = Math.abs(shortData.price || 0);
                const longPrice = Math.abs(longData.price || 0);

                if (isCreditStrategy) {
                    // Conservative Mark: Cost to Close (Short Ask - Long Bid)
                    const shortAsk = shortData.ask || shortPrice;
                    const longBid = longData.bid || longPrice;
                    netPrice = shortAsk - longBid;
                } else {
                    // Debit Spread: Sell to Close (Long Bid - Short Ask)
                    const longBid = longData.bid || longPrice;
                    const shortAsk = shortData.ask || shortPrice;
                    netPrice = longBid - shortAsk;
                }
            }

            if (isCreditStrategy && shortData && longData && underlyingPrice > 0) {
                const shortLeg = position.legs.find(l => l.side === 'short')!;
                const longLeg = position.legs.find(l => l.side === 'long')!;
                const width = Math.abs(Math.abs(shortLeg.strike) - Math.abs(longLeg.strike));
                compositeScore = calculateCreditSpreadScore({
                    credit: netPrice,
                    width,
                    shortDelta: shortData.delta || 0,
                    shortStrike: shortLeg.strike,
                    currentPrice: underlyingPrice
                });
            } else if (!isCreditStrategy && shortData && longData && underlyingPrice > 0) {
                const shortLeg = position.legs.find(l => l.side === 'short')!;
                const longLeg = position.legs.find(l => l.side === 'long')!;
                const width = Math.abs(Math.abs(shortLeg.strike) - Math.abs(longLeg.strike));
                compositeScore = calculateDebitSpreadScore({
                    debit: netPrice,
                    width,
                    longDelta: longData.delta || 0,
                    longPrice: Math.abs(longData.price),
                    currentPrice: underlyingPrice
                });
            }
        } else {
            const data = results[0];
            if (data) {
                netPrice = data.price;
                netDelta = data.delta;
                netGamma = data.gamma;
                netTheta = data.theta;
                netVega = data.vega;
                netIv = data.iv;
                isDayTrade = data.isDayTrade;
                netIvRatio = data.ivRatio;
                underlyingPrice = data.underlyingPrice;
                compositeScore = data.score || (underlyingPrice ? calculateSingleLOQ(
                    data.delta || 0,
                    data.gamma || 0,
                    data.theta || 0,
                    underlyingPrice,
                    data.price,
                    data.ivRatio || 1.0
                ) : undefined);
            }
        }

        setLiveData({
            delta: netDelta,
            gamma: netGamma,
            theta: netTheta,
            vega: netVega,
            iv: netIv,
            price: netPrice,
            score: compositeScore,
            isDayTrade,
            ivRatio: netIvRatio
        });

        if (netDelta !== 0) saveGreeksHistory(position.id, netIv, netDelta);
        if (netPrice && Math.abs((position.current_price || 0) - netPrice) > 0.01) {
            await onUpdatePrice(position.id, netPrice);
        }
        const firstValid = results.find(r => r && r.cboeTimestamp);
        if (firstValid && onDataUpdate) {
            onDataUpdate(firstValid.cboeTimestamp);
        }
    }, [position, isSpread, isCreditStrategy, onUpdatePrice, onDataUpdate]);

    const fetchGreeksAndPrice = useCallback(async () => {
        if (preFetchedData) {
            await processOptionData(preFetchedData);
            return;
        }
        setLoading(true);
        try {
            let results = [];
            if (isSpread && position.legs) {
                const promises = position.legs.map(async (leg) => {
                    const params = new URLSearchParams({ ticker: position.ticker, expiration: leg.expiration, strike: leg.strike.toString(), type: leg.type });
                    const res = await fetch(`/api/option-price?${params}`);
                    return res.ok ? await res.json() : null;
                });
                results = await Promise.all(promises);
            } else {
                const params = new URLSearchParams({ ticker: position.ticker, expiration: position.expiration, strike: position.strike.toString(), type: position.type });
                const response = await fetch(`/api/option-price?${params}`);
                if (response.ok) results = [await response.json()];
            }
            await processOptionData(results);
        } catch (e) { console.error(e); }
        setLoading(false);
    }, [position, isSpread, processOptionData, preFetchedData]);

    useEffect(() => { fetchGreeksAndPrice(); }, [fetchGreeksAndPrice]);

    useEffect(() => {
        if (isExpanded && historyData.length === 0) {
            setHistoryLoading(true);
            fetchGreeksHistory(position.id).then(data => {
                setHistoryData(data);
                setHistoryLoading(false);
            });
        }
    }, [isExpanded, position.id, historyData.length]);

    // Derived Logic for UI
    const positionTxns = transactions.filter(t => t.position_id === position.id);
    let totalQtyBought = 0, totalCostBasis = 0, totalQtySold = 0;
    positionTxns.forEach(t => {
        const qty = t.quantity;
        const price = t.price * CONTRACT_MULTIPLIER;
        if (qty > 0) { totalQtyBought += qty; totalCostBasis += qty * price; }
        else { totalQtySold += Math.abs(qty); }
    });

    const totalQty = totalQtyBought - totalQtySold;
    const avgCostPerContract = totalQtyBought > 0 ? totalCostBasis / totalQtyBought : 0;
    const firstBuy = positionTxns.find(t => t.quantity > 0);
    const entryPrice = firstBuy ? Math.abs(firstBuy.price) : 0;
    const hasTakenProfit = positionTxns.some(t => t.type === 'Take Profit');
    const currentStopLoss = isCreditStrategy ? entryPrice * 1.5 : (hasTakenProfit ? entryPrice * 0.75 : entryPrice * 0.5);
    const currentPrice = liveData.price !== undefined ? liveData.price : (position.current_price || 0);

    let unrealizedPnL = 0, unrealizedPnLPct = 0;
    if (totalQty > 0 && currentPrice) {
        if (isCreditStrategy) {
            unrealizedPnL = (entryPrice - currentPrice) * totalQty * CONTRACT_MULTIPLIER;
            unrealizedPnLPct = entryPrice > 0 ? (unrealizedPnL / (entryPrice * totalQty * CONTRACT_MULTIPLIER)) * 100 : 0;
        } else {
            const totalValue = totalQty * currentPrice * CONTRACT_MULTIPLIER;
            const totalCost = totalQty * avgCostPerContract;
            unrealizedPnL = totalValue - totalCost;
            unrealizedPnLPct = (totalCost > 0) ? (unrealizedPnL / totalCost) * 100 : 0;
        }
    }

    const calculatedTarget = isCreditStrategy ? entryPrice * 0.5 : entryPrice * 1.25;
    const targetPrice = position.target_price || calculatedTarget;
    let realizedPnL = 0;
    positionTxns.forEach(t => {
        if (t.type === 'Take Profit' || t.type === 'Close' || t.type === 'Size Down') {
            const exitPricePerContract = t.price * CONTRACT_MULTIPLIER;
            const qtySold = Math.abs(t.quantity);
            if (isCreditStrategy) realizedPnL += (avgCostPerContract - exitPricePerContract) * qtySold;
            else realizedPnL += (exitPricePerContract - avgCostPerContract) * qtySold;
        }
    });

    const daysToExp = daysUntil(position.expiration);
    const currentScore = position.current_score || position.entry_score;
    const scoreColor = currentScore >= 70 ? 'text-accent-green' : currentScore >= 50 ? 'text-accent-yellow' : 'text-accent-red';
    const scoreBarColor = currentScore >= 70 ? 'bg-accent-green' : currentScore >= 50 ? 'bg-accent-yellow' : 'bg-accent-red';
    const pnlColor = unrealizedPnL >= 0 ? 'text-accent-green' : 'text-accent-red';

    const handleAction = async (type: 'Size Up' | 'Take Profit' | 'Close') => {
        if (!actionPrice) return;
        setLoading(true);
        const qty = ['Size Down', 'Take Profit', 'Close'].includes(type) ? -Math.abs(actionQty) : Math.abs(actionQty);
        await onAction(position.id, { type, quantity: type === 'Close' ? -totalQty : qty, price: parseFloat(actionPrice) });
        setLoading(false);
        setActionMode(null);
        setActionPrice('');
        setActionQty(1);
    };

    const handleScoreSave = async () => {
        const newScore = parseInt(scoreInput);
        if (!isNaN(newScore)) { await onUpdateScore(position.id, newScore); setIsEditingScore(false); }
    };

    const handleTargetSave = async () => {
        const newTarget = parseFloat(targetInput);
        if (!isNaN(newTarget)) { await onUpdateTarget(position.id, newTarget); setIsEditingTarget(false); }
    };

    return (
        <div className="relative overflow-hidden group rounded-2xl border border-white/5 bg-white/5 backdrop-blur-md hover:bg-white/10 transition-all duration-300 shadow-xl mb-4">
            {/* Top Bar: Gradient Line based on PnL */}
            <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${unrealizedPnL >= 0 ? 'from-transparent via-accent-green/50 to-transparent' : 'from-transparent via-accent-red/50 to-transparent'} opacity-50`}></div>

            <div className="p-5">
                {/* Header Section */}
                <div className="flex justify-between items-start mb-6">
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-3">
                            <h3 className="text-2xl font-bold tracking-tight text-white">{position.ticker}</h3>
                            <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider border ${isCreditStrategy ? 'border-accent-green/30 text-accent-green bg-accent-green/10' : 'border-accent-blue/30 text-accent-blue bg-accent-blue/10'}`}>
                                {isSpread ? 'Spread' : position.type}
                            </span>
                            {Boolean(liveData.isDayTrade) && (
                                <span className="px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider border border-purple-500/30 text-purple-300 bg-purple-500/10">DT</span>
                            )}
                        </div>
                        <div className="text-sm text-text-tertiary font-mono flex items-center gap-2">
                            <span>{formatDate(position.expiration)}</span>
                            <span>•</span>
                            <span className={daysToExp <= 7 ? 'text-accent-yellow font-bold' : ''}>{daysToExp}d left</span>
                        </div>
                    </div>

                    {/* Score Badge */}
                    <div className="flex flex-col items-end">
                        <div className="text-xs text-text-tertiary mb-1 uppercase tracking-wider font-bold">Score</div>
                        <div className="relative group/score cursor-pointer" onClick={() => { setIsEditingScore(true); setScoreInput(currentScore?.toString() || ''); }}>
                            {isEditingScore ? (
                                <input autoFocus className="w-12 bg-bg-secondary text-right border rounded px-1" value={scoreInput} onChange={e => setScoreInput(e.target.value)} onBlur={handleScoreSave} onKeyDown={e => e.key === 'Enter' && handleScoreSave()} />
                            ) : (
                                <div className={`text-3xl font-black ${scoreColor} tabular-nums relative z-10`}>
                                    {currentScore || '--'}
                                </div>
                            )}
                            {/* Health Bar Underline */}
                            <div className="absolute -bottom-1 left-0 right-0 h-1 bg-white/10 rounded-full overflow-hidden">
                                <div className={`h-full ${scoreBarColor} transition-all duration-500`} style={{ width: `${currentScore}%` }}></div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Main Body Grid */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">

                    {/* Left: PnL & Status */}
                    <div className="md:col-span-4 flex flex-col">
                        <div className="flex items-baseline gap-2">
                            <span className={`text-4xl font-bold tracking-tighter ${pnlColor}`}>
                                {formatPercent(unrealizedPnLPct)}
                            </span>
                            <span className={`text-lg font-mono opacity-80 ${pnlColor}`}>
                                {unrealizedPnL >= 0 ? '+' : ''}{formatCurrency(unrealizedPnL)}
                            </span>
                        </div>
                        <div className="mt-2 flex items-center gap-4 text-xs font-mono text-text-secondary">
                            <div className="flex flex-col">
                                <span className="text-text-tertiary uppercase text-[9px]">Entry</span>
                                <span>{formatPrice(entryPrice)}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-text-tertiary uppercase text-[9px]">Current</span>
                                <span>{currentPrice ? formatPrice(currentPrice) : '...'}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-text-tertiary uppercase text-[9px]">Target</span>
                                <span className="text-accent-green" onClick={() => { setIsEditingTarget(true); setTargetInput(targetPrice.toString()); }}>
                                    {isEditingTarget ? <input className="w-12 bg-transparent border-b" value={targetInput} onChange={e => setTargetInput(e.target.value)} onBlur={handleTargetSave} autoFocus /> : formatPrice(targetPrice)}
                                </span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-text-tertiary uppercase text-[9px]">Stop</span>
                                <span className="text-accent-red">{formatPrice(currentStopLoss)}</span>
                            </div>
                        </div>
                    </div>

                    {/* Center: Greeks Grid (Compact) */}
                    <div className="md:col-span-5 grid grid-cols-4 gap-2">
                        {[
                            { label: 'Delta', value: liveData.delta, fmt: (v: number) => v.toFixed(2) },
                            { label: 'Gamma', value: liveData.gamma, fmt: (v: number) => v.toFixed(3) },
                            { label: 'Theta', value: liveData.theta, fmt: (v: number) => v.toFixed(2) },
                            { label: 'IV', value: liveData.iv, fmt: (v: number) => (v * 100).toFixed(0) + '%' },
                        ].map((g, i) => (
                            <div key={i} className="bg-white/5 rounded-lg p-2 text-center border border-white/5 hover:border-white/10 transition-colors">
                                <div className="text-[9px] text-text-tertiary uppercase tracking-wider mb-0.5">{g.label}</div>
                                <div className={`text-sm font-mono font-medium ${!g.value ? 'text-text-tertiary' : 'text-white'}`}>
                                    {g.value !== undefined ? g.fmt(g.value) : '--'}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Right: Actions */}
                    <div className="md:col-span-3 flex justify-end gap-2">
                        {!actionMode ? (
                            <>
                                <button onClick={() => setActionMode('Add')} className="p-2 rounded-lg bg-white/5 hover:bg-white/10 hover:text-white text-text-secondary transition-colors" title="Size Up">
                                    <TrendingUp size={18} />
                                </button>
                                <button onClick={() => setActionMode('TakeProfit')} className="p-2 rounded-lg bg-white/5 hover:bg-emerald-500/20 hover:text-emerald-400 text-text-secondary transition-colors" title="Take Profit">
                                    <Target size={18} />
                                </button>
                                <button onClick={() => setActionMode('Close')} className="p-2 rounded-lg bg-white/5 hover:bg-red-500/20 hover:text-red-400 text-text-secondary transition-colors" title="Close Position">
                                    <Trash2 size={18} />
                                </button>
                                {onRollClick && (
                                    <button onClick={() => onRollClick(totalQty)} className="p-2 rounded-lg bg-white/5 hover:bg-blue-500/20 hover:text-blue-400 text-text-secondary transition-colors" title="Roll Position">
                                        <ArrowRightLeft size={18} />
                                    </button>
                                )}
                                <button onClick={() => onDelete(position.id)} className="p-2 rounded-lg bg-white/5 hover:bg-red-500/20 hover:text-red-400 text-text-secondary transition-colors" title="Delete Position">
                                    <Trash2 size={18} />
                                </button>
                                <button onClick={fetchGreeksAndPrice} disabled={loading} className={`p-2 rounded-lg bg-white/5 hover:bg-white/10 text-text-secondary transition-colors ${loading ? 'animate-spin' : ''}`} title="Refresh">
                                    <RefreshCw size={18} />
                                </button>
                            </>
                        ) : (
                            <div className="flex flex-col gap-2 w-full animate-in fade-in zoom-in-95">
                                <div className="flex gap-2">
                                    {actionMode !== 'Close' && <input className="w-12 bg-bg-tertiary rounded px-1 text-sm" placeholder="#" value={actionQty} onChange={e => setActionQty(parseFloat(e.target.value))} />}
                                    <input className="flex-1 bg-bg-tertiary rounded px-1 text-sm" placeholder="Price" value={actionPrice} onChange={e => setActionPrice(e.target.value)} autoFocus />
                                </div>
                                <div className="flex gap-1">
                                    <button onClick={() => handleAction(actionMode === 'Add' ? 'Size Up' : actionMode === 'TakeProfit' ? 'Take Profit' : 'Close')} className="flex-1 bg-emerald-500/20 text-emerald-400 text-xs py-1 rounded hover:bg-emerald-500/30">Confirm</button>
                                    <button onClick={() => setActionMode(null)} className="flex-1 bg-white/5 text-text-secondary text-xs py-1 rounded hover:bg-white/10">Cancel</button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer Details */}
                <div className="mt-4 pt-4 border-t border-white/5 flex justify-between items-center text-xs text-text-tertiary">
                    <div className="flex items-center gap-4">
                        {isSpread ? (
                            <span>{position.legs?.find(l => l.side === 'short')?.strike}/{position.legs?.find(l => l.side === 'long')?.strike} {isCreditStrategy ? 'Credit' : 'Debit'}</span>
                        ) : (
                            <span>${position.strike} {position.type}</span>
                        )}
                        {Boolean(earnings.days !== null && earnings.days <= 14) && (
                            <span className="flex items-center gap-1 text-orange-400/80">
                                <AlertOctagon size={12} /> Earn in {earnings.days}d
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 cursor-pointer hover:text-text-secondary transition-colors" onClick={() => setIsExpanded(!isExpanded)}>
                        {historyLoading ? <RefreshCw size={10} className="animate-spin" /> : <Clock size={12} />}
                        <span>History</span>
                        <ChevronDown size={12} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </div>
                </div>
            </div>

            {/* Expanded History */}
            {isExpanded && (
                <div className="bg-black/20 p-4 border-t border-white/5 animate-in slide-in-from-top-2">
                    <GreeksHistoryChart data={historyData} loading={historyLoading} />
                </div>
            )}
        </div>
    );
};
