import React, { useState, useEffect, useMemo } from 'react';
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
import { getProfile } from '../lib/strategyProfiles';
import { getPositionRiskAtStopOutDollars, aggregatePortfolioGreeks } from '../lib/riskSizing';
import { formatCurrency, daysUntil } from '../lib/utils';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';
import {
    usePositionAction,
    useUpdateScore,
    useUpdatePrice,
    useUpdateTarget,
    useUpdateStop,
    useUpdateOwner,
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
    const addDirectMut = useAddDirect();
    const rollPositionMut = useRollPosition();
    const deletePositionMut = useDeletePosition();

    const positions = props.positions ?? positionsQuery;
    const transactions = props.transactions ?? transactionsQuery;
    const loading = props.loading ?? (positionsLoading || transactionsLoading);
    const onAction = props.onAction ?? (async (id: string, action: PositionAction, exitType?: Position['exit_type']) => { positionActionMut.mutate({ id, action, exitType }); });
    const onUpdateScore = props.onUpdateScore ?? (async (id: string, score: number) => { updateScoreMut.mutate({ id, score }); });
    const onUpdatePrice = props.onUpdatePrice ?? (async (id: string, price: number) => { updatePriceMut.mutate({ id, price }); });
    const onUpdateTarget = props.onUpdateTarget ?? (async (id: string, target: number) => { updateTargetMut.mutate({ id, target }); });
    const onUpdateStop = props.onUpdateStop ?? (async (id: string, stopPrice: number) => { updateStopMut.mutate({ id, stopPrice }); });
    const onUpdateOwner = props.onUpdateOwner ?? (async (id: string, owner: 'Yuchen' | 'Annie' | null) => { updateOwnerMut.mutate({ id, owner }); });
    const onAddDirect = props.onAddDirect ?? (async (item: DirectAddItem) => { addDirectMut.mutate(item); });
    const onRoll = props.onRoll ?? (async (originalPositionId: string, rollData: RollData) => {
        const originalPosition = positions.find(p => p.id === originalPositionId);
        if (originalPosition) rollPositionMut.mutate({ originalPosition, rollData });
    });
    const onDelete = props.onDelete ?? (async (id: string) => {
        if (window.confirm('Are you sure you want to permanently delete this position? This cannot be undone.')) {
            deletePositionMut.mutate(id);
        }
    });
    const { settings, maxRiskPerTrade, stopOutFraction, activeStrategy } = useAppSettings();
    const profile = getProfile(activeStrategy);
    const { accountSize: portfolioTotal, riskPct, stopOutPct } = settings.portfolio;
    const [showForm, setShowForm] = useState(false);
    const [showAccountSettings, setShowAccountSettings] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [rollingPosition, setRollingPosition] = useState<{ position: Position, qty: number } | null>(null);
    const [sortBy] = useState('expiration');
    const [ownerFilter, setOwnerFilter] = useState<'All' | 'Yuchen' | 'Annie'>('All');
    const [strategyFilter, setStrategyFilter] = useState<'All' | 'swing' | 'shortTerm' | 'untagged'>('All');
    const [bulkData, setBulkData] = useState<Record<string, any>>({});
    const [lastTimestamp, setLastTimestamp] = useState<string | null>(null);
    const [refreshTrigger, setRefreshTrigger] = useState(0);

    const allActivePositions = positions.filter(p => p.status === 'active');
    const ownerFiltered = ownerFilter === 'All' ? allActivePositions : allActivePositions.filter(p => p.owner === ownerFilter);
    const activePositions = strategyFilter === 'All'
        ? ownerFiltered
        : strategyFilter === 'untagged'
            ? ownerFiltered.filter(p => !p.strategy_type)
            : ownerFiltered.filter(p => p.strategy_type === strategyFilter);

    // ... (risk calc unchanged)
    const totalRiskDollars = activePositions.reduce((sum, position) => {
        const posTxns = transactions.filter(t => t.position_id === position.id);
        let totalQtyBought = 0, totalQtySold = 0, entryPrice = 0;
        posTxns.forEach(t => {
            const qty = t.quantity;
            if (qty > 0) {
                if (entryPrice === 0) entryPrice = t.price;
                totalQtyBought += qty;
            } else {
                totalQtySold += Math.abs(qty);
            }
        });
        const totalQty = totalQtyBought - totalQtySold;
        return sum + getPositionRiskAtStopOutDollars(position, totalQty, entryPrice, stopOutFraction);
    }, 0);
    const totalRiskPct = portfolioTotal > 0 ? (totalRiskDollars / portfolioTotal) * 100 : 0;

    // Portfolio-level Greeks aggregation + concentration warnings from shared utility
    const portfolioGreeks = useMemo(() => {
        return aggregatePortfolioGreeks(activePositions, transactions, bulkData, portfolioTotal, stopOutFraction);
    }, [activePositions, bulkData, transactions, portfolioTotal, stopOutFraction]);

    const sortedPositions = [...activePositions].sort((a, b) => {
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
    });

    const refreshAllPrices = async () => {
        setRefreshing(true);
        // Collect all legs
        const legsToFetch: any[] = [];

        activePositions.forEach(pos => {
            if (pos.legs && pos.legs.length > 0) {
                pos.legs.forEach(leg => {
                    legsToFetch.push({
                        ticker: pos.ticker,
                        expiration: leg.expiration,
                        strike: leg.strike,
                        type: leg.type,
                        id: pos.id // Map back to position
                    });
                });
            } else {
                legsToFetch.push({
                    ticker: pos.ticker,
                    expiration: pos.expiration,
                    strike: pos.strike,
                    type: pos.type,
                    id: pos.id
                });
            }
        });

        if (legsToFetch.length === 0) {
            setRefreshing(false);
            return;
        }

        try {
            console.log("Fetching bulk data for", legsToFetch.length, "legs");
            const res = await fetch('/api/option-prices-bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ legs: legsToFetch })
            });

            if (res.ok) {
                const data = await res.json();
                if (data.success && data.results) {
                    // Group results by Position ID
                    const newBulkData: Record<string, any[]> = {};
                    const failedPositionIds = new Set<string>();

                    data.results.forEach((r: any) => {
                        if (!r.id) return;
                        if (!newBulkData[r.id]) newBulkData[r.id] = [];
                        if (r.success === false) {
                            failedPositionIds.add(r.id);
                        } else {
                            newBulkData[r.id].push(r);
                        }
                    });

                    // Apply successful partial results immediately
                    setBulkData(prev => ({ ...prev, ...newBulkData }));
                    setLastTimestamp(new Date().toISOString());

                    // Only trigger individual re-fetch for positions whose legs all failed
                    // (avoids blanket refreshTrigger that re-fetches every card)
                    const partialFailIds = [...failedPositionIds].filter(
                        id => !newBulkData[id] || newBulkData[id].length === 0
                    );
                    if (partialFailIds.length > 0) {
                        console.warn(`[Portfolio] ${partialFailIds.length} position(s) had no bulk data — triggering selective fallback`);
                        setRefreshTrigger(prev => prev + 1);
                    }
                }
            } else {
                console.error("Bulk fetch failed", await res.text());
                // Full failure — fall back to individual fetches
                setRefreshTrigger(prev => prev + 1);
            }
        } catch (e) {
            console.error("Bulk fetch error", e);
            setRefreshTrigger(prev => prev + 1);
        }

        setRefreshing(false);
    };

    useEffect(() => {
        // Bulk refresh only
        refreshAllPrices();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);


    if (loading) return <LoadingSpinner />;

    return (
        <div className="fade-in pb-24 sm:pb-0 space-y-6">
            {/* Header */}
            <div className="space-y-4">
                <div className="flex flex-col gap-4">
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
                                disabled={refreshing}
                                className={`
                                    relative overflow-hidden group flex items-center gap-2 p-2.5 sm:px-4 sm:py-2 rounded-xl border border-border-default/50
                                    bg-bg-secondary/30 backdrop-blur-sm hover:bg-bg-secondary transition-all duration-200
                                    ${refreshing ? 'opacity-70 cursor-not-allowed text-text-tertiary' : 'text-text-secondary hover:text-text-primary hover:border-text-secondary/30'}
                                `}
                                aria-label="Refresh all prices"
                            >
                                <RefreshCw size={18} className={`transition-transform duration-500 ${refreshing ? 'animate-spin' : 'group-hover:rotate-180'}`} />
                                <span className="font-medium text-sm hidden sm:inline">{refreshing ? 'Refreshing...' : 'Refresh All'}</span>
                            </button>
                            <button
                                onClick={() => setShowForm(!showForm)}
                                className="flex items-center gap-1.5 sm:gap-2 px-3.5 sm:px-5 py-2.5 sm:py-2 rounded-xl font-medium text-sm text-white shadow-lg transition-all duration-200 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 shadow-emerald-500/20 hover:shadow-emerald-500/30 hover:-translate-y-0.5"
                            >
                                <span className="text-lg leading-none">+</span>
                                <span className="hidden sm:inline">Add Position</span>
                            </button>
                        </div>
                    </div>
                    {/* Settings toggle - full width on mobile */}
                    <button
                        type="button"
                        onClick={() => setShowAccountSettings(!showAccountSettings)}
                        className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl border border-border-default/50 bg-bg-secondary/30 hover:bg-bg-secondary text-text-secondary hover:text-text-primary text-xs sm:text-sm font-medium transition-colors w-full sm:w-auto"
                        aria-expanded={showAccountSettings}
                    >
                        <Settings2 size={16} className="text-accent-green shrink-0" />
                        <span className="font-mono truncate">
                            <span className="hidden sm:inline">Portfolio {formatCurrency(portfolioTotal)} · Risk {riskPct}% · Stop {stopOutPct}% · Cap {formatCurrency(maxRiskPerTrade)}/trade</span>
                            <span className="sm:hidden">{formatCurrency(portfolioTotal)} · {riskPct}% risk · {formatCurrency(maxRiskPerTrade)}/trade</span>
                        </span>
                        <ChevronDown size={16} className={`text-gray-500 transition-transform shrink-0 ${showAccountSettings ? 'rotate-180' : ''}`} />
                    </button>
                </div>
                {/* Owner Filter */}
                <div className="flex items-center gap-1.5">
                    {(['All', 'Yuchen', 'Annie'] as const).map(value => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setOwnerFilter(value)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${ownerFilter === value
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
                {/* Strategy Filter */}
                <div className="flex items-center gap-1.5">
                    <span className="text-xs text-text-tertiary">Strategy:</span>
                    {([['All', 'All'], ['swing', 'Swing'], ['shortTerm', 'ST'], ['untagged', '—']] as const).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setStrategyFilter(value as 'All' | 'swing' | 'shortTerm' | 'untagged')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${strategyFilter === value
                                ? value === 'swing'
                                    ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                                    : value === 'shortTerm'
                                        ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                                        : 'bg-white/10 text-text-primary border border-white/20'
                                : 'bg-bg-secondary/30 text-text-tertiary border border-border-default/50 hover:text-text-secondary'
                                }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* Collapsible Account & Risk Settings */}
                {showAccountSettings && (
                    <div className="rounded-xl border border-border-default/50 bg-bg-secondary/20 p-6">
                        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-4">Account & risk</h3>
                        <PortfolioSettingsForm variant="full" className="max-w-md" />
                    </div>
                )}
            </div>

            {/* Portfolio Greeks Aggregation Widget */}
            {portfolioGreeks && <PortfolioGreeksWidget greeks={portfolioGreeks} />}

            {/* Summary Strip */}
            {activePositions.length > 0 && (() => {
                const swingCount = activePositions.filter(p => p.strategy_type === 'swing').length;
                const stCount = activePositions.filter(p => p.strategy_type === 'shortTerm').length;
                const untaggedCount = activePositions.length - swingCount - stCount;
                const dailyTheta = portfolioGreeks?.netTheta ?? 0;

                // Find nearest expiring position
                const nearest = [...activePositions].sort((a, b) =>
                    daysUntil(a.expiration) - daysUntil(b.expiration)
                )[0];
                const nearestDTE = nearest ? daysUntil(nearest.expiration) : null;
                const timeStopThreshold = nearest?.strategy_type === 'shortTerm' ? 1 : 3;
                const nearestUrgent = nearestDTE != null && nearestDTE <= timeStopThreshold;

                return (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 rounded-xl bg-bg-secondary/40 border border-border-default/30 text-xs font-mono mb-4">
                        <span className="text-text-tertiary">
                            {swingCount > 0 && <span className="text-green-400">{swingCount} Swing</span>}
                            {swingCount > 0 && stCount > 0 && <span className="text-text-tertiary"> / </span>}
                            {stCount > 0 && <span className="text-blue-400">{stCount} ST</span>}
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
                            transactions={transactions.filter(t => t.position_id === position.id)}
                            onAction={onAction}
                            onUpdateScore={onUpdateScore}
                            onUpdatePrice={onUpdatePrice}
                            onUpdateTarget={onUpdateTarget}
                            onUpdateStop={onUpdateStop}
                            onUpdateOwner={onUpdateOwner}
                            onDelete={onDelete}
                            onDataUpdate={setLastTimestamp}
                            refreshTrigger={refreshTrigger}
                            index={index}
                            onRollClick={(qty) => setRollingPosition({ position, qty })}
                            portfolioTotal={portfolioTotal}
                            initialData={bulkData[position.id]}
                        />
                    ))}
                </div>
            )}

            <DataFooter timestamp={lastTimestamp} />

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
