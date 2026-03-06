import React, { useState, useEffect, useRef } from 'react';
import { Radio, RefreshCw, X, Settings } from 'lucide-react';
import { useSignalScanner, type SignalRow } from '../hooks/useSignalScanner';
import { usePositions } from '../hooks/usePositions';
import { useAppSettings } from '../context/AppSettingsContext';
import { useNavigate } from 'react-router-dom';
import type { TechScoreOptions } from '../lib/tech-analysis';

// ── Helpers ──────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-400';
  if (score >= 70) return 'text-yellow-400';
  if (score >= 60) return 'text-orange-400';
  return 'text-red-400';
}

function scoreBg(score: number): string {
  if (score >= 80) return 'bg-green-500/10';
  if (score >= 70) return 'bg-yellow-500/10';
  if (score >= 60) return 'bg-orange-500/10';
  return 'bg-red-500/10';
}

function dirBadge(type: 'CALL' | 'PUT' | 'NEUTRAL'): { label: string; cls: string } {
  if (type === 'CALL') return { label: 'CALL', cls: 'bg-green-500/20 text-green-400' };
  if (type === 'PUT') return { label: 'PUT', cls: 'bg-red-500/20 text-red-400' };
  return { label: 'NEUTRAL', cls: 'bg-white/10 text-[#888]' };
}

// ── Page ─────────────────────────────────────────────────

