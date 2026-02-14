import React, { useState, useEffect } from 'react';
import { RefreshCw, ChevronDown, Settings2 } from 'lucide-react';
import { Position, Transaction, PositionAction, DirectAddItem, RollData, PositionLeg } from '../lib/types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { PositionCard } from '../components/PositionCard';
import { RollModal } from '../components/RollModal';
import { DataFooter } from '../components/DataFooter';
import { PortfolioSettingsForm } from '../components/PortfolioSettingsForm';
import { useAppSettings } from '../context/AppSettingsContext';
import { getPositionRiskAtStopOutDollars } from '../lib/riskSizing';
import { SETUPS, formatCurrency } from '../lib/utils';

interface PortfolioPageProps {
    positions: Position[];
    transactions: Transaction[];
    onAction: (id: string, action: PositionAction) => Promise<void>;
    onUpdateScore: (id: string, score: number) => Promise<void>;
    onUpdatePrice: (id: string, price: number) => Promise<void>;
    onUpdateTarget: (id: string, target: number) => Promise<void>;
    onUpdateStop: (id: string, stopPrice: number) => Promise<void>;
    onUpdateOwner: (id: string, owner: 'Yuchen' | 'Annie' | null) => Promise<void>;
    onAddDirect: (item: DirectAddItem) => Promise<void>;
    onRoll: (originalPositionId: string, rollData: RollData) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    loading: boolean;
}

export const PortfolioPage: React.FC<PortfolioPageProps> = ({ positions, transactions, onAction, onUpdateScore, onUpdatePrice, onUpdateTarget, onUpdateStop, onUpdateOwner, onAddDirect, onRoll, onDelete, loading }) => {
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
    const [form, setForm] = useState({ ticker: '', strike: '', strike2: '', type: 'Call', expiration: '', setup: 'Pullback Buy', entry_score: '', stop_reason: '', quantity: '1', entry_price: '' });
    const [bulkData, setBulkData] = useState<Record<string, any>>({});
    const [lastTimestamp, setLastTimestamp] = useState<string | null>(null);
    const [refreshTrigger, setRefreshTrigger] = useState(0);

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
                    // structure: { "posId": [ {leg1data}, {leg2data} ] }
                    const newBulkData: Record<string, any[]> = {};

                    data.results.forEach((r: any) => {
                        if (r.id) {
                            if (!newBulkData[r.id]) newBulkData[r.id] = [];
                            newBulkData[r.id].push(r);
                        }
                    });

                    setBulkData(prev => ({ ...prev, ...newBulkData }));
                    setLastTimestamp(new Date().toISOString());
                }
            } else {
                console.error("Bulk fetch failed", await res.text());
                // Fallback: Increment trigger to signal children to fetch individually
                setRefreshTrigger(prev => prev + 1);
            }
        } catch (e) {
            console.error("Bulk fetch error", e);
            setRefreshTrigger(prev => prev + 1);
        }

        setRefreshing(false);
    };

    useEffect(() => {
        refreshAllPrices();

        // Trigger efficient background Tech Score update (checks staleness)
        fetch('/api/batch-refresh-tech?scope=active')
            .then(res => res.json())
            .then(data => console.log("Tech Score Check:", data.message))
            .catch(err => console.error("Tech Score Trigger Failed", err));

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);

        if (positionType === 'single') {
            await onAddDirect({
                ticker: form.ticker,
                strike: parseFloat(form.strike),
                type: form.type,
                expiration: form.expiration,
                setup: form.setup,
                entry_score: parseInt(form.entry_score),
                stop_reason: form.stop_reason,
                quantity: parseInt(form.quantity),
                entry_price: parseFloat(form.entry_price),
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
                entry_score: parseInt(form.entry_score),
                stop_reason: form.stop_reason,
                quantity: parseInt(form.quantity),
                entry_price: parseFloat(form.entry_price),
                legs,
                owner: formOwner
            });
        }

        setSubmitting(false);
        setForm({ ticker: '', strike: '', strike2: '', type: 'Call', expiration: '', setup: 'Pullback Buy', entry_score: '', stop_reason: '', quantity: '1', entry_price: '' });
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
                                    <label htmlFor="setup">Setup Strategy</label>
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
                                    <label htmlFor="setup">Setup Strategy</label>
                                    <select
                                        id="setup"
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
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                            <div className="space-y-1.5">
                                <label htmlFor="score">Entry Score</label>
                                <input
                                    id="score"
                                    type="number"
                                    placeholder="0-100"
                                    className="input-field"
                                    value={form.entry_score}
                                    onChange={e => setForm({ ...form, entry_score: e.target.value })}
                                />
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
