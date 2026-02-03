import React, { useState, useEffect } from 'react';
import { RefreshCw, Calendar, ChevronDown } from 'lucide-react';
import { Position, Transaction, LiveData, GreeksHistory } from '../lib/types';
import { GreeksHistoryChart } from './GreeksHistoryChart';
import { saveGreeksHistory, fetchGreeksHistory } from '../lib/greeksHistory';
import { formatDate, formatCurrency, formatPercent, daysUntil, formatPrice, CONTRACT_MULTIPLIER } from '../lib/utils';

interface PositionCardProps {
    position: Position;
    transactions: Transaction[];
    onAction: (id: string, action: any) => Promise<void>;
    onUpdateScore: (id: string, score: number) => Promise<void>; // Kept for interface compatibility
    onUpdatePrice: (id: string, price: number) => Promise<void>;
}

export const PositionCard: React.FC<PositionCardProps> = ({ position, transactions, onAction, onUpdateScore, onUpdatePrice }) => {
    const [loading, setLoading] = useState(false);
    const [liveData, setLiveData] = useState<LiveData>({ delta: undefined, iv: undefined });
    const [earnings, setEarnings] = useState<{ loading: boolean; date: string | null; days: number | null }>({ loading: true, date: null, days: null });
    const [actionMode, setActionMode] = useState<'Add' | 'TakeProfit' | 'Close' | null>(null);
    const [actionQty, setActionQty] = useState(1);
    const [actionPrice, setActionPrice] = useState('');
    const [isEditingScore, setIsEditingScore] = useState(false);
    const [scoreInput, setScoreInput] = useState('');
    const [isExpanded, setIsExpanded] = useState(false);
    const [historyData, setHistoryData] = useState<GreeksHistory[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

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

    // Fetch Greeks and save history once per day
    useEffect(() => {
        const fetchGreeks = async () => {
            try {
                const params = new URLSearchParams({ ticker: position.ticker, expiration: position.expiration, strike: position.strike.toString(), type: position.type });
                const response = await fetch(`/api/option-price?${params}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.delta || data.iv) {
                        setLiveData({ delta: data.delta, iv: data.iv });
                        // Save to history (once per day)
                        saveGreeksHistory(position.id, data.iv, data.delta);
                    }
                }
            } catch (e) { /* ignore */ }
        };
        fetchGreeks();
    }, [position.id, position.ticker, position.expiration, position.strike, position.type]);

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
        const price = t.price * CONTRACT_MULTIPLIER;
        if (qty > 0) { totalQtyBought += qty; totalCostBasis += qty * price; }
        else { totalQtySold += Math.abs(qty); }
    });

    const totalQty = totalQtyBought - totalQtySold;
    const avgCostPerContract = totalQtyBought > 0 ? totalCostBasis / totalQtyBought : 0;
    const firstBuy = positionTxns.find(t => t.quantity > 0);
    const entryPrice = firstBuy ? firstBuy.price : 0;

    const hasTakenProfit = positionTxns.some(t => t.type === 'Take Profit');
    const currentStopLoss = hasTakenProfit ? entryPrice * 0.75 : entryPrice * 0.5;

    const currentPrice = position.current_price || 0;
    const unrealizedCostBasis = totalQty * avgCostPerContract;
    const currentValue = totalQty * currentPrice * CONTRACT_MULTIPLIER;
    const unrealizedPnL = currentPrice ? currentValue - unrealizedCostBasis : 0;
    const unrealizedPnLPct = unrealizedCostBasis > 0 && currentPrice ? ((currentPrice * CONTRACT_MULTIPLIER - avgCostPerContract) / avgCostPerContract) * 100 : 0;

    const daysToExp = daysUntil(position.expiration);
    const currentScore = position.current_score || position.entry_score;

    // Alert logic
    let alertLevel: 'none' | 'danger' | 'warning' = 'none';
    const alerts: string[] = [];
    if (currentScore < 60) { alerts.push('Low Score'); alertLevel = 'danger'; }
    if (currentPrice && currentPrice <= currentStopLoss) { alerts.push('Hit Stop'); alertLevel = 'danger'; }
    if (unrealizedPnLPct <= -40) { alerts.push('Heavy Loss'); alertLevel = 'danger'; }
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

    const fetchPrice = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ ticker: position.ticker, expiration: position.expiration, strike: position.strike.toString(), type: position.type });
            const response = await fetch(`/api/option-price?${params}`);
            if (response.ok) {
                const data = await response.json();
                if (data.price) {
                    await onUpdatePrice(position.id, data.price);
                    setLiveData({ delta: data.delta, iv: data.iv });
                }
            }
        } catch (e) { console.error(e); }
        setLoading(false);
    };

    const handleAction = async (type: 'Size Up' | 'Take Profit' | 'Close') => {
        if (!actionPrice) return;
        setLoading(true);
        const qty = ['Size Down', 'Take Profit', 'Close'].includes(type) ? -Math.abs(actionQty) : Math.abs(actionQty);
        await onAction(position.id, {
            type,
            quantity: type === 'Close' ? -totalQty : qty,
            price: parseFloat(actionPrice)
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
                        <span className={`badge ${position.type === 'Call' ? 'badge-green' : 'badge-red'}`}>
                            {position.type}
                        </span>
                    </div>
                    <div className="text-text-secondary">
                        <span className="font-mono">${position.strike}</span>
                        <span className="mx-2">·</span>
                        <span>{formatDate(position.expiration)}</span>
                        <span className="mx-2">·</span>
                        <span>{totalQty} contract{totalQty !== 1 ? 's' : ''}</span>
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
                <div className={`mb-4 p-3 rounded-xl flex items-center justify-between ${earningsImminent ? 'bg-purple-500/20 border border-purple-500/40' : 'bg-blue-500/10 border border-blue-500/30'}`}>
                    <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${earningsImminent ? 'bg-purple-500/30' : 'bg-blue-500/20'}`}>
                            <Calendar size={18} className={earningsImminent ? 'text-purple-300' : 'text-blue-300'} />
                        </div>
                        <div>
                            <div className={`font-semibold ${earningsImminent ? 'text-purple-400' : 'text-blue-400'}`}>
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
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-4 mb-4 py-4 border-y border-border-default">
                <div>
                    <div className="metric-label">Entry</div>
                    <div className="metric-value">{formatPrice(entryPrice)}</div>
                </div>
                <div>
                    <div className="metric-label">Avg. Cost</div>
                    <div className="metric-value text-accent-blue">{formatPrice(avgCostPerContract / CONTRACT_MULTIPLIER)}</div>
                </div>
                <div>
                    <div className="metric-label">Current</div>
                    <div className="metric-value">{currentPrice ? formatPrice(currentPrice) : '—'}</div>
                </div>
                <div>
                    <div className="metric-label">Stop</div>
                    <div className={`metric-value ${hasTakenProfit ? 'text-accent-blue' : 'text-accent-red'}`}>
                        {formatPrice(currentStopLoss)}
                    </div>
                </div>
                <div>
                    <div className="metric-label">Delta</div>
                    <div className="metric-value text-purple-400">
                        {liveData.delta ? liveData.delta.toFixed(2) : '—'}
                    </div>
                </div>
                <div>
                    <div className="metric-label">IV</div>
                    <div className="metric-value text-cyan-400">
                        {liveData.iv ? (liveData.iv * 100).toFixed(1) + '%' : '—'}
                    </div>
                </div>
                <div>
                    <div className="metric-label flex items-center gap-1">
                        Score
                        <button onClick={() => { setIsEditingScore(true); setScoreInput(currentScore.toString()); }} className="text-text-tertiary hover:text-text-primary transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                        </button>
                    </div>
                    {isEditingScore ? (
                        <div className="flex items-center gap-1 mt-1">
                            <input
                                type="number"
                                value={scoreInput}
                                onChange={e => setScoreInput(e.target.value)}
                                className="w-12 px-1 py-0.5 text-sm bg-bg-secondary rounded border border-border-default font-mono"
                                autoFocus
                            />
                            <button onClick={handleScoreSave} className="text-accent-green hover:bg-accent-green/10 p-0.5 rounded">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                            </button>
                            <button onClick={() => setIsEditingScore(false)} className="text-accent-red hover:bg-accent-red/10 p-0.5 rounded">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                        </div>
                    ) : (
                        <div className={`metric-value ${currentScore >= 70 ? 'text-accent-green' : currentScore >= 60 ? 'text-accent-yellow' : 'text-accent-red'}`}>
                            {currentScore}
                        </div>
                    )}
                </div>
            </div>

            {/* Setup info */}
            <div className="text-sm text-text-secondary mb-4">
                <span className="text-text-tertiary">Setup:</span> {position.setup}
                {position.stop_reason && (
                    <>
                        <span className="mx-2 text-text-tertiary">·</span>
                        <span className="text-text-tertiary">Exit if:</span> {position.stop_reason}
                    </>
                )}
            </div>

            {/* Expandable Greeks History */}
            <div className="mb-4">
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="w-full flex items-center justify-between py-2 px-3 rounded-lg bg-bg-secondary/50 hover:bg-bg-secondary transition-colors text-sm text-text-secondary"
                >
                    <span>IV & Delta History</span>
                    <ChevronDown
                        size={16}
                        className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                    />
                </button>
                {isExpanded && (
                    <div className="mt-3 p-3 rounded-lg bg-bg-secondary/30 border border-border-default">
                        <GreeksHistoryChart data={historyData} loading={historyLoading} />
                    </div>
                )}
            </div>

            {/* Action Buttons */}
            {!actionMode ? (
                <div className="flex gap-2">
                    <button onClick={fetchPrice} disabled={loading} className="action-btn btn-secondary flex items-center justify-center gap-2">
                        {loading ? <div className="spinner w-4 h-4" /> : <RefreshCw size={16} />}
                        <span className="hidden sm:inline">Refresh</span>
                    </button>
                    <button onClick={() => setActionMode('Add')} className="action-btn bg-accent-greenDim text-accent-green">+ Add</button>
                    <button onClick={() => setActionMode('TakeProfit')} className="action-btn bg-accent-blue/20 text-accent-blue">Profit</button>
                    <button onClick={() => setActionMode('Close')} className="action-btn btn-danger">Close</button>
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
            )}
        </div>
    );
};
