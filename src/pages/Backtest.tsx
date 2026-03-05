import React, { useState, useMemo } from 'react';
import { FlaskConical, Play, Zap, Pin, X, ChevronDown, ChevronUp, TrendingUp, TrendingDown, Rocket } from 'lucide-react';
import { useBacktest, type BacktestMode } from '../hooks/useBacktest';
import type { BacktestConfig, BacktestResult, BacktestAnalytics, SweepConfig, BacktestTrade, IndicatorSweepParams, OptimizeConfig } from '../lib/backtest/types';
import type { TechScoreOptions } from '../lib/tech-analysis';
import { DEFAULT_SWEEP } from '../lib/backtest/sweep';

// ── Stat Card ───────────────────────────────────────────

const Stat: React.FC<{ label: string; value: string | number; sub?: string; good?: boolean }> = ({ label, value, sub, good }) => (
  <div className="bg-[#1A1A1A] rounded-lg p-3 border border-white/5">
    <div className="text-[11px] text-text-tertiary uppercase tracking-wider">{label}</div>
    <div className={`text-lg font-mono font-bold mt-0.5 ${good === true ? 'text-emerald-400' : good === false ? 'text-red-400' : 'text-white'}`}>
      {value}
    </div>
    {sub && <div className="text-[10px] text-text-tertiary mt-0.5">{sub}</div>}
  </div>
);

// ── Config Panel ────────────────────────────────────────

const SETUPS = ['All', 'Perfect Storm', 'Breakout', 'Pullback Buy', 'Strong Trend', 'Breakdown', 'Failed Rally', 'Strong Down', 'Bullish', 'Bearish'];

// Default indicator values for display
const IND_DEFAULTS: Record<string, number> = {
  w_mb: 30, w_bxs: 25, w_bxl: 20, w_ema: 15, w_mom: 10,
  sc_mb_len: 100, sc_osc_len: 7,
  sc_bx_s1: 5, sc_bx_s2: 20, sc_bx_l1: 20, sc_bx_l2: 15,
};

