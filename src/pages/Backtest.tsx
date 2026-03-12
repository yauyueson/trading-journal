import React, { useState, useMemo } from 'react';
import {
    AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip,
    ResponsiveContainer, CartesianGrid
} from 'recharts';
import { TrendingUp, Activity, ShieldAlert, BarChart3, Layers, AlertTriangle, Info } from 'lucide-react';
import wfaRaw from '../../data/wfa-results.json';

// ── Types ─────────────────────────────────────────────────────────────────────

interface WFAWindow {
    windowIndex: number;
    trainStart: string;
    trainEnd: string;
    oosStart: string;
    oosEnd: string;
    bestTrainSharpe: number;
    oosSharpe: number;
    oosTrades: Trade[];
    bestConfig: {
        signalWeightPreset: string;
        creditProfitTarget: number;
        minIVRank: number;
    };
}

interface Trade {
    ticker: string;
    entryDate: string;
    exitDate: string;
    pnl: number;
    pnlPct: number;
    holdDays: number;
    exitType: string;
    direction: string;
    entryDelta: number;
    entryDTE: number;
    strike: number;
    spreadWidth: number;
}

interface WFAData {
    config: {
        tickers: string[];
        startDate: string;
        endDate: string;
        trainWindowDays: number;
        forwardStepDays: number;
        purgeGapDays: number;
        startingCapital: number;
        maxPositions: number;
        maxPerTicker: number;
    };
    windows: WFAWindow[];
    allOOSTrades: Trade[];
    oosEquityCurve: { date: string; equity: number }[];
    oosSharpe: number;
    oosWinRate: number;
    oosMaxDD: number;
    oosTotalPnl: number;
    wfEfficiency: number;
    stressMetrics: {
        peakCorrelatedDD: number;
        peakCorrelatedDDDate: string;
        tickersInDDOnWorstDay: number;
        avgPairwiseCorrelation: number;
        worstDayLoss: number;
        worstDayLossDate: string;
        correlationPenalty: number;
        perTickerDD: Record<string, number>;
    };
}

const wfaData = wfaRaw as unknown as WFAData;

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = {
    pct: (n: number, d = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`,
    usd: (n: number) => n >= 0 ? `+$${(n / 1000).toFixed(0)}K` : `-$${(Math.abs(n) / 1000).toFixed(0)}K`,
    mon: (iso: string) => {
        const d = new Date(iso);
        return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    },
    period: (start: string, end: string) => `${fmt.mon(start)} – ${fmt.mon(end)}`,
};

const sharpeColor = (s: number) =>
    s >= 2.0 ? 'text-emerald-400' : s >= 1.0 ? 'text-yellow-400' : 'text-red-400';

const wrColor = (wr: number) =>
    wr >= 80 ? 'text-emerald-400' : wr >= 70 ? 'text-yellow-400' : 'text-red-400';

const PRESET_LABELS: Record<string, string> = {
    ema: 'EMA Trend',
    mom: 'Momentum',
    em: 'EMA+Mom',
    mf: 'Multi-Factor',
};

const PRESET_COLORS: Record<string, string> = {
    ema: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    mom: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    em: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    mf: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
};

// ── Sub-components ────────────────────────────────────────────────────────────

const Stat: React.FC<{
    label: string;
    value: string | number;
    sub?: string;
    tone?: 'good' | 'bad' | 'warn' | 'neutral';
    icon?: React.ReactNode;
}> = ({ label, value, sub, tone = 'neutral', icon }) => {
    const colors = { good: 'text-emerald-400', bad: 'text-red-400', warn: 'text-yellow-400', neutral: 'text-white' };
    return (
        <div className="bg-[#1A1A1A] rounded-xl p-3.5 border border-white/5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary uppercase tracking-wider">
                {icon}
                {label}
            </div>
            <div className={`text-xl font-mono font-bold ${colors[tone]}`}>{value}</div>
            {sub && <div className="text-[10px] text-text-tertiary">{sub}</div>}
        </div>
    );
};

const TabBtn: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
    <button
        onClick={onClick}
        className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
            active ? 'bg-accent-green/15 text-accent-green border border-accent-green/30' : 'text-text-tertiary hover:text-text-secondary'
        }`}
    >
        {children}
    </button>
);

