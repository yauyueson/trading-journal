import React, { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Position, Transaction } from '../lib/types';
import { formatCurrency, CONTRACT_MULTIPLIER } from '../lib/utils';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ScoreValidation } from '../components/ScoreValidation';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';

interface StatsPageProps {
    positions?: Position[];
    transactions?: Transaction[];
    loading?: boolean;
}

interface BucketStats {
    wins: number;
    losses: number;
    pnl: number;
    totalHoldDays: number;
    holdCount: number;
    totalR: number;
    rCount: number;
}

const emptyBucket = (): BucketStats => ({
    wins: 0, losses: 0, pnl: 0,
    totalHoldDays: 0, holdCount: 0,
    totalR: 0, rCount: 0,
});

const accumulateBucket = (
    bucket: BucketStats,
    pnl: number,
    holdDays: number | null,
    rMult: number | null
) => {
    bucket.pnl += pnl;
    if (pnl >= 0) bucket.wins++; else bucket.losses++;
    if (holdDays != null && holdDays >= 0) { bucket.totalHoldDays += holdDays; bucket.holdCount++; }
    if (rMult != null && isFinite(rMult)) { bucket.totalR += rMult; bucket.rCount++; }
};

const BucketMeta: React.FC<{ data: BucketStats }> = ({ data }) => {
    const avgHold = data.holdCount > 0 ? Math.round(data.totalHoldDays / data.holdCount) : null;
    const avgR = data.rCount > 0 ? data.totalR / data.rCount : null;
    if (avgHold == null && avgR == null) return null;
    return (
        <div className="flex gap-3 mt-1">
            {avgHold != null && (
                <span className="text-[11px] text-text-tertiary font-mono">Hold: {avgHold}d</span>
            )}
            {avgR != null && (
                <span className={`text-[11px] font-mono font-semibold ${avgR >= 0 ? 'text-emerald-500/70' : 'text-red-500/70'}`}>
                    R: {avgR >= 0 ? '+' : ''}{avgR.toFixed(2)}x
                </span>
            )}
        </div>
    );
};

