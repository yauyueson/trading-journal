import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import type { Position } from '../lib/types';

export function usePositions() {
  return useQuery({
    queryKey: queryKeys.positions,
    queryFn: async () => {
      const { data, error } = await supabase.from('positions').select('*');
      if (error) throw error;
      return (data ?? []) as Position[];
    },
  });
}
