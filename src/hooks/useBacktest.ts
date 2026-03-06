/**
 * React hook for backtest state management.
 * Fetches candles, runs engine, manages validate/sweep/optimize modes.
 */

import { useState, useCallback, useRef } from 'react';
import type {
  BacktestCandle,
  BacktestConfig,
  BacktestResult,
  SweepConfig,
  SweepResult,
  OptimizeConfig,
  OptimizeResult,
} from '../lib/backtest/types';
import { DEFAULT_CONFIG } from '../lib/backtest/types';
import { runBacktest } from '../lib/backtest/engine';
import { runSweep, runTwoStageOptimize } from '../lib/backtest/sweep';

export type BacktestMode = 'validate' | 'sweep' | 'optimize';

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
  progressPhase: string;
  error: string | null;
  // Results
  singleResult: BacktestResult | null;
  sweepResult: SweepResult | null;
  optimizeResult: OptimizeResult | null;
  candles: BacktestCandle[] | null;
  // Pinned for comparison
  pinned: BacktestResult[];
  togglePin: (r: BacktestResult) => void;
  clearPins: () => void;
  // Actions
  run: () => Promise<void>;
  runSweepAction: (sweepConfig: SweepConfig) => Promise<void>;
  runOptimizeAction: (optConfig: OptimizeConfig) => Promise<void>;
}

export function useBacktest(): UseBacktestReturn {
  const [config, setConfig] = useState<BacktestConfig>(DEFAULT_CONFIG);
  const [mode, setMode] = useState<BacktestMode>('validate');
  const [loading, setLoading] = useState(false);
  const [fetchingCandles, setFetchingCandles] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [singleResult, setSingleResult] = useState<BacktestResult | null>(null);
  const [sweepResult, setSweepResult] = useState<SweepResult | null>(null);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null);
  const [candles, setCandles] = useState<BacktestCandle[] | null>(null);
  const [pinned, setPinned] = useState<BacktestResult[]>([]);

  const candlesCacheRef = useRef<Map<string, BacktestCandle[]>>(new Map());

  const fetchCandles = useCallback(async (ticker: string, from: string, to: string): Promise<BacktestCandle[]> => {
    const key = `${ticker}|${from}|${to}`;
    const cached = candlesCacheRef.current.get(key);
    if (cached) return cached;

    setFetchingCandles(true);
    try {
      const res = await fetch(`/api/backtest-candles?ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}&timeframe=1D`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const c = data.candles as BacktestCandle[];
      candlesCacheRef.current.set(key, c);
      setCandles(c);
      return c;
    } finally {
      setFetchingCandles(false);
    }
  }, []);

  const run = useCallback(async () => {
    setError(null);
    setLoading(true);
    setProgress(0);
    setProgressPhase('');
    setSingleResult(null);

    try {
      const fetchFrom = addTradingDaysBack(config.startDate, 450);
      const c = await fetchCandles(config.ticker, fetchFrom, config.endDate);
      if (c.length < 350) {
        throw new Error(`Need 350+ candles for stable backtest, got ${c.length}. Try a longer date range.`);
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
    setProgressPhase('');
    setSweepResult(null);

    try {
      const fetchFrom = addTradingDaysBack(sweepCfg.startDate, 450);
      const c = await fetchCandles(sweepCfg.ticker, fetchFrom, sweepCfg.endDate);
      if (c.length < 350) {
        throw new Error(`Need 350+ candles for stable backtest, got ${c.length}. Try a longer date range.`);
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

  const runOptimizeAction = useCallback(async (optCfg: OptimizeConfig) => {
    setError(null);
    setLoading(true);
    setProgress(0);
    setProgressPhase('Fetching candles');
    setOptimizeResult(null);

    try {
      const fetchFrom = addTradingDaysBack(optCfg.startDate, 450);
      const allTickers = optCfg.tickers?.length ? optCfg.tickers : [optCfg.ticker];

      // Fetch candles for all tickers
      const candleMap = new Map<string, BacktestCandle[]>();
      for (const ticker of allTickers) {
        const c = await fetchCandles(ticker, fetchFrom, optCfg.endDate);
        if (c.length < 350) {
          console.warn(`${ticker}: Need 350+ candles, got ${c.length} — skipping`);
          continue;
        }
        candleMap.set(ticker, c);
      }

      if (candleMap.size === 0) {
        throw new Error('No tickers with sufficient data (need 350+ candles each).');
      }

      setProgressPhase('GA weights');
      const input = candleMap.size === 1
        ? Array.from(candleMap.values())[0]
        : candleMap;

      const result = runTwoStageOptimize(input, optCfg, (phase, pct) => {
        setProgressPhase(phase === 'ga' ? 'GA weights' : 'TP/SL grid');
        setProgress(pct);
      });
      setOptimizeResult(result);
    } catch (err: any) {
      setError(err.message || 'Optimize failed');
    } finally {
      setLoading(false);
      setProgress(100);
      setProgressPhase('');
    }
  }, [fetchCandles]);

  const togglePin = useCallback((r: BacktestResult) => {
    setPinned(prev => {
      const key = (p: BacktestResult) => JSON.stringify(p.config.indicatorOptions);
      const exists = prev.some(p => key(p) === key(r));
      if (exists) return prev.filter(p => key(p) !== key(r));
      if (prev.length >= 4) return prev;
      return [...prev, r];
    });
  }, []);

  const clearPins = useCallback(() => setPinned([]), []);

  return {
    config, setConfig,
    mode, setMode,
    loading, fetchingCandles, progress, progressPhase, error,
    singleResult, sweepResult, optimizeResult, candles,
    pinned, togglePin, clearPins,
    run, runSweepAction, runOptimizeAction,
  };
}
