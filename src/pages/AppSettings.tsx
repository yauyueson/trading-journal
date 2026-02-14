// src/pages/AppSettings.tsx
import React, { useState } from 'react';
import { useAppSettings } from '../context/AppSettingsContext';
import { AppSettings, DEFAULT_APP_SETTINGS, PORTFOLIO_BOUNDS } from '../lib/types/settings';
import { formatCurrency } from '../lib/utils';

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
      <h1 className="text-xl font-semibold text-white">App Settings</h1>
      {/* Portfolio / Risk */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Portfolio / Risk</h2>
          <button
            onClick={() => setDraft(d => ({ ...d, portfolio: DEFAULT_APP_SETTINGS.portfolio }))}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Reset defaults
          </button>
        </div>

        {/* Account Size */}
        <div>
          <label className="text-xs text-gray-400 mb-1.5 block uppercase tracking-wider">Account Size ($)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-mono">$</span>
            <input
              type="number" min={0} step={100}
              value={draft.portfolio.accountSize}
              onChange={e => setPortfolio({ accountSize: parseFloat(e.target.value) || 0 })}
              className="w-full bg-[#000] border border-[#333] text-white rounded-lg pl-8 pr-4 py-2.5 font-mono focus:outline-none focus:border-accent-green"
            />
          </div>
        </div>

        {/* Risk % */}
        <div>
          <label className="text-xs text-gray-400 mb-1.5 block uppercase tracking-wider">
            Risk per Trade ({MIN_RISK_PCT}%–{MAX_RISK_PCT}%)
          </label>
          <div className="flex items-center gap-3">
            <input type="range" min={MIN_RISK_PCT} max={MAX_RISK_PCT} step={0.1}
              value={draft.portfolio.riskPct}
              onChange={e => setPortfolio({ riskPct: parseFloat(e.target.value) })}
              className="flex-1 h-2 bg-[#222] rounded-lg appearance-none cursor-pointer accent-accent-green"
            />
            <input type="number" min={MIN_RISK_PCT} max={MAX_RISK_PCT} step={0.1}
              value={draft.portfolio.riskPct}
              onChange={e => setPortfolio({ riskPct: parseFloat(e.target.value) || MIN_RISK_PCT })}
              className="w-16 px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
            />
            <span className="text-gray-500 text-sm w-4">%</span>
          </div>
          <p className="text-xs text-gray-500 mt-1 font-mono">Risk cap: {formatCurrency(maxRiskPreview)}/trade</p>
        </div>
        {/* Stop-Out % */}
        <div>
          <label className="text-xs text-gray-400 mb-1.5 block uppercase tracking-wider">
            Stop-Out Level ({MIN_STOP_OUT_PCT}%–{MAX_STOP_OUT_PCT}% of max loss)
          </label>
          <div className="flex items-center gap-3">
            <input type="range" min={MIN_STOP_OUT_PCT} max={MAX_STOP_OUT_PCT} step={5}
              value={draft.portfolio.stopOutPct}
              onChange={e => setPortfolio({ stopOutPct: parseFloat(e.target.value) })}
              className="flex-1 h-2 bg-[#222] rounded-lg appearance-none cursor-pointer accent-accent-green"
            />
            <input type="number" min={MIN_STOP_OUT_PCT} max={MAX_STOP_OUT_PCT} step={5}
              value={draft.portfolio.stopOutPct}
              onChange={e => setPortfolio({ stopOutPct: parseFloat(e.target.value) || MIN_STOP_OUT_PCT })}
              className="w-16 px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
            />
            <span className="text-gray-500 text-sm w-4">%</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">Exit when loss reaches this % of max loss.</p>
        </div>
      </section>

      {/* Tech Score */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Tech Score Parameters</h2>
          <button
            onClick={() => setDraft(d => ({ ...d, techScore: DEFAULT_APP_SETTINGS.techScore }))}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Reset defaults
          </button>
        </div>
        {/* Weights */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400 uppercase tracking-wider">Weights</p>
            <span className={`text-xs font-mono ${Math.abs(weightSum - 100) > 0.01 ? 'text-accent-red' : 'text-accent-green'}`}>
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
                <label className="text-xs text-gray-500 mb-1 block">{label}</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} max={100} step={1}
                    value={draft.techScore.weights[key]}
                    onChange={e => setWeights({ [key]: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
                  />
                  <span className="text-gray-500 text-sm w-4">%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Periods */}
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Periods</p>
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
                <label className="text-xs text-gray-500 mb-1 block">{label}</label>
                <input type="number" min={1} max={200} step={1}
                  value={draft.techScore.periods[key]}
                  onChange={e => setPeriods({ [key]: parseInt(e.target.value) || 1 })}
                  className="w-full px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
                />
              </div>
            ))}
          </div>
        </div>
      </section>
      {/* Save Button */}
      <div className="sticky bottom-20 sm:bottom-0 sm:static pt-4 bg-bg-primary sm:bg-transparent">
        <button
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          className={`w-full py-3 rounded-lg font-medium text-sm transition-colors
            ${saveStatus === 'saving' ? 'bg-gray-700 text-gray-400 cursor-not-allowed' :
              saveStatus === 'saved' ? 'bg-accent-green/20 text-accent-green border border-accent-green' :
              saveStatus === 'error' ? 'bg-accent-red/20 text-accent-red border border-accent-red' :
              'bg-accent-green text-black hover:bg-accent-green/90'}`}
        >
          {saveStatus === 'saving' ? 'Saving…' :
           saveStatus === 'saved' ? 'Saved ✓' :
           saveStatus === 'error' ? 'Save failed — try again' :
           'Save Settings'}
        </button>
      </div>
    </div>
  );
};
