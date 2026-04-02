import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export interface SignalStatus {
  isActive: boolean;
  direction: string | null;
  score: number | null;
  streak: number;
  lastSignalDate: string | null;
  asOfDate: string | null;
}

export function useSignalStatus(ticker = 'QQQ') {
  return useQuery<SignalStatus>({
    queryKey: ['signal-status', ticker],
    queryFn: async () => {
      // Fetch last 30 days of signals for streak calculation
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const { data, error } = await supabase
        .from('signal_history')
        .select('date,direction,score,components')
        .eq('ticker', ticker)
        .gte('date', thirtyDaysAgo)
        .order('date', { ascending: false });

      if (error) throw error;
      if (!data || data.length === 0) {
        return { isActive: false, direction: null, score: null, streak: 0, lastSignalDate: null, asOfDate: null };
      }

      const latest = data[0];
      // Signal is active if latest day has direction CALL (DTE5 bull put) and score > 0
      // cron-signal-scan.js stores DTE5 bull put signals with direction: 'CALL'
      const isActive = latest.direction === 'CALL' && (latest.score ?? 0) > 0;

      // Calculate streak: count consecutive days with same direction
      let streak = 0;
      const latestDir = latest.direction;
      for (const row of data) {
        if (row.direction === latestDir && (row.score ?? 0) > 0) {
          streak++;
        } else {
          break;
        }
      }

      const lastSignalDate = isActive ? latest.date : (data.find(r => r.direction === 'CALL' && (r.score ?? 0) > 0)?.date ?? null);

      return {
        isActive,
        direction: latest.direction,
        score: latest.score,
        streak,
        lastSignalDate,
        asOfDate: latest.date,
      };
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}
