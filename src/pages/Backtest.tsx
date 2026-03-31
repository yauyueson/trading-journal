import React, { useState, useMemo } from 'react';
import {
    AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip,
    ResponsiveContainer, CartesianGrid,
    BarChart, Bar, Legend
} from 'recharts';
import { TrendingUp, Activity, ShieldAlert, BarChart3, Layers, AlertTriangle, Info, Clock, Beaker, Shield, Zap } from 'lucide-react';
// Stale WFA viewer data archived 2026-03-30 — all pre-audit results
const wfaRaw: never[] = [];
const wfaShortRaw: never[] = [];
const wfaV2SwingRaw: never[] = [];
const wfaV2ShortRaw: never[] = [];
const wfaV2NoAdxRaw: never[] = [];
const wfaV2Seed43Raw: never[] = [];
const signalsRaw: never[] = [];
const configsRaw: never[] = [];
import { getProfile } from '../lib/strategyProfiles';

// ── Types ─────────────────────────────────────────────────────────────────────

interface WFAWindow {
    windowIndex: number; trainStart: string; trainEnd: string;
    oosStart: string; oosEnd: string;
    bestTrainSharpe: number; oosSharpe: number;
    oosTrades: Trade[];
    oosWinRate?: number;      // v2: pre-computed win rate
    oosTradeCount?: number;   // v2: trade count when oosTrades is empty
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

// ── v2 Types & Normalizers ───────────────────────────────────────────────────

interface V2Stats {
    dsr: { observedSR: number; expectedMaxSR: number; dsr: number; nTrials: number; skewness: number; kurtosis: number };
    pbo: { pbo: number; logitPBO: number; rankCorrelation: number; nCombinations: number };
    bootstrap: { sharpe: { ci5: number; ci50: number; ci95: number }; maxDD: { ci5: number; ci50: number; ci95: number } };
    permutation?: { pValue: number; nPermutations: number; baselineSharpe: number };
}

interface V2Regime { regime: string; tradeCount: number; sharpe: number; winRate: number; avgPnl: number; maxDD: number; avgHoldDays: number; totalPnl: number }
interface V2Holdout { sharpe: number; winRate: number; maxDD: number; totalPnl: number; tradeCount: number; degradation: number }

interface V2Data {
    wfa: WFAData;
    stats: V2Stats;
    regimes: V2Regime[];
    holdout: V2Holdout;
    bestConfig: Record<string, unknown>;
    v1Comparison?: Record<string, unknown>;
    ranking?: Record<string, unknown>[];
    paretoFrontier?: Record<string, unknown>[];
    totalEvaluations: number;
    elapsedMs: number;
}

function normalizeV2(raw: any): V2Data {
    const trades: Trade[] = (raw.oos?.allTrades ?? []).map((t: any) => ({
        ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
        pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
        exitType: t.exitType, direction: t.direction, entryDelta: t.entryDelta ?? 0,
        entryDTE: t.entryDTE ?? 0, strike: t.strike ?? 0, spreadWidth: t.spreadWidth ?? 10,
    }));

    const equityCurve = (raw.oos?.equityCurve ?? []).map((pt: any) => ({
        date: pt.date, equity: pt.equity,
    }));

    const windows: WFAWindow[] = (raw.oos?.windows ?? []).map((w: any, i: number) => ({
        windowIndex: i,
        trainStart: w.trainStart, trainEnd: w.trainEnd,
        oosStart: w.oosStart, oosEnd: w.oosEnd,
        bestTrainSharpe: w.bestTrainSharpe ?? 0,
        oosSharpe: w.oosSharpe ?? 0,
        oosTrades: [], // v2 windows don't include per-window trade details
        oosWinRate: w.oosWinRate,
        oosTradeCount: w.oosTradeCount ?? w.oosTrades,
        bestConfig: {
            signalWeightPreset: w.bestConfig?.signalWeightPreset ?? 'mom',
            creditProfitTarget: w.bestConfig?.creditProfitTarget ?? 0.30,
            minIVRank: w.bestConfig?.minIVRank ?? 20,
            ...w.bestConfig,
        },
    }));

    const tickers = [...new Set(trades.map(t => t.ticker))] as string[];

    const wfa: WFAData = {
        config: {
            tickers,
            startDate: windows[0]?.trainStart ?? '',
            endDate: windows[windows.length - 1]?.oosEnd ?? '',
            trainWindowDays: 504, forwardStepDays: 126, purgeGapDays: 65,
            startingCapital: 100_000, maxPositions: 10, maxPerTicker: 3,
        },
        windows,
        allOOSTrades: trades,
        oosEquityCurve: equityCurve,
        oosSharpe: raw.oos?.sharpe ?? 0,
        oosWinRate: raw.oos?.winRate ?? 0,
        oosMaxDD: raw.oos?.maxDD ?? 0,
        oosTotalPnl: raw.oos?.totalPnl ?? 0,
        wfEfficiency: raw.oos?.wfEfficiency ?? 0,
        stressMetrics: {
            peakCorrelatedDD: 0, peakCorrelatedDDDate: '', tickersInDDOnWorstDay: 0,
            avgPairwiseCorrelation: 0, worstDayLoss: 0, worstDayLossDate: '',
            correlationPenalty: 0, perTickerDD: {},
        },
    };

    return {
        wfa,
        stats: raw.stats ?? {} as V2Stats,
        regimes: raw.regimes ?? [],
        holdout: raw.holdout ?? { sharpe: 0, winRate: 0, maxDD: 0, totalPnl: 0, tradeCount: 0, degradation: 0 },
        bestConfig: raw.bestConfig ?? {},
        v1Comparison: raw.v1Comparison,
        ranking: raw.ranking,
        paretoFrontier: raw.paretoFrontier,
        totalEvaluations: raw.totalEvaluations ?? 0,
        elapsedMs: raw.elapsedMs ?? 0,
    };
}

const v2SwingData = normalizeV2(wfaV2SwingRaw);
const v2ShortData = normalizeV2(wfaV2ShortRaw);
const v2NoAdxData = normalizeV2(wfaV2NoAdxRaw);
const v2Seed43Data = normalizeV2(wfaV2Seed43Raw);

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
    const [backtestProfile, setBacktestProfile] = useState<'swing' | 'shortTerm'>('swing');
    const profile = getProfile(backtestProfile);
    const isShort = backtestProfile === 'shortTerm';
    const [wfaVersion, setWfaVersion] = useState<'v1' | 'v2'>('v2');
    const [tab, setTab] = useState<'windows' | 'signals' | 'configs' | 'tickers' | 'stress'>('windows');
    const [signalSubTab, setSignalSubTab] = useState<'iv' | 'tier'>('iv');
    const [configSubTab, setConfigSubTab] = useState<'iv' | 'filters' | 'exits'>('iv');
    const [selectedSignalFilter, setSelectedSignalFilter] = useState<string>('all');
    const [exitSignalFilter, setExitSignalFilter] = useState<string>('ema');

    const isV2 = wfaVersion === 'v2';
    const activeV2 = isShort ? v2ShortData : v2SwingData;
    const activeData = isV2 ? activeV2.wfa : (isShort ? wfaShortData : wfaData);

    // When switching to short mode, reset tab if on v1-only tabs
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
    const dataAsOf = config.endDate;
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
                    <div className="flex items-center gap-3">
                        <h2 className="text-2xl font-bold">WFA Results</h2>
                        <div className="flex items-center gap-0.5 rounded-lg bg-white/5 p-0.5">
                            <button onClick={() => setBacktestProfile('swing')} className={`px-2.5 py-1 text-[10px] font-semibold rounded-md transition-colors ${!isShort ? 'bg-emerald-500/20 text-emerald-400' : 'text-text-tertiary hover:text-text-secondary'}`}>Swing</button>
                            <button onClick={() => setBacktestProfile('shortTerm')} className={`px-2.5 py-1 text-[10px] font-semibold rounded-md transition-colors ${isShort ? 'bg-blue-500/20 text-blue-400' : 'text-text-tertiary hover:text-text-secondary'}`}>Short DTE</button>
                        </div>
                        <div className="flex items-center gap-0.5 rounded-lg bg-white/5 p-0.5">
                            <button onClick={() => setWfaVersion('v1')} className={`px-2.5 py-1 text-[10px] font-semibold rounded-md transition-colors ${!isV2 ? 'bg-white/10 text-white' : 'text-text-tertiary hover:text-text-secondary'}`}>v1</button>
                            <button onClick={() => setWfaVersion('v2')} className={`px-2.5 py-1 text-[10px] font-semibold rounded-md transition-colors ${isV2 ? 'bg-white/10 text-white' : 'text-text-tertiary hover:text-text-secondary'}`}>v2</button>
                        </div>
                    </div>
                    <p className="text-text-secondary text-sm mt-0.5">Walk-Forward Analysis{isV2 ? ' v2 (GA optimizer)' : ''} · {config.tickers.length} tickers · {config.startDate} → {config.endDate}</p>
                    <p className={`text-[11px] mt-0.5 font-mono ${isShort ? 'text-blue-400/70' : 'text-emerald-400/70'}`}>{profile.subtitle}</p>
                </div>
                <div className="text-right text-[11px] text-text-tertiary font-mono space-y-0.5">
                    <div>Train {config.trainWindowDays}d · OOS {config.forwardStepDays}d · Purge {config.purgeGapDays}d</div>
                    <div>{activeData.windows.length} windows · $100K start{isV2 ? ` · ${activeV2.totalEvaluations} GA trials` : ''}</div>
                    <div>Static analysis · Data as of {dataAsOf}</div>
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

