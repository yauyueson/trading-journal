import React, { useMemo } from 'react';
import {
    ResponsiveContainer,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    Cell,
} from 'recharts';
import { Position, Transaction } from '../../lib/types';
import { formatCurrency, computePositionPnL, getStrategyKind, groupTransactionsByPositionId } from '../../lib/utils';
import { CHART_COLORS, CHART_FONT_MONO } from '../../lib/chartTheme';

interface DisciplineCardProps {
    closedPositions: Position[];
    transactions: Transaction[];
}

type ExitType = 'TP' | 'SL' | 'TIME' | 'MANUAL' | 'ROLL' | 'EXP_PROFIT' | 'EXP_LOSS' | 'EARLY_PROFIT' | 'EARLY_DEFENSE' | 'Unknown';

// Phosphor-aligned exit-type palette: green for healthy outcomes, amber for time/manual, red for losses, dim for ambiguous.
const EXIT_COLORS: Record<ExitType, string> = {
    TP: '#00FF41',         // phosphor green — clean profit target
    SL: '#FF2D00',         // phosphor red — stop hit
    TIME: '#FFB000',       // phosphor amber — expiry without TP/SL
    MANUAL: '#868F97',     // neutral — manual close
    ROLL: '#00CC33',       // phosphor dim — roll (defensive but disciplined)
    EXP_PROFIT: '#00FF41', // phosphor green
    EXP_LOSS: '#FF2D00',   // phosphor red
    EARLY_PROFIT: '#7FFF00', // chartreuse — early-profit close
    EARLY_DEFENSE: '#FFB000', // phosphor amber — defensive
    Unknown: '#555555',
};

const EXIT_LABELS: Record<ExitType, string> = {
    TP: 'Take Profit',
    SL: 'Stop Loss',
    TIME: 'Expiry',
    MANUAL: 'Manual',
    ROLL: 'Roll',
    EXP_PROFIT: 'Expired +',
    EXP_LOSS: 'Expired −',
    EARLY_PROFIT: 'Early Profit',
    EARLY_DEFENSE: 'Early Defense',
    Unknown: 'Unknown',
};

