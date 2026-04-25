import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import type { FillDiagnosticsLeg } from '../lib/fillDiagnostics';

export interface FillDiagnosticRow {
  id: number;
  position_id: string;
  captured_at: string;
  chain_fetched_at: string | null;
  strategy_type: 'bcd' | 'pmcc' | null;
  quantity: number;
  actual_net_debit: number | null;
  actual_long_debit: number | null;
  actual_short_credit: number | null;
  legs: FillDiagnosticsLeg[];
  predicted_net_debit: number | null;
  predicted_slippage: number | null;
  slippage_delta_abs: number | null;
  notes: string | null;
}

export function useFillDiagnostics() {
  return useQuery({
    queryKey: queryKeys.fillDiagnostics,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fill_diagnostics')
        .select('*')
        .order('captured_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as FillDiagnosticRow[];
    },
    staleTime: 5 * 60 * 1000,
  });
}
