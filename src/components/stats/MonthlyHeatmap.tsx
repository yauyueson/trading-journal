import React, { useMemo } from 'react';

interface MonthlyHeatmapProps {
    trades: { closedAt: string; pnl: number }[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const MonthlyHeatmap: React.FC<MonthlyHeatmapProps> = ({ trades }) => {
    const { grid, years, maxAbs } = useMemo(() => {
        const map: Record<string, number> = {};
        const yearSet = new Set<number>();
        trades.forEach(t => {
            const d = new Date(t.closedAt);
            const y = d.getFullYear();
            const m = d.getMonth();
            const key = `${y}-${m}`;
            map[key] = (map[key] || 0) + t.pnl;
            yearSet.add(y);
        });
        const years = Array.from(yearSet).sort();
        const maxAbs = Math.max(1, ...Object.values(map).map(Math.abs));
        return { grid: map, years, maxAbs };
    }, [trades]);

    if (trades.length === 0) {
        return (
            <div className="card p-6 flex items-center justify-center text-text-tertiary text-sm h-24">
                No closed trades yet
            </div>
        );
    }

    const cellBg = (val: number | undefined): string => {
        if (val == null || val === 0) return 'rgba(255,255,255,0.03)';
        const intensity = Math.min(1, Math.abs(val) / maxAbs);
        const alpha = 0.15 + intensity * 0.55;
        return val > 0
            ? `rgba(16,185,129,${alpha})`
            : `rgba(239,68,68,${alpha})`;
    };

    return (
        <div className="card p-4">
            <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">Monthly P&L</h3>
            <div className="overflow-x-auto">
                <div className="min-w-[600px]">
                    {/* Month headers */}
                    <div className="grid grid-cols-[60px_repeat(12,1fr)] gap-1 mb-1">
                        <div />
                        {MONTHS.map(m => (
                            <div key={m} className="text-center text-[10px] text-text-tertiary font-medium">{m}</div>
                        ))}
                    </div>
                    {/* Year rows */}
                    {years.map(year => (
                        <div key={year} className="grid grid-cols-[60px_repeat(12,1fr)] gap-1 mb-1">
                            <div className="text-xs text-text-tertiary font-mono flex items-center">{year}</div>
                            {Array.from({ length: 12 }, (_, m) => {
                                const key = `${year}-${m}`;
                                const val = grid[key];
                                const hasData = val != null && val !== 0;
                                return (
                                    <div
                                        key={m}
                                        className="rounded-md h-10 flex items-center justify-center text-[11px] font-mono font-semibold text-white"
                                        style={{ backgroundColor: cellBg(val) }}
                                        title={hasData ? `${MONTHS[m]} ${year}: ${val >= 0 ? '+' : ''}$${val.toFixed(0)}` : `${MONTHS[m]} ${year}: No trades`}
                                    >
                                        {hasData ? (
                                            <span>
                                                {val >= 0 ? '+' : ''}{Math.abs(val) >= 1000 ? `${(val / 1000).toFixed(1)}K` : `$${val.toFixed(0)}`}
                                            </span>
                                        ) : (
                                            <span className="text-white/10">&mdash;</span>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
