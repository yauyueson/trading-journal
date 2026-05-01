import React, { useCallback, useMemo, useState } from 'react';
import { History, Check, Trash2 } from 'lucide-react';
import { Position, Transaction } from '../lib/types';
import { computePositionPnL, formatCurrency, formatPercent, getStrategyKind, groupTransactionsByPositionId } from '../lib/utils';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';
import { useDeletePosition, useUpdateOwner } from '../hooks/usePositionMutations';

interface HistoryPageProps {
    positions?: Position[];
    transactions?: Transaction[];
    loading?: boolean;
    onDelete?: (id: string) => Promise<void>;
    onUpdateOwner?: (id: string, owner: 'Yuchen' | 'Annie' | null) => Promise<void>;
}

function exitTypeBadge(type: Position['exit_type']) {
    if (!type) return null;
    // Phosphor-aligned exit-type badges. Green = clean profit, red = loss, amber = time/defensive, dim = manual/roll.
    const G = 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/30';
    const R = 'bg-phosphor-red/10 text-phosphor-red text-glow-red border border-phosphor-red/30';
    const A = 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/30';
    const N = 'bg-terminal-panel text-phosphor-dim border border-phosphor-green/20';
    const map: Record<string, { label: string; cls: string }> = {
        TP:            { label: 'TP HIT',         cls: G },
        SL:            { label: 'SL HIT',         cls: R },
        TIME:          { label: 'TIME',           cls: A },
        MANUAL:        { label: 'MANUAL',         cls: N },
        ROLL:          { label: 'ROLLED',         cls: N },
        EXP_PROFIT:    { label: 'EXPIRED +',      cls: G },
        EXP_LOSS:      { label: 'EXPIRED −',      cls: R },
        EARLY_PROFIT:  { label: 'EARLY PROFIT',   cls: G },
        EARLY_DEFENSE: { label: 'EARLY DEFENSE',  cls: A },
    };
    const m = map[type];
    if (!m) return null;
    return <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider font-bold ${m.cls}`}>{m.label}</span>;
}

export const HistoryPage: React.FC<HistoryPageProps> = ({ positions: positionsProp, transactions: transactionsProp, loading: loadingProp, onDelete: onDeleteProp, onUpdateOwner: onUpdateOwnerProp }) => {
    const { data: positionsQuery = [], isLoading: positionsLoading } = usePositions();
    const { data: transactionsQuery = [], isLoading: transactionsLoading } = useTransactions();
    const deletePositionMut = useDeletePosition();
    const updateOwnerMut = useUpdateOwner();

    const positions = positionsProp ?? positionsQuery;
    const transactions = transactionsProp ?? transactionsQuery;
    const loading = loadingProp ?? (positionsLoading || transactionsLoading);
    const onDelete = onDeleteProp ?? (async (id: string) => {
        if (window.confirm('Are you sure you want to permanently delete this position? This cannot be undone.')) {
            await deletePositionMut.mutateAsync(id);
        }
    });
    const onUpdateOwner = onUpdateOwnerProp ?? (async (id: string, owner: 'Yuchen' | 'Annie' | null) => {
        await updateOwnerMut.mutateAsync({ id, owner });
    });

    const [ownerFilter, setOwnerFilter] = useState<'All' | 'Yuchen' | 'Annie'>('All');
    const allClosedPositions = positions.filter(p => p.status === 'closed');
    const closedPositions = ownerFilter === 'All' ? allClosedPositions : allClosedPositions.filter(p => p.owner === ownerFilter);
    const transactionsByPosition = useMemo(
        () => groupTransactionsByPositionId(transactions),
        [transactions],
    );
    const getStats = useCallback((position: Position) => {
        const txns = transactionsByPosition[position.id] ?? [];
        const pnl = computePositionPnL(txns, getStrategyKind(position));
        const totalEntryDollars = txns.reduce((sum, t) => t.quantity > 0 ? sum + t.quantity * t.price * 100 : sum, 0);
        const pnlPct = totalEntryDollars > 0 ? (pnl / totalEntryDollars) * 100 : 0;
        const holdDays = position.closed_at && position.created_at ? Math.ceil((new Date(position.closed_at).getTime() - new Date(position.created_at).getTime()) / 86400000) : 0;
        return { pnl, pnlPct, holdDays };
    }, [transactionsByPosition]);

    const overallStats = useMemo(() => {
        let totalPnL = 0, wins = 0, losses = 0;
        closedPositions.forEach(p => {
            const { pnl } = getStats(p);
            totalPnL += pnl;
            if (pnl >= 0) wins++; else losses++;
        });
        const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;
        return { totalPnL, wins, losses, winRate };
    }, [closedPositions, getStats]);

    if (loading) return <LoadingSpinner />;

    return (
        <div className="stagger-fade-in pb-24 sm:pb-0 lg:flex lg:gap-8">
            {/* Sidebar — sticky summary on desktop */}
            <div className="lg:w-1/3 lg:sticky lg:top-20 lg:self-start">
                {/* Summary Stats */}
                {closedPositions.length > 0 && (
                    <div className="mb-6 pb-4 border-b border-phosphor-green/15">
                        {/* Total P&L */}
                        <div className="terminal-panel p-4 mb-3">
                            <span className="label-mono">▌ TOTAL P&L</span>
                            <div className={`text-4xl font-bold font-mono tabular-nums mt-1 ${overallStats.totalPnL >= 0 ? 'metric-glow-pos' : 'metric-glow-neg'}`}>
                                {overallStats.totalPnL >= 0 ? '+' : '-'}${Math.abs(overallStats.totalPnL).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </div>
                        </div>
                        {/* Stats Strip */}
                        <div className="grid grid-cols-3 gap-2">
                            <div className="terminal-panel p-3">
                                <span className="label-mono">WIN RATE</span>
                                <div className={`text-xl font-bold font-mono tabular-nums mt-1 ${overallStats.winRate >= 50 ? 'metric-glow-pos' : 'metric-glow-neg'}`}>
                                    {overallStats.winRate.toFixed(0)}%
                                </div>
                            </div>
                            <div className="terminal-panel p-3">
                                <span className="label-mono">WINS</span>
                                <div className="text-xl font-bold font-mono tabular-nums mt-1 metric-glow-pos">{overallStats.wins}</div>
                            </div>
                            <div className="terminal-panel p-3">
                                <span className="label-mono">LOSSES</span>
                                <div className="text-xl font-bold font-mono tabular-nums mt-1 metric-glow-neg">{overallStats.losses}</div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Owner Filter */}
                <div>
                    <span className="label-mono mb-1.5 block">▌ OWNER</span>
                    <div className="flex items-center gap-1.5 mb-4">
                        {(['All', 'Yuchen', 'Annie'] as const).map(value => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setOwnerFilter(value)}
                                className={`px-3 py-1.5 rounded-md text-[11px] font-mono uppercase tracking-wider transition-all min-h-[36px] cursor-pointer ${ownerFilter === value
                                    ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40'
                                    : 'bg-terminal-panel text-text-tertiary border border-border-default/50 hover:text-phosphor-dim hover:border-phosphor-green/20'
                                    }`}
                            >
                                {value}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Main content — trade list */}
            <div className="lg:w-2/3">
                <h2 className="text-xl sm:text-2xl font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-6">▌ TRADE_HISTORY</h2>

                {closedPositions.length === 0 ? (
                    <div className="terminal-panel text-center py-16">
                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-phosphor-green/[0.08] border border-phosphor-green/30 flex items-center justify-center">
                            <History size={32} strokeWidth={1.5} className="text-phosphor-green" />
                        </div>
                        <p className="text-phosphor-green text-glow-green text-sm font-mono uppercase tracking-widest font-bold">▌ NO_CLOSED_TRADES</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {closedPositions.map(p => {
                            const { pnl, pnlPct, holdDays } = getStats(p);
                            const isWin = pnl >= 0;
                            return (
                                <div key={p.id} className={`terminal-panel ${isWin ? '' : 'terminal-panel-red'} p-4 sm:p-5`}>
                                    <div className="flex justify-between items-start gap-3">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2 sm:gap-3 mb-1 flex-wrap">
                                                <span className="text-lg sm:text-xl font-mono font-bold uppercase tracking-wider text-phosphor-green text-glow-green">{p.ticker}</span>
                                                {p.owner && (
                                                    <button
                                                        onClick={() => {
                                                            if (!onUpdateOwner) return;
                                                            const next = p.owner === 'Yuchen' ? 'Annie' : 'Yuchen';
                                                            onUpdateOwner(p.id, next);
                                                        }}
                                                        className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider font-bold cursor-pointer transition-colors bg-terminal-panel text-phosphor-dim border border-phosphor-green/20 hover:border-phosphor-green/40 hover:text-phosphor-green"
                                                        title={`Owner: ${p.owner}`}
                                                    >
                                                        ▌ {p.owner}
                                                    </button>
                                                )}
                                                <span className="badge bg-terminal-panel text-text-primary border border-border-default font-mono uppercase tracking-wider text-[10px]">{p.type}</span>
                                                {p.setup && <span className="badge bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/30 font-mono uppercase tracking-wider text-[10px]">{p.setup}</span>}
                                                {p.strategy && <span className="badge bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/30 font-mono uppercase tracking-wider text-[10px]">{p.strategy}</span>}
                                                <span className={`badge font-mono uppercase tracking-wider text-[10px] flex items-center gap-1 ${isWin ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/30' : 'bg-phosphor-red/10 text-phosphor-red text-glow-red border border-phosphor-red/30'}`}>
                                                    {isWin ? <><Check size={12} /> WIN</> : 'LOSS'}
                                                </span>
                                            </div>
                                            <div className="text-text-secondary text-xs font-mono uppercase tracking-wider flex items-center flex-wrap gap-1.5">
                                                <span className="tabular-nums">${p.strike}</span>
                                                {p.spread_width != null && <span className="text-text-tertiary tabular-nums">${p.spread_width}W</span>}
                                                <span>·</span>
                                                <span className="tabular-nums">{holdDays}D HOLD</span>
                                                {exitTypeBadge(p.exit_type)}
                                            </div>
                                        </div>
                                        <div className="flex flex-col items-end gap-2 sm:gap-3 shrink-0">
                                            <div className="text-right">
                                                <div className={`text-2xl sm:text-3xl font-bold font-mono tabular-nums tracking-tight leading-none ${isWin ? 'metric-glow-pos' : 'metric-glow-neg'}`}>
                                                    {formatPercent(pnlPct)}
                                                </div>
                                                <div className={`text-xs sm:text-sm font-mono tabular-nums ${isWin ? 'text-phosphor-green' : 'text-phosphor-red'}`}>
                                                    {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
                                                </div>
                                            </div>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onDelete(p.id);
                                                }}
                                                className="btn-terminal-danger min-w-[44px] flex items-center gap-1"
                                                title="Delete Record"
                                            >
                                                <Trash2 size={14} />
                                                <span className="hidden sm:inline">DELETE</span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};
