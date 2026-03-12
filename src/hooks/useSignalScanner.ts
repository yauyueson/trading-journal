import { useState, useRef, useCallback } from 'react';
import { calculateTechScore, type TechScoreResult, type TechScoreOptions } from '../lib/tech-analysis';

export interface SignalRow {
  ticker: string;
  result: TechScoreResult;
  lastClose: number;
  updatedAt: number; // Date.now()
}

export interface FailedTicker {
  ticker: string;
  reason: string;
}

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD'];

interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
}

export function useSignalScanner() {
  const [tickers, setTickers] = useState<string[]>(DEFAULT_TICKERS);
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<FailedTicker[]>([]);
  const candlesCacheRef = useRef<Map<string, CandleData[]>>(new Map());
  const abortRef = useRef(false);

  const fetchCandles = useCallback(async (ticker: string): Promise<CandleData[]> => {
    const cached = candlesCacheRef.current.get(ticker);
    if (cached) return cached;

    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 600 * 86400000).toISOString().slice(0, 10); // ~600 days back
    const res = await fetch(`/api/backtest-data?type=candles&ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}&timeframe=1D`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status} for ${ticker}`);
    }
    const data = await res.json();
    const candles = data.candles as CandleData[];
    candlesCacheRef.current.set(ticker, candles);
    return candles;
  }, []);

  const scanList = useCallback(async (tickerList: string[], options: TechScoreOptions | undefined, merge: boolean) => {
    if (!tickerList.length) return;
    setLoading(true);
    setProgress(0);
    setError(null);
    if (!merge) {
      setSignals([]);
      setFailed([]);
    }
    abortRef.current = false;

    const results: SignalRow[] = [];
    const failures: FailedTicker[] = [];

    for (let i = 0; i < tickerList.length; i++) {
      if (abortRef.current) break;
      const ticker = tickerList[i];
      setProgress(Math.round((i / tickerList.length) * 100));
      try {
        const candles = await fetchCandles(ticker);
        if (candles.length < 50) {
          failures.push({ ticker, reason: `Only ${candles.length} candles (need 50+)` });
          continue;
        }
        const result = calculateTechScore(candles, options);
        results.push({
          ticker,
          result,
          lastClose: candles[candles.length - 1].close,
          updatedAt: Date.now(),
        });
        // Update progressively
        if (merge) {
          setSignals(prev => {
            const existing = prev.filter(s => !tickerList.includes(s.ticker));
            return [...existing, ...results].sort((a, b) => b.result.techScore - a.result.techScore);
          });
        } else {
          setSignals([...results].sort((a, b) => b.result.techScore - a.result.techScore));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Signal scan failed for ${ticker}:`, msg);
        failures.push({ ticker, reason: msg });
      }
    }

    // Final update
    if (merge) {
      setSignals(prev => {
        const existing = prev.filter(s => !tickerList.includes(s.ticker));
        return [...existing, ...results].sort((a, b) => b.result.techScore - a.result.techScore);
      });
      setFailed(prev => [...prev, ...failures]);
    } else {
      setSignals([...results].sort((a, b) => b.result.techScore - a.result.techScore));
      setFailed(failures);
    }

    if (failures.length > 0) {
      setError(`${failures.length} ticker${failures.length > 1 ? 's' : ''} failed — see details below`);
    }

    setProgress(100);
    setLoading(false);
  }, [fetchCandles]);

  /** Scan all tickers. Pass explicit list to override current state (avoids stale closure). */
  const scan = useCallback(async (options?: TechScoreOptions, tickerOverride?: string[]) => {
    await scanList(tickerOverride ?? tickers, options, false);
  }, [tickers, scanList]);

  const scanAdditional = useCallback(async (newTickers: string[], options?: TechScoreOptions) => {
    await scanList(newTickers, options, true);
  }, [scanList]);

  const stop = useCallback(() => {
    abortRef.current = true;
  }, []);

  const clearCache = useCallback(() => {
    candlesCacheRef.current.clear();
  }, []);

  return { signals, loading, progress, error, failed, tickers, setTickers, scan, scanAdditional, stop, clearCache };
}
