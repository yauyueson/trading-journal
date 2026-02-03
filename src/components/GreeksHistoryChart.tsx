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
            <div className="h-48 flex items-center justify-center text-text-tertiary text-sm">
                No history data yet. Data will be recorded daily.
            </div>
        );
    }

    // Format data for chart
    const chartData = data.map(d => ({
        date: new Date(d.recorded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        iv: d.iv ? Number((d.iv * 100).toFixed(1)) : null,
        delta: d.delta ? Number(d.delta.toFixed(3)) : null
    }));

    return (
        <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                    <XAxis
                        dataKey="date"
                        tick={{ fill: '#888', fontSize: 11 }}
                        axisLine={{ stroke: 'rgba(255,255,255,0.2)' }}
                    />
                    <YAxis
                        yAxisId="left"
                        tick={{ fill: '#22d3ee', fontSize: 11 }}
                        axisLine={{ stroke: 'rgba(255,255,255,0.2)' }}
                        tickFormatter={(v) => `${v}%`}
                    />
                    <YAxis
                        yAxisId="right"
                        orientation="right"
                        tick={{ fill: '#a78bfa', fontSize: 11 }}
                        axisLine={{ stroke: 'rgba(255,255,255,0.2)' }}
                        domain={[0, 1]}
                    />
                    <Tooltip
                        contentStyle={{
                            backgroundColor: 'rgba(0,0,0,0.9)',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: '8px',
                            fontSize: '12px'
                        }}
                        labelStyle={{ color: '#fff' }}
                    />
                    <Legend
                        wrapperStyle={{ fontSize: '12px' }}
                        formatter={(value) => value === 'iv' ? 'IV' : 'Delta'}
                    />
                    <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="iv"
                        stroke="#22d3ee"
                        strokeWidth={2}
                        dot={{ fill: '#22d3ee', r: 3 }}
                        activeDot={{ r: 5 }}
                        connectNulls
                    />
                    <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="delta"
                        stroke="#a78bfa"
                        strokeWidth={2}
                        dot={{ fill: '#a78bfa', r: 3 }}
                        activeDot={{ r: 5 }}
                        connectNulls
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
};
