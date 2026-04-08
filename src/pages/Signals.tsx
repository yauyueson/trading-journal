import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { useSignalScanner, type ScanTimeframe } from '../hooks/useSignalScanner';
import { scaleIndicatorPeriods } from '../lib/backtest/intraday-signals';
import { usePositions } from '../hooks/usePositions';
import { useAppSettings } from '../context/AppSettingsContext';
import { useStrategyConfig, getConfigProfile } from '../lib/strategyConfig';
import { SpreadPickerModal } from '../components/SpreadPickerModal';
import type { TechScoreOptions } from '../lib/tech-analysis';

// Signal preset weight maps — production subset of src/lib/backtest/types.ts SIGNAL_PRESETS
const SIGNAL_PRESETS: Record<string, TechScoreOptions> = {
  vol: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_adx: 0 },
  mom: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_adx: 0, w_vol: 0 },
  em:  { w_mb: 0, w_bxs: 0, w_bxl: 0, w_adx: 0, w_vol: 0 },
  ema: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_mom: 0, w_adx: 0, w_vol: 0 },
};

// ── Watchlist (same as cron scanner) ──────────────────────
const WATCHLIST = [
  'SPY', 'QQQ', 'GOOGL', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
  'AAPL', 'NVDA', 'AMD', 'COST', 'IREN', 'BA', 'AMZN', 'HOOD',
  'CRWV', 'COIN', 'MSTR', 'PLTR', 'AVGO', 'LULU', 'UBER', 'GS',
  'UNH', 'IWM', 'GLD',
];

// ── Page ──────────────────────────────────────────────────

