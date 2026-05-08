import React, { useMemo, useState } from 'react';
import {
    BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip,
    ResponsiveContainer, CartesianGrid, Cell, Legend,
} from 'recharts';
import { TrendingUp, Trophy, Shield, Target, FlaskConical, CheckCircle2, XCircle, Layers, AlertTriangle } from 'lucide-react';
import dashboard from '../../data/strategy-dashboard.json';
import { CHART_COLORS, CHART_FONT_MONO, SERIES_PALETTE } from '../lib/chartTheme';

// ── Types ──────────────────────────────────────────────────────────────────

interface Gate {
    name: string;
    actual: number;
    threshold: number;
    pass: boolean;
    fmt: 'ratio' | 'bool';
}

interface Strategy {
    id: 'bcd' | 'pmcc';
    label: string;
    status: string;
    sealedAt: string;
    sealPath: string;
    hypothesis: string;
    spec: {
        underlying: string;
        structure: string;
        longLeg: string;
        shortLeg: string;
        dteRange: string;
        profitTarget: string;
        stopLoss: string;
        cadence: string;
        capitalTier: string;
        riskPerTrade: string;
    };
    oos: { sharpe: number; spyIR: number; spyExcess: number; maxDD: number; trades: number; winRate: number; totalPnl: number };
    holdout: { sharpe: number; spyIR: number; spyExcess: number; trades: number; newTrades: number; ratio: number };
    deflation: { global: number; f0Effective: number; attemptsGlobal: number; attemptsF0Eff: number; stdErr: number };
    stability: { wfEfficiency: number; statConsistencyRatio: number; bootstrapCI: [number, number]; passesStability: boolean; passesStatConsistency: boolean };
    exitBreakdown: Record<string, number>;
    gates: Gate[];
}

interface Dashboard {
    generatedAt: string;
    evidenceCutoffDate: string;
    nextHoldoutRefresh: string;
    liveTradingPolicy: string;
    strategies: Strategy[];
}

const data = dashboard as unknown as Dashboard;

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtPct(v: number, digits = 1): string { return v.toFixed(digits) + '%'; }
function fmtRatio(v: number, digits = 3): string { return v.toFixed(digits); }
function fmt$(v: number): string { return '$' + Math.round(v).toLocaleString(); }

function sharpeColor(s: number): string {
    if (s >= 1.0) return 'text-phosphor-green text-glow-green';
    if (s >= 0.5) return 'text-phosphor-amber text-glow-amber';
    if (s >= 0) return 'text-phosphor-amber';
    return 'text-phosphor-red text-glow-red';
}

function irColor(ir: number): string {
    if (ir >= 0.3) return 'text-phosphor-green text-glow-green';
    if (ir >= 0) return 'text-phosphor-amber text-glow-amber';
    return 'text-phosphor-red text-glow-red';
}

const STRATEGY_COLORS: Record<string, string> = {
    bcd: SERIES_PALETTE[0],
    pmcc: SERIES_PALETTE[1],
};

const EXIT_COLORS: Record<string, string> = {
    PROFIT_TARGET: '#22c55e',
    STOP_LOSS: '#ef4444',
    TIME_STOP: '#eab308',
    FORCE_CLOSE: '#94a3b8',
    DELTA_STOP: '#f97316',
    TRAILING_LOCK: '#3b82f6',
    EXPIRATION: '#a78bfa',
    NO_CHAIN: '#64748b',
    MAX_LOSS_STOP: '#dc2626',
};

type Tab = 'overview' | 'bcd' | 'pmcc';

// ── Subcomponents ──────────────────────────────────────────────────────────

