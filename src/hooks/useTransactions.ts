import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import type { Transaction } from '../lib/types';

const TRANSACTION_SELECT = [
  'id',
  'position_id',
  'type',
  'quantity',
  'price',
  'date',
  'note',
].join(',');

export function useTransactions() {
  return useQuery({
    queryKey: queryKeys.transactions,
    queryFn: async () => {
      const { data, error } = await supabase.from('transactions').select(TRANSACTION_SELECT);
      if (error) throw error;
      return (data ?? []) as unknown as Transaction[];
    },
    staleTime: 60_000,
  });
}
