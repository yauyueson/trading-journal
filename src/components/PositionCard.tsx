import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Calendar, ChevronDown, Trash2, ArrowRightLeft } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { Position, Transaction, LiveData, GreeksHistory, PositionAction } from '../lib/types';
import { GreeksHistoryChart } from './GreeksHistoryChart';
import { saveGreeksHistory, fetchGreeksHistory } from '../lib/greeksHistory';
import { formatDate, formatCurrency, formatPercent, daysUntil, formatPrice, CONTRACT_MULTIPLIER } from '../lib/utils';
import { calculateCreditSpreadScore, calculateDebitSpreadScore, calculateSingleLOQWithFactors } from '../lib/scoring';
import { getPositionRiskAtStopOutDollars } from '../lib/riskSizing';
import { useAppSettings } from '../context/AppSettingsContext';
import {
    usePositionAction,
    useUpdatePrice,
    useUpdateTarget,
    useUpdateStop,
    useUpdateOwner,
    useUpdateNotes,
    useDeletePosition,
} from '../hooks/usePositionMutations';

/** Normalize expiration to YYYY-MM-DD for option-price API (avoids wrong contract match). */
function normalizeExpiration(exp: string): string {
    if (!exp || typeof exp !== 'string') return exp;
    const s = exp.trim();
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
        const [, mm, dd, yyyy] = slashMatch;
        return `${yyyy}-${String(parseInt(mm, 10)).padStart(2, '0')}-${String(parseInt(dd, 10)).padStart(2, '0')}`;
    }
    return s;
}

interface PositionCardProps {
    position: Position;
    transactions: Transaction[];
    onAction?: (id: string, action: PositionAction, exitType?: Position['exit_type']) => Promise<void>;
    onUpdateScore?: (id: string, score: number) => Promise<void>;
    onUpdatePrice?: (id: string, price: number) => Promise<void>;
    onUpdateTarget?: (id: string, target: number) => Promise<void>;
    onUpdateStop?: (id: string, stopPrice: number) => Promise<void>;
    onDelete?: (id: string) => Promise<void>;
    onUpdateOwner?: (id: string, owner: 'Yuchen' | 'Annie' | null) => Promise<void>;
    onDataUpdate?: (timestamp: string) => void;
    refreshTrigger?: number;
    index?: number;
    onRollClick?: (qty: number) => void;
    portfolioTotal?: number;
    initialData?: any[];
    fetchEarningsForTicker?: (ticker: string) => Promise<{ daysUntil: number | null; date: string | null }>;
}

