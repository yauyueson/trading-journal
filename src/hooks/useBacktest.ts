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
import { runBacktest, type IVDataRow } from '../lib/backtest/engine';
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
  const ivCacheRef = useRef<Map<string, IVDataRow[]>>(new Map());

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

  const fetchIVData = useCallback(async (ticker: string, from: string, to: string): Promise<IVDataRow[] | undefined> => {
    const key = `${ticker}|${from}|${to}`;
    const cached = ivCacheRef.current.get(key);
    if (cached) return cached;

    try {
      const res = await fetch(`/api/backtest-iv?ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}`);
      if (!res.ok) return undefined;
      const data = await res.json();
      const iv = data.iv as IVDataRow[];
      if (iv && iv.length > 0) {
        ivCacheRef.current.set(key, iv);
      }
      return iv;
    } catch {
      return undefined;
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
      const [c, iv] = await Promise.all([
        fetchCandles(config.ticker, fetchFrom, config.endDate),
        config.optionsPricing?.ivSource === 'orats'
          ? fetchIVData(config.ticker, fetchFrom, config.endDate)
          : Promise.resolve(undefined),
      ]);
      if (c.length < 350) {
        throw new Error(`Need 350+ candles for stable backtest, got ${c.length}. Try a longer date range.`);
      }

      const result = runBacktest(c, config, pct => setProgress(pct), iv);
      setSingleResult(result);
    } catch (err: any) {
      setError(err.message || 'Backtest failed');
    } finally {
      setLoading(false);
      setProgress(100);
    }
  }, [config, fetchCandles, fetchIVData]);

  const runSweepAction = useCallback(async (sweepCfg: SweepConfig) => {
    setError(null);
    setLoading(true);
    setProgress(0);
    setProgressPhase('');
    setSweepResult(null);

    try {
      const fetchFrom = addTradingDaysBack(sweepCfg.startDate, 450);
      const [c, iv] = await Promise.all([
        fetchCandles(sweepCfg.ticker, fetchFrom, sweepCfg.endDate),
        sweepCfg.optionsPricing?.ivSource === 'orats'
          ? fetchIVData(sweepCfg.ticker, fetchFrom, sweepCfg.endDate)
          : Promise.resolve(undefined),
      ]);
      if (c.length < 350) {
        throw new Error(`Need 350+ candles for stable backtest, got ${c.length}. Try a longer date range.`);
      }

      const result = runSweep(c, sweepCfg, (done, total) => {
        setProgress(Math.round((done / total) * 100));
      }, iv);
      setSweepResult(result);
    } catch (err: any) {
      setError(err.message || 'Sweep failed');
    } finally {
      setLoading(false);
      setProgress(100);
    }
  }, [fetchCandles, fetchIVData]);

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
      // Multi-ticker GA requires 1500+ bars per ticker for statistical robustness.
      // Short-history tickers (IPOs etc.) are excluded from training — use validate mode for those.
      const isMultiTicker = allTickers.length > 1;
      const MIN_CANDLES = isMultiTicker ? 1500 : 350;
      const candleMap = new Map<string, BacktestCandle[]>();
      const skipped: string[] = [];
      console.log('[optimize] tickers:', allTickers, 'fetchFrom:', fetchFrom, 'to:', optCfg.endDate, 'minCandles:', MIN_CANDLES);
      for (const ticker of allTickers) {
        try {
          const c = await fetchCandles(ticker, fetchFrom, optCfg.endDate);
          console.log(`[optimize] ${ticker}: got ${c.length} candles`);
          if (c.length < MIN_CANDLES) {
            console.warn(`${ticker}: Need ${MIN_CANDLES}+ candles for ${isMultiTicker ? 'multi-ticker GA' : 'backtest'}, got ${c.length} — skipping`);
            skipped.push(`${ticker}(${c.length})`);
            continue;
          }
          candleMap.set(ticker, c);
        } catch (fetchErr: any) {
          console.error(`[optimize] ${ticker} fetch failed:`, fetchErr.message);
        }
      }

      if (skipped.length > 0) {
        console.warn(`[optimize] Excluded from GA training (< ${MIN_CANDLES} candles): ${skipped.join(', ')}. Use validate mode for these tickers.`);
      }

      if (candleMap.size === 0) {
        throw new Error(`No tickers with sufficient data (need ${MIN_CANDLES}+ candles each). Tickers tried: ${allTickers.join(', ')}. Excluded: ${skipped.join(', ')}. Check browser console for details.`);
      }

      // Fetch IV data for all tickers (if ORATS IV source)
      let ivInput: IVDataRow[] | Map<string, IVDataRow[]> | undefined;
      if (optCfg.optionsPricing?.ivSource === 'orats') {
        const ivMap = new Map<string, IVDataRow[]>();
        for (const ticker of candleMap.keys()) {
          const iv = await fetchIVData(ticker, fetchFrom, optCfg.endDate);
          if (iv && iv.length > 0) ivMap.set(ticker, iv);
        }
        ivInput = ivMap.size === 1 ? Array.from(ivMap.values())[0] : ivMap.size > 0 ? ivMap : undefined;
      }

      setProgressPhase('GA weights');
      const input = candleMap.size === 1
        ? Array.from(candleMap.values())[0]
        : candleMap;

      const result = runTwoStageOptimize(input, optCfg, (phase, pct) => {
        setProgressPhase(phase === 'ga' ? 'GA weights' : 'TP/SL grid');
        setProgress(pct);
      }, ivInput);
      setOptimizeResult(result);
    } catch (err: any) {
      setError(err.message || 'Optimize failed');
    } finally {
      setLoading(false);
      setProgress(100);
      setProgressPhase('');
    }
  }, [fetchCandles, fetchIVData]);

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
