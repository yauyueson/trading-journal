import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import type { Position, Transaction } from '../lib/types';

/**
 * Auto-close active positions that have 0 remaining quantity.
 * Catches positions stuck from prior bug where Take Profit / Size Down
 * reduced qty to 0 without flipping status to 'closed'.
 */
export function useAutoCloseStuckPositions(
  positions: Position[],
  transactions: Transaction[],
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const txByPos: Record<string, Transaction[]> = {};
    transactions.forEach(t => {
      if (!txByPos[t.position_id]) txByPos[t.position_id] = [];
      txByPos[t.position_id].push(t);
    });

    const stuck = positions.filter(p => {
      if (p.status !== 'active') return false;
      const txns = txByPos[p.id] ?? [];
      if (txns.length === 0) return false;
      return txns.reduce((sum, t) => sum + t.quantity, 0) <= 0;
    });

    for (const p of stuck) {
      supabase.from('positions').update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        exit_type: 'MANUAL',
      }).eq('id', p.id).then(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.positions });
      });
    }
  }, [positions, transactions, queryClient]);
}
