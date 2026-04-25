import React, { useMemo } from 'react';
import { useFillDiagnostics, type FillDiagnosticRow } from '../../hooks/useFillDiagnostics';
import { formatCurrency, formatDate } from '../../lib/utils';

interface AggregateStats {
  count: number;
  avgActualNetDebit: number;
  avgPredictedNetDebit: number;
  avgSlippageDelta: number;       // mean(actual − predicted), per share
  avgAbsSlippageDelta: number;    // mean|actual − predicted|
  worstDelta: number;
  bestDelta: number;
  pctWithSnapshot: number;        // fraction of rows where both legs had a chain snapshot
}

function aggregate(rows: FillDiagnosticRow[]): AggregateStats {
  if (rows.length === 0) {
    return {
      count: 0, avgActualNetDebit: 0, avgPredictedNetDebit: 0,
      avgSlippageDelta: 0, avgAbsSlippageDelta: 0,
      worstDelta: 0, bestDelta: 0, pctWithSnapshot: 0,
    };
  }
  const withPrediction = rows.filter(r => r.predicted_net_debit != null && r.slippage_delta_abs != null);
  const sumActual = rows.reduce((s, r) => s + (r.actual_net_debit ?? 0), 0);
  const sumPredicted = withPrediction.reduce((s, r) => s + (r.predicted_net_debit ?? 0), 0);
  const deltas = withPrediction.map(r => r.slippage_delta_abs as number);
  const sumDelta = deltas.reduce((s, d) => s + d, 0);
  const sumAbsDelta = deltas.reduce((s, d) => s + Math.abs(d), 0);
  return {
    count: rows.length,
    avgActualNetDebit: sumActual / rows.length,
    avgPredictedNetDebit: withPrediction.length ? sumPredicted / withPrediction.length : 0,
    avgSlippageDelta: deltas.length ? sumDelta / deltas.length : 0,
    avgAbsSlippageDelta: deltas.length ? sumAbsDelta / deltas.length : 0,
    worstDelta: deltas.length ? Math.max(...deltas) : 0,
    bestDelta: deltas.length ? Math.min(...deltas) : 0,
    pctWithSnapshot: withPrediction.length / rows.length,
  };
}

function StatBlock({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-bg-tertiary/40 border border-border-default/30 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className="text-sm font-mono text-text-primary mt-0.5">{value}</div>
      {hint && <div className="text-[10px] text-text-tertiary mt-0.5">{hint}</div>}
    </div>
  );
}

