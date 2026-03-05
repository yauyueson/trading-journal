/**
 * React hook for backtest state management.
 * Fetches candles, runs engine, manages sweep mode.
 */

import { useState, useCallback, useRef } from 'react';
import type {
  BacktestCandle,
  BacktestConfig,
  BacktestResult,
  SweepConfig,
  SweepResult,
} from '../lib/backtest/types';
import { DEFAULT_CONFIG } from '../lib/backtest/types';
import { runBacktest } from '../lib/backtest/engine';
import { runSweep, DEFAULT_SWEEP } from '../lib/backtest/sweep';

export interface TickerOptResult {
  ticker: string;
  sweep: SweepResult;
  candleCount: number;
  error?: string;
}

export type BacktestMode = 'single' | 'sweep' | 'optimize';

/** Subtract N calendar days (approximates trading days × 1.45 for weekends/holidays) */
function addTradingDaysBack(dateStr: string, tradingDays: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - Math.ceil(tradingDays * 1.45));
  return d.toISOString().split('T')[0];
}

interface UseBacktestReturn {
  // State
  config: BacktestConfig;
  setConfig: (c: BacktestConfig) => void;
  mode: BacktestMode;
  setMode: (m: BacktestMode) => void;
  loading: boolean;
  fetchingCandles: boolean;
  progress: number;
  error: string | null;
  // Results
  singleResult: BacktestResult | null;
  sweepResult: SweepResult | null;
  candles: BacktestCandle[] | null;
  // Pinned for comparison
  pinned: BacktestResult[];
  togglePin: (r: BacktestResult) => void;
  clearPins: () => void;
  // Optimize (multi-ticker)
  optimizeResults: TickerOptResult[];
  optimizeStatus: string;
  // Actions
  run: () => Promise<void>;
  runSweepAction: (sweepConfig: SweepConfig) => Promise<void>;
  runOptimize: (tickers: string[]) => Promise<void>;
}

