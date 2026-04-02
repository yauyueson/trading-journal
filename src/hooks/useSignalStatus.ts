import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export interface SignalStatus {
  ticker: string;
  isActive: boolean;
  direction: string | null;
  score: number | null;
  streak: number;
  lastSignalDate: string | null;
  asOfDate: string | null;
}

/** Fetch signal status for a single ticker */
export function useSignalStatus(ticker = 'QQQ') {
  return useQuery<SignalStatus>({
    queryKey: ['signal-status', ticker],
    queryFn: async () => fetchSignalForTicker(ticker),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

/** Fetch signal status for multiple tickers at once */
export function useAllSignals(tickers: string[]) {
  return useQuery<SignalStatus[]>({
    queryKey: ['signal-status-all', tickers],
    queryFn: async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const { data, error } = await supabase
        .from('signal_history')
        .select('ticker,date,direction,score,components')
        .in('ticker', tickers)
        .gte('date', thirtyDaysAgo)
        .order('date', { ascending: false });

      if (error) throw error;

      // Group by ticker
      const byTicker = new Map<string, typeof data>();
      for (const row of data ?? []) {
        if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
        byTicker.get(row.ticker)!.push(row);
      }

      return tickers.map(ticker => {
        const rows = byTicker.get(ticker);
        if (!rows || rows.length === 0) {
          return { ticker, isActive: false, direction: null, score: null, streak: 0, lastSignalDate: null, asOfDate: null };
        }
        return parseSignalRows(ticker, rows);
      });
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    enabled: tickers.length > 0,
  });
}

async function fetchSignalForTicker(ticker: string): Promise<SignalStatus> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('signal_history')
    .select('ticker,date,direction,score,components')
    .eq('ticker', ticker)
    .gte('date', thirtyDaysAgo)
    .order('date', { ascending: false });

  if (error) throw error;
  if (!data || data.length === 0) {
    return { ticker, isActive: false, direction: null, score: null, streak: 0, lastSignalDate: null, asOfDate: null };
  }
  return parseSignalRows(ticker, data);
}

function parseSignalRows(ticker: string, data: Array<{ date: string; direction: string; score: number | null }>): SignalStatus {
  const latest = data[0];
  // DTE5 bull put signals stored with direction: 'CALL' by cron-signal-scan.js
  const isActive = latest.direction === 'CALL' && (latest.score ?? 0) > 0;

  let streak = 0;
  const latestDir = latest.direction;
  for (const row of data) {
    if (row.direction === latestDir && (row.score ?? 0) > 0) streak++;
    else break;
  }

  const lastSignalDate = isActive
    ? latest.date
    : (data.find(r => r.direction === 'CALL' && (r.score ?? 0) > 0)?.date ?? null);

  return { ticker, isActive, direction: latest.direction, score: latest.score, streak, lastSignalDate, asOfDate: latest.date };
}
