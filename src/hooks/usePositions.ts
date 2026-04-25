import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import type { Position } from '../lib/types';

const POSITION_SELECT = [
  'id',
  'ticker',
  'strike',
  'type',
  'expiration',
  'status',
  'setup',
  'strategy',
  'entry_score',
  'current_score',
  'score_updated_at',
  'ideal_entry',
  'current_price',
  'stop_reason',
  'target_price',
  'stop_price',
  'notes',
  'created_at',
  'closed_at',
  'legs',
  'owner',
  'tech_score',
  'tech_score_auto',
  'tech_score_manual',
  'tech_score_source',
  'tech_score_updated_at',
  'tech_data',
  'direction',
  'market_state',
  'trade_profile',
  'iv_rank_entry',
  'iv_regime_entry',
  'max_risk_entry',
  'exit_type',
  'spread_width',
  'strategy_type',
  'is_paper',
].join(',');

export function usePositions() {
  return useQuery({
    queryKey: queryKeys.positions,
    queryFn: async () => {
      const { data, error } = await supabase.from('positions').select(POSITION_SELECT);
      if (error) throw error;
      return (data ?? []) as unknown as Position[];
    },
    staleTime: 45_000,
  });
}
