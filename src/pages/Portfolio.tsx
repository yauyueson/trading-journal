import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { RefreshCw, ChevronDown, Settings2 } from 'lucide-react';
import { Position, Transaction, PositionAction, DirectAddItem, RollData } from '../lib/types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { PositionCard } from '../components/PositionCard';
import { RollModal } from '../components/RollModal';
import { DataFooter } from '../components/DataFooter';
import { PortfolioSettingsForm } from '../components/PortfolioSettingsForm';
import { QuickAddPositionForm } from '../components/QuickAddPositionForm';
import { PortfolioGreeksWidget } from '../components/PortfolioGreeksWidget';
import { useAppSettings } from '../context/AppSettingsContext';
import { getProfile, RETIRED_STRATEGIES, type StrategyType } from '../lib/strategyProfiles';
import { getPositionRiskAtStopOutDollars, aggregatePortfolioGreeks } from '../lib/riskSizing';
import { formatCurrency, daysUntil, groupTransactionsByPositionId } from '../lib/utils';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';
import { useAutoCloseStuckPositions } from '../hooks/useAutoCloseStuckPositions';
import { useOptionPrices, type OptionPriceLeg } from '../hooks/useOptionPrices';
import { useEarningsLookup } from '../hooks/useEarningsLookup';
import {
    usePositionAction,
    useUpdateScore,
    useUpdatePrice,
    useUpdateTarget,
    useUpdateStop,
    useUpdateOwner,
    useUpdatePaper,
    useAddDirect,
    useRollPosition,
    useDeletePosition,
} from '../hooks/usePositionMutations';

interface PortfolioPageProps {
    positions?: Position[];
    transactions?: Transaction[];
    onAction?: (id: string, action: PositionAction, exitType?: Position['exit_type']) => Promise<void>;
    onUpdateScore?: (id: string, score: number) => Promise<void>;
    onUpdatePrice?: (id: string, price: number) => Promise<void>;
    onUpdateTarget?: (id: string, target: number) => Promise<void>;
    onUpdateStop?: (id: string, stopPrice: number) => Promise<void>;
    onUpdateOwner?: (id: string, owner: 'Yuchen' | 'Annie' | null) => Promise<void>;
    onAddDirect?: (item: DirectAddItem) => Promise<void>;
    onRoll?: (originalPositionId: string, rollData: RollData) => Promise<void>;
    onDelete?: (id: string) => Promise<void>;
    loading?: boolean;
}

