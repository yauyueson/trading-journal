import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export interface TradeOutcome {
  id: number;
  position_id: string;
  ticker: string;
  entry_date: string;
  exit_date: string | null;
  entry_price: number;
  direction: string;
  mfe_pct: number | null;
  mae_pct: number | null;
  mfe_bars: number | null;
  mae_bars: number | null;
  final_pct: number | null;
}

export function useTradeOutcomes() {
  return useQuery({
    queryKey: ['trade-outcomes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trade_outcomes')
        .select('*')
        .order('entry_date', { ascending: false });
      if (error) throw error;
      return (data ?? []) as TradeOutcome[];
    },
    staleTime: 5 * 60 * 1000,
  });
}
