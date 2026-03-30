import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, RefreshCw, X, Clock, ChevronDown, ChevronRight, Flame, TrendingUp } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useSignalScanner, type ScanTimeframe } from '../hooks/useSignalScanner';
import { useSignalHistory, type SignalHistoryRow } from '../hooks/useSignalHistory';
import { scaleIndicatorPeriods } from '../lib/backtest/intraday-signals';
import { usePositions } from '../hooks/usePositions';
import { useAppSettings } from '../context/AppSettingsContext';
import { STRATEGY_PROFILES } from '../lib/strategyProfiles';
import { useStrategyConfig, getConfigProfile } from '../lib/strategyConfig';
import { supabase } from '../lib/supabase';
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

// ── Status types ──────────────────────────────────────────
type SignalStatus = 'GO' | 'LOW_IV' | 'WEAK_TREND' | 'LOW_VOL' | 'WEAK_DIR' | 'INACTIVE';

interface DashboardRow {
  ticker: string;
  score: number;
  direction: 'CALL' | 'PUT' | 'NEUTRAL';
  confidence: number;
  close: number;
  dirConfidence: number;
  adx: number;
  rvol: number;
  iv30: number | null;
  streak: number;       // consecutive days signal fired (same direction)
  streakDir: string;    // direction of the streak
  firstFired: string;   // date the streak started
  status: SignalStatus;
  components: Record<string, number>;
  debug: Record<string, number | string>;
  signal: string;
}

// ── Helpers ───────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 90) return 'text-green-400';
  if (score >= 80) return 'text-yellow-400';
  if (score >= 70) return 'text-orange-400';
  return 'text-red-400';
}

function scoreBg(score: number): string {
  if (score >= 90) return 'bg-green-500/10';
  if (score >= 80) return 'bg-yellow-500/10';
  if (score >= 70) return 'bg-orange-500/10';
  return 'bg-red-500/10';
}

function dirBadge(type: 'CALL' | 'PUT' | 'NEUTRAL'): { label: string; cls: string } {
  if (type === 'CALL') return { label: 'CALL', cls: 'bg-green-500/20 text-green-400' };
  if (type === 'PUT') return { label: 'PUT', cls: 'bg-red-500/20 text-red-400' };
  return { label: 'NEUTRAL', cls: 'bg-white/10 text-[#888]' };
}

