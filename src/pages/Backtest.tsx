import React, { useState, useMemo } from 'react';
import {
    AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip,
    ResponsiveContainer, CartesianGrid,
    BarChart, Bar, Legend
} from 'recharts';
import { TrendingUp, Activity, ShieldAlert, BarChart3, Layers, AlertTriangle, Info, Clock } from 'lucide-react';
import wfaRaw from '../../data/wfa-results.json';
import wfaShortRaw from '../../data/wfa-results-short.json';
import signalsRaw from '../../data/viewer-signals.json';
import configsRaw from '../../data/viewer-configs.json';
import { useAppSettings } from '../context/AppSettingsContext';
import { getProfile } from '../lib/strategyProfiles';

// ── Types ─────────────────────────────────────────────────────────────────────

interface WFAWindow {

    windowIndex: number; trainStart: string; trainEnd: string;
    oosStart: string; oosEnd: string;
    bestTrainSharpe: number; oosSharpe: number;
    oosTrades: Trade[];
    bestConfig: { signalWeightPreset: string; creditProfitTarget: number; minIVRank: number };
}
interface Trade {
    ticker: string; entryDate: string; exitDate: string; pnl: number; pnlPct: number;
    holdDays: number; exitType: string; direction: string; entryDelta: number;
    entryDTE: number; strike: number; spreadWidth: number;
}
interface WFAData {
    config: { tickers: string[]; startDate: string; endDate: string; trainWindowDays: number; forwardStepDays: number; purgeGapDays: number; startingCapital: number; maxPositions: number; maxPerTicker: number };
    windows: WFAWindow[];
    allOOSTrades: Trade[];
    oosEquityCurve: { date: string; equity: number }[];
    oosSharpe: number; oosWinRate: number; oosMaxDD: number; oosTotalPnl: number; wfEfficiency: number;
    stressMetrics: { peakCorrelatedDD: number; peakCorrelatedDDDate: string; tickersInDDOnWorstDay: number; avgPairwiseCorrelation: number; worstDayLoss: number; worstDayLossDate: string; correlationPenalty: number; perTickerDD: Record<string, number> };
}
interface PeriodStats { sharpe: number; wr: number; roc: number; trades: number; util?: number; dd?: number }
interface SignalIVRow { signal: string; filter: string; is: PeriodStats; oos: PeriodStats }
interface ScoreTierRow { signal: string; tier: string; is: PeriodStats; oos: PeriodStats }
interface OptionFilterRow { filter: string; is: { sharpe: number; wr: number; trades: number; util: number }; oos: { sharpe: number; wr: number; trades: number; util: number } }
interface ExitRow { exit: string; label: string; signal: string; is: { sharpe: number; wr: number; roc: number; dd: number }; oos: { sharpe: number; wr: number; roc: number; dd: number } }
interface ViewerSignals { signalIV: SignalIVRow[]; scoreTier: ScoreTierRow[] }
interface ViewerConfigs { optionFilters: OptionFilterRow[]; exitRows: ExitRow[]; ivRows: SignalIVRow[] }

const wfaData = wfaRaw as unknown as WFAData;
const signalsData = signalsRaw as unknown as ViewerSignals;
const configsData = configsRaw as unknown as ViewerConfigs;

