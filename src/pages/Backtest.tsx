import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { FlaskConical, Play, Zap, Pin, X, ChevronDown, ChevronUp, TrendingUp, TrendingDown, Rocket, Upload, Info, Download } from 'lucide-react';
import { useBacktest, type OOSDateRange } from '../hooks/useBacktest';
import type { BacktestConfig, BacktestResult, BacktestAnalytics, SweepConfig, BacktestTrade, OptimizeConfig, OptimizeParams, QualityGates, SpreadType, WalkForwardConfig, WalkForwardResult } from '../lib/backtest/types';
import { DEFAULT_QUALITY_GATES, DEFAULT_OPTIMIZE_PARAMS, DEFAULT_OPTIONS_PRICING, DEFAULT_SLIPPAGE, DEFAULT_REGIME_GATES } from '../lib/backtest/types';
import type { TechScoreOptions } from '../lib/tech-analysis';
import { DEFAULT_SWEEP } from '../lib/backtest/sweep';
import { useAppSettings } from '../context/AppSettingsContext';

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

// ── Tooltip ─────────────────────────────────────────────

const Tip: React.FC<{ text: string }> = ({ text }) => (
  <span className="relative group inline-flex ml-1 align-middle">
    <Info size={12} className="text-text-tertiary/50 group-hover:text-text-secondary cursor-help" />
    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 rounded bg-[#222] border border-white/10 text-[10px] text-text-secondary leading-tight whitespace-normal w-52 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50 shadow-lg">
      {text}
    </span>
  </span>
);

// ── Toggle Switch ───────────────────────────────────────

// ── Progress Panel ───────────────────────────────────────

import type { LiveGenPoint } from '../hooks/useBacktest';

const OPT_PIPELINE = [
  { key: 'Fetching candles', label: 'Fetch', icon: '📡' },
  { key: 'GA weights',       label: 'GA weights', icon: '⚙️' },
  { key: 'Genetic algorithm', label: 'Evolve', icon: '🧬' },
  { key: 'TP/SL grid',      label: 'TP/SL grid', icon: '🔍' },
  { key: 'OOS validation',  label: 'OOS test', icon: '🧪' },
];

const WF_PIPELINE = [
  { key: 'Fetching candles', label: 'Fetch', icon: '📡' },
  { key: 'Walk-forward',     label: 'Walk-forward', icon: '📈' },
];

function fmtElapsed(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

// Mini SVG sparkline for fitness convergence
const FitnessSparkline: React.FC<{ data: LiveGenPoint[] }> = ({ data }) => {
  if (data.length < 2) return null;
  const W = 220, H = 48;
  const maxF = Math.max(...data.map(d => d.bestFitness));
  const minF = Math.min(...data.map(d => d.avgFitness ?? d.bestFitness));
  const range = maxF - minF || 0.001;
  const sx = (i: number) => (i / (data.length - 1)) * W;
  const sy = (v: number) => H - ((v - minF) / range) * (H - 4) - 2;

  const bestPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${sx(i).toFixed(1)} ${sy(d.bestFitness).toFixed(1)}`).join(' ');
  const avgPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${sx(i).toFixed(1)} ${sy(d.avgFitness ?? d.bestFitness).toFixed(1)}`).join(' ');

  return (
    <svg width={W} height={H} className="overflow-visible">
      <path d={avgPath} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d={bestPath} fill="none" stroke="#10b981" strokeWidth="2" strokeLinejoin="round" />
      {/* Last point dot */}
      <circle cx={sx(data.length - 1)} cy={sy(data[data.length - 1].bestFitness)} r="3" fill="#10b981" />
    </svg>
  );
};

const ProgressPanel: React.FC<{
  phase: string;
  detail: string;
  progress: number;
  elapsedMs: number;
  liveGenHistory: LiveGenPoint[];
  genProgress: { gen: number; totalGens: number; bestFitness: number; cacheHits: number } | null;
  mode: string;
}> = ({ phase, detail, progress, elapsedMs, liveGenHistory, genProgress, mode }) => {
  const isWF = mode === 'walkforward';
  const pipeline = isWF ? WF_PIPELINE : OPT_PIPELINE;

  // Determine which step is active
  const activeIdx = pipeline.findIndex(s => s.key === phase);
  const isGA = phase === 'Genetic algorithm';
  const isTpsl = phase === 'TP/SL grid';

  // Convergence: last 5 gens of improvement
  const lastGen = liveGenHistory[liveGenHistory.length - 1];
  const prevGen = liveGenHistory[liveGenHistory.length - 6];
  const improvement = lastGen && prevGen ? lastGen.bestFitness - prevGen.bestFitness : null;
  const converged = improvement !== null && improvement < 0.001 && liveGenHistory.length > 5;

  return (
    <div className="bg-[#111] border border-white/10 rounded-xl p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">
          {pipeline.find(s => s.key === phase)?.icon ?? '⚙️'}{' '}
          {phase}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-text-tertiary font-mono">{fmtElapsed(elapsedMs)}</span>
          <span className="text-lg font-mono font-bold text-accent-green tabular-nums">{progress}%</span>
        </div>
      </div>

      {/* Pipeline steps */}
      <div className="flex items-center gap-1">
        {pipeline.map((step, i) => {
          const done = activeIdx > i;
          const active = activeIdx === i;
          return (
            <React.Fragment key={step.key}>
              <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all
                ${done ? 'bg-emerald-500/20 text-emerald-400' : active ? 'bg-accent-green/20 text-accent-green ring-1 ring-accent-green/40' : 'bg-white/5 text-text-tertiary'}`}>
                <span>{step.icon}</span>
                <span>{step.label}</span>
                {done && <span>✓</span>}
              </div>
              {i < pipeline.length - 1 && <span className="text-white/20 text-[10px]">›</span>}
            </React.Fragment>
          );
        })}
      </div>

      {/* Main progress bar */}
      <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-accent-green/70 to-accent-green rounded-full transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* GA-specific: sparkline + stats */}
      {isGA && (
        <div className="space-y-2">
          {liveGenHistory.length > 1 && (
            <div className="bg-white/3 rounded-lg p-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-text-tertiary">Fitness convergence</span>
                <div className="flex items-center gap-3 text-[10px] font-mono">
                  <span className="text-emerald-400">best</span>
                  <span className="text-white/30">avg</span>
                </div>
              </div>
              <FitnessSparkline data={liveGenHistory} />
            </div>
          )}
          {genProgress && (
            <div className="grid grid-cols-4 gap-1.5 text-[10px]">
              <div className="bg-white/5 rounded p-1.5 text-center">
                <div className="text-text-tertiary">Gen</div>
                <div className="font-mono font-bold text-white">{genProgress.gen}/{genProgress.totalGens}</div>
              </div>
              <div className="bg-white/5 rounded p-1.5 text-center">
                <div className="text-text-tertiary">Best</div>
                <div className="font-mono font-bold text-accent-green">{genProgress.bestFitness.toFixed(3)}</div>
              </div>
              <div className="bg-white/5 rounded p-1.5 text-center">
                <div className="text-text-tertiary">Δ5 gens</div>
                <div className={`font-mono font-bold ${converged ? 'text-amber-400' : 'text-white'}`}>
                  {improvement !== null ? (improvement >= 0 ? '+' : '') + improvement.toFixed(4) : '—'}
                </div>
              </div>
              <div className="bg-white/5 rounded p-1.5 text-center">
                <div className="text-text-tertiary">Cached</div>
                <div className="font-mono font-bold text-white">{genProgress.cacheHits}</div>
              </div>
            </div>
          )}
          {converged && (
            <p className="text-[10px] text-amber-400/80 font-mono">⚡ Population converged — consider stopping early</p>
          )}
        </div>
      )}

      {/* TP/SL grid detail */}
      {isTpsl && detail && (
        <p className="text-[10px] text-text-secondary font-mono">{detail}</p>
      )}

      {/* WF / other detail */}
      {!isGA && !isTpsl && detail && (
        <p className="text-[10px] text-text-secondary font-mono">{detail}</p>
      )}
    </div>
  );
};

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; color?: string }> = ({ checked, onChange, color = 'bg-accent-green' }) => (
  <button type="button" role="switch" aria-checked={checked}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-3.5 w-7 shrink-0 items-center rounded-full transition-colors cursor-pointer ${checked ? color : 'bg-white/10'}`}
  >
    <span className={`inline-block h-2.5 w-2.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
  </button>
);

// ── Field Components ────────────────────────────────────

const Field: React.FC<{ label: string; value: string; onChange: (v: string) => void; type?: string }> = ({ label, value, onChange, type }) => (
  <div>
    <label className="text-[11px] text-text-tertiary uppercase block mb-1">{label}</label>
    <input type={type || 'text'} value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
  </div>
);

// ── Shared Config Fields ────────────────────────────────

const SETUPS = ['All', 'Perfect Storm', 'Breakout', 'Pullback Buy', 'Strong Trend', 'Breakdown', 'Failed Rally', 'Strong Down', 'Bullish', 'Bearish'];

const IND_DEFAULTS: Record<string, number> = {
  w_mb: 30, w_bxs: 25, w_bxl: 20, w_ema: 15, w_mom: 10,
};

const SharedConfigFields: React.FC<{
  config: BacktestConfig;
  onChange: (c: BacktestConfig) => void;
  showWeights?: boolean;
  hideTicker?: boolean;
}> = ({ config, onChange, showWeights, hideTicker }) => {
  const [showIndicators, setShowIndicators] = useState(false);
  const [showGates, setShowGates] = useState(false);

  const upd = (partial: Partial<BacktestConfig>) => onChange({ ...config, ...partial });
  const updInd = (key: keyof TechScoreOptions, val: number) => {
    onChange({ ...config, indicatorOptions: { ...config.indicatorOptions, [key]: val } });
  };
  const updGate = (partial: Partial<QualityGates>) => {
    onChange({ ...config, qualityGates: { ...config.qualityGates, ...partial } });
  };
  const indVal = (key: keyof TechScoreOptions): number =>
    (config.indicatorOptions[key] as number) ?? IND_DEFAULTS[key] ?? 0;

  const isOptionMode = config.optionsPricing?.enabled ?? false;

  return (
    <>
      {/* Option Mode / Stock Mode — top-level toggle */}
      <div className={`rounded-lg p-2.5 border ${isOptionMode ? 'border-purple-500/30 bg-purple-500/5' : 'border-white/5'}`}>
        <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
          <Toggle checked={isOptionMode}
            onChange={v => {
              const base = config.optionsPricing ?? DEFAULT_OPTIONS_PRICING;
              upd({ optionsPricing: { ...base, enabled: v, premiumTP: base.premiumTP ?? 0.50, premiumSL: base.premiumSL ?? 0.50 } });
            }} />
          <span className="font-medium">{isOptionMode ? 'Option Mode' : 'Stock Mode'}</span>
          <Tip text="Stock Mode: TP/SL based on stock price ATR levels, returns = stock price change. Option Mode: simulates buying an ATM option at each signal — TP/SL based on option premium % change, with real IV from ORATS and theta decay." />
        </label>
      </div>

      {/* Ticker + Dates */}
      {!hideTicker ? (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[11px] text-text-tertiary uppercase block mb-1">
              Ticker<Tip text="Stock symbol to backtest. Signals are generated from this ticker's daily candles using the tech score algorithm." />
            </label>
            <input type="text" value={config.ticker} onChange={e => upd({ ticker: e.target.value.toUpperCase() })}
              className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
          </div>
          <Field label="Start" value={config.startDate} onChange={v => upd({ startDate: v })} type="date" />
          <Field label="End" value={config.endDate} onChange={v => upd({ endDate: v })} type="date" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start" value={config.startDate} onChange={v => upd({ startDate: v })} type="date" />
          <Field label="End" value={config.endDate} onChange={v => upd({ endDate: v })} type="date" />
        </div>
      )}

      {/* TP/SL — mode-dependent */}
      {isOptionMode ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div>
            <label className="text-[11px] text-text-tertiary uppercase block mb-1">
              Premium TP %<Tip text="Take profit when option premium gains this %. 50% = sell when option is up 50% from entry." />
            </label>
            <input type="number" value={Math.round((config.optionsPricing?.premiumTP ?? 0.50) * 100)}
              onChange={e => upd({ optionsPricing: { ...config.optionsPricing!, premiumTP: Number(e.target.value) / 100 } })}
              step={5} min={10} max={300}
              className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
          </div>
          <div>
            <label className="text-[11px] text-text-tertiary uppercase block mb-1">
              Premium SL %<Tip text="Stop loss when option premium drops by this %. 50% = exit when option loses half its value." />
            </label>
            <input type="number" value={Math.round((config.optionsPricing?.premiumSL ?? 0.50) * 100)}
              onChange={e => upd({ optionsPricing: { ...config.optionsPricing!, premiumSL: Number(e.target.value) / 100 } })}
              step={5} min={10} max={100}
              className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
          </div>
          <div>
            <label className="text-[11px] text-text-tertiary uppercase block mb-1">
              Entry DTE<Tip text="Days to expiration when synthetic option is 'bought'. 30 = typical swing trade." />
            </label>
            <input type="number" value={config.optionsPricing?.entryDTE ?? 30}
              onChange={e => upd({ optionsPricing: { ...config.optionsPricing!, entryDTE: Number(e.target.value) } })}
              step={1} min={7} max={90}
              className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
          </div>
          <div>
            <label className="text-[11px] text-text-tertiary uppercase block mb-1">
              Spread<Tip text="Single = naked long option. Vertical = debit spread (capped risk)." />
            </label>
            <select value={config.optionsPricing?.spreadType ?? 'single'}
              onChange={e => upd({ optionsPricing: { ...config.optionsPricing!, spreadType: e.target.value as SpreadType } })}
              className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white focus:border-accent-green/50 focus:outline-none">
              <option value="single">Single Leg</option>
              <option value="vertical">Vertical</option>
            </select>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] text-text-tertiary uppercase block mb-1">
              TP (ATR)<Tip text="Take profit distance as ATR(14) multiple. Higher = more room to run but fewer hits. E.g. 2.5 means exit when price moves 2.5× the average true range in your favor." />
            </label>
            <input type="number" value={config.tpAtr} onChange={e => upd({ tpAtr: Number(e.target.value) })} step={0.5} min={0.5} max={5}
              className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
          </div>
          <div>
            <label className="text-[11px] text-text-tertiary uppercase block mb-1">
              SL (ATR)<Tip text="Stop loss distance as ATR(14) multiple. Lower = tighter risk but more stops. E.g. 1.5 means exit when price moves 1.5× ATR against you." />
            </label>
            <input type="number" value={config.slAtr} onChange={e => upd({ slAtr: Number(e.target.value) })} step={0.5} min={0.5} max={5}
              className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
          </div>
        </div>
      )}

      {/* Score + Confidence */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            Min Score<Tip text="Minimum tech score (0-100) to trigger a signal. Higher = fewer but higher-conviction trades. The tech score combines MB, BXS, BXL, EMA, and momentum sub-scores." />
          </label>
          <input type="number" value={config.minScore} onChange={e => upd({ minScore: Number(e.target.value) })} step={5} min={50} max={95}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
        </div>
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            Min Conf<Tip text="Minimum setup confidence level (0-3). 0=any signal, 1=at least low confidence, 2=medium, 3=high only. Based on how many confirming factors the setup has." />
          </label>
          <input type="number" value={config.minConfidence} onChange={e => upd({ minConfidence: Number(e.target.value) })} step={1} min={0} max={3}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
        </div>
      </div>

      {/* Direction + Cooldown */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            Direction<Tip text="Filter signals by direction. ALL=both calls and puts. CALL=bullish only. PUT=bearish only." />
          </label>
          <select value={config.directionFilter} onChange={e => upd({ directionFilter: e.target.value as 'ALL' | 'CALL' | 'PUT' })}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none">
            {['ALL', 'CALL', 'PUT'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            Cooldown<Tip text="Minimum bars between entries. Prevents stacking trades on consecutive signals. Higher = more spacing, fewer total trades." />
          </label>
          <input type="number" value={config.cooldownBars} onChange={e => upd({ cooldownBars: Number(e.target.value) })} step={1} min={1} max={50}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
        </div>
      </div>

      {/* Time Stop + Score Stop + Decay */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            Time Stop<Tip text="Force-close position after N bars if neither TP nor SL is hit. Prevents capital from being tied up in stale trades. Typical: 21 bars (1 month)." />
          </label>
          <input type="number" value={config.timeStopBars} onChange={e => upd({ timeStopBars: Number(e.target.value) })} step={1} min={5} max={60}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
        </div>
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            Score Stop<Tip text="Exit if the composite signal score drops below this threshold. Indicates the original trade thesis has broken down. 0 = disabled. Default: 55." />
          </label>
          <input type="number" value={config.scoreStopThreshold} onChange={e => upd({ scoreStopThreshold: Number(e.target.value) })} step={5} min={0} max={70}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
        </div>
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            Theta Decay<Tip text="Daily decay rate applied to P&L to simulate options time decay. 0.03 = 3% per day penalty on unrealized gains. Models how options lose value over time even if stock price is favorable." />
          </label>
          <input type="number" value={config.thetaDecayRate} onChange={e => upd({ thetaDecayRate: Number(e.target.value) })} step={0.01} min={0} max={0.1}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
        </div>
      </div>

      {/* Slippage */}
      <div className="border border-white/5 rounded-lg p-2.5">
        <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
          <Toggle checked={config.slippage?.enabled ?? false}
            onChange={v => upd({ slippage: { ...(config.slippage ?? DEFAULT_SLIPPAGE), enabled: v } })} />
          Slippage Model
          <Tip text="Applies adverse fill basis points at entry and exit. 5 bps = 0.05% worse price on each trade. Models real-world execution costs." />
        </label>
        {config.slippage?.enabled && (
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div>
              <label className="text-[10px] text-text-tertiary uppercase block mb-1">Entry (bps)</label>
              <input type="number" value={config.slippage?.entryBps ?? 5}
                onChange={e => upd({ slippage: { ...config.slippage!, entryBps: Number(e.target.value) } })}
                step={1} min={0} max={50}
                className="w-full bg-[#111] border border-white/10 rounded px-2 py-1 text-xs text-white font-mono focus:border-accent-green/50 focus:outline-none" />
            </div>
            <div>
              <label className="text-[10px] text-text-tertiary uppercase block mb-1">Exit (bps)</label>
              <input type="number" value={config.slippage?.exitBps ?? 5}
                onChange={e => upd({ slippage: { ...config.slippage!, exitBps: Number(e.target.value) } })}
                step={1} min={0} max={50}
                className="w-full bg-[#111] border border-white/10 rounded px-2 py-1 text-xs text-white font-mono focus:border-accent-green/50 focus:outline-none" />
            </div>
          </div>
        )}
      </div>

      {/* Setups */}
      <div>
        <label className="text-[11px] text-text-tertiary uppercase block mb-1">
          Setups<Tip text="Filter which setup patterns to trade. 'All' includes every detected setup. Select specific ones to test individual pattern performance." />
        </label>
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
        <Toggle checked={config.useEntryQualityAdjust} onChange={v => upd({ useEntryQualityAdjust: v })} />
        Entry quality adjustment
        <Tip text="Adjusts TP/SL based on entry timing relative to EMA-8. Optimal entries get wider targets, chasing entries get tighter stops. Models real-world fill quality." />
      </label>

      {/* Quality Gates (V4) */}
      <div>
        <button onClick={() => setShowGates(!showGates)}
          className="flex items-center gap-1 text-sm text-text-secondary hover:text-white w-full py-1">
          {showGates ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          Quality Gates
          <Tip text="V4 market-structure filters applied BEFORE scoring. These are fixed thresholds (not optimizable) that filter out low-quality market environments. Reducing overfitting by removing noise signals." />
        </button>
        {showGates && (
          <div className="space-y-2 mt-1 pl-1">
            <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
              <Toggle checked={config.qualityGates.minADX > 0} onChange={v => updGate({ minADX: v ? DEFAULT_QUALITY_GATES.minADX : 0 })} color="bg-cyan-500" />
              ADX filter (min {config.qualityGates.minADX})
              <Tip text="Average Directional Index measures trend strength (0-100). ADX < 15 = no trend, choppy market. Filters out signals in trendless conditions where directional trades fail. Uses ADX(14)." />
            </label>
            <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
              <Toggle checked={config.qualityGates.minRVOL > 0} onChange={v => updGate({ minRVOL: v ? DEFAULT_QUALITY_GATES.minRVOL : 0 })} color="bg-cyan-500" />
              RVOL filter (min {config.qualityGates.minRVOL})
              <Tip text="Relative Volume = today's volume / 20-day average. RVOL < 0.5 = dead volume, low participation. Filters out signals on low-volume days where price moves are unreliable." />
            </label>
            <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
              <Toggle checked={config.qualityGates.useCoherence} onChange={v => updGate({ useCoherence: v })} color="bg-cyan-500" />
              Coherence multiplier
              <Tip text="Counts how many of MB/BXS/BXL sub-scores agree with signal direction (0-3). Adjusts score: 3/3 = 1.10x boost, 2/3 = 1.00x (neutral), 1/3 = 0.85x penalty, 0/3 = 0.70x strong penalty. Rewards signals where all indicators agree." />
            </label>
            <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
              <Toggle checked={config.qualityGates.useSqueeze} onChange={v => updGate({ useSqueeze: v })} color="bg-cyan-500" />
              Squeeze multiplier
              <Tip text="Bollinger Band squeeze detection: BB inside Keltner Channel = volatility compression. When squeeze is active, a breakout is likely. Applies 1.05x score boost to signals during squeeze conditions." />
            </label>
            <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
              <Toggle checked={config.regimeGates?.enabled ?? false}
                onChange={v => upd({ regimeGates: { ...(config.regimeGates ?? DEFAULT_REGIME_GATES), enabled: v } })}
                color="bg-cyan-500" />
              Regime-adaptive gates
              <Tip text="ADX/RVOL thresholds and coherence multipliers adapt based on market regime (trending/ranging). Trending: stricter ADX, relaxed volume. Ranging: relaxed ADX, stricter volume." />
            </label>
          </div>
        )}
      </div>

      {/* Indicator Weights (validate mode only) */}
      {showWeights && (
        <div>
          <button onClick={() => setShowIndicators(!showIndicators)}
            className="flex items-center gap-1 text-sm text-text-secondary hover:text-white w-full py-1">
            {showIndicators ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            Signal Weights
            <Tip text="How much each sub-indicator contributes to the composite tech score (must sum to 100). In Optimize mode, GA evolves these automatically." />
          </button>
          {showIndicators && (
            <div className="space-y-2 mt-1">
              <div className="grid grid-cols-5 gap-1">
                {([
                  ['w_mb', 'MB', 'Mean/Bollinger Band reversion signal. Measures price position relative to statistical bands.'],
                  ['w_bxs', 'BXS', 'Box Short-term breakout. Detects short-term (1-2 week) price range breakouts.'],
                  ['w_bxl', 'BXL', 'Box Long-term breakout. Detects long-term (3-6 week) price range breakouts.'],
                  ['w_ema', 'EMA', 'EMA trend alignment. Measures price position vs EMA-8/21/50/200 stack.'],
                  ['w_mom', 'MOM', 'Momentum oscillator. RSI/Stochastic based momentum confirmation.'],
                ] as const).map(([k, label, tip]) => (
                  <div key={k}>
                    <label className="text-[9px] text-text-tertiary uppercase block">{label}<Tip text={tip} /></label>
                    <input type="number" value={indVal(k as keyof TechScoreOptions)} onChange={e => updInd(k as keyof TechScoreOptions, Number(e.target.value))}
                      step={5} min={0} max={60}
                      className="w-full bg-[#111] border border-white/10 rounded px-1 py-1 text-[11px] text-white font-mono focus:border-accent-green/50 focus:outline-none" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};

// ── Validate Panel ──────────────────────────────────────

const ValidatePanel: React.FC<{
  config: BacktestConfig;
  onChange: (c: BacktestConfig) => void;
  onRun: () => void;
  loading: boolean;
  progress: number;
}> = ({ config, onChange, onRun, loading, progress }) => (
  <div className="space-y-3">
    <SharedConfigFields config={config} onChange={onChange} showWeights />
    <button onClick={onRun} disabled={loading}
      className="w-full py-2.5 rounded-lg font-medium text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-50 bg-accent-green text-black hover:bg-accent-green/90"
    >
      {loading ? (
        <><Zap size={16} className="animate-pulse" /> Running... {progress}%</>
      ) : (
        <><Play size={16} /> Run Backtest</>
      )}
    </button>
  </div>
);

// ── Optimize Panel ──────────────────────────────────────

type OptSubMode = 'sweep' | 'ga';

interface SweepToggles {
  tpSl: boolean;
  minScore: boolean;
  confidence: boolean;
  decay: boolean;
}

const DEFAULT_SWEEP_TOGGLES: SweepToggles = {
  tpSl: true,
  minScore: true,
  confidence: false,
  decay: false,
};

const IS_SPLIT_PRESETS = [0.5, 0.6, 0.66, 0.70, 0.75, 0.80] as const;

/** Compute IS endDate and OOS startDate from full date range + split fraction */
function computeISOOSDates(startDate: string, endDate: string, splitFraction: number, purgeGapDays = 5) {
  const start = new Date(startDate + 'T12:00:00Z');
  const end = new Date(endDate + 'T12:00:00Z');
  const totalMs = end.getTime() - start.getTime();
  const isEndMs = start.getTime() + totalMs * splitFraction;
  const isEnd = new Date(isEndMs);
  const oosStart = new Date(isEndMs + purgeGapDays * 86400000);
  return {
    isEnd: isEnd.toISOString().split('T')[0],
    oosStart: oosStart.toISOString().split('T')[0],
  };
}

const OptimizePanel: React.FC<{
  config: BacktestConfig;
  onChange: (c: BacktestConfig) => void;
  onRunSweep: (s: SweepConfig) => void;
  onRunOptimize: (o: OptimizeConfig, oosDateRange?: OOSDateRange) => void;
  loading: boolean;
  progress: number;
  progressPhase: string;
}> = ({ config, onChange, onRunSweep, onRunOptimize, loading, progress, progressPhase }) => {
  const [subMode, setSubMode] = useState<OptSubMode>('ga');
  const [showSweepDims, setShowSweepDims] = useState(false);
  const [showOptParams, setShowOptParams] = useState(false);
  const [selectedTickers, setSelectedTickers] = useState<string[]>([]);
  const [customInput, setCustomInput] = useState('');
  const [sweepToggles, setSweepToggles] = useState<SweepToggles>(DEFAULT_SWEEP_TOGGLES);
  const [optParams, setOptParams] = useState<OptimizeParams>(DEFAULT_OPTIMIZE_PARAMS);
  const [isSplit, setIsSplit] = useState(0.66); // IS fraction (default 66%)
  const [oosEnabled, setOosEnabled] = useState(true); // auto OOS validation after optimize

  // Default ticker universe: same 27 tickers as cron-signal-scan
  const SCAN_TICKERS = useMemo(() => [
    'SPY','QQQ','GOOG','JPM','META','TSLA','MSFT','NFLX','AAPL','NVDA',
    'AMD','COST','IREN','BA','AMZN','HOOD','CRWV','COIN','MSTR','PLTR',
    'AVGO','LULU','UBER','GS','UNH','IWM','GLD',
  ], []);
  const universeTickers = SCAN_TICKERS;

  // Once watchlist loads, default-select all (only on first load)
  useEffect(() => {
    if (universeTickers.length > 0 && selectedTickers.length === 0) {
      setSelectedTickers(universeTickers);
    }
  }, [universeTickers]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTicker = (t: string) =>
    setSelectedTickers(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  const addCustomTicker = () => {
    const t = customInput.trim().toUpperCase();
    if (!t) return;
    setSelectedTickers(prev => prev.includes(t) ? prev : [...prev, t]);
    setCustomInput('');
  };

  const parsedTickers = selectedTickers;
  const primaryTicker = parsedTickers[0] || config.ticker || 'SPY';

  const sweepConfig = useMemo((): Omit<SweepConfig, 'ticker' | 'startDate' | 'endDate' | 'timeframe'> => ({
    tpAtrRange: sweepToggles.tpSl ? DEFAULT_SWEEP.tpAtrRange : [config.tpAtr],
    slAtrRange: sweepToggles.tpSl ? DEFAULT_SWEEP.slAtrRange : [config.slAtr],
    minScoreRange: sweepToggles.minScore ? DEFAULT_SWEEP.minScoreRange : [config.minScore],
    minConfidenceRange: sweepToggles.confidence ? DEFAULT_SWEEP.minConfidenceRange : [config.minConfidence],
    setupGroups: DEFAULT_SWEEP.setupGroups,
    thetaDecayRange: sweepToggles.decay ? [0.02, 0.03, 0.05] : [config.thetaDecayRate],
  }), [sweepToggles, config.tpAtr, config.slAtr, config.minScore, config.minConfidence, config.thetaDecayRate]);

  const totalSweepCombos = sweepConfig.tpAtrRange.length * sweepConfig.slAtrRange.length *
    sweepConfig.minScoreRange.length * sweepConfig.minConfidenceRange.length *
    sweepConfig.thetaDecayRange.length;

  const geneCount = (optParams.weights ? 5 : 0) + (optParams.periods ? 6 : 0) +
    (optParams.tpSl ? 2 : 0) + (optParams.minScore ? 1 : 0) + (optParams.decay ? 1 : 0);

  const { isEnd, oosStart } = computeISOOSDates(config.startDate, config.endDate, isSplit);

  const handleRun = () => {
    if (parsedTickers.length === 0) return;
    if (subMode === 'sweep') {
      onRunSweep({
        ...sweepConfig,
        ticker: primaryTicker,
        startDate: config.startDate,
        endDate: config.endDate,
        timeframe: '1D',
        optionsPricing: config.optionsPricing,
        slippage: config.slippage,
        regimeGates: config.regimeGates,
      });
    } else {
      // IS dates: full start → split point. OOS dates: split+purge → full end.
      const oosDateRange: OOSDateRange | undefined = oosEnabled
        ? { startDate: oosStart, endDate: config.endDate }
        : undefined;

      onRunOptimize({
        ticker: primaryTicker,
        startDate: config.startDate,
        endDate: isEnd,           // IS end date
        tpAtr: config.tpAtr,
        slAtr: config.slAtr,
        minScore: config.minScore,
        minConfidence: config.minConfidence,
        thetaDecayRate: config.thetaDecayRate,
        scoreStopThreshold: config.scoreStopThreshold,
        tickers: parsedTickers.length > 1 ? parsedTickers : undefined,
        optimizeParams: optParams,
        optionsPricing: config.optionsPricing,
        slippage: config.slippage,
        regimeGates: config.regimeGates,
      }, oosDateRange);
    }
  };

  return (
    <div className="space-y-3">
      {/* Ticker universe */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] text-text-tertiary uppercase">
            Ticker Universe
            <Tip text="GA fitness is averaged across all selected tickers. More diverse instruments = more robust params, less curve-fitting. Industry standard: 5–15 tickers spanning sectors." />
          </label>
          <div className="flex gap-2 text-[10px]">
            <button onClick={() => setSelectedTickers(universeTickers)} className="text-blue-400/70 hover:text-blue-300 transition-colors">All</button>
            <button onClick={() => setSelectedTickers([])} className="text-text-tertiary hover:text-white transition-colors">None</button>
          </div>
        </div>

        {/* Chips */}
        <div className="flex flex-wrap gap-1 mb-1.5 min-h-[28px]">
          {universeTickers.map(t => {
            const active = selectedTickers.includes(t);
            return (
              <button key={t} onClick={() => toggleTicker(t)}
                className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${active
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-[#111] border-white/10 text-text-tertiary hover:border-white/25 hover:text-white'}`}
              >{t}</button>
            );
          })}
          {/* Custom tickers not in watchlist */}
          {selectedTickers.filter(t => !universeTickers.includes(t)).map(t => (
            <button key={t} onClick={() => toggleTicker(t)}
              className="px-2 py-0.5 rounded text-[11px] font-mono border bg-blue-500/15 border-blue-500/40 text-blue-300 transition-colors"
            >{t} ×</button>
          ))}
        </div>

        {/* Add custom ticker */}
        <div className="flex gap-1">
          <input value={customInput} onChange={e => setCustomInput(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && addCustomTicker()}
            placeholder="Add ticker…"
            className="flex-1 bg-[#111] border border-white/10 rounded px-2 py-1 text-[11px] text-white font-mono focus:border-accent-green/50 focus:outline-none placeholder:text-white/20" />
          <button onClick={addCustomTicker} className="px-2 py-1 bg-[#111] border border-white/10 rounded text-[11px] text-text-tertiary hover:text-white transition-colors">+</button>
        </div>

        {parsedTickers.length > 1 ? (
          <div className="text-[10px] text-emerald-400/70 mt-1">{parsedTickers.length} tickers — GA fitness averaged across basket (anti-overfitting)</div>
        ) : parsedTickers.length === 1 ? (
          <div className="text-[10px] text-amber-400/70 mt-1">Select 3+ tickers for robust optimization — single ticker risks curve-fitting</div>
        ) : (
          <div className="text-[10px] text-red-400/70 mt-1">Select at least one ticker</div>
        )}
      </div>

      <SharedConfigFields config={config} onChange={onChange} hideTicker />

      {/* IS/OOS split — only for GA mode */}
      {subMode === 'ga' && (
        <div className="border border-white/5 rounded-lg p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-secondary font-medium">
              IS / OOS Split
              <Tip text="In-sample (IS) data is used for optimization. Out-of-sample (OOS) is held back and never seen during training — it's the true forward-test of the optimized params. Industry standard: 66–75% IS, 25–34% OOS." />
            </span>
            <label className="flex items-center gap-1.5 text-[10px] text-text-tertiary cursor-pointer">
              <Toggle checked={oosEnabled} onChange={setOosEnabled} color="bg-blue-500" />
              Auto OOS validate
            </label>
          </div>

          {/* Split presets */}
          <div className="flex gap-1">
            {IS_SPLIT_PRESETS.map(p => (
              <button key={p} onClick={() => setIsSplit(p)}
                className={`flex-1 py-1 rounded text-[10px] font-mono transition-colors ${isSplit === p ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-[#111] text-text-tertiary hover:text-white border border-white/5'}`}
              >{Math.round(p * 100)}%</button>
            ))}
          </div>

          {/* Date preview */}
          <div className="space-y-1 text-[10px] font-mono">
            <div className="flex items-center gap-2">
              <span className="text-amber-400 w-3">IS</span>
              <span className="text-text-tertiary">{config.startDate}</span>
              <span className="text-text-tertiary/40">→</span>
              <span className="text-amber-400">{isEnd}</span>
              <span className="text-text-tertiary/50 ml-auto">train ({Math.round(isSplit * 100)}%)</span>
            </div>
            {oosEnabled && (
              <div className="flex items-center gap-2">
                <span className="text-blue-400 w-3">OOS</span>
                <span className="text-text-tertiary">{oosStart}</span>
                <span className="text-text-tertiary/40">→</span>
                <span className="text-blue-400">{config.endDate}</span>
                <span className="text-text-tertiary/50 ml-auto">test ({Math.round((1 - isSplit) * 100)}%)</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sub-mode toggle: Sweep vs GA */}
      <div className="flex gap-1 bg-[#0A0A0A] rounded-lg p-0.5">
        <button onClick={() => setSubMode('sweep')}
          className={`flex-1 py-1.5 rounded text-[12px] font-medium transition-colors ${
            subMode === 'sweep' ? 'bg-[#2A2A2A] text-white' : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >Grid Sweep</button>
        <button onClick={() => setSubMode('ga')}
          className={`flex-1 py-1.5 rounded text-[12px] font-medium transition-colors ${
            subMode === 'ga' ? 'bg-[#2A2A2A] text-white' : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >GA Optimize</button>
      </div>

      {/* Sweep-specific controls */}
      {subMode === 'sweep' && (
        <div>
          <button onClick={() => setShowSweepDims(!showSweepDims)}
            className="flex items-center gap-1 text-sm text-text-secondary hover:text-white w-full py-1">
            {showSweepDims ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            Sweep Dimensions
            <Tip text="Choose which parameters to sweep. Enabled dimensions will be tested across a range of values. Disabled dimensions use the fixed values from above. More dimensions = more combos = slower but more thorough." />
          </button>
          {showSweepDims && (
            <div className="space-y-1.5 mt-1 pl-1">
              <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
                <Toggle checked={sweepToggles.tpSl} onChange={v => setSweepToggles(p => ({ ...p, tpSl: v }))} />
                TP/SL range
                <Tip text="Sweep TP across [1.5, 2.0, 2.5, 3.0] and SL across [1.0, 1.5, 2.0]. Tests 12 TP/SL combinations to find optimal risk/reward ratio." />
                <span className="text-text-tertiary/50 ml-auto text-[10px]">{sweepToggles.tpSl ? '4×3' : 'fixed'}</span>
              </label>
              <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
                <Toggle checked={sweepToggles.minScore} onChange={v => setSweepToggles(p => ({ ...p, minScore: v }))} />
                Min Score range
                <Tip text="Sweep minimum score across [65, 70, 75, 80]. Tests the trade-off between signal quantity and quality — higher min score = fewer but better trades." />
                <span className="text-text-tertiary/50 ml-auto text-[10px]">{sweepToggles.minScore ? '×4' : 'fixed'}</span>
              </label>
              <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
                <Toggle checked={sweepToggles.confidence} onChange={v => setSweepToggles(p => ({ ...p, confidence: v }))} />
                Confidence range
                <Tip text="Sweep min confidence across [1, 2]. Tests whether requiring higher setup confirmation improves results." />
                <span className="text-text-tertiary/50 ml-auto text-[10px]">{sweepToggles.confidence ? '×2' : 'fixed'}</span>
              </label>
              <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
                <Toggle checked={sweepToggles.decay} onChange={v => setSweepToggles(p => ({ ...p, decay: v }))} />
                Theta Decay range
                <Tip text="Sweep theta decay across [0.02, 0.03, 0.05]. Tests sensitivity to options time decay assumptions." />
                <span className="text-text-tertiary/50 ml-auto text-[10px]">{sweepToggles.decay ? '×3' : 'fixed'}</span>
              </label>
              <div className="text-[10px] text-text-tertiary mt-1 pt-1 border-t border-white/5">
                Total: {totalSweepCombos} combinations
              </div>
            </div>
          )}
        </div>
      )}

      {/* GA-specific controls */}
      {subMode === 'ga' && (
        <>
          {/* GA Parameters */}
          <div>
            <button onClick={() => setShowOptParams(!showOptParams)}
              className="flex items-center gap-1 text-sm text-text-secondary hover:text-white w-full py-1">
              {showOptParams ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              GA Parameters
              <Tip text="Choose which parameter groups the genetic algorithm optimizes. More parameters = larger search space = more expressive but higher overfitting risk. Start with weights only, add more if needed." />
            </button>
            {showOptParams && (
              <div className="space-y-1.5 mt-1 pl-1">
                <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
                  <Toggle checked={optParams.weights} onChange={v => setOptParams(p => ({ ...p, weights: v }))} color="bg-purple-500" />
                  Signal Weights
                  <Tip text="Evolves the 5 scoring weights (MB, BXS, BXL, EMA, MOM) that sum to 100. Controls how much each sub-indicator contributes to the composite tech score. 5 genes, ~4,096 combos at step=5." />
                  <span className="text-text-tertiary/50 ml-auto text-[10px]">5 genes</span>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
                  <Toggle checked={optParams.periods} onChange={v => setOptParams(p => ({ ...p, periods: v }))} color="bg-purple-500" />
                  Indicator Periods
                  <Tip text="Evolves lookback periods for each sub-indicator: MB length (50-200), Oscillator smooth (3-14), Box Short p1/p2 (3-10/10-30), Box Long p1/p2 (10-40/10-30). WARNING: 6 extra genes significantly increase search space and overfitting risk." />
                  <span className="text-text-tertiary/50 ml-auto text-[10px]">6 genes</span>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
                  <Toggle checked={optParams.tpSl} onChange={v => setOptParams(p => ({ ...p, tpSl: v }))} color="bg-purple-500" />
                  TP / SL
                  <Tip text="Evolves take-profit (1.0-4.0) and stop-loss (0.5-3.0) ATR multiples. When enabled, replaces the separate TP/SL grid stage with GA-driven optimization. 2 genes." />
                  <span className="text-text-tertiary/50 ml-auto text-[10px]">2 genes</span>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
                  <Toggle checked={optParams.minScore} onChange={v => setOptParams(p => ({ ...p, minScore: v }))} color="bg-purple-500" />
                  Min Score
                  <Tip text="Evolves the minimum tech score threshold (55-90). Finds optimal trade-off between signal quantity and quality. 1 gene." />
                  <span className="text-text-tertiary/50 ml-auto text-[10px]">1 gene</span>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
                  <Toggle checked={optParams.decay} onChange={v => setOptParams(p => ({ ...p, decay: v }))} color="bg-purple-500" />
                  Theta Decay
                  <Tip text="Evolves the daily theta decay rate (0.01-0.08). Models options time decay intensity. 1 gene." />
                  <span className="text-text-tertiary/50 ml-auto text-[10px]">1 gene</span>
                </label>
                <div className={`text-[10px] mt-1 pt-1 border-t border-white/5 ${geneCount > 8 ? 'text-amber-400' : 'text-text-tertiary'}`}>
                  {geneCount} genes total{geneCount > 8 && ' — high overfitting risk'}
                  {geneCount === 0 && ' — select at least one parameter group'}
                  {!optParams.tpSl && geneCount > 0 && ' + 12 TP/SL grid (stage 2)'}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Mode description */}
      <div className="text-[10px] text-text-tertiary">
        {subMode === 'sweep' && `Grid search ${totalSweepCombos} parameter combos`}
        {subMode === 'ga' && (() => {
          if (geneCount === 0) return 'Select parameters to optimize';
          const parts: string[] = [];
          if (optParams.weights) parts.push('weights');
          if (optParams.periods) parts.push('periods');
          if (optParams.tpSl) parts.push('TP/SL');
          if (optParams.minScore) parts.push('minScore');
          if (optParams.decay) parts.push('decay');
          return `GA optimizes ${parts.join(' + ')} (${geneCount} genes)${!optParams.tpSl ? ' + TP/SL grid' : ''}`;
        })()}
      </div>

      {/* Run Button */}
      <button onClick={handleRun} disabled={loading || parsedTickers.length === 0 || (subMode === 'ga' && geneCount === 0)}
        className={`w-full py-2.5 rounded-lg font-medium text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-50 ${
          subMode === 'ga'
            ? 'bg-purple-500 text-white hover:bg-purple-400'
            : 'bg-accent-green text-black hover:bg-accent-green/90'
        }`}
      >
        {loading ? (
          <><Zap size={16} className="animate-pulse" /> {subMode === 'ga' ? `Optimizing (${progressPhase})` : 'Sweeping'}... {progress}%</>
        ) : subMode === 'sweep' ? (
          <><Zap size={16} /> Sweep ({totalSweepCombos} combos)</>
        ) : (
          <><Rocket size={16} /> Optimize ({geneCount} genes{!optParams.tpSl && geneCount > 0 ? ' + grid' : ''})</>
        )}
      </button>
    </div>
  );
};

// ── Walk-Forward Panel ───────────────────────────────────

const WalkForwardPanel: React.FC<{
  config: BacktestConfig;
  onRun: (wf: WalkForwardConfig) => void;
  loading: boolean;
  progress: number;
  progressPhase: string;
}> = ({ config, onRun, loading, progress, progressPhase }) => {
  const [ticker, setTicker] = useState(config.ticker || 'SPY');
  const [startDate, setStartDate] = useState(config.startDate);
  const [endDate, setEndDate] = useState(config.endDate);
  const [isWindowDays, setIsWindowDays] = useState(252);
  const [oosWindowDays, setOosWindowDays] = useState(63);
  const [mode, setMode] = useState<'rolling' | 'anchored'>('rolling');
  const [optimizer, setOptimizer] = useState<'ga' | 'sweep'>('ga');

  // Estimate window count
  const start = new Date(startDate + 'T12:00:00Z');
  const end = new Date(endDate + 'T12:00:00Z');
  const totalTradingDays = Math.round((end.getTime() - start.getTime()) / 86400000 * 5 / 7);
  const estimatedWindows = Math.max(0, Math.floor((totalTradingDays - isWindowDays) / oosWindowDays));

  const handleRun = () => {
    onRun({
      ticker: ticker.toUpperCase().trim(),
      startDate,
      endDate,
      timeframe: '1D',
      isWindowDays,
      oosWindowDays,
      mode,
      purgeGapDays: 5,
      optimizer,
      populationSize: 30,
      generations: 20,
    });
  };

  return (
    <div className="space-y-3">
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-2.5 text-[11px] text-blue-300/80 space-y-1">
        <div className="font-medium text-blue-300">Walk-Forward Validation</div>
        <div>Optimizes on rolling IS windows, validates on held-out OOS windows. Concatenated OOS trades = true forward-test. More robust than single IS/OOS split.</div>
      </div>

      {/* Ticker + dates */}
      <div>
        <label className="text-[11px] text-text-tertiary uppercase block mb-1">Ticker</label>
        <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
          className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">Start</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
        </div>
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">End</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none" />
        </div>
      </div>

      {/* Window sizes */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            IS Window (days)<Tip text="In-sample optimization window size in trading days. 252 = 1 year. Larger IS = more stable params but fewer OOS windows." />
          </label>
          <select value={isWindowDays} onChange={e => setIsWindowDays(Number(e.target.value))}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none">
            {[126, 189, 252, 378, 504].map(v => (
              <option key={v} value={v}>{v} days ({Math.round(v / 21)}mo)</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            OOS Window (days)<Tip text="Out-of-sample validation window size. 63 = 1 quarter. Smaller OOS = more windows = better statistical coverage." />
          </label>
          <select value={oosWindowDays} onChange={e => setOosWindowDays(Number(e.target.value))}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none">
            {[21, 42, 63, 126].map(v => (
              <option key={v} value={v}>{v} days ({Math.round(v / 21)}mo)</option>
            ))}
          </select>
        </div>
      </div>

      {/* Mode + Optimizer */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            Mode<Tip text="Rolling: fixed IS size slides forward. Anchored: IS expands from a fixed start. Rolling is preferred when you expect regime changes over time." />
          </label>
          <select value={mode} onChange={e => setMode(e.target.value as 'rolling' | 'anchored')}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none">
            <option value="rolling">Rolling</option>
            <option value="anchored">Anchored</option>
          </select>
        </div>
        <div>
          <label className="text-[11px] text-text-tertiary uppercase block mb-1">
            Optimizer<Tip text="GA: genetic algorithm finds signal weight combinations. Sweep: exhaustive grid over TP/SL/score. GA is preferred for WF as it's faster per window." />
          </label>
          <select value={optimizer} onChange={e => setOptimizer(e.target.value as 'ga' | 'sweep')}
            className="w-full bg-[#111] border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-accent-green/50 focus:outline-none">
            <option value="ga">GA Optimize</option>
            <option value="sweep">Grid Sweep</option>
          </select>
        </div>
      </div>

      {/* Window count preview */}
      <div className="text-[10px] text-text-tertiary">
        {estimatedWindows > 0
          ? `~${estimatedWindows} OOS windows (${isWindowDays}d IS / ${oosWindowDays}d OOS, ${mode})`
          : 'Date range too short for selected window sizes'}
        {estimatedWindows < 5 && estimatedWindows > 0 && <span className="text-amber-400 ml-1">— 5+ windows recommended</span>}
      </div>

      <button onClick={handleRun} disabled={loading || estimatedWindows < 1}
        className="w-full py-2.5 rounded-lg font-medium text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-50 bg-blue-600 text-white hover:bg-blue-500"
      >
        {loading
          ? <><Zap size={16} className="animate-pulse" /> {progressPhase}... {progress}%</>
          : <><TrendingUp size={16} /> Walk-Forward ({estimatedWindows} windows)</>}
      </button>
    </div>
  );
};

// ── Walk-Forward Results ─────────────────────────────────

const WalkForwardResultView: React.FC<{ result: WalkForwardResult }> = ({ result }) => {
  const { oosAnalytics, oosTrades, windows, wfEfficiency } = result;
  const effLabel = wfEfficiency >= 0.7 ? 'Low overfitting' : wfEfficiency >= 0.4 ? 'Moderate overfitting' : 'High overfitting';

  return (
    <div className="space-y-4">
      {/* Header stats */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-blue-300 uppercase tracking-wider font-medium">Walk-Forward OOS Results</span>
          <span className="text-[10px] text-text-tertiary">{windows.length} windows · {result.totalEvals} evals · {(result.elapsedMs / 1000).toFixed(1)}s</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="WF Efficiency" value={`${(wfEfficiency * 100).toFixed(0)}%`}
            sub={effLabel}
            good={wfEfficiency >= 0.7} />
          <Stat label="OOS Win Rate" value={`${oosAnalytics.winRateTheta.toFixed(1)}%`} good={oosAnalytics.winRateTheta > 50} />
          <Stat label="OOS Sharpe" value={oosAnalytics.sharpe.toFixed(2)} good={oosAnalytics.sharpe > 0.5} />
          <Stat label="OOS Trades" value={oosTrades.length} sub={`${windows.length} windows`} />
        </div>
        <div className="text-[10px] text-text-tertiary">
          WF Efficiency = OOS fitness / IS fitness. {'>'} 70% = strategy generalizes well. {'<'} 40% = likely overfitted.
        </div>
      </div>

      {/* OOS equity curve */}
      <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
        <h3 className="text-sm font-medium mb-2">OOS Equity Curve (concatenated)</h3>
        <EquityCurveSVG curves={[{ data: oosAnalytics.equityCurve, color: '#3b82f6', label: 'OOS (forward-test)' }]} />
      </div>

      {/* IS vs OOS per-window table */}
      <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
        <h3 className="text-sm font-medium mb-2">Per-Window IS vs OOS</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-text-tertiary text-[10px] uppercase border-b border-white/5">
                <th className="text-left py-1 px-1.5">Window</th>
                <th className="text-right py-1 px-1.5">IS Period</th>
                <th className="text-right py-1 px-1.5">OOS Period</th>
                <th className="text-right py-1 px-1.5">IS Sharpe</th>
                <th className="text-right py-1 px-1.5">OOS Win%</th>
                <th className="text-right py-1 px-1.5">OOS Trades</th>
                <th className="text-right py-1 px-1.5">Efficiency</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((w, i) => {
                const eff = w.isBestFitness > 0 ? w.oosResult.analytics.sharpe / w.isBestFitness : 0;
                return (
                  <tr key={i} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-1 px-1.5 font-mono text-text-tertiary">{i + 1}</td>
                    <td className="py-1 px-1.5 font-mono text-[9px] text-text-tertiary">{w.isStart} → {w.isEnd}</td>
                    <td className="py-1 px-1.5 font-mono text-[9px] text-text-tertiary">{w.oosStart} → {w.oosEnd}</td>
                    <td className="py-1 px-1.5 font-mono text-right">{w.isBestFitness.toFixed(2)}</td>
                    <td className={`py-1 px-1.5 font-mono text-right ${w.oosResult.analytics.winRateTheta > 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {w.oosResult.analytics.winRateTheta.toFixed(0)}%
                    </td>
                    <td className="py-1 px-1.5 font-mono text-right text-text-tertiary">{w.oosResult.analytics.totalTrades}</td>
                    <td className={`py-1 px-1.5 font-mono text-right ${eff >= 0.7 ? 'text-emerald-400' : eff >= 0.4 ? 'text-amber-400' : 'text-red-400'}`}>
                      {(eff * 100).toFixed(0)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <AnalyticsGrid a={oosAnalytics} />
    </div>
  );
};

// ── IS vs OOS Comparison ─────────────────────────────────

const ISvsOOSView: React.FC<{ isResult: BacktestResult; oosResult: BacktestResult }> = ({ isResult, oosResult }) => {
  const isSharpe = isResult.analytics.sharpe;
  const oosSharpe = oosResult.analytics.sharpe;
  const wfEfficiency = isSharpe > 0 ? oosSharpe / isSharpe : 0;

  const rows: { label: string; is: string; oos: string; good?: boolean }[] = [
    { label: 'Win Rate', is: `${isResult.analytics.winRateTheta.toFixed(1)}%`, oos: `${oosResult.analytics.winRateTheta.toFixed(1)}%`, good: oosResult.analytics.winRateTheta > 50 },
    { label: 'Sharpe', is: isSharpe.toFixed(2), oos: oosSharpe.toFixed(2), good: oosSharpe > 0.5 },
    { label: 'Profit Factor', is: isResult.analytics.profitFactor === Infinity ? '∞' : isResult.analytics.profitFactor.toFixed(2), oos: oosResult.analytics.profitFactor === Infinity ? '∞' : oosResult.analytics.profitFactor.toFixed(2), good: oosResult.analytics.profitFactor > 1.2 },
    { label: 'Max DD', is: `${isResult.analytics.maxDrawdown.toFixed(1)}%`, oos: `${oosResult.analytics.maxDrawdown.toFixed(1)}%`, good: oosResult.analytics.maxDrawdown < 15 },
    { label: 'Trades', is: String(isResult.analytics.totalTrades), oos: String(oosResult.analytics.totalTrades) },
    { label: 'Avg Return', is: `${isResult.analytics.avgReturnTheta >= 0 ? '+' : ''}${isResult.analytics.avgReturnTheta.toFixed(2)}%`, oos: `${oosResult.analytics.avgReturnTheta >= 0 ? '+' : ''}${oosResult.analytics.avgReturnTheta.toFixed(2)}%`, good: oosResult.analytics.avgReturnTheta > 0 },
  ];

  return (
    <div className="space-y-3">
      {/* WF Efficiency banner */}
      <div className={`rounded-lg border p-3 ${wfEfficiency >= 0.7 ? 'bg-emerald-500/10 border-emerald-500/30' : wfEfficiency >= 0.4 ? 'bg-amber-500/10 border-amber-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium">WF Efficiency (OOS Sharpe / IS Sharpe)</span>
          <span className={`text-lg font-mono font-bold ${wfEfficiency >= 0.7 ? 'text-emerald-400' : wfEfficiency >= 0.4 ? 'text-amber-400' : 'text-red-400'}`}>{(wfEfficiency * 100).toFixed(0)}%</span>
        </div>
        <div className="text-[10px] text-text-tertiary mt-1">
          {wfEfficiency >= 0.7 ? '✓ Strategy generalizes well — low overfitting risk' :
           wfEfficiency >= 0.4 ? '⚠ Moderate decay — acceptable for signal-based strategies' :
           '✗ OOS significantly worse than IS — params likely overfit to training data'}
        </div>
      </div>

      {/* Side-by-side comparison table */}
      <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-tertiary border-b border-white/5">
              <th className="text-left py-1.5 px-2">Metric</th>
              <th className="text-right py-1.5 px-2 text-amber-400">IS (train)</th>
              <th className="text-right py-1.5 px-2 text-blue-400">OOS (test)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label} className="border-b border-white/5">
                <td className="py-1.5 px-2 text-text-tertiary">{r.label}</td>
                <td className="text-right py-1.5 px-2 font-mono text-amber-300/80">{r.is}</td>
                <td className={`text-right py-1.5 px-2 font-mono ${r.good === true ? 'text-emerald-400' : r.good === false ? 'text-red-400' : 'text-blue-300/80'}`}>{r.oos}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Overlaid equity curves */}
      <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
        <h3 className="text-sm font-medium mb-2">Equity Curves</h3>
        <EquityCurveSVG curves={[
          { data: isResult.analytics.equityCurve, color: '#f59e0b', label: 'IS (train)' },
          { data: oosResult.analytics.equityCurve, color: '#3b82f6', label: 'OOS (test)' },
        ]} />
      </div>
    </div>
  );
};

// ── Analytics Display ───────────────────────────────────

const AnalyticsGrid: React.FC<{ a: BacktestAnalytics }> = ({ a }) => (
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
    <Stat label="Trades" value={a.totalTrades} sub={`${a.totalSignals} signals`} />
    <Stat label="Win Rate" value={`${(a.optionMode ? a.optionWinRate! : a.winRate).toFixed(1)}%`} good={(a.optionMode ? a.optionWinRate! : a.winRate) > 50}
      sub={a.optionMode ? `stock: ${a.stockWinRate?.toFixed(1)}%` : `θ: ${a.winRateTheta.toFixed(1)}%`} />
    <Stat label="Avg Return" value={`${(a.optionMode ? a.optionAvgReturn! : a.avgReturn) >= 0 ? '+' : ''}${(a.optionMode ? a.optionAvgReturn! : a.avgReturn).toFixed(2)}%`} good={(a.optionMode ? a.optionAvgReturn! : a.avgReturn) > 0}
      sub={a.optionMode ? `stock: ${(a.stockAvgReturn ?? 0) >= 0 ? '+' : ''}${a.stockAvgReturn?.toFixed(2)}%` : `θ: ${a.avgReturnTheta.toFixed(2)}%`} />
    <Stat label="Profit Factor" value={(() => { const pf = a.optionMode ? a.optionProfitFactor! : a.profitFactor; return pf === Infinity ? '∞' : pf.toFixed(2); })()}
      good={(a.optionMode ? a.optionProfitFactor! : a.profitFactor) > 1.5}
      sub={a.optionMode ? `stock: ${a.stockProfitFactor === Infinity ? '∞' : a.stockProfitFactor?.toFixed(2)}` : undefined} />
    <Stat label="Sharpe" value={(a.optionMode ? a.optionSharpe! : a.sharpe).toFixed(2)} good={(a.optionMode ? a.optionSharpe! : a.sharpe) > 1}
      sub={a.optionMode ? `stock: ${a.stockSharpe?.toFixed(2)}` : undefined} />
    <Stat label="Max DD" value={`${(a.optionMode ? a.optionMaxDrawdown! : a.maxDrawdown).toFixed(1)}%`} good={(a.optionMode ? a.optionMaxDrawdown! : a.maxDrawdown) < 10}
      sub={a.optionMode ? `stock: ${a.maxDrawdown.toFixed(1)}%` : undefined} />
    <Stat label="Avg Win" value={`+${a.avgWin.toFixed(2)}%`} good />
    <Stat label="Avg Loss" value={`${a.avgLoss.toFixed(2)}%`} good={false} />
    <Stat label="Avg Hold" value={`${a.avgHoldDays.toFixed(1)}d`}
      sub={a.optionMode ? `exp: ${a.optionExpectancy?.toFixed(2)}%/t` : undefined} />
    <Stat label="TP Hits" value={a.tpHits} sub={`${a.totalTrades > 0 ? ((a.tpHits / a.totalTrades) * 100).toFixed(0) : 0}%`} />
    <Stat label="SL Hits" value={a.slHits} sub={`${a.totalTrades > 0 ? ((a.slHits / a.totalTrades) * 100).toFixed(0) : 0}%`} />
    <Stat label="Time Stops" value={a.timeStops} sub={`${a.totalTrades > 0 ? ((a.timeStops / a.totalTrades) * 100).toFixed(0) : 0}%`} />
    {a.scoreStops > 0 && <Stat label="Score Stops" value={a.scoreStops} sub={`${a.totalTrades > 0 ? ((a.scoreStops / a.totalTrades) * 100).toFixed(0) : 0}%`} />}
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
  const hasTicker = trades.some(t => t.ticker);
  const hasOption = trades.some(t => t.optionReturn != null);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-tertiary text-[10px] uppercase">
              {hasTicker && <th className="text-left py-1 px-1.5">Ticker</th>}
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
              {hasOption && <th className="text-right py-1 px-1.5">Opt Ret</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((t, i) => (
              <tr key={i} className="border-t border-white/5 hover:bg-white/5">
                {hasTicker && <td className="py-1 px-1.5 font-medium">{t.ticker}</td>}
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
                <td className={`py-1 px-1.5 ${t.exitType === 'TP' ? 'text-emerald-400' : t.exitType === 'SL' ? 'text-red-400' : t.exitType === 'SCORE_STOP' ? 'text-orange-400' : 'text-yellow-400'}`}>
                  {t.exitType}
                </td>
                <td className="py-1 px-1.5 text-right font-mono text-text-tertiary">{t.holdDays}d</td>
                <td className={`py-1 px-1.5 text-right font-mono ${t.rawReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {(t.rawReturn * 100).toFixed(2)}%
                </td>
                <td className={`py-1 px-1.5 text-right font-mono ${t.thetaAdjReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {(t.thetaAdjReturn * 100).toFixed(2)}%
                </td>
                {hasOption && (
                  <td className={`py-1 px-1.5 text-right font-mono ${(t.optionReturn ?? 0) >= 0 ? 'text-purple-400' : 'text-red-400'}`}>
                    {t.optionReturn != null ? `${(t.optionReturn * 100).toFixed(1)}%` : '—'}
                  </td>
                )}
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
    // Deduplicate by indicator options — keep best Sharpe per unique weight config
    const seen = new Map<string, BacktestResult>();
    for (const r of results) {
      if (r.analytics.totalTrades < 3) continue;
      const key = JSON.stringify(r.config.indicatorOptions);
      const existing = seen.get(key);
      if (!existing || r.analytics.sharpe > existing.analytics.sharpe) seen.set(key, r);
    }
    const arr = Array.from(seen.values());
    switch (sortKey) {
      case 'sharpe': return arr.sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
      case 'winRate': return arr.sort((a, b) => b.analytics.winRateTheta - a.analytics.winRateTheta);
      case 'pf': return arr.sort((a, b) => b.analytics.profitFactor - a.analytics.profitFactor);
      case 'trades': return arr.sort((a, b) => b.analytics.totalTrades - a.analytics.totalTrades);
    }
  }, [results, sortKey]);

  const isBest = (r: BacktestResult) => best && JSON.stringify(r.config.indicatorOptions) === JSON.stringify(best.config.indicatorOptions);

  return (
    <div>
      <div className="flex gap-1 mb-2">
        {(['sharpe', 'winRate', 'pf', 'trades'] as const).map(k => (
          <button key={k} onClick={() => setSortKey(k)}
            className={`text-[10px] px-1.5 py-0.5 rounded ${sortKey === k ? 'bg-purple-500/20 text-purple-400' : 'text-text-tertiary hover:text-white'}`}
          >{{ sharpe: 'Sharpe', winRate: 'Win%', pf: 'PF', trades: 'Trades' }[k]}</button>
        ))}
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

  return (
    <div>
      <div className="flex gap-1 mb-2">
        {(['sharpe', 'winRate', 'pf', 'dd'] as const).map(k => (
          <button key={k} onClick={() => setSortKey(k)}
            className={`text-[10px] px-1.5 py-0.5 rounded ${sortKey === k ? 'bg-accent-green/20 text-accent-green' : 'text-text-tertiary hover:text-white'}`}
          >{{ sharpe: 'Sharpe', winRate: 'Win%', pf: 'PF', dd: 'Drawdown' }[k]}</button>
        ))}
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

const GateStatsBar: React.FC<{ analytics: BacktestAnalytics }> = ({ analytics }) => {
  const gs = analytics.gateStats;
  if (!gs) return null;
  const total = gs.adxFiltered + gs.rvolFiltered + gs.coherenceAdjusted + gs.squeezeAdjusted;
  if (total === 0) return null;
  return (
    <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-2 flex flex-wrap gap-3 text-[11px]">
      <span className="text-cyan-400 font-medium">Quality Gates:</span>
      {gs.adxFiltered > 0 && <span className="text-text-secondary">ADX filtered: <b className="text-cyan-300">{gs.adxFiltered}</b></span>}
      {gs.rvolFiltered > 0 && <span className="text-text-secondary">RVOL filtered: <b className="text-cyan-300">{gs.rvolFiltered}</b></span>}
      {gs.coherenceAdjusted > 0 && <span className="text-text-secondary">Coherence adj: <b className="text-cyan-300">{gs.coherenceAdjusted}</b></span>}
      {gs.squeezeAdjusted > 0 && <span className="text-text-secondary">Squeeze adj: <b className="text-cyan-300">{gs.squeezeAdjusted}</b></span>}
    </div>
  );
};

/** Per-ticker breakdown for multi-ticker optimize results */
const TickerBreakdown: React.FC<{ trades: BacktestTrade[] }> = ({ trades }) => {
  const byTicker = new Map<string, BacktestTrade[]>();
  for (const t of trades) {
    const tk = t.ticker ?? '—';
    const arr = byTicker.get(tk);
    if (arr) arr.push(t); else byTicker.set(tk, [t]);
  }
  if (byTicker.size <= 1 && byTicker.has('—')) return null;

  const rows = Array.from(byTicker.entries()).map(([ticker, tt]) => {
    const wins = tt.filter(t => t.thetaAdjReturn > 0).length;
    const wr = tt.length > 0 ? (wins / tt.length) * 100 : 0;
    const avgRet = tt.length > 0 ? tt.reduce((s, t) => s + t.thetaAdjReturn * 100, 0) / tt.length : 0;
    return { ticker, count: tt.length, winRate: wr, avgReturn: avgRet };
  }).sort((a, b) => b.count - a.count);

  return (
    <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
      <h3 className="text-sm font-medium mb-2">By Ticker</h3>
      <table className="w-full text-xs">
        <thead><tr className="text-text-tertiary border-b border-white/5">
          <th className="text-left py-1 px-1.5">Ticker</th>
          <th className="text-right py-1 px-1.5">Trades</th>
          <th className="text-right py-1 px-1.5">Win Rate</th>
          <th className="text-right py-1 px-1.5">Avg Return</th>
        </tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.ticker} className="border-b border-white/5">
            <td className="py-1 px-1.5 font-medium">{r.ticker}</td>
            <td className="text-right py-1 px-1.5 font-mono">{r.count}</td>
            <td className={`text-right py-1 px-1.5 font-mono ${r.winRate > 50 ? 'text-green-400' : 'text-red-400'}`}>{r.winRate.toFixed(1)}%</td>
            <td className={`text-right py-1 px-1.5 font-mono ${r.avgReturn >= 0 ? 'text-green-400' : 'text-red-400'}`}>{r.avgReturn >= 0 ? '+' : ''}{r.avgReturn.toFixed(2)}%</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
};

const MonteCarloBar: React.FC<{ analytics: BacktestAnalytics }> = ({ analytics }) => {
  const mc = analytics.monteCarlo;
  if (!mc) return null;
  const bb = mc.blockBootstrap;
  return (
    <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3 space-y-2">
      <h3 className="text-sm font-medium">Monte Carlo</h3>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="MC Sharpe p50" value={mc.sharpe.p50.toFixed(2)} sub={`[${mc.sharpe.p5.toFixed(2)}, ${mc.sharpe.p95.toFixed(2)}]`} good={mc.sharpe.p50 > 0.5} />
        <Stat label="MC DD p50" value={`${mc.maxDrawdown.p50.toFixed(1)}%`} sub={`[${mc.maxDrawdown.p5.toFixed(1)}%, ${mc.maxDrawdown.p95.toFixed(1)}%]`} />
        <Stat label="Significant" value={mc.isSignificant ? 'Yes' : 'No'} good={mc.isSignificant} sub={`p5 Sharpe: ${mc.sharpe.p5.toFixed(2)}`} />
      </div>
      {bb && (
        <>
          <div className="text-[10px] text-text-tertiary border-t border-white/5 pt-1.5">Block Bootstrap (block={bb.blockSize})</div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <Stat label="BB Sharpe p50" value={bb.sharpe.p50.toFixed(2)} sub={`[${bb.sharpe.p5.toFixed(2)}, ${bb.sharpe.p95.toFixed(2)}]`} good={bb.sharpe.p50 > 0.5} />
            <Stat label="BB DD p50" value={`${bb.maxDrawdown.p50.toFixed(1)}%`} sub={`[${bb.maxDrawdown.p5.toFixed(1)}%, ${bb.maxDrawdown.p95.toFixed(1)}%]`} />
            <Stat label="BB Significant" value={bb.isSignificant ? 'Yes' : 'No'} good={bb.isSignificant} sub="p5 Sharpe > 0" />
          </div>
        </>
      )}
      {analytics.avgSubScoreCorrelation != null && (
        <div className="text-[10px] text-text-tertiary border-t border-white/5 pt-1.5">
          Avg sub-score correlation: <span className={analytics.avgSubScoreCorrelation > 0.3 ? 'text-amber-400' : 'text-emerald-400'}>{analytics.avgSubScoreCorrelation.toFixed(3)}</span>
          {analytics.avgSubScoreCorrelation > 0.3 && ' (high — GA fitness penalized)'}
        </div>
      )}
    </div>
  );
};

const SingleResultView: React.FC<{ result: BacktestResult }> = ({ result }) => {
  const { analytics, trades, config } = result;
  const hasMultiTicker = trades.some(t => t.ticker);

  return (
    <div className="space-y-4">
      <AnalyticsGrid a={analytics} />
      {hasMultiTicker && <TickerBreakdown trades={trades} />}
      <GateStatsBar analytics={analytics} />
      <MonteCarloBar analytics={analytics} />

      <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
        <h3 className="text-sm font-medium mb-2">Equity Curve</h3>
        <EquityCurveSVG curves={[
          { data: analytics.equityCurve, color: '#10b981', label: `${config.ticker} (stock)` },
          ...(analytics.optionEquityCurve?.length ? [{
            data: analytics.optionEquityCurve,
            color: '#8b5cf6',
            label: `${config.ticker} (option)`,
          }] : []),
        ]} />
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

// ── Export Results ──────────────────────────────────────

function buildExportPayload(
  bt: ReturnType<typeof useBacktest>,
  topTab: string,
  config: BacktestConfig,
  oosResult?: BacktestResult | null,
) {
  const fmtAnalytics = (a: BacktestAnalytics) => ({
    trades: a.totalTrades,
    signals: a.totalSignals,
    winRate: +a.winRate.toFixed(1),
    winRateTheta: +a.winRateTheta.toFixed(1),
    avgReturn: +a.avgReturn.toFixed(3),
    avgReturnTheta: +a.avgReturnTheta.toFixed(3),
    profitFactor: a.profitFactor === Infinity ? 999 : +a.profitFactor.toFixed(2),
    sharpe: +a.sharpe.toFixed(2),
    sortino: +((a as any).sortino ?? 0).toFixed(2),
    maxDrawdown: +((a as any).maxDrawdownPct ?? 0).toFixed(1),
    avgWin: +a.avgWin.toFixed(3),
    avgLoss: +a.avgLoss.toFixed(3),
    avgHoldDays: +a.avgHoldDays.toFixed(1),
    tpHits: a.tpHits,
    slHits: a.slHits,
    timeStops: a.timeStops,
    scoreStops: a.scoreStops,
    callStats: { count: a.callStats.count, winRate: +a.callStats.winRate.toFixed(1) },
    putStats: { count: a.putStats.count, winRate: +a.putStats.winRate.toFixed(1) },
    bySetup: Object.fromEntries(
      Object.entries(a.bySetup).map(([k, v]) => [k, { count: v.count, winRate: +v.winRate.toFixed(1), avgReturn: +v.avgReturn.toFixed(3) }])
    ),
  });

  const fmtConfig = (c: BacktestConfig) => ({
    ticker: c.ticker,
    startDate: c.startDate,
    endDate: c.endDate,
    timeframe: c.timeframe,
    tpAtr: c.tpAtr,
    slAtr: c.slAtr,
    minScore: c.minScore,
    minConfidence: c.minConfidence,
    thetaDecayRate: c.thetaDecayRate,
    scoreStopThreshold: c.scoreStopThreshold,
    weights: c.indicatorOptions ? {
      w_mb: c.indicatorOptions.w_mb,
      w_bxs: c.indicatorOptions.w_bxs,
      w_bxl: c.indicatorOptions.w_bxl,
      w_ema: c.indicatorOptions.w_ema,
      w_mom: c.indicatorOptions.w_mom,
    } : undefined,
    periods: c.indicatorOptions ? {
      sc_mb_len: c.indicatorOptions.sc_mb_len,
      sc_osc_len: c.indicatorOptions.sc_osc_len,
      sc_bx_s1: c.indicatorOptions.sc_bx_s1,
      sc_bx_s2: c.indicatorOptions.sc_bx_s2,
      sc_bx_l1: c.indicatorOptions.sc_bx_l1,
      sc_bx_l2: c.indicatorOptions.sc_bx_l2,
    } : undefined,
    optionMode: !!c.optionsPricing?.enabled,
    premiumTP: c.optionsPricing?.premiumTP,
    premiumSL: c.optionsPricing?.premiumSL,
    entryDTE: c.optionsPricing?.entryDTE,
    spreadType: c.optionsPricing?.spreadType,
    qualityGates: c.qualityGates ? {
      minADX: c.qualityGates.minADX,
      minRVOL: c.qualityGates.minRVOL,
      coherence: c.qualityGates.useCoherence,
      squeeze: c.qualityGates.useSqueeze,
    } : undefined,
  });

  const fmtTrade = (t: BacktestTrade) => ({
    ticker: t.ticker,
    entry: t.entryDate,
    exit: t.exitDate,
    dir: t.direction,
    setup: t.setup,
    score: t.score,
    conf: t.confidence,
    tier: t.tier,
    exitType: t.exitType,
    holdDays: t.holdDays,
    rawReturn: +(t.rawReturn * 100).toFixed(2),
    thetaReturn: +(t.thetaAdjReturn * 100).toFixed(2),
    optionReturn: t.optionReturn != null ? +(t.optionReturn * 100).toFixed(2) : undefined,
  });

  const payload: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    mode: topTab,
  };

  if (topTab === 'validate' && bt.singleResult) {
    payload.config = fmtConfig(config);
    payload.analytics = fmtAnalytics(bt.singleResult.analytics);
    payload.trades = bt.singleResult.trades.map(fmtTrade);
  }

  if (topTab === 'optimize' && bt.optimizeResult) {
    const best = bt.optimizeResult.bestOverall;
    const oos = oosResult;
    payload.gaStats = {
      totalEvals: bt.optimizeResult.totalCombos,
      generations: bt.optimizeResult.generationHistory?.length,
      elapsedMs: bt.optimizeResult.elapsedMs,
      configsWithTrades: bt.optimizeResult.results.filter(r => r.analytics.totalTrades >= 3).length,
    };
    if (best) {
      payload.bestConfig = fmtConfig(best.config);
      payload.isAnalytics = fmtAnalytics(best.analytics);
      payload.isTrades = best.trades.map(fmtTrade);
    }
    if (oos) {
      payload.oosAnalytics = fmtAnalytics(oos.analytics);
      payload.oosTrades = oos.trades.map(fmtTrade);
      const isSharpe = best?.analytics.sharpe ?? 0;
      const oosSharpe = oos.analytics.sharpe;
      payload.wfEfficiency = isSharpe > 0 ? +((oosSharpe / isSharpe) * 100).toFixed(1) : 0;
    }
    // Top 5 ranked configs (compact)
    payload.top5 = bt.optimizeResult.results.slice(0, 5).map(r => ({
      config: fmtConfig(r.config),
      sharpe: +r.analytics.sharpe.toFixed(2),
      winRate: +r.analytics.winRate.toFixed(1),
      pf: r.analytics.profitFactor === Infinity ? 999 : +r.analytics.profitFactor.toFixed(2),
      trades: r.analytics.totalTrades,
    }));
    // Generation history for convergence analysis
    if (bt.optimizeResult.generationHistory) {
      payload.generationHistory = bt.optimizeResult.generationHistory;
    }
  }

  if (topTab === 'walkforward' && bt.walkforwardResult) {
    const wf = bt.walkforwardResult;
    payload.wfConfig = {
      mode: wf.config.mode,
      isWindowDays: wf.config.isWindowDays,
      oosWindowDays: wf.config.oosWindowDays,
      optimizer: wf.config.optimizer,
    };
    payload.oosAnalytics = fmtAnalytics(wf.oosAnalytics);
    payload.wfEfficiency = +(wf.wfEfficiency * 100).toFixed(1);
    payload.windows = wf.windows.map(w => ({
      is: `${w.isStart} → ${w.isEnd}`,
      oos: `${w.oosStart} → ${w.oosEnd}`,
      isFitness: +w.isBestFitness.toFixed(3),
      oosConfig: fmtConfig(w.isBestConfig),
      oosSharpe: +w.oosResult.analytics.sharpe.toFixed(2),
      oosWR: +w.oosResult.analytics.winRate.toFixed(1),
      oosTrades: w.oosResult.analytics.totalTrades,
    }));
    payload.oosTrades = wf.oosTrades.map(fmtTrade);
  }

  return payload;
}

function downloadJSON(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main Page ───────────────────────────────────────────

type TopTab = 'validate' | 'optimize' | 'walkforward';

export const BacktestPage: React.FC = () => {
  const bt = useBacktest();
  const { updateSettings } = useAppSettings();
  const [topTab, setTopTab] = useState<TopTab>('validate');
  const [selectedSweepResult, setSelectedSweepResult] = useState<BacktestResult | null>(null);
  const [selectedOptResult, setSelectedOptResult] = useState<BacktestResult | null>(null);
  const [deployState, setDeployState] = useState<'idle' | 'deploying' | 'deployed'>('idle');

  const deployStrategy = useCallback(async (result: BacktestResult, source: string) => {
    setDeployState('deploying');
    try {
      const opts = result.config.indicatorOptions ?? {};
      await updateSettings({
        techScore: {
          weights: {
            w_mb: opts.w_mb ?? 25,
            w_bxs: opts.w_bxs ?? 20,
            w_bxl: opts.w_bxl ?? 15,
            w_ema: opts.w_ema ?? 12,
            w_mom: opts.w_mom ?? 8,
          },
          periods: {
            sc_mb_len: opts.sc_mb_len ?? 20,
            sc_mb_smoothing: opts.sc_mb_smoothing ?? 20,
            sc_osc_len: opts.sc_osc_len ?? 7,
            sc_bx_s1: opts.sc_bx_s1 ?? 5,
            sc_bx_s2: opts.sc_bx_s2 ?? 20,
            sc_bx_s3: opts.sc_bx_s3 ?? 15,
            sc_bx_l1: opts.sc_bx_l1 ?? 20,
            sc_bx_l2: opts.sc_bx_l2 ?? 15,
          },
        },
        strategy: {
          tpAtr: result.config.tpAtr,
          slAtr: result.config.slAtr,
          minScore: result.config.minScore,
          thetaDecayRate: result.config.thetaDecayRate,
          deployedAt: new Date().toISOString(),
          source,
        },
      });
      setDeployState('deployed');
      setTimeout(() => setDeployState('idle'), 3000);
    } catch {
      setDeployState('idle');
    }
  }, [updateSettings]);

  // Map top tab to backtest mode for the hook
  const handleRun = useCallback(() => {
    bt.setMode('validate');
    bt.run();
  }, [bt]);

  const handleRunSweep = useCallback((s: SweepConfig) => {
    bt.setMode('sweep');
    bt.runSweepAction(s);
  }, [bt]);

  const handleRunOptimize = useCallback((o: OptimizeConfig, oosDateRange?: OOSDateRange) => {
    bt.setMode('optimize');
    bt.runOptimizeAction(o, oosDateRange);
  }, [bt]);

  const handleRunWalkForward = useCallback((wf: WalkForwardConfig) => {
    bt.setMode('walkforward');
    bt.runWalkForwardAction(wf);
  }, [bt]);

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

      {/* Top-level tabs */}
      <div className="flex gap-1 mb-4 bg-[#111] rounded-lg p-0.5 w-fit">
        <button onClick={() => setTopTab('validate')}
          className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
            topTab === 'validate' ? 'bg-[#2A2A2A] text-white' : 'text-text-tertiary hover:text-text-secondary'
          }`}
        ><Play size={14} className="inline mr-1.5 -mt-0.5" />Validate</button>
        <button onClick={() => setTopTab('optimize')}
          className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
            topTab === 'optimize' ? 'bg-[#2A2A2A] text-white' : 'text-text-tertiary hover:text-text-secondary'
          }`}
        ><Rocket size={14} className="inline mr-1.5 -mt-0.5" />Optimize</button>
        <button onClick={() => setTopTab('walkforward')}
          className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
            topTab === 'walkforward' ? 'bg-[#2A2A2A] text-white' : 'text-text-tertiary hover:text-text-secondary'
          }`}
        ><TrendingUp size={14} className="inline mr-1.5 -mt-0.5" />Walk-Forward</button>
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
          {topTab === 'validate' && (
            <ValidatePanel
              config={bt.config}
              onChange={bt.setConfig}
              onRun={handleRun}
              loading={bt.loading && bt.mode === 'validate'}
              progress={bt.progress}
            />
          )}
          {topTab === 'optimize' && (
            <OptimizePanel
              config={bt.config}
              onChange={bt.setConfig}
              onRunSweep={handleRunSweep}
              onRunOptimize={handleRunOptimize}
              loading={bt.loading && (bt.mode === 'sweep' || bt.mode === 'optimize')}
              progress={bt.progress}
              progressPhase={bt.progressPhase}
            />
          )}
          {topTab === 'walkforward' && (
            <WalkForwardPanel
              config={bt.config}
              onRun={handleRunWalkForward}
              loading={bt.loading && bt.mode === 'walkforward'}
              progress={bt.progress}
              progressPhase={bt.progressPhase}
            />
          )}
        </div>

        {/* Right: Results */}
        <div className="space-y-4">
          {/* Progress panel — visible whenever loading */}
          {bt.loading && bt.progressPhase && (
            <ProgressPanel
              phase={bt.progressPhase}
              detail={bt.progressDetail}
              progress={bt.progress}
              elapsedMs={bt.elapsedMs}
              liveGenHistory={bt.liveGenHistory}
              genProgress={bt.genProgress}
              mode={bt.mode}
            />
          )}

          {/* Candle info */}
          {bt.candles && (
            <div className="text-xs text-text-tertiary flex gap-3">
              <span>{bt.candles.length} candles loaded</span>
              <span>{bt.candles[0]?.date} → {bt.candles[bt.candles.length - 1]?.date}</span>
            </div>
          )}

          {/* Comparison view */}
          <ComparisonView pinned={bt.pinned} onClear={bt.clearPins} />

          {/* Validate tab result */}
          {topTab === 'validate' && bt.singleResult && (
            <>
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    const payload = buildExportPayload(bt, 'validate', bt.config);
                    downloadJSON(payload, `validate-${bt.config.ticker}-${new Date().toISOString().slice(0, 10)}.json`);
                  }}
                  className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-white/5 hover:bg-white/10 text-text-secondary hover:text-white transition-colors"
                >
                  <Download size={12} />
                  Export
                </button>
              </div>
              <SingleResultView result={bt.singleResult} />
            </>
          )}

          {/* Optimize tab — sweep result */}
          {topTab === 'optimize' && bt.sweepResult && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-sm text-text-tertiary">
                <span>{bt.sweepResult.totalCombos} combos</span>
                <span>{bt.sweepResult.elapsedMs.toFixed(0)}ms</span>
                <span>{bt.sweepResult.results.filter(r => r.analytics.totalTrades >= 3).length} with 3+ trades</span>
              </div>

              <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
                <h3 className="text-sm font-medium mb-2">Ranked Results (Grid Sweep)</h3>
                <SweepTable
                  results={bt.sweepResult.results}
                  pinned={bt.pinned}
                  onPin={bt.togglePin}
                  onSelect={setSelectedSweepResult}
                  best={bt.sweepResult.bestOverall}
                />
              </div>

              {bt.sweepResult.bestOverall && (
                <button
                  onClick={() => deployStrategy(bt.sweepResult!.bestOverall!, 'sweep')}
                  disabled={deployState === 'deploying'}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded bg-accent-green/20 text-accent-green hover:bg-accent-green/30 disabled:opacity-50 transition-colors"
                >
                  <Upload size={13} />
                  {deployState === 'deploying' ? 'Deploying...' : deployState === 'deployed' ? 'Deployed \u2713' : 'Deploy Best'}
                </button>
              )}

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

          {/* Optimize tab — GA result */}
          {topTab === 'optimize' && bt.optimizeResult && (() => {
            const best = bt.optimizeResult.bestOverall;
            const oos = bt.oosResult;
            // Compute strategy grade from OOS metrics
            const oosWR = oos?.analytics.winRateTheta ?? 0;
            const oosSharpe = oos?.analytics.sharpe ?? 0;
            const oosPF = oos?.analytics.profitFactor ?? 0;
            const oosTrades = oos?.analytics.totalTrades ?? 0;
            const isSharpe = best?.analytics.sharpe ?? 0;
            const wfEff = isSharpe > 0 ? oosSharpe / isSharpe : 0;
            const grade = !oos ? null
              : (oosSharpe >= 1.0 && oosWR >= 50 && oosPF >= 1.5 && wfEff >= 0.6 && oosTrades >= 10) ? 'A'
              : (oosSharpe >= 0.5 && oosWR >= 45 && oosPF >= 1.2 && wfEff >= 0.4 && oosTrades >= 5) ? 'B'
              : (oosSharpe > 0 && oosWR >= 40 && oosPF >= 1.0 && wfEff >= 0.25) ? 'C'
              : 'F';
            const gradeColor = grade === 'A' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
              : grade === 'B' ? 'text-blue-400 border-blue-500/30 bg-blue-500/10'
              : grade === 'C' ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
              : 'text-red-400 border-red-500/30 bg-red-500/10';
            const gradeVerdict = grade === 'A' ? 'Strategy validated — strong OOS performance with good generalization'
              : grade === 'B' ? 'Strategy shows promise — decent OOS metrics, consider paper trading'
              : grade === 'C' ? 'Marginal — OOS positive but weak, needs more tickers or longer data'
              : grade === 'F' ? 'Not viable — strategy does not generalize to unseen data'
              : null;
            return (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-sm text-text-tertiary">
                <span>{bt.optimizeResult.totalCombos} evals{bt.optimizeResult.generationHistory ? ` over ${bt.optimizeResult.generationHistory.length} gens` : ''}</span>
                <span>{(bt.optimizeResult.elapsedMs / 1000).toFixed(1)}s</span>
                <span>{bt.optimizeResult.results.filter(r => r.analytics.totalTrades >= 3).length} with 3+ trades</span>
                <button
                  onClick={() => {
                    const payload = buildExportPayload(bt, 'optimize', bt.config, bt.oosResult);
                    downloadJSON(payload, `optimize-${new Date().toISOString().slice(0, 10)}.json`);
                  }}
                  className="ml-auto flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-white/5 hover:bg-white/10 text-text-secondary hover:text-white transition-colors"
                >
                  <Download size={12} />
                  Export
                </button>
              </div>

              {/* Strategy Grade Banner */}
              {grade && (
                <div className={`rounded-lg border p-4 ${gradeColor}`}>
                  <div className="flex items-center gap-3">
                    <span className="text-3xl font-bold font-mono">{grade}</span>
                    <div>
                      <div className="text-sm font-medium">{gradeVerdict}</div>
                      <div className="text-[10px] opacity-70 mt-0.5">
                        OOS: Sharpe {oosSharpe.toFixed(2)} · WR {oosWR.toFixed(0)}% · PF {oosPF === Infinity ? '∞' : oosPF.toFixed(2)} · {oosTrades} trades · WF Eff {(wfEff * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* IS vs OOS comparison — shown when OOS validation ran */}
              {oos && best && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-text-secondary uppercase tracking-wider font-medium">IS vs OOS Validation</span>
                    <span className="text-[10px] text-text-tertiary">Best IS params applied to unseen OOS period</span>
                  </div>
                  <ISvsOOSView isResult={best} oosResult={oos} />
                </div>
              )}

              {/* Best config — only show deploy when grade is A/B/C */}
              {best && (
                <div className={`rounded-lg p-3 ${grade === 'F' ? 'bg-red-500/5 border border-red-500/20' : 'bg-purple-500/10 border border-purple-500/30'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-[11px] uppercase tracking-wider ${grade === 'F' ? 'text-red-400' : 'text-purple-400'}`}>
                      {grade === 'F' ? 'Best Config (overfit — not deployable)' : oos ? 'OOS-Validated Config' : 'Best Signal Config (IS)'}
                    </span>
                    {!oos && <span className="text-[10px] text-text-tertiary ml-auto">Enable OOS split for forward-test</span>}
                  </div>
                  <div className="mb-2">
                    <IndicatorParamsLabel opts={best.config.indicatorOptions} />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {oos ? (
                      <>
                        <Stat label="OOS Win Rate" value={`${oosWR.toFixed(1)}%`} good={oosWR > 50} />
                        <Stat label="OOS Sharpe" value={oosSharpe.toFixed(2)} good={oosSharpe > 0.5} />
                        <Stat label="OOS PF" value={oosPF === Infinity ? '∞' : oosPF.toFixed(2)} good={oosPF > 1.2} />
                        <Stat label="OOS Trades" value={oosTrades} />
                      </>
                    ) : (
                      <>
                        <Stat label="IS Win Rate" value={`${best.analytics.winRateTheta.toFixed(1)}%`} good={best.analytics.winRateTheta > 50} />
                        <Stat label="IS Sharpe" value={best.analytics.sharpe.toFixed(2)} good={best.analytics.sharpe > 1} />
                        <Stat label="IS PF" value={best.analytics.profitFactor === Infinity ? '∞' : best.analytics.profitFactor.toFixed(2)} good={best.analytics.profitFactor > 1.5} />
                        <Stat label="IS Trades" value={best.analytics.totalTrades} />
                      </>
                    )}
                  </div>
                  {grade !== 'F' && (
                    <button
                      onClick={() => deployStrategy(best, 'ga-optimize')}
                      disabled={deployState === 'deploying'}
                      className="mt-2 flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 disabled:opacity-50 transition-colors"
                    >
                      <Upload size={13} />
                      {deployState === 'deploying' ? 'Deploying...' : deployState === 'deployed' ? 'Deployed ✓' : 'Deploy Strategy'}
                    </button>
                  )}
                </div>
              )}

              {/* Ranked configs — collapsed behind toggle when overfit */}
              <div className="bg-[#1A1A1A] rounded-lg border border-white/10 p-3">
                {grade === 'F' ? (
                  <details>
                    <summary className="text-sm font-medium mb-2 cursor-pointer text-text-tertiary hover:text-white">
                      Ranked Signal Configs (IS only — overfit) <span className="text-[10px] text-red-400/60 ml-2">click to expand</span>
                    </summary>
                    <OptimizeTable results={bt.optimizeResult.results} onSelect={setSelectedOptResult} best={best} />
                  </details>
                ) : (
                  <>
                    <h3 className="text-sm font-medium mb-2">{oos ? 'Signal Configs (ranked by IS fitness)' : 'Ranked Signal Configs'}</h3>
                    <OptimizeTable results={bt.optimizeResult.results} onSelect={setSelectedOptResult} best={best} />
                  </>
                )}
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
            );
          })()}

          {/* Walk-Forward tab result */}
          {topTab === 'walkforward' && bt.walkforwardResult && (
            <>
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    const payload = buildExportPayload(bt, 'walkforward', bt.config);
                    downloadJSON(payload, `walkforward-${new Date().toISOString().slice(0, 10)}.json`);
                  }}
                  className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-white/5 hover:bg-white/10 text-text-secondary hover:text-white transition-colors"
                >
                  <Download size={12} />
                  Export
                </button>
              </div>
              <WalkForwardResultView result={bt.walkforwardResult} />
            </>
          )}

          {/* Empty state */}
          {!bt.loading && !bt.singleResult && !bt.sweepResult && !bt.optimizeResult && !bt.walkforwardResult && (
            <div className="text-center py-16 text-text-tertiary">
              <FlaskConical size={48} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Configure parameters and run a backtest</p>
              <p className="text-xs mt-1"><b>Validate</b> — single run on full date range</p>
              <p className="text-xs"><b>Optimize</b> — multi-ticker GA with IS/OOS split (recommended)</p>
              <p className="text-xs"><b>Walk-Forward</b> — rolling IS/OOS windows, most robust validation</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
