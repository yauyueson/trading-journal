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
import { runSweep } from '../lib/backtest/sweep';

export type BacktestMode = 'single' | 'sweep';

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
  // Actions
  run: () => Promise<void>;
  runSweepAction: (sweepConfig: SweepConfig) => Promise<void>;
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

  const candlesCacheRef = useRef<{ key: string; data: BacktestCandle[] } | null>(null);

  const fetchCandles = useCallback(async (ticker: string, from: string, to: string): Promise<BacktestCandle[]> => {
    const key = `${ticker}|${from}|${to}`;
    if (candlesCacheRef.current?.key === key) {
      return candlesCacheRef.current.data;
    }

    setFetchingCandles(true);
    try {
      const res = await fetch(`/api/backtest-candles?ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const c = data.candles as BacktestCandle[];
      candlesCacheRef.current = { key, data: c };
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
    setSingleResult(null);

    try {
      const c = await fetchCandles(config.ticker, config.startDate, config.endDate);
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
    setSweepResult(null);

    try {
      const c = await fetchCandles(sweepCfg.ticker, sweepCfg.startDate, sweepCfg.endDate);
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
    run, runSweepAction,
  };
}
