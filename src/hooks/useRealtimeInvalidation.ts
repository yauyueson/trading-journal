import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';

/**
 * Subscribe to Supabase realtime changes on positions and transactions tables.
 * On any change, invalidate the corresponding React Query cache.
 */
export function useRealtimeInvalidation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const posSub = supabase
      .channel('rq-positions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.positions });
      })
      .subscribe();

    const txnSub = supabase
      .channel('rq-transactions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.transactions });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(posSub);
      supabase.removeChannel(txnSub);
    };
  }, [queryClient]);
}
