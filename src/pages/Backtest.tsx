import React, { useState, useMemo } from 'react';
import {
    AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip,
    ResponsiveContainer, CartesianGrid,
    BarChart, Bar, Legend, Cell,
} from 'recharts';
import { TrendingUp, BarChart3, Layers, Target, Filter } from 'lucide-react';
import dashboardData from '../../data/dte5-dashboard.json';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SpreadResult {
    ticker: string; label: string; riskPct: number;
    finalEquity: number; cagr: number | null; sharpe: number; maxDD: number;
    minEquity: number; winRate: number; trades: number; posWindows: number; totalWindows: number;
    equityCurve: Array<{ date: string; equity: number }>;
}

interface EMAResult {
    ticker: string; spread: string; ema: number | null;
    finalEquity: number; cagr: number | null; sharpe: number; maxDD: number;
    minEquity: number; winRate: number; trades: number;
    equityCurve: Array<{ date: string; equity: number }>;
}

interface DetailedCurve {
    ticker: string; label: string; tag: string;
    windows: Array<{ testStart: string; testEnd: string; startEq: number; endEq: number; pnl: number; trades: number; wr: number }>;
    summary: { finalEquity: number; cagr: number | null; sharpe: number; maxDD: number; minEquity: number; winRate: number; trades: number };
}

