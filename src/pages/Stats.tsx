import React, { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Position, Transaction } from '../lib/types';
import {
    computePositionPnL,
    computeRiskMultiple,
    formatCurrency,
    getOpenedQuantity,
    getStrategyKind,
    groupTransactionsByPositionId,
} from '../lib/utils';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ScoreValidation } from '../components/ScoreValidation';
import { EquityCurve } from '../components/stats/EquityCurve';
import { MonthlyHeatmap } from '../components/stats/MonthlyHeatmap';
import { DisciplineCard } from '../components/stats/DisciplineCard';
import { MFEMAEChart } from '../components/stats/MFEMAEChart';
import { FillQualityCard } from '../components/stats/FillQualityCard';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';
import { useAppSettings } from '../context/AppSettingsContext';
import { RETIRED_STRATEGIES, type StrategyType } from '../lib/strategyProfiles';

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
                <span className={`text-[11px] font-mono font-semibold ${avgR >= 0 ? 'text-phosphor-green' : 'text-phosphor-red'}`}>
                    R: {avgR >= 0 ? '+' : ''}{avgR.toFixed(2)}x
                </span>
            )}
        </div>
    );
};

/** Reusable bucket list renderer */
const BucketList: React.FC<{ entries: [string, BucketStats][]; renderLabel?: (key: string) => React.ReactNode }> = ({ entries, renderLabel }) => (
    <div className="space-y-3">
        {entries
            .sort((a, b) => b[1].pnl - a[1].pnl)
            .map(([key, data]) => {
                const total = data.wins + data.losses;
                const wr = total > 0 ? (data.wins / total) * 100 : 0;
                return (
                    <div key={key} className="py-3 border-b border-phosphor-green/10 flex justify-between items-center">
                        <div>
                            {renderLabel ? renderLabel(key) : (
                                <div className="font-mono uppercase tracking-wider text-text-primary">{key || 'Unknown'}</div>
                            )}
                            <div className="text-text-secondary text-xs font-mono uppercase tracking-wider">
                                <span className="text-phosphor-green">{data.wins}W</span> / <span className="text-phosphor-red">{data.losses}L</span> · {wr.toFixed(0)}%
                            </div>
                            <BucketMeta data={data} />
                        </div>
                        <div className={`text-xl font-bold font-mono tabular-nums ${data.pnl >= 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'}`}>
                            {data.pnl >= 0 ? '+' : ''}{formatCurrency(data.pnl)}
                        </div>
                    </div>
                );
            })}
    </div>
);

type StatsTab = 'overview' | 'breakdowns' | 'discipline' | 'validation' | 'mfe-mae' | 'fill-quality';

const TABS: { key: StatsTab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'breakdowns', label: 'Breakdowns' },
    { key: 'discipline', label: 'Discipline' },
    { key: 'validation', label: 'Validation' },
    { key: 'mfe-mae', label: 'MFE/MAE' },
    { key: 'fill-quality', label: 'Fill Quality' },
];