// Normalize short-DTE data to match WFAData shape
const wfaShortData: WFAData = (() => {
    const raw = wfaShortRaw as any;
    const trades: Trade[] = (raw.allOOSTrades ?? []).map((t: any) => ({
        ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
        pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
        exitType: t.exitType, direction: t.direction, entryDelta: t.entryDelta,
        entryDTE: t.entryDTE, strike: t.strike, spreadWidth: t.spreadWidth ?? 2.5,
    }));

    // Build equity curve from sorted trades
    const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
    let equity = 100_000;
    const oosEquityCurve = sorted.map(t => { equity += t.pnl; return { date: t.exitDate, equity }; });

    const windows: WFAWindow[] = (raw.windows ?? []).map((w: any, i: number) => ({
        windowIndex: i,
        trainStart: w.trainStart, trainEnd: w.trainEnd,
        oosStart: w.oosStart, oosEnd: w.oosEnd,
        bestTrainSharpe: w.bestTrainSharpe, oosSharpe: w.oosSharpe,
        oosTrades: (w.oosTrades ?? []).map((t: any) => ({
            ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
            pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
            exitType: t.exitType, direction: t.direction, entryDelta: t.entryDelta,
            entryDTE: t.entryDTE, strike: t.strike, spreadWidth: t.spreadWidth ?? 2.5,
        })),
        bestConfig: {
            signalWeightPreset: w.bestConfig?.preset ?? 'ema',
            creditProfitTarget: w.bestConfig?.tp ?? 0.40,
            minIVRank: w.bestConfig?.ivMin ?? 30,
            // Extra fields for short-DTE display
            ...w.bestConfig,
        },
    }));

    return {
        config: {
            tickers: [...new Set(trades.map((t: Trade) => t.ticker))] as string[],
            startDate: windows[0]?.trainStart ?? '',
            endDate: windows[windows.length - 1]?.oosEnd ?? '',
            trainWindowDays: 252, forwardStepDays: 63, purgeGapDays: 25,
            startingCapital: 100_000, maxPositions: 10, maxPerTicker: 2,
        },
        windows,
        allOOSTrades: trades,
        oosEquityCurve,
        oosSharpe: raw.oosSharpe ?? 0,
        oosWinRate: raw.oosWinRate ?? 0,
        oosMaxDD: raw.oosMaxDD ?? 0,
        oosTotalPnl: raw.oosTotalPnl ?? 0,
        wfEfficiency: raw.wfEfficiency ?? 0,
        stressMetrics: {
            peakCorrelatedDD: 0, peakCorrelatedDDDate: '', tickersInDDOnWorstDay: 0,
            avgPairwiseCorrelation: 0, worstDayLoss: 0, worstDayLossDate: '',
            correlationPenalty: 0, perTickerDD: {},
        },
    };
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtUsd = (n: number) => n >= 0 ? `+$${(n / 1000).toFixed(0)}K` : `-$${(Math.abs(n) / 1000).toFixed(0)}K`;
const fmtMon = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const fmtPeriod = (s: string, e: string) => `${fmtMon(s)} – ${fmtMon(e)}`;
const sharpeColor = (s: number) => s >= 2.0 ? 'text-emerald-400' : s >= 1.0 ? 'text-yellow-400' : 'text-red-400';
const wrColor = (wr: number) => wr >= 80 ? 'text-emerald-400' : wr >= 70 ? 'text-yellow-400' : 'text-red-400';

const PRESET_COLORS: Record<string, string> = {
    ema: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    mom: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    em:  'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    EM:  'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    mf:  'bg-orange-500/20 text-orange-400 border-orange-500/30',
    MF:  'bg-orange-500/20 text-orange-400 border-orange-500/30',
};
const PRESET_LABELS: Record<string, string> = { ema: 'EMA Trend', mom: 'Momentum', em: 'EMA+Mom', EM: 'EMA+Mom', mf: 'Multi-Factor', MF: 'Multi-Factor' };
const SIG_CHART_COLOR: Record<string, string> = { ema: '#60a5fa', mom: '#c084fc', EM: '#34d399', MF: '#fb923c' };

const FILTER_GROUPS: Record<string, string[]> = {
    'IV':      ['noFilter', 'iv20plus', 'iv30plus', 'ivCap80', 'iv20_80'],
    'Volume':  ['vol10', 'vol50', 'vol100'],
    'OI':      ['oi100', 'oi500', 'oi1000'],
    'B/A':     ['ba10pct', 'ba20pct', 'ba30pct'],
    'Credit':  ['cr15pct', 'cr20pct', 'cr25pct'],
    'Composite': ['liq_gate'],
};
const filterGroup = (f: string) => Object.entries(FILTER_GROUPS).find(([, v]) => v.includes(f))?.[0] ?? 'Other';
const FILTER_DESCRIPTIONS: Record<string, string> = {
    noFilter: 'No filter (baseline)',
    iv20plus: 'IV rank ≥ 20%',
    iv30plus: 'IV rank ≥ 30%',
    ivCap80:  'IV rank ≤ 80% (cap extreme IV)',
    iv20_80:  'IV rank 20–80%',
    vol10: 'Avg vol ≥ 10', vol50: 'Avg vol ≥ 50', vol100: 'Avg vol ≥ 100',
    oi100: 'OI ≥ 100', oi500: 'OI ≥ 500', oi1000: 'OI ≥ 1000',
    ba10pct: 'B/A spread ≤ 10%', ba20pct: 'B/A spread ≤ 20%', ba30pct: 'B/A spread ≤ 30%',
    cr15pct: 'Credit ≥ 15% of width', cr20pct: 'Credit ≥ 20% of width', cr25pct: 'Credit ≥ 25% of width',
    liq_gate: 'Combined liquidity gate',
};

// ── Sub-components ────────────────────────────────────────────────────────────

const Stat: React.FC<{ label: string; value: string | number; sub?: string; tone?: 'good' | 'bad' | 'warn' | 'neutral'; icon?: React.ReactNode }> = ({ label, value, sub, tone = 'neutral', icon }) => {
    const colors = { good: 'text-emerald-400', bad: 'text-red-400', warn: 'text-yellow-400', neutral: 'text-white' };
    return (
        <div className="bg-[#1A1A1A] rounded-xl p-3.5 border border-white/5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary uppercase tracking-wider">{icon}{label}</div>
            <div className={`text-xl font-mono font-bold ${colors[tone]}`}>{value}</div>
            {sub && <div className="text-[10px] text-text-tertiary">{sub}</div>}
        </div>
    );
};

const TabBtn: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
    <button onClick={onClick} className={`px-3.5 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${active ? 'bg-accent-green/15 text-accent-green border border-accent-green/30' : 'text-text-tertiary hover:text-text-secondary'}`}>
        {children}
    </button>
);

const SubTabBtn: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
    <button onClick={onClick} className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${active ? 'bg-white/10 text-white' : 'text-text-tertiary hover:text-text-secondary'}`}>
        {children}
    </button>
);

const PresetBadge: React.FC<{ preset: string }> = ({ preset }) => (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${PRESET_COLORS[preset] ?? 'bg-white/10 text-white border-white/20'}`}>
        {preset.toUpperCase()}
    </span>
);

const ISDiff: React.FC<{ is: number; oos: number }> = ({ is: isVal, oos }) => {
    const diff = oos - isVal;
    return <span className={`text-[10px] font-mono ml-1 ${diff >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>({diff >= 0 ? '+' : ''}{diff.toFixed(2)})</span>;
};

const EquityTooltip: React.FC<{ active?: boolean; payload?: { value: number }[]; label?: string }> = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const equity = payload[0].value;
    const gain = ((equity - 100000) / 100000 * 100).toFixed(1);
    return (
        <div className="bg-[#1E1E1E] border border-white/10 rounded-lg px-3 py-2 text-xs shadow-xl">
            <div className="text-text-tertiary mb-0.5">{label}</div>
            <div className="font-mono font-bold text-white">${(equity / 1000).toFixed(1)}K</div>
            <div className={`font-mono ${parseFloat(gain) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{gain}% return</div>
        </div>
    );
};

const SharpeBarTooltip: React.FC<{ active?: boolean; payload?: { dataKey: string; value: number; color: string }[]; label?: string }> = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
        <div className="bg-[#1E1E1E] border border-white/10 rounded-lg px-3 py-2 text-xs shadow-xl space-y-1">
            <div className="text-text-tertiary font-medium">{label}</div>
            {payload.map(p => (
                <div key={p.dataKey} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
                    <span className="text-text-secondary">{p.dataKey}:</span>
                    <span className="font-mono font-bold text-white">{p.value.toFixed(3)}</span>
                </div>
            ))}
        </div>
    );
};

