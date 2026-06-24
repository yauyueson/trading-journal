import React, { useState, useEffect, useCallback } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import { InlineEditField } from './position/InlineEditField';
import { PositionActionForm } from './position/PositionActionForm';
import { NotesEditor } from './position/NotesEditor';
import { LegPanel } from './position/LegPanel';
import { Tooltip } from './Tooltip';
import { Position, Transaction, LiveData, GreeksHistory, PositionAction } from '../lib/types';
import { splitPMCCLegs, cycleRealizedPnL, totalRealizedShortPnL } from '../lib/pmccCycles';
import { computeDiagonalHeadline, computeNetSpreadPrice, debitSpreadTpProgress, computeLegBasedPnL, isCycleRollTransaction } from '../lib/legPnL';
import { GreeksHistoryChart } from './GreeksHistoryChart';
import { saveGreeksHistory, fetchGreeksHistory } from '../lib/greeksHistory';
import { formatDate, formatDateWithYear, formatCurrency, formatPercent, daysUntil, formatPrice, CONTRACT_MULTIPLIER, isCreditStrategy as isCreditStrategyFn } from '../lib/utils';
import { calculateCreditSpreadScore, calculateDebitSpreadScore, calculateSingleLOQWithFactors } from '../lib/scoring';
import { getPositionRiskAtStopOutDollars } from '../lib/riskSizing';
import { STRATEGY_PROFILES, type StrategyType } from '../lib/strategyProfiles';
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
    /**
     * Transactions for THIS position only — caller must pre-filter via
     * `groupTransactionsByPositionId(...)[position.id]` (see Portfolio.tsx,
     * Dashboard.tsx). Passing the global transactions array here will
     * silently aggregate across all positions and produce wrong PnL.
     * A dev-mode assertion enforces this at runtime.
     */
    transactions: Transaction[];
    onAction?: (id: string, action: PositionAction, exitType?: Position['exit_type']) => Promise<void>;
    onUpdateScore?: (id: string, score: number) => Promise<void>;
    onUpdatePrice?: (id: string, price: number) => Promise<void>;
    onUpdateTarget?: (id: string, target: number) => Promise<void>;
    onUpdateStop?: (id: string, stopPrice: number) => Promise<void>;
    onDelete?: (id: string) => Promise<void>;
    onUpdateOwner?: (id: string, owner: 'Yuchen' | 'Annie' | null) => Promise<void>;
    onUpdatePaper?: (id: string, isPaper: boolean) => Promise<void>;
    onDataUpdate?: (timestamp: string) => void;
    refreshTrigger?: number;
    parentManagedPrices?: boolean;
    needsFallbackPriceRefresh?: boolean;
    index?: number;
    onRollClick?: (qty: number) => void;
    onAddLegClick?: () => void;
    portfolioTotal?: number;
    initialData?: any[];
    fetchEarningsForTicker?: (ticker: string) => Promise<{ daysUntil: number | null; date: string | null }>;
}

