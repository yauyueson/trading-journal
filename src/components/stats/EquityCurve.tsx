import React, { useMemo } from 'react';
import {
    ResponsiveContainer,
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
} from 'recharts';
import { formatCurrency } from '../../lib/utils';

interface EquityCurveProps {
    /** Closed positions sorted by closed_at with their P&L already computed */
    trades: { closedAt: string; pnl: number; ticker: string }[];
}

export const EquityCurve: React.FC<EquityCurveProps> = ({ trades }) => {
    const chartData = useMemo(() => {
        let cumulative = 0;
        return trades.map((t, i) => {
            cumulative += t.pnl;
            return {
                index: i + 1,
                date: new Date(t.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                cumPnL: cumulative,
                ticker: t.ticker,
                pnl: t.pnl,
            };
        });
    }, [trades]);

    if (trades.length < 2) {
        return (
            <div className="card p-6 h-[250px] flex items-center justify-center text-text-tertiary text-sm">
                Need at least 2 closed trades to show equity curve
            </div>
        );
    }

    const maxVal = Math.max(...chartData.map(d => d.cumPnL));
    const minVal = Math.min(...chartData.map(d => d.cumPnL));

    return (
        <div className="card p-4">
            <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">Equity Curve</h3>
            <div className="h-[250px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                        <defs>
                            <linearGradient id="eqGreen" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#00C805" stopOpacity={0.3} />
                                <stop offset="95%" stopColor="#00C805" stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <XAxis
                            dataKey="date"
                            tick={{ fill: '#888', fontSize: 11 }}
                            tickLine={false}
                            axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                        />
                        <YAxis
                            tick={{ fill: '#888', fontSize: 11 }}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={(v: number) => `$${v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v.toFixed(0)}`}
                            domain={[Math.min(minVal * 1.1, 0), maxVal * 1.1]}
                        />
                        <Tooltip
                            contentStyle={{
                                background: '#1C1C1E',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: 12,
                                fontSize: 13,
                            }}
                            formatter={(value: number | undefined) => [value != null ? formatCurrency(value) : '$0', 'Cumulative P&L']}
                            labelFormatter={(_, payload) => {
                                if (payload && payload[0]) {
                                    const d = payload[0].payload;
                                    return `Trade #${d.index} · ${d.ticker} · ${d.date}`;
                                }
                                return '';
                            }}
                        />
                        <Area
                            type="monotone"
                            dataKey="cumPnL"
                            stroke="#00C805"
                            strokeWidth={2}
                            fill="url(#eqGreen)"
                            dot={false}
                            activeDot={{ r: 4, fill: '#00C805' }}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};
