import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { RefreshCw, ChevronDown, Settings2 } from 'lucide-react';
import { Position, Transaction, PositionAction, DirectAddItem, RollData, PositionLeg } from '../lib/types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { PositionCard } from '../components/PositionCard';
import { RollModal } from '../components/RollModal';
import { DataFooter } from '../components/DataFooter';
import { PortfolioSettingsForm } from '../components/PortfolioSettingsForm';
import { useAppSettings } from '../context/AppSettingsContext';
import { getPositionRiskAtStopOutDollars, aggregatePortfolioGreeks } from '../lib/riskSizing';
import { SETUPS, formatCurrency } from '../lib/utils';
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

const TV_GRADES = ['', 'S', 'A', 'B', 'C', 'D'] as const;
const TV_GRADE_TO_SCORE: Record<string, number> = { S: 95, A: 80, B: 60, C: 40, D: 20 };

interface PortfolioPageProps {
    positions?: Position[];
    transactions?: Transaction[];
    onAction?: (id: string, action: PositionAction) => Promise<void>;
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
    const onAction = props.onAction ?? (async (id: string, action: PositionAction) => { positionActionMut.mutate({ id, action }); });
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
    const { settings, maxRiskPerTrade, stopOutFraction } = useAppSettings();
    const { accountSize: portfolioTotal, riskPct, stopOutPct } = settings.portfolio;
    const [showForm, setShowForm] = useState(false);
    const [showAccountSettings, setShowAccountSettings] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [rollingPosition, setRollingPosition] = useState<{ position: Position, qty: number } | null>(null);
    const [sortBy] = useState('expiration');
    const [positionType, setPositionType] = useState<'single' | 'credit' | 'debit'>('single');
    const [formOwner, setFormOwner] = useState<'Yuchen' | 'Annie'>('Yuchen');
    const [ownerFilter, setOwnerFilter] = useState<'All' | 'Yuchen' | 'Annie'>('All');
    const [form, setForm] = useState({ ticker: '', strike: '', strike2: '', type: 'Call', expiration: '', setup: 'Pullback Buy', strategy: '', entry_score: '', tech_score: '', stop_reason: '', quantity: '1', entry_price: '', direction: 'BULL' as 'BULL' | 'BEAR', iv_regime_entry: '', market_state: '' });
    const [bulkData, setBulkData] = useState<Record<string, any>>({});
    const [lastTimestamp, setLastTimestamp] = useState<string | null>(null);
    const [refreshTrigger, setRefreshTrigger] = useState(0);
    const [scoreFetching, setScoreFetching] = useState(false);
    const scoreFetchRef = useRef(0); // dedup concurrent fetches

    // Auto-fetch OSS entry score when ticker + strike + expiration + type are filled
    const fetchEntryScore = useCallback(async (ticker: string, strike: string, expiration: string, optType: string) => {
        if (!ticker || !strike || !expiration || !optType) return;
        const fetchId = ++scoreFetchRef.current;
        setScoreFetching(true);
        try {
            const strikeNum = parseFloat(strike);
            const params = new URLSearchParams({
                ticker,
                strategy: 'long',
                dteMin: '0',
                dteMax: '365',
                strikeRange: '1.0',
                minVolume: '0',
                maxSpreadPct: '1.0',
                minDelta: '0',
                maxDelta: '1',
                direction: optType === 'Call' ? 'bullish' : 'bearish'
            });
            const res = await fetch(`/api/scan-options?${params}`);
            if (fetchId !== scoreFetchRef.current) return; // stale
            if (!res.ok) return;
            const data = await res.json();
            if (fetchId !== scoreFetchRef.current) return;
            // Find matching option by strike + expiration + type
            const match = data.results?.find((r: any) =>
                Math.abs(r.strike - strikeNum) < 0.01 &&
                r.expiration === expiration &&
                r.type?.toLowerCase() === optType.toLowerCase()
            );
            if (match?.score != null) {
                setForm(prev => ({ ...prev, entry_score: String(Math.round(match.score)) }));
            }
        } catch {
            // silent — user can still enter manually
        } finally {
            if (fetchId === scoreFetchRef.current) setScoreFetching(false);
        }
    }, []);

    useEffect(() => {
        if (form.ticker && form.strike && form.expiration && form.type) {
            const timer = setTimeout(() => {
                fetchEntryScore(form.ticker, form.strike, form.expiration, form.type);
            }, 600); // debounce 600ms
            return () => clearTimeout(timer);
        }
    }, [form.ticker, form.strike, form.expiration, form.type, fetchEntryScore]);