function statusBadge(status: SignalStatus): { label: string; cls: string } {
  switch (status) {
    case 'GO': return { label: 'GO', cls: 'bg-green-500/20 text-green-400 border border-green-500/30' };
    case 'LOW_IV': return { label: 'LOW IV', cls: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' };
    case 'WEAK_TREND': return { label: 'WEAK ADX', cls: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' };
    case 'LOW_VOL': return { label: 'LOW VOL', cls: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' };
    case 'WEAK_DIR': return { label: 'WEAK DIR', cls: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' };
    case 'INACTIVE': return { label: '\u2014', cls: 'text-[#555]' };
  }
}

function ivColor(iv: number | null): string {
  if (iv == null) return 'text-[#555]';
  if (iv >= 0.40) return 'text-green-400';
  if (iv >= 0.30) return 'text-green-400/70';
  if (iv >= 0.20) return 'text-yellow-400';
  return 'text-red-400';
}

function computeStatus(score: number, dir: string, iv: number | null, adx: number, rvol: number, dirConfidence: number, minScore: number, adxGate: number | null, minRvol: number, minIV: number, minDirConf: number): SignalStatus {
  if (score < minScore || dir === 'NEUTRAL') return 'INACTIVE';
  if (dirConfidence < minDirConf) return 'WEAK_DIR';
  if (adxGate != null && adx < adxGate) return 'WEAK_TREND';
  if (rvol < minRvol) return 'LOW_VOL';
  if (iv != null && iv < minIV) return 'LOW_IV';
  return 'GO';
}

// ── IV data hook ──────────────────────────────────────────

function useWatchlistIV(tickers: string[]) {
  return useQuery({
    queryKey: ['watchlist-iv', tickers],
    queryFn: async () => {
      // Fetch latest IV per ticker from orats_iv_cache
      const { data, error } = await supabase
        .from('orats_iv_cache')
        .select('ticker,iv30d,date')
        .in('ticker', tickers)
        .order('date', { ascending: false })
        .limit(tickers.length * 5); // recent days, more than enough
      if (error) throw error;
      // Deduplicate to latest per ticker
      const map = new Map<string, number>();
      for (const row of data ?? []) {
        if (!map.has(row.ticker) && row.iv30d != null) {
          // ORATS hist/cores iv30d is percentage (e.g. 24.3 = 24.3%); normalize to decimal
          map.set(row.ticker, Number(row.iv30d) / 100);
        }
      }
      return map;
    },
    staleTime: 5 * 60 * 1000,
    enabled: tickers.length > 0,
  });
}

// ── Live prices hook (ORATS real-time) ───────────────────

function useLivePrices(tickers: string[]) {
  return useQuery({
    queryKey: ['live-prices', tickers],
    queryFn: async () => {
      const res = await fetch(`/api/live-prices?tickers=${tickers.join(',')}`);
      if (!res.ok) throw new Error('Failed to fetch live prices');
      const data = await res.json();
      return data.prices as Record<string, number>;
    },
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000, // refresh every 2 min during market hours
    enabled: tickers.length > 0,
  });
}

// ── Signal streak hook ────────────────────────────────────

interface StreakInfo { days: number; direction: string; firstDate: string }

function useSignalStreaks(tickers: string[], minScore = 70) {
  return useQuery({
    queryKey: ['signal-streaks', tickers, minScore],
    queryFn: async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const { data, error } = await supabase
        .from('signal_history')
        .select('ticker,date,direction,score')
        .in('ticker', tickers)
        .gte('date', thirtyDaysAgo)
        .gte('score', minScore)
        .order('date', { ascending: false });
      if (error) throw error;

      const streaks = new Map<string, StreakInfo>();
      // Group by ticker
      const byTicker = new Map<string, Array<{ date: string; direction: string }>>();
      for (const row of data ?? []) {
        if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
        byTicker.get(row.ticker)!.push(row);
      }
      // For each ticker, count consecutive days from most recent with same direction
      for (const [ticker, rows] of byTicker) {
        if (rows.length === 0) continue;
        const dir = rows[0].direction;
        let streak = 1;
        for (let i = 1; i < rows.length; i++) {
          if (rows[i].direction !== dir) break;
          // Allow up to 4-day gap (weekends + holidays)
          const prev = new Date(rows[i - 1].date + 'T12:00:00Z');
          const curr = new Date(rows[i].date + 'T12:00:00Z');
          const diffDays = (prev.getTime() - curr.getTime()) / 86400000;
          if (diffDays > 4) break;
          streak++;
        }
        streaks.set(ticker, {
          days: streak,
          direction: dir,
          firstDate: rows[Math.min(streak - 1, rows.length - 1)].date,
        });
      }
      return streaks;
    },
    staleTime: 5 * 60 * 1000,
    enabled: tickers.length > 0,
  });
}

// ── Page ──────────────────────────────────────────────────

export const SignalsPage: React.FC = () => {
  const { settings } = useAppSettings();
  const { data: stratConfig } = useStrategyConfig();
  const scanner = useSignalScanner();
  const { data: positions } = usePositions();
  const [dirFilter, setDirFilter] = useState<'ALL' | 'CALL' | 'PUT'>('ALL');
  const [showFilter, setShowFilter] = useState<'ALL' | 'GO' | 'ACTIVE'>('ALL');
  const [tickerInput, setTickerInput] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const hasSeededWatchlist = useRef(false);
  const [tab, setTab] = useState<'dashboard' | 'history'>('dashboard');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activeBoard, setActiveBoard] = useState<'swing' | 'shortTerm' | 'dte5'>('dte5');

  // Dynamic config — reads from active board's profile
  const activeConfig = getConfigProfile(stratConfig, activeBoard);
  const MIN_SCORE = activeConfig.minScore;
  const MIN_IV = activeConfig.ivRankMin / 100;   // config is percentage (20), display needs decimal (0.20)
  const ADX_GATE = activeConfig.adxGate;          // null = disabled
  const MIN_RVOL = activeConfig.rvolGate;
  const MIN_DIR_CONF = activeConfig.minDirConfidence;

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

  // Seed scanner with full watchlist on mount (skip for DTE5 — QQQ only)
  useEffect(() => {
    if (hasSeededWatchlist.current) return;
    if (!positions) return;
    hasSeededWatchlist.current = true;

    if (activeBoard === 'dte5') {
      scanner.setTickers(['QQQ']);
      scanner.scan(techOptions, ['QQQ'], '1D');
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

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      scanner.clearCache();
      scanner.scan(techOptions, undefined, timeframe);
    }, 5 * 60 * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, timeframe]);

  // Re-scan when board changes
  useEffect(() => {
    if (!hasSeededWatchlist.current) return; // don't scan before initial seed
    scanner.clearCache();
    if (activeBoard === 'dte5') {
      scanner.setTickers(['QQQ']);
      scanner.scan(techOptions, ['QQQ'], '1D');
    } else {
      scanner.scan(techOptions, undefined, timeframe);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBoard]);

  // Fetch enrichment data
  const { data: ivMap } = useWatchlistIV(scanner.tickers);
  const { data: streakMap } = useSignalStreaks(scanner.tickers, MIN_SCORE);
  const { data: livePrices } = useLivePrices(scanner.tickers);

  // Build dashboard rows
  const dashboardRows = useMemo<DashboardRow[]>(() => {
    // Include all tickers, even those not yet scanned
    const scannedMap = new Map(scanner.signals.map(s => [s.ticker, s]));

    return scanner.tickers.map(ticker => {
      const sig = scannedMap.get(ticker);
      const iv = ivMap?.get(ticker) ?? null;
      const streak = streakMap?.get(ticker);

      if (!sig) {
        return {
          ticker,
          score: 0,
          direction: 'NEUTRAL' as const,
          confidence: 0,
          close: 0,
          dirConfidence: 0,
          adx: 0,
          rvol: 0,
          iv30: iv,
          streak: streak?.days ?? 0,
          streakDir: streak?.direction ?? '',
          firstFired: streak?.firstDate ?? '',
          status: 'INACTIVE' as const,
          components: {},
          debug: {},
          signal: '',
        };
      }

      const adx = (sig.result.debug?.adx as number) ?? 0;
      const rvol = (sig.result.debug?.rvol as number) ?? 0;
      const dirConf = sig.result.dirConfidence ?? 0;
      const emaScore = sig.result.components?.sc_mom ?? 50;
      const status = computeStatus(emaScore, sig.result.type, iv, adx, rvol, dirConf, MIN_SCORE, ADX_GATE, MIN_RVOL, MIN_IV, MIN_DIR_CONF);

      return {
        ticker,
        score: sig.result.components?.sc_mom ?? 50,
        direction: sig.result.type,
        confidence: sig.result.confidence,
        close: sig.lastClose,
        dirConfidence: dirConf,
        adx,
        rvol,
        iv30: iv,
        streak: streak?.days ?? 0,
        streakDir: streak?.direction ?? '',
        firstFired: streak?.firstDate ?? '',
        status,
        components: sig.result.components as unknown as Record<string, number>,
        debug: sig.result.debug as unknown as Record<string, number | string>,
        signal: sig.result.signal,
      };
    });
  }, [scanner.signals, scanner.tickers, ivMap, streakMap]);

  // Filter + sort
  const filtered = useMemo(() => {
    let rows = dashboardRows;
    if (dirFilter !== 'ALL') rows = rows.filter(r => r.direction === dirFilter);
    if (showFilter === 'GO') rows = rows.filter(r => r.status === 'GO');
    if (showFilter === 'ACTIVE') rows = rows.filter(r => r.status !== 'INACTIVE');

    // Sort: GO first, then active (LOW_IV etc), then inactive. Within group, by score desc.
    const statusOrder: Record<SignalStatus, number> = { GO: 0, LOW_IV: 1, WEAK_TREND: 1, LOW_VOL: 1, WEAK_DIR: 1, INACTIVE: 2 };
    return rows.sort((a, b) => {
      const oa = statusOrder[a.status], ob = statusOrder[b.status];
      if (oa !== ob) return oa - ob;
      return b.score - a.score;
    });
  }, [dashboardRows, dirFilter, showFilter]);

  const goCount = dashboardRows.filter(r => r.status === 'GO').length;
  const activeCount = dashboardRows.filter(r => r.status !== 'INACTIVE').length;

  const handleAddTickers = () => {
    const newTickers = tickerInput
      .toUpperCase()
      .split(/[,\s]+/)
      .map(t => t.trim())
      .filter(t => t && !scanner.tickers.includes(t));
    if (newTickers.length) {
      scanner.setTickers([...scanner.tickers, ...newTickers]);
      scanner.scanAdditional(newTickers, techOptions, timeframe);
    }
    setTickerInput('');
  };

  const handleRemoveTicker = (t: string) => {
    scanner.setTickers(scanner.tickers.filter(x => x !== t));
  };

  return (
    <div className="max-w-7xl mx-auto px-4 pb-24 sm:pb-6">
      {/* Board Toggle */}
      <div className="flex items-center gap-1 mb-4 bg-[#111] border border-[#333] rounded-lg p-1 w-fit">
        <button
          onClick={() => setActiveBoard('dte5')}
          className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
            activeBoard === 'dte5'
              ? 'bg-amber-500/20 text-amber-400'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          DTE5 (QQQ)
        </button>
        <button
          onClick={() => setActiveBoard('swing')}
          className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
            activeBoard === 'swing'
              ? 'bg-green-500/20 text-green-400'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          Swing (1D)
        </button>
        <button
          onClick={() => setActiveBoard('shortTerm')}
          className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
            activeBoard === 'shortTerm'
              ? 'bg-blue-500/20 text-blue-400'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          Short-Term (130M)
        </button>
      </div>

      {/* DTE5 Board — simplified QQQ-only view */}
      {activeBoard === 'dte5' && (() => {
        const qqqRow = scanner.signals.find(s => s.ticker === 'QQQ');
        const qqqClose = qqqRow?.lastClose ?? 0;
        const emaScore = qqqRow?.result.components.sc_ema ?? 0;
        const isBullish = qqqRow?.result.type === 'CALL';
        const isNeutral = qqqRow?.result.type === 'NEUTRAL';
        const gateStatus = isBullish ? 'BULL' : isNeutral ? 'NEUTRAL' : 'BEAR';
        const gateColor = isBullish ? 'text-emerald-400' : isNeutral ? 'text-yellow-400' : 'text-red-400';
        const gateBg = isBullish ? 'bg-emerald-500/10 border-emerald-500/30' : isNeutral ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-red-500/10 border-red-500/30';

        return (
          <div className="space-y-4">
            <div className="flex items-center gap-3 mb-4">
              <Radio size={24} className="text-amber-400" />
              <div>
                <h1 className="text-xl font-semibold">DTE5 Signal — QQQ Bull Put</h1>
                <p className="text-xs text-text-tertiary">EMA34 gate check — hold-to-expiry — sp25/15 — $1K paper</p>
              </div>
            </div>

            {/* QQQ Status Card */}
            <div className={`rounded-xl border ${gateBg} p-6`}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <span className="text-2xl font-bold">QQQ</span>
                  <span className="ml-3 text-lg text-text-secondary">${qqqClose.toFixed(2)}</span>
                </div>
                <span className={`px-4 py-2 rounded-lg text-sm font-bold ${gateBg} ${gateColor} border`}>
                  {gateStatus}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-text-tertiary text-xs">Direction</p>
                  <p className={`font-semibold ${gateColor}`}>{qqqRow?.result.type || '—'}</p>
                </div>
                <div>
                  <p className="text-text-tertiary text-xs">EMA Score</p>
                  <p className="font-semibold text-text-primary">{emaScore || '—'}</p>
                </div>
                <div>
                  <p className="text-text-tertiary text-xs">Dir Confidence</p>
                  <p className="font-semibold text-text-primary">{qqqRow?.result.dirConfidence ?? '—'}</p>
                </div>
                <div>
                  <p className="text-text-tertiary text-xs">ADX</p>
                  <p className="font-semibold text-text-primary">{qqqRow?.result.debug?.adx?.toFixed(0) ?? '—'}</p>
                </div>
              </div>

              {isBullish && (
                <div className="mt-4 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <p className="text-emerald-400 text-sm font-semibold">Signal Active — Open /selector to get DTE5 spread recommendation</p>
                </div>
              )}
              {!isBullish && (
                <div className="mt-4 p-3 rounded-lg bg-white/5 border border-white/10">
                  <p className="text-text-tertiary text-sm">No entry signal — QQQ not in bull regime. Wait for CALL direction.</p>
                </div>
              )}
            </div>

            {/* Scan button */}
            <button
              onClick={() => { scanner.clearCache(); scanner.scan(techOptions, ['QQQ'], '1D'); }}
              disabled={scanner.loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={13} className={scanner.loading ? 'animate-spin' : ''} />
              {scanner.loading ? `${scanner.progress}%` : 'Rescan QQQ'}
            </button>
          </div>
        );
      })()}

      {/* Legacy boards — full scanner view */}
      {activeBoard !== 'dte5' && <>

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Radio size={24} className={activeBoard === 'swing' ? 'text-accent-green' : 'text-blue-400'} />
          <div>
            <h1 className="text-xl font-semibold">Signal Dashboard</h1>
            <p className="text-xs text-text-tertiary">
              {presetKey.toUpperCase()} signal {activeBoard === 'shortTerm' ? '(130M \u00d7 2.25)' : '(1D)'}
              {' \u2022'} IV {'\u2265'} {activeConfig.ivRankMin}%
              {ADX_GATE != null ? ` \u2022 ADX \u2265 ${ADX_GATE}` : ''}
              {' \u2022'} RVOL {'\u2265'} {MIN_RVOL}
            </p>
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
            onClick={() => { scanner.clearCache(); scanner.scan(techOptions, undefined, timeframe); }}
            disabled={scanner.loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-accent-green/20 text-accent-green hover:bg-accent-green/30 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={13} className={scanner.loading ? 'animate-spin' : ''} />
            {scanner.loading ? `${scanner.progress}%` : 'Scan'}
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-4">
        <button
          onClick={() => setTab('dashboard')}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors flex items-center gap-1.5 ${
            tab === 'dashboard' ? 'bg-accent-green/20 text-accent-green' : 'bg-white/5 text-text-tertiary hover:text-white'
          }`}
        >
          <TrendingUp size={12} /> Dashboard
        </button>
        <button
          onClick={() => setTab('history')}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors flex items-center gap-1.5 ${
            tab === 'history' ? 'bg-accent-green/20 text-accent-green' : 'bg-white/5 text-text-tertiary hover:text-white'
          }`}
        >
          <Clock size={12} /> Signal History
        </button>
      </div>

      {/* 130M approximation warning */}
      {scanner.approxTickers.length > 0 && activeBoard === 'shortTerm' && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-xs text-yellow-400">
          <span className="font-medium">130M data approximated from 1H bars:</span>{' '}
          {scanner.approxTickers.join(', ')}.
          {' '}Run the prefetch script to cache precise 5-min data.
        </div>
      )}

      {tab === 'history' && <SignalHistoryTab />}

      {tab === 'dashboard' && <>
        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-[#1A1A1A] rounded-lg border border-white/10 px-4 py-3">
            <div className="text-2xl font-bold text-green-400">{goCount}</div>
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider">GO Signals</div>
          </div>
          <div className="bg-[#1A1A1A] rounded-lg border border-white/10 px-4 py-3">
            <div className="text-2xl font-bold text-yellow-400">{activeCount - goCount}</div>
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider">Filtered Out</div>
          </div>
          <div className="bg-[#1A1A1A] rounded-lg border border-white/10 px-4 py-3">
            <div className="text-2xl font-bold text-text-secondary">{scanner.tickers.length}</div>
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider">Watchlist</div>
          </div>
        </div>

        {/* Filter bar */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            {(['ALL', 'GO', 'ACTIVE'] as const).map(f => (
              <button
                key={f}
                onClick={() => setShowFilter(f)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  showFilter === f ? 'bg-accent-green/20 text-accent-green' : 'bg-white/5 text-text-tertiary hover:text-white'
                }`}
              >
                {f === 'ALL' ? `All (${dashboardRows.length})` : f === 'GO' ? `GO (${goCount})` : `Active (${activeCount})`}
              </button>
            ))}
          </div>
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
          <form onSubmit={e => { e.preventDefault(); handleAddTickers(); }} className="flex items-center gap-1 ml-auto">
            <input
              value={tickerInput}
              onChange={e => setTickerInput(e.target.value)}
              placeholder="Add tickers..."
              className="w-28 px-2 py-1 text-xs bg-[#111] border border-white/10 rounded focus:border-accent-green/50 outline-none"
            />
            <button type="submit" className="px-2 py-1 text-xs bg-white/5 rounded hover:bg-white/10">+</button>
          </form>
        </div>

        {/* Dashboard table */}
        <div className="bg-[#1A1A1A] rounded-lg border border-white/10 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-text-tertiary text-xs text-left">
                <th className="px-3 py-2 font-medium w-6"></th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Ticker</th>
                <th className="px-3 py-2 font-medium">Dir</th>
                <th className="px-3 py-2 font-medium text-right">Dir Conf</th>
                <th className="px-3 py-2 font-medium text-right">{presetKey.toUpperCase()}</th>
                <th className="px-3 py-2 font-medium text-right">IV</th>
                <th className="px-3 py-2 font-medium text-right">ADX</th>
                <th className="px-3 py-2 font-medium text-right">RVOL</th>
                <th className="px-3 py-2 font-medium text-center">Streak</th>
                <th className="px-3 py-2 font-medium text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !scanner.loading && (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-text-tertiary text-xs">
                    {scanner.signals.length === 0 ? 'Scanning...' : 'No signals match filters.'}
                  </td>
                </tr>
              )}
              {filtered.map(row => {
                const isExpanded = expanded === row.ticker;
                return (
                  <React.Fragment key={row.ticker}>
                    <DashboardRowView
                      row={row}
                      isExpanded={isExpanded}
                      onToggle={() => setExpanded(isExpanded ? null : row.ticker)}
                      livePrice={livePrices?.[row.ticker]}
                      adxGate={ADX_GATE}
                      minRvol={MIN_RVOL}
                    />
                    {isExpanded && (
                      <tr className="border-b border-white/5">
                        <td colSpan={11} className="px-4 py-3 bg-white/[0.02]">
                          <DashboardDetailPanel row={row} minScore={MIN_SCORE} minIV={MIN_IV} adxGate={ADX_GATE} minRvol={MIN_RVOL} minDirConf={MIN_DIR_CONF} signalLabel={presetKey.toUpperCase()} activeBoard={activeBoard} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Loading bar */}
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
              {scanner.failed.length} ticker{scanner.failed.length > 1 ? 's' : ''} failed:
            </p>
            <div className="flex flex-wrap gap-1">
              {scanner.failed.map(f => (
                <span key={f.ticker} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-red-500/10 text-red-400 rounded" title={f.reason}>
                  {f.ticker}
                </span>
              ))}
            </div>
            <button
              onClick={() => scanner.scanAdditional(scanner.failed.map(f => f.ticker), techOptions)}
              className="mt-2 text-[10px] text-accent-green hover:underline"
            >
              Retry failed
            </button>
          </div>
        )}

        {/* Ticker pills (collapsible) */}
        <details className="mt-3">
          <summary className="text-xs text-text-tertiary cursor-pointer hover:text-white">
            Manage watchlist ({scanner.tickers.length} tickers)
          </summary>
          <div className="mt-2 flex flex-wrap gap-1">
            {scanner.tickers.map(t => (
              <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-white/5 rounded border border-white/10">
                {t}
                {!WATCHLIST.includes(t) && (
                  <button onClick={() => handleRemoveTicker(t)} className="text-text-tertiary hover:text-white">
                    <X size={10} />
                  </button>
                )}
              </span>
            ))}
          </div>
        </details>
      </>}

      </>}
    </div>
  );
};

// ── Dashboard Row ─────────────────────────────────────────

const DashboardRowView: React.FC<{
  row: DashboardRow;
  isExpanded: boolean;
  onToggle: () => void;
  livePrice?: number;
  adxGate: number | null;
  minRvol: number;
}> = ({ row, isExpanded, onToggle, livePrice, adxGate, minRvol }) => {
  const dir = dirBadge(row.direction);
  const status = statusBadge(row.status);
  const isInactive = row.status === 'INACTIVE';

  return (
    <tr
      className={`border-b border-white/5 hover:bg-white/[0.02] transition-colors cursor-pointer ${
        isInactive ? 'opacity-40' : ''
      }`}
      onClick={onToggle}
    >
      <td className="px-2 py-2 text-text-tertiary">
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </td>
      <td className="px-3 py-2">
        <span className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded ${status.cls}`}>
          {status.label}
        </span>
      </td>
      <td className="px-3 py-2 font-medium">{row.ticker}</td>
      <td className="px-3 py-2">
        <span className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded ${dir.cls}`}>
          {dir.label}
        </span>
      </td>
      <td className={`px-3 py-2 text-right font-mono font-semibold ${
        row.dirConfidence >= 70 ? 'text-green-400' : row.dirConfidence >= 50 ? 'text-yellow-400' : 'text-red-400'
      }`}>
        {row.dirConfidence > 0 ? row.dirConfidence : '\u2014'}
      </td>
      <td className={`px-3 py-2 text-right font-mono font-semibold ${scoreColor(row.score)}`}>
        <span className={`inline-block px-1.5 py-0.5 rounded ${scoreBg(row.score)}`}>
          {row.score > 0 ? row.score.toFixed(0) : '\u2014'}
        </span>
      </td>
      <td className={`px-3 py-2 text-right font-mono ${ivColor(row.iv30)}`}>
        {row.iv30 != null ? `${(row.iv30 * 100).toFixed(0)}%` : '\u2014'}
      </td>
      <td className={`px-3 py-2 text-right font-mono ${adxGate == null || row.adx >= adxGate ? 'text-text-secondary' : 'text-red-400/60'}`}>
        {row.adx > 0 ? row.adx.toFixed(0) : '\u2014'}
      </td>
      <td className={`px-3 py-2 text-right font-mono ${row.rvol >= minRvol ? 'text-text-secondary' : 'text-red-400/60'}`}>
        {row.rvol > 0 ? row.rvol.toFixed(1) : '\u2014'}
      </td>
      <td className="px-3 py-2 text-center">
        {row.streak > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs font-mono">
            <Flame size={11} className={row.streak >= 3 ? 'text-orange-400' : 'text-text-tertiary'} />
            <span className={row.streak >= 3 ? 'text-orange-400 font-semibold' : 'text-text-secondary'}>
              {row.streak}d
            </span>
          </span>
        ) : (
          <span className="text-[#555]">{'\u2014'}</span>
        )}
      </td>
      <td className="px-3 py-2 text-right font-mono text-text-secondary">
        {(() => {
          const price = livePrice ?? (row.close > 0 ? row.close : null);
          if (price == null) return '\u2014';
          return (
            <span title={livePrice ? 'Live ORATS price' : 'Previous close'}>
              ${price.toFixed(2)}
              {livePrice && <span className="text-[9px] text-accent-green ml-1">●</span>}
            </span>
          );
        })()}
      </td>
    </tr>
  );
};

// ── Dashboard Detail Panel ────────────────────────────────

const DashboardDetailPanel: React.FC<{ row: DashboardRow; minScore: number; minIV: number; adxGate: number | null; minRvol: number; minDirConf: number; signalLabel: string; activeBoard: 'swing' | 'shortTerm' | 'dte5' }> = ({ row, minScore, minIV, adxGate, minRvol, minDirConf, signalLabel, activeBoard }) => {
  const navigate = useNavigate();
  const profile = STRATEGY_PROFILES[activeBoard];
  const isGo = row.status === 'GO';
  const dir = row.direction === 'CALL' ? 'BULL' : 'BEAR';
  const spreadType = row.direction === 'CALL' ? 'Bull Put Spread' : 'Bear Call Spread';

  return (
    <div className="space-y-3">
      {/* Criteria checklist */}
      <div>
        <h4 className="text-xs font-medium text-text-secondary mb-2">Entry Criteria</h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <CriteriaCheck label={`${signalLabel} \u2265 ${minScore}`} value={row.score} pass={row.score >= minScore} fmt={v => v.toFixed(0)} />
          <CriteriaCheck label={`IV \u2265 ${(minIV * 100).toFixed(0)}%`} value={row.iv30} pass={row.iv30 != null && row.iv30 >= minIV} fmt={v => v != null ? `${(v * 100).toFixed(0)}%` : 'n/a'} />
          {adxGate != null && (
            <CriteriaCheck label={`ADX \u2265 ${adxGate}`} value={row.adx} pass={row.adx >= adxGate} fmt={v => v.toFixed(1)} />
          )}
          <CriteriaCheck label={`RVOL \u2265 ${minRvol}`} value={row.rvol} pass={row.rvol >= minRvol} fmt={v => v.toFixed(2)} />
          <CriteriaCheck label={`Dir Conf \u2265 ${minDirConf}`} value={row.dirConfidence} pass={row.dirConfidence >= minDirConf} fmt={v => String(v)} />
        </div>
      </div>

      {/* Strategy GO card */}
      {isGo && row.streak > 0 && (
        <div className={`${activeBoard === 'swing' ? 'bg-green-500/5 border-green-500/20' : 'bg-blue-500/5 border-blue-500/20'} border rounded-lg px-4 py-3`}>
          <div className="flex items-center gap-2 mb-1">
            <span className={`${activeBoard === 'swing' ? 'text-green-400' : 'text-blue-400'} font-semibold text-sm`}>{spreadType}</span>
            <span className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded ${activeBoard === 'swing' ? 'bg-green-500/15 text-green-400' : 'bg-blue-500/15 text-blue-400'}`}>
              {activeBoard === 'swing' ? 'Swing' : 'ST'}
            </span>
          </div>
          <div className="text-xs text-text-secondary mb-2">{profile.subtitle}</div>
          <span className="text-[10px] text-text-tertiary">
            Signal active {row.streak}d (since {row.firstFired})
          </span>
        </div>
      )}

      {/* Indicators */}
      {row.debug && Object.keys(row.debug).length > 0 && (
        <div className="text-xs">
          <h4 className="font-medium text-text-secondary mb-1">Indicators</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-0.5">
            {Object.entries(row.debug)
              .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
              .slice(0, 12)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-text-tertiary">{k}</span>
                  <span className="font-mono">{typeof v === 'number' ? v.toFixed(2) : String(v)}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Build Spread CTA */}
      {row.status === 'GO' && (
        <div className="mt-3 pt-3 border-t border-white/10">
          {(() => {
            const p = new URLSearchParams({
              ticker: row.ticker,
              direction: dir,
              strategy: activeBoard,
              score: String(Math.round(row.score)),
              streak: String(row.streak),
              signalType: signalLabel,
              adx: String(row.adx.toFixed(1)),
              rvol: String(row.rvol.toFixed(2)),
            });
            if (row.iv30 != null) p.set('iv30d', String(row.iv30.toFixed(4)));
            const isSwing = activeBoard === 'swing';
            return (
              <button
                onClick={e => { e.stopPropagation(); navigate(`/selector?${p.toString()}`); }}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${
                  isSwing
                    ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                    : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                }`}
              >
                Build {isSwing ? 'Swing' : 'Short-Term'} Spread →
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
};

// ── Criteria check widget ─────────────────────────────────

function CriteriaCheck<T>({ label, value, pass, fmt }: { label: string; value: T; pass: boolean; fmt: (v: T) => string }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded text-xs ${
      pass ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20'
    }`}>
      <span className={pass ? 'text-green-400' : 'text-red-400'}>{pass ? '\u2713' : '\u2717'}</span>
      <div>
        <div className="text-text-tertiary">{label}</div>
        <div className={`font-mono font-semibold ${pass ? 'text-green-400' : 'text-red-400'}`}>
          {fmt(value)}
        </div>
      </div>
    </div>
  );
}

// ── Signal History Tab (unchanged) ────────────────────────

const SignalHistoryTab: React.FC = () => {
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  })();

  const [from, setFrom] = useState(thirtyDaysAgo);
  const [to, setTo] = useState(today);
  const [ticker, setTicker] = useState('');
  const [histMinScore, setHistMinScore] = useState(90);
  const [histDir, setHistDir] = useState<'CALL' | 'PUT' | ''>('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data, isLoading, error } = useSignalHistory({
    from,
    to,
    ticker: ticker || undefined,
    minScore: histMinScore || undefined,
    direction: histDir || undefined,
  });

  return (
    <>
      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-text-tertiary">
          From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="px-2 py-1 text-xs bg-[#111] border border-white/10 rounded focus:border-accent-green/50 outline-none" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-tertiary">
          To
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            className="px-2 py-1 text-xs bg-[#111] border border-white/10 rounded focus:border-accent-green/50 outline-none" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-tertiary">
          Ticker
          <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="All"
            className="w-20 px-2 py-1 text-xs bg-[#111] border border-white/10 rounded focus:border-accent-green/50 outline-none" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-tertiary">
          Min Score
          <input type="number" value={histMinScore} onChange={e => setHistMinScore(Number(e.target.value))} min={0} max={100}
            className="w-14 px-2 py-1 text-xs bg-[#111] border border-white/10 rounded focus:border-accent-green/50 outline-none" />
        </label>
        <div className="flex items-center gap-1">
          {(['', 'CALL', 'PUT'] as const).map(d => (
            <button key={d || 'ALL'} onClick={() => setHistDir(d)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                histDir === d ? 'bg-accent-green/20 text-accent-green' : 'bg-white/5 text-text-tertiary hover:text-white'
              }`}>
              {d || 'ALL'}
            </button>
          ))}
        </div>
        {data && (
          <span className="text-xs text-text-tertiary ml-auto">
            {data.length} signal{data.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-[#1A1A1A] rounded-lg border border-white/10 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-text-tertiary text-xs text-left">
              <th className="px-3 py-2 font-medium w-6"></th>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Ticker</th>
              <th className="px-3 py-2 font-medium">Direction</th>
              <th className="px-3 py-2 font-medium text-right">Score</th>
              <th className="px-3 py-2 font-medium text-center">Conf</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-text-tertiary text-xs">Loading...</td></tr>
            )}
            {error && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-red-400 text-xs">Error: {(error as Error).message}</td></tr>
            )}
            {!isLoading && !error && data?.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-text-tertiary text-xs">No signals in this range.</td></tr>
            )}
            {data?.map(row => {
              const dir = dirBadge(row.direction as 'CALL' | 'PUT' | 'NEUTRAL');
              const isExpanded = expanded === row.id;
              return (
                <React.Fragment key={row.id}>
                  <tr
                    className="border-b border-white/5 hover:bg-white/[0.02] transition-colors cursor-pointer"
                    onClick={() => setExpanded(isExpanded ? null : row.id)}
                  >
                    <td className="px-2 py-2 text-text-tertiary">
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-secondary font-mono">{row.date}</td>
                    <td className="px-3 py-2 font-medium">{row.ticker}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded ${dir.cls}`}>{dir.label}</span>
                    </td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${scoreColor(row.score)}`}>
                      <span className={`inline-block px-1.5 py-0.5 rounded ${scoreBg(row.score)}`}>
                        {row.score.toFixed(0)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {Array.from({ length: 3 }, (_, i) => (
                        <span key={i} className={i < row.confidence ? 'text-accent-green' : 'text-white/10'}>{'\u25CF'}</span>
                      ))}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="border-b border-white/5">
                      <td colSpan={6} className="px-4 py-3 bg-white/[0.02]">
                        <HistoryDetailPanel row={row} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};

const HistoryDetailPanel: React.FC<{ row: SignalHistoryRow }> = ({ row }) => {
  const components = row.components;
  const debug = row.debug;

  return (
    <div className="grid grid-cols-2 gap-4 text-xs">
      {components && (
        <div>
          <h4 className="font-medium text-text-secondary mb-1">Components</h4>
          <div className="space-y-0.5">
            {Object.entries(components).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-text-tertiary">{k}</span>
                <span className="font-mono">{typeof v === 'number' ? v.toFixed(2) : String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {debug && (
        <div>
          <h4 className="font-medium text-text-secondary mb-1">Debug</h4>
          <div className="space-y-0.5">
            {Object.entries(debug)
              .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
              .slice(0, 15)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-text-tertiary">{k}</span>
                  <span className="font-mono">{typeof v === 'number' ? v.toFixed(2) : String(v)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};
