/**
 * React hook for backtest state management.
 * Fetches candles, runs engine, manages validate/sweep/optimize modes.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  BacktestCandle,
  BacktestConfig,
  BacktestResult,
  SweepConfig,
  SweepResult,
  OptimizeConfig,
  OptimizeResult,
  WalkForwardConfig,
  WalkForwardResult,
} from '../lib/backtest/types';
import { DEFAULT_CONFIG } from '../lib/backtest/types';
import { runBacktest, type IVDataRow } from '../lib/backtest/engine';
import { runSweep } from '../lib/backtest/sweep';

// ── Web Worker for heavy GA/walk-forward computation ──────────────────────────
// Keeps the main thread (and React UI) fully responsive during optimization.
function createOptimizerWorker(): Worker {
  return new Worker(
    new URL('../lib/backtest/optimizer.worker.ts', import.meta.url),
    { type: 'module' },
  );
}

/** Run a function inside the shared optimizer worker, resolving on 'done'. */
function workerRun<T>(
  worker: Worker,
  msg: { type: string; payload: unknown },
  onProgress: (data: Record<string, unknown>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const handler = (e: MessageEvent) => {
      const d = e.data;
      if (d.id !== id) return;
      if (d.type === 'progress' || d.type === 'wf-progress') {
        onProgress(d);
      } else if (d.type === 'optimize-done' || d.type === 'wf-done') {
        worker.removeEventListener('message', handler);
        resolve(d.result as T);
      } else if (d.type === 'error') {
        worker.removeEventListener('message', handler);
        reject(new Error(d.message));
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ id, ...msg });
  });
}

export type BacktestMode = 'validate' | 'sweep' | 'optimize' | 'walkforward';

export interface OOSDateRange {
  startDate: string;
  endDate: string;
}

/** Subtract N calendar days (approximates trading days × 1.45 for weekends/holidays) */
function addTradingDaysBack(dateStr: string, tradingDays: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - Math.ceil(tradingDays * 1.45));
  return d.toISOString().split('T')[0];
}

export interface LiveGenPoint { gen: number; bestFitness: number; avgFitness: number; }

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
  progressDetail: string;
  elapsedMs: number;
  liveGenHistory: LiveGenPoint[];
  genProgress: { gen: number; totalGens: number; bestFitness: number; cacheHits: number } | null;
  error: string | null;
  // Results
  singleResult: BacktestResult | null;
  sweepResult: SweepResult | null;
  optimizeResult: OptimizeResult | null;
  oosResult: BacktestResult | null;     // OOS validation after optimize
  walkforwardResult: WalkForwardResult | null;
  candles: BacktestCandle[] | null;
  // Pinned for comparison
  pinned: BacktestResult[];
  togglePin: (r: BacktestResult) => void;
  clearPins: () => void;
  // Actions
  run: () => Promise<void>;
  runSweepAction: (sweepConfig: SweepConfig) => Promise<void>;
  runOptimizeAction: (optConfig: OptimizeConfig, oosDateRange?: OOSDateRange) => Promise<void>;
  runWalkForwardAction: (wfConfig: WalkForwardConfig) => Promise<void>;
}

