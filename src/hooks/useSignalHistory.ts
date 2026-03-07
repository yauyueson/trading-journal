import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export interface SignalHistoryRow {
  id: number;
  ticker: string;
  date: string;
  score: number;
  direction: string;
  setup: string | null;
  confidence: number;
  components: Record<string, number> | null;
  debug: Record<string, unknown> | null;
}

interface SignalHistoryFilters {
  from?: string;
  to?: string;
  ticker?: string;
  minScore?: number;
  direction?: 'CALL' | 'PUT' | '';
}

export function useSignalHistory(filters: SignalHistoryFilters) {
  return useQuery({
    queryKey: ['signal-history', filters],
    queryFn: async () => {
      let q = supabase
        .from('signal_history')
        .select('id,ticker,date,score,direction,setup,confidence,components,debug')
        .order('date', { ascending: false })
        .order('score', { ascending: false })
        .limit(500);

      if (filters.from) q = q.gte('date', filters.from);
      if (filters.to) q = q.lte('date', filters.to);
      if (filters.ticker) q = q.eq('ticker', filters.ticker.toUpperCase());
      if (filters.minScore) q = q.gte('score', filters.minScore);
      if (filters.direction) q = q.eq('direction', filters.direction);

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as SignalHistoryRow[];
    },
    staleTime: 5 * 60 * 1000, // 5 min — data only updates daily
  });
}