export const StatsPage: React.FC<StatsPageProps> = ({ positions: positionsProp, transactions: transactionsProp, loading: loadingProp }) => {
    const { data: positionsQuery = [], isLoading: positionsLoading } = usePositions();
    const { data: transactionsQuery = [], isLoading: transactionsLoading } = useTransactions();
    const positions = positionsProp ?? positionsQuery;
    const transactions = transactionsProp ?? transactionsQuery;
    const loading = loadingProp ?? (positionsLoading || transactionsLoading);
    const { activeStrategy } = useAppSettings();
    const [ownerFilter, setOwnerFilter] = useState<'All' | 'Yuchen' | 'Annie'>('All');
    const [strategyFilter, setStrategyFilter] = useState<'All' | 'bcd' | 'pmcc' | 'legacy'>('All');
    const [statsTab, setStatsTab] = useState<StatsTab>('overview');
    const allClosedPositions = useMemo(
        () => positions.filter(p => p.status === 'closed'),
        [positions],
    );
    const ownerFiltered = useMemo(
        () => ownerFilter === 'All'
            ? allClosedPositions
            : allClosedPositions.filter(p => p.owner === ownerFilter),
        [allClosedPositions, ownerFilter],
    );
    const closedPositions = useMemo(
        () => strategyFilter === 'All'
            ? ownerFiltered
            : strategyFilter === 'legacy'
                ? ownerFiltered.filter(p => p.strategy_type && RETIRED_STRATEGIES.has(p.strategy_type as StrategyType))
                : ownerFiltered.filter(p => p.strategy_type === strategyFilter),
        [ownerFiltered, strategyFilter],
    );

    const stats = useMemo(() => {
        const transactionsByPosition = groupTransactionsByPositionId(transactions);
        let totalPnL = 0, wins = 0, losses = 0, totalWinPnL = 0, totalLossPnL = 0;
        const setupStats: Record<string, BucketStats> = {};
        const strategyStats: Record<string, BucketStats> = {};
        const crossTabStats: Record<string, BucketStats> = {};
        const dteStats: Record<string, BucketStats> = {};
        const regimeStats: Record<string, BucketStats> = {};
        const holdDurationStats: Record<string, BucketStats> = {};
        const exitTypeStats: Record<string, BucketStats> = {};
        const spreadWidthStats: Record<string, BucketStats> = {};

        // Equity curve data
        const equityTrades: { closedAt: string; pnl: number; ticker: string }[] = [];
        // Monthly heatmap data
        const heatmapTrades: { closedAt: string; pnl: number }[] = [];

        closedPositions.forEach(p => {
            const txns = transactionsByPosition[p.id] ?? [];
            const totalQty = getOpenedQuantity(txns);
            const pnl = computePositionPnL(txns, getStrategyKind(p));
            totalPnL += pnl;
            if (pnl >= 0) { wins++; totalWinPnL += pnl; }
            else { losses++; totalLossPnL += pnl; }

            // Hold duration (days from open to close)
            const holdDays = (p.closed_at && p.created_at)
                ? Math.round((new Date(p.closed_at).getTime() - new Date(p.created_at).getTime()) / 86400000)
                : null;

            // R-Multiple
            const rMult = computeRiskMultiple(pnl, p.max_risk_entry, totalQty);

            // Setup bucket
            if (!setupStats[p.setup]) setupStats[p.setup] = emptyBucket();
            accumulateBucket(setupStats[p.setup], pnl, holdDays, rMult);

            // Strategy bucket
            const strategyType = p.type || 'Unknown';
            if (!strategyStats[strategyType]) strategyStats[strategyType] = emptyBucket();
            accumulateBucket(strategyStats[strategyType], pnl, holdDays, rMult);

            // Cross-tab
            const crossKey = `${p.setup || 'Unknown'}|${p.strategy || p.type || 'Unknown'}`;
            if (!crossTabStats[crossKey]) crossTabStats[crossKey] = emptyBucket();
            accumulateBucket(crossTabStats[crossKey], pnl, holdDays, rMult);

            // DTE bucket (days from open to expiration) — strategy-conditional
            if (p.expiration && p.created_at) {
                const openDate = new Date(p.created_at);
                const expDate = new Date(p.expiration);
                const dte = Math.round((expDate.getTime() - openDate.getTime()) / 86400000);
                const dteBucket = activeStrategy === 'shortTerm'
                    ? (dte < 5 ? '<5d' : dte < 10 ? '5-10d' : dte < 14 ? '10-14d' : '14+d')
                    : (dte < 30 ? '<30d' : dte < 45 ? '30-45d' : dte < 65 ? '45-65d' : '65+d');
                if (!dteStats[dteBucket]) dteStats[dteBucket] = emptyBucket();
                accumulateBucket(dteStats[dteBucket], pnl, holdDays, rMult);
            }

            // Regime bucket
            const regime = p.iv_regime_entry || 'Unknown';
            if (!regimeStats[regime]) regimeStats[regime] = emptyBucket();
            accumulateBucket(regimeStats[regime], pnl, holdDays, rMult);

            // Hold duration bucket
            if (holdDays != null) {
                const holdBucket = holdDays < 3 ? '<3d' : holdDays <= 7 ? '3-7d' : holdDays <= 14 ? '7-14d' : '14+d';
                if (!holdDurationStats[holdBucket]) holdDurationStats[holdBucket] = emptyBucket();
                accumulateBucket(holdDurationStats[holdBucket], pnl, holdDays, rMult);
            }

            // Exit type bucket (opt-in — only positions with explicit exit_type recorded)
            if (p.exit_type) {
                if (!exitTypeStats[p.exit_type]) exitTypeStats[p.exit_type] = emptyBucket();
                accumulateBucket(exitTypeStats[p.exit_type], pnl, holdDays, rMult);
            }

            // Spread width bucket (only for positions with spread_width set)
            if (p.spread_width != null) {
                const wBucket = p.spread_width <= 5 ? '$5' : p.spread_width <= 10 ? '$10' : p.spread_width <= 15 ? '$15' : '$20+';
                if (!spreadWidthStats[wBucket]) spreadWidthStats[wBucket] = emptyBucket();
                accumulateBucket(spreadWidthStats[wBucket], pnl, holdDays, rMult);
            }

            // Equity curve + heatmap data
            if (p.closed_at) {
                equityTrades.push({ closedAt: p.closed_at, pnl, ticker: p.ticker });
                heatmapTrades.push({ closedAt: p.closed_at, pnl });
            }
        });

        // Sort equity trades by close date
        equityTrades.sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());

        const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;
        const avgWin = wins > 0 ? totalWinPnL / wins : 0;
        const avgLoss = losses > 0 ? totalLossPnL / losses : 0;
        const profitFactor = totalLossPnL !== 0
            ? Math.abs(totalWinPnL / totalLossPnL)
            : totalWinPnL > 0 ? Infinity : 0;

        return {
            totalPnL, wins, losses, winRate, avgWin, avgLoss, profitFactor,
            setupStats, strategyStats, crossTabStats,
            dteStats, regimeStats, holdDurationStats,
            exitTypeStats, spreadWidthStats,
            equityTrades, heatmapTrades,
        };
    }, [closedPositions, transactions, activeStrategy]);

    if (loading) return <LoadingSpinner />;

    return (
        <div className="stagger-fade-in pb-24 sm:pb-0">
            <h2 className="text-xl sm:text-2xl font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4">
                ▌ PERFORMANCE_STATS
            </h2>

            <div className="lg:flex lg:gap-8">
                {/* Sidebar — filters + vertical tabs on desktop */}
                <div className="lg:w-48 shrink-0 lg:sticky lg:top-20 lg:self-start">
                    {/* Owner Filter */}
                    <div className="mb-4">
                        <span className="label-mono mb-1.5 block">▌ OWNER</span>
                        <div className="flex items-center gap-1.5 lg:flex-col lg:items-stretch">
                            {(['All', 'Yuchen', 'Annie'] as const).map(value => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => setOwnerFilter(value)}
                                    className={`px-3 py-1.5 rounded-md text-[11px] font-mono uppercase tracking-wider transition-all min-h-[36px] cursor-pointer lg:text-left ${ownerFilter === value
                                        ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40'
                                        : 'bg-terminal-panel text-text-tertiary border border-border-default/50 hover:text-phosphor-dim hover:border-phosphor-green/20'
                                        }`}
                                >
                                    {value}
                                </button>
                            ))}
                        </div>
                    </div>
                    {/* Strategy Filter */}
                    <div className="mb-4">
                        <span className="label-mono mb-1.5 block">▌ STRATEGY</span>
                        <div className="flex items-center gap-1.5 lg:flex-col lg:items-stretch">
                            {([['All', 'All'], ['bcd', 'BCD'], ['pmcc', 'PMCC'], ['legacy', 'Legacy']] as const).map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => setStrategyFilter(value as typeof strategyFilter)}
                                    className={`px-3 py-1.5 rounded-md text-[11px] font-mono uppercase tracking-wider transition-all min-h-[36px] cursor-pointer lg:text-left ${strategyFilter === value
                                        ? value === 'legacy'
                                            ? 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/40'
                                            : 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40'
                                        : 'bg-terminal-panel text-text-tertiary border border-border-default/50 hover:text-phosphor-dim hover:border-phosphor-green/20'
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Vertical tab nav — desktop only */}
                    {closedPositions.length > 0 && (
                        <div className="hidden lg:flex flex-col gap-1">
                            {TABS.map(tab => (
                                <button
                                    key={tab.key}
                                    type="button"
                                    onClick={() => setStatsTab(tab.key)}
                                    className={`text-left px-3 py-2 rounded-md text-[11px] font-mono uppercase tracking-wider transition-all cursor-pointer ${
                                        statsTab === tab.key
                                            ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border-l-2 border-phosphor-green'
                                            : 'text-text-tertiary hover:text-phosphor-dim border-l-2 border-transparent'
                                    }`}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Main content */}
                <div className="flex-1 min-w-0">
            {closedPositions.length === 0 ? (
                <div className="terminal-panel text-center py-16">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-phosphor-green/[0.08] border border-phosphor-green/30 flex items-center justify-center">
                        <BarChart3 size={32} strokeWidth={1.5} className="text-phosphor-green" />
                    </div>
                    <p className="text-phosphor-green text-glow-green text-sm font-mono uppercase tracking-widest font-bold">▌ NO_CLOSED_TRADES</p>
                    <p className="text-text-tertiary text-xs font-mono mt-2">Complete some trades to see your stats.</p>
                </div>
            ) : (
                <>
                    {/* Sub-tab pills — mobile only */}
                    <div className="flex items-center gap-1.5 mb-6 overflow-x-auto scrollbar-hide lg:hidden">
                        {TABS.map(tab => (
                            <button
                                key={tab.key}
                                type="button"
                                onClick={() => setStatsTab(tab.key)}
                                className={`px-3.5 py-1.5 rounded-md text-[11px] font-mono uppercase tracking-wider transition-all whitespace-nowrap min-h-[36px] cursor-pointer ${
                                    statsTab === tab.key
                                        ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40'
                                        : 'bg-terminal-panel text-text-tertiary border border-border-default/50 hover:text-phosphor-dim hover:border-phosphor-green/20'
                                }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    {/* ═══ OVERVIEW TAB ═══ */}
                    {statsTab === 'overview' && (
                        <>
                            {/* Key Metrics \u2014 phosphor terminal tiles */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                                <div className="terminal-panel p-4">
                                    <span className="label-mono">\u258C TOTAL P&L</span>
                                    <div className={`text-3xl font-bold font-mono tabular-nums mt-1 ${stats.totalPnL >= 0 ? 'metric-glow-pos' : 'metric-glow-neg'}`}>
                                        {stats.totalPnL >= 0 ? '+' : ''}{formatCurrency(stats.totalPnL)}
                                    </div>
                                </div>
                                <div className="terminal-panel p-4">
                                    <span className="label-mono">\u258C WIN RATE</span>
                                    <div className={`text-3xl font-bold font-mono tabular-nums mt-1 ${stats.winRate >= 50 ? 'metric-glow-pos' : 'metric-glow-neg'}`}>
                                        {stats.winRate.toFixed(1)}%
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                                <div className="terminal-panel p-4">
                                    <span className="label-mono">AVG WIN</span>
                                    <div className="text-xl font-bold font-mono tabular-nums mt-1 metric-glow-pos">{formatCurrency(stats.avgWin)}</div>
                                </div>
                                <div className="terminal-panel p-4">
                                    <span className="label-mono">AVG LOSS</span>
                                    <div className="text-xl font-bold font-mono tabular-nums mt-1 metric-glow-neg">{formatCurrency(Math.abs(stats.avgLoss))}</div>
                                </div>
                                <div className="terminal-panel p-4">
                                    <span className="label-mono">PROFIT FACTOR</span>
                                    <div className={`text-xl font-bold font-mono tabular-nums mt-1 ${stats.profitFactor >= 1 ? 'metric-glow-pos' : 'metric-glow-neg'}`}>
                                        {stats.profitFactor === Infinity ? '\u221E' : stats.profitFactor.toFixed(2)}
                                    </div>
                                </div>
                                <div className="terminal-panel p-4">
                                    <span className="label-mono">TOTAL TRADES</span>
                                    <div className="text-xl font-bold font-mono tabular-nums mt-1 text-text-primary">{closedPositions.length}</div>
                                </div>
                            </div>

                            {/* Equity Curve */}
                            <div className="mb-6">
                                <EquityCurve trades={stats.equityTrades} />
                            </div>

                            {/* Monthly Heatmap */}
                            <MonthlyHeatmap trades={stats.heatmapTrades} />
                        </>
                    )}

                    {/* ═══ BREAKDOWNS TAB ═══ */}
                    {statsTab === 'breakdowns' && (
                        <>
                            <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4 pt-6 mt-2 border-t border-phosphor-green/15">▌ BY_STRATEGY</h3>
                            <div className="mb-8">
                                <BucketList entries={Object.entries(stats.strategyStats)} />
                            </div>

                            <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4 pt-6 mt-2 border-t border-phosphor-green/15">▌ BY_SETUP</h3>
                            <div className="mb-8">
                                <BucketList entries={Object.entries(stats.setupStats)} renderLabel={key => (
                                    <div className="font-medium text-text-primary">{key || 'Unknown Setup'}</div>
                                )} />
                            </div>

                            {Object.keys(stats.crossTabStats).length > 0 && (
                                <>
                                    <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4 pt-6 mt-2 border-t border-phosphor-green/15">▌ SETUP × STRATEGY</h3>
                                    <div className="mb-8">
                                        <BucketList
                                            entries={Object.entries(stats.crossTabStats)}
                                            renderLabel={key => {
                                                const [setup, strategy] = key.split('|');
                                                return (
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="badge bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/30 text-[10px] font-mono uppercase tracking-wider">{setup}</span>
                                                        <span className="text-text-tertiary">+</span>
                                                        <span className="badge bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/30 text-[10px] font-mono uppercase tracking-wider">{strategy}</span>
                                                    </div>
                                                );
                                            }}
                                        />
                                    </div>
                                </>
                            )}

                            {/* DTE Breakdown */}
                            {Object.keys(stats.dteStats).length > 0 && (
                                <>
                                    <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4 pt-6 mt-2 border-t border-phosphor-green/15">▌ BY_DTE_AT_ENTRY</h3>
                                    <div className="mb-8">
                                        <BucketList entries={Object.entries(stats.dteStats).sort((a, b) => {
                                            const order = activeStrategy === 'shortTerm'
                                                ? ['<5d', '5-10d', '10-14d', '14+d']
                                                : ['<30d', '30-45d', '45-65d', '65+d'];
                                            return order.indexOf(a[0]) - order.indexOf(b[0]);
                                        })} renderLabel={key => (
                                            <div className="font-medium text-text-primary">{key} DTE</div>
                                        )} />
                                    </div>
                                </>
                            )}

                            {/* Regime Breakdown */}
                            {Object.keys(stats.regimeStats).length > 0 && (
                                <>
                                    <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4 pt-6 mt-2 border-t border-phosphor-green/15">▌ BY_IV_REGIME</h3>
                                    <div className="mb-8">
                                        <BucketList entries={Object.entries(stats.regimeStats)} />
                                    </div>
                                </>
                            )}

                            {/* Hold Duration Breakdown */}
                            {Object.keys(stats.holdDurationStats).length > 0 && (
                                <>
                                    <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4 pt-6 mt-2 border-t border-phosphor-green/15">▌ BY_HOLD_DURATION</h3>
                                    <div className="mb-8">
                                        <BucketList entries={Object.entries(stats.holdDurationStats).sort((a, b) => {
                                            const order = ['<3d', '3-7d', '7-14d', '14+d'];
                                            return order.indexOf(a[0]) - order.indexOf(b[0]);
                                        })} />
                                    </div>
                                </>
                            )}

                            {/* Exit Type Breakdown */}
                            {Object.keys(stats.exitTypeStats).length > 0 && (
                                <>
                                    <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4 pt-6 mt-2 border-t border-phosphor-green/15">▌ BY_EXIT_REASON</h3>
                                    <div className="mb-8">
                                        <BucketList entries={Object.entries(stats.exitTypeStats)} renderLabel={key => {
                                            const labels: Record<string, string> = { TP: 'Profit Target', SL: 'Stop Loss', TIME: 'Time Stop', MANUAL: 'Manual Close', ROLL: 'Rolled' };
                                            return <div className="font-medium text-text-primary">{labels[key] || key}</div>;
                                        }} />
                                    </div>
                                </>
                            )}

                            {/* Spread Width Breakdown */}
                            {Object.keys(stats.spreadWidthStats).length > 0 && (
                                <>
                                    <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4 pt-6 mt-2 border-t border-phosphor-green/15">▌ BY_SPREAD_WIDTH</h3>
                                    <div className="mb-8">
                                        <BucketList entries={Object.entries(stats.spreadWidthStats).sort((a, b) => {
                                            const order = ['$5', '$10', '$15', '$20+'];
                                            return order.indexOf(a[0]) - order.indexOf(b[0]);
                                        })} renderLabel={key => (
                                            <div className="font-medium text-text-primary">{key} wide</div>
                                        )} />
                                    </div>
                                </>
                            )}
                        </>
                    )}

                    {/* ═══ DISCIPLINE TAB ═══ */}
                    {statsTab === 'discipline' && (
                        <DisciplineCard closedPositions={closedPositions} transactions={transactions} />
                    )}

                    {/* ═══ VALIDATION TAB ═══ */}
                    {statsTab === 'validation' && (
                        <div className="mt-2">
                            <ScoreValidation />
                        </div>
                    )}

                    {/* ═══ MFE/MAE TAB ═══ */}
                    {statsTab === 'mfe-mae' && (
                        <div className="mt-2">
                            <MFEMAEChart />
                        </div>
                    )}

                    {/* ═══ FILL QUALITY TAB ═══ */}
                    {statsTab === 'fill-quality' && (
                        <div className="mt-2">
                            <FillQualityCard />
                        </div>
                    )}
                </>
            )}
                </div>
            </div>
        </div>
    );
};