const PresetBadge: React.FC<{ preset: string }> = ({ preset }) => (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${PRESET_COLORS[preset] ?? 'bg-white/10 text-white border-white/20'}`}>
        {preset.toUpperCase()}
    </span>
);

// ── Custom Tooltip ────────────────────────────────────────────────────────────

const EquityTooltip: React.FC<{ active?: boolean; payload?: { value: number }[]; label?: string }> = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const equity = payload[0].value;
    const gain = ((equity - 100000) / 100000 * 100).toFixed(1);
    return (
        <div className="bg-[#1E1E1E] border border-white/10 rounded-lg px-3 py-2 text-xs shadow-xl">
            <div className="text-text-tertiary mb-0.5">{label}</div>
            <div className="font-mono font-bold text-white">${(equity / 1000).toFixed(1)}K</div>
            <div className={`font-mono ${parseFloat(gain) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {gain}% return
            </div>
        </div>
    );
};

// ── Main Page ─────────────────────────────────────────────────────────────────

export const BacktestPage: React.FC = () => {
    const [tab, setTab] = useState<'windows' | 'presets' | 'tickers' | 'stress'>('windows');

    // Deduplicate equity curve: last trade per date wins
    const equityCurve = useMemo(() => {
        const map = new Map<string, number>();
        for (const pt of wfaData.oosEquityCurve) map.set(pt.date, pt.equity);
        return Array.from(map.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, equity]) => ({ date, equity }));
    }, []);

    // X-axis ticks: Jan of each year in range
    const xTicks = useMemo(() => {
        const years = new Set<string>();
        for (const pt of equityCurve) years.add(pt.date.slice(0, 4));
        return Array.from(years).map(y => `${y}-01-01`);
    }, [equityCurve]);

    // Ticker stats from allOOSTrades
    const tickerStats = useMemo(() => {
        const map: Record<string, { trades: number; wins: number; pnl: number }> = {};
        for (const t of wfaData.allOOSTrades) {
            if (!map[t.ticker]) map[t.ticker] = { trades: 0, wins: 0, pnl: 0 };
            map[t.ticker].trades++;
            if (t.exitType === 'PROFIT_TARGET') map[t.ticker].wins++;
            map[t.ticker].pnl += t.pnl;
        }
        return Object.entries(map)
            .map(([ticker, v]) => ({ ticker, ...v, winRate: v.wins / v.trades * 100 }))
            .sort((a, b) => b.pnl - a.pnl);
    }, []);

    // Preset stats from window results
    const presetStats = useMemo(() => {
        const map: Record<string, { wins: number; totalSharpe: number; totalWR: number; windows: number[] }> = {};
        for (const w of wfaData.windows) {
            const p = w.bestConfig.signalWeightPreset;
            if (!map[p]) map[p] = { wins: 0, totalSharpe: 0, totalWR: 0, windows: [] };
            map[p].wins++;
            map[p].totalSharpe += w.oosSharpe;
            const trades = w.oosTrades ?? [];
            const wr = trades.length ? trades.filter(t => t.exitType === 'PROFIT_TARGET').length / trades.length * 100 : 0;
            map[p].totalWR += wr;
            map[p].windows.push(w.windowIndex);
        }
        return Object.entries(map)
            .map(([preset, v]) => ({
                preset,
                label: PRESET_LABELS[preset] ?? preset,
                wins: v.wins,
                avgSharpe: v.totalSharpe / v.wins,
                avgWR: v.totalWR / v.wins,
                windows: v.windows,
            }))
            .sort((a, b) => b.wins - a.wins || b.avgSharpe - a.avgSharpe);
    }, []);

    // Summary
    const { oosSharpe, oosWinRate, oosMaxDD, oosTotalPnl, wfEfficiency, allOOSTrades, config } = wfaData;
    const roc = oosTotalPnl / config.startingCapital * 100;
    const exitBreakdown = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const t of allOOSTrades) counts[t.exitType] = (counts[t.exitType] ?? 0) + 1;
        return counts;
    }, []);

    return (
        <div className="fade-in pb-24 sm:pb-8 space-y-5">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h2 className="text-2xl font-bold">WFA Results</h2>
                    <p className="text-text-secondary text-sm mt-0.5">
                        Walk-Forward Analysis · {config.tickers.length} tickers · {config.startDate} → {config.endDate}
                    </p>
                </div>
                <div className="text-right text-[11px] text-text-tertiary font-mono space-y-0.5">
                    <div>Train {config.trainWindowDays}d · OOS {config.forwardStepDays}d · Purge {config.purgeGapDays}d</div>
                    <div>{wfaData.windows.length} windows · $100K start</div>
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                <Stat label="OOS Sharpe" value={oosSharpe.toFixed(2)} sub="Combined" tone={oosSharpe >= 1 ? 'good' : 'warn'}
                    icon={<Activity size={11} />} />
                <Stat label="Win Rate" value={`${oosWinRate.toFixed(1)}%`} sub={`${exitBreakdown['PROFIT_TARGET'] ?? 0} wins`}
                    tone={oosWinRate >= 80 ? 'good' : 'warn'} icon={<BarChart3 size={11} />} />
                <Stat label="Max DD" value={`${oosMaxDD.toFixed(1)}%`} sub="OOS peak→trough" tone="neutral"
                    icon={<ShieldAlert size={11} />} />
                <Stat label="Total P&L" value={`$${(oosTotalPnl / 1000).toFixed(0)}K`}
                    sub={`${roc.toFixed(0)}% ROC`} tone="good" icon={<TrendingUp size={11} />} />
                <Stat label="WF Efficiency" value={`${(wfEfficiency * 100).toFixed(0)}%`}
                    sub="OOS / In-sample" tone={wfEfficiency >= 0.8 ? 'good' : 'warn'} icon={<Layers size={11} />} />
                <Stat label="Trades" value={allOOSTrades.length.toLocaleString()}
                    sub={`${config.tickers.length} tickers`} tone="neutral" />
                <Stat label="Avg Corr" value={wfaData.stressMetrics.avgPairwiseCorrelation.toFixed(3)}
                    sub="Pairwise ρ" tone={wfaData.stressMetrics.avgPairwiseCorrelation < 0.25 ? 'good' : 'warn'}
                    icon={<AlertTriangle size={11} />} />
            </div>

            {/* Equity Curve */}
            <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                <div className="flex items-center justify-between mb-3">
                    <div>
                        <span className="text-sm font-semibold">Equity Curve</span>
                        <span className="text-text-tertiary text-xs ml-2">OOS only · $100K → ${(713248 / 1000).toFixed(0)}K</span>
                    </div>
                    <span className="text-emerald-400 font-mono text-sm font-bold">+{roc.toFixed(0)}%</span>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={equityCurve} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                        <defs>
                            <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#34d399" stopOpacity={0.25} />
                                <stop offset="95%" stopColor="#34d399" stopOpacity={0.02} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#2A2A2A" vertical={false} />
                        <XAxis
                            dataKey="date"
                            ticks={xTicks}
                            tickFormatter={d => d.slice(0, 4)}
                            tick={{ fontSize: 10, fill: '#666' }}
                            axisLine={false}
                            tickLine={false}
                        />
                        <YAxis
                            tickFormatter={v => `$${(v / 1000).toFixed(0)}K`}
                            tick={{ fontSize: 10, fill: '#666' }}
                            axisLine={false}
                            tickLine={false}
                            width={52}
                        />
                        <RechartsTooltip content={<EquityTooltip />} />
                        <Area
                            type="monotone"
                            dataKey="equity"
                            stroke="#34d399"
                            strokeWidth={1.5}
                            fill="url(#equityGrad)"
                            dot={false}
                            activeDot={{ r: 3, fill: '#34d399' }}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>

            {/* Tabs */}
            <div className="flex gap-1.5 border-b border-[#2A2A2A] pb-3">
                <TabBtn active={tab === 'windows'} onClick={() => setTab('windows')}>Windows</TabBtn>
                <TabBtn active={tab === 'presets'} onClick={() => setTab('presets')}>Presets</TabBtn>
                <TabBtn active={tab === 'tickers'} onClick={() => setTab('tickers')}>Tickers</TabBtn>
                <TabBtn active={tab === 'stress'} onClick={() => setTab('stress')}>Stress</TabBtn>
            </div>

            {/* Tab: Windows */}
            {tab === 'windows' && (
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="text-text-tertiary uppercase tracking-wider">
                                <th className="text-left pb-2 pr-3 font-medium">#</th>
                                <th className="text-left pb-2 pr-3 font-medium">OOS Period</th>
                                <th className="text-right pb-2 pr-3 font-medium">Train ↑</th>
                                <th className="text-right pb-2 pr-3 font-medium">OOS Sharpe</th>
                                <th className="text-right pb-2 pr-3 font-medium">Win Rate</th>
                                <th className="text-right pb-2 pr-3 font-medium">Trades</th>
                                <th className="text-center pb-2 pr-3 font-medium">Preset</th>
                                <th className="text-center pb-2 pr-3 font-medium">TP</th>
                                <th className="text-center pb-2 font-medium">IV≥</th>
                            </tr>
                        </thead>
                        <tbody>
                            {wfaData.windows.map(w => {
                                const trades = w.oosTrades ?? [];
                                const wins = trades.filter(t => t.exitType === 'PROFIT_TARGET').length;
                                const wr = trades.length ? wins / trades.length * 100 : 0;
                                return (
                                    <tr key={w.windowIndex} className="border-t border-[#222] hover:bg-white/2 transition-colors">
                                        <td className="py-2.5 pr-3 font-mono text-text-tertiary">W{w.windowIndex}</td>
                                        <td className="py-2.5 pr-3 text-text-secondary font-mono">
                                            {fmt.period(w.oosStart, w.oosEnd)}
                                        </td>
                                        <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">
                                            {w.bestTrainSharpe.toFixed(2)}
                                        </td>
                                        <td className={`py-2.5 pr-3 text-right font-mono font-bold ${sharpeColor(w.oosSharpe)}`}>
                                            {w.oosSharpe.toFixed(2)}
                                        </td>
                                        <td className={`py-2.5 pr-3 text-right font-mono ${wrColor(wr)}`}>
                                            {trades.length ? `${wr.toFixed(1)}%` : '—'}
                                        </td>
                                        <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">
                                            {trades.length}
                                        </td>
                                        <td className="py-2.5 pr-3 text-center">
                                            <PresetBadge preset={w.bestConfig.signalWeightPreset} />
                                        </td>
                                        <td className="py-2.5 pr-3 text-center font-mono text-text-secondary">
                                            {(w.bestConfig.creditProfitTarget * 100).toFixed(0)}%
                                        </td>
                                        <td className="py-2.5 text-center font-mono text-text-secondary">
                                            {w.bestConfig.minIVRank > 0 ? `${w.bestConfig.minIVRank}%` : '—'}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    <div className="mt-4 text-[10px] text-text-tertiary flex items-center gap-1.5">
                        <Info size={10} />
                        Delta 0.35 · $15 width · DTE 45-65 · no stop loss across all windows
                    </div>
                </div>
            )}

            {/* Tab: Presets */}
            {tab === 'presets' && (
                <div className="space-y-4">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {presetStats.map(p => (
                            <div key={p.preset} className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <PresetBadge preset={p.preset} />
                                    <span className="text-text-tertiary text-[10px]">{p.wins}/12 wins</span>
                                </div>
                                <div>
                                    <div className="text-xs text-text-tertiary mb-0.5">Label</div>
                                    <div className="text-sm font-medium">{p.label}</div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <div className="text-[10px] text-text-tertiary">Avg Sharpe</div>
                                        <div className={`font-mono font-bold text-sm ${sharpeColor(p.avgSharpe)}`}>
                                            {p.avgSharpe.toFixed(2)}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-[10px] text-text-tertiary">Avg Win Rate</div>
                                        <div className={`font-mono font-bold text-sm ${wrColor(p.avgWR)}`}>
                                            {p.avgWR.toFixed(1)}%
                                        </div>
                                    </div>
                                </div>
                                <div className="text-[10px] text-text-tertiary">
                                    Windows: {p.windows.map(w => `W${w}`).join(', ')}
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4 text-xs text-text-secondary space-y-1.5">
                        <div className="font-semibold text-white mb-2">Signal Descriptions</div>
                        <div><PresetBadge preset="ema" /> <span className="ml-1">EMA crossover trend filter (21/9 EMA). Best in trending markets.</span></div>
                        <div><PresetBadge preset="mom" /> <span className="ml-1">Pure momentum (rate of change). Captures breakout continuation.</span></div>
                        <div><PresetBadge preset="em" /> <span className="ml-1">EMA + Momentum combined. Balanced trend + momentum weighting.</span></div>
                        <div><PresetBadge preset="mf" /> <span className="ml-1">Multi-factor (RSI + MACD + volume). Most features, higher complexity.</span></div>
                    </div>
                </div>
            )}

            {/* Tab: Tickers */}
            {tab === 'tickers' && (
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="text-text-tertiary uppercase tracking-wider">
                                <th className="text-left pb-2 pr-3 font-medium">Ticker</th>
                                <th className="text-right pb-2 pr-3 font-medium">Trades</th>
                                <th className="text-right pb-2 pr-3 font-medium">Win Rate</th>
                                <th className="text-right pb-2 pr-3 font-medium">Total P&L</th>
                                <th className="text-right pb-2 font-medium">Avg/Trade</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tickerStats.map(t => (
                                <tr key={t.ticker} className="border-t border-[#222] hover:bg-white/2 transition-colors">
                                    <td className="py-2.5 pr-3 font-mono font-bold text-white">{t.ticker}</td>
                                    <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{t.trades}</td>
                                    <td className={`py-2.5 pr-3 text-right font-mono font-bold ${wrColor(t.winRate)}`}>
                                        {t.winRate.toFixed(1)}%
                                    </td>
                                    <td className={`py-2.5 pr-3 text-right font-mono font-bold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {fmt.usd(t.pnl)}
                                    </td>
                                    <td className={`py-2.5 text-right font-mono ${t.pnl >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                                        ${(t.pnl / t.trades).toFixed(0)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className="border-t border-[#333]">
                                <td className="py-2.5 pr-3 font-bold text-text-secondary">Total</td>
                                <td className="py-2.5 pr-3 text-right font-mono font-bold text-white">
                                    {allOOSTrades.length}
                                </td>
                                <td className={`py-2.5 pr-3 text-right font-mono font-bold ${wrColor(oosWinRate)}`}>
                                    {oosWinRate.toFixed(1)}%
                                </td>
                                <td className="py-2.5 pr-3 text-right font-mono font-bold text-emerald-400">
                                    {fmt.usd(oosTotalPnl)}
                                </td>
                                <td className="py-2.5 text-right font-mono text-emerald-400/70">
                                    ${(oosTotalPnl / allOOSTrades.length).toFixed(0)}
                                </td>
                            </tr>
                        </tfoot>
                    </table>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                        {Object.entries(exitBreakdown).map(([type, count]) => (
                            <div key={type} className="bg-[#1A1A1A] rounded-lg px-3 py-2 border border-white/5">
                                <div className="text-[10px] text-text-tertiary uppercase">{type.replace('_', ' ')}</div>
                                <div className="font-mono font-bold text-sm text-white">
                                    {count} <span className="text-text-tertiary font-normal text-[10px]">
                                        ({(count / allOOSTrades.length * 100).toFixed(1)}%)
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Tab: Stress */}
            {tab === 'stress' && (
                <div className="space-y-4">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        <div className="bg-[#1A1A1A] rounded-xl border border-red-500/20 p-4">
                            <div className="text-[10px] text-text-tertiary uppercase mb-1">Peak Correlated DD</div>
                            <div className="text-xl font-mono font-bold text-red-400">
                                {wfaData.stressMetrics.peakCorrelatedDD.toFixed(1)}%
                            </div>
                            <div className="text-[10px] text-text-tertiary mt-1">
                                On {wfaData.stressMetrics.peakCorrelatedDDDate} ·{' '}
                                {wfaData.stressMetrics.tickersInDDOnWorstDay} tickers in DD
                            </div>
                        </div>
                        <div className="bg-[#1A1A1A] rounded-xl border border-red-500/20 p-4">
                            <div className="text-[10px] text-text-tertiary uppercase mb-1">Worst Day Loss</div>
                            <div className="text-xl font-mono font-bold text-red-400">
                                ${Math.abs(wfaData.stressMetrics.worstDayLoss / 1000).toFixed(1)}K
                            </div>
                            <div className="text-[10px] text-text-tertiary mt-1">
                                {wfaData.stressMetrics.worstDayLossDate}
                            </div>
                        </div>
                        <div className="bg-[#1A1A1A] rounded-xl border border-yellow-500/20 p-4">
                            <div className="text-[10px] text-text-tertiary uppercase mb-1">Avg Pairwise Corr</div>
                            <div className="text-xl font-mono font-bold text-yellow-400">
                                {wfaData.stressMetrics.avgPairwiseCorrelation.toFixed(3)}
                            </div>
                            <div className="text-[10px] text-text-tertiary mt-1">
                                Penalty: {(wfaData.stressMetrics.correlationPenalty * 100).toFixed(1)}%
                            </div>
                        </div>
                    </div>

                    <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                        <div className="text-xs font-semibold mb-3 text-text-secondary">Per-Ticker Max Drawdown</div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {Object.entries(wfaData.stressMetrics.perTickerDD)
                                .sort(([, a], [, b]) => a - b)
                                .map(([ticker, dd]) => (
                                    <div key={ticker} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#111] border border-white/5">
                                        <span className="font-mono font-bold text-xs text-white">{ticker}</span>
                                        <span className="font-mono text-xs text-red-400">${Math.abs(dd).toFixed(0)}</span>
                                    </div>
                                ))}
                        </div>
                    </div>

                    <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4 text-xs text-text-secondary space-y-2">
                        <div className="font-semibold text-white">Interpretation</div>
                        <p>
                            Peak correlated drawdown of <span className="text-red-400 font-mono">67.8%</span> occurred on 2024-09-17 when
                            all {wfaData.stressMetrics.tickersInDDOnWorstDay} tickers were simultaneously in drawdown.
                            This is the theoretical worst-case if all positions moved against you at once.
                        </p>
                        <p>
                            Avg pairwise correlation of <span className="text-yellow-400 font-mono">0.198</span> indicates
                            reasonable diversification across the {config.tickers.length}-ticker portfolio.
                            The <span className="font-mono">maxPerTicker={config.maxPerTicker}</span> and{' '}
                            <span className="font-mono">maxPositions={config.maxPositions}</span> limits further cap concentration risk.
                        </p>
                        <p>
                            The worst realized single-day loss of <span className="text-red-400 font-mono">${Math.abs(wfaData.stressMetrics.worstDayLoss / 1000).toFixed(1)}K</span> on{' '}
                            {wfaData.stressMetrics.worstDayLossDate} (Liberation Day tariff shock) represents{' '}
                            <span className="font-mono">{(Math.abs(wfaData.stressMetrics.worstDayLoss) / 100000 * 100).toFixed(1)}%</span> of
                            starting capital — well within defined-risk spread mechanics.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};