export const FillQualityCard: React.FC = () => {
  const { data: rows = [], isLoading, error } = useFillDiagnostics();

  const bcdStats = useMemo(() => aggregate(rows.filter(r => r.strategy_type === 'bcd')), [rows]);
  const pmccStats = useMemo(() => aggregate(rows.filter(r => r.strategy_type === 'pmcc')), [rows]);

  if (isLoading) {
    return <div className="text-text-tertiary text-xs">Loading fill diagnostics…</div>;
  }
  if (error) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] px-3 py-2.5 text-xs text-amber-300">
        Couldn't load fill diagnostics: {(error as Error).message}. Has the 017_fill_diagnostics migration been applied?
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg bg-bg-secondary/40 border border-border-default/30 px-4 py-4 text-xs text-text-tertiary">
        No fill-quality captures yet. Enter a BCD or PMCC trade through the entry modal and the chain snapshot + model prediction will be logged here for calibration.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Aggregate stats per strategy */}
      {[
        { label: 'BCD', stats: bcdStats },
        { label: 'PMCC', stats: pmccStats },
      ].map(({ label, stats }) => (
        <div key={label} className="card-glass p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">{label} fill quality</h3>
            <span className="text-[11px] text-text-tertiary">{stats.count} trade{stats.count === 1 ? '' : 's'}</span>
          </div>
          {stats.count === 0 ? (
            <p className="text-xs text-text-tertiary">No {label} entries captured yet.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatBlock
                label="Actual avg"
                value={`$${stats.avgActualNetDebit.toFixed(2)}`}
                hint="user-entered net debit / share"
              />
              <StatBlock
                label="Model avg"
                value={`$${stats.avgPredictedNetDebit.toFixed(2)}`}
                hint="slippage model prediction"
              />
              <StatBlock
                label="Avg Δ (actual − model)"
                value={`${stats.avgSlippageDelta >= 0 ? '+' : ''}$${stats.avgSlippageDelta.toFixed(3)}`}
                hint={stats.avgSlippageDelta > 0 ? 'user filling worse than model' : 'user filling better than model'}
              />
              <StatBlock
                label="Worst | Best Δ"
                value={`+$${stats.worstDelta.toFixed(3)} | ${stats.bestDelta >= 0 ? '+' : ''}$${stats.bestDelta.toFixed(3)}`}
                hint="per share, bounds of the sample"
              />
            </div>
          )}
        </div>
      ))}

      {/* Recent captures */}
      <div className="card-glass p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Recent captures</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-text-tertiary uppercase tracking-wider text-[10px]">
              <tr className="border-b border-border-default/30">
                <th className="text-left py-1.5 pr-3">Captured</th>
                <th className="text-left py-1.5 pr-3">Strat</th>
                <th className="text-right py-1.5 pr-3">Qty</th>
                <th className="text-right py-1.5 pr-3">Actual</th>
                <th className="text-right py-1.5 pr-3">Model</th>
                <th className="text-right py-1.5 pr-3">Δ / share</th>
                <th className="text-right py-1.5 pr-3">Δ total $</th>
                <th className="text-left py-1.5">Snapshot</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 30).map(r => {
                const deltaPerShare = r.slippage_delta_abs;
                const deltaTotalDollars = deltaPerShare != null ? deltaPerShare * 100 * r.quantity : null;
                const hasSnapshot = r.legs.every(l => l.bid != null);
                const deltaColor = deltaPerShare == null
                  ? 'text-text-tertiary'
                  : deltaPerShare > 0 ? 'text-accent-red' : 'text-accent-green';
                return (
                  <tr key={r.id} className="border-b border-border-default/10 text-text-secondary">
                    <td className="py-1.5 pr-3 font-mono">{formatDate(r.captured_at.slice(0, 10))}</td>
                    <td className="py-1.5 pr-3 uppercase">{r.strategy_type ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{r.quantity}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      {r.actual_net_debit != null ? `$${r.actual_net_debit.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      {r.predicted_net_debit != null ? `$${r.predicted_net_debit.toFixed(2)}` : '—'}
                    </td>
                    <td className={`py-1.5 pr-3 text-right font-mono ${deltaColor}`}>
                      {deltaPerShare != null ? `${deltaPerShare >= 0 ? '+' : ''}$${deltaPerShare.toFixed(3)}` : '—'}
                    </td>
                    <td className={`py-1.5 pr-3 text-right font-mono ${deltaColor}`}>
                      {deltaTotalDollars != null ? `${deltaTotalDollars >= 0 ? '+' : ''}${formatCurrency(deltaTotalDollars)}` : '—'}
                    </td>
                    <td className="py-1.5">
                      {hasSnapshot
                        ? <span className="text-accent-green/80 text-[10px]">✓ both legs</span>
                        : <span className="text-amber-400/80 text-[10px]">partial</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > 30 && (
            <p className="text-[10px] text-text-tertiary mt-2">Showing latest 30 of {rows.length} captures.</p>
          )}
        </div>
      </div>

      <p className="text-[10px] text-text-tertiary">
        Δ = actual − model prediction, per share. Positive Δ means fills came in WORSE than
        <code className="mx-1 px-1 bg-bg-tertiary/40 rounded">slippage.ts</code> expected —
        every +$0.10 per share on a 2-contract trade is $20 of unmodeled friction.
        After ~10 captures, feed the average Δ back into the slippage config's <code className="mx-1 px-1 bg-bg-tertiary/40 rounded">baseImpactBps</code>.
      </p>
    </div>
  );
};