export const SignalsPage: React.FC = () => {
  const { settings } = useAppSettings();
  const { data: stratConfig } = useStrategyConfig();
  const scanner = useSignalScanner();
  const { data: positions } = usePositions();
  const hasSeededWatchlist = useRef(false);
  const [activeBoard] = useState<'swing' | 'shortTerm' | 'dte5'>('dte5');
  const [pickerSignal, setPickerSignal] = useState<{ ticker: string; side: 'bull' | 'bear'; spread: string } | null>(null);

  // Dynamic config — reads from active board's profile
  const activeConfig = getConfigProfile(stratConfig, activeBoard);

  // Signal preset weights from active config, with period scaling for 4H
  const presetKey = activeConfig.signalPreset;
  const timeframe: ScanTimeframe = activeBoard === 'shortTerm' ? '130M' : '1D';
  const baseTechOptions: TechScoreOptions = {
    ...settings.techScore.periods,
    ...(SIGNAL_PRESETS[presetKey] || SIGNAL_PRESETS.vol),
  };
  const SHORT_TERM_PERIOD_MULT = 2.25;  // WFA locked: pm2.25 (130M)
  const techOptions: TechScoreOptions = activeBoard === 'shortTerm'
    ? scaleIndicatorPeriods(SHORT_TERM_PERIOD_MULT, baseTechOptions)
    : baseTechOptions;

  // Seed scanner with full watchlist on mount (DTE5 scans QQQ+SPY+IWM)
  useEffect(() => {
    if (hasSeededWatchlist.current) return;
    if (!positions) return;
    hasSeededWatchlist.current = true;

    if (activeBoard === 'dte5') {
      const dte5Tickers = ['QQQ', 'SPY', 'IWM'];
      scanner.setTickers(dte5Tickers);
      scanner.scan(techOptions, dte5Tickers, '1D');
    } else {
      const watchlistTickers = [...new Set(
        positions
          .filter(p => p.status === 'watchlist')
          .map(p => p.ticker.toUpperCase())
      )];
      const merged = [...new Set([...WATCHLIST, ...watchlistTickers])];
      scanner.setTickers(merged);
      scanner.scan(techOptions, merged, timeframe);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions]);

  // Re-scan when board changes
  useEffect(() => {
    if (!hasSeededWatchlist.current) return; // don't scan before initial seed
    scanner.clearCache();
    if (activeBoard === 'dte5') {
      const dte5Tickers = ['QQQ', 'SPY', 'IWM'];
      scanner.setTickers(dte5Tickers);
      scanner.scan(techOptions, dte5Tickers, '1D');
    } else {
      scanner.scan(techOptions, undefined, timeframe);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBoard]);

  return (
    <div className="max-w-7xl mx-auto stagger-fade-in">

      {/* DTE5 Board — Multi-ticker Bull + Bear */}
      {(() => {
        // Signal configs per ticker
        // Helper: extract real EMA values from debug
        const getEMAs = (row: typeof scanner.signals[0] | undefined) => {
          const d = row?.result.debug;
          return { close: row?.lastClose ?? 0, e21: d?.ema21 ?? 0, e34: d?.ema34 ?? 0, e55: d?.ema55 ?? 0 };
        };

        const DTE5_SIGNALS = [
          { ticker: 'QQQ', side: 'bull' as const, spread: 'sp30/20', label: 'Bull Put', recommended: true,
            note: 'Primary strategy — Sharpe 0.69 standalone',
            criteria: (row: typeof scanner.signals[0] | undefined) => {
              const { close, e34 } = getEMAs(row);
              const pass = close > e34 && e34 > 0;
              return [
                { label: 'close > EMA34', pass, value: `$${close.toFixed(2)} ${pass ? '>' : '≤'} $${e34.toFixed(2)}` },
              ];
            }},
          { ticker: 'QQQ', side: 'bear' as const, spread: 'sp40/30', label: 'Bear Call', recommended: true,
            note: '~3 trades/yr — tight proximity filter',
            criteria: (row: typeof scanner.signals[0] | undefined) => {
              const { close, e21, e34, e55 } = getEMAs(row);
              const tripleAligned = e21 > 0 && e21 < e34 && e34 < e55;
              const belowE21 = close < e21 && e21 > 0;
              const proxDist = e21 > 0 ? Math.abs(close - e21) / e21 : 1;
              const proxPass = belowE21 && proxDist <= 0.01;
              return [
                { label: 'EMA21 < EMA34 < EMA55', pass: tripleAligned, value: `${e21.toFixed(1)} ${tripleAligned ? '<' : '≥'} ${e34.toFixed(1)} ${tripleAligned ? '<' : '≥'} ${e55.toFixed(1)}` },
                { label: 'close < EMA21', pass: belowE21, value: `$${close.toFixed(2)} ${belowE21 ? '<' : '≥'} $${e21.toFixed(2)}` },
                { label: 'within 1% of EMA21', pass: proxPass, value: `${(proxDist * 100).toFixed(1)}% ${proxPass ? '≤' : '>'} 1%` },
              ];
            }},
          { ticker: 'SPY', side: 'bear' as const, spread: 'sp40/30', label: 'Bear Call', recommended: true,
            note: 'Primary bear engine — 114 trades, Sharpe 0.56',
            criteria: (row: typeof scanner.signals[0] | undefined) => {
              const { close, e21, e34, e55 } = getEMAs(row);
              const tripleAligned = e21 > 0 && e21 < e34 && e34 < e55;
              const belowE21 = close < e21 && e21 > 0;
              const proxDist = e21 > 0 ? Math.abs(close - e21) / e21 : 1;
              const proxPass = belowE21 && proxDist <= 0.05;
              return [
                { label: 'EMA21 < EMA34 < EMA55', pass: tripleAligned, value: `${e21.toFixed(1)} ${tripleAligned ? '<' : '≥'} ${e34.toFixed(1)} ${tripleAligned ? '<' : '≥'} ${e55.toFixed(1)}` },
                { label: 'close < EMA21', pass: belowE21, value: `$${close.toFixed(2)} ${belowE21 ? '<' : '≥'} $${e21.toFixed(2)}` },
                { label: 'within 5% of EMA21', pass: proxPass, value: `${(proxDist * 100).toFixed(1)}% ${proxPass ? '≤' : '>'} 5%` },
              ];
            }},
          { ticker: 'IWM', side: 'bear' as const, spread: 'sp15/05', label: 'Bear Call', recommended: false,
            note: 'Diversifier — Sharpe 0.58, adds hedging value',
            criteria: (row: typeof scanner.signals[0] | undefined) => {
              const { close, e21, e34, e55 } = getEMAs(row);
              const tripleAligned = e21 > 0 && e21 < e34 && e34 < e55;
              const belowE21 = close < e21 && e21 > 0;
              const proxDist = e21 > 0 ? Math.abs(close - e21) / e21 : 1;
              const proxPass = belowE21 && proxDist <= 0.03;
              return [
                { label: 'EMA21 < EMA34 < EMA55', pass: tripleAligned, value: `${e21.toFixed(1)} ${tripleAligned ? '<' : '≥'} ${e34.toFixed(1)} ${tripleAligned ? '<' : '≥'} ${e55.toFixed(1)}` },
                { label: 'close < EMA21', pass: belowE21, value: `$${close.toFixed(2)} ${belowE21 ? '<' : '≥'} $${e21.toFixed(2)}` },
                { label: 'within 3% of EMA21', pass: proxPass, value: `${(proxDist * 100).toFixed(1)}% ${proxPass ? '≤' : '>'} 3%` },
              ];
            }},
        ];

        return (
          <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-lg font-semibold">Signals</h1>
                <p className="text-xs text-text-tertiary mt-0.5">DTE5 EMA gate · hold-to-expiry · $10K equity</p>
              </div>
              <button
                onClick={() => { scanner.clearCache(); scanner.scan(techOptions, ['QQQ', 'SPY', 'IWM'], '1D'); }}
                disabled={scanner.loading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-white/[0.05] border border-white/[0.08] text-text-secondary hover:text-text-primary hover:bg-white/[0.08] disabled:opacity-50 transition-all duration-150"
              >
                <RefreshCw size={12} className={scanner.loading ? 'animate-spin' : ''} />
                {scanner.loading ? `${scanner.progress}%` : 'Scan'}
              </button>
            </div>

            {/* Two columns: Bull (left) | Bear (right) */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">

              {/* ── BULL column ── */}
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-1 h-4 rounded-full bg-emerald-400" />
                  <span className="text-sm font-semibold text-emerald-400">Bull Put</span>
                  <span className="text-xs text-text-tertiary">· Close &gt; EMA34</span>
                </div>
                <div className="space-y-3">
                  {DTE5_SIGNALS.filter(s => s.side === 'bull').map((sig, idx) => {
                    const row = scanner.signals.find(s => s.ticker === sig.ticker);
                    const close = row?.lastClose ?? 0;
                    const criteria = sig.criteria(row);
                    const allPass = criteria.every(c => c.pass);
                    return (
                      <div
                        key={idx}
                        className={`rounded-xl p-4 border transition-all duration-150 ${
                          allPass ? 'border-emerald-500/20 bg-emerald-500/[0.04] cursor-pointer hover:bg-emerald-500/[0.07]' : 'border-white/[0.06] bg-white/[0.02]'
                        }`}
                        onClick={allPass ? () => setPickerSignal({ ticker: sig.ticker, side: 'bull', spread: sig.spread }) : undefined}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="text-base font-bold">{sig.ticker}</span>
                            <span className="text-xs text-text-tertiary font-mono">{sig.spread}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-text-secondary font-mono">${close.toFixed(2)}</span>
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide uppercase ${
                              allPass ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20' : 'bg-white/[0.04] text-text-tertiary ring-1 ring-white/[0.06]'
                            }`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${allPass ? 'bg-emerald-400 pulse-glow' : 'bg-text-tertiary/30'}`} />
                              {allPass ? 'Active' : 'Off'}
                            </span>
                          </div>
                        </div>
                        <div className="space-y-1 mb-2">
                          {criteria.map((c, ci) => (
                            <div key={ci} className="flex items-center gap-1.5 text-[11px]">
                              <span className={c.pass ? 'text-emerald-400' : 'text-text-tertiary'}>{c.pass ? '✓' : '✗'}</span>
                              <span className={c.pass ? 'text-text-secondary' : 'text-text-tertiary'}>{c.value}</span>
                            </div>
                          ))}
                        </div>
                        <div className={`text-[11px] font-semibold ${allPass ? 'text-emerald-400' : 'text-text-tertiary'}`}>
                          {allPass ? 'Tap to open spread →' : (() => {
                            const failing = criteria.filter(c => !c.pass);
                            return `Waiting — ${failing.map(c => c.label).join(', ')} not met`;
                          })()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── BEAR column ── */}
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-1 h-4 rounded-full bg-rose-400" />
                  <span className="text-sm font-semibold text-rose-400">Bear Call</span>
                  <span className="text-xs text-text-tertiary">· EMA21 &lt; EMA34 &lt; EMA55 · Close &lt; EMA21</span>
                </div>
                <div className="space-y-3">
                  {DTE5_SIGNALS.filter(s => s.side === 'bear').map((sig, idx) => {
                    const row = scanner.signals.find(s => s.ticker === sig.ticker);
                    const close = row?.lastClose ?? 0;
                    const criteria = sig.criteria(row);
                    const allPass = criteria.every(c => c.pass);
                    return (
                      <div
                        key={idx}
                        className={`rounded-xl p-4 border transition-all duration-150 ${
                          allPass ? 'border-rose-500/20 bg-rose-500/[0.04] cursor-pointer hover:bg-rose-500/[0.07]' : 'border-white/[0.06] bg-white/[0.02]'
                        }`}
                        onClick={allPass ? () => setPickerSignal({ ticker: sig.ticker, side: 'bear', spread: sig.spread }) : undefined}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="text-base font-bold">{sig.ticker}</span>
                            <span className="text-xs text-text-tertiary font-mono">{sig.spread}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-text-secondary font-mono">${close.toFixed(2)}</span>
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide uppercase ${
                              allPass ? 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/20' : 'bg-white/[0.04] text-text-tertiary ring-1 ring-white/[0.06]'
                            }`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${allPass ? 'bg-rose-400' : 'bg-text-tertiary/30'}`} />
                              {allPass ? 'Active' : 'Off'}
                            </span>
                          </div>
                        </div>
                        <div className="space-y-1 mb-2">
                          {criteria.map((c, ci) => (
                            <div key={ci} className="flex items-center gap-1.5 text-[11px]">
                              <span className={c.pass ? 'text-rose-400' : 'text-text-tertiary'}>{c.pass ? '✓' : '✗'}</span>
                              <span className={c.pass ? 'text-text-secondary' : 'text-text-tertiary'}>{c.value}</span>
                            </div>
                          ))}
                        </div>
                        <div className={`text-[11px] font-semibold ${allPass ? 'text-rose-400' : 'text-text-tertiary'}`}>
                          {allPass ? 'Tap to open spread →' : (() => {
                            const failing = criteria.filter(c => !c.pass);
                            return `Waiting — ${failing.map(c => c.label).join(', ')} not met`;
                          })()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Entry timing */}
            <p className="text-[10px] text-text-tertiary mt-6">
              Entry: next morning 10:00-10:30 AM · Verify EMAs hold before entering
            </p>
          </div>
        );
      })()}

      <SpreadPickerModal signal={pickerSignal} onClose={() => setPickerSignal(null)} />
    </div>
  );
};

