import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import type { Position } from '../lib/types';

// `as const satisfies` enforces that every entry below is a valid `keyof Position`
// (catches typos / removed fields). The `_AllKeysCovered` guard below catches the
// reverse direction: any new field added to `Position` must be added here, or the
// build fails. Together they make this list a maintained contract — the only
// alternative for `select(*)` performance without schema-drift risk.
const POSITION_COLUMNS = [
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
] as const satisfies readonly (keyof Position)[];

// Build-time guard: if any `keyof Position` is missing from `POSITION_COLUMNS`,
// `_MissingKeys` resolves to that key union, the conditional resolves to `never`,
// and `const _AllKeysCovered: never = true` fails to compile — usually with the
// missing key name in the error message.
type _MissingKeys = Exclude<keyof Position, typeof POSITION_COLUMNS[number]>;
const _AllKeysCovered: _MissingKeys extends never ? true : never = true;
void _AllKeysCovered;

const POSITION_SELECT = POSITION_COLUMNS.join(',');

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