    const allActivePositions = positions.filter(p => p.status === 'active');
    const activePositions = ownerFilter === 'All' ? allActivePositions : allActivePositions.filter(p => p.owner === ownerFilter);

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

    const deriveStrategy = (posType: string, optType: string): string => {
        if (posType === 'single') return `Long ${optType}`;
        if (posType === 'credit') return `Credit ${optType} Spread`;
        return `Debit ${optType} Spread`;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);

        const strategy = deriveStrategy(positionType, form.type);
        const techScoreNum = form.tech_score ? TV_GRADE_TO_SCORE[form.tech_score] : undefined;

        if (positionType === 'single') {
            await onAddDirect({
                ticker: form.ticker,
                strike: parseFloat(form.strike),
                type: form.type,
                expiration: form.expiration,
                setup: form.setup,
                strategy,
                entry_score: parseInt(form.entry_score),
                tech_score: techScoreNum,
                stop_reason: form.stop_reason,
                quantity: parseInt(form.quantity),
                entry_price: parseFloat(form.entry_price),
                direction: form.direction as 'BULL' | 'BEAR',
                iv_regime_entry: form.iv_regime_entry || undefined,
                market_state: form.market_state || undefined,
                owner: formOwner
            });
        } else {
            const shortStrike = parseFloat(form.strike);
            const longStrike = parseFloat(form.strike2);
            const isCredit = positionType === 'credit';
            const typeName = isCredit
                ? `Credit ${form.type} Spread`
                : `Debit ${form.type} Spread`;
            const anchorStrike = isCredit ? shortStrike : longStrike;

            const legs: PositionLeg[] = [
                { strike: shortStrike, type: form.type, side: 'short', expiration: form.expiration },
                { strike: longStrike, type: form.type, side: 'long', expiration: form.expiration }
            ];

            await onAddDirect({
                ticker: form.ticker,
                strike: anchorStrike,
                type: typeName,
                expiration: form.expiration,
                setup: form.setup,
                strategy,
                entry_score: parseInt(form.entry_score),
                tech_score: techScoreNum,
                stop_reason: form.stop_reason,
                quantity: parseInt(form.quantity),
                entry_price: parseFloat(form.entry_price),
                legs,
                direction: form.direction as 'BULL' | 'BEAR',
                iv_regime_entry: form.iv_regime_entry || undefined,
                market_state: form.market_state || undefined,
                owner: formOwner
            });
        }

