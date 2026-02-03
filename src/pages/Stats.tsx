import React, { useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import { Position, Transaction } from '../lib/types';
import { formatCurrency, CONTRACT_MULTIPLIER } from '../lib/utils';
import { LoadingSpinner } from '../components/LoadingSpinner';

interface StatsPageProps {
    positions: Position[];
    transactions: Transaction[];
    loading: boolean;
}

export const StatsPage: React.FC<StatsPageProps> = ({ positions, transactions, loading }) => {
    const closedPositions = positions.filter(p => p.status === 'closed');

    const stats = useMemo(() => {
        let totalPnL = 0, wins = 0, losses = 0, totalWinPnL = 0, totalLossPnL = 0;
        const setupStats: Record<string, { wins: number; losses: number; pnl: number }> = {};

        closedPositions.forEach(p => {
            const txns = transactions.filter(t => t.position_id === p.id);
            let cost = 0, proceeds = 0;
            txns.forEach(t => {
                const price = t.price * CONTRACT_MULTIPLIER;
                if (t.quantity > 0) cost += t.quantity * price;
                else proceeds += Math.abs(t.quantity) * price;
            });
            const pnl = proceeds - cost;
            totalPnL += pnl;

            if (pnl >= 0) { wins++; totalWinPnL += pnl; }
            else { losses++; totalLossPnL += pnl; }

            if (!setupStats[p.setup]) setupStats[p.setup] = { wins: 0, losses: 0, pnl: 0 };
            setupStats[p.setup].pnl += pnl;
            if (pnl >= 0) setupStats[p.setup].wins++;
            else setupStats[p.setup].losses++;
        });

        const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;
        const avgWin = wins > 0 ? totalWinPnL / wins : 0;
        const avgLoss = losses > 0 ? totalLossPnL / losses : 0;
        const profitFactor = totalLossPnL !== 0 ? Math.abs(totalWinPnL / totalLossPnL) : totalWinPnL > 0 ? Infinity : 0;

        return { totalPnL, wins, losses, winRate, avgWin, avgLoss, profitFactor, setupStats };
    }, [closedPositions, transactions]);

    if (loading) return <LoadingSpinner />;

    return (
        <div className="fade-in pb-24 sm:pb-0">
            <h2 className="text-2xl font-bold mb-6">Performance Stats</h2>

            {closedPositions.length === 0 ? (
                <div className="text-center py-16 text-text-secondary">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-tertiary flex items-center justify-center">
                        <BarChart3 size={32} strokeWidth={1.5} />
                    </div>
                    <p>Complete some trades to see your stats</p>
                </div>
            ) : (
                <>
                    {/* Key Metrics */}
                    <div className="grid grid-cols-2 gap-4 mb-6">
                        <div className="card p-5">
                            <div className="text-text-tertiary text-xs uppercase tracking-wider mb-2">Total P&L</div>
                            <div className={`text-3xl font-bold font-mono ${stats.totalPnL >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                                {stats.totalPnL >= 0 ? '+' : ''}{formatCurrency(stats.totalPnL)}
                            </div>
                        </div>
                        <div className="card p-5">
                            <div className="text-text-tertiary text-xs uppercase tracking-wider mb-2">Win Rate</div>
                            <div className={`text-3xl font-bold ${stats.winRate >= 50 ? 'text-accent-green' : 'text-accent-red'}`}>
                                {stats.winRate.toFixed(1)}%
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                        <div className="card p-4">
                            <div className="text-text-tertiary text-xs uppercase tracking-wider mb-1">Avg Win</div>
                            <div className="text-xl font-bold font-mono text-accent-green">{formatCurrency(stats.avgWin)}</div>
                        </div>
                        <div className="card p-4">
                            <div className="text-text-tertiary text-xs uppercase tracking-wider mb-1">Avg Loss</div>
                            <div className="text-xl font-bold font-mono text-accent-red">{formatCurrency(Math.abs(stats.avgLoss))}</div>
                        </div>
                        <div className="card p-4">
                            <div className="text-text-tertiary text-xs uppercase tracking-wider mb-1">Profit Factor</div>
                            <div className={`text-xl font-bold ${stats.profitFactor >= 1 ? 'text-accent-green' : 'text-accent-red'}`}>
                                {stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}
                            </div>
                        </div>
                        <div className="card p-4">
                            <div className="text-text-tertiary text-xs uppercase tracking-wider mb-1">Total Trades</div>
                            <div className="text-xl font-bold">{closedPositions.length}</div>
                        </div>
                    </div>

                    {/* Setup Breakdown */}
                    <h3 className="text-lg font-semibold mb-4">By Setup</h3>
                    <div className="space-y-3">
                        {Object.entries(stats.setupStats)
                            .sort((a, b) => b[1].pnl - a[1].pnl)
                            .map(([setup, data]) => {
                                const total = data.wins + data.losses;
                                const winRate = total > 0 ? (data.wins / total) * 100 : 0;
                                return (
                                    <div key={setup} className="card p-4 flex justify-between items-center">
                                        <div>
                                            <div className="font-medium">{setup}</div>
                                            <div className="text-text-secondary text-sm">
                                                {data.wins}W / {data.losses}L · {winRate.toFixed(0)}%
                                            </div>
                                        </div>
                                        <div className={`text-xl font-bold font-mono ${data.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                                            {data.pnl >= 0 ? '+' : ''}{formatCurrency(data.pnl)}
                                        </div>
                                    </div>
                                );
                            })}
                    </div>
                </>
            )}
        </div>
    );
};
