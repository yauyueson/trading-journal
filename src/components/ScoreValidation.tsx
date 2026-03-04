import React, { useEffect, useState } from 'react';
import { TrendingUp, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';

interface Bucket {
    label: string;
    scoreRange: [number, number];
    candidateCount: number;
    closedCount: number;
    hitRate: number | null;
    avgPnl: number | null;
    totalPnl: number;
    profitFactor: number | null;
}

interface ValidationData {
    success: boolean;
    message?: string;
    totalLinked: number;
    totalClosed: number;
    monotonic?: boolean;
    buckets: Bucket[];
}

export const ScoreValidation: React.FC = () => {
    const [data, setData] = useState<ValidationData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        fetch('/api/analytics?type=score-validation')
            .then(r => r.json())
            .then(d => { setData(d); setError(null); })
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    if (loading) {
        return (
            <div className="card p-6 bg-[#242426]/50">
                <div className="flex items-center gap-2 text-text-secondary">
                    <Loader2 size={16} className="animate-spin" />
                    <span className="text-sm">Loading score validation...</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="card p-6 bg-[#242426]/50">
                <div className="text-red-400 text-sm">Score validation error: {error}</div>
            </div>
        );
    }

    if (!data || data.totalClosed === 0) {
        return (
            <div className="card p-6 bg-[#242426]/50">
                <h3 className="text-lg font-semibold text-white/90 flex items-center gap-2 mb-2">
                    <TrendingUp size={18} />
                    Score → P&L Validation
                </h3>
                <p className="text-text-tertiary text-sm">
                    {data?.message || 'No closed positions linked to scored candidates yet. Trade from recommendations to populate.'}
                </p>
            </div>
        );
    }

    const hasData = data.buckets.some(b => b.closedCount > 0);

    return (
        <div className="card p-6 bg-[#242426]/50">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-white/90 flex items-center gap-2">
                    <TrendingUp size={18} />
                    Score → P&L Validation
                </h3>
                {data.monotonic != null && hasData && (
                    <div className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full ${
                        data.monotonic
                            ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    }`}>
                        {data.monotonic ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
                        {data.monotonic ? 'Monotonic' : 'Non-monotonic'}
                    </div>
                )}
            </div>

            <div className="text-xs text-text-tertiary mb-4">
                {data.totalLinked} candidates linked · {data.totalClosed} closed positions
            </div>

            {/* Bucket table */}
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-text-tertiary text-xs border-b border-border-default/30">
                            <th className="text-left py-2 pr-3 font-medium">Score</th>
                            <th className="text-right py-2 px-3 font-medium">Trades</th>
                            <th className="text-right py-2 px-3 font-medium">Win %</th>
                            <th className="text-right py-2 px-3 font-medium">Avg P&L</th>
                            <th className="text-right py-2 px-3 font-medium">Total</th>
                            <th className="text-right py-2 pl-3 font-medium">PF</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.buckets.map(b => (
                            <tr key={b.label} className="border-b border-border-default/10">
                                <td className="py-2 pr-3 font-mono text-white/80">{b.label}</td>
                                <td className="py-2 px-3 text-right text-text-secondary">
                                    {b.closedCount > 0 ? b.closedCount : <span className="text-text-tertiary">—</span>}
                                </td>
                                <td className="py-2 px-3 text-right">
                                    {b.hitRate != null ? (
                                        <span className={b.hitRate >= 50 ? 'text-green-400' : 'text-red-400'}>
                                            {b.hitRate}%
                                        </span>
                                    ) : <span className="text-text-tertiary">—</span>}
                                </td>
                                <td className="py-2 px-3 text-right font-mono">
                                    {b.avgPnl != null ? (
                                        <span className={b.avgPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                                            {b.avgPnl >= 0 ? '+' : ''}${b.avgPnl}
                                        </span>
                                    ) : <span className="text-text-tertiary">—</span>}
                                </td>
                                <td className="py-2 px-3 text-right font-mono">
                                    {b.closedCount > 0 ? (
                                        <span className={b.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                                            {b.totalPnl >= 0 ? '+' : ''}${b.totalPnl}
                                        </span>
                                    ) : <span className="text-text-tertiary">—</span>}
                                </td>
                                <td className="py-2 pl-3 text-right font-mono">
                                    {b.profitFactor != null && b.profitFactor !== Infinity ? (
                                        <span className={b.profitFactor >= 1.0 ? 'text-green-400' : 'text-red-400'}>
                                            {b.profitFactor.toFixed(2)}
                                        </span>
                                    ) : b.profitFactor === Infinity ? (
                                        <span className="text-green-400">∞</span>
                                    ) : <span className="text-text-tertiary">—</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {!data.monotonic && hasData && (
                <div className="mt-3 text-xs text-amber-400/80 flex items-center gap-1.5">
                    <AlertTriangle size={12} />
                    Higher scores don't consistently correlate with better win rates. Scoring may need recalibration.
                </div>
            )}
        </div>
    );
};