        setSubmitting(false);
        setForm({ ticker: '', strike: '', strike2: '', type: 'Call', expiration: '', setup: 'Pullback Buy', strategy: '', entry_score: '', tech_score: '', stop_reason: '', quantity: '1', entry_price: '', direction: 'BULL', iv_regime_entry: '', market_state: '' });
        setPositionType('single');
        setShowForm(false);
    };

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

                {/* Collapsible Account & Risk Settings */}
                {showAccountSettings && (
                    <div className="rounded-xl border border-border-default/50 bg-bg-secondary/20 p-6">
                        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-4">Account & risk</h3>
                        <PortfolioSettingsForm variant="full" className="max-w-md" />
                    </div>
                )}
            </div>

            {/* Portfolio Greeks Aggregation Widget */}
            {portfolioGreeks && (
                <div className="rounded-xl border border-border-default/30 bg-bg-secondary/20 p-4">
                    <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
                            Portfolio Greeks — {portfolioGreeks.positionsWithData} position{portfolioGreeks.positionsWithData !== 1 ? 's' : ''} with live data
                        </span>
                        {Math.abs(portfolioGreeks.netDelta) > 200 && (
                            <span className="text-[10px] font-bold text-orange-400 border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 rounded">
                                ⚠ HIGH DIRECTIONAL EXPOSURE
                            </span>
                        )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                        <div>
                            <div className={`text-base sm:text-lg font-bold font-mono ${portfolioGreeks.netDelta > 150 ? 'text-emerald-400' :
                                    portfolioGreeks.netDelta < -150 ? 'text-accent-red' :
                                        'text-text-primary'
                                }`}>
                                {portfolioGreeks.netDelta > 0 ? '+' : ''}{portfolioGreeks.netDelta.toFixed(0)}
                            </div>
                            <div className="text-[10px] text-text-tertiary mt-0.5">Net Delta (Δ shares)</div>
                        </div>
                        <div>
                            <div className={`text-base sm:text-lg font-bold font-mono ${portfolioGreeks.netTheta > 15 ? 'text-emerald-400' :
                                    portfolioGreeks.netTheta < -25 ? 'text-accent-red' :
                                        'text-text-primary'
                                }`}>
                                {portfolioGreeks.netTheta >= 0 ? '+' : ''}${portfolioGreeks.netTheta.toFixed(0)}/d
                            </div>
                            <div className="text-[10px] text-text-tertiary mt-0.5">Net Theta (Θ)</div>
                        </div>
                        <div>
                            <div className={`text-base sm:text-lg font-bold font-mono ${portfolioGreeks.netVega > 0 ? 'text-accent-yellow' :
                                    portfolioGreeks.netVega < 0 ? 'text-blue-400' :
                                        'text-text-primary'
                                }`}>
                                {portfolioGreeks.netVega >= 0 ? '+' : ''}${portfolioGreeks.netVega.toFixed(0)}
                            </div>
                            <div className="text-[10px] text-text-tertiary mt-0.5">Net Vega (per 1% IV)</div>
                        </div>
                        <div>
                            <div className={`text-base sm:text-lg font-bold font-mono ${portfolioGreeks.netGamma > 20 ? 'text-emerald-400' :
                                    portfolioGreeks.netGamma < -20 ? 'text-accent-red' :
                                        'text-text-primary'
                                }`}>
                                {portfolioGreeks.netGamma >= 0 ? '+' : ''}{portfolioGreeks.netGamma.toFixed(2)}
                            </div>
                            <div className="text-[10px] text-text-tertiary mt-0.5">Net Gamma (Γ)</div>
                        </div>
                    </div>
                    {/* Largest position risk — shown beneath main Greeks row */}
                    {portfolioGreeks.largestRiskTicker && portfolioGreeks.largestRiskPct > 0 && (
                        <div className="mt-3 pt-3 border-t border-border-default/20 flex items-center gap-2 text-[11px]">
                            <span className="text-text-tertiary">Largest position risk:</span>
                            <span className={`font-mono font-semibold ${portfolioGreeks.largestRiskPct > 10 ? 'text-accent-red' :
                                    portfolioGreeks.largestRiskPct > 5 ? 'text-accent-yellow' :
                                        'text-text-primary'
                                }`}>{portfolioGreeks.largestRiskTicker} {portfolioGreeks.largestRiskPct.toFixed(1)}%</span>
                        </div>
                    )}
                    {/* Concentration warnings (F5.2) */}
                    {portfolioGreeks.concentrationWarnings && portfolioGreeks.concentrationWarnings.length > 0 && (
                        <div className="mt-2 space-y-1">
                            {portfolioGreeks.concentrationWarnings.map((w, i) => (
                                <div key={i} className="flex items-center gap-2 text-[11px] text-accent-red/90">
                                    <span className="font-semibold">CONCENTRATION:</span>
                                    <span className="font-mono">{w.label} @ {w.pct}%</span>
                                    <span className="text-text-tertiary">(limit {w.limit}%)</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Quick Add Form */}
            {showForm && (
                <div className="card-elevated p-8 animate-in fade-in slide-in-from-top-4 shadow-2xl relative overflow-hidden group">
                    <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500/50" />
                    <div className="flex justify-between items-center mb-8">
                        <div>
                            <h3 className="text-xl font-bold text-text-primary">Quick Add Position</h3>
                            <p className="text-sm text-text-tertiary">Enter the details of your new option position</p>
                        </div>
                        <button
                            onClick={() => setShowForm(false)}
                            className="p-2 hover:bg-bg-elevated rounded-lg transition-colors text-text-tertiary hover:text-text-primary"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-8">
                        {/* Position Type Toggle */}
                        <div className="flex items-center gap-4">
                            <div className="grid grid-cols-3 gap-2 flex-1">
                                {([
                                    ['single', 'Single Leg'],
                                    ['credit', 'Credit Spread'],
                                    ['debit', 'Debit Spread']
                                ] as const).map(([value, label]) => (
                                    <button
                                        key={value}
                                        type="button"
                                        onClick={() => setPositionType(value)}
                                        className={`px-3 py-3 rounded-lg text-sm font-medium transition-all ${positionType === value
                                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                            : 'bg-bg-secondary/30 text-text-tertiary border border-border-default/50 hover:text-text-secondary'
                                            }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            {/* Owner Toggle */}
                            <div className="flex gap-1.5">
                                {(['Yuchen', 'Annie'] as const).map(name => (
                                    <button
                                        key={name}
                                        type="button"
                                        onClick={() => setFormOwner(name)}
                                        className={`px-3 py-2 rounded-lg text-xs font-semibold transition-all ${formOwner === name
                                            ? name === 'Yuchen'
                                                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                                                : 'bg-pink-500/20 text-pink-400 border border-pink-500/40'
                                            : 'bg-bg-secondary/30 text-text-tertiary border border-border-default/50 hover:text-text-secondary'
                                            }`}
                                    >
                                        {name}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Row 1: Basic Info */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                            <div className="space-y-1.5">
                                <label htmlFor="ticker">Symbol</label>
                                <input
                                    id="ticker"
                                    placeholder="e.g. SPY"
                                    className="input-field"
                                    value={form.ticker}
                                    onChange={e => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
                                    required
                                />
                            </div>

                            {positionType === 'single' ? (
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <label htmlFor="strike">Strike</label>
                                        <input
                                            id="strike"
                                            type="number"
                                            inputMode="decimal"
                                            placeholder="0.00"
                                            className="input-field"
                                            value={form.strike}
                                            onChange={e => setForm({ ...form, strike: e.target.value })}
                                            required
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label htmlFor="type">Type</label>
                                        <select
                                            id="type"
                                            className="input-field"
                                            value={form.type}
                                            onChange={e => setForm({ ...form, type: e.target.value })}
                                        >
                                            <option value="Call">Call</option>
                                            <option value="Put">Put</option>
                                        </select>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:col-span-1 lg:col-span-2">
                                    <div className="space-y-1.5">
                                        <label htmlFor="strike">Short Strike</label>
                                        <input
                                            id="strike"
                                            type="number"
                                            inputMode="decimal"
                                            placeholder="0.00"
                                            className="input-field"
                                            value={form.strike}
                                            onChange={e => setForm({ ...form, strike: e.target.value })}
                                            required
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label htmlFor="strike2">Long Strike</label>
                                        <input
                                            id="strike2"
                                            type="number"
                                            inputMode="decimal"
                                            placeholder="0.00"
                                            className="input-field"
                                            value={form.strike2}
                                            onChange={e => setForm({ ...form, strike2: e.target.value })}
                                            required
                                        />
                                    </div>
                                    <div className="space-y-1.5 col-span-2 md:col-span-1">
                                        <label htmlFor="type">Type</label>
                                        <select
                                            id="type"
                                            className="input-field"
                                            value={form.type}
                                            onChange={e => setForm({ ...form, type: e.target.value })}
                                        >
                                            <option value="Call">Call</option>
                                            <option value="Put">Put</option>
                                        </select>
                                    </div>
                                </div>
                            )}

                            <div className="space-y-1.5">
                                <label htmlFor="expiration">Expiration</label>
                                <input
                                    id="expiration"
                                    type="date"
                                    className="input-field"
                                    value={form.expiration}
                                    onChange={e => setForm({ ...form, expiration: e.target.value })}
                                    required
                                />
                            </div>

                            {positionType === 'single' && (
                                <div className="space-y-1.5">
                                    <label htmlFor="setup">Setup</label>
                                    <select
                                        id="setup"
                                        className="input-field"
                                        value={form.setup}
                                        onChange={e => setForm({ ...form, setup: e.target.value })}
                                    >
                                        {SETUPS.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                </div>
                            )}
                        </div>

                        {/* Setup row for spreads (needs its own row since strikes take more space) */}
                        {positionType !== 'single' && (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                                <div className="space-y-1.5">
                                    <label htmlFor="setup-spread">Setup</label>
                                    <select
                                        id="setup-spread"
                                        className="input-field"
                                        value={form.setup}
                                        onChange={e => setForm({ ...form, setup: e.target.value })}
                                    >
                                        {SETUPS.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                </div>
                            </div>
                        )}

                        {/* Row 2: Analysis & Execution */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
                            <div className="space-y-1.5">
                                <label htmlFor="score">Entry Score {scoreFetching && <span className="text-xs text-text-tertiary animate-pulse ml-1">fetching…</span>}</label>
                                <input
                                    id="score"
                                    type="number"
                                    placeholder={scoreFetching ? '…' : 'auto'}
                                    className="input-field"
                                    value={form.entry_score}
                                    onChange={e => setForm({ ...form, entry_score: e.target.value })}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label htmlFor="tech_score">TV Grade</label>
                                <div className="flex gap-1.5">
                                    {TV_GRADES.filter(g => g !== '').map(grade => (
                                        <button
                                            key={grade}
                                            type="button"
                                            onClick={() => setForm({ ...form, tech_score: form.tech_score === grade ? '' : grade })}
                                            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${form.tech_score === grade
                                                ? grade === 'S' ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
                                                : grade === 'A' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                                : grade === 'B' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                                                : grade === 'C' ? 'bg-orange-500/20 text-orange-400 border border-orange-500/40'
                                                : 'bg-red-500/20 text-red-400 border border-red-500/40'
                                                : 'bg-bg-secondary/30 text-text-tertiary border border-border-default/50 hover:text-text-secondary'
                                            }`}
                                        >
                                            {grade}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-1.5 lg:col-span-1">
                                <label htmlFor="stop_reason">Stop Reason / Plan</label>
                                <input
                                    id="stop_reason"
                                    placeholder="Why take this trade?"
                                    className="input-field"
                                    value={form.stop_reason}
                                    onChange={e => setForm({ ...form, stop_reason: e.target.value })}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label htmlFor="quantity">Quantity</label>
                                <input
                                    id="quantity"
                                    type="number"
                                    placeholder="1"
                                    className="input-field"
                                    value={form.quantity}
                                    onChange={e => setForm({ ...form, quantity: e.target.value })}
                                    required
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label htmlFor="price">{positionType === 'credit' ? 'Net Credit' : positionType === 'debit' ? 'Net Debit' : 'Entry Price'}</label>
                                <div className="relative">
                                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary select-none">$</span>
                                    <input
                                        id="price"
                                        type="number"
                                        step="0.01"
                                        placeholder="0.00"
                                        className="input-field pl-8"
                                        value={form.entry_price}
                                        onChange={e => setForm({ ...form, entry_price: e.target.value })}
                                        required
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Row 3: Direction + Market State + IV Regime */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <div className="space-y-1.5">
                                <label className="text-xs font-medium text-text-secondary uppercase tracking-wider">Direction</label>
                                <div className="flex gap-2">
                                    {(['BULL', 'BEAR'] as const).map(d => (
                                        <button
                                            key={d}
                                            type="button"
                                            onClick={() => setForm({ ...form, direction: d })}
                                            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${form.direction === d
                                                    ? d === 'BULL'
                                                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                                        : 'bg-red-500/20 text-red-400 border border-red-500/40'
                                                    : 'bg-bg-secondary/30 text-text-tertiary border border-border-default/50 hover:text-text-secondary'
                                                }`}
                                        >
                                            {d === 'BULL' ? '▲ BULL' : '▼ BEAR'}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-xs font-medium text-text-secondary uppercase tracking-wider">Market State</label>
                                <div className="grid grid-cols-4 gap-1.5">
                                    {[
                                        { label: 'TREND', value: 'TRENDING' },
                                        { label: 'EXPL', value: 'EXPLOSIVE' },
                                        { label: 'RANGE', value: 'RANGING' },
                                        { label: 'REV', value: 'REVERTING' },
                                    ].map(opt => (
                                        <button
                                            key={opt.value}
                                            type="button"
                                            onClick={() => setForm({ ...form, market_state: form.market_state === opt.value ? '' : opt.value })}
                                            className={`py-2 rounded-lg text-[10px] font-bold transition-all ${form.market_state === opt.value
                                                ? 'bg-accent-green/20 text-accent-green border border-accent-green/40'
                                                : 'bg-bg-secondary/30 text-text-tertiary border border-border-default/50 hover:text-text-secondary'
                                                }`}
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="space-y-1.5">
                                <label htmlFor="iv_regime" className="text-xs font-medium text-text-secondary uppercase tracking-wider">IV Regime</label>
                                <select
                                    id="iv_regime"
                                    className="input-field"
                                    value={form.iv_regime_entry}
                                    onChange={e => setForm({ ...form, iv_regime_entry: e.target.value })}
                                >
                                    <option value="">— Unknown —</option>
                                    <option value="CREDIT">CREDIT (Hi HV)</option>
                                    <option value="DEBIT">DEBIT (Lo HV)</option>
                                    <option value="NEUTRAL">NEUTRAL</option>
                                </select>
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex justify-end items-center gap-4 pt-4 border-t border-border-default/50">
                            <button
                                type="button"
                                onClick={() => setShowForm(false)}
                                className="px-6 py-2.5 rounded-xl font-medium text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={submitting}
                                className="btn-primary px-8 py-2.5 rounded-xl flex items-center gap-2 shadow-lg shadow-emerald-500/10"
                            >
                                {submitting ? (
                                    <>
                                        <RefreshCw size={18} className="animate-spin" />
                                        <span>Adding...</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-xl leading-none mb-0.5">+</span>
                                        <span>Add Position</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </form>
                </div>
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
