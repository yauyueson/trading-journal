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
import { formatCurrency, computePositionPnL } from '../../lib/utils';

interface DisciplineCardProps {
    closedPositions: Position[];
    transactions: Transaction[];
}

type ExitType = 'TP' | 'SL' | 'TIME' | 'MANUAL' | 'ROLL' | 'Unknown';

const EXIT_COLORS: Record<ExitType, string> = {
    TP: '#00C805',
    SL: '#FF5000',
    TIME: '#FFD60A',
    MANUAL: '#A3A3A3',
    ROLL: '#0A84FF',
    Unknown: '#555555',
};

const EXIT_LABELS: Record<ExitType, string> = {
    TP: 'Take Profit',
    SL: 'Stop Loss',
    TIME: 'Expiry',
    MANUAL: 'Manual',
    ROLL: 'Roll',
    Unknown: 'Unknown',
};

export const DisciplineCard: React.FC<DisciplineCardProps> = ({ closedPositions, transactions }) => {
    const metrics = useMemo(() => {
        const byType: Record<ExitType, { count: number; totalPnl: number }> = {
            TP: { count: 0, totalPnl: 0 },
            SL: { count: 0, totalPnl: 0 },
            TIME: { count: 0, totalPnl: 0 },
            MANUAL: { count: 0, totalPnl: 0 },
            ROLL: { count: 0, totalPnl: 0 },
            Unknown: { count: 0, totalPnl: 0 },
        };
        let withExitType = 0;

        closedPositions.forEach(p => {
            const txns = transactions.filter(t => t.position_id === p.id);
            const pnl = computePositionPnL(txns);
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

        return { byType, tpSlWinRate, disciplineRate, expectancy, barData, withExitType, total: closedPositions.length };
    }, [closedPositions, transactions]);

    if (metrics.withExitType === 0) {
        return (
            <div className="card p-6 text-center">
                <p className="text-text-tertiary text-sm">
                    Exit types will appear once you close trades with the updated app.
                </p>
                <p className="text-text-tertiary/60 text-xs mt-2">
                    Future closes will auto-detect TP, SL, Expiry, Manual, or Roll.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Data coverage note */}
            {metrics.withExitType < metrics.total && (
                <div className="text-xs text-text-tertiary bg-white/[0.03] rounded-lg px-3 py-2">
                    {metrics.withExitType} of {metrics.total} trades have exit data
                </div>
            )}

            {/* Hero: TP/SL Win Rate */}
            <div className="card p-5">
                <div className="text-text-tertiary text-xs uppercase tracking-wider mb-2">TP / SL Win Rate</div>
                <div className="flex items-baseline gap-3">
                    <span className={`text-4xl font-bold ${metrics.tpSlWinRate != null && metrics.tpSlWinRate >= 50 ? 'text-accent-green' : 'text-accent-red'}`}>
                        {metrics.tpSlWinRate != null ? `${metrics.tpSlWinRate.toFixed(1)}%` : '—'}
                    </span>
                    {metrics.byType.TP.count + metrics.byType.SL.count > 0 && (
                        <span className="text-sm text-text-tertiary">
                            <span className="text-accent-green">{metrics.byType.TP.count} TP</span>
                            {' / '}
                            <span className="text-accent-red">{metrics.byType.SL.count} SL</span>
                        </span>
                    )}
                </div>
            </div>

            {/* Secondary metrics */}
            <div className="grid grid-cols-2 gap-3">
                <div className="card p-4">
                    <div className="text-text-tertiary text-xs uppercase tracking-wider mb-1">Discipline Rate</div>
                    <div className={`text-xl font-bold ${metrics.disciplineRate != null && metrics.disciplineRate >= 50 ? 'text-accent-green' : 'text-text-secondary'}`}>
                        {metrics.disciplineRate != null ? `${metrics.disciplineRate.toFixed(1)}%` : '—'}
                    </div>
                    <div className="text-[11px] text-text-tertiary mt-0.5">TP+SL / total closes</div>
                </div>
                <div className="card p-4">
                    <div className="text-text-tertiary text-xs uppercase tracking-wider mb-1">Expectancy</div>
                    <div className={`text-xl font-bold font-mono ${metrics.expectancy != null && metrics.expectancy >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                        {metrics.expectancy != null ? `${metrics.expectancy >= 0 ? '+' : ''}${formatCurrency(metrics.expectancy)}` : '—'}
                    </div>
                    <div className="text-[11px] text-text-tertiary mt-0.5">per TP/SL trade</div>
                </div>
            </div>

            {/* Exit type bar chart */}
            {metrics.barData.length > 0 && (
                <div className="card p-4">
                    <h4 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">Exit Type Distribution</h4>
                    <div className="h-[180px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={metrics.barData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                                <XAxis type="number" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} />
                                <YAxis
                                    type="category"
                                    dataKey="name"
                                    tick={{ fill: '#ccc', fontSize: 12 }}
                                    axisLine={false}
                                    tickLine={false}
                                    width={80}
                                />
                                <Tooltip
                                    contentStyle={{
                                        background: '#1C1C1E',
                                        border: '1px solid rgba(255,255,255,0.1)',
                                        borderRadius: 12,
                                        fontSize: 13,
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

            {/* Avg P&L by exit type */}
            <div className="card p-4">
                <h4 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">Avg P&L by Exit Type</h4>
                <div className="space-y-2">
                    {metrics.barData.map(d => (
                        <div key={d.name} className="flex justify-between items-center py-1.5 border-b border-white/[0.04] last:border-0">
                            <div className="flex items-center gap-2">
                                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                                <span className="text-sm text-text-primary">{d.name}</span>
                                <span className="text-xs text-text-tertiary">({d.count})</span>
                            </div>
                            <span className={`font-mono font-semibold text-sm ${d.avgPnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                                {d.avgPnl >= 0 ? '+' : ''}{formatCurrency(d.avgPnl)}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
