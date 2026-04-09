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

        // WFA-validated bull-only signals: QQQ (Sharpe 1.29), SPY (0.85), IWM (0.76)
        // Exit: SL 2.5x credit, trailing lock 50/50, hold-to-expiry
        // Bears disabled: QQQ (15 trades/6yr), SPY (Grade D), IWM (negative Sharpe)
        const bullCriteria = (row: typeof scanner.signals[0] | undefined) => {
          const { close, e34 } = getEMAs(row);
          const pass = close > e34 && e34 > 0;
          return [
            { label: 'close > EMA34', pass, value: `$${close.toFixed(2)} ${pass ? '>' : '\u2264'} $${e34.toFixed(2)}` },
          ];
        };

        const DTE5_SIGNALS = [
          { ticker: 'QQQ', side: 'bull' as const, spread: 'sp30/20', label: 'Bull Put', recommended: true,
            note: 'WFA validated \u2014 OOS Sharpe 1.29, Holdout +0.18',
            criteria: bullCriteria },
          { ticker: 'SPY', side: 'bull' as const, spread: 'sp30/20', label: 'Bull Put', recommended: true,
            note: 'WFA validated \u2014 OOS Sharpe 0.85, Holdout +0.13',
            criteria: bullCriteria },
          { ticker: 'IWM', side: 'bull' as const, spread: 'sp30/20', label: 'Bull Put', recommended: true,
            note: 'WFA validated \u2014 OOS Sharpe 0.76, Holdout +1.42',
            criteria: bullCriteria },
        ];

        return (
          <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-lg font-semibold">Signals</h1>
                <p className="text-xs text-text-tertiary mt-0.5">DTE5 Bull Put · EMA34 gate · SL 2.5x · TL 50/50 · $1K live</p>
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

            {/* Bull signals — QQQ, SPY, IWM (WFA-validated) */}
            <div className="grid grid-cols-1 gap-6">

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

              {/* Bears disabled per WFA Phase 7: QQQ (15 trades/6yr), SPY (Grade D), IWM (negative Sharpe) */}
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

