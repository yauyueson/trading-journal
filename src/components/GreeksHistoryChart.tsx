import React from 'react';
import {
    ResponsiveContainer,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend
} from 'recharts';
import { GreeksHistory } from '../lib/types';
import { CHART_COLORS, CHART_FONT_MONO } from '../lib/chartTheme';

interface GreeksHistoryChartProps {
    data: GreeksHistory[];
    loading?: boolean;
}

export const GreeksHistoryChart: React.FC<GreeksHistoryChartProps> = ({ data, loading }) => {
    if (loading) {
        return (
            <div className="h-48 flex items-center justify-center">
                <div className="spinner w-6 h-6" />
            </div>
        );
    }

    if (!data || data.length === 0) {
        return (
            <div className="h-48 flex items-center justify-center text-text-tertiary text-xs font-mono uppercase tracking-wider">
                ▌ No history data yet. Data will be recorded daily.
            </div>
        );
    }

    // Format data for chart
    const chartData = data.map(d => ({
        date: new Date(d.recorded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        iv: d.iv ? Number((d.iv * 100).toFixed(1)) : null,
        delta: d.delta ? Number(d.delta.toFixed(3)) : null
    }));

    // IV → phosphor amber, Delta → phosphor dim (CRT-friendly distinction).
    const IV_COLOR = CHART_COLORS.warning;
    const DELTA_COLOR = '#00CC33';

    return (
        <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                    <XAxis
                        dataKey="date"
                        tick={{ fill: CHART_COLORS.axisText, fontSize: 11, fontFamily: CHART_FONT_MONO }}
                        axisLine={{ stroke: CHART_COLORS.axisLine }}
                    />
                    <YAxis
                        yAxisId="left"
                        tick={{ fill: IV_COLOR, fontSize: 11, fontFamily: CHART_FONT_MONO }}
                        axisLine={{ stroke: CHART_COLORS.axisLine }}
                        tickFormatter={(v) => `${v}%`}
                    />
                    <YAxis
                        yAxisId="right"
                        orientation="right"
                        tick={{ fill: DELTA_COLOR, fontSize: 11, fontFamily: CHART_FONT_MONO }}
                        axisLine={{ stroke: CHART_COLORS.axisLine }}
                        domain={[0, 1]}
                    />
                    <Tooltip
                        contentStyle={{
                            backgroundColor: CHART_COLORS.tooltipBg,
                            border: `1px solid ${CHART_COLORS.tooltipBorder}`,
                            borderRadius: 6,
                            fontSize: 12,
                            fontFamily: CHART_FONT_MONO,
                            boxShadow: CHART_COLORS.tooltipShadow,
                        }}
                        labelStyle={{ color: '#fff' }}
                    />
                    <Legend
                        wrapperStyle={{ fontSize: '11px', fontFamily: CHART_FONT_MONO, textTransform: 'uppercase', letterSpacing: '0.05em' }}
                        formatter={(value) => value === 'iv' ? 'IV' : 'Delta'}
                    />
                    <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="iv"
                        stroke={IV_COLOR}
                        strokeWidth={2}
                        dot={{ fill: IV_COLOR, r: 3 }}
                        activeDot={{ r: 5 }}
                        connectNulls
                    />
                    <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="delta"
                        stroke={DELTA_COLOR}
                        strokeWidth={2}
                        dot={{ fill: DELTA_COLOR, r: 3 }}
                        activeDot={{ r: 5 }}
                        connectNulls
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
};
