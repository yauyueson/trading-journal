import { useState, useRef, useCallback } from 'react';
import { calculateTechScore, type TechScoreResult, type TechScoreOptions } from '../lib/tech-analysis';

export interface SignalRow {
  ticker: string;
  result: TechScoreResult;
  lastClose: number;
  updatedAt: number; // Date.now()
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
  const candlesCacheRef = useRef<Map<string, CandleData[]>>(new Map());
  const abortRef = useRef(false);

  const fetchCandles = useCallback(async (ticker: string): Promise<CandleData[]> => {
    const cached = candlesCacheRef.current.get(ticker);
    if (cached) return cached;

    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 600 * 86400000).toISOString().slice(0, 10); // ~600 days back
    const res = await fetch(`/api/backtest-candles?ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}&timeframe=1D`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status} for ${ticker}`);
    }
    const data = await res.json();
    const candles = data.candles as CandleData[];
    candlesCacheRef.current.set(ticker, candles);
    return candles;
  }, []);

  const scan = useCallback(async (options?: TechScoreOptions) => {
    setLoading(true);
    setProgress(0);
    setError(null);
    setSignals([]);
    abortRef.current = false;

    const results: SignalRow[] = [];
    for (let i = 0; i < tickers.length; i++) {
      if (abortRef.current) break;
      const ticker = tickers[i];
      setProgress(Math.round(((i) / tickers.length) * 100));
      try {
        const candles = await fetchCandles(ticker);
        if (candles.length < 50) continue;
        const result = calculateTechScore(candles, options);
        results.push({
          ticker,
          result,
          lastClose: candles[candles.length - 1].close,
          updatedAt: Date.now(),
        });
        // Update progressively so user sees results appear
        setSignals([...results].sort((a, b) => b.result.techScore - a.result.techScore));
      } catch (err) {
        console.warn(`Signal scan failed for ${ticker}:`, err);
      }
    }

    setSignals([...results].sort((a, b) => b.result.techScore - a.result.techScore));
    setProgress(100);
    setLoading(false);
  }, [tickers, fetchCandles]);

  const stop = useCallback(() => {
    abortRef.current = true;
  }, []);

  const clearCache = useCallback(() => {
    candlesCacheRef.current.clear();
  }, []);

  return { signals, loading, progress, error, tickers, setTickers, scan, stop, clearCache };
}
