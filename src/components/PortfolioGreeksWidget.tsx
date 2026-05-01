import React from 'react';
import type { PortfolioGreeksResult } from '../lib/riskSizing';

interface Props {
    greeks: PortfolioGreeksResult;
}

export const PortfolioGreeksWidget: React.FC<Props> = ({ greeks }) => (
    <div className="terminal-panel p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <span className="label-mono">
                ▌ PORTFOLIO_GREEKS — {greeks.positionsWithData} POSITION{greeks.positionsWithData !== 1 ? 'S' : ''} LIVE
            </span>
            {Math.abs(greeks.netDelta) > 200 && (
                <span className="text-[10px] font-mono uppercase tracking-wider font-bold text-phosphor-amber text-glow-amber border border-phosphor-amber/40 bg-phosphor-amber/10 px-2 py-0.5 rounded">
                    HIGH DIRECTIONAL EXPOSURE
                </span>
            )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div>
                <div className={`text-base sm:text-lg font-bold font-mono tabular-nums ${greeks.netDelta > 150 ? 'metric-glow-pos' :
                        greeks.netDelta < -150 ? 'metric-glow-neg' :
                            'text-text-primary'
                    }`}>
                    {greeks.netDelta > 0 ? '+' : ''}{greeks.netDelta.toFixed(0)}
                </div>
                <div className="label-mono mt-0.5">NET DELTA (SHARES)</div>
            </div>
            <div>
                <div className={`text-base sm:text-lg font-bold font-mono tabular-nums ${greeks.netTheta > 15 ? 'metric-glow-pos' :
                        greeks.netTheta < -25 ? 'metric-glow-neg' :
                            'text-text-primary'
                    }`}>
                    {greeks.netTheta >= 0 ? '+' : ''}${greeks.netTheta.toFixed(0)}/d
                </div>
                <div className="label-mono mt-0.5">NET THETA</div>
            </div>
            <div>
                <div className={`text-base sm:text-lg font-bold font-mono tabular-nums ${greeks.netVega > 0 ? 'metric-glow-warn' :
                        greeks.netVega < 0 ? 'text-phosphor-dim' :
                            'text-text-primary'
                    }`}>
                    {greeks.netVega >= 0 ? '+' : ''}${greeks.netVega.toFixed(0)}
                </div>
                <div className="label-mono mt-0.5">NET VEGA (PER 1% IV)</div>
            </div>
            <div>
                <div className={`text-base sm:text-lg font-bold font-mono tabular-nums ${greeks.netGamma > 20 ? 'metric-glow-pos' :
                        greeks.netGamma < -20 ? 'metric-glow-neg' :
                            'text-text-primary'
                    }`}>
                    {greeks.netGamma >= 0 ? '+' : ''}{greeks.netGamma.toFixed(2)}
                </div>
                <div className="label-mono mt-0.5">NET GAMMA</div>
            </div>
        </div>
        {greeks.largestRiskTicker && greeks.largestRiskPct > 0 && (
            <div className="mt-3 pt-3 border-t border-phosphor-green/15 flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider">
                <span className="text-text-tertiary">▌ LARGEST POSITION RISK:</span>
                <span className={`font-mono font-bold tabular-nums ${greeks.largestRiskPct > 10 ? 'text-phosphor-red text-glow-red' :
                        greeks.largestRiskPct > 5 ? 'text-phosphor-amber text-glow-amber' :
                            'text-text-primary'
                    }`}>{greeks.largestRiskTicker} {greeks.largestRiskPct.toFixed(1)}%</span>
            </div>
        )}
        {greeks.concentrationWarnings && greeks.concentrationWarnings.length > 0 && (
            <div className="mt-2 space-y-1">
                {greeks.concentrationWarnings.map((w, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-phosphor-red/90">
                        <span className="font-bold">▌ CONCENTRATION:</span>
                        <span className="font-mono tabular-nums">{w.label} @ {w.pct}%</span>
                        <span className="text-text-tertiary">(limit {w.limit}%)</span>
                    </div>
                ))}
            </div>
        )}
    </div>
);