export function useBacktest(): UseBacktestReturn {
  const [config, setConfig] = useState<BacktestConfig>(DEFAULT_CONFIG);
  const [mode, setMode] = useState<BacktestMode>('single');
  const [loading, setLoading] = useState(false);
  const [fetchingCandles, setFetchingCandles] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [singleResult, setSingleResult] = useState<BacktestResult | null>(null);
  const [sweepResult, setSweepResult] = useState<SweepResult | null>(null);
  const [candles, setCandles] = useState<BacktestCandle[] | null>(null);
  const [pinned, setPinned] = useState<BacktestResult[]>([]);
  const [optimizeResults, setOptimizeResults] = useState<TickerOptResult[]>([]);
  const [optimizeStatus, setOptimizeStatus] = useState('');

  const candlesCacheRef = useRef<Map<string, BacktestCandle[]>>(new Map());

  const fetchCandles = useCallback(async (ticker: string, from: string, to: string, timeframe: string, skipUIState?: boolean): Promise<BacktestCandle[]> => {
    const key = `${ticker}|${from}|${to}|${timeframe}`;
    const cached = candlesCacheRef.current.get(key);
    if (cached) return cached;

    if (!skipUIState) setFetchingCandles(true);
    try {
      const res = await fetch(`/api/backtest-candles?ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}&timeframe=${timeframe}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const c = data.candles as BacktestCandle[];
      candlesCacheRef.current.set(key, c);
      if (!skipUIState) setCandles(c);
      return c;
    } finally {
      if (!skipUIState) setFetchingCandles(false);
    }
  }, []);

  const run = useCallback(async () => {
    setError(null);
    setLoading(true);
    setProgress(0);
    setSingleResult(null);

    try {
      // Fetch extra lookback: engine needs ~320 daily bars of warmup before startDate
      // 4H has ~2 bars/day, so need more raw bars for same calendar coverage
      const lookbackDays = config.timeframe === '4H' ? 500 : 450;
      const fetchFrom = addTradingDaysBack(config.startDate, lookbackDays);
      const c = await fetchCandles(config.ticker, fetchFrom, config.endDate, config.timeframe);
      const minBars = config.timeframe === '4H' ? 700 : 350;
      if (c.length < minBars) {
        throw new Error(`Need ${minBars}+ candles for stable backtest, got ${c.length}. Try a longer date range.`);
      }

      const result = runBacktest(c, config, pct => setProgress(pct));
      setSingleResult(result);
    } catch (err: any) {
      setError(err.message || 'Backtest failed');
    } finally {
      setLoading(false);
      setProgress(100);
    }
  }, [config, fetchCandles]);

  const runSweepAction = useCallback(async (sweepCfg: SweepConfig) => {
    setError(null);
    setLoading(true);
    setProgress(0);
    setSweepResult(null);

    try {
      const lookbackDays = sweepCfg.timeframe === '4H' ? 500 : 450;
      const fetchFrom = addTradingDaysBack(sweepCfg.startDate, lookbackDays);
      const c = await fetchCandles(sweepCfg.ticker, fetchFrom, sweepCfg.endDate, sweepCfg.timeframe);
      const minBars = sweepCfg.timeframe === '4H' ? 700 : 350;
      if (c.length < minBars) {
        throw new Error(`Need ${minBars}+ candles for stable backtest, got ${c.length}. Try a longer date range.`);
      }

      const result = runSweep(c, sweepCfg, (done, total) => {
        setProgress(Math.round((done / total) * 100));
      });
      setSweepResult(result);
    } catch (err: any) {
      setError(err.message || 'Sweep failed');
    } finally {
      setLoading(false);
      setProgress(100);
    }
  }, [fetchCandles]);

  const runOptimize = useCallback(async (tickers: string[]) => {
    setError(null);
    setLoading(true);
    setProgress(0);
    setOptimizeResults([]);
    setOptimizeStatus('Starting...');

    const results: TickerOptResult[] = [];
    const timeframe = config.timeframe;
    const lookbackDays = timeframe === '4H' ? 500 : 450;
    const minBars = timeframe === '4H' ? 700 : 350;

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i];
      setOptimizeStatus(`Fetching ${ticker} (${i + 1}/${tickers.length})...`);
      setProgress(Math.round((i / tickers.length) * 100));

      try {
        const fetchFrom = addTradingDaysBack(config.startDate, lookbackDays);
        const c = await fetchCandles(ticker, fetchFrom, config.endDate, timeframe, true);
        if (c.length < minBars) {
          results.push({ ticker, sweep: { results: [], rankedBySharpe: [], rankedByWinRate: [], rankedByProfitFactor: [], bestOverall: null, totalCombos: 0, elapsedMs: 0 }, candleCount: c.length, error: `Only ${c.length} candles (need ${minBars}+)` });
          setOptimizeResults([...results]);
          continue;
        }

        setOptimizeStatus(`Sweeping ${ticker} (${i + 1}/${tickers.length})...`);

        const sweepCfg: SweepConfig = {
          ...DEFAULT_SWEEP,
          ticker,
          startDate: config.startDate,
          endDate: config.endDate,
          timeframe,
        };

        const sweep = runSweep(c, sweepCfg);
        results.push({ ticker, sweep, candleCount: c.length });
        setOptimizeResults([...results]);
      } catch (err: any) {
        results.push({ ticker, sweep: { results: [], rankedBySharpe: [], rankedByWinRate: [], rankedByProfitFactor: [], bestOverall: null, totalCombos: 0, elapsedMs: 0 }, candleCount: 0, error: err.message });
        setOptimizeResults([...results]);
      }
    }

    setOptimizeStatus(`Done — ${results.filter(r => !r.error).length}/${tickers.length} tickers`);
    setLoading(false);
    setProgress(100);
  }, [config, fetchCandles]);

  const togglePin = useCallback((r: BacktestResult) => {
    setPinned(prev => {
      const exists = prev.some(p =>
        p.config.tpAtr === r.config.tpAtr &&
        p.config.slAtr === r.config.slAtr &&
        p.config.minScore === r.config.minScore
      );
      if (exists) return prev.filter(p =>
        !(p.config.tpAtr === r.config.tpAtr &&
          p.config.slAtr === r.config.slAtr &&
          p.config.minScore === r.config.minScore)
      );
      if (prev.length >= 4) return prev; // Max 4 pins
      return [...prev, r];
    });
  }, []);

  const clearPins = useCallback(() => setPinned([]), []);

  return {
    config, setConfig,
    mode, setMode,
    loading, fetchingCandles, progress, error,
    singleResult, sweepResult, candles,
    pinned, togglePin, clearPins,
    optimizeResults, optimizeStatus,
    run, runSweepAction, runOptimize,
  };
}
