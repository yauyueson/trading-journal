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
import { CHART_COLORS, CHART_FONT_MONO, axisProps } from '../../lib/chartTheme';

interface EquityCurveProps {
    /** Closed positions sorted by closed_at with their P&L already computed */
    trades: { closedAt: string; pnl: number; ticker: string }[];
}

export const EquityCurve: React.FC<EquityCurveProps> = ({ trades }) => {
    const chartData = useMemo(() => {
        const result: { index: number; date: string; cumPnL: number; ticker: string; pnl: number }[] = [];
        trades.reduce((cum, t, i) => {
            const cumPnL = cum + t.pnl;
            result.push({
                index: i + 1,
                date: new Date(t.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                cumPnL,
                ticker: t.ticker,
                pnl: t.pnl,
            });
            return cumPnL;
        }, 0);
        return result;
    }, [trades]);

    if (trades.length < 2) {
        return (
            <div className="terminal-panel p-6 chart-container flex items-center justify-center text-text-tertiary text-xs font-mono uppercase tracking-wider">
                Need at least 2 closed trades to show equity curve
            </div>
        );
    }

    const maxVal = Math.max(...chartData.map(d => d.cumPnL));
    const minVal = Math.min(...chartData.map(d => d.cumPnL));

    return (
        <div className="terminal-panel p-4">
            <h3 className="label-mono mb-3">▌ EQUITY_CURVE</h3>
            <div className="chart-container">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                        <defs>
                            <linearGradient id="eqGreen" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={CHART_COLORS.positive} stopOpacity={0.3} />
                                <stop offset="95%" stopColor={CHART_COLORS.positive} stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                        <XAxis
                            dataKey="date"
                            {...axisProps}
                            axisLine={{ stroke: CHART_COLORS.axisLine }}
                        />
                        <YAxis
                            {...axisProps}
                            axisLine={false}
                            tickFormatter={(v: number) => `$${v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v.toFixed(0)}`}
                            domain={[Math.min(minVal * 1.1, 0), maxVal * 1.1]}
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
                            formatter={(value: number | undefined) => [value != null ? formatCurrency(value) : '$0', 'Cumulative P&L']}
                            labelFormatter={(_, payload) => {
                                if (payload && payload[0]) {
                                    const d = payload[0].payload;
                                    return `TRADE #${d.index} · ${d.ticker} · ${d.date}`;
                                }
                                return '';
                            }}
                        />
                        <Area
                            type="monotone"
                            dataKey="cumPnL"
                            stroke={CHART_COLORS.positive}
                            strokeWidth={2}
                            fill="url(#eqGreen)"
                            dot={false}
                            activeDot={{ r: 4, fill: CHART_COLORS.positive, stroke: CHART_COLORS.tooltipBg, strokeWidth: 2 }}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};