// ── Main Page ─────────────────────────────────────────────────────────────────

export const BacktestPage: React.FC = () => {
    const { activeStrategy } = useAppSettings();
    const profile = getProfile(activeStrategy);
    const isShort = activeStrategy === 'shortTerm';
    const [tab, setTab] = useState<'windows' | 'signals' | 'configs' | 'tickers' | 'stress'>('windows');
    const [signalSubTab, setSignalSubTab] = useState<'iv' | 'tier'>('iv');
    const [configSubTab, setConfigSubTab] = useState<'iv' | 'filters' | 'exits'>('iv');
    const [selectedSignalFilter, setSelectedSignalFilter] = useState<string>('all');
    const [exitSignalFilter, setExitSignalFilter] = useState<string>('ema');

    const activeData = isShort ? wfaShortData : wfaData;

    // When switching to short mode via the global toggle, reset tab if on signals/configs
    React.useEffect(() => {
        if (isShort && (tab === 'signals' || tab === 'configs')) setTab('windows');
    }, [isShort]); // eslint-disable-line react-hooks/exhaustive-deps

    // Deduplicate equity curve: last trade per date wins
    const equityCurve = useMemo(() => {
        const map = new Map<string, number>();
        for (const pt of activeData.oosEquityCurve) map.set(pt.date, pt.equity);
        return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, equity]) => ({ date, equity }));
    }, [activeData]);

    const xTicks = useMemo(() => {
        const years = new Set<string>();
        for (const pt of equityCurve) years.add(pt.date.slice(0, 4));
        return Array.from(years).map(y => `${y}-01-01`);
    }, [equityCurve]);

    // Ticker stats
    const tickerStats = useMemo(() => {
        const map: Record<string, { trades: number; wins: number; pnl: number }> = {};
        for (const t of activeData.allOOSTrades) {
            if (!map[t.ticker]) map[t.ticker] = { trades: 0, wins: 0, pnl: 0 };
            map[t.ticker].trades++;
            if (t.exitType === 'PROFIT_TARGET') map[t.ticker].wins++;
            map[t.ticker].pnl += t.pnl;
        }
        return Object.entries(map).map(([ticker, v]) => ({ ticker, ...v, winRate: v.wins / v.trades * 100 })).sort((a, b) => b.pnl - a.pnl);
    }, [activeData]);

    // WFA preset wins
    const presetStats = useMemo(() => {
        const map: Record<string, { wins: number; totalSharpe: number; totalWR: number; windows: number[] }> = {};
        for (const w of activeData.windows) {
            const p = w.bestConfig.signalWeightPreset;
            if (!map[p]) map[p] = { wins: 0, totalSharpe: 0, totalWR: 0, windows: [] };
            map[p].wins++;
            map[p].totalSharpe += w.oosSharpe;
            const trades = w.oosTrades ?? [];
            map[p].totalWR += trades.length ? trades.filter(t => t.exitType === 'PROFIT_TARGET').length / trades.length * 100 : 0;
            map[p].windows.push(w.windowIndex);
        }
        return Object.entries(map).map(([preset, v]) => ({ preset, label: PRESET_LABELS[preset] ?? preset, wins: v.wins, avgSharpe: v.totalSharpe / v.wins, avgWR: v.totalWR / v.wins, windows: v.windows })).sort((a, b) => b.wins - a.wins);
    }, [activeData]);

    // Signal bar chart data (IV filter comparison)
    const signalChartData = useMemo(() => {
        const filters = ['noFilter', 'iv20plus', 'iv30plus'];
        return filters.map(f => {
            const row: Record<string, string | number> = { name: f === 'noFilter' ? 'No Filter' : f === 'iv20plus' ? 'IV≥20' : 'IV≥30' };
            for (const sig of ['ema', 'mom', 'EM', 'MF']) {
                const d = signalsData.signalIV.find(r => r.signal === sig && r.filter === f);
                if (d) row[sig] = d.oos.sharpe;
            }
            return row;
        });
    }, []);

    // Exit strategies chart data
    const exitChartData = useMemo(() => {
        const exits = ['std30', 'std50', 'ph30_50_be', 'ph30_50_25', 'ph30_75_25', 'ph50_75_25'];
        const labels: Record<string, string> = { std30: 'TP30', std50: 'TP50', ph30_50_be: 'P30/BE', ph30_50_25: 'P30/25', ph30_75_25: 'P30→75', ph50_75_25: 'P50→75' };
        return exits.map(exit => {
            const row: Record<string, string | number> = { name: labels[exit] };
            for (const sig of ['ema', 'mom', 'EM', 'MF']) {
                const d = configsData.exitRows.find(r => r.exit === exit && r.signal === sig);
                if (d) row[sig] = d.oos.sharpe;
            }
            return row;
        });
    }, []);

    const { oosSharpe, oosWinRate, oosMaxDD, oosTotalPnl, wfEfficiency, allOOSTrades, config } = activeData;
    const roc = oosTotalPnl / config.startingCapital * 100;
    const exitBreakdown = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const t of allOOSTrades) counts[t.exitType] = (counts[t.exitType] ?? 0) + 1;
        return counts;
    }, [allOOSTrades]);

    return (
        <div className="fade-in pb-24 sm:pb-8 space-y-5">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h2 className="text-2xl font-bold">WFA Results</h2>
                    <p className="text-text-secondary text-sm mt-0.5">Walk-Forward Analysis · {config.tickers.length} tickers · {config.startDate} → {config.endDate}</p>
                    <p className={`text-[11px] mt-0.5 font-mono ${isShort ? 'text-blue-400/70' : 'text-emerald-400/70'}`}>{profile.subtitle}</p>
                </div>
                <div className="text-right text-[11px] text-text-tertiary font-mono space-y-0.5">
                    <div>Train {config.trainWindowDays}d · OOS {config.forwardStepDays}d · Purge {config.purgeGapDays}d</div>
                    <div>{activeData.windows.length} windows · $100K start</div>
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                <Stat label="OOS Sharpe" value={oosSharpe.toFixed(2)} sub="Combined" tone={oosSharpe >= 1 ? 'good' : 'warn'} icon={<Activity size={11} />} />
                <Stat label="Win Rate" value={`${oosWinRate.toFixed(1)}%`} sub={`${exitBreakdown['PROFIT_TARGET'] ?? 0} wins`} tone={oosWinRate >= 80 ? 'good' : 'warn'} icon={<BarChart3 size={11} />} />
                <Stat label="Max DD" value={`${oosMaxDD.toFixed(1)}%`} sub="OOS peak→trough" tone="neutral" icon={<ShieldAlert size={11} />} />
                <Stat label="Total P&L" value={`$${(oosTotalPnl / 1000).toFixed(0)}K`} sub={`${roc.toFixed(0)}% ROC`} tone="good" icon={<TrendingUp size={11} />} />
                <Stat label="WF Efficiency" value={`${(wfEfficiency * 100).toFixed(0)}%`} sub="OOS / In-sample" tone={wfEfficiency >= 0.8 ? 'good' : 'warn'} icon={<Layers size={11} />} />
                <Stat label="Trades" value={allOOSTrades.length.toLocaleString()} sub={`${config.tickers.length} tickers`} tone="neutral" />
                {!isShort && <Stat label="Avg Corr" value={activeData.stressMetrics.avgPairwiseCorrelation.toFixed(3)} sub="Pairwise ρ" tone={activeData.stressMetrics.avgPairwiseCorrelation < 0.25 ? 'good' : 'warn'} icon={<AlertTriangle size={11} />} />}
                {isShort && <Stat label="Avg Hold" value={`${(allOOSTrades.reduce((s, t) => s + t.holdDays, 0) / Math.max(1, allOOSTrades.length)).toFixed(1)}d`} sub="Per trade" tone="neutral" icon={<Clock size={11} />} />}
            </div>

            {/* Equity Curve */}
            <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                <div className="flex items-center justify-between mb-3">
                    <div>
                        <span className="text-sm font-semibold">Equity Curve</span>
                        <span className="text-text-tertiary text-xs ml-2">OOS only · $100K → ${equityCurve.length ? `$${(equityCurve[equityCurve.length - 1].equity / 1000).toFixed(0)}K` : '—'}</span>
                    </div>
                    <span className="text-emerald-400 font-mono text-sm font-bold">+{roc.toFixed(0)}%</span>
                </div>
                <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={equityCurve} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                        <defs>
                            <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#34d399" stopOpacity={0.25} />
                                <stop offset="95%" stopColor="#34d399" stopOpacity={0.02} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#2A2A2A" vertical={false} />
                        <XAxis dataKey="date" ticks={xTicks} tickFormatter={d => d.slice(0, 4)} tick={{ fontSize: 10, fill: '#666' }} axisLine={false} tickLine={false} />
                        <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 10, fill: '#666' }} axisLine={false} tickLine={false} width={52} />
                        <RechartsTooltip content={<EquityTooltip />} />
                        <Area type="monotone" dataKey="equity" stroke="#34d399" strokeWidth={1.5} fill="url(#equityGrad)" dot={false} activeDot={{ r: 3, fill: '#34d399' }} />
                    </AreaChart>
                </ResponsiveContainer>
            </div>

            {/* Tabs */}
            <div className="flex gap-1.5 border-b border-[#2A2A2A] pb-3 overflow-x-auto scrollbar-hide">
                <TabBtn active={tab === 'windows'} onClick={() => setTab('windows')}>Windows</TabBtn>
                {!isShort && <TabBtn active={tab === 'signals'} onClick={() => setTab('signals')}>Signals</TabBtn>}
                {!isShort && <TabBtn active={tab === 'configs'} onClick={() => setTab('configs')}>Configs</TabBtn>}
                <TabBtn active={tab === 'tickers'} onClick={() => setTab('tickers')}>Tickers</TabBtn>
                {!isShort && <TabBtn active={tab === 'stress'} onClick={() => setTab('stress')}>Stress</TabBtn>}
            </div>

            {/* ── Tab: Windows ── */}
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
                                {isShort && <th className="text-right pb-2 pr-3 font-medium">P&L</th>}
                                <th className="text-center pb-2 pr-3 font-medium">Signal</th>
                                <th className="text-center pb-2 pr-3 font-medium">TP</th>
                                {isShort && <th className="text-center pb-2 pr-3 font-medium">Width</th>}
                                {isShort && <th className="text-center pb-2 pr-3 font-medium">Delta</th>}
                                <th className="text-center pb-2 font-medium">IV≥</th>
                            </tr>
                        </thead>
                        <tbody>
                            {activeData.windows.map(w => {
                                const trades = w.oosTrades ?? [];
                                const wins = trades.filter(t => t.exitType === 'PROFIT_TARGET').length;
                                const wr = trades.length ? wins / trades.length * 100 : 0;
                                return (
                                    <tr key={w.windowIndex} className="border-t border-[#222] hover:bg-white/2 transition-colors">
                                        <td className="py-2.5 pr-3 font-mono text-text-tertiary">W{w.windowIndex}</td>
                                        <td className="py-2.5 pr-3 text-text-secondary font-mono">{fmtPeriod(w.oosStart, w.oosEnd)}</td>
                                        <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{w.bestTrainSharpe.toFixed(2)}</td>
                                        <td className={`py-2.5 pr-3 text-right font-mono font-bold ${sharpeColor(w.oosSharpe)}`}>{w.oosSharpe.toFixed(2)}</td>
                                        <td className={`py-2.5 pr-3 text-right font-mono ${wrColor(wr)}`}>{trades.length ? `${wr.toFixed(1)}%` : '—'}</td>
                                        <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{trades.length}</td>
                                        {isShort && <td className={`py-2.5 pr-3 text-right font-mono ${trades.reduce((s, t) => s + t.pnl, 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{trades.length ? `$${trades.reduce((s, t) => s + t.pnl, 0).toFixed(0)}` : '—'}</td>}
                                        <td className="py-2.5 pr-3 text-center"><PresetBadge preset={w.bestConfig.signalWeightPreset} /></td>
                                        <td className="py-2.5 pr-3 text-center font-mono text-text-secondary">{(w.bestConfig.creditProfitTarget * 100).toFixed(0)}%</td>
                                        {isShort && <td className="py-2.5 pr-3 text-center font-mono text-text-secondary">${(w.bestConfig as any).width ?? '—'}</td>}
                                        {isShort && <td className="py-2.5 pr-3 text-center font-mono text-text-secondary">{(w.bestConfig as any).delta ?? '—'}</td>}
                                        <td className="py-2.5 text-center font-mono text-text-secondary">{w.bestConfig.minIVRank > 0 ? `${w.bestConfig.minIVRank}%` : '—'}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    <div className="mt-4 text-[10px] text-text-tertiary flex items-center gap-1.5">
                        <Info size={10} />
                        {profile.subtitle} · no stop loss across all windows
                    </div>
                </div>
            )}

            {/* ── Tab: Signals ── */}
            {tab === 'signals' && (
                <div className="space-y-4">
                    <div className="flex gap-1.5">
                        <SubTabBtn active={signalSubTab === 'iv'} onClick={() => setSignalSubTab('iv')}>Signal × IV Filter</SubTabBtn>
                        <SubTabBtn active={signalSubTab === 'tier'} onClick={() => setSignalSubTab('tier')}>Score Tier</SubTabBtn>
                    </div>

                    {signalSubTab === 'iv' && (
                        <div className="space-y-4">
                            {/* Bar chart: OOS Sharpe per signal × IV filter */}
                            <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                                <div className="text-xs text-text-tertiary mb-3">OOS Sharpe by Signal & IV Filter</div>
                                <ResponsiveContainer width="100%" height={180}>
                                    <BarChart data={signalChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#2A2A2A" vertical={false} />
                                        <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#666' }} axisLine={false} tickLine={false} />
                                        <YAxis domain={[0, 2.5]} tick={{ fontSize: 10, fill: '#666' }} axisLine={false} tickLine={false} width={32} />
                                        <RechartsTooltip content={<SharpeBarTooltip />} />
                                        <Legend wrapperStyle={{ fontSize: 10, color: '#888' }} />
                                        {(['ema', 'mom', 'EM', 'MF'] as const).map(sig => (
                                            <Bar key={sig} dataKey={sig} fill={SIG_CHART_COLOR[sig]} radius={[2, 2, 0, 0]} maxBarSize={18} />
                                        ))}
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>

                            {/* Signal filter toggle */}
                            <div className="flex items-center gap-1.5">
                                <span className="text-[11px] text-text-tertiary">Signal:</span>
                                {['all', 'ema', 'mom', 'EM', 'MF'].map(s => (
                                    <button key={s} onClick={() => setSelectedSignalFilter(s)} className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${selectedSignalFilter === s ? 'bg-white/15 text-white' : 'text-text-tertiary hover:text-text-secondary'}`}>
                                        {s === 'all' ? 'All' : s.toUpperCase()}
                                    </button>
                                ))}
                            </div>

                            {/* Detailed table */}
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-text-tertiary uppercase tracking-wider">
                                        <th className="text-left pb-2 pr-2 font-medium">Signal</th>
                                        <th className="text-left pb-2 pr-3 font-medium">Filter</th>
                                        <th className="text-right pb-2 pr-2 font-medium">IS Sharpe</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS Sharpe</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS WR</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS ROC</th>
                                        <th className="text-right pb-2 pr-3 font-medium">Trades</th>
                                        <th className="text-right pb-2 font-medium">Util</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {signalsData.signalIV
                                        .filter(r => selectedSignalFilter === 'all' || r.signal === selectedSignalFilter)
                                        .sort((a, b) => b.oos.sharpe - a.oos.sharpe)
                                        .map((r, i) => (
                                            <tr key={i} className={`border-t border-[#222] hover:bg-white/2 transition-colors ${r.signal === 'ema' && r.filter === 'iv30plus' ? 'bg-emerald-500/5' : ''}`}>
                                                <td className="py-2.5 pr-2"><PresetBadge preset={r.signal} /></td>
                                                <td className="py-2.5 pr-3 font-mono text-text-secondary">{r.filter}</td>
                                                <td className="py-2.5 pr-2 text-right font-mono text-text-tertiary">{r.is.sharpe.toFixed(3)}</td>
                                                <td className={`py-2.5 pr-3 text-right font-mono font-bold ${sharpeColor(r.oos.sharpe)}`}>
                                                    {r.oos.sharpe.toFixed(3)}<ISDiff is={r.is.sharpe} oos={r.oos.sharpe} />
                                                </td>
                                                <td className={`py-2.5 pr-3 text-right font-mono ${wrColor(r.oos.wr)}`}>{r.oos.wr.toFixed(1)}%</td>
                                                <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{r.oos.roc.toFixed(1)}%</td>
                                                <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{r.oos.trades}</td>
                                                <td className="py-2.5 text-right font-mono text-text-tertiary">{r.oos.util?.toFixed(1)}%</td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                            <div className="text-[10px] text-text-tertiary flex items-center gap-1.5">
                                <Info size={10} /> OOS period: Apr 2024 – Feb 2026 · maxPositions=50 · highlighted row = WFA production config
                            </div>
                        </div>
                    )}

                    {signalSubTab === 'tier' && (
                        <div className="space-y-3">
                            <div className="text-xs text-text-tertiary mb-2">
                                <strong className="text-white">ALL</strong> = all scored signals &nbsp;·&nbsp;
                                <strong className="text-white">S-tier</strong> = score ≥ 90 only · Exit: TP 30% · Per-ticker: 3 · maxPos: 50
                            </div>
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-text-tertiary uppercase tracking-wider">
                                        <th className="text-left pb-2 pr-2 font-medium">Signal</th>
                                        <th className="text-center pb-2 pr-3 font-medium">Tier</th>
                                        <th className="text-right pb-2 pr-2 font-medium">IS Sharpe</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS Sharpe</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS WR</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS ROC</th>
                                        <th className="text-right pb-2 font-medium">Trades</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {signalsData.scoreTier.sort((a, b) => b.oos.sharpe - a.oos.sharpe).map((r, i) => (
                                        <tr key={i} className={`border-t border-[#222] hover:bg-white/2 transition-colors`}>
                                            <td className="py-2.5 pr-2"><PresetBadge preset={r.signal} /></td>
                                            <td className="py-2.5 pr-3 text-center">
                                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${r.tier === 'S' ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' : 'bg-white/5 text-text-tertiary border-white/10'}`}>{r.tier}</span>
                                            </td>
                                            <td className="py-2.5 pr-2 text-right font-mono text-text-tertiary">{r.is.sharpe.toFixed(3)}</td>
                                            <td className={`py-2.5 pr-3 text-right font-mono font-bold ${sharpeColor(r.oos.sharpe)}`}>
                                                {r.oos.sharpe.toFixed(3)}<ISDiff is={r.is.sharpe} oos={r.oos.sharpe} />
                                            </td>
                                            <td className={`py-2.5 pr-3 text-right font-mono ${wrColor(r.oos.wr)}`}>{r.oos.wr.toFixed(1)}%</td>
                                            <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{r.oos.roc.toFixed(1)}%</td>
                                            <td className="py-2.5 text-right font-mono text-text-secondary">{r.oos.trades}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {/* WFA preset wins summary */}
                            <div className="mt-4 bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                                <div className="text-xs font-semibold mb-3">WFA Window Wins (best config selected per 12 windows)</div>
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                    {presetStats.map(p => (
                                        <div key={p.preset} className="p-3 rounded-lg bg-[#111] border border-white/5 space-y-1.5">
                                            <div className="flex items-center justify-between">
                                                <PresetBadge preset={p.preset} />
                                                <span className="text-[10px] text-text-tertiary">{p.wins}/12</span>
                                            </div>
                                            <div className={`font-mono font-bold text-sm ${sharpeColor(p.avgSharpe)}`}>{p.avgSharpe.toFixed(2)} <span className="text-[10px] font-normal text-text-tertiary">avg Sharpe</span></div>
                                            <div className="text-[10px] text-text-tertiary">{p.windows.map(w => `W${w}`).join(', ')}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Tab: Configs ── */}
            {tab === 'configs' && (
                <div className="space-y-4">
                    <div className="flex gap-1.5">
                        <SubTabBtn active={configSubTab === 'iv'} onClick={() => setConfigSubTab('iv')}>IV Filters</SubTabBtn>
                        <SubTabBtn active={configSubTab === 'filters'} onClick={() => setConfigSubTab('filters')}>Option Filters</SubTabBtn>
                        <SubTabBtn active={configSubTab === 'exits'} onClick={() => setConfigSubTab('exits')}>Exit Strategies</SubTabBtn>
                    </div>

                    {/* ── IV Filters sub-tab ── */}
                    {configSubTab === 'iv' && (
                        <div className="space-y-4">
                            <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                                <div className="text-xs text-text-tertiary mb-3">OOS Sharpe — All Signals × IV Filter (higher is better)</div>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-xs">
                                        <thead>
                                            <tr className="text-text-tertiary uppercase tracking-wider">
                                                <th className="text-left pb-2 pr-3 font-medium">Signal</th>
                                                <th className="text-right pb-2 pr-3 font-medium">No Filter</th>
                                                <th className="text-right pb-2 pr-3 font-medium">IV ≥ 20%</th>
                                                <th className="text-right pb-2 font-medium">IV ≥ 30%</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {['ema', 'mom', 'EM', 'MF'].map(sig => {
                                                const noFilt = configsData.ivRows.find(r => r.signal === sig && r.filter === 'noFilter');
                                                const iv20 = configsData.ivRows.find(r => r.signal === sig && r.filter === 'iv20plus');
                                                const iv30 = configsData.ivRows.find(r => r.signal === sig && r.filter === 'iv30plus');
                                                return (
                                                    <tr key={sig} className="border-t border-[#222] hover:bg-white/2">
                                                        <td className="py-3 pr-3"><PresetBadge preset={sig} /></td>
                                                        {[noFilt, iv20, iv30].map((d, i) => (
                                                            <td key={i} className={`py-3 ${i < 2 ? 'pr-3' : ''} text-right`}>
                                                                {d ? (
                                                                    <div>
                                                                        <span className={`font-mono font-bold ${sharpeColor(d.oos.sharpe)}`}>{d.oos.sharpe.toFixed(3)}</span>
                                                                        <div className="text-[9px] text-text-tertiary font-mono">{d.oos.wr.toFixed(1)}% WR · {d.oos.trades} trades</div>
                                                                    </div>
                                                                ) : '—'}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            <div className="bg-[#111] rounded-xl border border-white/5 p-3 text-xs text-text-secondary space-y-1">
                                <div className="font-medium text-white">Key Finding</div>
                                <p>IV ≥ 30% filter consistently improves Sharpe across all 4 signals — <span className="text-emerald-400">ema+iv30 (2.14)</span> is best. Trades drop ~55% but Sharpe/WR both increase. The IV filter ensures we only sell premium when it's elevated, improving edge.</p>
                            </div>
                        </div>
                    )}

                    {/* ── Option Filters sub-tab ── */}
                    {configSubTab === 'filters' && (
                        <div className="space-y-3">
                            <div className="text-xs text-text-tertiary">EMA signal · sorted by OOS Sharpe · IS period 2018-2023 · OOS 2024-2026</div>
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-text-tertiary uppercase tracking-wider">
                                        <th className="text-left pb-2 pr-2 font-medium">Filter</th>
                                        <th className="text-left pb-2 pr-3 font-medium">Description</th>
                                        <th className="text-left pb-2 pr-3 font-medium">Group</th>
                                        <th className="text-right pb-2 pr-2 font-medium">IS Sharpe</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS Sharpe</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS WR</th>
                                        <th className="text-right pb-2 pr-3 font-medium">Trades</th>
                                        <th className="text-right pb-2 font-medium">Util</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {configsData.optionFilters.map((r, i) => (
                                        <tr key={i} className={`border-t border-[#222] hover:bg-white/2 transition-colors ${r.filter === 'iv30plus' ? 'bg-emerald-500/5' : ''}`}>
                                            <td className="py-2 pr-2 font-mono font-bold text-white">{r.filter}</td>
                                            <td className="py-2 pr-3 text-text-tertiary">{FILTER_DESCRIPTIONS[r.filter] ?? r.filter}</td>
                                            <td className="py-2 pr-3">
                                                <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-white/5 text-text-tertiary">{filterGroup(r.filter)}</span>
                                            </td>
                                            <td className="py-2 pr-2 text-right font-mono text-text-tertiary">{r.is.sharpe.toFixed(3)}</td>
                                            <td className={`py-2 pr-3 text-right font-mono font-bold ${sharpeColor(r.oos.sharpe)}`}>
                                                {r.oos.sharpe.toFixed(3)}<ISDiff is={r.is.sharpe} oos={r.oos.sharpe} />
                                            </td>
                                            <td className={`py-2 pr-3 text-right font-mono ${wrColor(r.oos.wr)}`}>{r.oos.wr.toFixed(1)}%</td>
                                            <td className="py-2 pr-3 text-right font-mono text-text-secondary">{r.oos.trades}</td>
                                            <td className="py-2 text-right font-mono text-text-tertiary">{r.oos.util.toFixed(1)}%</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <div className="text-[10px] text-text-tertiary flex items-center gap-1.5">
                                <Info size={10} />
                                Highlighted = iv30plus (production config). IS-OOS diff shown in parentheses.
                            </div>
                        </div>
                    )}

                    {/* ── Exit Strategies sub-tab ── */}
                    {configSubTab === 'exits' && (
                        <div className="space-y-4">
                            {/* Bar chart */}
                            <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                                <div className="text-xs text-text-tertiary mb-3">OOS Sharpe by Exit Strategy & Signal</div>
                                <ResponsiveContainer width="100%" height={180}>
                                    <BarChart data={exitChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#2A2A2A" vertical={false} />
                                        <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#666' }} axisLine={false} tickLine={false} />
                                        <YAxis domain={[0, 1.2]} tick={{ fontSize: 10, fill: '#666' }} axisLine={false} tickLine={false} width={32} />
                                        <RechartsTooltip content={<SharpeBarTooltip />} />
                                        <Legend wrapperStyle={{ fontSize: 10, color: '#888' }} />
                                        {(['ema', 'mom', 'EM', 'MF'] as const).map(sig => (
                                            <Bar key={sig} dataKey={sig} fill={SIG_CHART_COLOR[sig]} radius={[2, 2, 0, 0]} maxBarSize={16} />
                                        ))}
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>

                            {/* Signal filter for exit table */}
                            <div className="flex items-center gap-1.5">
                                <span className="text-[11px] text-text-tertiary">Signal:</span>
                                {['ema', 'mom', 'EM', 'MF'].map(s => (
                                    <button key={s} onClick={() => setExitSignalFilter(s)} className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${exitSignalFilter === s ? 'bg-white/15 text-white' : 'text-text-tertiary hover:text-text-secondary'}`}>
                                        {s.toUpperCase()}
                                    </button>
                                ))}
                            </div>

                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-text-tertiary uppercase tracking-wider">
                                        <th className="text-left pb-2 pr-3 font-medium">Exit Strategy</th>
                                        <th className="text-right pb-2 pr-2 font-medium">IS Sharpe</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS Sharpe</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS WR</th>
                                        <th className="text-right pb-2 pr-3 font-medium">OOS ROC</th>
                                        <th className="text-right pb-2 font-medium">OOS DD</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {configsData.exitRows
                                        .filter(r => r.signal === exitSignalFilter)
                                        .sort((a, b) => b.oos.sharpe - a.oos.sharpe)
                                        .map((r, i) => (
                                            <tr key={i} className={`border-t border-[#222] hover:bg-white/2 transition-colors ${r.exit === 'std30' ? 'bg-emerald-500/5' : ''}`}>
                                                <td className="py-2.5 pr-3">
                                                    <div className="font-medium text-white">{r.label}</div>
                                                    <div className="text-[9px] text-text-tertiary font-mono">{r.exit}</div>
                                                </td>
                                                <td className="py-2.5 pr-2 text-right font-mono text-text-tertiary">{r.is.sharpe.toFixed(3)}</td>
                                                <td className={`py-2.5 pr-3 text-right font-mono font-bold ${sharpeColor(r.oos.sharpe)}`}>
                                                    {r.oos.sharpe.toFixed(3)}<ISDiff is={r.is.sharpe} oos={r.oos.sharpe} />
                                                </td>
                                                <td className={`py-2.5 pr-3 text-right font-mono ${wrColor(r.oos.wr)}`}>{r.oos.wr.toFixed(1)}%</td>
                                                <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{r.oos.roc.toFixed(1)}%</td>
                                                <td className="py-2.5 text-right font-mono text-text-secondary">{r.oos.dd.toFixed(1)}%</td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                            <div className="bg-[#111] rounded-xl border border-white/5 p-3 text-xs text-text-secondary space-y-1">
                                <div className="font-medium text-white">Key Finding</div>
                                <p><span className="text-emerald-400">TP 30% (std30)</span> is the best exit across all signals — simple profit target beats partial harvesting and later targets. Partial exits add complexity without OOS improvement. The high win rate (~85%) means most trades hit 30% TP quickly.</p>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Tab: Tickers ── */}
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
                                    <td className={`py-2.5 pr-3 text-right font-mono font-bold ${wrColor(t.winRate)}`}>{t.winRate.toFixed(1)}%</td>
                                    <td className={`py-2.5 pr-3 text-right font-mono font-bold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtUsd(t.pnl)}</td>
                                    <td className={`py-2.5 text-right font-mono ${t.pnl >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>${(t.pnl / t.trades).toFixed(0)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className="border-t border-[#333]">
                                <td className="py-2.5 pr-3 font-bold text-text-secondary">Total</td>
                                <td className="py-2.5 pr-3 text-right font-mono font-bold text-white">{allOOSTrades.length}</td>
                                <td className={`py-2.5 pr-3 text-right font-mono font-bold ${wrColor(oosWinRate)}`}>{oosWinRate.toFixed(1)}%</td>
                                <td className="py-2.5 pr-3 text-right font-mono font-bold text-emerald-400">{fmtUsd(oosTotalPnl)}</td>
                                <td className="py-2.5 text-right font-mono text-emerald-400/70">${(oosTotalPnl / allOOSTrades.length).toFixed(0)}</td>
                            </tr>
                        </tfoot>
                    </table>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                        {Object.entries(exitBreakdown).map(([type, count]) => (
                            <div key={type} className="bg-[#1A1A1A] rounded-lg px-3 py-2 border border-white/5">
                                <div className="text-[10px] text-text-tertiary uppercase">{type.replace('_', ' ')}</div>
                                <div className="font-mono font-bold text-sm text-white">{count} <span className="text-text-tertiary font-normal text-[10px]">({(count / allOOSTrades.length * 100).toFixed(1)}%)</span></div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Tab: Stress ── */}
            {tab === 'stress' && (
                <div className="space-y-4">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        <div className="bg-[#1A1A1A] rounded-xl border border-red-500/20 p-4">
                            <div className="text-[10px] text-text-tertiary uppercase mb-1">Peak Correlated DD</div>
                            <div className="text-xl font-mono font-bold text-red-400">{activeData.stressMetrics.peakCorrelatedDD.toFixed(1)}%</div>
                            <div className="text-[10px] text-text-tertiary mt-1">On {activeData.stressMetrics.peakCorrelatedDDDate} · {activeData.stressMetrics.tickersInDDOnWorstDay} tickers in DD</div>
                        </div>
                        <div className="bg-[#1A1A1A] rounded-xl border border-red-500/20 p-4">
                            <div className="text-[10px] text-text-tertiary uppercase mb-1">Worst Day Loss</div>
                            <div className="text-xl font-mono font-bold text-red-400">${Math.abs(activeData.stressMetrics.worstDayLoss / 1000).toFixed(1)}K</div>
                            <div className="text-[10px] text-text-tertiary mt-1">{activeData.stressMetrics.worstDayLossDate}</div>
                        </div>
                        <div className="bg-[#1A1A1A] rounded-xl border border-yellow-500/20 p-4">
                            <div className="text-[10px] text-text-tertiary uppercase mb-1">Avg Pairwise Corr</div>
                            <div className="text-xl font-mono font-bold text-yellow-400">{activeData.stressMetrics.avgPairwiseCorrelation.toFixed(3)}</div>
                            <div className="text-[10px] text-text-tertiary mt-1">Penalty: {(activeData.stressMetrics.correlationPenalty * 100).toFixed(1)}%</div>
                        </div>
                    </div>
                    <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                        <div className="text-xs font-semibold mb-3 text-text-secondary">Per-Ticker Max Drawdown</div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {Object.entries(activeData.stressMetrics.perTickerDD).sort(([, a], [, b]) => a - b).map(([ticker, dd]) => (
                                <div key={ticker} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#111] border border-white/5">
                                    <span className="font-mono font-bold text-xs text-white">{ticker}</span>
                                    <span className="font-mono text-xs text-red-400">${Math.abs(dd).toFixed(0)}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4 text-xs text-text-secondary space-y-2">
                        <div className="font-semibold text-white">Interpretation</div>
                        <p>Peak correlated drawdown of <span className="text-red-400 font-mono">67.8%</span> on 2024-09-17 is theoretical worst-case (all {activeData.stressMetrics.tickersInDDOnWorstDay} tickers simultaneously in DD). The actual OOS max DD was only <span className="text-yellow-400 font-mono">{oosMaxDD.toFixed(1)}%</span> because positions don't all peak at the same time.</p>
                        <p>Worst realized single-day loss of <span className="text-red-400 font-mono">${Math.abs(activeData.stressMetrics.worstDayLoss / 1000).toFixed(1)}K</span> on {activeData.stressMetrics.worstDayLossDate} (Liberation Day tariff shock) = <span className="font-mono">{(Math.abs(activeData.stressMetrics.worstDayLoss) / 100000 * 100).toFixed(1)}%</span> of starting capital — manageable under defined-risk spreads.</p>
                        <p>Avg pairwise correlation <span className="text-yellow-400 font-mono">ρ={activeData.stressMetrics.avgPairwiseCorrelation.toFixed(3)}</span> indicates reasonable diversification. <span className="font-mono">maxPerTicker={config.maxPerTicker}</span> and <span className="font-mono">maxPositions={config.maxPositions}</span> caps further contain concentration.</p>
                    </div>
                </div>
            )}
        </div>
    );
};
