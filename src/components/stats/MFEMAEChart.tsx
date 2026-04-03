import React, { useMemo } from 'react';
import { useTradeOutcomes } from '../../hooks/useTradeOutcomes';

export const MFEMAEChart: React.FC = () => {
  const { data: outcomes, isLoading, error } = useTradeOutcomes();

  const stats = useMemo(() => {
    if (!outcomes || outcomes.length === 0) return null;

    const valid = outcomes.filter(o => o.mfe_pct != null && o.mae_pct != null && o.final_pct != null);
    if (valid.length === 0) return null;

    const avgMFE = valid.reduce((s, o) => s + o.mfe_pct!, 0) / valid.length;
    const avgMAE = valid.reduce((s, o) => s + Math.abs(o.mae_pct!), 0) / valid.length;
    const avgFinal = valid.reduce((s, o) => s + o.final_pct!, 0) / valid.length;
    const captureRatio = avgMFE > 0 ? (avgFinal / avgMFE) * 100 : 0;
    const winners = valid.filter(o => o.final_pct! > 0);
    const losers = valid.filter(o => o.final_pct! <= 0);

    // Scale for scatter plot
    const maxMFE = Math.max(...valid.map(o => o.mfe_pct!), 1);
    const maxMAE = Math.max(...valid.map(o => Math.abs(o.mae_pct!)), 1);
    const scale = Math.max(maxMFE, maxMAE) * 1.1;

    return { valid, avgMFE, avgMAE, avgFinal, captureRatio, winners, losers, scale };
  }, [outcomes]);

  if (isLoading) return <p className="text-xs text-text-tertiary py-8 text-center">Loading trade outcomes...</p>;
  if (error) return <p className="text-xs text-red-400 py-8 text-center">Error: {(error as Error).message}</p>;
  if (!stats) {
    return (
      <div className="bg-bg-secondary rounded-lg border border-white/10 p-6 text-center">
        <p className="text-sm text-text-tertiary">No trade outcomes computed yet.</p>
        <p className="text-xs text-text-tertiary mt-1">The MFE/MAE cron runs daily after market close for closed trades.</p>
      </div>
    );
  }

  const { valid, avgMFE, avgMAE, avgFinal, captureRatio, winners, losers, scale } = stats;

  // Generate insight text
  let insight = '';
  if (captureRatio < 40) {
    insight = `You capture only ${captureRatio.toFixed(0)}% of available upside. Consider widening take-profit targets.`;
  } else if (captureRatio > 80) {
    insight = `Excellent capture ratio (${captureRatio.toFixed(0)}%). Your exit timing is strong.`;
  } else {
    insight = `Capture ratio: ${captureRatio.toFixed(0)}% of avg MFE. Room to tighten exits.`;
  }

  if (avgMAE > avgMFE * 1.5) {
    insight += ` Avg MAE (${avgMAE.toFixed(1)}%) is much larger than avg MFE (${avgMFE.toFixed(1)}%) — consider tighter stop losses.`;
  }

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Avg MFE" value={`+${avgMFE.toFixed(1)}%`} color="text-green-400" />
        <StatCard label="Avg MAE" value={`-${avgMAE.toFixed(1)}%`} color="text-red-400" />
        <StatCard label="Avg P&L" value={`${avgFinal >= 0 ? '+' : ''}${avgFinal.toFixed(1)}%`}
          color={avgFinal >= 0 ? 'text-green-400' : 'text-red-400'} />
        <StatCard label="Capture" value={`${captureRatio.toFixed(0)}%`}
          sub={`of MFE captured`} color="text-accent-green" />
      </div>

      {/* Scatter plot (CSS-based) */}
      <div className="bg-bg-secondary rounded-lg border border-white/10 p-4">
        <h3 className="text-sm font-medium mb-3">MFE vs MAE Scatter ({valid.length} trades)</h3>
        <div className="relative w-full" style={{ paddingBottom: '60%' }}>
          <div className="absolute inset-0">
            {/* Axes */}
            <div className="absolute bottom-0 left-12 right-4 h-px bg-white/10" />
            <div className="absolute top-4 bottom-0 left-12 w-px bg-white/10" />
            {/* Labels */}
            <span className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-4 text-[10px] text-text-tertiary">
              MAE (adverse) %
            </span>
            <span className="absolute top-1/2 left-0 -translate-y-1/2 -rotate-90 text-[10px] text-text-tertiary origin-center whitespace-nowrap">
              MFE (favorable) %
            </span>

            {/* Dots */}
            {valid.map((o, i) => {
              const x = (Math.abs(o.mae_pct!) / scale) * 100;
              const y = (o.mfe_pct! / scale) * 100;
              const isWin = o.final_pct! > 0;
              return (
                <div
                  key={i}
                  className={`absolute w-2 h-2 rounded-full ${isWin ? 'bg-green-400' : 'bg-red-400'} opacity-70 hover:opacity-100 transition-opacity`}
                  style={{
                    left: `calc(12px + ${x}% * 0.85)`,
                    bottom: `calc(${y}% * 0.85)`,
                  }}
                  title={`${o.ticker}: MFE +${o.mfe_pct!.toFixed(1)}%, MAE ${o.mae_pct!.toFixed(1)}%, P&L ${o.final_pct!.toFixed(1)}%`}
                />
              );
            })}

            {/* Avg lines */}
            <div
              className="absolute h-px bg-green-400/30 border-t border-dashed border-green-400/40"
              style={{
                left: '12px',
                right: '16px',
                bottom: `calc(${(avgMFE / scale) * 100}% * 0.85)`,
              }}
            />
            <div
              className="absolute w-px bg-red-400/30 border-l border-dashed border-red-400/40"
              style={{
                top: '16px',
                bottom: '0',
                left: `calc(12px + ${(avgMAE / scale) * 100}% * 0.85)`,
              }}
            />
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-2 text-[10px] text-text-tertiary">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> Winner ({winners.length})
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> Loser ({losers.length})
          </span>
          <span className="flex items-center gap-1">
            <span className="w-4 border-t border-dashed border-green-400/40 inline-block" /> Avg MFE
          </span>
          <span className="flex items-center gap-1">
            <span className="w-4 border-t border-dashed border-red-400/40 inline-block" /> Avg MAE
          </span>
        </div>
      </div>

      {/* Insight */}
      <div className="bg-bg-secondary rounded-lg border border-white/10 p-4">
        <p className="text-xs text-text-secondary">{insight}</p>
      </div>
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: string; color: string; sub?: string }> = ({ label, value, color, sub }) => (
  <div className="bg-bg-secondary rounded-lg border border-white/10 p-3">
    <p className="text-[10px] text-text-tertiary uppercase tracking-wider">{label}</p>
    <p className={`text-lg font-semibold font-mono ${color}`}>{value}</p>
    {sub && <p className="text-[10px] text-text-tertiary mt-0.5">{sub}</p>}
  </div>
);