export const DisciplineCard: React.FC<DisciplineCardProps> = ({ closedPositions, transactions }) => {
    const metrics = useMemo(() => {
        const transactionsByPosition = groupTransactionsByPositionId(transactions);
        const byType: Record<ExitType, { count: number; totalPnl: number }> = {
            TP: { count: 0, totalPnl: 0 },
            SL: { count: 0, totalPnl: 0 },
            TIME: { count: 0, totalPnl: 0 },
            MANUAL: { count: 0, totalPnl: 0 },
            ROLL: { count: 0, totalPnl: 0 },
            EXP_PROFIT: { count: 0, totalPnl: 0 },
            EXP_LOSS: { count: 0, totalPnl: 0 },
            EARLY_PROFIT: { count: 0, totalPnl: 0 },
            EARLY_DEFENSE: { count: 0, totalPnl: 0 },
            Unknown: { count: 0, totalPnl: 0 },
        };
        let withExitType = 0;

        closedPositions.forEach(p => {
            const txns = transactionsByPosition[p.id] ?? [];
            const pnl = computePositionPnL(txns, getStrategyKind(p));
            const et: ExitType = (p.exit_type as ExitType) || 'Unknown';
            byType[et].count++;
            byType[et].totalPnl += pnl;
            if (p.exit_type) withExitType++;
        });

        const tp = byType.TP.count;
        const sl = byType.SL.count;
        const tpSlWinRate = (tp + sl) > 0 ? (tp / (tp + sl)) * 100 : null;
        const disciplineRate = closedPositions.length > 0
            ? ((tp + sl) / closedPositions.length) * 100 : null;

        // Expectancy: (tpRate * avgTpPnl) + (slRate * avgSlPnl)
        const tpRate = (tp + sl) > 0 ? tp / (tp + sl) : 0;
        const slRate = (tp + sl) > 0 ? sl / (tp + sl) : 0;
        const avgTpPnl = tp > 0 ? byType.TP.totalPnl / tp : 0;
        const avgSlPnl = sl > 0 ? byType.SL.totalPnl / sl : 0;
        const expectancy = (tp + sl) > 0 ? tpRate * avgTpPnl + slRate * avgSlPnl : null;

        // Bar chart data
        const barData = (Object.keys(byType) as ExitType[])
            .filter(k => byType[k].count > 0)
            .map(k => ({
                name: EXIT_LABELS[k],
                count: byType[k].count,
                color: EXIT_COLORS[k],
                avgPnl: byType[k].count > 0 ? byType[k].totalPnl / byType[k].count : 0,
                totalPnl: byType[k].totalPnl,
            }));

        // Rule adherence
        let entryCompliant = 0, entryTotal = 0;
        let exitCompliant = 0, exitTotal = 0;
        closedPositions.forEach(p => {
            const isSwing = p.strategy_type === 'swing';
            const isST = p.strategy_type === 'shortTerm';
            if (!isSwing && !isST) return; // skip untagged

            // Entry compliance: IV Rank >= threshold
            entryTotal++;
            const ivThreshold = isSwing ? 30 : 20;
            const ivOk = p.iv_rank_entry != null && p.iv_rank_entry >= ivThreshold;
            // Width compliance
            const expectedWidth = isSwing ? 15 : 10;
            const widthOk = p.spread_width == null || Math.abs(p.spread_width - expectedWidth) <= 2.5;
            if (ivOk && widthOk) entryCompliant++;

            // Exit compliance
            if (p.exit_type) {
                exitTotal++;
                const isTP = p.exit_type === 'TP';
                const isTime = p.exit_type === 'TIME';
                if (isTP || isTime) exitCompliant++;
            }
        });
        const entryCompliancePct = entryTotal > 0 ? (entryCompliant / entryTotal) * 100 : null;
        const exitCompliancePct = exitTotal > 0 ? (exitCompliant / exitTotal) * 100 : null;

        return { byType, tpSlWinRate, disciplineRate, expectancy, barData, withExitType, total: closedPositions.length, entryCompliancePct, exitCompliancePct, entryCompliant, entryTotal, exitCompliant, exitTotal };
    }, [closedPositions, transactions]);

    if (metrics.withExitType === 0) {
        return (
            <div className="terminal-panel p-6 text-center">
                <p className="text-phosphor-green text-glow-green text-sm font-mono uppercase tracking-widest font-bold">▌ NO_EXIT_DATA</p>
                <p className="text-text-tertiary text-xs font-mono mt-2">
                    Exit types will appear once you close trades with the updated app.
                </p>
                <p className="text-text-tertiary/60 text-[10px] font-mono mt-1">
                    Future closes auto-detect TP, SL, Expiry, Manual, or Roll.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Data coverage note */}
            {metrics.withExitType < metrics.total && (
                <div className="text-[11px] text-phosphor-amber font-mono uppercase tracking-wider bg-phosphor-amber/[0.04] border border-phosphor-amber/20 rounded-md px-3 py-2">
                    ▌ {metrics.withExitType} OF {metrics.total} TRADES HAVE EXIT DATA
                </div>
            )}

            {/* Hero: TP/SL Win Rate */}
            <div className="terminal-panel p-5">
                <span className="label-mono">▌ TP / SL WIN RATE</span>
                <div className="flex items-baseline gap-3 mt-1">
                    <span className={`text-4xl font-bold font-mono tabular-nums ${metrics.tpSlWinRate != null && metrics.tpSlWinRate >= 50 ? 'metric-glow-pos' : 'metric-glow-neg'}`}>
                        {metrics.tpSlWinRate != null ? `${metrics.tpSlWinRate.toFixed(1)}%` : '—'}
                    </span>
                    {metrics.byType.TP.count + metrics.byType.SL.count > 0 && (
                        <span className="text-[11px] text-text-tertiary font-mono uppercase tracking-wider">
                            <span className="text-phosphor-green">{metrics.byType.TP.count} TP</span>
                            {' / '}
                            <span className="text-phosphor-red">{metrics.byType.SL.count} SL</span>
                        </span>
                    )}
                </div>
            </div>

            {/* Secondary metrics */}
            <div className="grid grid-cols-2 gap-3">
                <div className="terminal-panel p-4">
                    <span className="label-mono">DISCIPLINE RATE</span>
                    <div className={`text-xl font-bold font-mono tabular-nums mt-1 ${metrics.disciplineRate != null && metrics.disciplineRate >= 50 ? 'metric-glow-pos' : 'text-text-secondary'}`}>
                        {metrics.disciplineRate != null ? `${metrics.disciplineRate.toFixed(1)}%` : '—'}
                    </div>
                    <div className="text-[10px] text-text-tertiary font-mono mt-0.5">TP+SL / total closes</div>
                </div>
                <div className="terminal-panel p-4">
                    <span className="label-mono">EXPECTANCY</span>
                    <div className={`text-xl font-bold font-mono tabular-nums mt-1 ${metrics.expectancy != null && metrics.expectancy >= 0 ? 'metric-glow-pos' : 'metric-glow-neg'}`}>
                        {metrics.expectancy != null ? `${metrics.expectancy >= 0 ? '+' : ''}${formatCurrency(metrics.expectancy)}` : '—'}
                    </div>
                    <div className="text-[10px] text-text-tertiary font-mono mt-0.5">per TP/SL trade</div>
                </div>
            </div>

            {/* Exit type bar chart */}
            {metrics.barData.length > 0 && (
                <div className="terminal-panel p-4">
                    <h4 className="label-mono mb-3">▌ EXIT_TYPE_DISTRIBUTION</h4>
                    <div className="h-[160px] sm:h-[180px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={metrics.barData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                                <XAxis type="number" tick={{ fill: CHART_COLORS.axisText, fontSize: 11, fontFamily: CHART_FONT_MONO }} axisLine={false} tickLine={false} />
                                <YAxis
                                    type="category"
                                    dataKey="name"
                                    tick={{ fill: '#ccc', fontSize: 12, fontFamily: CHART_FONT_MONO }}
                                    axisLine={false}
                                    tickLine={false}
                                    width={80}
                                />
                                <Tooltip
                                    contentStyle={{
                                        background: CHART_COLORS.tooltipBg,
                                        border: `1px solid ${CHART_COLORS.tooltipBorder}`,
                                        borderRadius: 6,
                                        fontSize: 12,
                                        fontFamily: CHART_FONT_MONO,
                                        boxShadow: CHART_COLORS.tooltipShadow,
                                    }}
                                    formatter={(value: number | undefined) => [value ?? 0, 'Trades']}
                                />
                                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                                    {metrics.barData.map((entry, i) => (
                                        <Cell key={i} fill={entry.color} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            )}

            {/* Rule Adherence */}
            {(metrics.entryTotal > 0 || metrics.exitTotal > 0) && (
                <div className="grid grid-cols-2 gap-3">
                    <div className="terminal-panel p-4">
                        <span className="label-mono">ENTRY RULES</span>
                        <div className={`text-xl font-bold font-mono tabular-nums mt-1 ${metrics.entryCompliancePct != null && metrics.entryCompliancePct >= 80 ? 'metric-glow-pos' : metrics.entryCompliancePct != null && metrics.entryCompliancePct >= 60 ? 'metric-glow-warn' : 'metric-glow-neg'}`}>
                            {metrics.entryCompliancePct != null ? `${metrics.entryCompliancePct.toFixed(0)}%` : '—'}
                        </div>
                        <div className="text-[10px] text-text-tertiary font-mono mt-0.5">{metrics.entryCompliant}/{metrics.entryTotal} compliant</div>
                        <div className="text-[10px] text-text-tertiary/60 font-mono mt-1">IV Rank + Width check</div>
                    </div>
                    <div className="terminal-panel p-4">
                        <span className="label-mono">EXIT RULES</span>
                        <div className={`text-xl font-bold font-mono tabular-nums mt-1 ${metrics.exitCompliancePct != null && metrics.exitCompliancePct >= 80 ? 'metric-glow-pos' : metrics.exitCompliancePct != null && metrics.exitCompliancePct >= 60 ? 'metric-glow-warn' : 'metric-glow-neg'}`}>
                            {metrics.exitCompliancePct != null ? `${metrics.exitCompliancePct.toFixed(0)}%` : '—'}
                        </div>
                        <div className="text-[10px] text-text-tertiary font-mono mt-0.5">{metrics.exitCompliant}/{metrics.exitTotal} TP/TIME</div>
                        <div className="text-[10px] text-text-tertiary/60 font-mono mt-1">vs MANUAL/SL exits</div>
                    </div>
                </div>
            )}

            {/* Avg P&L by exit type */}
            <div className="terminal-panel p-4">
                <h4 className="label-mono mb-3">▌ AVG_P&L_BY_EXIT_TYPE</h4>
                <div className="space-y-2">
                    {metrics.barData.map(d => (
                        <div key={d.name} className="flex justify-between items-center py-1.5 border-b border-phosphor-green/10 last:border-0">
                            <div className="flex items-center gap-2">
                                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color, boxShadow: `0 0 6px ${d.color}88` }} />
                                <span className="text-sm text-text-primary font-mono uppercase tracking-wider">{d.name}</span>
                                <span className="text-xs text-text-tertiary font-mono">({d.count})</span>
                            </div>
                            <span className={`font-mono font-bold tabular-nums text-sm ${d.avgPnl >= 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'}`}>
                                {d.avgPnl >= 0 ? '+' : ''}{formatCurrency(d.avgPnl)}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