const ConfigPanel: React.FC<{
  config: BacktestConfig;
  onChange: (c: BacktestConfig) => void;
  mode: BacktestMode;
  onModeChange: (m: BacktestMode) => void;
  onRun: () => void;
  onRunSweep: (s: SweepConfig) => void;
  onRunOptimize: (o: OptimizeConfig) => void;
  loading: boolean;
  progress: number;
}> = ({ config, onChange, mode, onModeChange, onRun, onRunSweep, onRunOptimize, loading, progress }) => {
  const [showIndicators, setShowIndicators] = useState(false);
  const [indicatorSweep, setIndicatorSweep] = useState<IndicatorSweepParams>({});
  const [sweepIndicators, setSweepIndicators] = useState(false);

  const upd = (partial: Partial<BacktestConfig>) => onChange({ ...config, ...partial });
  const updInd = (key: keyof TechScoreOptions, val: number) => {
    onChange({ ...config, indicatorOptions: { ...config.indicatorOptions, [key]: val } });
  };

  const indVal = (key: keyof TechScoreOptions): number =>
    (config.indicatorOptions[key] as number) ?? IND_DEFAULTS[key] ?? 0;

  // Count total sweep combos including indicator sweep
  const tradeCombos = DEFAULT_SWEEP.tpAtrRange.length * DEFAULT_SWEEP.slAtrRange.length *
    DEFAULT_SWEEP.minScoreRange.length * DEFAULT_SWEEP.minConfidenceRange.length;

  const indicatorCombos = sweepIndicators
    ? Object.values(indicatorSweep).reduce((acc, arr) => acc * (arr && arr.length > 0 ? arr.length : 1), 1)
    : 1;

  const totalSweepCombos = tradeCombos * indicatorCombos;

  // GA optimizer: ~1,120 evaluations (40 pop × 30 gen)
  const gaEvals = '~1,120';

  const handleRun = () => {
    if (mode === 'single') {
      onRun();
    } else if (mode === 'sweep') {
      onRunSweep({
        ...DEFAULT_SWEEP,
        ticker: config.ticker,
        startDate: config.startDate,
        endDate: config.endDate,
        timeframe: '1D',
        indicatorSweep: sweepIndicators ? indicatorSweep : undefined,
      });
    } else {
      onRunOptimize({
        ticker: config.ticker,
        startDate: config.startDate,
        endDate: config.endDate,
        tpAtr: config.tpAtr,
        slAtr: config.slAtr,
        minScore: config.minScore,
        minConfidence: config.minConfidence,
        thetaDecayRate: config.thetaDecayRate,
      });
    }
  };

  return (
    <div className="space-y-3">
      {/* Ticker + Dates */}
      <div className="grid grid-cols-3 gap-2">
        <Field label="Ticker" value={config.ticker} onChange={v => upd({ ticker: v.toUpperCase() })} />
        <Field label="Start" value={config.startDate} onChange={v => upd({ startDate: v })} type="date" />
        <Field label="End" value={config.endDate} onChange={v => upd({ endDate: v })} type="date" />
      </div>

      {/* TP/SL */}
      <div className="grid grid-cols-2 gap-2">
        <NumField label="TP (ATR)" value={config.tpAtr} onChange={v => upd({ tpAtr: v })} step={0.5} min={0.5} max={5} />
        <NumField label="SL (ATR)" value={config.slAtr} onChange={v => upd({ slAtr: v })} step={0.5} min={0.5} max={5} />
      </div>

      {/* Score + Confidence */}
      <div className="grid grid-cols-2 gap-2">
        <NumField label="Min Score" value={config.minScore} onChange={v => upd({ minScore: v })} step={5} min={50} max={95} />
        <NumField label="Min Conf" value={config.minConfidence} onChange={v => upd({ minConfidence: v })} step={1} min={0} max={3} />
      </div>

      {/* Direction + Cooldown */}
      <div className="grid grid-cols-2 gap-2">
        <SelectField label="Direction" value={config.directionFilter} options={['ALL', 'CALL', 'PUT']}
          onChange={v => upd({ directionFilter: v as 'ALL' | 'CALL' | 'PUT' })} />
        <NumField label="Cooldown" value={config.cooldownBars} onChange={v => upd({ cooldownBars: v })} step={1} min={1} max={50} />
      </div>

      {/* Time Stop + Decay */}
      <div className="grid grid-cols-2 gap-2">
        <NumField label="Time Stop" value={config.timeStopBars} onChange={v => upd({ timeStopBars: v })} step={1} min={5} max={60} />
        <NumField label="Theta Decay" value={config.thetaDecayRate} onChange={v => upd({ thetaDecayRate: v })} step={0.01} min={0} max={0.1} />
      </div>

      {/* Setups */}
      <div>
        <label className="text-[11px] text-text-tertiary uppercase block mb-1">Setups</label>
        <div className="flex flex-wrap gap-1">
          {SETUPS.map(s => {
            const active = config.allowedSetups.includes(s) || (s === 'All' && config.allowedSetups.includes('All'));
            return (
              <button key={s} onClick={() => {
                if (s === 'All') {
                  upd({ allowedSetups: ['All'] });
                } else {
                  const current = config.allowedSetups.filter(x => x !== 'All');
                  const next = current.includes(s) ? current.filter(x => x !== s) : [...current, s];
                  upd({ allowedSetups: next.length === 0 ? ['All'] : next });
                }
              }}
                className={`px-2 py-0.5 rounded text-[11px] border transition-colors ${
                  active ? 'bg-accent-green/20 border-accent-green/40 text-accent-green' : 'bg-transparent border-white/10 text-text-tertiary hover:border-white/20'
                }`}
              >{s}</button>
            );
          })}
        </div>
      </div>

      {/* Entry Quality */}
      <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
        <input type="checkbox" checked={config.useEntryQualityAdjust}
          onChange={e => upd({ useEntryQualityAdjust: e.target.checked })}
          className="accent-accent-green" />
        Entry quality adjustment
      </label>

      {/* Indicator Tuning (single mode only) */}
      {mode === 'single' && (
        <div>
          <button onClick={() => setShowIndicators(!showIndicators)}
            className="flex items-center gap-1 text-sm text-text-secondary hover:text-white w-full py-1">
            {showIndicators ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            Indicator Params
          </button>
          {showIndicators && (
            <div className="space-y-2 mt-1">
              <div className="text-[10px] text-text-tertiary">Component Weights (must sum to 100)</div>
              <div className="grid grid-cols-5 gap-1">
                {(['w_mb', 'w_bxs', 'w_bxl', 'w_ema', 'w_mom'] as const).map(k => (
                  <div key={k}>
                    <label className="text-[9px] text-text-tertiary uppercase block">{k.replace('w_', '')}</label>
                    <input type="number" value={indVal(k)} onChange={e => updInd(k, Number(e.target.value))}
                      step={5} min={0} max={60}
                      className="w-full bg-[#111] border border-white/10 rounded px-1 py-1 text-[11px] text-white font-mono focus:border-accent-green/50 focus:outline-none" />
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-text-tertiary">Criteria Periods</div>
              <div className="grid grid-cols-3 gap-1">
                <div>
                  <label className="text-[9px] text-text-tertiary block">MB Len</label>
                  <input type="number" value={indVal('sc_mb_len')} onChange={e => updInd('sc_mb_len', Number(e.target.value))}
                    step={10} min={20} max={200}
                    className="w-full bg-[#111] border border-white/10 rounded px-1 py-1 text-[11px] text-white font-mono focus:border-accent-green/50 focus:outline-none" />
                </div>
                <div>
                  <label className="text-[9px] text-text-tertiary block">Osc Len</label>
                  <input type="number" value={indVal('sc_osc_len')} onChange={e => updInd('sc_osc_len', Number(e.target.value))}
                    step={1} min={3} max={20}
                    className="w-full bg-[#111] border border-white/10 rounded px-1 py-1 text-[11px] text-white font-mono focus:border-accent-green/50 focus:outline-none" />
                </div>
                <div>
                  <label className="text-[9px] text-text-tertiary block">BXS p1</label>
                  <input type="number" value={indVal('sc_bx_s1')} onChange={e => updInd('sc_bx_s1', Number(e.target.value))}
                    step={1} min={2} max={15}
                    className="w-full bg-[#111] border border-white/10 rounded px-1 py-1 text-[11px] text-white font-mono focus:border-accent-green/50 focus:outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(['sc_bx_s2', 'sc_bx_l1', 'sc_bx_l2'] as const).map(k => (
                  <div key={k}>
                    <label className="text-[9px] text-text-tertiary block">{k.replace('sc_bx_', 'BX ')}</label>
                    <input type="number" value={indVal(k)} onChange={e => updInd(k, Number(e.target.value))}
                      step={5} min={5} max={50}
                      className="w-full bg-[#111] border border-white/10 rounded px-1 py-1 text-[11px] text-white font-mono focus:border-accent-green/50 focus:outline-none" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Mode Toggle */}
      <div className="flex gap-1 bg-[#111] rounded-lg p-0.5">
        {(['single', 'sweep', 'optimize'] as BacktestMode[]).map(m => (
          <button key={m} onClick={() => onModeChange(m)}
            className={`flex-1 py-1.5 rounded text-[12px] font-medium transition-colors ${
              mode === m ? 'bg-[#2A2A2A] text-white' : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >{m === 'single' ? 'Single' : m === 'sweep' ? 'Sweep' : 'Optimize'}</button>
        ))}
      </div>

      {/* Mode description */}
      <div className="text-[10px] text-text-tertiary">
        {mode === 'single' && 'Run one backtest with current settings'}
        {mode === 'sweep' && `Sweep ${totalSweepCombos} TP/SL combos`}
        {mode === 'optimize' && `GA optimizer: evolve ${gaEvals} configs across 30 generations to find the best signal weights & periods`}
      </div>

      {/* Sweep: indicator sweep toggle */}
      {mode === 'sweep' && (
        <div className="border-t border-white/5 pt-2">
          <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
            <input type="checkbox" checked={sweepIndicators}
              onChange={e => setSweepIndicators(e.target.checked)}
              className="accent-accent-green" />
            Also sweep indicator params
          </label>
          {sweepIndicators && (
            <div className="mt-2 space-y-1">
              <div className="text-[10px] text-text-tertiary">Comma-separated values to try</div>
              {[
                { key: 'w_mb' as const, label: 'MB weight', placeholder: '25,30,35' },
                { key: 'w_bxs' as const, label: 'BXS weight', placeholder: '20,25,30' },
                { key: 'sc_mb_len' as const, label: 'MB length', placeholder: '60,80,100' },
                { key: 'sc_osc_len' as const, label: 'Osc length', placeholder: '5,7,10' },
              ].map(({ key, label, placeholder }) => (
                <div key={key} className="flex items-center gap-2">
                  <label className="text-[10px] text-text-tertiary w-16 shrink-0">{label}</label>
                  <input
                    type="text"
                    placeholder={placeholder}
                    value={(indicatorSweep[key] ?? []).join(',')}
                    onChange={e => {
                      const vals = e.target.value.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n) && n > 0);
                      setIndicatorSweep(prev => ({ ...prev, [key]: vals.length > 0 ? vals : undefined }));
                    }}
                    className="flex-1 bg-[#111] border border-white/10 rounded px-1.5 py-0.5 text-[11px] text-white font-mono focus:border-accent-green/50 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Run Button */}
      <button onClick={handleRun} disabled={loading}
        className={`w-full py-2.5 rounded-lg font-medium text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-50 ${
          mode === 'optimize'
            ? 'bg-purple-500 text-white hover:bg-purple-400'
            : 'bg-accent-green text-black hover:bg-accent-green/90'
        }`}
      >
        {loading ? (
          <><Zap size={16} className="animate-pulse" /> {mode === 'optimize' ? 'Optimizing' : 'Running'}... {progress}%</>
        ) : mode === 'single' ? (
          <><Play size={16} /> Run Backtest</>
        ) : mode === 'sweep' ? (
          <><Zap size={16} /> Run Sweep ({totalSweepCombos} combos)</>
        ) : (
          <><Rocket size={16} /> Optimize Signals (GA)</>
        )}
      </button>
    </div>
  );
};

// ── Field Components ────────────────────────────────────

const Field: React.FC<{ label: string; value: string; onChange: (v: string) => void; type?: string }> = ({ label, value, onChange, type }) => (
  <div>
    <label className="text-[11px] text-text-tertiary uppercase block mb-1">{label}</label>
    <input type={type || 'text'} value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
  </div>
);

const NumField: React.FC<{ label: string; value: number; onChange: (v: number) => void; step: number; min: number; max: number }> = ({ label, value, onChange, step, min, max }) => (
  <div>
    <label className="text-[11px] text-text-tertiary uppercase block mb-1">{label}</label>
    <input type="number" value={value} onChange={e => onChange(Number(e.target.value))} step={step} min={min} max={max}
      className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
  </div>
);

const SelectField: React.FC<{ label: string; value: string; options: string[]; onChange: (v: string) => void }> = ({ label, value, options, onChange }) => (
  <div>
    <label className="text-[11px] text-text-tertiary uppercase block mb-1">{label}</label>
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none">
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  </div>
);

// ── Analytics Display ───────────────────────────────────

const AnalyticsGrid: React.FC<{ a: BacktestAnalytics }> = ({ a }) => (
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
    <Stat label="Trades" value={a.totalTrades} sub={`${a.totalSignals} signals`} />
    <Stat label="Win Rate" value={`${a.winRate.toFixed(1)}%`} good={a.winRate > 50} sub={`θ: ${a.winRateTheta.toFixed(1)}%`} />
    <Stat label="Avg Return" value={`${a.avgReturn >= 0 ? '+' : ''}${a.avgReturn.toFixed(2)}%`} good={a.avgReturn > 0} sub={`θ: ${a.avgReturnTheta.toFixed(2)}%`} />
    <Stat label="Profit Factor" value={a.profitFactor === Infinity ? '∞' : a.profitFactor.toFixed(2)} good={a.profitFactor > 1.5} />
    <Stat label="Sharpe" value={a.sharpe.toFixed(2)} good={a.sharpe > 1} />
    <Stat label="Max DD" value={`${a.maxDrawdown.toFixed(1)}%`} good={a.maxDrawdown < 10} />
    <Stat label="Avg Win" value={`+${a.avgWin.toFixed(2)}%`} good />
    <Stat label="Avg Loss" value={`${a.avgLoss.toFixed(2)}%`} good={false} />
    <Stat label="Avg Hold" value={`${a.avgHoldDays.toFixed(1)}d`} />
    <Stat label="TP Hits" value={a.tpHits} sub={`${a.totalTrades > 0 ? ((a.tpHits / a.totalTrades) * 100).toFixed(0) : 0}%`} />
    <Stat label="SL Hits" value={a.slHits} sub={`${a.totalTrades > 0 ? ((a.slHits / a.totalTrades) * 100).toFixed(0) : 0}%`} />
    <Stat label="Time Stops" value={a.timeStops} sub={`${a.totalTrades > 0 ? ((a.timeStops / a.totalTrades) * 100).toFixed(0) : 0}%`} />
  </div>
);

// ── Equity Curve (SVG) ──────────────────────────────────

const EquityCurveSVG: React.FC<{ curves: { data: { date: string; cumReturn: number }[]; color: string; label: string }[] }> = ({ curves }) => {
  const W = 600, H = 200, PAD = 30;

  const allPoints = curves.flatMap(c => c.data);
  if (allPoints.length === 0) return <div className="text-text-tertiary text-sm">No trades yet</div>;

  const minY = Math.min(0, ...allPoints.map(p => p.cumReturn));
  const maxY = Math.max(0, ...allPoints.map(p => p.cumReturn));
  const rangeY = maxY - minY || 1;

  const scaleX = (i: number, total: number) => PAD + (i / Math.max(total - 1, 1)) * (W - 2 * PAD);
  const scaleY = (v: number) => H - PAD - ((v - minY) / rangeY) * (H - 2 * PAD);

  const zeroY = scaleY(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      <line x1={PAD} x2={W - PAD} y1={zeroY} y2={zeroY} stroke="#333" strokeDasharray="4" />
      <text x={PAD - 4} y={zeroY + 3} fontSize="9" fill="#666" textAnchor="end">0%</text>
      <text x={PAD - 4} y={scaleY(maxY) + 3} fontSize="9" fill="#666" textAnchor="end">{maxY.toFixed(1)}%</text>
      <text x={PAD - 4} y={scaleY(minY) + 3} fontSize="9" fill="#666" textAnchor="end">{minY.toFixed(1)}%</text>

      {curves.map((curve, ci) => {
        if (curve.data.length < 2) return null;
        const path = curve.data.map((p, i) =>
          `${i === 0 ? 'M' : 'L'} ${scaleX(i, curve.data.length).toFixed(1)} ${scaleY(p.cumReturn).toFixed(1)}`
        ).join(' ');
        return <path key={ci} d={path} fill="none" stroke={curve.color} strokeWidth="1.5" opacity="0.9" />;
      })}

      {curves.length > 1 && curves.map((c, i) => (
        <g key={i}>
          <rect x={PAD + i * 120} y={4} width={10} height={10} fill={c.color} rx={2} />
          <text x={PAD + i * 120 + 14} y={12} fontSize="9" fill="#aaa">{c.label}</text>
        </g>
      ))}
    </svg>
  );
};

// ── Setup Breakdown ─────────────────────────────────────

const SetupBreakdown: React.FC<{ bySetup: Record<string, { count: number; winRate: number; avgReturn: number; avgReturnTheta: number; avgHoldDays: number; tpHits: number; slHits: number; timeStops: number }> }> = ({ bySetup }) => {
  const entries = Object.entries(bySetup).sort((a, b) => b[1].count - a[1].count);
  if (entries.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-text-tertiary text-[11px] uppercase">
            <th className="text-left py-1 px-2">Setup</th>
            <th className="text-right py-1 px-2">N</th>
            <th className="text-right py-1 px-2">Win%</th>
            <th className="text-right py-1 px-2">Avg Ret</th>
            <th className="text-right py-1 px-2">θ Ret</th>
            <th className="text-right py-1 px-2">Hold</th>
            <th className="text-right py-1 px-2">TP</th>
            <th className="text-right py-1 px-2">SL</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([name, s]) => (
            <tr key={name} className="border-t border-white/5">
              <td className="py-1.5 px-2 font-medium">{name}</td>
              <td className="text-right py-1.5 px-2 font-mono">{s.count}</td>
              <td className={`text-right py-1.5 px-2 font-mono ${s.winRate > 50 ? 'text-emerald-400' : 'text-red-400'}`}>{s.winRate.toFixed(0)}%</td>
              <td className={`text-right py-1.5 px-2 font-mono ${s.avgReturn > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{s.avgReturn >= 0 ? '+' : ''}{s.avgReturn.toFixed(2)}%</td>
              <td className={`text-right py-1.5 px-2 font-mono ${s.avgReturnTheta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{s.avgReturnTheta >= 0 ? '+' : ''}{s.avgReturnTheta.toFixed(2)}%</td>
              <td className="text-right py-1.5 px-2 font-mono text-text-tertiary">{s.avgHoldDays.toFixed(0)}d</td>
              <td className="text-right py-1.5 px-2 font-mono text-emerald-400/60">{s.tpHits}</td>
              <td className="text-right py-1.5 px-2 font-mono text-red-400/60">{s.slHits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ── MFE/MAE Table ───────────────────────────────────────

const MfeTable: React.FC<{ avgMfe: Record<number, number>; avgMae: Record<number, number> }> = ({ avgMfe, avgMae }) => {
  const windows = Object.keys(avgMfe).map(Number).sort((a, b) => a - b);
  if (windows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-text-tertiary text-[11px] uppercase">
            <th className="text-left py-1 px-2">Window</th>
            {windows.map(w => <th key={w} className="text-right py-1 px-2">{w}d</th>)}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-white/5">
            <td className="py-1.5 px-2 text-emerald-400">MFE</td>
            {windows.map(w => (
              <td key={w} className="text-right py-1.5 px-2 font-mono text-emerald-400">+{avgMfe[w]?.toFixed(2) ?? '—'}%</td>
            ))}
          </tr>
          <tr className="border-t border-white/5">
            <td className="py-1.5 px-2 text-red-400">MAE</td>
            {windows.map(w => (
              <td key={w} className="text-right py-1.5 px-2 font-mono text-red-400">{avgMae[w]?.toFixed(2) ?? '—'}%</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
};

// ── Trade Log ───────────────────────────────────────────

const TradeLog: React.FC<{ trades: BacktestTrade[] }> = ({ trades }) => {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? trades : trades.slice(0, 20);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-tertiary text-[10px] uppercase">
              <th className="text-left py-1 px-1.5">Entry</th>
              <th className="text-left py-1 px-1.5">Dir</th>
              <th className="text-left py-1 px-1.5">Setup</th>
              <th className="text-right py-1 px-1.5">Score</th>
              <th className="text-left py-1 px-1.5">EQ</th>
              <th className="text-right py-1 px-1.5">Entry$</th>
              <th className="text-right py-1 px-1.5">Exit$</th>
              <th className="text-left py-1 px-1.5">Exit</th>
              <th className="text-right py-1 px-1.5">Hold</th>
              <th className="text-right py-1 px-1.5">Return</th>
              <th className="text-right py-1 px-1.5">θ Ret</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t, i) => (
              <tr key={i} className="border-t border-white/5 hover:bg-white/5">
                <td className="py-1 px-1.5 font-mono">{t.entryDate}</td>
                <td className={`py-1 px-1.5 ${t.direction === 'CALL' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {t.direction === 'CALL' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                </td>
                <td className="py-1 px-1.5">{t.setup}</td>
                <td className="py-1 px-1.5 text-right font-mono">{t.score.toFixed(0)}</td>
                <td className="py-1 px-1.5">
                  <span className={`text-[10px] px-1 rounded ${
                    t.entryQuality === 'OPTIMAL' ? 'bg-emerald-500/20 text-emerald-400' :
                    t.entryQuality === 'ACCEPTABLE' ? 'bg-blue-500/20 text-blue-400' :
                    t.entryQuality === 'MARGINAL' ? 'bg-yellow-500/20 text-yellow-400' :
                    'bg-red-500/20 text-red-400'
                  }`}>{t.entryQuality.slice(0, 3)}</span>
                </td>
                <td className="py-1 px-1.5 text-right font-mono">${t.entryPrice.toFixed(2)}</td>
                <td className="py-1 px-1.5 text-right font-mono">${t.exitPrice.toFixed(2)}</td>
                <td className={`py-1 px-1.5 ${t.exitType === 'TP' ? 'text-emerald-400' : t.exitType === 'SL' ? 'text-red-400' : 'text-yellow-400'}`}>
                  {t.exitType}
                </td>
                <td className="py-1 px-1.5 text-right font-mono text-text-tertiary">{t.holdDays}d</td>
                <td className={`py-1 px-1.5 text-right font-mono ${t.rawReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {(t.rawReturn * 100).toFixed(2)}%
                </td>
                <td className={`py-1 px-1.5 text-right font-mono ${t.thetaAdjReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {(t.thetaAdjReturn * 100).toFixed(2)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {trades.length > 20 && (
        <button onClick={() => setExpanded(!expanded)} className="text-sm text-accent-green mt-2 flex items-center gap-1">
          {expanded ? <><ChevronUp size={14} /> Show less</> : <><ChevronDown size={14} /> Show all {trades.length} trades</>}
        </button>
      )}
    </div>
  );
};

// ── Indicator Params Display ────────────────────────────

const IndicatorParamsLabel: React.FC<{ opts: TechScoreOptions }> = ({ opts }) => {
  const entries = Object.entries(opts).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return <span className="text-text-tertiary">defaults</span>;
  return (
    <span className="text-[10px] font-mono text-purple-300">
      {entries.map(([k, v]) => `${k}=${v}`).join(' ')}
    </span>
  );
};

// ── Optimize Results Table ──────────────────────────────

const OptimizeTable: React.FC<{
  results: BacktestResult[];
  onSelect: (r: BacktestResult) => void;
  best: BacktestResult | null;
}> = ({ results, onSelect, best }) => {
  const [sortKey, setSortKey] = useState<'sharpe' | 'winRate' | 'pf' | 'trades'>('sharpe');

  const sorted = useMemo(() => {
    const arr = [...results].filter(r => r.analytics.totalTrades >= 3);
    switch (sortKey) {
      case 'sharpe': return arr.sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
      case 'winRate': return arr.sort((a, b) => b.analytics.winRateTheta - a.analytics.winRateTheta);
      case 'pf': return arr.sort((a, b) => b.analytics.profitFactor - a.analytics.profitFactor);
      case 'trades': return arr.sort((a, b) => b.analytics.totalTrades - a.analytics.totalTrades);
    }
  }, [results, sortKey]);

  const isBest = (r: BacktestResult) => best && JSON.stringify(r.config.indicatorOptions) === JSON.stringify(best.config.indicatorOptions);

  const SortBtn: React.FC<{ k: typeof sortKey; label: string }> = ({ k, label }) => (
    <button onClick={() => setSortKey(k)}
      className={`text-[10px] px-1.5 py-0.5 rounded ${sortKey === k ? 'bg-purple-500/20 text-purple-400' : 'text-text-tertiary hover:text-white'}`}
    >{label}</button>
  );

  return (
    <div>
      <div className="flex gap-1 mb-2">
        <SortBtn k="sharpe" label="Sharpe" />
        <SortBtn k="winRate" label="Win%" />
        <SortBtn k="pf" label="PF" />
        <SortBtn k="trades" label="Trades" />
      </div>
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#1A1A1A]">
            <tr className="text-text-tertiary text-[10px] uppercase">
              <th className="text-left py-1 px-1.5">Indicator Config</th>
              <th className="text-right py-1 px-1.5">N</th>
              <th className="text-right py-1 px-1.5">Win%</th>
              <th className="text-right py-1 px-1.5">Sharpe</th>
              <th className="text-right py-1 px-1.5">PF</th>
              <th className="text-right py-1 px-1.5">DD</th>
              <th className="text-right py-1 px-1.5">Hold</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 100).map((r, i) => (
              <tr key={i}
                className={`border-t border-white/5 cursor-pointer hover:bg-white/5 ${isBest(r) ? 'bg-purple-500/10' : ''}`}
                onClick={() => onSelect(r)}
              >
                <td className="py-1 px-1.5"><IndicatorParamsLabel opts={r.config.indicatorOptions} /></td>
                <td className="text-right py-1 px-1.5 font-mono">{r.analytics.totalTrades}</td>
                <td className={`text-right py-1 px-1.5 font-mono ${r.analytics.winRateTheta > 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {r.analytics.winRateTheta.toFixed(0)}%
                </td>
                <td className={`text-right py-1 px-1.5 font-mono ${r.analytics.sharpe > 1 ? 'text-emerald-400' : r.analytics.sharpe > 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {r.analytics.sharpe.toFixed(2)}
                </td>
                <td className={`text-right py-1 px-1.5 font-mono ${r.analytics.profitFactor > 1.5 ? 'text-emerald-400' : 'text-text-tertiary'}`}>
                  {r.analytics.profitFactor === Infinity ? '∞' : r.analytics.profitFactor.toFixed(1)}
                </td>
                <td className="text-right py-1 px-1.5 font-mono text-red-400/60">{r.analytics.maxDrawdown.toFixed(1)}%</td>
                <td className="text-right py-1 px-1.5 font-mono text-text-tertiary">{r.analytics.avgHoldDays.toFixed(0)}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Sweep Results Table (trade params) ──────────────────

const SweepTable: React.FC<{
  results: BacktestResult[];
  pinned: BacktestResult[];
  onPin: (r: BacktestResult) => void;
  onSelect: (r: BacktestResult) => void;
  best: BacktestResult | null;
}> = ({ results, pinned, onPin, onSelect, best }) => {
  const [sortKey, setSortKey] = useState<'sharpe' | 'winRate' | 'pf' | 'dd'>('sharpe');

  const sorted = useMemo(() => {
    const arr = [...results].filter(r => r.analytics.totalTrades >= 3);
    switch (sortKey) {
      case 'sharpe': return arr.sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
      case 'winRate': return arr.sort((a, b) => b.analytics.winRateTheta - a.analytics.winRateTheta);
      case 'pf': return arr.sort((a, b) => b.analytics.profitFactor - a.analytics.profitFactor);
      case 'dd': return arr.sort((a, b) => a.analytics.maxDrawdown - b.analytics.maxDrawdown);
    }
  }, [results, sortKey]);

  const isPinned = (r: BacktestResult) => pinned.some(p =>
    p.config.tpAtr === r.config.tpAtr && p.config.slAtr === r.config.slAtr && p.config.minScore === r.config.minScore
  );
  const isBest = (r: BacktestResult) => best &&
    r.config.tpAtr === best.config.tpAtr && r.config.slAtr === best.config.slAtr && r.config.minScore === best.config.minScore;

  const SortBtn: React.FC<{ k: typeof sortKey; label: string }> = ({ k, label }) => (
    <button onClick={() => setSortKey(k)}
      className={`text-[10px] px-1.5 py-0.5 rounded ${sortKey === k ? 'bg-accent-green/20 text-accent-green' : 'text-text-tertiary hover:text-white'}`}
    >{label}</button>
  );

  return (
    <div>
      <div className="flex gap-1 mb-2">
        <SortBtn k="sharpe" label="Sharpe" />
        <SortBtn k="winRate" label="Win%" />
        <SortBtn k="pf" label="PF" />
        <SortBtn k="dd" label="Drawdown" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-tertiary text-[10px] uppercase">
              <th className="py-1 px-1.5"></th>
              <th className="text-right py-1 px-1.5">TP</th>
              <th className="text-right py-1 px-1.5">SL</th>
              <th className="text-right py-1 px-1.5">Score</th>
              <th className="text-right py-1 px-1.5">Conf</th>
              <th className="text-right py-1 px-1.5">N</th>
              <th className="text-right py-1 px-1.5">Win%</th>
              <th className="text-right py-1 px-1.5">Sharpe</th>
              <th className="text-right py-1 px-1.5">PF</th>
              <th className="text-right py-1 px-1.5">DD</th>
              <th className="text-right py-1 px-1.5">Hold</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 50).map((r, i) => (
              <tr key={i}
                className={`border-t border-white/5 cursor-pointer hover:bg-white/5 ${isBest(r) ? 'bg-accent-green/10' : ''} ${isPinned(r) ? 'bg-blue-500/10' : ''}`}
                onClick={() => onSelect(r)}
              >
                <td className="py-1 px-1.5">
                  <button onClick={e => { e.stopPropagation(); onPin(r); }}
                    className={`p-0.5 rounded ${isPinned(r) ? 'text-blue-400' : 'text-text-tertiary hover:text-white'}`}
                  ><Pin size={10} /></button>
                </td>
                <td className="text-right py-1 px-1.5 font-mono">{r.config.tpAtr}</td>
                <td className="text-right py-1 px-1.5 font-mono">{r.config.slAtr}</td>
                <td className="text-right py-1 px-1.5 font-mono">{r.config.minScore}</td>
                <td className="text-right py-1 px-1.5 font-mono">{r.config.minConfidence}</td>
                <td className="text-right py-1 px-1.5 font-mono">{r.analytics.totalTrades}</td>
                <td className={`text-right py-1 px-1.5 font-mono ${r.analytics.winRateTheta > 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {r.analytics.winRateTheta.toFixed(0)}%
                </td>
                <td className={`text-right py-1 px-1.5 font-mono ${r.analytics.sharpe > 1 ? 'text-emerald-400' : r.analytics.sharpe > 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {r.analytics.sharpe.toFixed(2)}
                </td>
                <td className={`text-right py-1 px-1.5 font-mono ${r.analytics.profitFactor > 1.5 ? 'text-emerald-400' : 'text-text-tertiary'}`}>
                  {r.analytics.profitFactor === Infinity ? '∞' : r.analytics.profitFactor.toFixed(1)}
                </td>
                <td className="text-right py-1 px-1.5 font-mono text-red-400/60">{r.analytics.maxDrawdown.toFixed(1)}%</td>
                <td className="text-right py-1 px-1.5 font-mono text-text-tertiary">{r.analytics.avgHoldDays.toFixed(0)}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Comparison View ─────────────────────────────────────

const ComparisonView: React.FC<{ pinned: BacktestResult[]; onClear: () => void }> = ({ pinned, onClear }) => {
  if (pinned.length < 2) return null;

  const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444'];

  return (
    <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-4 space-y-3">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-medium">Comparison ({pinned.length})</h3>
        <button onClick={onClear} className="text-text-tertiary hover:text-white text-xs flex items-center gap-1">
          <X size={12} /> Clear
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-tertiary">
              <th className="text-left py-1 px-2"></th>
              {pinned.map((r, i) => (
                <th key={i} className="text-right py-1 px-2" style={{ color: COLORS[i] }}>
                  TP:{r.config.tpAtr} SL:{r.config.slAtr} S≥{r.config.minScore}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { label: 'Win%', fn: (a: BacktestAnalytics) => `${a.winRateTheta.toFixed(1)}%` },
              { label: 'Sharpe', fn: (a: BacktestAnalytics) => a.sharpe.toFixed(2) },
              { label: 'Max DD', fn: (a: BacktestAnalytics) => `${a.maxDrawdown.toFixed(1)}%` },
              { label: 'PF', fn: (a: BacktestAnalytics) => a.profitFactor === Infinity ? '∞' : a.profitFactor.toFixed(2) },
              { label: 'Avg Hold', fn: (a: BacktestAnalytics) => `${a.avgHoldDays.toFixed(0)}d` },
              { label: 'Trades', fn: (a: BacktestAnalytics) => `${a.totalTrades}` },
            ].map(row => (
              <tr key={row.label} className="border-t border-white/5">
                <td className="py-1.5 px-2 text-text-tertiary">{row.label}</td>
                {pinned.map((r, i) => (
                  <td key={i} className="text-right py-1.5 px-2 font-mono">{row.fn(r.analytics)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <EquityCurveSVG curves={pinned.map((r, i) => ({
        data: r.analytics.equityCurve,
        color: COLORS[i],
        label: `TP:${r.config.tpAtr} SL:${r.config.slAtr} S≥${r.config.minScore}`,
      }))} />
    </div>
  );
};

// ── Single Result View ──────────────────────────────────

const SingleResultView: React.FC<{ result: BacktestResult }> = ({ result }) => {
  const { analytics, trades, config } = result;

  return (
    <div className="space-y-4">
      <AnalyticsGrid a={analytics} />

      <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
        <h3 className="text-sm font-medium mb-2">Equity Curve</h3>
        <EquityCurveSVG curves={[{
          data: analytics.equityCurve,
          color: '#10b981',
          label: config.ticker,
        }]} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
          <h3 className="text-sm font-medium mb-2">By Setup</h3>
          <SetupBreakdown bySetup={analytics.bySetup} />
        </div>
        <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
          <h3 className="text-sm font-medium mb-2">MFE / MAE</h3>
          <MfeTable avgMfe={analytics.avgMfe} avgMae={analytics.avgMae} />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Stat label="CALL" value={`${analytics.callStats.winRate.toFixed(0)}%`} sub={`${analytics.callStats.count} trades`} good={analytics.callStats.winRate > 50} />
        <Stat label="PUT" value={`${analytics.putStats.winRate.toFixed(0)}%`} sub={`${analytics.putStats.count} trades`} good={analytics.putStats.winRate > 50} />
        <Stat label="Tier S (90+)" value={`${analytics.tierS.winRate.toFixed(0)}%`} sub={`${analytics.tierS.count} trades`} good={analytics.tierS.winRate > 50} />
        <Stat label="Tier A (80+)" value={`${analytics.tierA.winRate.toFixed(0)}%`} sub={`${analytics.tierA.count} trades`} good={analytics.tierA.winRate > 50} />
        <Stat label="Tier B (70+)" value={`${analytics.tierB.winRate.toFixed(0)}%`} sub={`${analytics.tierB.count} trades`} good={analytics.tierB.winRate > 50} />
      </div>

      <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
        <h3 className="text-sm font-medium mb-2">Trade Log</h3>
        <TradeLog trades={trades} />
      </div>
    </div>
  );
};

// ── Main Page ───────────────────────────────────────────

export const BacktestPage: React.FC = () => {
  const bt = useBacktest();
  const [selectedSweepResult, setSelectedSweepResult] = useState<BacktestResult | null>(null);
  const [selectedOptResult, setSelectedOptResult] = useState<BacktestResult | null>(null);

  return (
    <div className="max-w-7xl mx-auto px-4 pb-24 sm:pb-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <FlaskConical size={24} className="text-accent-green" />
        <div>
          <h1 className="text-xl font-semibold">Signal Backtester</h1>
          <p className="text-sm text-text-tertiary">Test & optimize tech analysis signals</p>
        </div>
      </div>

      {/* Error */}
      {bt.error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 text-sm text-red-400">
          {bt.error}
        </div>
      )}

      {/* Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        {/* Left: Config */}
        <div className="bg-[#111] rounded-lg border border-white/10 p-3 h-fit lg:sticky lg:top-4">
          <ConfigPanel
            config={bt.config}
            onChange={bt.setConfig}
            mode={bt.mode}
            onModeChange={bt.setMode}
            onRun={bt.run}
            onRunSweep={bt.runSweepAction}
            onRunOptimize={bt.runOptimizeAction}
            loading={bt.loading}
            progress={bt.progress}
          />
        </div>

        {/* Right: Results */}
        <div className="space-y-4">
          {/* Candle info */}
          {bt.candles && (
            <div className="text-xs text-text-tertiary flex gap-3">
              <span>{bt.candles.length} candles loaded</span>
              <span>{bt.candles[0]?.date} → {bt.candles[bt.candles.length - 1]?.date}</span>
            </div>
          )}

          {/* Comparison view */}
          <ComparisonView pinned={bt.pinned} onClear={bt.clearPins} />

          {/* Single mode result */}
          {bt.mode === 'single' && bt.singleResult && (
            <SingleResultView result={bt.singleResult} />
          )}

          {/* Sweep mode */}
          {bt.mode === 'sweep' && bt.sweepResult && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-sm text-text-tertiary">
                <span>{bt.sweepResult.totalCombos} combos</span>
                <span>{bt.sweepResult.elapsedMs.toFixed(0)}ms</span>
                <span>{bt.sweepResult.results.filter(r => r.analytics.totalTrades >= 3).length} with 3+ trades</span>
              </div>

              <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
                <h3 className="text-sm font-medium mb-2">Ranked Results (TP/SL Sweep)</h3>
                <SweepTable
                  results={bt.sweepResult.results}
                  pinned={bt.pinned}
                  onPin={bt.togglePin}
                  onSelect={setSelectedSweepResult}
                  best={bt.sweepResult.bestOverall}
                />
              </div>

              {selectedSweepResult && (
                <div className="bg-[#111] rounded-lg border border-accent-green/30 p-3">
                  <div className="flex justify-between items-center mb-3">
                    <h3 className="text-sm font-medium">
                      Detail: TP={selectedSweepResult.config.tpAtr} SL={selectedSweepResult.config.slAtr} Score≥{selectedSweepResult.config.minScore}
                    </h3>
                    <button onClick={() => setSelectedSweepResult(null)} className="text-text-tertiary hover:text-white">
                      <X size={14} />
                    </button>
                  </div>
                  <SingleResultView result={selectedSweepResult} />
                </div>
              )}
            </div>
          )}

          {/* Optimize mode */}
          {bt.mode === 'optimize' && bt.optimizeResult && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-sm text-text-tertiary">
                <span>{bt.optimizeResult.totalCombos} evals over {bt.optimizeResult.generationHistory.length} gens</span>
                <span>{(bt.optimizeResult.elapsedMs / 1000).toFixed(1)}s</span>
                <span>{bt.optimizeResult.results.filter(r => r.analytics.totalTrades >= 3).length} with 3+ trades</span>
              </div>

              {/* Best config highlight */}
              {bt.optimizeResult.bestOverall && (
                <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-3">
                  <div className="text-[11px] text-purple-400 uppercase tracking-wider mb-2">Best Signal Config</div>
                  <div className="mb-2">
                    <IndicatorParamsLabel opts={bt.optimizeResult.bestOverall.config.indicatorOptions} />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Stat label="Win Rate" value={`${bt.optimizeResult.bestOverall.analytics.winRateTheta.toFixed(1)}%`} good={bt.optimizeResult.bestOverall.analytics.winRateTheta > 50} />
                    <Stat label="Sharpe" value={bt.optimizeResult.bestOverall.analytics.sharpe.toFixed(2)} good={bt.optimizeResult.bestOverall.analytics.sharpe > 1} />
                    <Stat label="PF" value={bt.optimizeResult.bestOverall.analytics.profitFactor === Infinity ? '∞' : bt.optimizeResult.bestOverall.analytics.profitFactor.toFixed(2)} good={bt.optimizeResult.bestOverall.analytics.profitFactor > 1.5} />
                    <Stat label="Trades" value={bt.optimizeResult.bestOverall.analytics.totalTrades} />
                  </div>
                </div>
              )}

              <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
                <h3 className="text-sm font-medium mb-2">Ranked Signal Configs</h3>
                <OptimizeTable
                  results={bt.optimizeResult.results}
                  onSelect={setSelectedOptResult}
                  best={bt.optimizeResult.bestOverall}
                />
              </div>

              {selectedOptResult && (
                <div className="bg-[#111] rounded-lg border border-purple-500/30 p-3">
                  <div className="flex justify-between items-center mb-3">
                    <h3 className="text-sm font-medium flex items-center gap-2">
                      Detail: <IndicatorParamsLabel opts={selectedOptResult.config.indicatorOptions} />
                    </h3>
                    <button onClick={() => setSelectedOptResult(null)} className="text-text-tertiary hover:text-white">
                      <X size={14} />
                    </button>
                  </div>
                  <SingleResultView result={selectedOptResult} />
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {!bt.loading && !bt.singleResult && !bt.sweepResult && !bt.optimizeResult && (
            <div className="text-center py-16 text-text-tertiary">
              <FlaskConical size={48} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Configure parameters and run a backtest</p>
              <p className="text-xs mt-1"><b>Single</b> — one config, one run</p>
              <p className="text-xs"><b>Sweep</b> — find best TP/SL settings</p>
              <p className="text-xs"><b>Optimize</b> — find best indicator weights & periods</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