export const PortfolioPage: React.FC<PortfolioPageProps> = (props) => {
    // React Query hooks as fallbacks when props not provided
    const { data: positionsQuery = [], isLoading: positionsLoading } = usePositions();
    const { data: transactionsQuery = [], isLoading: transactionsLoading } = useTransactions();
    const positionActionMut = usePositionAction();
    const updateScoreMut = useUpdateScore();
    const updatePriceMut = useUpdatePrice();
    const updateTargetMut = useUpdateTarget();
    const updateStopMut = useUpdateStop();
    const updateOwnerMut = useUpdateOwner();
    const updatePaperMut = useUpdatePaper();
    const addDirectMut = useAddDirect();
    const rollPositionMut = useRollPosition();
    const deletePositionMut = useDeletePosition();

    const positions = props.positions ?? positionsQuery;
    const transactions = props.transactions ?? transactionsQuery;
    const loading = props.loading ?? (positionsLoading || transactionsLoading);

    // Pre-index transactions by position_id to avoid N+1 filtering (was 40+ filter ops per render)
    const transactionsByPosition = useMemo(
        () => groupTransactionsByPositionId(transactions),
        [transactions],
    );

    // Stable callbacks — useCallback prevents cascading re-renders through PositionCard memo
    const defaultOnAction = useCallback(async (id: string, action: PositionAction, exitType?: Position['exit_type']) => { await positionActionMut.mutateAsync({ id, action, exitType }); }, [positionActionMut]);
    const defaultOnUpdateScore = useCallback(async (id: string, score: number) => { await updateScoreMut.mutateAsync({ id, score }); }, [updateScoreMut]);
    const defaultOnUpdatePrice = useCallback(async (id: string, price: number) => { await updatePriceMut.mutateAsync({ id, price }); }, [updatePriceMut]);
    const defaultOnUpdateTarget = useCallback(async (id: string, target: number) => { await updateTargetMut.mutateAsync({ id, target }); }, [updateTargetMut]);
    const defaultOnUpdateStop = useCallback(async (id: string, stopPrice: number) => { await updateStopMut.mutateAsync({ id, stopPrice }); }, [updateStopMut]);
    const defaultOnUpdateOwner = useCallback(async (id: string, owner: 'Yuchen' | 'Annie' | null) => { await updateOwnerMut.mutateAsync({ id, owner }); }, [updateOwnerMut]);
    const onUpdatePaper = useCallback(async (id: string, isPaper: boolean) => { await updatePaperMut.mutateAsync({ id, isPaper }); }, [updatePaperMut]);
    const defaultOnAddDirect = useCallback(async (item: DirectAddItem) => { await addDirectMut.mutateAsync(item); }, [addDirectMut]);
    const onAction = props.onAction ?? defaultOnAction;
    const onUpdateScore = props.onUpdateScore ?? defaultOnUpdateScore;
    const onUpdatePrice = props.onUpdatePrice ?? defaultOnUpdatePrice;
    const onUpdateTarget = props.onUpdateTarget ?? defaultOnUpdateTarget;
    const onUpdateStop = props.onUpdateStop ?? defaultOnUpdateStop;
    const onUpdateOwner = props.onUpdateOwner ?? defaultOnUpdateOwner;
    const onAddDirect = props.onAddDirect ?? defaultOnAddDirect;
    const onRoll = props.onRoll ?? (async (originalPositionId: string, rollData: RollData) => {
        const originalPosition = positions.find(p => p.id === originalPositionId);
        if (originalPosition) await rollPositionMut.mutateAsync({ originalPosition, rollData });
    });
    const onDelete = props.onDelete ?? (async (id: string) => {
        if (window.confirm('Are you sure you want to permanently delete this position? This cannot be undone.')) {
            await deletePositionMut.mutateAsync(id);
        }
    });
    const { settings, maxRiskPerTrade, stopOutFraction, activeStrategy } = useAppSettings();
    const profile = getProfile(activeStrategy);
    const { accountSize: portfolioTotal, riskPct, stopOutPct } = settings.portfolio;
    const [showForm, setShowForm] = useState(false);
    const [showAccountSettings, setShowAccountSettings] = useState(false);
    const [rollingPosition, setRollingPosition] = useState<{ position: Position, qty: number } | null>(null);
    const [sortBy] = useState('expiration');
    const [ownerFilter, setOwnerFilter] = useState<'All' | 'Yuchen' | 'Annie'>('All');
    const [strategyFilter, setStrategyFilter] = useState<'All' | 'bcd' | 'pmcc' | 'legacy' | 'untagged'>('All');
    const [paperFilter, setPaperFilter] = useState<'all' | 'paper' | 'live'>('all');
    const [lastTimestamp, setLastTimestamp] = useState<string | null>(null);
    const [refreshTrigger, setRefreshTrigger] = useState(0);

    // Auto-close active positions that have 0 remaining quantity (stuck from prior bug)
    useAutoCloseStuckPositions(positions, transactions);

    const allActivePositions = useMemo(
        () => positions.filter(p => p.status === 'active'),
        [positions],
    );
    const ownerFiltered = useMemo(
        () => ownerFilter === 'All' ? allActivePositions : allActivePositions.filter(p => p.owner === ownerFilter),
        [allActivePositions, ownerFilter],
    );
    const strategyFiltered = useMemo(() => {
        if (strategyFilter === 'All') return ownerFiltered;
        if (strategyFilter === 'untagged') return ownerFiltered.filter(p => !p.strategy_type);
        if (strategyFilter === 'legacy') return ownerFiltered.filter(p => p.strategy_type && RETIRED_STRATEGIES.has(p.strategy_type as StrategyType));
        return ownerFiltered.filter(p => p.strategy_type === strategyFilter);
    }, [ownerFiltered, strategyFilter]);
    const activePositions = useMemo(() => {
        if (paperFilter === 'all') return strategyFiltered;
        if (paperFilter === 'paper') return strategyFiltered.filter(p => p.is_paper);
        return strategyFiltered.filter(p => !p.is_paper);
    }, [strategyFiltered, paperFilter]);

    const legsToFetch = useMemo<OptionPriceLeg[]>(() => {
        return activePositions.flatMap(pos => {
            if (pos.legs && pos.legs.length > 0) {
                return pos.legs.map(leg => ({
                    ticker: pos.ticker,
                    expiration: leg.expiration,
                    strike: leg.strike,
                    type: leg.type,
                    id: pos.id,
                }));
            }
            return [{
                ticker: pos.ticker,
                expiration: pos.expiration,
                strike: pos.strike,
                type: pos.type,
                id: pos.id,
            }];
        });
    }, [activePositions]);
    const optionPricesQuery = useOptionPrices(legsToFetch, !loading && legsToFetch.length > 0);
    const bulkData = useMemo<Record<string, any[]>>(() => {
        const grouped: Record<string, any[]> = {};
        for (const result of optionPricesQuery.data ?? []) {
            if (!result.id || result.success === false) continue;
            if (!grouped[result.id]) grouped[result.id] = [];
            grouped[result.id].push(result);
        }
        return grouped;
    }, [optionPricesQuery.data]);
    const failedPricePositionIds = useMemo(() => {
        if (optionPricesQuery.isError) return new Set(activePositions.map(p => p.id));
        if (!optionPricesQuery.isSuccess) return new Set<string>();
        const failedIds = new Set<string>();
        for (const result of optionPricesQuery.data ?? []) {
            if (result.id && result.success === false) failedIds.add(result.id);
        }
        for (const position of activePositions) {
            if (!bulkData[position.id]) failedIds.add(position.id);
        }
        return failedIds;
    }, [activePositions, bulkData, optionPricesQuery.data, optionPricesQuery.isError, optionPricesQuery.isSuccess]);
    const failedPricePositionKey = useMemo(
        () => [...failedPricePositionIds].sort().join('|'),
        [failedPricePositionIds],
    );
    const earningsTickers = useMemo(() => activePositions.map(p => p.ticker), [activePositions]);
    const earningsLookup = useEarningsLookup(earningsTickers);
    const fetchEarningsForTicker = useCallback(async (ticker: string) => {
        const key = ticker.toUpperCase();
        return earningsLookup.data?.[key] ?? { date: null, daysUntil: null };
    }, [earningsLookup.data]);

    // ... (risk calc unchanged)
    const totalRiskDollars = activePositions.reduce((sum, position) => {
        const posTxns = transactionsByPosition[position.id] ?? [];
        let totalQtyBought = 0, totalQtySold = 0, totalCostBasis = 0;
        posTxns.forEach(t => {
            const qty = t.quantity;
            if (qty > 0) {
                totalQtyBought += qty;
                totalCostBasis += qty * Math.abs(t.price);
            } else {
                totalQtySold += Math.abs(qty);
            }
        });
        const totalQty = totalQtyBought - totalQtySold;
        const avgPrice = totalQtyBought > 0 ? totalCostBasis / totalQtyBought : 0;
        return sum + getPositionRiskAtStopOutDollars(position, totalQty, avgPrice, stopOutFraction);
    }, 0);
    const totalRiskPct = portfolioTotal > 0 ? (totalRiskDollars / portfolioTotal) * 100 : 0;

    // Portfolio-level Greeks aggregation + concentration warnings from shared utility
    const portfolioGreeks = useMemo(() => {
        return aggregatePortfolioGreeks(activePositions, transactions, bulkData, portfolioTotal, stopOutFraction);
    }, [activePositions, bulkData, transactions, portfolioTotal, stopOutFraction]);

    const sortedPositions = useMemo(() => [...activePositions].sort((a, b) => {
        switch (sortBy) {
            case 'expiration':
                return new Date(a.expiration).getTime() - new Date(b.expiration).getTime();
            case 'ticker':
                return a.ticker.localeCompare(b.ticker);
            case 'created':
                return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
            default:
                return 0;
        }
    }), [activePositions, sortBy]);

    const rollClickHandlers = useMemo(() => {
        const handlers: Record<string, (qty: number) => void> = {};
        for (const position of sortedPositions) {
            handlers[position.id] = (qty: number) => setRollingPosition({ position, qty });
        }
        return handlers;
    }, [sortedPositions]);

    const refreshAllPrices = async () => {
        if (legsToFetch.length === 0) return;
        const result = await optionPricesQuery.refetch();
        if (result.data) setLastTimestamp(new Date().toISOString());
    };

    useEffect(() => {
        if (optionPricesQuery.data) setLastTimestamp(new Date().toISOString());
    }, [optionPricesQuery.data]);

    useEffect(() => {
        if (failedPricePositionKey) setRefreshTrigger(prev => prev + 1);
    }, [failedPricePositionKey]);


    if (loading) return <LoadingSpinner />;

    return (
        <div className="stagger-fade-in pb-24 sm:pb-0 space-y-6">
            {/* Header — full width above both columns */}
            <div className="flex justify-between items-start">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-text-primary to-text-secondary bg-clip-text text-transparent">
                        Portfolio
                    </h1>
                    <p className="text-text-secondary text-sm mt-1 hidden sm:block">Manage open positions and track performance</p>
                    {activePositions.length > 0 && portfolioTotal > 0 && (
                        <p className="text-xs sm:text-sm text-text-tertiary mt-1.5 sm:mt-2 font-mono">
                            Risk: <span className={totalRiskPct > 10 ? 'text-accent-red font-semibold' : 'text-text-primary'}>{formatCurrency(totalRiskDollars)}</span>
                            {' '}<span className={totalRiskPct > 10 ? 'text-accent-red font-semibold' : ''}>({totalRiskPct.toFixed(1)}%)</span>
                        </p>
                    )}
                </div>
                {/* Mobile: only add button. Desktop: full row */}
                <div className="flex items-center gap-2 sm:gap-3">
                    <button
                        onClick={refreshAllPrices}
                        disabled={optionPricesQuery.isFetching}
                        className={`
                            relative overflow-hidden group flex items-center gap-2 p-2.5 sm:px-4 sm:py-2 rounded-xl border border-white/[0.06]
                            bg-white/[0.03] hover:bg-white/[0.05] transition-all duration-200
                            ${optionPricesQuery.isFetching ? 'opacity-70 cursor-not-allowed text-text-tertiary' : 'text-text-secondary hover:text-text-primary hover:border-text-secondary/30'}
                        `}
                        aria-label="Refresh all prices"
                    >
                        <RefreshCw size={18} className={`transition-transform duration-500 ${optionPricesQuery.isFetching ? 'animate-spin' : 'group-hover:rotate-180'}`} />
                        <span className="font-medium text-sm hidden sm:inline">{optionPricesQuery.isFetching ? 'Refreshing...' : 'Refresh All'}</span>
                    </button>
                    <button
                        onClick={() => setShowForm(!showForm)}
                        className="flex items-center gap-1.5 sm:gap-2 px-3.5 sm:px-5 py-2.5 sm:py-2 rounded-xl font-medium text-sm text-black shadow-lg transition-all duration-200 bg-accent-green hover:bg-[#5ED4A6] shadow-accent-green/20 hover:shadow-accent-green/30 hover:-translate-y-0.5"
                    >
                        <span className="text-lg leading-none">+</span>
                        <span className="hidden sm:inline">Add Position</span>
                    </button>
                </div>
            </div>

            {/* Two-column layout: sidebar + main content */}
            <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
                {/* Sidebar */}
                <div className="lg:w-1/4 lg:sticky lg:top-20 lg:self-start space-y-4">
                    {/* Filter: Owner */}
                    <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5 block">Owner</span>
                        <div className="flex flex-row lg:flex-col gap-1.5">
                            {(['All', 'Yuchen', 'Annie'] as const).map(value => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => setOwnerFilter(value)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all min-h-[36px] ${ownerFilter === value
                                        ? value === 'Yuchen'
                                            ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                                            : value === 'Annie'
                                                ? 'bg-pink-500/20 text-pink-400 border border-pink-500/40'
                                                : 'bg-white/10 text-text-primary border border-white/20'
                                        : 'bg-bg-secondary/30 text-text-tertiary border border-border-default/50 hover:text-text-secondary'
                                        }`}
                                >
                                    {value}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Filter: Strategy */}
                    <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5 block">Strategy</span>
                        <div className="flex flex-row lg:flex-col gap-1.5">
                            {([['All', 'All'], ['bcd', 'BCD'], ['pmcc', 'PMCC'], ['legacy', 'Legacy'], ['untagged', '\u2014']] as const).map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => setStrategyFilter(value as typeof strategyFilter)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all min-h-[36px] ${strategyFilter === value
                                        ? value === 'bcd'
                                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                            : value === 'pmcc'
                                                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                                                : value === 'legacy'
                                                    ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                                                    : 'bg-white/10 text-text-primary border border-white/20'
                                        : 'bg-bg-secondary/30 text-text-tertiary border border-border-default/50 hover:text-text-secondary'
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Filter: Mode */}
                    <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5 block">Mode</span>
                        <div className="flex flex-row lg:flex-col gap-1.5">
                            {([['all', 'All'], ['paper', 'Paper'], ['live', 'Live']] as const).map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => setPaperFilter(value as typeof paperFilter)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all min-h-[36px] ${paperFilter === value
                                        ? value === 'paper'
                                            ? 'bg-orange-500/20 text-orange-400 border border-orange-500/40'
                                            : value === 'live'
                                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                                : 'bg-white/10 text-text-primary border border-white/20'
                                        : 'bg-bg-secondary/30 text-text-tertiary border border-border-default/50 hover:text-text-secondary'
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Settings toggle */}
                    <button
                        type="button"
                        onClick={() => setShowAccountSettings(!showAccountSettings)}
                        className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl border border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.05] text-text-secondary hover:text-text-primary text-xs sm:text-sm font-medium transition-colors w-full"
                        aria-expanded={showAccountSettings}
                    >
                        <Settings2 size={16} className="text-accent-green shrink-0" />
                        <span className="font-mono truncate min-w-0">
                            <span className="hidden lg:inline">Portfolio {formatCurrency(portfolioTotal)} · Risk {riskPct}% · Stop {stopOutPct}% · Cap {formatCurrency(maxRiskPerTrade)}/trade</span>
                            <span className="lg:hidden hidden sm:inline">Portfolio {formatCurrency(portfolioTotal)} · Risk {riskPct}% · Stop {stopOutPct}% · Cap {formatCurrency(maxRiskPerTrade)}/trade</span>
                            <span className="sm:hidden truncate">{formatCurrency(portfolioTotal)} · {riskPct}% · {formatCurrency(maxRiskPerTrade)}/trade</span>
                        </span>
                        <ChevronDown size={16} className={`text-gray-500 transition-transform shrink-0 ${showAccountSettings ? 'rotate-180' : ''}`} />
                    </button>

                    {/* Collapsible Account & Risk Settings */}
                    {showAccountSettings && (
                        <div className="rounded-xl border border-white/[0.06] bg-bg-secondary/10 p-6">
                            <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-4">Account & risk</h3>
                            <PortfolioSettingsForm variant="full" className="max-w-md" />
                        </div>
                    )}
                </div>

                {/* Main content */}
                <div className="lg:w-3/4 space-y-4">
                    {/* Portfolio Greeks Aggregation Widget */}
                    {portfolioGreeks && <PortfolioGreeksWidget greeks={portfolioGreeks} />}

                    {/* Summary Strip */}
                    {activePositions.length > 0 && (() => {
                        const bcdCount = activePositions.filter(p => p.strategy_type === 'bcd').length;
                        const pmccCount = activePositions.filter(p => p.strategy_type === 'pmcc').length;
                        const legacyCount = activePositions.filter(p => p.strategy_type && RETIRED_STRATEGIES.has(p.strategy_type as StrategyType)).length;
                        const untaggedCount = activePositions.length - bcdCount - pmccCount - legacyCount;
                        const dailyTheta = portfolioGreeks?.netTheta ?? 0;

                        // Find nearest expiring position
                        const nearest = [...activePositions].sort((a, b) =>
                            daysUntil(a.expiration) - daysUntil(b.expiration)
                        )[0];
                        const nearestDTE = nearest ? daysUntil(nearest.expiration) : null;
                        // Time-stop threshold: legacy shortTerm = 1d, everything else = 3d (closest to expiry urgency for BCD/PMCC short legs)
                        const timeStopThreshold = nearest?.strategy_type === 'shortTerm' ? 1 : 3;
                        const nearestUrgent = nearestDTE != null && nearestDTE <= timeStopThreshold;

                        return (
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2.5 border-b border-white/[0.04] text-xs font-mono mb-4">
                                <span className="text-text-tertiary">
                                    {bcdCount > 0 && <span className="text-emerald-400">{bcdCount} BCD</span>}
                                    {bcdCount > 0 && pmccCount > 0 && <span className="text-text-tertiary"> / </span>}
                                    {pmccCount > 0 && <span className="text-blue-400">{pmccCount} PMCC</span>}
                                    {legacyCount > 0 && <span className="text-amber-400"> · {legacyCount} legacy</span>}
                                    {untaggedCount > 0 && <span className="text-text-tertiary"> + {untaggedCount}</span>}
                                </span>
                                {dailyTheta !== 0 && (
                                    <span className="text-text-secondary">
                                        <span className="text-accent-green font-semibold">${(dailyTheta * 100).toFixed(0)}</span>/day theta
                                    </span>
                                )}
                                {nearest && nearestDTE != null && (
                                    <span className={nearestUrgent ? 'text-accent-red font-semibold' : 'text-text-secondary'}>
                                        Next: {nearest.ticker} {nearestDTE}d
                                        {nearestUrgent && ' — close now'}
                                    </span>
                                )}
                            </div>
                        );
                    })()}

                    {/* Quick Add Form */}
                    {showForm && (
                        <QuickAddPositionForm
                            onAddDirect={onAddDirect}
                            onClose={() => setShowForm(false)}
                            profile={profile}
                            activeStrategy={activeStrategy}
                        />
                    )}

                    {activePositions.length === 0 ? (
                        <div className="text-center py-20 text-text-tertiary">
                            No active positions. Click "Add Position" to start tracking.
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {sortedPositions.map((position, index) => (
                                <PositionCard
                                    key={position.id}
                                    position={position}
                                    transactions={transactionsByPosition[position.id] ?? []}
                                    onAction={onAction}
                                    onUpdateScore={onUpdateScore}
                                    onUpdatePrice={onUpdatePrice}
                                    onUpdateTarget={onUpdateTarget}
                                    onUpdateStop={onUpdateStop}
                                    onUpdateOwner={onUpdateOwner}
                                    onUpdatePaper={onUpdatePaper}
                                    onDelete={onDelete}
                                    onDataUpdate={setLastTimestamp}
                                    refreshTrigger={refreshTrigger}
                                    parentManagedPrices
                                    needsFallbackPriceRefresh={failedPricePositionIds.has(position.id)}
                                    index={index}
                                    onRollClick={rollClickHandlers[position.id]}
                                    portfolioTotal={portfolioTotal}
                                    initialData={bulkData[position.id]}
                                    fetchEarningsForTicker={fetchEarningsForTicker}
                                />
                            ))}
                        </div>
                    )}

                    <DataFooter timestamp={lastTimestamp} />
                </div>
            </div>

            {rollingPosition && (
                <RollModal
                    position={rollingPosition.position}
                    currentQuantity={rollingPosition.qty}
                    onConfirm={async (closeQty, closePrice, newStrike, newType, newExpiration, newQty, newPrice) => {
                        await onRoll(rollingPosition.position.id, {
                            closeQty,
                            closePrice,
                            newStrike,
                            newType,
                            newExpiration,
                            newQty,
                            newPrice
                        });
                        setRollingPosition(null);
                    }}
                    onCancel={() => setRollingPosition(null)}
                />
            )}
        </div>
    );
};
