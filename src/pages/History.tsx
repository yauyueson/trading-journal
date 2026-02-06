import React, { useMemo } from 'react';
import { History, Check, Trash2 } from 'lucide-react';
import { Position, Transaction } from '../lib/types';
import { formatCurrency, formatPercent, CONTRACT_MULTIPLIER } from '../lib/utils';
import { LoadingSpinner } from '../components/LoadingSpinner';

interface HistoryPageProps {
    positions: Position[];
    transactions: Transaction[];
    loading: boolean;
    onDelete: (id: string) => Promise<void>;
}

export const HistoryPage: React.FC<HistoryPageProps> = ({ positions, transactions, loading, onDelete }) => {
    const closedPositions = positions.filter(p => p.status === 'closed');
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
                            <div key={p.id} className="card p-5 fade-in">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <div className="flex items-center gap-3 mb-1">
                                            <span className="text-xl font-bold">{p.ticker}</span>
                                            <span className={`badge ${p.type === 'Call' ? 'badge-green' : 'badge-red'}`}>{p.type}</span>
                                            <span className={`badge ${isWin ? 'badge-green' : 'badge-red'} flex items-center gap-1`}>
                                                {isWin ? <><Check size={12} /> Win</> : 'Loss'}
                                            </span>
                                        </div>
                                        <div className="text-text-secondary text-sm">
                                            <span className="font-mono">${p.strike}</span>
                                            <span className="mx-2">·</span>
                                            <span>{p.setup}</span>
                                            <span className="mx-2">·</span>
                                            <span>{holdDays}d held</span>
                                        </div>
                                    </div>
                                    <div className="flex flex-col items-end gap-3">
                                        <div className="text-right">
                                            <div className={`big-number ${isWin ? 'text-accent-green' : 'text-accent-red'}`}>
                                                {formatPercent(pnlPct)}
                                            </div>
                                            <div className={`text-sm font-mono ${isWin ? 'text-accent-green' : 'text-accent-red'}`}>
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
                                            <span>Delete</span>
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