export const StatsPage: React.FC<StatsPageProps> = ({ positions: positionsProp, transactions: transactionsProp, loading: loadingProp }) => {
    const { data: positionsQuery = [], isLoading: positionsLoading } = usePositions();
    const { data: transactionsQuery = [], isLoading: transactionsLoading } = useTransactions();
    const positions = positionsProp ?? positionsQuery;
    const transactions = transactionsProp ?? transactionsQuery;
    const loading = loadingProp ?? (positionsLoading || transactionsLoading);
    const [ownerFilter, setOwnerFilter] = useState<'All' | 'Yuchen' | 'Annie'>('All');
    const allClosedPositions = positions.filter(p => p.status === 'closed');
    const closedPositions = ownerFilter === 'All'
        ? allClosedPositions
        : allClosedPositions.filter(p => p.owner === ownerFilter);

    const stats = useMemo(() => {
        let totalPnL = 0, wins = 0, losses = 0, totalWinPnL = 0, totalLossPnL = 0;
        const setupStats: Record<string, BucketStats> = {};
        const strategyStats: Record<string, BucketStats> = {};
        const crossTabStats: Record<string, BucketStats> = {};

        closedPositions.forEach(p => {
            const txns = transactions.filter(t => t.position_id === p.id);
            let cost = 0, proceeds = 0, totalQty = 0;
            txns.forEach(t => {
                const price = t.price * CONTRACT_MULTIPLIER;
                if (t.quantity > 0) { cost += t.quantity * price; totalQty += t.quantity; }
                else proceeds += Math.abs(t.quantity) * price;
            });
            const pnl = proceeds - cost;
            totalPnL += pnl;
            if (pnl >= 0) { wins++; totalWinPnL += pnl; }
            else { losses++; totalLossPnL += pnl; }

            // Hold duration (days from open to close)
            const holdDays = (p.closed_at && p.created_at)
                ? Math.round((new Date(p.closed_at).getTime() - new Date(p.created_at).getTime()) / 86400000)
                : null;

            // R-Multiple: pnl / (max_risk_entry per contract × qty × multiplier)
            const maxRiskDollars = (p.max_risk_entry != null && totalQty > 0)
                ? p.max_risk_entry * totalQty * CONTRACT_MULTIPLIER
                : null;
            const rMult = (maxRiskDollars != null && maxRiskDollars !== 0) ? pnl / maxRiskDollars : null;

            // Accumulate setup bucket
            if (!setupStats[p.setup]) setupStats[p.setup] = emptyBucket();
            accumulateBucket(setupStats[p.setup], pnl, holdDays, rMult);

            // Accumulate strategy bucket
            const strategyType = p.type || 'Unknown';
            if (!strategyStats[strategyType]) strategyStats[strategyType] = emptyBucket();
            accumulateBucket(strategyStats[strategyType], pnl, holdDays, rMult);

            // Setup × Strategy cross-tab
            const crossKey = `${p.setup || 'Unknown'}|${p.strategy || p.type || 'Unknown'}`;
            if (!crossTabStats[crossKey]) crossTabStats[crossKey] = emptyBucket();
            accumulateBucket(crossTabStats[crossKey], pnl, holdDays, rMult);
        });

        const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;
        const avgWin = wins > 0 ? totalWinPnL / wins : 0;
        const avgLoss = losses > 0 ? totalLossPnL / losses : 0;
        const profitFactor = totalLossPnL !== 0
            ? Math.abs(totalWinPnL / totalLossPnL)
            : totalWinPnL > 0 ? Infinity : 0;

        return { totalPnL, wins, losses, winRate, avgWin, avgLoss, profitFactor, setupStats, strategyStats, crossTabStats };
    }, [closedPositions, transactions]);

    if (loading) return <LoadingSpinner />;

    return (
        <div className="fade-in pb-24 sm:pb-0">
            <h2 className="text-2xl font-bold mb-4">Performance Stats</h2>

            {/* Owner Filter */}
            <div className="flex items-center gap-1.5 mb-6">
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

                    {/* Strategy Breakdown */}
                    <h3 className="text-lg font-semibold mb-4 text-white/90">By Strategy</h3>
                    <div className="space-y-3 mb-8">
                        {Object.entries(stats.strategyStats)
                            .sort((a, b) => b[1].pnl - a[1].pnl)
                            .map(([strat, data]) => {
                                const total = data.wins + data.losses;
                                const wr = total > 0 ? (data.wins / total) * 100 : 0;
                                return (
                                    <div key={strat} className="card p-4 flex justify-between items-center bg-[#242426]/50">
                                        <div>
                                            <div className="font-medium text-[#E0E0E0]">{strat}</div>
                                            <div className="text-text-secondary text-sm">
                                                <span className="text-accent-green">{data.wins}W</span> / <span className="text-red-400">{data.losses}L</span> · {wr.toFixed(0)}%
                                            </div>
                                            <BucketMeta data={data} />
                                        </div>
                                        <div className={`text-xl font-bold font-mono ${data.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                                            {data.pnl >= 0 ? '+' : ''}{formatCurrency(data.pnl)}
                                        </div>
                                    </div>
                                );
                            })}
                    </div>

                    {/* Setup Breakdown */}
                    <h3 className="text-lg font-semibold mb-4 text-white/90">By Setup</h3>
                    <div className="space-y-3">
                        {Object.entries(stats.setupStats)
                            .sort((a, b) => b[1].pnl - a[1].pnl)
                            .map(([setup, data]) => {
                                const total = data.wins + data.losses;
                                const wr = total > 0 ? (data.wins / total) * 100 : 0;
                                return (
                                    <div key={setup} className="card p-4 flex justify-between items-center bg-[#242426]/50">
                                        <div>
                                            <div className="font-medium text-[#E0E0E0]">{setup || 'Unknown Setup'}</div>
                                            <div className="text-text-secondary text-sm">
                                                <span className="text-accent-green">{data.wins}W</span> / <span className="text-red-400">{data.losses}L</span> · {wr.toFixed(0)}%
                                            </div>
                                            <BucketMeta data={data} />
                                        </div>
                                        <div className={`text-xl font-bold font-mono ${data.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                                            {data.pnl >= 0 ? '+' : ''}{formatCurrency(data.pnl)}
                                        </div>
                                    </div>
                                );
                            })}
                    </div>

                    {/* Setup × Strategy Cross-Tab */}
                    {Object.keys(stats.crossTabStats).length > 0 && (
                        <>
                            <h3 className="text-lg font-semibold mb-4 mt-8 text-white/90">Setup × Strategy</h3>
                            <div className="space-y-3">
                                {Object.entries(stats.crossTabStats)
                                    .sort((a, b) => b[1].pnl - a[1].pnl)
                                    .map(([key, data]) => {
                                        const [setup, strategy] = key.split('|');
                                        const total = data.wins + data.losses;
                                        const wr = total > 0 ? (data.wins / total) * 100 : 0;
                                        return (
                                            <div key={key} className="card p-4 flex justify-between items-center bg-[#242426]/50">
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="badge bg-yellow-500/10 text-yellow-500 border border-yellow-500/20 text-xs">{setup}</span>
                                                        <span className="text-text-tertiary">+</span>
                                                        <span className="badge bg-violet-500/10 text-violet-400 border border-violet-500/20 text-xs">{strategy}</span>
                                                    </div>
                                                    <div className="text-text-secondary text-sm">
                                                        <span className="text-accent-green">{data.wins}W</span> / <span className="text-red-400">{data.losses}L</span> · {wr.toFixed(0)}%
                                                    </div>
                                                    <BucketMeta data={data} />
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

                    {/* Score → P&L Validation (F3: Forensic Audit v1.1) */}
                    <div className="mt-8">
                        <ScoreValidation />
                    </div>
                </>
            )}
        </div>
    );
};
