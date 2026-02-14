import React from 'react';
import { useAppSettings } from '../context/AppSettingsContext';
import { PORTFOLIO_BOUNDS } from '../lib/types/settings';
import { formatCurrency } from '../lib/utils';

const { MIN_RISK_PCT, MAX_RISK_PCT, MIN_STOP_OUT_PCT, MAX_STOP_OUT_PCT } = PORTFOLIO_BOUNDS;

interface PortfolioSettingsFormProps {
    /** Compact: single row with inputs. Full: labels above. */
    variant?: 'compact' | 'full';
    className?: string;
}

export const PortfolioSettingsForm: React.FC<PortfolioSettingsFormProps> = ({ variant = 'full', className = '' }) => {
    const { settings, updateSettings, maxRiskPerTrade } = useAppSettings();
    const { accountSize: portfolioTotal, riskPct, stopOutPct } = settings.portfolio;
    const setPortfolioTotal = (v: number) => updateSettings({ portfolio: { ...settings.portfolio, accountSize: v } });
    const setRiskPct = (v: number) => updateSettings({ portfolio: { ...settings.portfolio, riskPct: v } });
    const setStopOutPct = (v: number) => updateSettings({ portfolio: { ...settings.portfolio, stopOutPct: v } });

    if (variant === 'compact') {
        return (
            <div className={`flex flex-wrap items-center gap-4 ${className}`}>
                <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400 uppercase tracking-wider whitespace-nowrap">Portfolio</label>
                    <span className="text-text-tertiary select-none">$</span>
                    <input
                        type="number"
                        min={0}
                        step={100}
                        value={portfolioTotal}
                        onChange={e => setPortfolioTotal(parseFloat(e.target.value) || 0)}
                        className="w-24 px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
                    />
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400 uppercase tracking-wider whitespace-nowrap">Risk/trade</label>
                    <input
                        type="number"
                        min={MIN_RISK_PCT}
                        max={MAX_RISK_PCT}
                        step={0.1}
                        value={riskPct}
                        onChange={e => setRiskPct(parseFloat(e.target.value) || MIN_RISK_PCT)}
                        className="w-14 px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
                    />
                    <span className="text-gray-500 text-sm">%</span>
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400 uppercase tracking-wider whitespace-nowrap" title="Exit when loss reaches this % of max loss">Stop out</label>
                    <input
                        type="number"
                        min={MIN_STOP_OUT_PCT}
                        max={MAX_STOP_OUT_PCT}
                        step={5}
                        value={stopOutPct}
                        onChange={e => setStopOutPct(parseFloat(e.target.value) || MIN_STOP_OUT_PCT)}
                        className="w-12 px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
                    />
                    <span className="text-gray-500 text-sm">%</span>
                </div>
                <span className="text-xs text-gray-500 font-mono">
                    Cap: {formatCurrency(maxRiskPerTrade)}/trade
                </span>
            </div>
        );
    }

    return (
        <div className={`space-y-4 ${className}`}>
            <div>
                <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">
                    Portfolio Total / Account Size ($)
                </label>
                <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-mono">$</span>
                    <input
                        type="number"
                        min={0}
                        step={100}
                        value={portfolioTotal}
                        onChange={e => setPortfolioTotal(parseFloat(e.target.value) || 0)}
                        className="w-full bg-[#000] border border-[#333] text-white rounded-lg pl-8 pr-4 py-2.5 font-mono focus:outline-none focus:border-accent-green"
                    />
                </div>
            </div>
            <div>
                <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">
                    Max risk per trade ({MIN_RISK_PCT}%–{MAX_RISK_PCT}%)
                </label>
                <div className="flex items-center gap-3">
                    <input
                        type="range"
                        min={MIN_RISK_PCT}
                        max={MAX_RISK_PCT}
                        step={0.1}
                        value={riskPct}
                        onChange={e => setRiskPct(parseFloat(e.target.value))}
                        className="flex-1 h-2 bg-[#222] rounded-lg appearance-none cursor-pointer accent-accent-green"
                    />
                    <input
                        type="number"
                        min={MIN_RISK_PCT}
                        max={MAX_RISK_PCT}
                        step={0.1}
                        value={riskPct}
                        onChange={e => setRiskPct(parseFloat(e.target.value) || MIN_RISK_PCT)}
                        className="w-16 px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
                    />
                    <span className="text-gray-500 text-sm w-6">%</span>
                </div>
                <p className="text-xs text-gray-500 mt-1 font-mono">
                    Risk cap per trade: {formatCurrency(maxRiskPerTrade)}
                </p>
            </div>
            <div>
                <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">
                    Stop out at ({MIN_STOP_OUT_PCT}%–{MAX_STOP_OUT_PCT}% of max loss)
                </label>
                <div className="flex items-center gap-3">
                    <input
                        type="range"
                        min={MIN_STOP_OUT_PCT}
                        max={MAX_STOP_OUT_PCT}
                        step={5}
                        value={stopOutPct}
                        onChange={e => setStopOutPct(parseFloat(e.target.value))}
                        className="flex-1 h-2 bg-[#222] rounded-lg appearance-none cursor-pointer accent-accent-green"
                    />
                    <input
                        type="number"
                        min={MIN_STOP_OUT_PCT}
                        max={MAX_STOP_OUT_PCT}
                        step={5}
                        value={stopOutPct}
                        onChange={e => setStopOutPct(parseFloat(e.target.value) || MIN_STOP_OUT_PCT)}
                        className="w-16 px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
                    />
                    <span className="text-gray-500 text-sm w-6">%</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                    Exit when loss reaches this % of max loss (e.g. 50% = stop at half of max loss).
                </p>
            </div>
        </div>
    );
};
