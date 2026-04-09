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

/** Tickers where 130M data was approximated from 1H bars (no pre-populated cache) */
export type ApproxTickers = string[];

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD'];

interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ScanTimeframe = '1D' | '4H' | '130M';

export function useSignalScanner() {
  const [tickers, setTickers] = useState<string[]>(DEFAULT_TICKERS);
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<FailedTicker[]>([]);
  const [approxTickers, setApproxTickers] = useState<string[]>([]);
  const candlesCacheRef = useRef<Map<string, CandleData[]>>(new Map());
  const abortRef = useRef(false);

  const fetchCandles = useCallback(async (ticker: string, timeframe: ScanTimeframe = '1D'): Promise<{ candles: CandleData[]; source: string }> => {
    const cacheKey = `${ticker}:${timeframe}`;
    const cached = candlesCacheRef.current.get(cacheKey);
    if (cached) return { candles: cached, source: 'client-cache' };

    const to = new Date().toISOString().slice(0, 10);
    // Intraday bars are denser, so fewer calendar days needed
    // 130M: pm2.25 scales longest indicator to 225 bars; 225/3 bars per day = 75 trading days ≈ 120 cal days
    const lookbackDays = timeframe === '130M' ? 120 : timeframe === '4H' ? 300 : 600;
    const from = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
    const res = await fetch(`/api/backtest-data?type=candles&ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}&timeframe=${timeframe}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status} for ${ticker}`);
    }
    const data = await res.json();
    const candles = data.candles as CandleData[];
    candlesCacheRef.current.set(cacheKey, candles);
    return { candles, source: data.source || 'unknown' };
  }, []);

  const scanList = useCallback(async (tickerList: string[], options: TechScoreOptions | undefined, merge: boolean, timeframe: ScanTimeframe = '1D') => {
    if (!tickerList.length) return;
    setLoading(true);
    setProgress(0);
    setError(null);
    if (!merge) {
      setSignals([]);
      setFailed([]);
      setApproxTickers([]);
    }
    abortRef.current = false;

    const results: SignalRow[] = [];
    const failures: FailedTicker[] = [];
    const approx: string[] = [];

    for (let i = 0; i < tickerList.length; i++) {
      if (abortRef.current) break;
      const ticker = tickerList[i];
      setProgress(Math.round((i / tickerList.length) * 100));
      try {
        const { candles, source } = await fetchCandles(ticker, timeframe);
        if (source.includes('approx')) approx.push(ticker);
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

    if (approx.length > 0) {
      setApproxTickers(merge ? prev => [...new Set([...prev, ...approx])] : approx);
    }

    if (failures.length > 0) {
      setError(`${failures.length} ticker${failures.length > 1 ? 's' : ''} failed — see details below`);
    }

    setProgress(100);
    setLoading(false);
  }, [fetchCandles]);

  /** Scan all tickers. Pass explicit list to override current state (avoids stale closure). */
  const scan = useCallback(async (options?: TechScoreOptions, tickerOverride?: string[], timeframe: ScanTimeframe = '1D') => {
    await scanList(tickerOverride ?? tickers, options, false, timeframe);
  }, [tickers, scanList]);

  const scanAdditional = useCallback(async (newTickers: string[], options?: TechScoreOptions, timeframe: ScanTimeframe = '1D') => {
    await scanList(newTickers, options, true, timeframe);
  }, [scanList]);

  const stop = useCallback(() => {
    abortRef.current = true;
  }, []);

  const clearCache = useCallback(() => {
    candlesCacheRef.current.clear();
  }, []);

  return { signals, loading, progress, error, failed, approxTickers, tickers, setTickers, scan, scanAdditional, stop, clearCache };
}