export const SignalsPage: React.FC = () => {
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const scanner = useSignalScanner();
  const { data: positions } = usePositions();
  const [minScore, setMinScore] = useState(0);
  const [dirFilter, setDirFilter] = useState<'ALL' | 'CALL' | 'PUT'>('ALL');
  const [tickerInput, setTickerInput] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const hasSeededWatchlist = useRef(false);

  const hasDeployed = !!settings.strategy.deployedAt;

  // Build TechScoreOptions from deployed settings
  const techOptions: TechScoreOptions = {
    ...settings.techScore.weights,
    ...settings.techScore.periods,
  };

  // Seed scanner with watchlist tickers once positions load, then scan
  useEffect(() => {
    if (hasSeededWatchlist.current) return;
    // Wait for positions to load (undefined = loading, array = loaded)
    if (!positions) return;
    hasSeededWatchlist.current = true;

    const watchlistTickers = [...new Set(
      positions
        .filter(p => p.status === 'watchlist')
        .map(p => p.ticker.toUpperCase())
    )];

    // Merge watchlist tickers with defaults (dedup)
    const merged = [...new Set([...scanner.tickers, ...watchlistTickers])];
    scanner.setTickers(merged);
    // Pass merged list directly to avoid stale closure
    scanner.scan(techOptions, merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions]);

  // Auto-refresh interval
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      scanner.clearCache();
      scanner.scan(techOptions);
    }, 5 * 60 * 1000); // 5 min
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh]);

  const handleAddTickers = () => {
    const newTickers = tickerInput
      .toUpperCase()
      .split(/[,\s]+/)
      .map(t => t.trim())
      .filter(t => t && !scanner.tickers.includes(t));
    if (newTickers.length) {
      scanner.setTickers([...scanner.tickers, ...newTickers]);
      scanner.scanAdditional(newTickers, techOptions);
    }
    setTickerInput('');
  };

  const handleRemoveTicker = (t: string) => {
    scanner.setTickers(scanner.tickers.filter(x => x !== t));
  };

  // Filter signals
  const filtered = scanner.signals.filter(s => {
    if (s.result.techScore < minScore) return false;
    if (dirFilter !== 'ALL' && s.result.type !== dirFilter) return false;
    return true;
  });

  return (
    <div className="max-w-7xl mx-auto px-4 pb-24 sm:pb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Radio size={24} className="text-accent-green" />
          <div>
            <h1 className="text-xl font-semibold">Signal Scanner</h1>
            {hasDeployed ? (
              <p className="text-xs text-text-tertiary">
                Strategy deployed {new Date(settings.strategy.deployedAt).toLocaleDateString()} via {settings.strategy.source}
                {' \u2022 '}
                <button onClick={() => navigate('/settings')} className="text-accent-green hover:underline inline-flex items-center gap-1">
                  <Settings size={10} /> Settings
                </button>
              </p>
            ) : (
              <p className="text-xs text-text-tertiary">
                Using default params \u2014
                {' '}
                <button onClick={() => navigate('/backtest')} className="text-accent-green hover:underline">
                  run backtest to deploy optimized strategy
                </button>
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-text-tertiary cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="accent-accent-green"
            />
            Auto 5m
          </label>
          <button
            onClick={() => { scanner.clearCache(); scanner.scan(techOptions); }}
            disabled={scanner.loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-accent-green/20 text-accent-green hover:bg-accent-green/30 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={13} className={scanner.loading ? 'animate-spin' : ''} />
            {scanner.loading ? `${scanner.progress}%` : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Ticker management */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {scanner.tickers.map(t => (
            <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-white/5 rounded border border-white/10">
              {t}
              <button onClick={() => handleRemoveTicker(t)} className="text-text-tertiary hover:text-white">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
        <form onSubmit={e => { e.preventDefault(); handleAddTickers(); }} className="flex items-center gap-1">
          <input
            value={tickerInput}
            onChange={e => setTickerInput(e.target.value)}
            placeholder="Add tickers..."
            className="w-28 px-2 py-1 text-xs bg-[#111] border border-white/10 rounded focus:border-accent-green/50 outline-none"
          />
          <button type="submit" className="px-2 py-1 text-xs bg-white/5 rounded hover:bg-white/10">+</button>
        </form>
      </div>

      {/* Filters */}
      <div className="mb-4 flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs text-text-tertiary">
          Min Score
          <input
            type="number"
            value={minScore}
            onChange={e => setMinScore(Number(e.target.value))}
            min={0}
            max={100}
            className="w-14 px-2 py-1 text-xs bg-[#111] border border-white/10 rounded focus:border-accent-green/50 outline-none"
          />
        </label>
        <div className="flex items-center gap-1">
          {(['ALL', 'CALL', 'PUT'] as const).map(d => (
            <button
              key={d}
              onClick={() => setDirFilter(d)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                dirFilter === d ? 'bg-accent-green/20 text-accent-green' : 'bg-white/5 text-text-tertiary hover:text-white'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <span className="text-xs text-text-tertiary ml-auto">
          {filtered.length} signal{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Signal table */}
      <div className="bg-[#1A1A1A] rounded-lg border border-white/10 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-text-tertiary text-xs text-left">
              <th className="px-3 py-2 font-medium">Ticker</th>
              <th className="px-3 py-2 font-medium">Direction</th>
              <th className="px-3 py-2 font-medium text-right">Score</th>
              <th className="px-3 py-2 font-medium">Setup</th>
              <th className="px-3 py-2 font-medium text-center">Conf</th>
              <th className="px-3 py-2 font-medium">Signal</th>
              <th className="px-3 py-2 font-medium text-right">Close</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !scanner.loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-text-tertiary text-xs">
                  No signals found. Adjust filters or add tickers.
                </td>
              </tr>
            )}
            {filtered.map(row => {
              const dir = dirBadge(row.result.type);
              return (
                <SignalRowView key={row.ticker} row={row} dir={dir} />
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Loading overlay */}
      {scanner.loading && (
        <div className="mt-3">
          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-green transition-all duration-300"
              style={{ width: `${scanner.progress}%` }}
            />
          </div>
          <p className="text-xs text-text-tertiary mt-1">Scanning {scanner.tickers.length} tickers... {scanner.progress}%</p>
        </div>
      )}

      {/* Failed tickers */}
      {!scanner.loading && scanner.failed.length > 0 && (
        <div className="mt-3 p-3 bg-red-500/5 border border-red-500/20 rounded-lg">
          <p className="text-xs font-medium text-red-400 mb-1">
            {scanner.failed.length} ticker{scanner.failed.length > 1 ? 's' : ''} failed to load:
          </p>
          <div className="flex flex-wrap gap-1">
            {scanner.failed.map(f => (
              <span key={f.ticker} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-red-500/10 text-red-400 rounded" title={f.reason}>
                {f.ticker}
                <span className="text-red-400/50 max-w-[120px] truncate">{f.reason.includes('Rate limit') ? '(rate limit)' : '(error)'}</span>
              </span>
            ))}
          </div>
          <button
            onClick={() => scanner.scanAdditional(scanner.failed.map(f => f.ticker), techOptions)}
            className="mt-2 text-[10px] text-accent-green hover:underline"
          >
            Retry failed tickers
          </button>
        </div>
      )}
    </div>
  );
};

// ── Row Component ────────────────────────────────────────

const SignalRowView: React.FC<{ row: SignalRow; dir: { label: string; cls: string } }> = ({ row, dir }) => (
  <tr className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
    <td className="px-3 py-2 font-medium">{row.ticker}</td>
    <td className="px-3 py-2">
      <span className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded ${dir.cls}`}>{dir.label}</span>
    </td>
    <td className={`px-3 py-2 text-right font-mono font-semibold ${scoreColor(row.result.techScore)}`}>
      <span className={`inline-block px-1.5 py-0.5 rounded ${scoreBg(row.result.techScore)}`}>
        {row.result.techScore.toFixed(0)}
      </span>
    </td>
    <td className="px-3 py-2 text-xs text-text-secondary">{row.result.setup}</td>
    <td className="px-3 py-2 text-center">
      {Array.from({ length: 3 }, (_, i) => (
        <span key={i} className={i < row.result.confidence ? 'text-accent-green' : 'text-white/10'}>{'\u25CF'}</span>
      ))}
    </td>
    <td className="px-3 py-2 text-xs">{row.result.signal}</td>
    <td className="px-3 py-2 text-right font-mono text-text-secondary">${row.lastClose.toFixed(2)}</td>
  </tr>
);
