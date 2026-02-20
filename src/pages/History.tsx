import React, { useMemo, useState } from 'react';
import { History, Check, Trash2 } from 'lucide-react';
import { Position, Transaction } from '../lib/types';
import { formatCurrency, formatPercent, CONTRACT_MULTIPLIER } from '../lib/utils';
import { LoadingSpinner } from '../components/LoadingSpinner';

interface HistoryPageProps {
    positions: Position[];
    transactions: Transaction[];
    loading: boolean;
    onDelete: (id: string) => Promise<void>;
    onUpdateOwner?: (id: string, owner: 'Yuchen' | 'Annie' | null) => Promise<void>;
}

export const HistoryPage: React.FC<HistoryPageProps> = ({ positions, transactions, loading, onDelete, onUpdateOwner }) => {
    const [ownerFilter, setOwnerFilter] = useState<'All' | 'Yuchen' | 'Annie'>('All');
    const allClosedPositions = positions.filter(p => p.status === 'closed');
    const closedPositions = ownerFilter === 'All' ? allClosedPositions : allClosedPositions.filter(p => p.owner === ownerFilter);
    const getStats = (position: Position) => {
        const txns = transactions.filter(t => t.position_id === position.id);
        let totalQtyBought = 0, totalCostBasis = 0, totalProceeds = 0;
        txns.forEach(t => {
            const price = t.price * CONTRACT_MULTIPLIER;
            if (t.quantity > 0) { totalQtyBought += t.quantity; totalCostBasis += t.quantity * price; }
            else { totalProceeds += Math.abs(t.quantity) * price; }
        });
        const pnl = totalProceeds - totalCostBasis;
        const pnlPct = totalCostBasis > 0 ? (pnl / totalCostBasis) * 100 : 0;
        const holdDays = position.closed_at && position.created_at ? Math.ceil((new Date(position.closed_at).getTime() - new Date(position.created_at).getTime()) / 86400000) : 0;
        return { pnl, pnlPct, holdDays };
    };

    const overallStats = useMemo(() => {
        let totalPnL = 0, wins = 0, losses = 0;
        closedPositions.forEach(p => {
            const { pnl } = getStats(p);
            totalPnL += pnl;
            if (pnl >= 0) wins++; else losses++;
        });
        const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;
        return { totalPnL, wins, losses, winRate };
    }, [closedPositions, transactions]);

    if (loading) return <LoadingSpinner />;

    return (
        <div className="fade-in pb-24 sm:pb-0">
            {/* Summary Stats */}
            {closedPositions.length > 0 && (
                <div className="space-y-3 mb-6">
                    {/* Total P&L - Full Width */}
                    <div className="card p-4">
                        <div className="text-text-tertiary text-xs uppercase tracking-wider mb-1">Total P&L</div>
                        <div className={`text-3xl font-bold font-mono ${overallStats.totalPnL >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                            {overallStats.totalPnL >= 0 ? '+' : '-'}${Math.abs(overallStats.totalPnL).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                    </div>
                    {/* Other Stats Row */}
                    <div className="grid grid-cols-3 gap-3">
                        <div className="card p-4">
                            <div className="text-text-tertiary text-xs uppercase tracking-wider mb-1">Win Rate</div>
                            <div className={`text-xl font-bold ${overallStats.winRate >= 50 ? 'text-accent-green' : 'text-accent-red'}`}>
                                {overallStats.winRate.toFixed(0)}%
                            </div>
                        </div>
                        <div className="card p-4">
                            <div className="text-text-tertiary text-xs uppercase tracking-wider mb-1">Wins</div>
                            <div className="text-xl font-bold text-accent-green">{overallStats.wins}</div>
                        </div>
                        <div className="card p-4">
                            <div className="text-text-tertiary text-xs uppercase tracking-wider mb-1">Losses</div>
                            <div className="text-xl font-bold text-accent-red">{overallStats.losses}</div>
                        </div>
                    </div>
                </div>
            )}

            {/* Owner Filter */}
            <div className="flex items-center gap-1.5 mb-4">
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

            <h2 className="text-2xl font-bold mb-6">Trade History</h2>

            {closedPositions.length === 0 ? (
                <div className="text-center py-16 text-text-secondary">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-tertiary flex items-center justify-center">
                        <History size={32} strokeWidth={1.5} />
                    </div>
                    <p>No closed trades yet</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {closedPositions.map(p => {
                        const { pnl, pnlPct, holdDays } = getStats(p);
                        const isWin = pnl >= 0;
                        return (
                            <div key={p.id} className="card p-4 sm:p-5 fade-in">
                                <div className="flex justify-between items-start gap-3">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 sm:gap-3 mb-1 flex-wrap">
                                            <span className="text-lg sm:text-xl font-bold">{p.ticker}</span>
                                            {p.owner && (
                                                <button
                                                    onClick={() => {
                                                        if (!onUpdateOwner) return;
                                                        const next = p.owner === 'Yuchen' ? 'Annie' : 'Yuchen';
                                                        onUpdateOwner(p.id, next);
                                                    }}
                                                    className={`px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-semibold cursor-pointer transition-colors ${p.owner === 'Yuchen'
                                                        ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                                                        : 'bg-pink-500/20 text-pink-400 hover:bg-pink-500/30'
                                                        }`}
                                                    title={`Owner: ${p.owner}`}
                                                >
                                                    {p.owner}
                                                </button>
                                            )}
                                            <span className={`badge bg-[#2C2C2E] text-white border border-[#3A3A3C]`}>{p.type}</span>
                                            {p.setup && <span className={`badge bg-yellow-500/10 text-yellow-500 border border-yellow-500/20`}>{p.setup}</span>}
                                            {p.strategy && <span className={`badge bg-violet-500/10 text-violet-400 border border-violet-500/20`}>{p.strategy}</span>}
                                            <span className={`badge ${isWin ? 'badge-green' : 'badge-red'} flex items-center gap-1`}>
                                                {isWin ? <><Check size={12} /> Win</> : 'Loss'}
                                            </span>
                                        </div>
                                        <div className="text-text-secondary text-xs sm:text-sm">
                                            <span className="font-mono">${p.strike}</span>
                                            <span className="mx-1.5 sm:mx-2">·</span>
                                            <span>{holdDays}d</span>
                                        </div>
                                    </div>
                                    <div className="flex flex-col items-end gap-2 sm:gap-3 shrink-0">
                                        <div className="text-right">
                                            <div className={`text-2xl sm:text-3xl font-bold tracking-tight leading-none ${isWin ? 'text-accent-green' : 'text-accent-red'}`}>
                                                {formatPercent(pnlPct)}
                                            </div>
                                            <div className={`text-xs sm:text-sm font-mono ${isWin ? 'text-accent-green' : 'text-accent-red'}`}>
                                                {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
                                            </div>
                                        </div>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onDelete(p.id);
                                            }}
                                            className="p-1.5 text-text-tertiary hover:text-accent-red hover:bg-accent-red/10 rounded-lg transition-colors cursor-pointer flex items-center gap-1 text-xs"
                                            title="Delete Record"
                                        >
                                            <Trash2 size={14} />
                                            <span className="hidden sm:inline">Delete</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
