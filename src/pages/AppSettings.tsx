// src/pages/AppSettings.tsx
import React, { useState } from 'react';
import { useAppSettings } from '../context/AppSettingsContext';
import { AppSettings, DEFAULT_APP_SETTINGS, PORTFOLIO_BOUNDS } from '../lib/types/settings';
import { formatCurrency } from '../lib/utils';
import { getDefaultCreditSpreadConfig } from '../lib/strategyConfig';
import type { CreditSpreadConfig } from '../lib/types/settings';

const { MIN_RISK_PCT, MAX_RISK_PCT, MIN_STOP_OUT_PCT, MAX_STOP_OUT_PCT } = PORTFOLIO_BOUNDS;

export const AppSettingsPage: React.FC = () => {
  const { settings, updateSettings } = useAppSettings();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleSave = async () => {
    setSaveStatus('saving');
    try {
      await updateSettings(draft);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  const setPortfolio = (patch: Partial<typeof draft.portfolio>) =>
    setDraft(d => ({ ...d, portfolio: { ...d.portfolio, ...patch } }));

  const setWeights = (patch: Partial<typeof draft.techScore.weights>) =>
    setDraft(d => ({ ...d, techScore: { ...d.techScore, weights: { ...d.techScore.weights, ...patch } } }));

  const setPeriods = (patch: Partial<typeof draft.techScore.periods>) =>
    setDraft(d => ({ ...d, techScore: { ...d.techScore, periods: { ...d.techScore.periods, ...patch } } }));

  const weightSum = Object.values(draft.techScore.weights).reduce((a, b) => a + b, 0);
  const maxRiskPreview = (draft.portfolio.accountSize * draft.portfolio.riskPct) / 100;

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-8 pb-28 sm:pb-6">
      <h1 className="text-xl sm:text-2xl font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">▌ APP_SETTINGS</h1>
      {/* Portfolio / Risk */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-mono font-bold text-phosphor-green text-glow-green uppercase tracking-widest">▌ PORTFOLIO / RISK</h2>
          <button
            onClick={() => setDraft(d => ({ ...d, portfolio: DEFAULT_APP_SETTINGS.portfolio }))}
            className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary hover:text-phosphor-amber transition-colors cursor-pointer"
          >
            Reset defaults
          </button>
        </div>

        {/* Account Size */}
        <div>
          <label className="label-mono mb-1.5 block">Account Size ($)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary font-mono">$</span>
            <input
              type="number" min={0} step={100}
              value={draft.portfolio.accountSize}
              onChange={e => setPortfolio({ accountSize: parseFloat(e.target.value) || 0 })}
              className="w-full bg-bg-primary border border-white/[0.1] text-white rounded-lg pl-8 pr-4 py-2.5 font-mono focus:outline-none focus:border-phosphor-green/60"
            />
          </div>
        </div>

        {/* Risk % */}
        <div>
          <label className="label-mono mb-1.5 block">
            Risk per Trade ({MIN_RISK_PCT}%–{MAX_RISK_PCT}%)
          </label>
          <div className="flex items-center gap-3">
            <input type="range" min={MIN_RISK_PCT} max={MAX_RISK_PCT} step={0.1}
              value={draft.portfolio.riskPct}
              onChange={e => setPortfolio({ riskPct: parseFloat(e.target.value) })}
              className="flex-1 h-2 bg-bg-tertiary rounded-lg appearance-none cursor-pointer accent-phosphor-green"
            />
            <input type="number" min={MIN_RISK_PCT} max={MAX_RISK_PCT} step={0.1}
              value={draft.portfolio.riskPct}
              onChange={e => setPortfolio({ riskPct: parseFloat(e.target.value) || MIN_RISK_PCT })}
              className="w-16 px-2 py-1.5 bg-bg-primary border border-white/[0.1] rounded text-white font-mono text-sm focus:outline-none focus:border-phosphor-green/60"
            />
            <span className="text-text-tertiary font-mono text-sm w-4">%</span>
          </div>
          <p className="text-[11px] text-phosphor-amber font-mono mt-1">Risk cap: {formatCurrency(maxRiskPreview)}/trade</p>
        </div>
        {/* Stop-Out % */}
        <div>
          <label className="label-mono mb-1.5 block">
            Stop-Out Level ({MIN_STOP_OUT_PCT}%–{MAX_STOP_OUT_PCT}% of max loss)
          </label>
          <div className="flex items-center gap-3">
            <input type="range" min={MIN_STOP_OUT_PCT} max={MAX_STOP_OUT_PCT} step={5}
              value={draft.portfolio.stopOutPct}
              onChange={e => setPortfolio({ stopOutPct: parseFloat(e.target.value) })}
              className="flex-1 h-2 bg-bg-tertiary rounded-lg appearance-none cursor-pointer accent-phosphor-green"
            />
            <input type="number" min={MIN_STOP_OUT_PCT} max={MAX_STOP_OUT_PCT} step={5}
              value={draft.portfolio.stopOutPct}
              onChange={e => setPortfolio({ stopOutPct: parseFloat(e.target.value) || MIN_STOP_OUT_PCT })}
              className="w-16 px-2 py-1.5 bg-bg-primary border border-white/[0.1] rounded text-white font-mono text-sm focus:outline-none focus:border-phosphor-green/60"
            />
            <span className="text-text-tertiary font-mono text-sm w-4">%</span>
          </div>
          <p className="text-[11px] text-text-tertiary font-mono mt-1">Exit when loss reaches this % of max loss.</p>
        </div>
        {/* Min Open Interest */}
        <div>
          <label className="label-mono mb-1.5 block">
            Min Open Interest
          </label>
          <div className="flex items-center gap-3">
            <input type="number" min={0} max={1000} step={10}
              value={draft.portfolio.minOpenInterest}
              onChange={e => setPortfolio({ minOpenInterest: parseInt(e.target.value) || 0 })}
              className="w-24 px-2 py-1.5 bg-bg-primary border border-white/[0.1] rounded text-white font-mono text-sm focus:outline-none focus:border-phosphor-green/60"
            />
            <span className="text-text-tertiary font-mono text-sm">contracts</span>
          </div>
          <p className="text-[11px] text-text-tertiary font-mono mt-1">Minimum OI to show options in spread builder. WFA: lower is better (no OI filter optimal).</p>
        </div>
      </section>

      {/* Tech Score */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-mono font-bold text-phosphor-green text-glow-green uppercase tracking-widest">▌ TECH SCORE PARAMETERS</h2>
          <button
            onClick={() => setDraft(d => ({ ...d, techScore: DEFAULT_APP_SETTINGS.techScore }))}
            className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary hover:text-phosphor-amber transition-colors cursor-pointer"
          >
            Reset defaults
          </button>
        </div>
        {/* Weights */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="label-mono">▌ WEIGHTS</p>
            <span className={`text-xs font-mono ${Math.abs(weightSum - 100) > 0.01 ? 'text-phosphor-red text-glow-red' : 'text-phosphor-green text-glow-green'}`}>
              Sum: {weightSum}% {Math.abs(weightSum - 100) > 0.01 ? '⚠ must equal 100' : '✓'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {([
              ['w_mb', 'Market Bias'],
              ['w_bxs', 'B-X Short'],
              ['w_bxl', 'B-X Long'],
              ['w_ema', 'EMA Stack'],
              ['w_mom', 'Momentum'],
            ] as [keyof typeof draft.techScore.weights, string][]).map(([key, label]) => (
              <div key={key}>
                <label className="label-mono mb-1 block">{label}</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} max={100} step={1}
                    value={draft.techScore.weights[key]}
                    onChange={e => setWeights({ [key]: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2 py-1.5 bg-bg-primary border border-white/[0.1] rounded text-white font-mono text-sm focus:outline-none focus:border-phosphor-green/60"
                  />
                  <span className="text-text-tertiary font-mono text-sm w-4">%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Periods */}
        <div>
          <p className="label-mono mb-2">Periods</p>
          <div className="grid grid-cols-2 gap-3">
            {([
              ['sc_mb_len', 'Market Bias Length'],
              ['sc_mb_smoothing', 'MB Smoothing'],
              ['sc_osc_len', 'Oscillator Length'],
              ['sc_bx_s1', 'B-X Short L1'],
              ['sc_bx_s2', 'B-X Short L2'],
              ['sc_bx_s3', 'B-X Short L3'],
              ['sc_bx_l1', 'B-X Long L1'],
              ['sc_bx_l2', 'B-X Long L2'],
            ] as [keyof typeof draft.techScore.periods, string][]).map(([key, label]) => (
              <div key={key}>
                <label className="label-mono mb-1 block">{label}</label>
                <input type="number" min={1} max={200} step={1}
                  value={draft.techScore.periods[key]}
                  onChange={e => setPeriods({ [key]: parseInt(e.target.value) || 1 })}
                  className="w-full px-2 py-1.5 bg-bg-primary border border-white/[0.1] rounded text-white font-mono text-sm focus:outline-none focus:border-phosphor-green/60"
                />
              </div>
            ))}
          </div>
        </div>
      </section>
      {/* Credit Spread Strategy — Editable */}
      <CreditSpreadSection draft={draft} setDraft={setDraft} />
      {/* Save Button */}
      <div className="sticky bottom-20 sm:bottom-0 sm:static pt-4 bg-bg-primary sm:bg-transparent">
        <button
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          className={`w-full py-3 rounded-md font-mono uppercase tracking-widest text-sm transition-all cursor-pointer
            ${saveStatus === 'saving' ? 'bg-terminal-panel text-text-tertiary border border-border-default cursor-not-allowed' :
              saveStatus === 'saved' ? 'bg-phosphor-green/20 text-phosphor-green text-glow-green border border-phosphor-green' :
              saveStatus === 'error' ? 'bg-phosphor-red/20 text-phosphor-red text-glow-red border border-phosphor-red' :
              'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40 hover:bg-phosphor-green/20 hover:border-phosphor-green/70'}`}
        >
          {saveStatus === 'saving' ? '▌ SAVING…' :
           saveStatus === 'saved' ? '▌ SAVED ✓' :
           saveStatus === 'error' ? '▌ SAVE FAILED — TRY AGAIN' :
           '▌ SAVE SETTINGS'}
        </button>
      </div>
    </div>
  );
};

const SIGNAL_OPTIONS = ['vol', 'ema', 'mom', 'em'] as const;

const CreditSpreadSection: React.FC<{
  draft: AppSettings;
  setDraft: React.Dispatch<React.SetStateAction<AppSettings>>;
}> = ({ draft, setDraft }) => {
  const cs = draft.creditSpread ?? DEFAULT_APP_SETTINGS.creditSpread!;

  const setProfile = (key: 'swing' | 'shortTerm', patch: Partial<CreditSpreadConfig>) =>
    setDraft(d => ({
      ...d,
      creditSpread: {
        ...(d.creditSpread ?? DEFAULT_APP_SETTINGS.creditSpread!),
        [key]: { ...(d.creditSpread ?? DEFAULT_APP_SETTINGS.creditSpread!)[key], ...patch },
      },
    }));

  const resetProfile = (key: 'swing' | 'shortTerm') =>
    setDraft(d => ({
      ...d,
      creditSpread: {
        ...(d.creditSpread ?? DEFAULT_APP_SETTINGS.creditSpread!),
        [key]: getDefaultCreditSpreadConfig()[key],
      },
    }));

  const inputCls = 'w-full px-2 py-1.5 bg-bg-primary border border-white/[0.1] rounded text-white font-mono text-sm focus:outline-none focus:border-phosphor-green/60';

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xs font-mono font-bold text-phosphor-green text-glow-green uppercase tracking-widest">▌ CREDIT SPREAD STRATEGY</h2>
        <p className="text-[11px] text-text-tertiary font-mono mt-1">WFA-validated parameters. Changes persist to Supabase and take effect immediately.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {(['swing', 'shortTerm'] as const).map((key) => {
          const p = cs[key];
          const label = key === 'swing' ? 'Swing' : 'Short DTE';
          const isLocked = true;  // WFA v3: both swing and short-term params are locked
          const lockCls = isLocked ? ' opacity-60 cursor-not-allowed' : '';
          return (
            <div key={key} className="bg-bg-secondary border border-white/[0.1] rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-mono font-bold uppercase tracking-wider text-text-primary">{label}{isLocked && <span className="ml-2 text-[10px] text-phosphor-amber text-glow-amber font-normal">WFA v3 LOCKED</span>}</span>
                <button
                  onClick={() => resetProfile(key)}
                  className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary hover:text-phosphor-amber transition-colors cursor-pointer"
                >
                  Reset WFA defaults
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                {/* Signal Preset */}
                <div className="col-span-2">
                  <label className="label-mono mb-1 block">Signal Preset</label>
                  <select
                    value={p.signalPreset}
                    onChange={e => setProfile(key, { signalPreset: e.target.value })}
                    className={inputCls}
                  >
                    {SIGNAL_OPTIONS.map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}
                  </select>
                </div>
                {/* Delta */}
                <div>
                  <label className="label-mono mb-1 block">Delta</label>
                  <input type="number" min={0.1} max={0.5} step={0.01} value={p.defaultDelta}
                    onChange={e => setProfile(key, { defaultDelta: parseFloat(e.target.value) || 0.35 })}
                    disabled={isLocked}
                    className={inputCls + lockCls} />
                </div>
                {/* Width */}
                <div>
                  <label className="label-mono mb-1 block">Width ($)</label>
                  <input type="number" min={1} max={50} step={1} value={p.defaultWidth}
                    onChange={e => setProfile(key, { defaultWidth: parseFloat(e.target.value) || 1 })}
                    disabled={isLocked}
                    className={inputCls + lockCls} />
                </div>
                {/* DTE Min */}
                <div>
                  <label className="label-mono mb-1 block">DTE Min</label>
                  <input type="number" min={1} max={120} step={1} value={p.dteMin}
                    onChange={e => setProfile(key, { dteMin: parseInt(e.target.value) || 1 })}
                    className={inputCls} />
                </div>
                {/* DTE Max */}
                <div>
                  <label className="label-mono mb-1 block">DTE Max</label>
                  <input type="number" min={1} max={180} step={1} value={p.dteMax}
                    onChange={e => setProfile(key, { dteMax: parseInt(e.target.value) || 1 })}
                    className={inputCls} />
                </div>
                {/* DTE Peak */}
                <div>
                  <label className="label-mono mb-1 block">DTE Peak</label>
                  <input type="number" min={1} max={120} step={1} value={p.dtePeak}
                    onChange={e => setProfile(key, { dtePeak: parseInt(e.target.value) || 1 })}
                    className={inputCls} />
                </div>
                {/* Take Profit */}
                <div>
                  <label className="label-mono mb-1 block">Take Profit (%)</label>
                  <input type="number" min={5} max={90} step={5}
                    value={Math.round(p.profitTarget * 100)}
                    onChange={e => setProfile(key, { profitTarget: (parseInt(e.target.value) || 30) / 100 })}
                    disabled={isLocked}
                    className={inputCls + lockCls} />
                </div>
                {/* IV Rank Min */}
                <div>
                  <label className="label-mono mb-1 block">IV Rank Min (%)</label>
                  <input type="number" min={0} max={100} step={5} value={p.ivRankMin}
                    onChange={e => setProfile(key, { ivRankMin: parseInt(e.target.value) || 0 })}
                    disabled={isLocked}
                    className={inputCls + lockCls} />
                </div>
                {/* RVOL Gate */}
                <div>
                  <label className="label-mono mb-1 block">RVOL Gate</label>
                  <input type="number" min={0} max={5} step={0.1} value={p.rvolGate}
                    onChange={e => setProfile(key, { rvolGate: parseFloat(e.target.value) || 0 })}
                    className={inputCls} />
                </div>
                {/* Min Score */}
                <div>
                  <label className="label-mono mb-1 block">Min Score</label>
                  <input type="number" min={0} max={100} step={5} value={p.minScore}
                    onChange={e => setProfile(key, { minScore: parseInt(e.target.value) || 0 })}
                    className={inputCls} />
                </div>
                {/* Dir Confidence */}
                <div>
                  <label className="label-mono mb-1 block">Dir Confidence</label>
                  <input type="number" min={0} max={100} step={5} value={p.minDirConfidence}
                    onChange={e => setProfile(key, { minDirConfidence: parseInt(e.target.value) || 0 })}
                    disabled={isLocked}
                    className={inputCls + lockCls} />
                </div>
                {/* Time Stop DTE */}
                <div>
                  <label className="label-mono mb-1 block">Time Stop (DTE)</label>
                  <input type="number" min={0} max={30} step={1} value={p.timeStopDTE}
                    onChange={e => setProfile(key, { timeStopDTE: parseInt(e.target.value) || 0 })}
                    disabled={isLocked}
                    className={inputCls + lockCls} />
                </div>
                {/* Max Positions */}
                <div>
                  <label className="label-mono mb-1 block">Max Positions</label>
                  <input type="number" min={1} max={20} step={1} value={p.maxPositions}
                    onChange={e => setProfile(key, { maxPositions: parseInt(e.target.value) || 1 })}
                    className={inputCls} />
                </div>
                {/* Max Per Ticker */}
                <div>
                  <label className="label-mono mb-1 block">Max / Ticker</label>
                  <input type="number" min={1} max={10} step={1} value={p.maxPerTicker}
                    onChange={e => setProfile(key, { maxPerTicker: parseInt(e.target.value) || 1 })}
                    className={inputCls} />
                </div>
                {/* ADX Gate */}
                <div>
                  <label className="label-mono mb-1 block">ADX Gate</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={p.adxGate != null}
                      onChange={e => setProfile(key, { adxGate: e.target.checked ? 15 : null })}
                      className="accent-phosphor-green"
                    />
                    {p.adxGate != null && (
                      <input type="number" min={5} max={50} step={1} value={p.adxGate}
                        onChange={e => setProfile(key, { adxGate: parseInt(e.target.value) || 15 })}
                        className={inputCls + ' flex-1'} />
                    )}
                    {p.adxGate == null && <span className="text-gray-500">Disabled</span>}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