export function useBacktest(): UseBacktestReturn {
  const [config, setConfig] = useState<BacktestConfig>(DEFAULT_CONFIG);
  const [mode, setMode] = useState<BacktestMode>('validate');
  const [loading, setLoading] = useState(false);
  const [fetchingCandles, setFetchingCandles] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState('');
  const [progressDetail, setProgressDetail] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [liveGenHistory, setLiveGenHistory] = useState<LiveGenPoint[]>([]);
  const [genProgress, setGenProgress] = useState<{ gen: number; totalGens: number; bestFitness: number; cacheHits: number } | null>(null);
  const startedAtRef = useRef<number>(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [singleResult, setSingleResult] = useState<BacktestResult | null>(null);
  const [sweepResult, setSweepResult] = useState<SweepResult | null>(null);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null);
  const [oosResult, setOosResult] = useState<BacktestResult | null>(null);
  const [walkforwardResult, setWalkforwardResult] = useState<WalkForwardResult | null>(null);
  const [candles, setCandles] = useState<BacktestCandle[] | null>(null);
  const [pinned, setPinned] = useState<BacktestResult[]>([]);

  const candlesCacheRef = useRef<Map<string, BacktestCandle[]>>(new Map());
  const ivCacheRef = useRef<Map<string, IVDataRow[]>>(new Map());

  const startTimer = useCallback(() => {
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 500);
  }, []);

  const stopTimer = useCallback(() => {
    if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null; }
    setElapsedMs(Date.now() - startedAtRef.current);
  }, []);

  useEffect(() => () => { if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current); }, []);

  // Shared optimizer worker — created once, lives for the lifetime of the hook
  const workerRef = useRef<Worker | null>(null);
  useEffect(() => {
    workerRef.current = createOptimizerWorker();
    return () => { workerRef.current?.terminate(); workerRef.current = null; };
  }, []);

  const fetchCandles = useCallback(async (ticker: string, from: string, to: string): Promise<BacktestCandle[]> => {
    const key = `${ticker}|${from}|${to}`;
    const cached = candlesCacheRef.current.get(key);
    if (cached) return cached;

    setFetchingCandles(true);
    try {
      const res = await fetch(`/api/backtest-data?type=candles&ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}&timeframe=1D`);
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
      const res = await fetch(`/api/backtest-data?type=iv&ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}`);
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

  const runOptimizeAction = useCallback(async (optCfg: OptimizeConfig, oosDateRange?: OOSDateRange) => {
    setError(null);
    setLoading(true);
    setProgress(0);
    setProgressPhase('Fetching candles');
    setProgressDetail('');
    setLiveGenHistory([]);
    setGenProgress(null);
    setOptimizeResult(null);
    setOosResult(null);
    startTimer();

    try {
      const fetchFrom = addTradingDaysBack(optCfg.startDate, 450);
      // Extend fetch to cover OOS period if provided (candles shared between IS optimization + OOS validation)
      const fetchTo = oosDateRange?.endDate ?? optCfg.endDate;
      const allTickers = optCfg.tickers?.length ? optCfg.tickers : [optCfg.ticker];

      const isMultiTicker = allTickers.length > 1;
      const MIN_CANDLES = isMultiTicker ? 1000 : 350;

      // fullCandleMap: all candles (IS + OOS) for each ticker
      const fullCandleMap = new Map<string, BacktestCandle[]>();
      // candleMap: IS-only candles passed to GA optimizer
      const candleMap = new Map<string, BacktestCandle[]>();
      const skipped: string[] = [];

      console.log('[optimize] tickers:', allTickers, 'IS:', optCfg.startDate, '→', optCfg.endDate, 'OOS:', oosDateRange?.startDate, '→', oosDateRange?.endDate);

      for (let ti = 0; ti < allTickers.length; ti++) {
        const ticker = allTickers[ti];
        setProgressDetail(`${ticker} (${ti + 1}/${allTickers.length})`);
        try {
          const c = await fetchCandles(ticker, fetchFrom, fetchTo);
          fullCandleMap.set(ticker, c);

          // IS candles: everything up to IS end date
          const isCandles = c.filter(candle => candle.date <= optCfg.endDate);
          console.log(`[optimize] ${ticker}: ${c.length} total candles, ${isCandles.length} IS candles`);

          if (isCandles.length < MIN_CANDLES) {
            console.warn(`${ticker}: Need ${MIN_CANDLES}+ IS candles, got ${isCandles.length} — skipping`);
            skipped.push(`${ticker}(${isCandles.length})`);
            continue;
          }
          candleMap.set(ticker, isCandles);
        } catch (fetchErr: any) {
          console.error(`[optimize] ${ticker} fetch failed:`, fetchErr.message);
        }
      }

      if (skipped.length > 0) {
        console.warn(`[optimize] Excluded (< ${MIN_CANDLES} IS candles): ${skipped.join(', ')}`);
      }

      if (candleMap.size === 0) {
        throw new Error(`No tickers with sufficient IS data (need ${MIN_CANDLES}+ candles). Tried: ${allTickers.join(', ')}. Excluded: ${skipped.join(', ')}`);
      }

      // Fetch IV data for IS period
      const ivMap = new Map<string, IVDataRow[]>();
      if (optCfg.optionsPricing?.ivSource === 'orats') {
        for (const ticker of candleMap.keys()) {
          const iv = await fetchIVData(ticker, fetchFrom, optCfg.endDate);
          if (iv && iv.length > 0) ivMap.set(ticker, iv);
        }
      }
      const ivInput: IVDataRow[] | Map<string, IVDataRow[]> | undefined =
        ivMap.size === 1 ? Array.from(ivMap.values())[0] : ivMap.size > 0 ? ivMap : undefined;

      // ── Stage 1+2: Optimize on IS candles (in Web Worker) ──
      setProgressPhase('GA weights');

      // Serialise Map → array of entries for structured clone (workers can't receive Maps directly)
      const candlePayload = candleMap.size === 1
        ? Array.from(candleMap.values())[0]
        : Array.from(candleMap.entries());
      const ivPayload = ivInput instanceof Map
        ? Array.from(ivInput.entries())
        : ivInput;

      const worker = workerRef.current ?? createOptimizerWorker();
      const result = await workerRun<OptimizeResult>(
        worker,
        { type: 'optimize', payload: { candles: candlePayload, config: optCfg, ivData: ivPayload } },
        (d) => {
          if (d.type === 'progress') {
            const phase = d.phase as 'ga' | 'tpsl';
            const pct = d.pct as number;
            const det = d.detail as Record<string, number> | undefined;
            setProgressPhase(phase === 'ga' ? 'Genetic algorithm' : 'TP/SL grid');
            setProgress(Math.round(pct * (oosDateRange ? 0.9 : 1)));
            if (det) {
              if (phase === 'ga' && det.gen !== undefined) {
                const cacheStr = det.cacheHits ? ` · ${det.cacheHits} cached` : '';
                setProgressDetail(`Generation ${det.gen}/${det.totalGens} · Best score ${(det.bestFitness ?? 0).toFixed(3)}${cacheStr}`);
                setGenProgress({ gen: det.gen, totalGens: det.totalGens, bestFitness: det.bestFitness ?? 0, cacheHits: det.cacheHits ?? 0 });
                setLiveGenHistory(prev => {
                  const next = [...prev, { gen: det.gen, bestFitness: det.bestFitness ?? 0, avgFitness: det.avgFitness ?? 0 }];
                  return next.length > 200 ? next.slice(-200) : next;
                });
              } else if (phase === 'tpsl' && det.tpslDone !== undefined) {
                setProgressDetail(`Combo ${det.tpslDone}/${det.tpslTotal}`);
              }
            }
          }
        },
      );
      setOptimizeResult(result);

      // ── OOS validation: apply best IS config to unseen OOS candles ──
      if (oosDateRange && result.bestOverall) {
        setProgressPhase('OOS validation');
        setProgress(90);

        const primaryTicker = (optCfg.tickers?.[0] ?? optCfg.ticker).toUpperCase();
        const allOosTickers = optCfg.tickers?.length ? optCfg.tickers : [primaryTicker];

        // Run OOS on each ticker, collect all trades
        for (const ticker of allOosTickers) {
          const fullCandles = fullCandleMap.get(ticker) ?? [];
          if (fullCandles.length < 50 || ticker === primaryTicker) continue;

          let oosIV: IVDataRow[] | undefined;
          if (optCfg.optionsPricing?.ivSource === 'orats') {
            oosIV = await fetchIVData(ticker, oosDateRange.startDate, oosDateRange.endDate);
          }

          const oosConfig: BacktestConfig = {
            ...result.bestOverall.config,
            ticker,
            startDate: oosDateRange.startDate,
            endDate: oosDateRange.endDate,
          };

          try {
            runBacktest(fullCandles, oosConfig, undefined, oosIV);
          } catch (e: any) {
            console.warn(`[optimize] OOS backtest failed for ${ticker}:`, e.message);
          }
        }

        // Run final OOS backtest on primary ticker for analytics (equity curve, analytics object)
        const primaryFullCandles = fullCandleMap.get(primaryTicker) ?? [];
        if (primaryFullCandles.length >= 50) {
          let oosIV: IVDataRow[] | undefined;
          if (optCfg.optionsPricing?.ivSource === 'orats') {
            oosIV = await fetchIVData(primaryTicker, oosDateRange.startDate, oosDateRange.endDate);
          }
          const oosConfig: BacktestConfig = {
            ...result.bestOverall.config,
            ticker: primaryTicker,
            startDate: oosDateRange.startDate,
            endDate: oosDateRange.endDate,
          };
          const primaryOOS = runBacktest(primaryFullCandles, oosConfig, undefined, oosIV);
          setOosResult(primaryOOS);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Optimize failed');
    } finally {
      setLoading(false);
      setProgress(100);
      setProgressPhase('');
      setProgressDetail('');
      stopTimer();
    }
  }, [fetchCandles, fetchIVData, startTimer, stopTimer]);

  const runWalkForwardAction = useCallback(async (wfCfg: WalkForwardConfig) => {
    setError(null);
    setLoading(true);
    setProgress(0);
    setProgressPhase('Fetching candles');
    setWalkforwardResult(null);

    try {
      const fetchFrom = addTradingDaysBack(wfCfg.startDate, 450);
      const c = await fetchCandles(wfCfg.ticker, fetchFrom, wfCfg.endDate);
      if (c.length < 350) throw new Error(`Need 350+ candles, got ${c.length}. Try a longer date range.`);

      setProgressPhase('Walk-forward');
      const worker = workerRef.current ?? createOptimizerWorker();
      const result = await workerRun<WalkForwardResult>(
        worker,
        { type: 'walkforward', payload: { candles: c, config: wfCfg } },
        (d) => {
          if (d.type === 'wf-progress') {
            const wi = d.wi as number;
            const total = d.total as number;
            const phase = d.phase as string;
            setProgress(Math.round((wi / Math.max(total, 1)) * 100));
            setProgressPhase(`Window ${wi + 1} of ${total}`);
            setProgressDetail(phase === 'IS' ? 'Optimizing in-sample' : 'Validating out-of-sample');
          }
        },
      );
      setWalkforwardResult(result);
    } catch (err: any) {
      setError(err.message || 'Walk-forward failed');
    } finally {
      setLoading(false);
      setProgress(100);
      setProgressPhase('');
      setProgressDetail('');
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
    loading, fetchingCandles, progress, progressPhase, progressDetail, elapsedMs, liveGenHistory, genProgress, error,
    singleResult, sweepResult, optimizeResult, oosResult, walkforwardResult, candles,
    pinned, togglePin, clearPins,
    run, runSweepAction, runOptimizeAction, runWalkForwardAction,
  };
}