const PositionCardInner: React.FC<PositionCardProps> = (props) => {
    const {
        position,
        transactions,
        onDataUpdate,
        refreshTrigger = 0,
        parentManagedPrices = false,
        needsFallbackPriceRefresh = false,
        index = 0,
        onRollClick,
        onAddLegClick,
        portfolioTotal: portfolioTotalProp,
        initialData,
        fetchEarningsForTicker,
    } = props;

    // Mutation hooks as fallbacks when callback props not provided
    const positionActionMut = usePositionAction();
    const updatePriceMut = useUpdatePrice();
    const updateTargetMut = useUpdateTarget();
    const updateStopMut = useUpdateStop();
    const updateOwnerMut = useUpdateOwner();
    const updateNotesMut = useUpdateNotes();
    const deletePositionMut = useDeletePosition();

    const onAction = props.onAction ?? (async (id: string, action: PositionAction, exitType?: Position['exit_type']) => { await positionActionMut.mutateAsync({ id, action, exitType }); });
    const defaultOnUpdatePrice = useCallback(async (id: string, price: number) => { await updatePriceMut.mutateAsync({ id, price }); }, [updatePriceMut]);
    const onUpdatePrice = props.onUpdatePrice ?? defaultOnUpdatePrice;
    const onUpdateTarget = props.onUpdateTarget ?? (async (id: string, target: number) => { await updateTargetMut.mutateAsync({ id, target }); });
    const onUpdateStop = props.onUpdateStop ?? (async (id: string, stopPrice: number) => { await updateStopMut.mutateAsync({ id, stopPrice }); });
    const onUpdateOwner = props.onUpdateOwner ?? (async (id: string, owner: 'Yuchen' | 'Annie' | null) => { await updateOwnerMut.mutateAsync({ id, owner }); });
    const onDelete = props.onDelete ?? (async (id: string) => {
        if (window.confirm('Are you sure you want to permanently delete this position? This cannot be undone.')) {
            await deletePositionMut.mutateAsync(id);
        }
    });
    const { settings: appSettings, stopOutFraction } = useAppSettings();
    const portfolioTotal = portfolioTotalProp ?? appSettings.portfolio.accountSize;
    const [loading, setLoading] = useState(false);
    const [liveData, setLiveData] = useState<LiveData>({ delta: undefined, iv: undefined, gamma: undefined, theta: undefined, vega: undefined, score: undefined });
    const [earnings, setEarnings] = useState<{ loading: boolean; date: string | null; days: number | null }>({ loading: true, date: null, days: null });
    const [isExpanded, setIsExpanded] = useState(false);
    const [historyData, setHistoryData] = useState<GreeksHistory[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    const isSpread = !!position.legs && position.legs.length > 0;
    const isCreditStrategy = isCreditStrategyFn(position.type);

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
            } catch {
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
                        // Closed legs (e.g. rolled-off PMCC short cycles) are realized
                        // and need no live quote. They also expire and drop out of the
                        // chain — quoting them returns null and would abort the whole
                        // update below. Use `undefined` (≠ null) so the guard ignores them.
                        if (leg.closedAt) return undefined;
                        const match = effectiveData.find(d =>
                            d.expiration === leg.expiration &&
                            String(d.strike) === String(leg.strike) &&
                            d.type === leg.type
                        );
                        return match || null;
                    });
                } else {
                    const promises = position.legs.map(async (leg) => {
                        // Skip closed legs — see note above (they 404 once expired).
                        if (leg.closedAt) return undefined;
                        const params = new URLSearchParams({ ticker: position.ticker, expiration: normalizeExpiration(leg.expiration), strike: leg.strike.toString(), type: leg.type });
                        const res = await fetch(`/api/option-price?${params}`);
                        return res.ok ? await res.json() : null;
                    });
                    results = await Promise.all(promises);
                }

                // Prevent partial data update (wiping Greeks) if an OPEN leg's request
                // failed (null). Closed legs are `undefined` here and don't count.
                if (results.some(r => r === null)) {
                    setLoading(false);
                    return;
                }

                let netDelta = 0, netGamma = 0, netTheta = 0, netVega = 0;
                let netIv = 0;
                let netPrice = 0;
                let validLegs = 0;

                // Bind to the ACTIVE (open) legs — a rolled-off closed short is
                // `undefined` in results, so the index must point at the live leg.
                const shortIndex = position.legs.findIndex(l => l.side === 'short' && !l.closedAt);
                const longIndex = position.legs.findIndex(l => l.side === 'long' && !l.closedAt);

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
                        // Floor at 0: inverted quotes during low liquidity can produce negative values
                        netPrice = Math.max(0, shortAsk - longBid);
                    } else {
                        // Liquidation Value = Sell Long (Bid) - Buy back Short (Ask)
                        netPrice = Math.max(0, longBid - shortAsk);
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

                // Per-leg mid price for unrealized P&L inside LegPanel.
                // Use mid (midpoint of bid/ask) where available, otherwise fall back
                // to the broker-quoted price field.
                const legPrices: Array<number | undefined> = results.map(d => {
                    if (!d) return undefined;
                    const bid = typeof d.bid === 'number' ? d.bid : undefined;
                    const ask = typeof d.ask === 'number' ? d.ask : undefined;
                    if (bid != null && ask != null && ask > 0) return (bid + ask) / 2;
                    return typeof d.price === 'number' ? Math.abs(d.price) : undefined;
                });

                setLiveData({
                    delta: netDelta,
                    gamma: netGamma,
                    theta: netTheta,
                    vega: netVega,
                    iv: netIv,
                    price: netPrice,
                    score: compositeScore,
                    factors: compositeFactors,
                    legPrices,
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
        } catch { /* price fetch failed — silent */ }
        setLoading(false);
    }, [position.id, position.ticker, position.expiration, position.strike, position.type, position.current_price, isSpread, isCreditStrategy, position.legs, onUpdatePrice, onDataUpdate, initialData]);

    useEffect(() => {
        // Initial load? Try using bulk data if available, otherwise fetch.
        // If initialData is present, it means parent likely fetched already.
        if (initialData) {
            fetchGreeksAndPrice(true);
        } else if (!parentManagedPrices) {
            fetchGreeksAndPrice(false);
        }
    }, [initialData, parentManagedPrices, fetchGreeksAndPrice]); // Re-run when initialData updates (bulk refresh)

    useEffect(() => {
        if (refreshTrigger > 0 && !initialData && (!parentManagedPrices || needsFallbackPriceRefresh)) {
            // Only trigger individual fetch if NO bulk data was provided
            // OR if the refresh trigger is meant to force fallback
            // But Portfolio logic says: if bulk fails, trigger incremented.
            // If bulk succeeds, initialData updates, triggering above effect.
            // So this handles fallback only.
            const delay = index * 200;
            const timeoutId = setTimeout(() => {
                fetchGreeksAndPrice(false);
            }, delay);
            return () => clearTimeout(timeoutId);
        }
    }, [refreshTrigger, index, fetchGreeksAndPrice, initialData, parentManagedPrices, needsFallbackPriceRefresh]);

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

    // Caller contract: `transactions` is pre-filtered for this position.
    // Dev-mode assertion to fail loudly if a future caller forgets.
    if (process.env.NODE_ENV !== 'production') {
        const stray = transactions.find(t => t.position_id !== position.id);
        if (stray) {
            console.error(
                `[PositionCard] received transaction for a different position. Expected position_id=${position.id}, got ${stray.position_id}. Caller must pre-filter via groupTransactionsByPositionId.`,
            );
        }
    }
    const positionTxns = transactions;

    let totalQtyBought = 0, totalCostBasis = 0, totalQtySold = 0;
    positionTxns.forEach(t => {
        const qty = t.quantity;
        const price = t.price * CONTRACT_MULTIPLIER;
        if (qty > 0) { totalQtyBought += qty; totalCostBasis += qty * price; }
        else { totalQtySold += Math.abs(qty); }
    });

    const totalQty = totalQtyBought - totalQtySold;
    const avgCostPerContract = totalQtyBought > 0 ? totalCostBasis / totalQtyBought : 0;
    const avgPrice = avgCostPerContract / CONTRACT_MULTIPLIER;
    const sortedTxns = [...positionTxns].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const firstBuy = sortedTxns.find(t => t.quantity > 0);
    const entryPrice = firstBuy ? Math.abs(firstBuy.price) : 0;

    const currentStopLoss = position.stop_price ?? null;

    const currentPrice = liveData.price !== undefined ? liveData.price : (position.current_price || 0);

    const diagHeadline = position.strategy_type === 'pmcc'
        ? computeDiagonalHeadline(position, liveData.legPrices ?? [])
        : null;

    // Position-level spread price (BCD + PMCC): what the open structure cost to
    // open (entry net debit) vs what it's worth now (current net). Mirrors the
    // per-leg Entry/Current columns at the net level so "what did I pay / what's
    // it worth now" is answerable without summing legs by hand.
    const netSpread = (position.strategy_type === 'bcd' || position.strategy_type === 'pmcc')
        ? computeNetSpreadPrice(position, liveData.legPrices ?? [])
        : null;
    let netSpreadStrip: React.ReactNode = null;
    if (netSpread && netSpread.entry != null) {
        const entryNet = netSpread.entry;
        const currentNet = netSpread.current;
        netSpreadStrip = (
            <div className="flex items-center justify-between px-3 py-2 rounded bg-terminal-black/40 border border-border-default/40 text-xs font-mono">
                <span className="text-text-tertiary uppercase tracking-wider">Net debit</span>
                <span className="flex items-center gap-2">
                    <span className="text-text-tertiary">entry</span>
                    <span className="text-text-primary font-bold">{formatPrice(entryNet)}</span>
                    <span className="text-text-tertiary">→ now</span>
                    <span className={currentNet == null
                        ? 'text-text-tertiary'
                        : currentNet >= entryNet
                            ? 'text-phosphor-green text-glow-green font-bold'
                            : 'text-phosphor-red text-glow-red font-bold'}>
                        {currentNet != null ? formatPrice(currentNet) : '—'}
                    </span>
                </span>
            </div>
        );
    }

    let unrealizedPnL = 0;
    let unrealizedPnLPct = 0;
    // For a PMCC diagonal we only trust leg-aware marks. When they're missing
    // (diagHeadline.known === false) the unrealized headline is unknown — render
    // "—" rather than fall back to the single-instrument path below, which
    // values the long leg's mark as the whole position and ignores the short
    // liability (the source of the fabricated +128.96% / +$6.7K headline).
    let unrealizedKnown = true;

    if (diagHeadline) {
        unrealizedKnown = diagHeadline.known;
        unrealizedPnL = diagHeadline.unrealized;
        unrealizedPnLPct = diagHeadline.unrealizedPct;
    } else if (totalQty > 0 && currentPrice) {
        if (isCreditStrategy) {
            unrealizedPnL = (avgPrice - currentPrice) * totalQty * CONTRACT_MULTIPLIER;
            unrealizedPnLPct = avgPrice > 0 ? (unrealizedPnL / (avgPrice * totalQty * CONTRACT_MULTIPLIER)) * 100 : 0;
        } else {
            const totalValue = totalQty * currentPrice * CONTRACT_MULTIPLIER;
            const totalCost = totalQty * avgCostPerContract;
            unrealizedPnL = totalValue - totalCost;
            unrealizedPnLPct = (totalCost > 0) ? (unrealizedPnL / totalCost) * 100 : 0;
        }
    }

    const stratProfile = position.strategy_type && STRATEGY_PROFILES[position.strategy_type as StrategyType]
        ? STRATEGY_PROFILES[position.strategy_type as StrategyType]
        : null;
    // TP fraction by strategy kind:
    //   diagonal (PMCC): close the WHOLE position at long-leg PT (longProfitTarget,
    //     default 60%). The short-leg cycle PT only closes the short leg, not the
    //     position — so it's not the right anchor for the position-level bar.
    //   debit_spread (BCD): tpFraction of MAX profit (width − net debit), matching
    //     the sealed backtest (worker.ts) — NOT tpFraction of the debit paid.
    //   credit_spread: use the profile's profitTarget.
    //   No profile / unknown: legacy defaults (credit 30% / debit 25%).
    const tpFraction = stratProfile?.kind === 'diagonal'
        ? (stratProfile.longProfitTarget ?? 0.60)
        : (stratProfile?.profitTarget ?? (isCreditStrategy ? 0.30 : 0.25));
    // BCD strike width (per share) from the open legs — the basis of max profit.
    const bcdWidth = stratProfile?.kind === 'debit_spread'
        ? (() => {
            const legs = position.legs ?? [];
            const longLeg = legs.find(l => l.side === 'long' && !l.closedAt);
            const shortLeg = legs.find(l => l.side === 'short' && !l.closedAt);
            return longLeg && shortLeg ? Math.abs(shortLeg.strike - longLeg.strike) : null;
        })()
        : null;
    const calculatedTarget = isCreditStrategy
        ? avgPrice * (1 - tpFraction) // credit: close at (1-TP%) of avg credit
        : (stratProfile?.kind === 'debit_spread' && bcdWidth != null && bcdWidth - avgPrice > 0
            ? avgPrice + tpFraction * (bcdWidth - avgPrice) // debit: entry + tpFraction of max profit
            : avgPrice * (1 + tpFraction));
    // position.target_price is sometimes stored as a fraction (legacy BCD/PMCC entry rows).
    // Treat values < 1 as misuse and ignore them — the entry debit on a real spread
    // is always at least a few dollars, never sub-$1 per contract.
    const targetPriceRaw = position.target_price;
    const targetPrice = (targetPriceRaw != null && targetPriceRaw >= 1)
        ? targetPriceRaw
        : calculatedTarget;

    let realizedPnL = 0;
    // Skip cycle-roll transactions (PMCC short rolls) — their cash flow is
    // already captured at the leg level via openedCredit / closedCost on
    // position.legs, and treating them as open/close exits double-counts.
    positionTxns.forEach(t => {
        if (isCycleRollTransaction(t.note)) return;
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

    // Add leg-level realized P&L (PMCC closed-short cycles, BCD legs once
    // per-leg close prices land). For PMCC, use the same complete leg-aware
    // source as the headline so roll transactions cannot distort basis.
    if (diagHeadline) {
        // diagHeadline.realized is valid even when marks are missing (closed
        // short cycles carry their own openedCredit/closedCost).
        realizedPnL += diagHeadline.realized;
    } else {
        const legPnL = computeLegBasedPnL(position, liveData.legPrices ?? []);
        if (legPnL) realizedPnL += legPnL.realized;
    }

    const daysToExp = daysUntil(position.expiration);

    // TP Progress (0-100%+)
    const tpProgress = stratProfile?.kind === 'diagonal'
        // Diagonal: long-leg PT only off leg-aware marks. No marks → unknown (null),
        // never the single-instrument debit branch (which produced the fake 215%).
        ? (diagHeadline?.known && diagHeadline.basis > 0 && tpFraction > 0
            ? Math.max(0, (diagHeadline.longUnrealized / (diagHeadline.basis * tpFraction)) * 100)
            : null)
        : stratProfile?.kind === 'debit_spread'
            // BCD: +tpFraction of MAX profit (width − net debit), matching the sealed
            // backtest — not +tpFraction of debit paid. Mid-based current net value.
            ? debitSpreadTpProgress({
                entryDebit: avgPrice > 0 ? avgPrice : null,
                currentValue: netSpread?.current ?? null,
                width: bcdWidth,
                tpFraction,
            })
            : (isCreditStrategy && avgPrice > 0 && currentPrice != null)
                ? Math.max(0, ((avgPrice - currentPrice) / (avgPrice * tpFraction)) * 100)
                : (!isCreditStrategy && avgPrice > 0 && currentPrice != null)
                    ? Math.max(0, ((currentPrice - avgPrice) / (avgPrice * tpFraction)) * 100)
                    : null;
    const tpReady = tpProgress != null && tpProgress >= 100;

    // Time Stop thresholds (from strategy profile; DTE5 = 0 = hold-to-expiry)
    const timeStopDTE = stratProfile?.timeStopDTE ?? 3;
    const isTimeStop = timeStopDTE > 0 && daysToExp <= timeStopDTE && daysToExp >= 0;

    const positionRiskAtStopOutDollars = getPositionRiskAtStopOutDollars(position, Math.max(0, totalQty), avgPrice, stopOutFraction);
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
    if (unrealizedKnown && unrealizedPnLPct <= -50) { alerts.push('Heavy Loss'); alertLevel = 'danger'; }
    // DTE warning (approaching but not yet time stop)
    if (alertLevel === 'none' && daysToExp <= 7 && daysToExp > timeStopDTE) {
        alerts.push(`${daysToExp}d left`); alertLevel = 'warning';
    }

    const earningsWarning = earnings.days !== null && earnings.days >= 0 && earnings.days <= 7;
    const earningsImminent = earnings.days !== null && earnings.days >= 0 && earnings.days <= 3;

    // Terminal-panel base + state-driven border tint. Replaces glassy card-* variants on this signature page.
    let cardClass = 'terminal-panel';
    if (alertLevel === 'danger') cardClass = 'terminal-panel terminal-panel-red';
    else if (earningsImminent) cardClass = 'terminal-panel terminal-panel-amber';
    else if (alertLevel === 'warning') cardClass = 'terminal-panel terminal-panel-amber';
    else if (alertLevel === 'success') cardClass = 'terminal-panel border-phosphor-green/45';
    else if (earningsWarning) cardClass = 'terminal-panel terminal-panel-amber';

    const pnlColor = !unrealizedKnown
        ? 'text-text-tertiary'
        : unrealizedPnL >= 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red';

    return (
        <div className={`${cardClass} p-4 sm:p-5 fade-in`}>
            {/* Header */}
            <div className="flex justify-between items-start gap-3 mb-4">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 sm:gap-3 mb-1 flex-wrap">
                        <span className="text-xl sm:text-2xl font-mono font-bold uppercase tracking-wider text-phosphor-green text-glow-green">{position.ticker}</span>
                        {position.strategy_type && (() => {
                            const st = position.strategy_type;
                            // Active strategies (bcd/pmcc) glow phosphor-green; retired (dte5/swing/shortTerm) glow phosphor-amber as a read-only state.
                            const isActive = st === 'bcd' || st === 'pmcc';
                            const badgeClass = isActive
                                ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/30'
                                : 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/30';
                            const label = st === 'bcd' ? 'BCD'
                                : st === 'pmcc' ? 'PMCC'
                                : st === 'dte5' ? 'DTE5'
                                : st === 'swing' ? 'SWING'
                                : 'ST';
                            return (
                                <span className={`inline-block px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider rounded ${badgeClass}`}>
                                    {label}
                                </span>
                            );
                        })()}
                        {props.onUpdatePaper ? (
                            <button
                                onClick={() => props.onUpdatePaper!(position.id, !position.is_paper)}
                                className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded cursor-pointer transition-colors ${
                                    position.is_paper
                                        ? 'bg-orange-500/15 text-orange-400 border border-orange-500/30 border-dashed hover:bg-orange-500/25'
                                        : 'bg-green-500/15 text-green-400 border border-green-500/30 hover:bg-green-500/25'
                                }`}
                                title={position.is_paper ? 'Click to mark as LIVE' : 'Click to mark as PAPER'}
                            >
                                {position.is_paper ? 'PAPER' : 'LIVE'}
                            </button>
                        ) : position.is_paper ? (
                            <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded bg-orange-500/15 text-orange-400 border border-orange-500/30 border-dashed">
                                PAPER
                            </span>
                        ) : null}
                        {onUpdateOwner && (
                            <select
                                value={position.owner || ''}
                                onChange={e => {
                                    const val = e.target.value;
                                    onUpdateOwner(position.id, val === '' ? null : val as 'Yuchen' | 'Annie');
                                }}
                                className={`px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-mono uppercase tracking-wider cursor-pointer transition-colors appearance-none border ${position.owner
                                    ? 'bg-phosphor-green/10 text-phosphor-dim border-phosphor-green/25'
                                    : 'bg-terminal-black text-text-tertiary border-phosphor-green/15'
                                    }`}
                            >
                                <option value="" className="bg-bg-primary text-text-tertiary">▌ —</option>
                                <option value="Yuchen" className="bg-bg-primary text-phosphor-dim">▌ Y · YUCHEN</option>
                                <option value="Annie" className="bg-bg-primary text-phosphor-dim">▌ A · ANNIE</option>
                            </select>
                        )}
                        {isSpread && position.strategy_type === 'pmcc' ? (
                            <div className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm text-text-secondary font-medium uppercase tracking-wide">
                                <span className="text-text-primary">
                                    LEAP&nbsp;${position.legs?.find(l => l.side === 'long' && !l.closedAt)?.strike}C
                                    <span className="mx-1">/</span>
                                    Short&nbsp;${position.legs?.find(l => l.side === 'short' && !l.closedAt)?.strike}C
                                </span>
                                <span className="hidden sm:inline text-[15.5px]">PMCC Diagonal</span>
                                <span className="sm:hidden">PMCC</span>
                            </div>
                        ) : isSpread ? (
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
                                <span className={`font-mono ${position.type?.toLowerCase().includes('call') ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'}`}>
                                    {position.type}
                                </span>
                            </div>
                        )}
                    </div>
                    <div className="text-text-secondary text-xs sm:text-sm flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <span>{formatDateWithYear(position.expiration)}</span>
                        {position.strategy_type === 'dte5' && position.expiration && (() => {
                            const dte = Math.round((new Date(position.expiration + 'T16:00:00').getTime() - Date.now()) / 86400000);
                            return (
                                <span className={`inline-block px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider rounded ${
                                    dte <= 1 ? 'bg-phosphor-red/15 text-phosphor-red text-glow-red' : 'bg-phosphor-amber/15 text-phosphor-amber text-glow-amber'
                                }`}>
                                    {dte <= 0 ? 'EXPIRY' : `DTE ${dte}`}
                                </span>
                            );
                        })()}
                        {position.strategy_type === 'bcd' && (
                            <span className="inline-block px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider rounded bg-phosphor-green/15 text-phosphor-green text-glow-green"
                                title="Bull Call Debit Spread — close at +50% of debit paid">
                                PT 50%
                            </span>
                        )}
                        {position.strategy_type === 'pmcc' && (() => {
                            // PMCC: show short-leg DTE (the rolling leg) — that's the active countdown.
                            const shortLeg = position.legs?.find(l => l.side === 'short');
                            const shortExp = shortLeg?.expiration ?? position.expiration;
                            if (!shortExp) return null;
                            const shortDte = Math.round((new Date(shortExp + 'T16:00:00').getTime() - Date.now()) / 86400000);
                            return (
                                <span className={`inline-block px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider rounded ${
                                    shortDte <= 7 ? 'bg-phosphor-red/15 text-phosphor-red text-glow-red' : 'bg-phosphor-amber/15 text-phosphor-amber'
                                }`}
                                    title="Short-leg DTE — roll when underlying within 2% of short strike or at DTE 7">
                                    Short {shortDte <= 0 ? 'EXP' : `${shortDte}d`}
                                </span>
                            );
                        })()}
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
                            <span className="px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-mono font-medium bg-terminal-black border border-phosphor-green/15 text-text-secondary uppercase tracking-wider" title="IV Ratio">
                                IVR: <span className={liveData.ivRatio > 1.05 ? 'text-phosphor-green text-glow-green' : liveData.ivRatio < 0.95 ? 'text-phosphor-red text-glow-red' : 'text-text-primary'}>
                                    {liveData.ivRatio.toFixed(2)}
                                </span>
                            </span>
                        )}
                    </div>
                </div>
                <div className="text-right shrink-0">
                    <div className={`text-2xl sm:text-3xl font-bold tracking-tight leading-none ${pnlColor}`}>
                        {unrealizedKnown ? formatPercent(unrealizedPnLPct) : '—'}
                    </div>
                    <div className={`text-xs sm:text-sm font-mono ${pnlColor} mb-1`}>
                        {unrealizedKnown ? `${unrealizedPnL >= 0 ? '+' : ''}${formatCurrency(unrealizedPnL)}` : 'no live price'}
                    </div>
                    <div className={`text-[10px] sm:text-xs font-mono font-medium ${realizedPnL > 0 ? 'text-phosphor-green text-glow-green' : realizedPnL < 0 ? 'text-phosphor-red text-glow-red' : 'text-text-tertiary'} flex items-center justify-end gap-1`}>
                        <span className="text-text-tertiary text-[10px] uppercase tracking-wider hidden sm:inline">Realized</span>
                        {realizedPnL !== 0 ? (realizedPnL > 0 ? '+' : '') + formatCurrency(realizedPnL) : '—'}
                    </div>
                </div>
            </div>

            {/* Earnings Banner */}
            {earningsWarning && (
                <div className={`mb-4 p-3 rounded-md flex items-center justify-between terminal-panel ${earningsImminent ? 'border-phosphor-amber/40' : 'border-phosphor-green/20'}`}>
                    <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${earningsImminent ? 'bg-phosphor-amber/10' : 'bg-phosphor-green/10'}`}>
                            <Calendar size={18} className={earningsImminent ? 'text-phosphor-amber' : 'text-phosphor-dim'} />
                        </div>
                        <div>
                            <div className="font-mono font-bold uppercase tracking-wider text-text-primary">
                                {earnings.days === 0 ? '▌ EARNINGS_TODAY' : earnings.days === 1 ? '▌ EARNINGS_TOMORROW' : `▌ EARNINGS_${earnings.days}D`}
                            </div>
                            <div className="text-sm text-text-secondary font-mono">
                                {formatDate(earnings.date)} · Consider position sizing
                            </div>
                        </div>
                    </div>
                    {earningsImminent && (
                        <span className="px-3 py-1 bg-phosphor-amber/15 text-phosphor-amber text-glow-amber border border-phosphor-amber/40 rounded-md text-xs font-mono font-bold uppercase tracking-wider animate-pulse">
                            ▌ ACTION_NEEDED
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

            {/* PMCC-specific body: split LEAP + active short, plus past-shorts collapsible */}
            {position.strategy_type === 'pmcc' && (() => {
                const { closedShorts } = splitPMCCLegs(position);
                const realizedShortPnL = totalRealizedShortPnL(position);
                const legs = position.legs ?? [];
                const longLegIdx = legs.findIndex(l => l.side === 'long' && !l.closedAt);
                const activeShortIdx = legs.findIndex(l => l.side === 'short' && !l.closedAt);
                return (
                    <div className="flex flex-col gap-3 mb-4 py-4 border-y border-border-default">
                        {/* LEAP anchor — clickable to manage (Roll / Close / Edit) */}
                        {longLegIdx >= 0 && (
                            <LegPanel
                                position={position}
                                legIndex={longLegIdx}
                                role="leap"
                                tone="green"
                                title="LEAP_ANCHOR"
                                hint="long δ 0.70-0.80 · PT +60% · SL -35%"
                                currentValue={liveData.legPrices?.[longLegIdx]}
                            />
                        )}

                        {/* Active short — clickable to manage (Roll / Close / Edit) */}
                        {activeShortIdx >= 0 && (
                            <LegPanel
                                position={position}
                                legIndex={activeShortIdx}
                                role="active-short"
                                tone="amber"
                                title="ACTIVE_SHORT"
                                hint="short δ 0.20-0.30 · PT +50% · roll if K within 2%"
                                currentValue={liveData.legPrices?.[activeShortIdx]}
                            />
                        )}

                        {netSpreadStrip}

                        {/* Combined Greeks (compact) */}
                        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 sm:gap-4 pt-2">
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">Delta</div>
                                <div className="metric-value text-text-primary">{liveData.delta !== undefined ? liveData.delta.toFixed(2) : '—'}</div>
                            </div>
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">Gamma</div>
                                <div className="metric-value text-text-primary">{liveData.gamma !== undefined ? liveData.gamma.toFixed(3) : '—'}</div>
                            </div>
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">Theta</div>
                                <div className="metric-value text-text-primary">{liveData.theta !== undefined ? liveData.theta.toFixed(3) : '—'}</div>
                            </div>
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">Vega</div>
                                <div className="metric-value text-text-primary">{liveData.vega !== undefined ? liveData.vega.toFixed(3) : '—'}</div>
                            </div>
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">IV</div>
                                <div className="metric-value text-text-primary">{liveData.iv !== undefined ? (liveData.iv * 100).toFixed(1) + '%' : '—'}</div>
                            </div>
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">Realized rolls</div>
                                <div className={`metric-value font-bold ${realizedShortPnL > 0 ? 'text-phosphor-green text-glow-green' : realizedShortPnL < 0 ? 'text-phosphor-red text-glow-red' : 'text-text-tertiary'}`}>
                                    {closedShorts.length === 0 ? '—' : `${realizedShortPnL >= 0 ? '+' : ''}${formatCurrency(realizedShortPnL)}`}
                                </div>
                            </div>
                        </div>

                        {/* Past shorts collapsible */}
                        {closedShorts.length > 0 && (
                            <details className="text-xs font-mono pt-2">
                                <summary className="cursor-pointer text-text-secondary hover:text-phosphor-dim transition-colors">
                                    Past shorts ({closedShorts.length} {closedShorts.length === 1 ? 'roll' : 'rolls'})
                                </summary>
                                <div className="mt-2 space-y-1">
                                    {closedShorts.map((leg, i) => {
                                        const pnl = cycleRealizedPnL(leg);
                                        return (
                                            <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 rounded bg-terminal-black/50 border border-border-default/40">
                                                <span className="text-text-tertiary text-[10px]">#{closedShorts.length - i}</span>
                                                <span className="text-text-primary">K=${leg.strike}</span>
                                                <span className="text-text-secondary">exp {formatDateWithYear(leg.expiration)}</span>
                                                <span className="text-text-tertiary">cr ${leg.openedCredit?.toFixed(2) ?? '—'} → cl ${leg.closedCost?.toFixed(2) ?? '—'}</span>
                                                {pnl != null && (
                                                    <span className={`ml-auto ${pnl >= 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'}`}>
                                                        {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
                                                    </span>
                                                )}
                                                {leg.closedAt && (
                                                    <span className="text-text-tertiary text-[10px]">{leg.closedAt.slice(0, 10)}</span>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </details>
                        )}
                    </div>
                );
            })()}

            {/* BCD-specific body: long + short LegPanels (debit spread) */}
            {position.strategy_type === 'bcd' && (() => {
                const legs = position.legs ?? [];
                const longIdx = legs.findIndex(l => l.side === 'long');
                const shortIdx = legs.findIndex(l => l.side === 'short');
                return (
                    <div className="flex flex-col gap-3 mb-4 py-4 border-y border-border-default">
                        {longIdx >= 0 && (
                            <LegPanel
                                position={position}
                                legIndex={longIdx}
                                role="long"
                                tone="green"
                                title="LONG_CALL"
                                hint="long δ ≈ 0.50 · pays debit"
                                currentValue={liveData.legPrices?.[longIdx]}
                            />
                        )}
                        {shortIdx >= 0 && (
                            <LegPanel
                                position={position}
                                legIndex={shortIdx}
                                role="short"
                                tone="amber"
                                title="SHORT_CALL"
                                hint="short δ ≈ 0.20 · receives credit · same expiry"
                                currentValue={liveData.legPrices?.[shortIdx]}
                            />
                        )}
                        {netSpreadStrip}

                        {/* Combined Greeks compact */}
                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 sm:gap-4 pt-2">
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">Delta</div>
                                <div className="metric-value text-text-primary">{liveData.delta !== undefined ? liveData.delta.toFixed(2) : '—'}</div>
                            </div>
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">Gamma</div>
                                <div className="metric-value text-text-primary">{liveData.gamma !== undefined ? liveData.gamma.toFixed(3) : '—'}</div>
                            </div>
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">Theta</div>
                                <div className="metric-value text-text-primary">{liveData.theta !== undefined ? liveData.theta.toFixed(3) : '—'}</div>
                            </div>
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">Vega</div>
                                <div className="metric-value text-text-primary">{liveData.vega !== undefined ? liveData.vega.toFixed(3) : '—'}</div>
                            </div>
                            <div>
                                <div className="text-[11px] text-text-tertiary uppercase tracking-wider mb-1">IV</div>
                                <div className="metric-value text-text-primary">{liveData.iv !== undefined ? (liveData.iv * 100).toFixed(1) + '%' : '—'}</div>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* Metrics Grid (non-PMCC, non-BCD) */}
            {position.strategy_type !== 'pmcc' && position.strategy_type !== 'bcd' && (
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
                    <InlineEditField
                        label="Target"
                        value={targetPrice}
                        onSave={v => onUpdateTarget(position.id, v)}
                        formatValue={formatPrice}
                        colorClass="text-phosphor-green text-glow-green"
                        tooltipLabel="Target"
                        tooltipExplanation="Profit Target Price. Click to edit."
                        TooltipComponent={Tooltip}
                    />
                    {/* Current */}
                    <div>
                        <div className="mb-1 flex items-center h-5">
                            <Tooltip label="Current" explanation={isCreditStrategy ? "Cost to Close" : "Liquidation Value"} className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className="metric-value text-text-primary">{currentPrice ? formatPrice(currentPrice) : '—'}</div>
                    </div>
                    {/* Stop (only if user-set) */}
                    <InlineEditField
                        label="Stop"
                        value={currentStopLoss}
                        onSave={v => onUpdateStop(position.id, v)}
                        formatValue={formatPrice}
                        colorClass={currentStopLoss != null ? 'text-phosphor-red text-glow-red' : 'text-text-tertiary'}
                        tooltipLabel="Stop"
                        tooltipExplanation="Optional stop price. Credit spreads have defined risk — no stop needed."
                        TooltipComponent={Tooltip}
                    />
                    {/* DTE */}
                    <div>
                        <div className="mb-1 flex items-center h-5">
                            <Tooltip label="DTE" explanation="Days to expiration." className="text-[11px] text-text-tertiary uppercase tracking-wider" />
                        </div>
                        <div className={`metric-value font-bold ${
                            daysToExp <= 7 ? 'text-phosphor-red text-glow-red' :
                            daysToExp <= 14 ? 'text-phosphor-amber text-glow-amber' :
                            'text-phosphor-green text-glow-green'
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
                            (position.iv_rank_entry <= 1 ? position.iv_rank_entry * 100 : position.iv_rank_entry) >= 30 ? 'text-phosphor-green text-glow-green' :
                            (position.iv_rank_entry <= 1 ? position.iv_rank_entry * 100 : position.iv_rank_entry) >= 20 ? 'text-phosphor-amber text-glow-amber' : 'text-phosphor-red text-glow-red'
                        }`}>
                            {position.iv_rank_entry != null ? `${Math.round(position.iv_rank_entry <= 1 ? position.iv_rank_entry * 100 : position.iv_rank_entry)}%` : '—'}
                        </div>
                    </div>
                </div>
            </div>
            )}

            {/* TP Progress Bar.
                For PMCC the bar tracks the long-leg PT (60%) — the threshold that
                closes the entire position. Short-leg cycles use their own short
                PT (50%) and are managed inside LegPanel. */}
            {tpProgress != null && entryPrice > 0 && (
                <div className="mb-4">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="text-text-tertiary uppercase tracking-wider font-medium">
                            {position.strategy_type === 'pmcc' ? 'Long-leg PT Progress' : 'TP Progress'} ({Math.round(tpFraction * 100)}%)
                        </span>
                        <span className={`font-mono font-semibold ${tpReady ? 'text-phosphor-green text-glow-green' : 'text-text-secondary'}`}>
                            {Math.min(tpProgress, 999).toFixed(0)}%
                        </span>
                    </div>
                    <div className="h-1.5 bg-terminal-black rounded-full overflow-hidden border border-phosphor-green/15">
                        <div
                            className={`h-full rounded-full transition-all duration-500 ${
                                tpReady ? 'bg-phosphor-green' :
                                tpProgress >= 70 ? 'bg-phosphor-amber' :
                                'bg-phosphor-dim/50'
                            }`}
                            style={{ width: `${Math.min(tpProgress, 100)}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Notes */}
            <NotesEditor
                positionId={position.id}
                notes={position.notes}
                stopReason={position.stop_reason}
                onSave={vars => updateNotesMut.mutateAsync(vars)}
            />

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
            <PositionActionForm
                positionId={position.id}
                totalQty={totalQty}
                loading={loading}
                onAction={onAction}
                onDelete={onDelete}
                onRefresh={() => void fetchGreeksAndPrice()}
                onRollClick={onRollClick}
                onAddLegClick={(position.legs?.length ?? 0) <= 1 && position.status === 'active' ? onAddLegClick : undefined}
            />
        </div>
    );
};

// Per-field shallow compare avoids the JSON.stringify cost of the original
// implementation while covering every position field PositionCard reads.
// `legs` reference-equality is sound because React Query produces a fresh
// `positions` array on every cache update — a position whose legs change
// will arrive as a new object with a new `legs` reference. The optimistic
// `setQueryData` path in usePositionFieldUpdate also spreads into a new
// object, preserving the same invariant.
function positionFieldsEqual(a: Position, b: Position): boolean {
    return a.id === b.id
        && a.ticker === b.ticker
        && a.strike === b.strike
        && a.type === b.type
        && a.expiration === b.expiration
        && a.status === b.status
        && a.setup === b.setup
        && a.strategy === b.strategy
        && a.current_score === b.current_score
        && a.current_price === b.current_price
        && a.target_price === b.target_price
        && a.stop_price === b.stop_price
        && a.notes === b.notes
        && a.closed_at === b.closed_at
        && a.legs === b.legs
        && a.owner === b.owner
        && a.strategy_type === b.strategy_type
        && a.is_paper === b.is_paper
        && a.exit_type === b.exit_type;
}

export const PositionCard = React.memo(PositionCardInner, (prev, next) => {
    return positionFieldsEqual(prev.position, next.position)
        && prev.refreshTrigger === next.refreshTrigger
        && prev.parentManagedPrices === next.parentManagedPrices
        && prev.needsFallbackPriceRefresh === next.needsFallbackPriceRefresh
        && prev.initialData === next.initialData
        && prev.portfolioTotal === next.portfolioTotal
        && prev.transactions.length === next.transactions.length
        && prev.transactions === next.transactions;
});
