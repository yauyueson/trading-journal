import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import { throwIfSupabaseError } from '../lib/supabaseResult';
import { groupTransactionsByPositionId, getOpenQuantity } from '../lib/utils';
import type { Position, Transaction } from '../lib/types';

/**
 * Active positions whose remaining quantity is 0 (stuck from a prior bug where
 * Take Profit / Size Down reduced qty to 0 without flipping status).
 *
 * Spreads with open legs are never "stuck": add-leg shorts are recorded as −qty
 * and leg-level closes as ±qty, so Σqty can hit 0 while the structure is still
 * live. Those close through explicit Close actions only.
 */
export function findStuckPositions(positions: Position[], transactions: Transaction[]): Position[] {
  const txByPos = groupTransactionsByPositionId(transactions);
  return positions.filter(p => {
    if (p.status !== 'active') return false;
    if ((p.legs ?? []).some(leg => !leg.closedAt)) return false;
    const txns = txByPos[p.id] ?? [];
    if (txns.length === 0) return false;
    return getOpenQuantity(txns) <= 0;
  });
}

export function useAutoCloseStuckPositions(
  positions: Position[],
  transactions: Transaction[],
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    for (const p of findStuckPositions(positions, transactions)) {
      supabase.from('positions').update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        exit_type: 'MANUAL',
      }).eq('id', p.id)
        .then(result => {
          throwIfSupabaseError(result);
          queryClient.invalidateQueries({ queryKey: queryKeys.positions });
        })
        .then(undefined, (err: unknown) => {
          console.error(`[auto-close] failed to close stuck position ${p.id}:`, err);
        });
    }
  }, [positions, transactions, queryClient]);
}