const PositionCardInner: React.FC<PositionCardProps> = (props) => {
    const { position, transactions, onDataUpdate, refreshTrigger = 0, index = 0, onRollClick, portfolioTotal: portfolioTotalProp, initialData, fetchEarningsForTicker } = props;

    // Mutation hooks as fallbacks when callback props not provided
    const positionActionMut = usePositionAction();
    const updatePriceMut = useUpdatePrice();
    const updateTargetMut = useUpdateTarget();
    const updateStopMut = useUpdateStop();
    const updateOwnerMut = useUpdateOwner();
    const updateNotesMut = useUpdateNotes();
    const deletePositionMut = useDeletePosition();

    const onAction = props.onAction ?? (async (id: string, action: PositionAction, exitType?: Position['exit_type']) => { positionActionMut.mutate({ id, action, exitType }); });
    const onUpdatePrice = props.onUpdatePrice ?? (async (id: string, price: number) => { updatePriceMut.mutate({ id, price }); });
    const onUpdateTarget = props.onUpdateTarget ?? (async (id: string, target: number) => { updateTargetMut.mutate({ id, target }); });
    const onUpdateStop = props.onUpdateStop ?? (async (id: string, stopPrice: number) => { updateStopMut.mutate({ id, stopPrice }); });
    const onUpdateOwner = props.onUpdateOwner ?? (async (id: string, owner: 'Yuchen' | 'Annie' | null) => { updateOwnerMut.mutate({ id, owner }); });
    const onDelete = props.onDelete ?? (async (id: string) => {
        if (window.confirm('Are you sure you want to permanently delete this position? This cannot be undone.')) {
            deletePositionMut.mutate(id);
        }
    });
    const { settings: appSettings, stopOutFraction } = useAppSettings();
    const portfolioTotal = portfolioTotalProp ?? appSettings.portfolio.accountSize;
    const [loading, setLoading] = useState(false);
    const [liveData, setLiveData] = useState<LiveData>({ delta: undefined, iv: undefined, gamma: undefined, theta: undefined, vega: undefined, score: undefined });
    const [earnings, setEarnings] = useState<{ loading: boolean; date: string | null; days: number | null }>({ loading: true, date: null, days: null });
    const [actionMode, setActionMode] = useState<'Add' | 'TakeProfit' | 'Close' | null>(null);
    const [actionQty, setActionQty] = useState(1);
    const [actionPrice, setActionPrice] = useState('');
    const [closeExitType, setCloseExitType] = useState<'TP' | 'SL' | 'TIME' | 'MANUAL'>('MANUAL');
    const [isEditingTarget, setIsEditingTarget] = useState(false);
    const [targetInput, setTargetInput] = useState('');
    const [isEditingStop, setIsEditingStop] = useState(false);
    const [stopInput, setStopInput] = useState('');
    const [isExpanded, setIsExpanded] = useState(false);
    const [isEditingNotes, setIsEditingNotes] = useState(false);
    const [notesInput, setNotesInput] = useState('');
    const [historyData, setHistoryData] = useState<GreeksHistory[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    const isSpread = !!position.legs && position.legs.length > 0;
    const isCreditStrategy = position.type.includes('Credit') || position.type.includes('Short');

    // Fetch Earnings (uses cached lookup if provided, else falls back to direct API call)
    useEffect(() => {
        const fetchEarnings = async () => {
            try {
                if (fetchEarningsForTicker) {
                    const result = await fetchEarningsForTicker(position.ticker);
                    if (result.daysUntil != null && result.daysUntil <= 14) {
                        setEarnings({ loading: false, date: result.date, days: result.daysUntil });
                    } else {
                        setEarnings({ loading: false, date: null, days: null });
                    }
                } else {
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
                }
            } catch (e) {
                setEarnings({ loading: false, date: null, days: null });
            }
        };
        fetchEarnings();
    }, [position.ticker, fetchEarningsForTicker]);

    // Fetch Greeks and price
    const fetchGreeksAndPrice = useCallback(async (useBulkData = false) => {
        // If we have initialData and useBulkData is true (first load or bulk refresh), use it.
        // Otherwise fetch fresh.
        // NOTE: initialData changes when parent refreshes.

        const effectiveData = useBulkData ? initialData : null;

        if (!effectiveData) setLoading(true); // only show loading if fetching

        try {
            if (isSpread && position.legs) {
                let results;

                if (effectiveData && effectiveData.length > 0) {
                    // Map initialData back to legs order.
                    // Bulk API returns: { ...leg, price, bid, ask, data: {normalized option}, underlyingPrice, delta, ... }
                    // Use the TOP-LEVEL result (which has price, bid, ask, delta etc.) not d.data
                    // (d.data is the raw normalized option which lacks a computed `price` field).
                    results = position.legs.map(leg => {
                        const match = effectiveData.find(d =>
                            d.expiration === leg.expiration &&
                            String(d.strike) === String(leg.strike) &&
                            d.type === leg.type
                        );
                        return match || null;
                    });
                    console.log(`[Card] Using Bulk Data for ${position.ticker}`);
                } else {
                    const promises = position.legs.map(async (leg) => {
                        const params = new URLSearchParams({ ticker: position.ticker, expiration: normalizeExpiration(leg.expiration), strike: leg.strike.toString(), type: leg.type });
                        const res = await fetch(`/api/option-price?${params}`);
                        return res.ok ? await res.json() : null;
                    });
                    results = await Promise.all(promises);
                }

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
                    // CONSERVATIVE PRICING (Survival Mode)
                    // Use Bid/Ask to calculate "True Cost to Close" or "True Liquidation Value"
                    // If Bid/Ask missing, fallback to Mid/Last (price)
                    const shortAsk = shortData.ask || Math.abs(shortData.price || 0);
                    // const shortBid unused
                    // const longAsk unused
                    const longBid = longData.bid || Math.abs(longData.price || 0);

                    if (isCreditStrategy) {
                        // Cost to Close = Buy back Short (Ask) - Sell Long (Bid)
                        netPrice = shortAsk - longBid;
                    } else {
                        // Liquidation Value = Sell Long (Bid) - Buy back Short (Ask)
                        netPrice = longBid - shortAsk;
                    }
                }

                // Greeks Calculation
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

                // netPrice calculation moved to initial block for consistency


                let compositeScore = undefined;
                let compositeFactors = undefined;
                const underlyingPrice = shortData?.underlyingPrice || longData?.underlyingPrice || 0;

                if (isCreditStrategy && shortData && longData && underlyingPrice > 0) {
                    const shortLeg = position.legs?.find(l => l.side === 'short');
                    const longLeg = position.legs?.find(l => l.side === 'long');
                    const shortStrike = shortLeg ? shortLeg.strike : 0;
                    const longStrike = longLeg ? longLeg.strike : 0;
                    const width = Math.abs(Math.abs(shortStrike) - Math.abs(longStrike));
                    const currentCredit = Math.abs(shortData.price) - Math.abs(longData.price);

                    compositeScore = calculateCreditSpreadScore({
                        credit: currentCredit,
                        width: width,
                        shortDelta: shortData.delta || 0,
                        shortStrike: shortStrike,
                        currentPrice: underlyingPrice
                    });
                } else if (!isCreditStrategy && shortData && longData && underlyingPrice > 0) {
                    const shortStrike = position.legs?.find(l => l.side === 'short')?.strike || 0;
                    const longStrike = position.legs?.find(l => l.side === 'long')?.strike || 0;
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
                    const loq = shortData.underlyingPrice ? calculateSingleLOQWithFactors(
                        shortData.delta || 0,
                        shortData.gamma || 0,
                        shortData.theta || 0,
                        shortData.underlyingPrice,
                        Math.abs(shortData.price),
                        1.0,
                        daysUntil(position.expiration)
                    ) : null;
                    compositeScore = shortData.score ?? loq?.score;
                    compositeFactors = loq?.factors;
                } else if (!isCreditStrategy && longData) {
                    const loq = longData.underlyingPrice ? calculateSingleLOQWithFactors(
                        longData.delta || 0,
                        longData.gamma || 0,
                        longData.theta || 0,
                        longData.underlyingPrice,
                        Math.abs(longData.price),
                        1.0,
                        daysUntil(position.expiration)
                    ) : null;
                    compositeScore = longData.score ?? loq?.score;
                    compositeFactors = loq?.factors;
                }

                setLiveData({
                    delta: netDelta,
                    gamma: netGamma,
                    theta: netTheta,
                    vega: netVega,
                    iv: netIv,
                    price: netPrice,
                    score: compositeScore,
                    factors: compositeFactors
                });

                if (netDelta !== 0) saveGreeksHistory(position.id, netIv, netDelta);

                if (results.some(r => r !== null)) {
                    if (Math.abs((position.current_price || 0) - netPrice) > 0.01) {
                        await onUpdatePrice(position.id, netPrice);
                    }
                    // Report timestamp from first valid result
                    const firstValid = results.find(r => r && r.cboeTimestamp);
                    if (firstValid && onDataUpdate) {
                        onDataUpdate(firstValid.cboeTimestamp);
                    }
                }

            } else {
                let data;

                if (effectiveData && effectiveData.length > 0) {
                    // Single position — use top-level result (has price, bid, ask, delta etc.)
                    data = effectiveData[0] || null;
                } else {
                    const expNorm = normalizeExpiration(position.expiration);
                    const params = new URLSearchParams({ ticker: position.ticker, expiration: expNorm, strike: position.strike.toString(), type: position.type });
                    const response = await fetch(`/api/option-price?${params}`);
                    if (response.ok) {
                        data = await response.json();
                    }
                }

                if (data) {
                    // Current = mid (bid+ask)/2，与 API 返回的 price 一致
                    const price = data.price ?? 0;
                    if (price || data.bid != null || data.ask != null) {
                        if (Math.abs((position.current_price || 0) - price) > 0.01) {
                            await onUpdatePrice(position.id, price);
                        }
                        if (data.cboeTimestamp && onDataUpdate) {
                            onDataUpdate(data.cboeTimestamp);
                        }
                        const loqResult = data.underlyingPrice ? calculateSingleLOQWithFactors(
                            data.delta || 0,
                            data.gamma || 0,
                            data.theta || 0,
                            data.underlyingPrice,
                            price,
                            data.metrics?.ivRatio || 1.0,
                            daysUntil(position.expiration)
                        ) : null;
                        const calculatedScore = data.score ?? loqResult?.score;

                        setLiveData({
                            delta: data.delta,
                            iv: data.iv,
                            gamma: data.gamma,
                            theta: data.theta,
                            vega: data.vega,
                            score: calculatedScore,
                            price,
                            isDayTrade: data.metrics?.isDayTrade,
                            ivRatio: data.metrics?.ivRatio,
                            factors: loqResult?.factors
                        });
                        saveGreeksHistory(position.id, data.iv, data.delta);
                    }
                }
            }
        } catch (e) { console.error(e); }
        setLoading(false);
    }, [position.id, position.ticker, position.expiration, position.strike, position.type, isSpread, isCreditStrategy, position.legs, onUpdatePrice, initialData]);

    useEffect(() => {
        // Initial load? Try using bulk data if available, otherwise fetch.
        // If initialData is present, it means parent likely fetched already.
        if (initialData) {
            fetchGreeksAndPrice(true);
        } else {
            fetchGreeksAndPrice(false);
        }
    }, [initialData]); // Re-run when initialData updates (bulk refresh)

    useEffect(() => {
        if (refreshTrigger > 0 && !initialData) {
            // Only trigger individual fetch if NO bulk data was provided
            // OR if the refresh trigger is meant to force fallback
            // But Portfolio logic says: if bulk fails, trigger incremented.
            // If bulk succeeds, initialData updates, triggering above effect.
            // So this handles fallback only.
            const delay = index * 200;
            setTimeout(() => {
                fetchGreeksAndPrice(false);
            }, delay);
        }
    }, [refreshTrigger, index, fetchGreeksAndPrice, initialData]);

    const hasLoadedHistoryRef = React.useRef(false);

    useEffect(() => {
        if (isExpanded && !hasLoadedHistoryRef.current) {
            hasLoadedHistoryRef.current = true;
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
    const entryPrice = firstBuy ? Math.abs(firstBuy.price) : 0;

    const currentStopLoss = position.stop_price ?? null;

    const currentPrice = liveData.price !== undefined ? liveData.price : (position.current_price || 0);

    let unrealizedPnL = 0;
    let unrealizedPnLPct = 0;

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

    const tpFraction = isCreditStrategy
        ? (position.strategy_type === 'shortTerm' ? 0.50 : 0.30)
        : 0.25; // debit: 25% gain
    const calculatedTarget = isCreditStrategy
        ? entryPrice * (1 - tpFraction) // credit: close at (1-TP%) of entry credit
        : entryPrice * (1 + tpFraction);
    const targetPrice = position.target_price || calculatedTarget;

    let realizedPnL = 0;
    positionTxns.forEach(t => {
        if (t.type === 'Take Profit' || t.type === 'Close' || t.type === 'Size Down') {
            const exitPricePerContract = t.price * CONTRACT_MULTIPLIER;
            const qtySold = Math.abs(t.quantity);
            if (isCreditStrategy) {
                realizedPnL += (avgCostPerContract - exitPricePerContract) * qtySold;
            } else {
                realizedPnL += (exitPricePerContract - avgCostPerContract) * qtySold;
            }
        }
    });

    const daysToExp = daysUntil(position.expiration);

    // TP Progress (0-100%+)
    const tpProgress = (isCreditStrategy && entryPrice > 0 && currentPrice != null)
        ? Math.max(0, ((entryPrice - currentPrice) / (entryPrice * tpFraction)) * 100)
        : (!isCreditStrategy && entryPrice > 0 && currentPrice != null)
            ? Math.max(0, ((currentPrice - entryPrice) / (entryPrice * tpFraction)) * 100)
            : null;
    const tpReady = tpProgress != null && tpProgress >= 100;

    // Time Stop thresholds
    const timeStopDTE = position.strategy_type === 'shortTerm' ? 1 : 3;
    const isTimeStop = daysToExp <= timeStopDTE && daysToExp >= 0;

    const positionRiskAtStopOutDollars = getPositionRiskAtStopOutDollars(position, Math.max(0, totalQty), entryPrice, stopOutFraction);
    const singleTradeRiskPct = portfolioTotal && portfolioTotal > 0
        ? (positionRiskAtStopOutDollars / portfolioTotal) * 100
        : null;

    let alertLevel: 'none' | 'danger' | 'warning' | 'success' = 'none';
    const alerts: string[] = [];

    // TP Ready — actionable
    if (tpReady) { alerts.push('TP Ready'); alertLevel = 'success'; }
    // Time Stop — must close
    if (isTimeStop) { alerts.push(`TIME STOP (DTE ${daysToExp})`); alertLevel = 'danger'; }
    // User-set stop loss hit
    if (currentStopLoss != null && currentPrice) {
        if (isCreditStrategy && currentPrice >= currentStopLoss) { alerts.push('Hit Stop'); alertLevel = 'danger'; }
        if (!isCreditStrategy && currentPrice <= currentStopLoss) { alerts.push('Hit Stop'); alertLevel = 'danger'; }
    }
    // Heavy loss warning
    if (unrealizedPnLPct <= -50) { alerts.push('Heavy Loss'); alertLevel = 'danger'; }
    // DTE warning (approaching but not yet time stop)
    if (alertLevel === 'none' && daysToExp <= 7 && daysToExp > timeStopDTE) {
        alerts.push(`${daysToExp}d left`); alertLevel = 'warning';
    }

    const earningsWarning = earnings.days !== null && earnings.days >= 0 && earnings.days <= 7;
    const earningsImminent = earnings.days !== null && earnings.days >= 0 && earnings.days <= 3;

    let cardClass = 'card';
    if (alertLevel === 'danger') cardClass = 'card-danger';
    else if (earningsImminent) cardClass = 'card-earnings';
    else if (alertLevel === 'warning') cardClass = 'card-warning';
    else if (alertLevel === 'success') cardClass = 'card border-accent-green/30';
    else if (earningsWarning) cardClass = 'card-earnings-soon';

    const pnlColor = unrealizedPnL >= 0 ? 'text-accent-green' : 'text-accent-red';

    const handleAction = async (type: 'Size Up' | 'Take Profit' | 'Close', exitTypeOverride?: Position['exit_type']) => {
        if (!actionPrice) return;
        setLoading(true);
        const qty = ['Size Down', 'Take Profit', 'Close'].includes(type) ? -Math.abs(actionQty) : Math.abs(actionQty);
        await onAction(position.id, {
            type,
            quantity: type === 'Close' ? -totalQty : qty,
            price: parseFloat(actionPrice)
        }, exitTypeOverride);
        setLoading(false);
        setActionMode(null);
        setActionPrice('');
        setActionQty(1);
        setCloseExitType('MANUAL');
    };


    const handleTargetSave = async () => {
        const newTarget = parseFloat(targetInput);
        if (!isNaN(newTarget)) {
            await onUpdateTarget(position.id, newTarget);
            setIsEditingTarget(false);
        }
    };

    const handleStopSave = async () => {
        const newStop = parseFloat(stopInput);
        if (!isNaN(newStop) && onUpdateStop) {
            await onUpdateStop(position.id, newStop);
            setIsEditingStop(false);
        }
    };

    return (
        <div className={`${cardClass} p-4 sm:p-5 fade-in`}>
            {/* Header */}
            <div className="flex justify-between items-start gap-3 mb-4">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 sm:gap-3 mb-1 flex-wrap">
                        <span className="text-xl sm:text-2xl font-bold">{position.ticker}</span>
                        {position.strategy_type && (
                            <span className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded ${
                                position.strategy_type === 'swing'
                                    ? 'bg-green-500/15 text-green-400'
                                    : 'bg-blue-500/15 text-blue-400'
                            }`}>
                                {position.strategy_type === 'swing' ? 'Swing' : 'ST'}
                            </span>
                        )}
                        {onUpdateOwner && (
                            <select
                                value={position.owner || ''}
                                onChange={e => {
                                    const val = e.target.value;
                                    onUpdateOwner(position.id, val === '' ? null : val as 'Yuchen' | 'Annie');
                                }}
                                className={`px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-semibold cursor-pointer transition-colors appearance-none bg-transparent border-0 outline-none ${position.owner === 'Yuchen'
                                    ? 'bg-blue-500/20 text-blue-400'
                                    : position.owner === 'Annie'
                                        ? 'bg-pink-500/20 text-pink-400'
                                        : 'bg-white/5 text-text-tertiary'
                                    }`}
                            >
                                <option value="" className="bg-bg-primary text-text-tertiary">—</option>
                                <option value="Yuchen" className="bg-bg-primary text-blue-400">Yuchen</option>
                                <option value="Annie" className="bg-bg-primary text-pink-400">Annie</option>
                            </select>
                        )}
                        {isSpread ? (
                            <div className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm text-text-secondary font-medium uppercase tracking-wide">
                                <span className="text-text-primary">
                                    ${position.legs?.find(l => l.side === 'short')?.strike}{position.legs?.[0]?.type?.charAt(0)}
                                    <span className="mx-1">/</span>
                                    ${position.legs?.find(l => l.side === 'long')?.strike}{position.legs?.[0]?.type?.charAt(0)}
                                </span>
                                <span className="hidden sm:inline text-[15.5px]">{position.legs?.[0]?.type} {isCreditStrategy ? 'Credit' : 'Debit'} Spread</span>
                                <span className="sm:hidden">{isCreditStrategy ? 'Cr' : 'Dr'}</span>
                            </div>
                        ) : (
                            <div className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm text-text-secondary font-medium uppercase tracking-wide">
                                <span className="text-text-primary font-mono">${position.strike}</span>
                                <span className={`${position.type?.toLowerCase().includes('call') ? 'text-accent-green' : 'text-accent-red'}`}>
                                    {position.type}
                                </span>
                            </div>
                        )}
                    </div>
                    <div className="text-text-secondary text-xs sm:text-sm flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <span>{formatDate(position.expiration)}</span>
                        <span>·</span>
                        <span>{totalQty}x</span>
                        {singleTradeRiskPct != null && (
                            <>
                                <span>·</span>
                                <span className="font-mono text-text-primary" title="Max risk at stop-out: $ and % of portfolio">
                                    {formatCurrency(positionRiskAtStopOutDollars)} <span className="text-text-tertiary">({singleTradeRiskPct.toFixed(1)}%)</span>
                                </span>
                            </>
                        )}
                        {liveData.ivRatio !== undefined && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-mono font-medium bg-bg-tertiary border border-border-default/50 text-text-secondary" title="IV Ratio">
                                IVR: <span className={liveData.ivRatio > 1.05 ? 'text-accent-green' : liveData.ivRatio < 0.95 ? 'text-accent-red' : 'text-text-primary'}>
                                    {liveData.ivRatio.toFixed(2)}
                                </span>
                            </span>
                        )}
                    </div>
                </div>
                <div className="text-right shrink-0">
                    <div className={`text-2xl sm:text-3xl font-bold tracking-tight leading-none ${pnlColor}`}>
                        {formatPercent(unrealizedPnLPct)}
                    </div>
                    <div className={`text-xs sm:text-sm font-mono ${pnlColor} mb-1`}>
                        {unrealizedPnL >= 0 ? '+' : ''}{formatCurrency(unrealizedPnL)}
                    </div>
                    <div className={`text-[10px] sm:text-xs font-mono font-medium ${realizedPnL > 0 ? 'text-accent-green' : realizedPnL < 0 ? 'text-accent-red' : 'text-text-tertiary'} flex items-center justify-end gap-1`}>
                        <span className="text-text-tertiary text-[10px] uppercase tracking-wider hidden sm:inline">Realized</span>
                        {realizedPnL !== 0 ? (realizedPnL > 0 ? '+' : '') + formatCurrency(realizedPnL) : '—'}
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
                        <span key={i} className={`badge ${alertLevel === 'danger' ? 'badge-red' : alertLevel === 'success' ? 'badge-green' : 'badge-yellow'}`}>
                            {a}
                        </span>
                    ))}
                </div>
            )}

            {/* Metrics Grid */}
            <div className="flex flex-col gap-4 mb-4 py-4 border-y border-border-default">
                {/* Row 1: Trade Management */}
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 sm:gap-4">
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
                        <div className="mb-1 flex items-center gap-1 h-5">
                            <Tooltip label="Target" explanation="Profit Target Price. Click to edit." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                            <button
                                onClick={() => { setIsEditingTarget(true); setTargetInput(targetPrice.toString()); }}
                                className="text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
                                aria-label="Edit target"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                            </button>
                        </div>
                        {isEditingTarget ? (
                            <div className="flex items-center gap-1">
                                <input
                                    type="number"
                                    step="0.01"
                                    value={targetInput}
                                    onChange={e => setTargetInput(e.target.value)}
                                    className="w-16 px-1 py-0.5 text-sm bg-bg-secondary rounded border border-border-default font-mono"
                                    autoFocus
                                />
                                <button onClick={handleTargetSave} className="text-accent-green hover:bg-accent-green/10 p-0.5 rounded cursor-pointer">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                </button>
                                <button onClick={() => setIsEditingTarget(false)} className="text-accent-red hover:bg-accent-red/10 p-0.5 rounded cursor-pointer">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                </button>
                            </div>
                        ) : (
                            <div className="metric-value text-accent-green">{formatPrice(targetPrice)}</div>
                        )}
                    </div>
                    {/* Current */}
                    <div>
                        <div className="mb-1 flex items-center h-5">
                            <Tooltip label="Current" explanation={isCreditStrategy ? "Cost to Close" : "Liquidation Value"} className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value text-text-primary">{currentPrice ? formatPrice(currentPrice) : '—'}</div>
                    </div>
                    {/* Stop (only if user-set) */}
                    <div>
                        <div className="mb-1 flex items-center gap-1 h-5">
                            <Tooltip label="Stop" explanation="Optional stop price. Credit spreads have defined risk — no stop needed." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                            <button
                                onClick={() => { setIsEditingStop(true); setStopInput((currentStopLoss ?? '').toString()); }}
                                className="text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
                                aria-label="Edit stop"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                            </button>
                        </div>
                        {isEditingStop ? (
                            <div className="flex items-center gap-1">
                                <input
                                    type="number"
                                    step="0.01"
                                    value={stopInput}
                                    onChange={e => setStopInput(e.target.value)}
                                    className="w-16 px-1 py-0.5 text-sm bg-bg-secondary rounded border border-border-default font-mono"
                                    autoFocus
                                />
                                <button onClick={handleStopSave} className="text-accent-green hover:bg-accent-green/10 p-0.5 rounded cursor-pointer">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                </button>
                                <button onClick={() => setIsEditingStop(false)} className="text-accent-red hover:bg-accent-red/10 p-0.5 rounded cursor-pointer">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                </button>
                            </div>
                        ) : (
                            <div className={`metric-value ${currentStopLoss != null ? 'text-accent-red' : 'text-text-tertiary'}`}>
                                {currentStopLoss != null ? formatPrice(currentStopLoss) : '—'}
                            </div>
                        )}
                    </div>
                    {/* DTE */}
                    <div>
                        <div className="mb-1 flex items-center h-5">
                            <Tooltip label="DTE" explanation="Days to expiration." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className={`metric-value font-bold ${
                            daysToExp <= 7 ? 'text-accent-red' :
                            daysToExp <= 14 ? 'text-accent-yellow' :
                            'text-accent-green'
                        }`}>
                            {daysToExp}d
                        </div>
                    </div>
                </div>



                {/* Row 3: Greeks & IV Rank */}
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 sm:gap-4 pt-4 border-t border-border-light/50">
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
                            <Tooltip label="IV Rank" explanation="IV percentile at entry. Swing target: ≥30%, Short-term: ≥20%." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className={`metric-value font-bold ${
                            position.iv_rank_entry == null ? 'text-text-tertiary' :
                            (position.iv_rank_entry <= 1 ? position.iv_rank_entry * 100 : position.iv_rank_entry) >= 30 ? 'text-accent-green' :
                            (position.iv_rank_entry <= 1 ? position.iv_rank_entry * 100 : position.iv_rank_entry) >= 20 ? 'text-accent-yellow' : 'text-accent-red'
                        }`}>
                            {position.iv_rank_entry != null ? `${Math.round(position.iv_rank_entry <= 1 ? position.iv_rank_entry * 100 : position.iv_rank_entry)}%` : '—'}
                        </div>
                    </div>
                </div>
            </div>

            {/* TP Progress Bar */}
            {tpProgress != null && entryPrice > 0 && (
                <div className="mb-4">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="text-text-tertiary uppercase tracking-wider font-medium">
                            TP Progress ({Math.round(tpFraction * 100)}%)
                        </span>
                        <span className={`font-mono font-semibold ${tpReady ? 'text-accent-green' : 'text-text-secondary'}`}>
                            {Math.min(tpProgress, 999).toFixed(0)}%
                        </span>
                    </div>
                    <div className="h-1.5 bg-bg-secondary rounded-full overflow-hidden">
                        <div
                            className={`h-full rounded-full transition-all duration-500 ${
                                tpReady ? 'bg-accent-green' :
                                tpProgress >= 70 ? 'bg-accent-yellow' :
                                'bg-text-tertiary'
                            }`}
                            style={{ width: `${Math.min(tpProgress, 100)}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Notes */}
            <div className="mb-4">
                {isEditingNotes ? (
                    <div className="space-y-2">
                        <textarea
                            value={notesInput}
                            onChange={e => setNotesInput(e.target.value)}
                            placeholder="Trade notes — why you entered, adjustments, review..."
                            className="w-full px-3 py-2 text-sm bg-bg-secondary rounded-lg border border-border-default text-text-primary resize-none"
                            rows={3}
                            autoFocus
                        />
                        <div className="flex gap-2">
                            <button
                                onClick={() => { updateNotesMut.mutate({ id: position.id, notes: notesInput }); setIsEditingNotes(false); }}
                                className="text-xs px-3 py-1.5 bg-accent-green/20 text-accent-green rounded-lg font-medium"
                            >Save</button>
                            <button onClick={() => setIsEditingNotes(false)} className="text-xs px-3 py-1.5 text-text-tertiary hover:text-text-primary">Cancel</button>
                        </div>
                    </div>
                ) : (
                    <button
                        onClick={() => { setIsEditingNotes(true); setNotesInput(position.notes || position.stop_reason || ''); }}
                        className="text-xs text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer flex items-center gap-1.5"
                    >
                        {position.notes || position.stop_reason ? (
                            <span className="text-text-secondary truncate max-w-[300px]" title={position.notes || position.stop_reason || ''}>
                                {position.notes || position.stop_reason}
                            </span>
                        ) : (
                            <span>+ Add notes</span>
                        )}
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                    </button>
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
                {isExpanded && (
                    <div className="mt-3 p-3 rounded-lg bg-bg-secondary/30 border border-border-default">
                        <GreeksHistoryChart data={historyData} loading={historyLoading} />
                    </div>
                )}
            </div>

            {/* Action Buttons */}
            {!actionMode ? (
                <div className="flex flex-wrap gap-2">
                    <button onClick={() => void fetchGreeksAndPrice()} disabled={loading} className="action-btn btn-secondary flex items-center justify-center gap-1.5 cursor-pointer px-2.5 sm:px-3" aria-label="Refresh price">
                        {loading ? <div className="spinner w-4 h-4" /> : <RefreshCw size={15} />}
                        <span className="hidden sm:inline text-sm">Refresh</span>
                    </button>
                    <button onClick={() => setActionMode('Add')} className="action-btn btn-secondary text-sm">+ Add</button>
                    <button onClick={() => setActionMode('TakeProfit')} className="action-btn btn-secondary text-sm">Profit</button>
                    {onRollClick && (
                        <button onClick={() => onRollClick(totalQty)} className="action-btn btn-secondary text-text-secondary hover:text-white flex items-center gap-1 text-sm">
                            <ArrowRightLeft size={14} /> Roll
                        </button>
                    )}
                    <button onClick={() => setActionMode('Close')} className="action-btn btn-secondary text-text-secondary hover:text-accent-red hover:bg-accent-red/10 text-sm">Close</button>
                    <button onClick={() => onDelete(position.id)} className="action-btn btn-secondary text-text-tertiary hover:text-accent-red hover:bg-accent-red/10 px-2.5" aria-label="Delete Position">
                        <Trash2 size={15} />
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
                    {actionMode === 'Close' && (
                        <div className="space-y-2">
                            <p className="text-xs text-text-tertiary">Why are you closing?</p>
                            <div className="flex flex-wrap gap-2">
                                {(['TP', 'SL', 'TIME', 'MANUAL'] as const).map(t => (
                                    <button
                                        key={t}
                                        onClick={() => setCloseExitType(t)}
                                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                                            closeExitType === t
                                                ? 'bg-accent-green/20 text-accent-green border-accent-green/40'
                                                : 'bg-[#2C2C2E] text-text-tertiary border-[#3A3A3C] hover:text-white'
                                        }`}
                                    >
                                        {t === 'TP' ? 'Profit Target' : t === 'SL' ? 'Stop Loss' : t === 'TIME' ? 'Time Stop' : 'Manual'}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="flex gap-2">
                        <button onClick={() => { setActionMode(null); setCloseExitType('MANUAL'); }} className="flex-1 py-3 btn-secondary rounded-xl">Cancel</button>
                        {actionMode === 'Close' && (
                            <button onClick={() => handleAction('Close', closeExitType)}
                                disabled={!actionPrice || loading} className="flex-1 py-3 btn-primary rounded-xl">
                                {loading ? '...' : 'Confirm Close'}
                            </button>
                        )}
                        {actionMode !== 'Close' && (
                            <button onClick={() => handleAction(actionMode === 'Add' ? 'Size Up' : 'Take Profit')}
                                disabled={!actionPrice || loading} className="flex-1 py-3 btn-primary rounded-xl">
                                {loading ? '...' : 'Confirm'}
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export const PositionCard = React.memo(PositionCardInner, (prev, next) => {
    return prev.position.id === next.position.id
        && prev.position.current_score === next.position.current_score
        && prev.position.status === next.position.status
        && prev.refreshTrigger === next.refreshTrigger
        && prev.initialData === next.initialData
        && prev.portfolioTotal === next.portfolioTotal;
});
