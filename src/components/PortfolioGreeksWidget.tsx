import React from 'react';
import type { PortfolioGreeksResult } from '../lib/riskSizing';

interface Props {
    greeks: PortfolioGreeksResult;
}

export const PortfolioGreeksWidget: React.FC<Props> = ({ greeks }) => (
    <div className="rounded-xl border border-border-default/30 bg-bg-secondary/20 p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
                Portfolio Greeks — {greeks.positionsWithData} position{greeks.positionsWithData !== 1 ? 's' : ''} with live data
            </span>
            {Math.abs(greeks.netDelta) > 200 && (
                <span className="text-[10px] font-bold text-orange-400 border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 rounded">
                    HIGH DIRECTIONAL EXPOSURE
                </span>
            )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div>
                <div className={`text-base sm:text-lg font-bold font-mono ${greeks.netDelta > 150 ? 'text-emerald-400' :
                        greeks.netDelta < -150 ? 'text-accent-red' :
                            'text-text-primary'
                    }`}>
                    {greeks.netDelta > 0 ? '+' : ''}{greeks.netDelta.toFixed(0)}
                </div>
                <div className="text-[10px] text-text-tertiary mt-0.5">Net Delta (shares)</div>
            </div>
            <div>
                <div className={`text-base sm:text-lg font-bold font-mono ${greeks.netTheta > 15 ? 'text-emerald-400' :
                        greeks.netTheta < -25 ? 'text-accent-red' :
                            'text-text-primary'
                    }`}>
                    {greeks.netTheta >= 0 ? '+' : ''}${greeks.netTheta.toFixed(0)}/d
                </div>
                <div className="text-[10px] text-text-tertiary mt-0.5">Net Theta</div>
            </div>
            <div>
                <div className={`text-base sm:text-lg font-bold font-mono ${greeks.netVega > 0 ? 'text-accent-yellow' :
                        greeks.netVega < 0 ? 'text-blue-400' :
                            'text-text-primary'
                    }`}>
                    {greeks.netVega >= 0 ? '+' : ''}${greeks.netVega.toFixed(0)}
                </div>
                <div className="text-[10px] text-text-tertiary mt-0.5">Net Vega (per 1% IV)</div>
            </div>
            <div>
                <div className={`text-base sm:text-lg font-bold font-mono ${greeks.netGamma > 20 ? 'text-emerald-400' :
                        greeks.netGamma < -20 ? 'text-accent-red' :
                            'text-text-primary'
                    }`}>
                    {greeks.netGamma >= 0 ? '+' : ''}{greeks.netGamma.toFixed(2)}
                </div>
                <div className="text-[10px] text-text-tertiary mt-0.5">Net Gamma</div>
            </div>
        </div>
        {greeks.largestRiskTicker && greeks.largestRiskPct > 0 && (
            <div className="mt-3 pt-3 border-t border-border-default/20 flex items-center gap-2 text-[11px]">
                <span className="text-text-tertiary">Largest position risk:</span>
                <span className={`font-mono font-semibold ${greeks.largestRiskPct > 10 ? 'text-accent-red' :
                        greeks.largestRiskPct > 5 ? 'text-accent-yellow' :
                            'text-text-primary'
                    }`}>{greeks.largestRiskTicker} {greeks.largestRiskPct.toFixed(1)}%</span>
            </div>
        )}
        {greeks.concentrationWarnings && greeks.concentrationWarnings.length > 0 && (
            <div className="mt-2 space-y-1">
                {greeks.concentrationWarnings.map((w, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px] text-accent-red/90">
                        <span className="font-semibold">CONCENTRATION:</span>
                        <span className="font-mono">{w.label} @ {w.pct}%</span>
                        <span className="text-text-tertiary">(limit {w.limit}%)</span>
                    </div>
                ))}
            </div>
        )}
    </div>
);