const GateRow: React.FC<{ gate: Gate }> = ({ gate }) => {
    const Icon = gate.pass ? CheckCircle2 : XCircle;
    const cls = gate.pass ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red';
    const valueText = gate.fmt === 'bool' ? (gate.pass ? 'true' : 'false') : fmtRatio(gate.actual, 3);
    return (
        <tr className="border-b border-phosphor-green/10">
            <td className="py-2 px-2"><Icon size={14} className={`${cls} inline-block`} /></td>
            <td className="py-2 px-2 font-mono text-[12px] text-text-secondary">{gate.name}</td>
            <td className={`py-2 px-2 text-right font-mono text-[12px] ${cls}`}>{valueText}</td>
        </tr>
    );
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
    const isPaper = status === 'paper-approved';
    const cls = isPaper
        ? 'bg-phosphor-amber/15 text-phosphor-amber text-glow-amber border-phosphor-amber/40'
        : 'bg-phosphor-green/15 text-phosphor-green text-glow-green border-phosphor-green/40';
    const label = isPaper ? 'PAPER-APPROVED' : status.toUpperCase();
    return (
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wider border ${cls}`}>
            {label}
        </span>
    );
};

const StrategyCard: React.FC<{ s: Strategy; compact?: boolean }> = ({ s, compact }) => {
    const passCount = s.gates.filter(g => g.pass).length;
    return (
        <div className="terminal-panel p-4">
            <div className="flex items-start justify-between mb-3">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <h2 className="text-base font-mono font-bold uppercase tracking-wider" style={{ color: STRATEGY_COLORS[s.id] }}>
                            ▌ {s.label}
                        </h2>
                        <StatusBadge status={s.status} />
                    </div>
                    <p className="text-[11px] text-text-tertiary font-mono uppercase tracking-wider">
                        Sealed {new Date(s.sealedAt).toLocaleDateString()} · {s.spec.capitalTier}
                    </p>
                </div>
                <div className="text-right">
                    <div className="text-[11px] text-text-tertiary font-mono uppercase tracking-wider mb-0.5">Adoption Gates</div>
                    <div className="text-lg font-mono font-bold text-phosphor-green text-glow-green">{passCount}/6 PASS</div>
                </div>
            </div>

            {!compact && <p className="text-[12px] text-text-tertiary mb-3 italic">{s.hypothesis}</p>}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div>
                    <div className="label-mono mb-0.5">▌ HOLDOUT SHARPE</div>
                    <div className={`text-base font-mono font-bold ${sharpeColor(s.holdout.sharpe)}`}>{fmtRatio(s.holdout.sharpe, 2)}</div>
                </div>
                <div>
                    <div className="label-mono mb-0.5">▌ HOLDOUT vs SPY IR</div>
                    <div className={`text-base font-mono font-bold ${irColor(s.holdout.spyIR)}`}>+{fmtRatio(s.holdout.spyIR, 2)}</div>
                </div>
                <div>
                    <div className="label-mono mb-0.5">▌ OOS SHARPE</div>
                    <div className={`text-base font-mono font-bold ${sharpeColor(s.oos.sharpe)}`}>{fmtRatio(s.oos.sharpe, 2)}</div>
                </div>
                <div>
                    <div className="label-mono mb-0.5">▌ dsrM (F0-eff)</div>
                    <div className={`text-base font-mono font-bold ${s.deflation.f0Effective > 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'}`}>
                        +{fmtRatio(s.deflation.f0Effective, 3)}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ── Main Component ─────────────────────────────────────────────────────────

export function BacktestPage() {
    const [activeTab, setActiveTab] = useState<Tab>('overview');

    const bcd = data.strategies.find(s => s.id === 'bcd')!;
    const pmcc = data.strategies.find(s => s.id === 'pmcc')!;

    const TABS: Array<{ key: Tab; label: string; icon: React.ReactNode }> = [
        { key: 'overview', label: 'Overview', icon: <Trophy size={14} /> },
        { key: 'bcd', label: 'BCD QQQ', icon: <Layers size={14} /> },
        { key: 'pmcc', label: 'PMCC QQQ', icon: <Shield size={14} /> },
    ];

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                    <h1 className="text-xl sm:text-2xl font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">▌ WFA_DASHBOARD</h1>
                    <p className="text-[11px] text-text-tertiary font-mono uppercase tracking-wider mt-1">
                        F1 SEALED ADOPTIONS · QQQ-ONLY · PAPER-APPROVED · NEXT REFRESH {data.nextHoldoutRefresh}
                    </p>
                </div>
                <span className="text-[11px] text-phosphor-dim/70 font-mono uppercase tracking-wider">
                    EVIDENCE CUTOFF {data.evidenceCutoffDate}
                </span>
            </div>

            {/* Tab Nav */}
            <div className="flex gap-1 terminal-panel p-1">
                {TABS.map(tab => (
                    <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md transition-colors cursor-pointer ${
                            activeTab === tab.key ? 'bg-phosphor-amber/15 text-phosphor-amber text-glow-amber border border-phosphor-amber/40' : 'text-text-tertiary hover:text-phosphor-dim border border-transparent'
                        }`}
                    >{tab.icon} {tab.label}</button>
                ))}
            </div>

            {/* ══════════ OVERVIEW TAB ══════════ */}
            {activeTab === 'overview' && (
                <div className="space-y-4">
                    {/* Live-trading policy banner */}
                    <div className="terminal-panel p-3 border-l-4 border-phosphor-amber bg-phosphor-amber/5">
                        <div className="flex items-start gap-2">
                            <AlertTriangle size={16} className="text-phosphor-amber text-glow-amber shrink-0 mt-0.5" />
                            <div className="text-[12px] text-text-secondary">
                                Both anchors are <span className="text-phosphor-amber text-glow-amber font-bold">paper-approved</span> only.
                                Live trading blocked under the <span className="font-mono">2026-05-06</span> clean-sheet reset until forward-data review,
                                execution-ticket workflow, risk-manager signoff, and human broker confirmation are complete.
                                See <span className="font-mono text-phosphor-dim">config/strategy-governance.json</span>.
                            </div>
                        </div>
                    </div>

                    {/* Side-by-side strategy cards */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <StrategyCard s={bcd} />
                        <StrategyCard s={pmcc} />
                    </div>

                    {/* Holdout Sharpe + IR comparison */}
                    <div className="terminal-panel p-4">
                        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                            <Target size={14} className="text-phosphor-amber text-glow-amber" /> Holdout Performance vs Selection
                        </h2>
                        <div className="chart-container" style={{ height: 280 }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={data.strategies.map(s => ({
                                    name: s.label,
                                    'OOS Sharpe': Number(s.oos.sharpe.toFixed(3)),
                                    'Holdout Sharpe': Number(s.holdout.sharpe.toFixed(3)),
                                    'Holdout vs SPY IR': Number(s.holdout.spyIR.toFixed(3)),
                                }))}>
                                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: CHART_COLORS.axisText, fontFamily: CHART_FONT_MONO }} />
                                    <YAxis tick={{ fontSize: 10, fill: CHART_COLORS.axisText, fontFamily: CHART_FONT_MONO }} />
                                    <RechartsTooltip contentStyle={{ background: CHART_COLORS.tooltipBg, border: `1px solid ${CHART_COLORS.tooltipBorder}`, borderRadius: 6, fontSize: 12, fontFamily: CHART_FONT_MONO, boxShadow: CHART_COLORS.tooltipShadow }} />
                                    <Legend wrapperStyle={{ fontSize: 11 }} />
                                    <Bar dataKey="OOS Sharpe" fill={SERIES_PALETTE[0]} fillOpacity={0.6} radius={[4, 4, 0, 0]} />
                                    <Bar dataKey="Holdout Sharpe" fill={SERIES_PALETTE[1]} fillOpacity={0.85} radius={[4, 4, 0, 0]} />
                                    <Bar dataKey="Holdout vs SPY IR" fill={SERIES_PALETTE[3]} fillOpacity={0.85} radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                        <p className="text-[11px] text-text-tertiary mt-2 italic">
                            Holdout {'>'} Selection means the anchor held up out-of-sample. Holdout-vs-SPY IR {'>'} 0 means it earned alpha over the naive long-SPY baseline.
                        </p>
                    </div>

                    {/* Methodology note */}
                    <div className="terminal-panel p-4">
                        <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
                            <FlaskConical size={14} className="text-phosphor-green text-glow-green" /> Sealed Adoption Protocol
                        </h2>
                        <ul className="text-[12px] text-text-secondary space-y-1.5 list-disc list-inside">
                            <li>Pre-registration committed to <span className="font-mono">.handoff/current.md</span> <strong>before</strong> the runner executes.</li>
                            <li>Singleton strategy file with a named anchor — no variant search inside the seal.</li>
                            <li>Sealer (<span className="font-mono">scripts/evaluate-holdout.ts</span>) machine-enforces 6 gates: <span className="font-mono">holdoutSpyIR ≥ 0</span>, <span className="font-mono">holdoutSharpe ≥ 0.3</span>, <span className="font-mono">oosSharpe ≥ 0.8</span>, <span className="font-mono">passesStability</span>, <span className="font-mono">passesStatConsistency</span>, <span className="font-mono">deflatedSharpeMertens (F0-eff) {'>'} 0</span>.</li>
                            <li>Phase F0 effective-N counter excludes pre-2026-04-23 trials so dsrM isn't fatally inflated by 100+ historical attempts.</li>
                            <li>DTE5 bull-put credit spread retired 2026-04-24 — sealed FAIL under F0 (window-artifact loss to 2024-2026 QQQ rally). See <span className="font-mono">docs/wfa/CLEAN-SHEET-RESET-2026-05-06.md</span>.</li>
                        </ul>
                    </div>
                </div>
            )}

            {/* ══════════ STRATEGY DETAIL TABS ══════════ */}
            {(activeTab === 'bcd' || activeTab === 'pmcc') && (
                <StrategyDetail s={activeTab === 'bcd' ? bcd : pmcc} />
            )}
        </div>
    );
}

// ── Strategy Detail View ───────────────────────────────────────────────────

const StrategyDetail: React.FC<{ s: Strategy }> = ({ s }) => {
    const exitData = useMemo(() => Object.entries(s.exitBreakdown).map(([type, count]) => ({
        type, count, pct: count / Object.values(s.exitBreakdown).reduce((a, b) => a + b, 0) * 100,
    })), [s]);

    const totalExits = Object.values(s.exitBreakdown).reduce((a, b) => a + b, 0);

    return (
        <div className="space-y-4">
            <StrategyCard s={s} />

            {/* Spec table + Hypothesis */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="terminal-panel p-4">
                    <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                        <Layers size={14} className="text-phosphor-green text-glow-green" /> Strategy Spec
                    </h2>
                    <table className="w-full text-xs">
                        <tbody>
                            <SpecRow label="Underlying" value={s.spec.underlying} />
                            <SpecRow label="Structure" value={s.spec.structure} />
                            <SpecRow label="Long leg" value={s.spec.longLeg} />
                            <SpecRow label="Short leg" value={s.spec.shortLeg} />
                            <SpecRow label="DTE range" value={s.spec.dteRange} />
                            <SpecRow label="Profit target" value={s.spec.profitTarget} />
                            <SpecRow label="Stop loss" value={s.spec.stopLoss} />
                            <SpecRow label="Cadence" value={s.spec.cadence} />
                            <SpecRow label="Capital tier" value={s.spec.capitalTier} />
                            <SpecRow label="Risk per trade" value={s.spec.riskPerTrade} />
                        </tbody>
                    </table>
                </div>

                <div className="terminal-panel p-4">
                    <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                        <FlaskConical size={14} className="text-phosphor-amber text-glow-amber" /> 6-Gate Adoption Verdict
                    </h2>
                    <table className="w-full text-xs">
                        <tbody>
                            {s.gates.map((g, i) => <GateRow key={i} gate={g} />)}
                        </tbody>
                    </table>
                    <div className="mt-3 text-[11px] text-text-tertiary font-mono">
                        Seal: <span className="text-phosphor-dim">{s.sealPath}</span>
                    </div>
                </div>
            </div>

            {/* Selection vs Holdout split */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="terminal-panel p-4">
                    <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                        <Target size={14} className="text-phosphor-green text-glow-green" /> Selection-Period (OOS)
                    </h2>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                        <Metric label="Sharpe" value={fmtRatio(s.oos.sharpe, 3)} cls={sharpeColor(s.oos.sharpe)} />
                        <Metric label="vs SPY IR" value={'+' + fmtRatio(s.oos.spyIR, 3)} cls={irColor(s.oos.spyIR)} />
                        <Metric label="vs SPY Excess" value={fmtPct(s.oos.spyExcess * 100)} />
                        <Metric label="Max DD" value={fmtPct(s.oos.maxDD)} cls={s.oos.maxDD > 30 ? 'text-phosphor-red text-glow-red' : 'text-phosphor-amber'} />
                        <Metric label="Trades" value={String(s.oos.trades)} />
                        <Metric label="Win rate" value={fmtPct(s.oos.winRate)} cls={s.oos.winRate > 50 ? 'text-phosphor-green text-glow-green' : ''} />
                        <Metric label="Total P&L" value={fmt$(s.oos.totalPnl)} cls={s.oos.totalPnl >= 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'} />
                    </div>
                </div>

                <div className="terminal-panel p-4">
                    <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                        <Trophy size={14} className="text-phosphor-amber text-glow-amber" /> Holdout
                    </h2>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                        <Metric label="Sharpe" value={fmtRatio(s.holdout.sharpe, 3)} cls={sharpeColor(s.holdout.sharpe)} />
                        <Metric label="vs SPY IR" value={'+' + fmtRatio(s.holdout.spyIR, 3)} cls={irColor(s.holdout.spyIR)} />
                        <Metric label="vs SPY Excess" value={fmtPct(s.holdout.spyExcess * 100)} />
                        <Metric label="Holdout/OOS Sharpe" value={fmtRatio(s.holdout.ratio, 2)} cls={s.holdout.ratio >= 0.7 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-amber'} />
                        <Metric label="Trades (new)" value={`${s.holdout.trades} (${s.holdout.newTrades})`} />
                        <Metric label="Bootstrap 95% CI" value={`[${s.stability.bootstrapCI[0].toFixed(2)}, ${s.stability.bootstrapCI[1].toFixed(2)}]`} />
                    </div>
                </div>
            </div>

            {/* Exit breakdown + dsrM detail */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="terminal-panel p-4">
                    <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                        <TrendingUp size={14} className="text-phosphor-green text-glow-green" /> Exit Type Breakdown ({totalExits} trades)
                    </h2>
                    <div className="chart-container" style={{ height: 220 }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={exitData} layout="vertical">
                                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                                <XAxis type="number" tick={{ fontSize: 10, fill: CHART_COLORS.axisText, fontFamily: CHART_FONT_MONO }} />
                                <YAxis type="category" dataKey="type" tick={{ fontSize: 10, fill: CHART_COLORS.axisText, fontFamily: CHART_FONT_MONO }} width={110} />
                                <RechartsTooltip contentStyle={{ background: CHART_COLORS.tooltipBg, border: `1px solid ${CHART_COLORS.tooltipBorder}`, borderRadius: 6, fontSize: 12, fontFamily: CHART_FONT_MONO, boxShadow: CHART_COLORS.tooltipShadow }} formatter={(v, _n, p) => {
                                    const pct = (p?.payload as { pct?: number } | undefined)?.pct ?? 0;
                                    return [`${v} (${pct.toFixed(0)}%)`, 'Trades'];
                                }} />
                                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                                    {exitData.map((entry, i) => (
                                        <Cell key={i} fill={EXIT_COLORS[entry.type] || '#6b7280'} fillOpacity={0.85} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                <div className="terminal-panel p-4">
                    <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                        <Shield size={14} className="text-phosphor-amber text-glow-amber" /> Multiple-Testing Deflation
                    </h2>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                        <Metric label="dsrM (global N)" value={fmtRatio(s.deflation.global, 3)} cls={s.deflation.global > 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'} />
                        <Metric label="dsrM (F0-eff N)" value={'+' + fmtRatio(s.deflation.f0Effective, 3)} cls={s.deflation.f0Effective > 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'} />
                        <Metric label="Attempts (global)" value={String(s.deflation.attemptsGlobal)} />
                        <Metric label="Attempts (F0-eff)" value={String(s.deflation.attemptsF0Eff)} />
                        <Metric label="Mertens SE" value={fmtRatio(s.deflation.stdErr, 3)} />
                        <Metric label="WF efficiency" value={fmtRatio(s.stability.wfEfficiency, 2)} cls={s.stability.wfEfficiency > 1 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-amber'} />
                    </div>
                    <p className="text-[11px] text-text-tertiary mt-3 italic">
                        Bailey & López de Prado (2014) deflation. Only the F0-effective N counts toward the gate — the global N includes 100+ pre-clean-slate trials retained for audit only.
                    </p>
                </div>
            </div>
        </div>
    );
};

const SpecRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <tr className="border-b border-phosphor-green/10">
        <td className="py-1.5 px-2 text-text-tertiary font-mono text-[11px] uppercase tracking-wider">{label}</td>
        <td className="py-1.5 px-2 text-right text-text-primary">{value}</td>
    </tr>
);

const Metric: React.FC<{ label: string; value: string; cls?: string }> = ({ label, value, cls }) => (
    <div>
        <div className="label-mono mb-0.5">▌ {label}</div>
        <div className={`text-base font-mono font-bold ${cls || 'text-text-primary'}`}>{value}</div>
    </div>
);
