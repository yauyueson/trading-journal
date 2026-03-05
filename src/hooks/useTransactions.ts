import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import type { Transaction } from '../lib/types';

export function useTransactions() {
  return useQuery({
    queryKey: queryKeys.transactions,
    queryFn: async () => {
      const { data, error } = await supabase.from('transactions').select('*');
      if (error) throw error;
      return (data ?? []) as Transaction[];
    },
  });
}