const data = dashboardData as {
    generatedAt: string; engine: string; startingCapital: number;
    dataStart: string; dataEnd: string;
    tickers: string[]; direction: string; defaultEMA: number; dte: number;
    trainDays: number; testDays: number;
    spreadComparison: SpreadResult[];
    emaComparison: EMAResult[];
    detailedCurves: DetailedCurve[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(v: number): string { return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtPct(v: number | null): string { return v != null ? v.toFixed(1) + '%' : 'N/A'; }

function scoreColor(sharpe: number): string {
    if (sharpe >= 0.7) return 'text-emerald-400';
    if (sharpe >= 0.4) return 'text-yellow-400';
    if (sharpe >= 0.1) return 'text-orange-400';
    return 'text-red-400';
}

const RISK_COLORS: Record<number, string> = { 0.05: '#22c55e', 0.1: '#3b82f6', 0.15: '#f59e0b', 0.2: '#ef4444' };
const TICKER_COLORS: Record<string, string> = { QQQ: '#3b82f6', SPY: '#22c55e', IWM: '#f59e0b' };
const SPREAD_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1', '#14b8a6'];

type Tab = 'overview' | 'spreads' | 'ema' | 'equity';

// ── Main Component ───────────────────────────────────────────────────────────

export function BacktestPage() {
    const [activeTab, setActiveTab] = useState<Tab>('overview');
    const [selectedTicker, setSelectedTicker] = useState<string>('QQQ');
    const [selectedRisk, setSelectedRisk] = useState<number>(0.1);
    const [selectedSpread, setSelectedSpread] = useState<string>('sp30/20');
    const [highlightedSpreads, setHighlightedSpreads] = useState<Set<string>>(new Set(['sp25/15', 'sp30/20', 'sp25/10']));

    const tickers = data.tickers || ['QQQ'];
    const risks = useMemo(() => [...new Set(data.spreadComparison.map(r => r.riskPct))].sort(), []);

    const spreadsForTickerRisk = useMemo(() =>
        data.spreadComparison
            .filter(r => r.ticker === selectedTicker && r.riskPct === selectedRisk)
            .sort((a, b) => b.sharpe - a.sharpe),
        [selectedTicker, selectedRisk]);

    const emasForTickerSpread = useMemo(() =>
        data.emaComparison
            .filter(r => r.ticker === selectedTicker && r.spread === selectedSpread)
            .sort((a, b) => b.sharpe - a.sharpe),
        [selectedTicker, selectedSpread]);

    // Best config per ticker per risk
    const bestPerTickerRisk = useMemo(() => {
        const result: Record<string, Record<number, SpreadResult>> = {};
        for (const ticker of tickers) {
            result[ticker] = {};
            for (const risk of risks) {
                const rows = data.spreadComparison
                    .filter(r => r.ticker === ticker && r.riskPct === risk && r.minEquity >= 5000)
                    .sort((a, b) => b.sharpe - a.sharpe);
                if (rows.length > 0) result[ticker][risk] = rows[0];
            }
        }
        return result;
    }, [tickers, risks]);

    const TABS: Array<{ key: Tab; label: string; icon: React.ReactNode }> = [
        { key: 'overview', label: 'Overview', icon: <BarChart3 size={14} /> },
        { key: 'spreads', label: 'Spread Comparison', icon: <Layers size={14} /> },
        { key: 'ema', label: 'EMA Filter', icon: <Filter size={14} /> },
        { key: 'equity', label: 'Equity Curves', icon: <TrendingUp size={14} /> },
    ];

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold">DTE5 Strategy Analysis</h1>
                    <p className="text-xs text-text-tertiary">
                        {tickers.join(', ')} Bull Put • EMA34 • True Portfolio Growth WFA • {data.dataStart} → {data.dataEnd}
                    </p>
                </div>
                <span className="text-xs text-text-tertiary">Generated {new Date(data.generatedAt).toLocaleDateString()}</span>
            </div>

            {/* Tab Nav */}
            <div className="flex gap-1 bg-bg-secondary rounded-lg p-1">
                {TABS.map(tab => (
                    <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                            activeTab === tab.key ? 'bg-amber-500/20 text-amber-400' : 'text-text-tertiary hover:text-text-secondary'
                        }`}
                    >{tab.icon} {tab.label}</button>
                ))}
            </div>

            {/* ══════════ OVERVIEW TAB ══════════ */}
            {activeTab === 'overview' && (
                <div className="space-y-4">
                    {/* Cross-ticker summary */}
                    <div className="bg-bg-secondary rounded-xl border border-white/5 p-4">
                        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                            <Target size={14} className="text-amber-400" /> Best Config Per Ticker at 10% Risk
                            <span className="text-xs text-text-tertiary font-normal">(MinEq &ge; $5K filter)</span>
                        </h2>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            {tickers.map(ticker => {
                                const best = bestPerTickerRisk[ticker]?.[0.1];
                                if (!best) return <div key={ticker} className="rounded-lg border border-white/10 p-3"><span className="text-text-tertiary text-sm">{ticker}: no viable config</span></div>;
                                const isActive = ticker === 'QQQ';
                                return (
                                    <div key={ticker} className={`rounded-lg border p-3 ${isActive ? 'border-amber-500/40 bg-amber-500/5' : 'border-white/10 bg-bg-primary'}`}>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-base font-bold" style={{ color: TICKER_COLORS[ticker] }}>{ticker}</span>
                                            {isActive && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">ACTIVE</span>}
                                        </div>
                                        <div className="text-lg font-bold">{best.label}</div>
                                        <div className="grid grid-cols-2 gap-1 mt-2 text-xs">
                                            <div><span className="text-text-tertiary">Sharpe</span> <span className={scoreColor(best.sharpe)}>{best.sharpe.toFixed(3)}</span></div>
                                            <div><span className="text-text-tertiary">CAGR</span> {fmtPct(best.cagr)}</div>
                                            <div><span className="text-text-tertiary">MaxDD</span> {fmtPct(best.maxDD)}</div>
                                            <div><span className="text-text-tertiary">Final</span> {fmt$(best.finalEquity)}</div>
                                            <div><span className="text-text-tertiary">WR</span> {best.winRate.toFixed(0)}%</div>
                                            <div><span className="text-text-tertiary">MinEq</span> {fmt$(best.minEquity)}</div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Best per risk tier for all tickers */}
                    <div className="bg-bg-secondary rounded-xl border border-white/5 p-4">
                        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                            <BarChart3 size={14} className="text-blue-400" /> Best Spread Per Risk Tier
                        </h2>
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-text-tertiary border-b border-white/10">
                                        <th className="text-left py-1.5 px-2">Ticker</th>
                                        <th className="text-left py-1.5 px-2">Risk</th>
                                        <th className="text-left py-1.5 px-2">Best Spread</th>
                                        <th className="text-right py-1.5 px-2">Sharpe</th>
                                        <th className="text-right py-1.5 px-2">CAGR</th>
                                        <th className="text-right py-1.5 px-2">MaxDD</th>
                                        <th className="text-right py-1.5 px-2">Final$</th>
                                        <th className="text-right py-1.5 px-2">WR%</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {tickers.flatMap(ticker =>
                                        risks.map(risk => {
                                            const best = bestPerTickerRisk[ticker]?.[risk];
                                            if (!best) return null;
                                            const isActive = ticker === 'QQQ' && risk === 0.1;
                                            return (
                                                <tr key={`${ticker}-${risk}`} className={`border-b border-white/5 ${isActive ? 'bg-amber-500/5' : 'hover:bg-white/5'}`}>
                                                    <td className="py-1.5 px-2 font-medium" style={{ color: TICKER_COLORS[ticker] }}>{ticker}</td>
                                                    <td className="py-1.5 px-2" style={{ color: RISK_COLORS[risk] }}>{(risk * 100).toFixed(0)}%</td>
                                                    <td className="py-1.5 px-2 font-medium">{best.label}{isActive ? ' ✦' : ''}</td>
                                                    <td className={`py-1.5 px-2 text-right font-medium ${scoreColor(best.sharpe)}`}>{best.sharpe.toFixed(3)}</td>
                                                    <td className={`py-1.5 px-2 text-right ${(best.cagr ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtPct(best.cagr)}</td>
                                                    <td className={`py-1.5 px-2 text-right ${best.maxDD > 50 ? 'text-red-400' : best.maxDD > 30 ? 'text-yellow-400' : ''}`}>{fmtPct(best.maxDD)}</td>
                                                    <td className="py-1.5 px-2 text-right">{fmt$(best.finalEquity)}</td>
                                                    <td className="py-1.5 px-2 text-right">{best.winRate.toFixed(0)}%</td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Equity overlay — top config per ticker at 10% */}
                    <div className="bg-bg-secondary rounded-xl border border-white/5 p-4">
                        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                            <TrendingUp size={14} className="text-emerald-400" /> Portfolio Growth — Best Config Per Ticker at 10% Risk
                        </h2>
                        <div className="h-64">
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickFormatter={d => d?.slice(0, 7) || ''} />
                                    <YAxis tick={{ fontSize: 10, fill: '#888' }} tickFormatter={v => `$${(Number(v) / 1000).toFixed(0)}K`} />
                                    <RechartsTooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', borderRadius: 8, fontSize: 12 }} formatter={(v) => [fmt$(Number(v)), '']} labelFormatter={(l) => String(l)?.slice(0, 7) || ''} />
                                    {tickers.map(ticker => {
                                        const best = bestPerTickerRisk[ticker]?.[0.1];
                                        if (!best) return null;
                                        const curveData = [{ date: '', equity: data.startingCapital }, ...best.equityCurve];
                                        return (
                                            <Area key={ticker} data={curveData} type="monotone" dataKey="equity"
                                                name={`${ticker} ${best.label}`}
                                                stroke={TICKER_COLORS[ticker]} fill={TICKER_COLORS[ticker]}
                                                fillOpacity={0.08} strokeWidth={ticker === 'QQQ' ? 2.5 : 1.5} dot={false} />
                                        );
                                    })}
                                    <Legend wrapperStyle={{ fontSize: 11 }} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>
            )}

            {/* ══════════ SPREAD COMPARISON TAB ══════════ */}
            {activeTab === 'spreads' && (
                <div className="space-y-4">
                    {/* Ticker + Risk selectors */}
                    <div className="flex flex-wrap items-center gap-4">
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-text-tertiary">Ticker:</span>
                            {tickers.map(t => (
                                <button key={t} onClick={() => setSelectedTicker(t)}
                                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${selectedTicker === t ? 'text-white' : 'text-text-tertiary hover:text-text-secondary'}`}
                                    style={selectedTicker === t ? { backgroundColor: TICKER_COLORS[t] + '33', color: TICKER_COLORS[t] } : {}}
                                >{t}</button>
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-text-tertiary">Risk:</span>
                            {risks.map(risk => (
                                <button key={risk} onClick={() => setSelectedRisk(risk)}
                                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${selectedRisk === risk ? 'text-white' : 'text-text-tertiary hover:text-text-secondary'}`}
                                    style={selectedRisk === risk ? { backgroundColor: RISK_COLORS[risk] + '33', color: RISK_COLORS[risk] } : {}}
                                >{(risk * 100).toFixed(0)}%</button>
                            ))}
                        </div>
                    </div>

                    {/* Bar chart */}
                    <div className="bg-bg-secondary rounded-xl border border-white/5 p-4">
                        <h2 className="text-sm font-semibold mb-3">Sharpe by Spread — {selectedTicker} at {(selectedRisk * 100).toFixed(0)}% Risk</h2>
                        <div className="h-56">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={spreadsForTickerRisk} layout="vertical">
                                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                    <XAxis type="number" tick={{ fontSize: 10, fill: '#888' }} domain={[Math.min(0, ...spreadsForTickerRisk.map(r => r.sharpe)) - 0.1, 'auto']} />
                                    <YAxis type="category" dataKey="label" tick={{ fontSize: 10, fill: '#888' }} width={60} />
                                    <RechartsTooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', borderRadius: 8, fontSize: 12 }} formatter={(v) => [Number(v).toFixed(3), 'Sharpe']} />
                                    <Bar dataKey="sharpe" radius={[0, 4, 4, 0]}>
                                        {spreadsForTickerRisk.map((entry, i) => (
                                            <Cell key={i} fill={entry.sharpe >= 0.7 ? '#22c55e' : entry.sharpe >= 0.4 ? '#eab308' : entry.sharpe >= 0.1 ? '#f97316' : '#ef4444'}
                                                fillOpacity={entry.label === 'sp30/20' && selectedTicker === 'QQQ' ? 1 : entry.label === 'sp20/10' && selectedTicker === 'SPY' ? 1 : 0.6} />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Full table */}
                    <div className="bg-bg-secondary rounded-xl border border-white/5 p-4">
                        <h2 className="text-sm font-semibold mb-3">All Configs — {selectedTicker} {(selectedRisk * 100).toFixed(0)}% — $10K Start</h2>
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-text-tertiary border-b border-white/10">
                                        <th className="text-left py-1.5 px-2">Spread</th>
                                        <th className="text-right py-1.5 px-2">Final$</th>
                                        <th className="text-right py-1.5 px-2">CAGR</th>
                                        <th className="text-right py-1.5 px-2">Sharpe</th>
                                        <th className="text-right py-1.5 px-2">MaxDD</th>
                                        <th className="text-right py-1.5 px-2">MinEq</th>
                                        <th className="text-right py-1.5 px-2">WR%</th>
                                        <th className="text-right py-1.5 px-2">Trades</th>
                                        <th className="text-right py-1.5 px-2">+Win</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {spreadsForTickerRisk.map((r, i) => {
                                        const isTop = i === 0;
                                        return (
                                            <tr key={i} className={`border-b border-white/5 transition-colors ${isTop ? 'bg-emerald-500/5' : 'hover:bg-white/5'}`}>
                                                <td className="py-1.5 px-2 font-medium">
                                                    {r.label}
                                                    {isTop && <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-400">BEST</span>}
                                                </td>
                                                <td className="py-1.5 px-2 text-right font-medium">{fmt$(r.finalEquity)}</td>
                                                <td className={`py-1.5 px-2 text-right ${(r.cagr ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtPct(r.cagr)}</td>
                                                <td className={`py-1.5 px-2 text-right font-medium ${scoreColor(r.sharpe)}`}>{r.sharpe.toFixed(3)}</td>
                                                <td className={`py-1.5 px-2 text-right ${r.maxDD > 50 ? 'text-red-400' : r.maxDD > 30 ? 'text-yellow-400' : ''}`}>{fmtPct(r.maxDD)}</td>
                                                <td className={`py-1.5 px-2 text-right ${r.minEquity < 5000 ? 'text-red-400' : ''}`}>{fmt$(r.minEquity)}</td>
                                                <td className="py-1.5 px-2 text-right">{r.winRate.toFixed(0)}%</td>
                                                <td className="py-1.5 px-2 text-right">{r.trades}</td>
                                                <td className="py-1.5 px-2 text-right">{r.posWindows}/{r.totalWindows}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Equity overlay */}
                    <div className="bg-bg-secondary rounded-xl border border-white/5 p-4">
                        <h2 className="text-sm font-semibold mb-2">Equity Curves — {selectedTicker} {(selectedRisk * 100).toFixed(0)}%</h2>
                        <div className="flex flex-wrap gap-1 mb-3">
                            {spreadsForTickerRisk.slice(0, 8).map((r, i) => (
                                <button key={r.label} onClick={() => setHighlightedSpreads(prev => { const next = new Set(prev); if (next.has(r.label)) next.delete(r.label); else next.add(r.label); return next; })}
                                    className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${highlightedSpreads.has(r.label) ? 'text-white' : 'text-text-tertiary'}`}
                                    style={highlightedSpreads.has(r.label) ? { backgroundColor: SPREAD_COLORS[i] + '44', color: SPREAD_COLORS[i] } : {}}
                                >{r.label}</button>
                            ))}
                        </div>
                        <div className="h-64">
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickFormatter={d => d?.slice(0, 7) || ''} />
                                    <YAxis tick={{ fontSize: 10, fill: '#888' }} tickFormatter={v => `$${(Number(v) / 1000).toFixed(0)}K`} />
                                    <RechartsTooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', borderRadius: 8, fontSize: 12 }} formatter={(v) => [fmt$(Number(v)), '']} labelFormatter={(l) => String(l)?.slice(0, 7) || ''} />
                                    {spreadsForTickerRisk.slice(0, 8).map((r, i) => {
                                        if (!highlightedSpreads.has(r.label)) return null;
                                        const curveData = [{ date: '', equity: data.startingCapital }, ...r.equityCurve];
                                        return <Area key={r.label} data={curveData} type="monotone" dataKey="equity" name={r.label} stroke={SPREAD_COLORS[i]} fill={SPREAD_COLORS[i]} fillOpacity={0.08} strokeWidth={i === 0 ? 2.5 : 1.5} dot={false} />;
                                    })}
                                    <Legend wrapperStyle={{ fontSize: 11 }} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>
            )}

            {/* ══════════ EMA FILTER TAB ══════════ */}
            {activeTab === 'ema' && (
                <div className="space-y-4">
                    {/* Selectors */}
                    <div className="flex flex-wrap items-center gap-4">
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-text-tertiary">Ticker:</span>
                            {tickers.map(t => (
                                <button key={t} onClick={() => setSelectedTicker(t)}
                                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${selectedTicker === t ? 'text-white' : 'text-text-tertiary hover:text-text-secondary'}`}
                                    style={selectedTicker === t ? { backgroundColor: TICKER_COLORS[t] + '33', color: TICKER_COLORS[t] } : {}}
                                >{t}</button>
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-text-tertiary">Spread:</span>
                            {['sp25/15', 'sp30/20'].map(sp => (
                                <button key={sp} onClick={() => setSelectedSpread(sp)}
                                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${selectedSpread === sp ? 'bg-blue-500/20 text-blue-400' : 'text-text-tertiary hover:text-text-secondary'}`}
                                >{sp}</button>
                            ))}
                        </div>
                    </div>

                    {/* Bar chart */}
                    <div className="bg-bg-secondary rounded-xl border border-white/5 p-4">
                        <h2 className="text-sm font-semibold mb-3">Sharpe by EMA — {selectedTicker} {selectedSpread} at 10% Risk</h2>
                        <div className="h-52">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={emasForTickerSpread.map(r => ({ ...r, label: r.ema === null ? 'None' : `EMA${r.ema}` }))}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#888' }} />
                                    <YAxis tick={{ fontSize: 10, fill: '#888' }} />
                                    <RechartsTooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', borderRadius: 8, fontSize: 12 }} />
                                    <Bar dataKey="sharpe" name="Sharpe" radius={[4, 4, 0, 0]}>
                                        {emasForTickerSpread.map((entry, i) => (
                                            <Cell key={i} fill={entry.ema === 34 ? '#f59e0b' : entry.sharpe >= 0.5 ? '#3b82f6' : entry.sharpe >= 0 ? '#6366f1' : '#ef4444'}
                                                fillOpacity={entry.ema === 34 ? 1 : 0.5} />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Table */}
                    <div className="bg-bg-secondary rounded-xl border border-white/5 p-4">
                        <h2 className="text-sm font-semibold mb-3">Full EMA Comparison — {selectedTicker} {selectedSpread} at 10% Risk</h2>
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-text-tertiary border-b border-white/10">
                                        <th className="text-left py-1.5 px-2">EMA</th>
                                        <th className="text-right py-1.5 px-2">Final$</th>
                                        <th className="text-right py-1.5 px-2">CAGR</th>
                                        <th className="text-right py-1.5 px-2">Sharpe</th>
                                        <th className="text-right py-1.5 px-2">MaxDD</th>
                                        <th className="text-right py-1.5 px-2">MinEq</th>
                                        <th className="text-right py-1.5 px-2">WR%</th>
                                        <th className="text-right py-1.5 px-2">Trades</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {emasForTickerSpread.map((r, i) => {
                                        const isEMA34 = r.ema === 34;
                                        const label = r.ema === null ? 'No filter' : `EMA${r.ema}`;
                                        return (
                                            <tr key={i} className={`border-b border-white/5 transition-colors ${isEMA34 ? 'bg-amber-500/5' : 'hover:bg-white/5'}`}>
                                                <td className="py-1.5 px-2 font-medium">
                                                    {label}
                                                    {isEMA34 && <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400">ACTIVE</span>}
                                                    {r.ema === null && <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-red-500/20 text-red-400">NO FILTER</span>}
                                                </td>
                                                <td className="py-1.5 px-2 text-right font-medium">{fmt$(r.finalEquity)}</td>
                                                <td className={`py-1.5 px-2 text-right ${(r.cagr ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtPct(r.cagr)}</td>
                                                <td className={`py-1.5 px-2 text-right font-medium ${scoreColor(r.sharpe)}`}>{r.sharpe.toFixed(3)}</td>
                                                <td className={`py-1.5 px-2 text-right ${r.maxDD > 50 ? 'text-red-400' : r.maxDD > 30 ? 'text-yellow-400' : ''}`}>{fmtPct(r.maxDD)}</td>
                                                <td className={`py-1.5 px-2 text-right ${r.minEquity < 5000 ? 'text-red-400' : ''}`}>{fmt$(r.minEquity)}</td>
                                                <td className="py-1.5 px-2 text-right">{r.winRate.toFixed(0)}%</td>
                                                <td className="py-1.5 px-2 text-right">{r.trades}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* EMA equity overlay */}
                    <div className="bg-bg-secondary rounded-xl border border-white/5 p-4">
                        <h2 className="text-sm font-semibold mb-3">Equity — No EMA vs EMA34 vs EMA55 ({selectedTicker} {selectedSpread})</h2>
                        <div className="h-64">
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickFormatter={d => d?.slice(0, 7) || ''} />
                                    <YAxis tick={{ fontSize: 10, fill: '#888' }} tickFormatter={v => `$${(Number(v) / 1000).toFixed(0)}K`} />
                                    <RechartsTooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', borderRadius: 8, fontSize: 12 }} formatter={(v) => [fmt$(Number(v)), '']} />
                                    {([null, 34, 55] as Array<number | null>).map((ema, i) => {
                                        const r = emasForTickerSpread.find(e => e.ema === ema);
                                        if (!r) return null;
                                        const colors = ['#ef4444', '#f59e0b', '#3b82f6'];
                                        const labels = ['No EMA', 'EMA34', 'EMA55'];
                                        const curveData = [{ date: '', equity: data.startingCapital }, ...r.equityCurve];
                                        return <Area key={String(ema)} data={curveData} type="monotone" dataKey="equity" name={labels[i]} stroke={colors[i]} fill={colors[i]} fillOpacity={0.08} strokeWidth={ema === 34 ? 2.5 : 1.5} strokeDasharray={ema === null ? '5 5' : undefined} dot={false} />;
                                    })}
                                    <Legend wrapperStyle={{ fontSize: 11 }} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>
            )}

            {/* ══════════ EQUITY CURVES TAB ══════════ */}
            {activeTab === 'equity' && (
                <div className="space-y-4">
                    {/* Ticker selector */}
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-text-tertiary">Ticker:</span>
                        {tickers.map(t => (
                            <button key={t} onClick={() => setSelectedTicker(t)}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${selectedTicker === t ? 'text-white' : 'text-text-tertiary hover:text-text-secondary'}`}
                                style={selectedTicker === t ? { backgroundColor: TICKER_COLORS[t] + '33', color: TICKER_COLORS[t] } : {}}
                            >{t}</button>
                        ))}
                    </div>

                    {data.detailedCurves.filter(c => c.ticker === selectedTicker).map((curve, idx) => {
                        const s = curve.summary;
                        const curveData = [
                            { date: curve.windows[0]?.testStart || '', equity: data.startingCapital },
                            ...curve.windows.map(w => ({ date: w.testEnd, equity: w.endEq })),
                        ];
                        const tagColors: Record<string, string> = { RECOMMENDED: '#f59e0b', CONSERVATIVE: '#22c55e', AGGRESSIVE: '#ef4444', PREVIOUS: '#3b82f6' };
                        const tagColor = tagColors[curve.tag] || '#888';
                        return (
                            <div key={idx} className="bg-bg-secondary rounded-xl border border-white/5 p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <h2 className="text-sm font-semibold">{curve.label}</h2>
                                        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ backgroundColor: tagColor + '22', color: tagColor }}>{curve.tag}</span>
                                    </div>
                                    <div className="flex gap-3 text-xs text-text-tertiary">
                                        <span>Sharpe <span className={scoreColor(s.sharpe)}>{s.sharpe.toFixed(3)}</span></span>
                                        <span>CAGR <span className="text-text-primary">{fmtPct(s.cagr)}</span></span>
                                        <span>MaxDD <span className={s.maxDD > 50 ? 'text-red-400' : 'text-text-primary'}>{fmtPct(s.maxDD)}</span></span>
                                        <span>Final <span className="text-emerald-400">{fmt$(s.finalEquity)}</span></span>
                                    </div>
                                </div>
                                <div className="h-48">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={curveData}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickFormatter={d => d?.slice(0, 7) || ''} />
                                            <YAxis tick={{ fontSize: 10, fill: '#888' }} tickFormatter={v => `$${(Number(v) / 1000).toFixed(0)}K`} />
                                            <RechartsTooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', borderRadius: 8, fontSize: 12 }} formatter={(v) => [fmt$(Number(v)), 'Equity']} />
                                            <Area type="monotone" dataKey="equity" stroke={tagColor} fill={tagColor} fillOpacity={0.15} strokeWidth={2} dot={{ r: 3, fill: tagColor }} />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                                {/* Window table */}
                                <div className="mt-3 overflow-x-auto">
                                    <table className="w-full text-[11px]">
                                        <thead>
                                            <tr className="text-text-tertiary border-b border-white/10">
                                                <th className="text-left py-1 px-1.5">W#</th>
                                                <th className="text-left py-1 px-1.5">Period</th>
                                                <th className="text-right py-1 px-1.5">Start</th>
                                                <th className="text-right py-1 px-1.5">P&L</th>
                                                <th className="text-right py-1 px-1.5">End</th>
                                                <th className="text-right py-1 px-1.5">Ret%</th>
                                                <th className="text-right py-1 px-1.5">Trades</th>
                                                <th className="text-right py-1 px-1.5">WR</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {curve.windows.map((w, i) => {
                                                const ret = w.startEq > 0 ? ((w.endEq / w.startEq - 1) * 100) : 0;
                                                return (
                                                    <tr key={i} className="border-b border-white/5">
                                                        <td className="py-1 px-1.5">W{i + 1}</td>
                                                        <td className="py-1 px-1.5 text-text-tertiary">{w.testStart.slice(2, 7)}→{w.testEnd.slice(2, 7)}</td>
                                                        <td className="py-1 px-1.5 text-right">{fmt$(w.startEq)}</td>
                                                        <td className={`py-1 px-1.5 text-right ${w.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{w.pnl >= 0 ? '+' : ''}{fmt$(w.pnl)}</td>
                                                        <td className="py-1 px-1.5 text-right">{fmt$(w.endEq)}</td>
                                                        <td className={`py-1 px-1.5 text-right ${ret >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{ret.toFixed(1)}%</td>
                                                        <td className="py-1 px-1.5 text-right">{w.trades}</td>
                                                        <td className="py-1 px-1.5 text-right">{w.wr.toFixed(0)}%</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