            {/* v2-only panels */}
            {isV2 && <V2ValidationPanels v2={activeV2} isShort={isShort} />}

            {/* Tabs */}
            <div className="flex gap-1.5 border-b border-[#2A2A2A] pb-3 overflow-x-auto scrollbar-hide">
                <TabBtn active={tab === 'windows'} onClick={() => setTab('windows')}>Windows</TabBtn>
                {!isV2 && !isShort && <TabBtn active={tab === 'signals'} onClick={() => setTab('signals')}>Signals</TabBtn>}
                {!isV2 && !isShort && <TabBtn active={tab === 'configs'} onClick={() => setTab('configs')}>Configs</TabBtn>}
                <TabBtn active={tab === 'tickers'} onClick={() => setTab('tickers')}>Tickers</TabBtn>
                {!isV2 && !isShort && <TabBtn active={tab === 'stress'} onClick={() => setTab('stress')}>Stress</TabBtn>}
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
                                const tradeCount = trades.length || w.oosTradeCount || 0;
                                const wins = trades.filter(t => t.exitType === 'PROFIT_TARGET').length;
                                const wr = w.oosWinRate ?? (trades.length ? wins / trades.length * 100 : 0);
                                return (
                                    <tr key={w.windowIndex} className="border-t border-[#222] hover:bg-white/2 transition-colors">
                                        <td className="py-2.5 pr-3 font-mono text-text-tertiary">W{w.windowIndex}</td>
                                        <td className="py-2.5 pr-3 text-text-secondary font-mono">{fmtPeriod(w.oosStart, w.oosEnd)}</td>
                                        <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{w.bestTrainSharpe.toFixed(2)}</td>
                                        <td className={`py-2.5 pr-3 text-right font-mono font-bold ${sharpeColor(w.oosSharpe)}`}>{w.oosSharpe.toFixed(2)}</td>
                                        <td className={`py-2.5 pr-3 text-right font-mono ${wrColor(wr)}`}>{tradeCount ? `${wr.toFixed(1)}%` : '—'}</td>
                                        <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{tradeCount}</td>
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

// ── Parameter Sensitivity ────────────────────────────────────────────────────

const SENSITIVITY_PARAMS = [
    { key: 'minIVRank', label: 'IV Rank', format: (v: number | string | boolean) => `≥ ${v}%` },
    { key: 'creditShortDelta', label: 'Short Delta', format: (v: number | string | boolean) => (v as number).toFixed(2) },
    { key: 'creditSpreadWidth', label: 'Spread Width', format: (v: number | string | boolean) => `$${v}` },
    { key: 'dirConfTier', label: 'Dir. Confidence', format: (v: number | string | boolean) => String(v) },
    { key: 'creditProfitTarget', label: 'Profit Target', format: (v: number | string | boolean) => `${((v as number) * 100).toFixed(0)}%` },
    { key: 'signalWeightPreset', label: 'Signal Type', format: (v: number | string | boolean) => String(v).toUpperCase() },
    { key: 'maxPositions', label: 'Max Positions', format: (v: number | string | boolean) => String(v) },
    { key: 'maxPerTicker', label: 'Max Per Ticker', format: (v: number | string | boolean) => String(v) },
] as const;

const ParameterSensitivity: React.FC<{ v2: V2Data }> = ({ v2 }) => {
    const [selectedParam, setSelectedParam] = useState<string>(SENSITIVITY_PARAMS[0].key);
    const paramDef = SENSITIVITY_PARAMS.find(p => p.key === selectedParam) ?? SENSITIVITY_PARAMS[0];

    // Combine ranking + pareto for max coverage
    const allConfigs = useMemo(() => {
        const map = new Map<string, { params: Record<string, unknown>; sharpe: number; winRate: number; maxDD: number; wfe: number; tradeCount: number; totalPnl: number; compositeScore: number }>();
        for (const src of [v2.ranking ?? [], v2.paretoFrontier ?? []]) {
            for (const r of src as Array<Record<string, unknown>>) {
                if (r.params && !map.has(r.configId as string)) {
                    map.set(r.configId as string, {
                        params: r.params as Record<string, unknown>,
                        sharpe: r.sharpe as number,
                        winRate: r.winRate as number,
                        maxDD: r.maxDD as number,
                        wfe: r.wfe as number,
                        tradeCount: r.tradeCount as number,
                        totalPnl: r.totalPnl as number,
                        compositeScore: r.compositeScore as number,
                    });
                }
            }
        }
        return [...map.values()];
    }, [v2.ranking, v2.paretoFrontier]);

    // Group by selected parameter
    const groups = useMemo(() => {
        const grouped = new Map<string, typeof allConfigs>();
        for (const cfg of allConfigs) {
            const val = String(cfg.params[selectedParam] ?? '—');
            if (!grouped.has(val)) grouped.set(val, []);
            grouped.get(val)!.push(cfg);
        }
        // Sort: numeric values numerically, strings alphabetically
        const entries = [...grouped.entries()].sort((a, b) => {
            const na = parseFloat(a[0]), nb = parseFloat(b[0]);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            return a[0].localeCompare(b[0]);
        });
        return entries.map(([val, cfgs]) => {
            const n = cfgs.length;
            const avgSharpe = cfgs.reduce((s, c) => s + c.sharpe, 0) / n;
            const avgWR = cfgs.reduce((s, c) => s + c.winRate, 0) / n;
            const avgDD = cfgs.reduce((s, c) => s + c.maxDD, 0) / n;
            const avgWFE = cfgs.reduce((s, c) => s + c.wfe, 0) / n;
            const bestSharpe = Math.max(...cfgs.map(c => c.sharpe));
            const avgTrades = Math.round(cfgs.reduce((s, c) => s + c.tradeCount, 0) / n);
            return { val, n, avgSharpe, avgWR, avgDD, avgWFE, bestSharpe, avgTrades };
        });
    }, [allConfigs, selectedParam]);

    const bestGroup = groups.reduce((best, g) => g.avgSharpe > best.avgSharpe ? g : best, groups[0]);

    // Available params (only show those with 2+ distinct values)
    const availableParams = SENSITIVITY_PARAMS.filter(p => {
        const vals = new Set(allConfigs.map(c => String(c.params[p.key])));
        return vals.size >= 2;
    });

    if (allConfigs.length === 0) return null;

    return (
        <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
            <div className="flex items-center justify-between mb-3">
                <div>
                    <div className="text-sm font-semibold">Parameter Sensitivity</div>
                    <div className="text-[10px] text-text-tertiary">How each parameter value affects performance across {allConfigs.length} tested configurations</div>
                </div>
            </div>

            {/* Parameter Toggle */}
            <div className="flex flex-wrap gap-1.5 mb-4">
                {availableParams.map(p => (
                    <button
                        key={p.key}
                        onClick={() => setSelectedParam(p.key)}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                            selectedParam === p.key
                                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                : 'bg-[#111] text-text-tertiary border border-white/5 hover:text-white hover:border-white/15'
                        }`}
                    >
                        {p.label}
                    </button>
                ))}
            </div>

            {/* Results Table */}
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="text-text-tertiary uppercase tracking-wider text-[10px]">
                            <th className="text-left pb-2 pr-3 font-medium">{paramDef.label}</th>
                            <th className="text-right pb-2 pr-3 font-medium">Configs</th>
                            <th className="text-right pb-2 pr-3 font-medium">Avg Sharpe</th>
                            <th className="text-right pb-2 pr-3 font-medium">Best Sharpe</th>
                            <th className="text-right pb-2 pr-3 font-medium">Avg Win Rate</th>
                            <th className="text-right pb-2 pr-3 font-medium">Avg Max DD</th>
                            <th className="text-right pb-2 pr-3 font-medium">Avg WFE</th>
                            <th className="text-right pb-2 font-medium">Avg Trades</th>
                        </tr>
                    </thead>
                    <tbody className="font-mono">
                        {groups.map(g => {
                            const isBest = g === bestGroup;
                            const prodVal = String((v2.bestConfig as Record<string, unknown>)?.[selectedParam] ?? '');
                            const isProd = g.val === prodVal;
                            return (
                                <tr key={g.val} className={`border-t border-[#222] ${isBest ? 'bg-amber-500/5' : ''}`}>
                                    <td className="py-2.5 pr-3 font-sans">
                                        <span className={`font-medium ${isBest ? 'text-amber-400' : 'text-white'}`}>
                                            {paramDef.format(selectedParam === 'dirConfTier' || selectedParam === 'signalWeightPreset' ? g.val : parseFloat(g.val))}
                                        </span>
                                        {isProd && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400">PROD</span>}
                                        {isBest && !isProd && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400">BEST</span>}
                                    </td>
                                    <td className="py-2.5 pr-3 text-right text-text-tertiary">{g.n}</td>
                                    <td className={`py-2.5 pr-3 text-right font-bold ${g.avgSharpe >= 2 ? 'text-emerald-400' : g.avgSharpe >= 1 ? 'text-yellow-400' : 'text-red-400'}`}>{g.avgSharpe.toFixed(2)}</td>
                                    <td className={`py-2.5 pr-3 text-right ${g.bestSharpe >= 2 ? 'text-emerald-400' : 'text-yellow-400'}`}>{g.bestSharpe.toFixed(2)}</td>
                                    <td className={`py-2.5 pr-3 text-right ${g.avgWR >= 93 ? 'text-emerald-400' : 'text-yellow-400'}`}>{g.avgWR.toFixed(1)}%</td>
                                    <td className={`py-2.5 pr-3 text-right ${g.avgDD < 1.5 ? 'text-emerald-400' : g.avgDD < 3 ? 'text-yellow-400' : 'text-red-400'}`}>{g.avgDD.toFixed(2)}%</td>
                                    <td className={`py-2.5 pr-3 text-right ${g.avgWFE >= 1.5 ? 'text-emerald-400' : 'text-yellow-400'}`}>{g.avgWFE.toFixed(2)}</td>
                                    <td className="py-2.5 text-right text-text-secondary">{g.avgTrades}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Insight */}
            {bestGroup && (
                <div className="mt-3 text-[10px] text-text-tertiary bg-[#111] rounded-lg px-3 py-2 border border-white/5">
                    <strong className="text-amber-400">{paramDef.label} = {paramDef.format(selectedParam === 'dirConfTier' || selectedParam === 'signalWeightPreset' ? bestGroup.val : parseFloat(bestGroup.val))}</strong> has the highest average Sharpe ({bestGroup.avgSharpe.toFixed(2)}) across {bestGroup.n} config{bestGroup.n > 1 ? 's' : ''}.
                    {bestGroup.val === String((v2.bestConfig as Record<string, unknown>)?.[selectedParam] ?? '')
                        ? ' This matches the production config.'
                        : ` Production uses ${paramDef.format((v2.bestConfig as Record<string, unknown>)?.[selectedParam] as number)} — optimized for composite fitness (Sharpe × WFE × trade count × DD), not just Sharpe alone.`
                    }
                </div>
            )}
        </div>
    );
};

// ── v2 Validation Panels ─────────────────────────────────────────────────────

const V2ValidationPanels: React.FC<{ v2: V2Data; isShort: boolean }> = ({ v2, isShort }) => {
    const { stats, regimes, holdout, bestConfig } = v2;
    const bc = bestConfig as Record<string, any>;
    const [analysisTab, setAnalysisTab] = useState<'summary' | 'validation' | 'comparison' | 'deep'>('summary');

    // Robustness & no-ADX data (swing only)
    const noAdx = v2NoAdxData;
    const seed43 = v2Seed43Data;

    return (
        <div className="space-y-4">
            {/* ── Archive notice ── */}
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
                <div className="flex items-center gap-2">
                    <AlertTriangle size={16} className="text-yellow-400" />
                    <span className="text-sm font-semibold text-yellow-400">Archived — Pre-Audit Results</span>
                </div>
                <p className="text-xs text-text-tertiary mt-1">
                    These WFA results were generated before the pricing audit (2026-03-28) and contain phantom expiration profits.
                    Do not use for strategy validation. Current validated strategy: DTE5 sp30/20 bull put (QQQ, EMA34).
                    See <code>backtesting history/credit-spread/reports/spread-comparison/</code> for current analysis.
                </p>
            </div>
            {/* ── Hero: What is this strategy? ── */}
            <div className="bg-gradient-to-br from-emerald-500/5 to-blue-500/5 rounded-xl border border-emerald-500/15 p-4">
                <div className="flex items-center gap-2 mb-2">
                    <Info size={16} className="text-emerald-400" />
                    <span className="text-base font-bold text-white">
                        {isShort ? 'Short-Term Credit Spread Strategy' : 'Swing Credit Spread Strategy'}
                    </span>
                </div>
                <div className="text-xs text-text-secondary space-y-2">
                    <p>
                        <strong className="text-white">What is a credit spread?</strong> You sell one option and buy another further away from the stock price (a "spread").
                        You collect a <em>credit</em> (premium) upfront. If the stock stays within your range by expiration, you keep the premium as profit.
                        Your maximum loss is capped at the spread width minus the credit received — this is "defined risk."
                    </p>
                    <p>
                        <strong className="text-white">How was this optimized?</strong> A genetic algorithm tested <span className="text-white font-mono">{v2.totalEvaluations.toLocaleString()}</span> parameter
                        combinations over <span className="text-white font-mono">{(v2.elapsedMs / 3600000).toFixed(1)}h</span> of compute.
                        It trained on 2 years of historical data, then validated on <em>unseen future data</em> (out-of-sample) to ensure results aren't just curve-fitting.
                        {!isShort && ' Three separate experiments with different random seeds confirmed the same optimal configuration.'}
                    </p>
                    <p className="text-[10px] text-text-tertiary">
                        Data: 15 tickers, {isShort ? '473' : '549'} out-of-sample trades, 10 rolling time windows (2020-2025), 46M option chain rows.
                    </p>
                </div>
            </div>

            {/* ── Analysis Tab Navigation ── */}
            <div className="flex gap-1 overflow-x-auto scrollbar-hide">
                {(['summary', 'validation', ...(isShort ? [] : ['comparison'] as const), 'deep'] as const).map(t => (
                    <button key={t} onClick={() => setAnalysisTab(t)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                            analysisTab === t ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/5 text-text-tertiary hover:text-white'
                        }`}>
                        {t === 'summary' ? 'Strategy Summary' :
                         t === 'validation' ? 'Is It Real?' :
                         t === 'comparison' ? 'Experiments' :
                         'Deep Dive'}
                    </button>
                ))}
            </div>

            {/* ══════════════════════════════════════════════════════════════════════ */}
            {/* TAB: Strategy Summary                                                */}
            {/* ══════════════════════════════════════════════════════════════════════ */}
            {analysisTab === 'summary' && (
                <div className="space-y-4">
                    {/* Production Config Card */}
                    <div className="bg-[#1A1A1A] rounded-xl border border-emerald-500/20 p-4">
                        <div className="flex items-center gap-2 mb-2">
                            <Zap size={14} className="text-emerald-400" />
                            <span className="text-sm font-semibold">
                                {isShort ? 'Short-Term Configuration' : 'Production Configuration'}
                            </span>
                            {!isShort && <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-semibold">LIVE</span>}
                        </div>
                        <p className="text-[11px] text-text-tertiary mb-3">
                            {isShort
                                ? 'Best configuration for weekly credit spreads. High Sharpe from near-zero variance, but small absolute returns ($21/trade avg).'
                                : `Best configuration from latest WFA v2 run — ${(bc.signalWeightPreset ?? 'VOL').toUpperCase()} signal, $${bc.creditSpreadWidth ?? 20} width, dirConfTier=${bc.dirConfTier ?? 'high'}. Currently deployed to live signals.`
                            }
                        </p>
                        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2 text-xs">
                            <ConfigItem label="Signal Type" value={bc.signalWeightPreset?.toUpperCase() ?? '—'} hint={isShort ? 'EMA + Momentum blend for short-term entries' : 'VOL = RVOL + Momentum — volume-confirmed moves without requiring trend strength'} />
                            <ConfigItem label="Spread Width" value={`$${bc.creditSpreadWidth ?? '—'}`} hint={`Distance between your two option strikes. ${isShort ? '$1 = minimal risk per trade, ~$21 avg profit' : '$10 = conservative risk/reward. Wider = more profit but more risk'}`} />
                            <ConfigItem label="Days to Expiry" value={bc.creditDTERange ? `${bc.creditDTERange[0]}\u2013${bc.creditDTERange[1]}d` : '—'} hint={isShort ? 'Short-dated options decay faster = quicker profit but less margin for error' : '45-65 day sweet spot: enough time decay to profit, enough time for the stock to stay in range'} />
                            <ConfigItem label="Short Delta" value={bc.creditShortDelta?.toFixed(2) ?? '—'} hint={`Delta ${bc.creditShortDelta?.toFixed(2) ?? '0.35'} means ~${Math.round((1 - (bc.creditShortDelta ?? 0.35)) * 100)}% chance of profit at entry. Lower delta = safer but less premium collected`} />
                            <ConfigItem label="Take Profit" value={bc.creditProfitTarget ? `${(bc.creditProfitTarget * 100).toFixed(0)}%` : '—'} hint="Close early when this % of max profit is captured. Don't get greedy — locking in gains reduces risk" />
                            <ConfigItem label="IV Rank Min" value={`\u2265 ${bc.minIVRank ?? '—'}%`} hint="Only enter when implied volatility is relatively high (premiums are rich). Higher = pickier but better premiums" />
                            <ConfigItem label="Time Stop" value={`${bc.creditTimeStopDTE ?? '—'}d before exp.`} hint="Close the trade this many days before expiration regardless of profit. Avoids gamma risk near expiry" />
                            <ConfigItem label="Stop Loss" value={bc.creditStopLossMultiple >= 100 ? 'None' : `${bc.creditStopLossMultiple}x`} hint="No stop loss needed — your max loss is already capped by the spread width (defined risk). Adding stops actually hurts returns" />
                            {!isShort && bc.dirConfTier && bc.dirConfTier !== 'any' && <ConfigItem label="Dir. Confidence" value={bc.dirConfTier} hint="Only enter trades when direction confidence meets this threshold. 'high' = strongest filter, avoids false-direction signals" />}
                            <ConfigItem label="Max Positions" value={`${(bc as any).maxPositions ?? 5}`} hint="Maximum simultaneous open trades. Limits how much capital is at risk at any time" />
                        </div>
                    </div>

                    {/* Key Metrics — Plain English */}
                    <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                        <div className="text-sm font-semibold mb-3">What Does This Strategy Actually Do?</div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                            <div className="space-y-1">
                                <div className="text-text-tertiary uppercase text-[10px]">How often it wins</div>
                                <div className={`text-2xl font-mono font-bold ${wrColor(v2.wfa.oosWinRate)}`}>{v2.wfa.oosWinRate.toFixed(1)}%</div>
                                <p className="text-text-secondary">Out of every 100 trades, about {Math.round(v2.wfa.oosWinRate)} are profitable. {v2.wfa.oosWinRate >= 90 ? 'This is excellent — most credit spread strategies aim for 70-80%.' : ''}</p>
                            </div>
                            <div className="space-y-1">
                                <div className="text-text-tertiary uppercase text-[10px]">Worst losing streak</div>
                                <div className="text-2xl font-mono font-bold text-yellow-400">{v2.wfa.oosMaxDD.toFixed(1)}%</div>
                                <p className="text-text-secondary">The deepest your account dropped from peak to trough during testing. {v2.wfa.oosMaxDD < 3 ? 'Under 3% is very manageable.' : 'Moderate — size positions conservatively.'}</p>
                            </div>
                            <div className="space-y-1">
                                <div className="text-text-tertiary uppercase text-[10px]">Risk-adjusted return</div>
                                <div className={`text-2xl font-mono font-bold ${sharpeColor(v2.wfa.oosSharpe)}`}>{v2.wfa.oosSharpe.toFixed(2)}</div>
                                <p className="text-text-secondary">Sharpe ratio measures return per unit of risk. {v2.wfa.oosSharpe >= 2 ? 'Above 2.0 is exceptional — most professional funds target 1.0-1.5.' : v2.wfa.oosSharpe >= 1 ? 'Above 1.0 is good — comparable to professional funds.' : 'Moderate risk-adjusted return.'}</p>
                            </div>
                        </div>
                    </div>

                    {/* How it exits */}
                    <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                        <div className="text-sm font-semibold mb-2">How Trades End</div>
                        <p className="text-[10px] text-text-tertiary mb-3">Every trade exits through one of these three doors. A healthy strategy should have most trades hitting the profit target.</p>
                        <div className="grid grid-cols-3 gap-3 text-xs">
                            {(() => {
                                const exits: Record<string, number> = {};
                                for (const t of v2.wfa.allOOSTrades) exits[t.exitType] = (exits[t.exitType] ?? 0) + 1;
                                const total = v2.wfa.allOOSTrades.length || 1;
                                const exitData = [
                                    { key: 'PROFIT_TARGET', label: 'Hit Profit Target', icon: '\u2714', color: 'emerald', desc: 'Closed early with gains locked in' },
                                    { key: 'TIME_STOP', label: 'Time Stop', icon: '\u23F1', color: 'yellow', desc: 'Closed before expiration to avoid gamma risk' },
                                    { key: 'EXPIRATION', label: 'Expired', icon: '\u23F3', color: 'blue', desc: 'Held to expiration — could be win or loss' },
                                ];
                                return exitData.map(e => {
                                    const count = exits[e.key] ?? 0;
                                    const pct = (count / total * 100);
                                    return (
                                        <div key={e.key} className="bg-[#111] rounded-lg p-3 border border-white/5">
                                            <div className="flex items-center gap-1.5 mb-1">
                                                <span className="text-base">{e.icon}</span>
                                                <span className="font-medium text-white">{e.label}</span>
                                            </div>
                                            <div className={`text-xl font-mono font-bold text-${e.color}-400`}>{pct.toFixed(0)}%</div>
                                            <div className="text-[10px] text-text-tertiary mt-1">{count} trades — {e.desc}</div>
                                        </div>
                                    );
                                });
                            })()}
                        </div>
                    </div>

                    {/* Regime Breakdown */}
                    {regimes.length > 0 && <RegimeTable regimes={regimes} />}

                    {/* Why it works */}
                    <div className="bg-gradient-to-br from-emerald-500/5 to-transparent rounded-xl border border-emerald-500/10 p-4 text-xs text-text-secondary">
                        <div className="font-semibold text-white mb-2">Why Credit Spreads Work</div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div>
                                <div className="font-medium text-emerald-400 mb-1">Time Decay (Theta)</div>
                                <p>Options lose value every day as expiration approaches. As a seller, time works <em>for</em> you — you profit from the passage of time even if the stock doesn't move.</p>
                            </div>
                            <div>
                                <div className="font-medium text-emerald-400 mb-1">Mean Reversion</div>
                                <p>Stocks tend to revert to their average. Extreme moves that would cause losses are statistically rare. The 94%+ win rate reflects this — most of the time, stocks stay within the spread's range.</p>
                            </div>
                            <div>
                                <div className="font-medium text-emerald-400 mb-1">Defined Risk</div>
                                <p>Unlike selling naked options, a credit spread has a fixed maximum loss (spread width minus credit). You always know your worst case <em>before</em> entering the trade.</p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ══════════════════════════════════════════════════════════════════════ */}
            {/* TAB: Is It Real? (Statistical Validation)                            */}
            {/* ══════════════════════════════════════════════════════════════════════ */}
            {analysisTab === 'validation' && (
                <div className="space-y-4">
                    {/* Intro */}
                    <div className="bg-[#111] rounded-xl border border-white/5 p-3 text-xs text-text-secondary">
                        <div className="font-medium text-white mb-1">How do we know this isn't just luck?</div>
                        <p>Any strategy can look good on historical data if you test enough combinations — this is called <em>overfitting</em>.
                        We run multiple statistical tests to check whether the edge is genuine. Think of it like a drug trial:
                        the strategy is the "drug" and these tests check if it actually works or if patients just got better on their own.</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {/* Statistical Tests */}
                        <div className="bg-[#1A1A1A] rounded-xl border border-purple-500/15 p-4">
                            <div className="flex items-center gap-2 mb-1">
                                <Beaker size={14} className="text-purple-400" />
                                <span className="text-sm font-semibold">Statistical Tests</span>
                            </div>
                            <p className="text-[10px] text-text-tertiary mb-3">Each test examines the results from a different angle. Green = passes, red = fails or concerning.</p>
                            <div className="space-y-3 text-xs">
                                {stats.pbo && (
                                    <V2StatRow
                                        label="Probability of Overfitting (PBO)"
                                        value={`${(stats.pbo.pbo * 100).toFixed(1)}%`}
                                        good={stats.pbo.pbo <= 0.1}
                                        warn={stats.pbo.pbo > 0.1 && stats.pbo.pbo <= 0.3}
                                        explain={`Tested ${stats.pbo.nCombinations.toLocaleString()} combinations of in-sample/out-of-sample splits. ${stats.pbo.pbo === 0 ? 'ZERO percent chance of overfitting — the strategy\'s rank ordering is perfectly preserved in held-out data. This is exceptional.' : `${(stats.pbo.pbo * 100).toFixed(0)}% chance the chosen config is overfit. Under 10% is acceptable.`}`}
                                    />
                                )}
                                {stats.dsr && (
                                    <V2StatRow
                                        label="Deflated Sharpe Ratio (DSR)"
                                        value={stats.dsr.dsr.toFixed(4)}
                                        good={stats.dsr.dsr > 0.5}
                                        warn={stats.dsr.dsr > 0 && stats.dsr.dsr <= 0.5}
                                        explain={`After testing ${stats.dsr.nTrials} configs, the expected "best by luck" Sharpe is ${stats.dsr.expectedMaxSR.toFixed(2)}. Our observed Sharpe (${stats.dsr.observedSR.toFixed(2)}) is ${stats.dsr.observedSR > stats.dsr.expectedMaxSR ? 'above' : 'below'} that bar. ${stats.dsr.dsr > 0.5 ? 'Passes — edge survives the data mining penalty.' : stats.dsr.dsr > 0 ? 'Marginal — close to the luck threshold, but positive.' : 'Below threshold — could be data mining.'}`}
                                    />
                                )}
                                {stats.bootstrap?.sharpe && (
                                    <V2StatRow
                                        label="Sharpe 90% Confidence Interval"
                                        value={`${stats.bootstrap.sharpe.ci5.toFixed(2)} \u2013 ${stats.bootstrap.sharpe.ci95.toFixed(2)}`}
                                        good={stats.bootstrap.sharpe.ci5 > 0}
                                        explain={`Bootstrapped 1,000 random resamplings of trade ordering. The Sharpe ratio lands between ${stats.bootstrap.sharpe.ci5.toFixed(2)} and ${stats.bootstrap.sharpe.ci95.toFixed(2)} 90% of the time. ${stats.bootstrap.sharpe.ci5 > 0 ? 'The lower bound is positive — the strategy is profitable even in pessimistic scenarios.' : 'Lower bound crosses zero — there\'s a scenario where it loses money.'}`}
                                    />
                                )}
                                {stats.bootstrap?.maxDD && (
                                    <V2StatRow
                                        label="Max Drawdown 90% CI"
                                        value={`${stats.bootstrap.maxDD.ci5.toFixed(2)}% \u2013 ${stats.bootstrap.maxDD.ci95.toFixed(2)}%`}
                                        good
                                        explain={`Plan for the upper end: in a bad stretch, your account could drop up to ${stats.bootstrap.maxDD.ci95.toFixed(1)}% from its peak before recovering. This helps you size positions so you never risk more than you can handle.`}
                                    />
                                )}
                                {stats.permutation && (
                                    <V2StatRow
                                        label="Permutation p-value"
                                        value={stats.permutation.pValue.toFixed(3)}
                                        good={stats.permutation.pValue <= 0.05}
                                        warn={stats.permutation.pValue > 0.05 && stats.permutation.pValue <= 0.5}
                                        explain={`Shuffled trade returns ${stats.permutation.nPermutations.toLocaleString()} times to see if random ordering produces similar results. ${stats.permutation.pValue > 0.3 ? 'Note: this test is unreliable for credit spreads because most trades are winners regardless of order — it measures sequence dependence (which doesn\'t exist for spreads), not signal quality. Ignore this result.' : stats.permutation.pValue <= 0.05 ? 'Statistically significant — the returns are not random.' : 'Inconclusive.'}`}
                                    />
                                )}
                            </div>
                        </div>

                        {/* Holdout Validation */}
                        <div className="bg-[#1A1A1A] rounded-xl border border-blue-500/15 p-4">
                            <div className="flex items-center gap-2 mb-1">
                                <Shield size={14} className="text-blue-400" />
                                <span className="text-sm font-semibold">Holdout Test (Unseen Data)</span>
                            </div>
                            <p className="text-[10px] text-text-tertiary mb-3">The optimizer never saw this data period. It's the closest thing to live trading performance we can measure before going live.</p>
                            <div className="space-y-3 text-xs">
                                <V2StatRow
                                    label="Holdout Sharpe"
                                    value={holdout.sharpe.toFixed(2)}
                                    good={holdout.sharpe >= 0.5}
                                    warn={holdout.sharpe > 0 && holdout.sharpe < 0.5}
                                    explain={`Risk-adjusted return on data the optimizer never trained on. ${holdout.sharpe >= 1.0 ? 'Above 1.0 is great — the strategy generalizes well.' : holdout.sharpe >= 0.5 ? 'Above 0.5 is acceptable — still profitable on unseen data.' : 'Below 0.5 — the strategy struggles on new data.'} Professional hedge funds target 1.0-1.5.`}
                                />
                                <V2StatRow
                                    label="Holdout Win Rate"
                                    value={`${holdout.winRate.toFixed(1)}%`}
                                    good={holdout.winRate >= 80}
                                    warn={holdout.winRate >= 70 && holdout.winRate < 80}
                                    explain={`${holdout.tradeCount} trades on unseen data, ${Math.round(holdout.winRate)}% profitable. ${holdout.winRate >= 85 ? 'Excellent consistency.' : holdout.winRate >= 75 ? 'Good — slight decline from the optimized period is normal and expected.' : 'Moderate decline from optimized period.'}`}
                                />
                                <V2StatRow
                                    label="Holdout Max Drawdown"
                                    value={`${holdout.maxDD.toFixed(2)}%`}
                                    good={holdout.maxDD < 5}
                                    explain={`Worst peak-to-trough decline on holdout: ${holdout.maxDD.toFixed(1)}%. ${holdout.maxDD < 3 ? 'Very manageable — less than a single bad week in the stock market.' : 'Moderate — use proper position sizing.'}`}
                                />
                                <V2StatRow
                                    label="Holdout P&L"
                                    value={`$${(holdout.totalPnl / 1000).toFixed(1)}K`}
                                    good={holdout.totalPnl > 0}
                                    explain={`Total profit from ${holdout.tradeCount} holdout trades. ${holdout.totalPnl > 0 ? 'Positive — the strategy makes money on unseen data.' : 'Negative — the strategy lost money on the holdout period.'}`}
                                />
                                <V2StatRow
                                    label="Performance Degradation"
                                    value={`${(holdout.degradation * 100).toFixed(0)}%`}
                                    good={holdout.degradation <= 0.5}
                                    warn={holdout.degradation > 0.5 && holdout.degradation <= 0.7}
                                    explain={`The holdout Sharpe is ${(holdout.degradation * 100).toFixed(0)}% lower than the optimized period. ${holdout.degradation <= 0.5 ? 'Under 50% is healthy — some degradation is expected when moving from trained to untrained data.' : 'Significant degradation — the strategy may be partially overfit to the training period.'} Every strategy tested shows ~45% degradation, suggesting this is systematic (market regime shift) rather than strategy-specific.`}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Parameter Stability */}
                    {!isShort && (
                        <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                            <div className="flex items-center gap-2 mb-1">
                                <Layers size={14} className="text-emerald-400" />
                                <span className="text-sm font-semibold">Parameter Stability Across Time</span>
                            </div>
                            <p className="text-[10px] text-text-tertiary mb-3">A robust strategy should find the same "best settings" no matter which time period you train on. If the optimizer picks wildly different settings each window, the results are fragile.</p>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                                {[
                                    { param: 'Delta', value: '0.35', stability: 'Stable across all 10 windows', verdict: 'good' },
                                    { param: 'Width', value: '$10', stability: 'Chosen in 20/26 Pareto configs', verdict: 'good' },
                                    { param: 'Profit Target', value: '30%', stability: 'Unanimous — every window agrees', verdict: 'good' },
                                    { param: 'Stop Loss', value: 'None', stability: 'Every run confirms stops hurt returns', verdict: 'good' },
                                    { param: 'Time Stop', value: '5 DTE', stability: 'Consistent across seeds', verdict: 'good' },
                                    { param: 'IV Rank', value: '\u2265 20%', stability: 'Both seeds found IVR 20', verdict: 'good' },
                                ].map(p => (
                                    <div key={p.param} className="bg-[#111] rounded-lg px-3 py-2 border border-white/5">
                                        <div className="flex items-center justify-between mb-0.5">
                                            <span className="text-text-tertiary">{p.param}</span>
                                            <span className="font-mono font-bold text-white">{p.value}</span>
                                        </div>
                                        <div className="text-[9px] text-emerald-400/70">{p.stability}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Verdict */}
                    <div className="bg-[#111] rounded-xl border border-white/5 p-3 text-xs text-text-secondary">
                        <div className="font-medium text-white mb-1">Bottom Line</div>
                        {isShort ? (
                            <p>The short-term strategy passes all statistical tests with flying colors (DSR=1.000, PBO=0%). However, $1-wide spreads generate only ~$21 per trade. Transaction costs and slippage in live trading could erode a significant % of edge. Best used as a low-risk overlay alongside swing trades, not as a standalone approach.</p>
                        ) : (
                            <p>PBO = 0% is exceptional — zero evidence of overfitting across 5,000 combinations. Perfect parameter stability (identical config across all windows). The ~46% holdout degradation is consistent across <em>all</em> strategies tested (including baselines), pointing to a 2025 market regime shift rather than strategy-specific overfit. The holdout Sharpe of {holdout.sharpe.toFixed(2)} is still positive and profitable.</p>
                        )}
                    </div>
                </div>
            )}

            {/* ══════════════════════════════════════════════════════════════════════ */}
            {/* TAB: Experiments (Swing only)                                        */}
            {/* ══════════════════════════════════════════════════════════════════════ */}
            {analysisTab === 'comparison' && !isShort && (
                <div className="space-y-4">
                    {/* Intro */}
                    <div className="bg-[#111] rounded-xl border border-white/5 p-3 text-xs text-text-secondary">
                        <div className="font-medium text-white mb-1">Four Experiments, One Answer</div>
                        <p>We ran the optimizer four times with different settings. The latest run adds <strong className="text-white">dirConfTier</strong> — a direction confidence filter that only enters trades when the signal's directional conviction is high. It produced the best holdout Sharpe (1.61) and lowest max drawdown (0.88%).</p>
                    </div>

                    {/* Comparison Table */}
                    <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4 overflow-x-auto">
                        <div className="text-sm font-semibold mb-3">Head-to-Head Comparison</div>
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-text-tertiary uppercase tracking-wider">
                                    <th className="text-left pb-2 pr-3 font-medium">Metric</th>
                                    <th className="text-right pb-2 pr-3 font-medium">
                                        <span className="text-amber-400">Latest</span>
                                        <div className="text-[9px] normal-case font-normal">dirConf=high, VOL</div>
                                    </th>
                                    <th className="text-right pb-2 pr-3 font-medium">
                                        <span className="text-blue-400">No-ADX</span>
                                        <div className="text-[9px] normal-case font-normal">ADX removed, VOL</div>
                                    </th>
                                    <th className="text-right pb-2 font-medium">
                                        <span className="text-purple-400">Seed 43</span>
                                        <div className="text-[9px] normal-case font-normal">dirConf=any, VOL</div>
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="font-mono">
                                {[
                                    { label: 'OOS Sharpe', baseline: v2.wfa.oosSharpe, noAdx: noAdx.wfa.oosSharpe, seed43: seed43.wfa.oosSharpe, fmt: (v: number) => v.toFixed(2), colorFn: sharpeColor },
                                    { label: 'Win Rate', baseline: v2.wfa.oosWinRate, noAdx: noAdx.wfa.oosWinRate, seed43: seed43.wfa.oosWinRate, fmt: (v: number) => `${v.toFixed(1)}%`, colorFn: wrColor },
                                    { label: 'Max DD', baseline: v2.wfa.oosMaxDD, noAdx: noAdx.wfa.oosMaxDD, seed43: seed43.wfa.oosMaxDD, fmt: (v: number) => `${v.toFixed(2)}%`, colorFn: (v: number) => v < 1 ? 'text-emerald-400' : v < 2 ? 'text-yellow-400' : 'text-text-secondary' },
                                    { label: 'Total P&L', baseline: v2.wfa.oosTotalPnl, noAdx: noAdx.wfa.oosTotalPnl, seed43: seed43.wfa.oosTotalPnl, fmt: (v: number) => `$${(v / 1000).toFixed(0)}K`, colorFn: (v: number) => v >= 0 ? 'text-emerald-400' : 'text-red-400' },
                                    { label: 'Trades', baseline: v2.wfa.allOOSTrades.length, noAdx: noAdx.wfa.allOOSTrades.length, seed43: seed43.wfa.allOOSTrades.length, fmt: (v: number) => String(v), colorFn: () => 'text-text-secondary' },
                                    { label: 'WF Efficiency', baseline: v2.wfa.wfEfficiency, noAdx: noAdx.wfa.wfEfficiency, seed43: seed43.wfa.wfEfficiency, fmt: (v: number) => v.toFixed(2), colorFn: (v: number) => v >= 1 ? 'text-emerald-400' : 'text-yellow-400' },
                                    { label: 'Holdout Sharpe', baseline: v2.holdout.sharpe, noAdx: noAdx.holdout.sharpe, seed43: seed43.holdout.sharpe, fmt: (v: number) => v.toFixed(2), colorFn: sharpeColor },
                                    { label: 'Holdout Degrad.', baseline: v2.holdout.degradation, noAdx: noAdx.holdout.degradation, seed43: seed43.holdout.degradation, fmt: (v: number) => `${(v * 100).toFixed(0)}%`, colorFn: (v: number) => v <= 0.5 ? 'text-emerald-400' : v <= 0.7 ? 'text-yellow-400' : 'text-red-400' },
                                    { label: 'dirConfTier', baseline: 0, noAdx: 0, seed43: 0, fmt: (_: number, key: string) => key === 'baseline' ? ((v2.bestConfig as any)?.dirConfTier ?? 'high') : 'any', colorFn: (_: number, key?: string) => key === 'baseline' ? 'text-amber-400' : 'text-text-secondary' },
                                    { label: 'Signal', baseline: 0, noAdx: 0, seed43: 0, fmt: (_: number, key: string) => key === 'baseline' ? ((v2.bestConfig as any)?.signalWeightPreset ?? 'VOL').toUpperCase() : 'VOL', colorFn: () => 'text-white' },
                                ].map(row => (
                                    <tr key={row.label} className="border-t border-[#222]">
                                        <td className="py-2 pr-3 text-text-tertiary font-sans">{row.label}</td>
                                        <td className={`py-2 pr-3 text-right font-bold ${row.colorFn(row.baseline, 'baseline')}`}>{row.fmt(row.baseline, 'baseline')}</td>
                                        <td className={`py-2 pr-3 text-right font-bold ${row.colorFn(row.noAdx, 'noAdx')}`}>{row.fmt(row.noAdx, 'noAdx')}</td>
                                        <td className={`py-2 text-right font-bold ${row.colorFn(row.seed43, 'seed43')}`}>{row.fmt(row.seed43, 'seed43')}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Key Findings */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="bg-[#1A1A1A] rounded-xl border border-amber-500/15 p-4">
                            <div className="text-sm font-semibold mb-2 text-amber-400">Finding: Direction Confidence Filter</div>
                            <div className="text-xs text-text-secondary space-y-2">
                                <p><strong className="text-white">What it does:</strong> <code className="text-amber-400">dirConfTier=high</code> requires strong directional conviction before entering a trade. It scores each signal on 7 technical components and only trades when they agree on direction.</p>
                                <p><strong className="text-white">Impact on risk:</strong> Max drawdown dropped from 1.89% to <strong className="text-emerald-400">0.88%</strong> — a 53% reduction. The filter eliminates false-direction signals that caused the worst losses in prior runs.</p>
                                <p><strong className="text-white">Impact on holdout:</strong> Holdout Sharpe jumped from 0.88 to <strong className="text-emerald-400">1.61</strong> — the best generalization of any run. High-confidence signals carry forward to unseen markets.</p>
                            </div>
                        </div>
                        <div className="bg-[#1A1A1A] rounded-xl border border-emerald-500/15 p-4">
                            <div className="text-sm font-semibold mb-2 text-emerald-400">Finding: Trade Structure Is the Edge</div>
                            <div className="text-xs text-text-secondary space-y-2">
                                <p><strong className="text-white">All 4 runs agree</strong> on core structure: Delta 0.35, TP 30%, SL None, Time Stop 5 DTE. The signal type (MOM/VOL) and filters (IV rank, ADX, dirConf) vary — but the spread structure is unanimous.</p>
                                <p><strong className="text-white">Width scaled up:</strong> Latest run selected $20 width (vs prior $10-15), increasing PnL from $57K to $89K while <em>reducing</em> max DD. The dirConf filter makes wider spreads safer.</p>
                                <p><strong className="text-white">IV Rank dropped to 0:</strong> With dirConf=high filtering quality, IV rank became unnecessary — the optimizer removed it entirely. Fewer filters = more trades without sacrificing quality.</p>
                            </div>
                        </div>
                    </div>

                    {/* Production Choice Rationale */}
                    <div className="bg-gradient-to-br from-amber-500/5 to-emerald-500/5 rounded-xl border border-amber-500/10 p-4 text-xs text-text-secondary">
                        <div className="font-semibold text-white mb-2">Why dirConfTier=high Is the Production Config</div>
                        <p className="mb-2">The latest run with direction confidence filtering produced the best risk-adjusted results across all metrics that matter for live trading:</p>
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                            <div className="bg-[#111]/50 rounded-lg px-2.5 py-2 border border-white/5">
                                <div className="text-[9px] text-text-tertiary">Quality Gate</div>
                                <div className="font-mono font-bold text-amber-400">dirConf=high</div>
                                <div className="text-[9px] text-text-tertiary">Replaces IV rank filter</div>
                            </div>
                            <div className="bg-[#111]/50 rounded-lg px-2.5 py-2 border border-white/5">
                                <div className="text-[9px] text-text-tertiary">Signal</div>
                                <div className="font-mono font-bold text-emerald-400">VOL</div>
                                <div className="text-[9px] text-text-tertiary">Volume-confirmed</div>
                            </div>
                            <div className="bg-[#111]/50 rounded-lg px-2.5 py-2 border border-white/5">
                                <div className="text-[9px] text-text-tertiary">Width</div>
                                <div className="font-mono font-bold text-emerald-400">$20</div>
                                <div className="text-[9px] text-text-tertiary">Safe with dirConf gate</div>
                            </div>
                            <div className="bg-[#111]/50 rounded-lg px-2.5 py-2 border border-white/5">
                                <div className="text-[9px] text-text-tertiary">Max DD</div>
                                <div className="font-mono font-bold text-emerald-400">0.88%</div>
                                <div className="text-[9px] text-text-tertiary">Best of all runs</div>
                            </div>
                            <div className="bg-[#111]/50 rounded-lg px-2.5 py-2 border border-white/5">
                                <div className="text-[9px] text-text-tertiary">Holdout SR</div>
                                <div className="font-mono font-bold text-emerald-400">1.61</div>
                                <div className="text-[9px] text-text-tertiary">Best generalization</div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ══════════════════════════════════════════════════════════════════════ */}
            {/* TAB: Deep Dive                                                       */}
            {/* ══════════════════════════════════════════════════════════════════════ */}
            {analysisTab === 'deep' && (
                <div className="space-y-4">
                    {/* Parameter Sensitivity */}
                    {!isShort && <ParameterSensitivity v2={v2} />}

                    {/* v2 vs v1 */}
                    <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                        <div className="text-sm font-semibold mb-1">v2 vs v1: What Changed</div>
                        <p className="text-[10px] text-text-tertiary mb-3">v2 trades quality over quantity — 10x fewer trades but each one is higher quality.</p>
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-text-tertiary uppercase tracking-wider">
                                        <th className="text-left pb-2 pr-3 font-medium">Metric</th>
                                        <th className="text-right pb-2 pr-3 font-medium">v1</th>
                                        <th className="text-right pb-2 pr-3 font-medium">v2</th>
                                        <th className="text-right pb-2 font-medium">Change</th>
                                    </tr>
                                </thead>
                                <tbody className="font-mono">
                                    {[
                                        { label: 'Sharpe', v1: '1.28', v2: v2.wfa.oosSharpe.toFixed(2), change: '+91%', good: true },
                                        { label: 'Win Rate', v1: '89.5%', v2: `${v2.wfa.oosWinRate.toFixed(1)}%`, change: '+5pp', good: true },
                                        { label: 'Max DD', v1: '4.64%', v2: `${v2.wfa.oosMaxDD.toFixed(2)}%`, change: '-62%', good: true },
                                        { label: 'Trades', v1: '5,556', v2: v2.wfa.allOOSTrades.length.toLocaleString(), change: '-90%', good: false },
                                        { label: 'Total P&L', v1: '$613K', v2: `$${(v2.wfa.oosTotalPnl / 1000).toFixed(0)}K`, change: '-91%', good: false },
                                        { label: 'WF Efficiency', v1: '0.89', v2: v2.wfa.wfEfficiency.toFixed(2), change: '+102%', good: true },
                                    ].map(row => (
                                        <tr key={row.label} className="border-t border-[#222]">
                                            <td className="py-2 pr-3 text-text-tertiary font-sans">{row.label}</td>
                                            <td className="py-2 pr-3 text-right text-text-secondary">{row.v1}</td>
                                            <td className="py-2 pr-3 text-right text-white font-bold">{row.v2}</td>
                                            <td className={`py-2 text-right font-bold ${row.good ? 'text-emerald-400' : 'text-yellow-400'}`}>{row.change}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className="text-[10px] text-text-tertiary mt-3">
                            PnL dropped 91% because v2 uses max 5 positions (vs v1's 10) and $10 spreads (vs $15).
                            Per-trade avg PnL is similar: v2 = ${Math.round(v2.wfa.oosTotalPnl / Math.max(1, v2.wfa.allOOSTrades.length))} vs v1 = $110.
                            Scaling v2 to v1's sizing ($15 width, 10 positions) would yield roughly 6x more P&L while keeping the superior risk profile.
                        </p>
                    </div>

                    {/* Exit Type Deep Dive */}
                    {!isShort && (
                        <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
                            <div className="text-sm font-semibold mb-2">Key Insights from WFA Analysis</div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-text-secondary">
                                <div>
                                    <div className="font-medium text-red-400 mb-1">Stop losses destroy returns</div>
                                    <p>Every experiment confirms: adding a stop loss at 2x credit received drops average Sharpe to 0.04 — essentially zero. With defined-risk spreads, the max loss is already capped by the spread width. Tight stops just get triggered by normal volatility before the trade can play out.</p>
                                </div>
                                <div>
                                    <div className="font-medium text-red-400 mb-1">Score-based exits hurt</div>
                                    <p>Exiting when the technical score drops (se50/se60 exits) goes negative OOS. The 94% win rate means most "score drops" recover — exiting on a dip just crystallizes temporary paper losses. Let time decay do the work.</p>
                                </div>
                                <div>
                                    <div className="font-medium text-emerald-400 mb-1">30% take-profit is optimal</div>
                                    <p>Capturing 30% of max profit and moving on outperforms 50% TP, which outperforms holding to expiration. The risk/reward of staying in diminishes rapidly after 30% — you're risking a reversal for small incremental gain.</p>
                                </div>
                                <div>
                                    <div className="font-medium text-emerald-400 mb-1">Direction confidence replaces IV rank</div>
                                    <p>With <code className="text-amber-400">dirConfTier=high</code>, the optimizer dropped IV rank entirely (≥ 0%). High direction confidence provides a stronger quality gate — it filters on signal agreement rather than volatility level, producing the best holdout generalization.</p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Cautionary Notes */}
                    <div className="bg-[#1A1A1A] rounded-xl border border-yellow-500/15 p-4">
                        <div className="flex items-center gap-2 mb-2">
                            <AlertTriangle size={14} className="text-yellow-400" />
                            <span className="text-sm font-semibold">Important Caveats</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-text-secondary">
                            <div>
                                <div className="font-medium text-yellow-400 mb-1">Backtest ≠ Live Trading</div>
                                <p>These results use realistic bid/ask fills and slippage, but live trading adds latency, partial fills, and wider spreads during fast moves. Expect 10-30% lower performance in practice.</p>
                            </div>
                            <div>
                                <div className="font-medium text-yellow-400 mb-1">Regime Dependence</div>
                                <p>The strategy was tested across bull (2020-2021), bear (2022), and recovery (2023-2024) markets. A fundamentally different regime (sustained deflation, liquidity crisis) could behave differently.</p>
                            </div>
                            {isShort && (
                                <div>
                                    <div className="font-medium text-yellow-400 mb-1">Small P&L per Trade</div>
                                    <p>$1-wide spreads generate ~$21/trade average. Transaction costs ($0.65/contract = $1.30/spread) consume ~6% of average profit. The astronomical Sharpe (12.69) comes from near-zero variance, not large absolute returns.</p>
                                </div>
                            )}
                            <div>
                                <div className="font-medium text-yellow-400 mb-1">Position Sizing Matters</div>
                                <p>Results assume $100K capital with max 5 positions. Overleveraging (too many positions or too-wide spreads) amplifies drawdowns proportionally. Stay within the tested position limits.</p>
                            </div>
                        </div>
                    </div>

                    {/* Glossary */}
                    <details className="bg-[#111] rounded-xl border border-white/5">
                        <summary className="p-3 text-xs font-medium text-white cursor-pointer hover:text-emerald-400 transition-colors">
                            Glossary — Key Terms Explained
                        </summary>
                        <div className="px-3 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px] text-text-secondary">
                            {[
                                ['Credit Spread', 'Selling one option and buying another further out-of-the-money. You collect premium upfront and profit if the stock stays within range.'],
                                ['Sharpe Ratio', 'Return divided by risk (volatility). Higher = better risk-adjusted performance. 1.0 = good, 2.0+ = exceptional.'],
                                ['Win Rate', 'Percentage of trades that were profitable. For credit spreads, 80%+ is typical because time decay works in your favor.'],
                                ['Max Drawdown', 'The largest peak-to-trough decline in your account. Lower = less painful losing streaks.'],
                                ['Walk-Forward Analysis', 'Train on past data, test on future data, roll forward. Prevents overfitting by always validating on unseen periods.'],
                                ['IV Rank', 'Where current implied volatility sits relative to its 1-year range. 0% = lowest IV, 100% = highest. Selling options at high IVR = better premiums.'],
                                ['Delta', 'Probability of the option finishing in-the-money. Delta 0.35 = ~65% chance of profit at entry.'],
                                ['DTE', 'Days to expiration. 45-65 DTE captures the steepest part of time decay without being too close to expiration.'],
                                ['Defined Risk', 'Your maximum possible loss is known before entering the trade (spread width - credit received).'],
                                ['Time Stop', 'Closing the trade before expiration to avoid "gamma risk" — the increasing sensitivity of options near expiry.'],
                                ['Theta Decay', 'Options lose value every day. As a seller, this daily erosion is your primary source of profit.'],
                                ['VIX', 'The CBOE Volatility Index — measures expected market volatility over 30 days. Known as the "fear gauge."'],
                            ].map(([term, def]) => (
                                <div key={term}>
                                    <span className="font-medium text-white">{term}:</span> {def}
                                </div>
                            ))}
                        </div>
                    </details>
                </div>
            )}
        </div>
    );
};

const REGIME_INFO: Record<string, { label: string; desc: string; cls: string }> = {
    low:  { label: 'Calm',      desc: 'VIX < 20 — normal markets',         cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
    mid:  { label: 'Elevated',  desc: 'VIX 20–30 — heightened uncertainty', cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
    high: { label: 'Crisis',    desc: 'VIX > 30 — fear / panic',            cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
};

const RegimeTable: React.FC<{ regimes: V2Regime[] }> = ({ regimes }) => (
    <div className="bg-[#1A1A1A] rounded-xl border border-white/5 p-4">
        <div className="flex items-center gap-2 mb-1">
            <Activity size={14} className="text-yellow-400" />
            <span className="text-sm font-semibold">Performance by Market Conditions</span>
        </div>
        <p className="text-[10px] text-text-tertiary mb-3">How the strategy performs under different levels of market fear, measured by the VIX index (the "fear gauge"). A robust strategy should work across all conditions, not just calm markets.</p>
        <div className="overflow-x-auto">
            <table className="w-full text-xs">
                <thead>
                    <tr className="text-text-tertiary uppercase tracking-wider">
                        <th className="text-left pb-2 pr-3 font-medium">Market Condition</th>
                        <th className="text-right pb-2 pr-3 font-medium">Trades</th>
                        <th className="text-right pb-2 pr-3 font-medium">Sharpe</th>
                        <th className="text-right pb-2 pr-3 font-medium">Win Rate</th>
                        <th className="text-right pb-2 pr-3 font-medium">Max DD</th>
                        <th className="text-right pb-2 pr-3 font-medium">Avg Hold</th>
                        <th className="text-right pb-2 font-medium">P&L</th>
                    </tr>
                </thead>
                <tbody>
                    {regimes.map(r => {
                        const regimeInfo = REGIME_INFO[r.regime] ?? { label: r.regime, desc: '', cls: 'bg-white/10 text-white border-white/20' };
                        return (
                            <tr key={r.regime} className="border-t border-[#222] hover:bg-white/2">
                                <td className="py-2.5 pr-3">
                                    <div className="flex items-center gap-2">
                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border whitespace-nowrap ${regimeInfo.cls}`}>
                                            {regimeInfo.label}
                                        </span>
                                        <span className="text-[10px] text-text-tertiary hidden sm:inline">{regimeInfo.desc}</span>
                                    </div>
                                </td>
                                <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{r.tradeCount}</td>
                                <td className={`py-2.5 pr-3 text-right font-mono font-bold ${sharpeColor(r.sharpe)}`}>{r.sharpe.toFixed(2)}</td>
                                <td className={`py-2.5 pr-3 text-right font-mono ${wrColor(r.winRate)}`}>{r.winRate.toFixed(1)}%</td>
                                <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{r.maxDD.toFixed(2)}%</td>
                                <td className="py-2.5 pr-3 text-right font-mono text-text-secondary">{r.avgHoldDays.toFixed(1)}d</td>
                                <td className={`py-2.5 text-right font-mono font-bold ${r.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                    ${(r.totalPnl / 1000).toFixed(1)}K
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
        <p className="text-[10px] text-text-tertiary mt-3">
            VIX (CBOE Volatility Index) measures expected market volatility over the next 30 days. <span className="text-emerald-400">Low VIX ({'<'}20)</span> = calm markets, <span className="text-yellow-400">Mid VIX (20–30)</span> = elevated uncertainty, <span className="text-red-400">High VIX ({'>'}30)</span> = fear/crisis (e.g. COVID crash, tariff shock).
            {regimes.find(r => r.regime === 'high')?.winRate === 100 && ' The strategy performs best in crisis — premium is richest when fear is highest.'}
        </p>
    </div>
);

const V2StatRow: React.FC<{
    label: string; value: string; good: boolean; warn?: boolean; explain: string;
}> = ({ label, value, good, warn, explain }) => (
    <div>
        <div className="flex justify-between items-center">
            <span className="text-text-tertiary">{label}</span>
            <span className={`font-mono font-bold ${good ? 'text-emerald-400' : warn ? 'text-yellow-400' : 'text-red-400'}`}>
                {value}
            </span>
        </div>
        <p className="text-[10px] text-text-tertiary/70 mt-0.5 leading-relaxed">{explain}</p>
    </div>
);

const ConfigItem: React.FC<{ label: string; value: string; hint?: string }> = ({ label, value, hint }) => (
    <div className="bg-[#111] rounded-lg px-2.5 py-1.5 border border-white/5" title={hint}>
        <div className="text-[9px] text-text-tertiary uppercase">{label}</div>
        <div className="font-mono font-bold text-sm text-white">{value}</div>
        {hint && <div className="text-[9px] text-text-tertiary/60 mt-0.5 leading-tight">{hint}</div>}
    </div>
);
