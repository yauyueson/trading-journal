import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import { formatDate } from '../lib/utils';
import type { Position, PositionAction, DirectAddItem, WatchlistItem, RollData } from '../lib/types';

function useInvalidatePositionsAndTransactions() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.positions });
    queryClient.invalidateQueries({ queryKey: queryKeys.transactions });
  };
}

/** Insert a transaction + optionally close the position */
export function usePositionAction() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ id, action, exitType }: { id: string; action: PositionAction; exitType?: Position['exit_type'] }) => {
      await supabase.from('transactions').insert([{
        position_id: id,
        type: action.type,
        quantity: action.quantity,
        price: action.price,
        note: action.type,
      }]);
      if (action.type === 'Close') {
        await supabase.from('positions').update({
          status: 'closed',
          closed_at: new Date().toISOString(),
          ...(exitType ? { exit_type: exitType } : {}),
        }).eq('id', id);
      }
    },
    onSuccess: invalidate,
  });
}

export function useUpdateScore() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ id, score }: { id: string; score: number }) => {
      await supabase.from('positions').update({
        current_score: score,
        tech_score: score,
        tech_score_manual: score,
        tech_score_source: 'manual',
        score_updated_at: new Date().toISOString(),
        tech_score_updated_at: new Date().toISOString(),
      }).eq('id', id);
    },
    onSuccess: invalidate,
  });
}

export function useUpdatePrice() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ id, price }: { id: string; price: number }) => {
      await supabase.from('positions').update({ current_price: price }).eq('id', id);
    },
    onSuccess: invalidate,
  });
}

export function useUpdateTarget() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ id, target }: { id: string; target: number }) => {
      await supabase.from('positions').update({ target_price: target }).eq('id', id);
    },
    onSuccess: invalidate,
  });
}

export function useUpdateStop() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ id, stopPrice }: { id: string; stopPrice: number }) => {
      await supabase.from('positions').update({ stop_price: stopPrice }).eq('id', id);
    },
    onSuccess: invalidate,
  });
}

export function useUpdateNotes() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes: string }) => {
      await supabase.from('positions').update({ notes }).eq('id', id);
    },
    onSuccess: invalidate,
  });
}

export function useUpdateOwner() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ id, owner }: { id: string; owner: 'Yuchen' | 'Annie' | null }) => {
      await supabase.from('positions').update({ owner }).eq('id', id);
    },
    onSuccess: invalidate,
  });
}

export function useAddDirect() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async (item: DirectAddItem) => {
      const { data, error } = await supabase.from('positions').insert([{
        ticker: item.ticker,
        strike: item.strike,
        type: item.type,
        expiration: item.expiration,
        setup: item.setup,
        strategy: item.strategy || item.type,
        status: 'active',
        entry_score: item.entry_score,
        current_score: item.entry_score,
        score_updated_at: new Date().toISOString(),
        notes: item.ticker + ' ' + item.type,
        stop_reason: item.stop_reason,
        legs: item.legs || null,
        owner: item.owner || null,
        tech_score: item.tech_score,
        tech_score_source: item.tech_score_source || 'manual',
        tech_score_manual: item.tech_score,
        direction: item.direction || null,
        market_state: item.market_state || null,
        iv_regime_entry: item.iv_regime_entry || null,
        max_risk_entry: item.max_risk_entry || null,
        trade_profile: item.trade_profile || null,
        iv_rank_entry: item.iv_rank_entry ?? null,
        spread_width: item.spread_width ?? null,
        strategy_type: item.strategy_type || null,
        is_paper: item.is_paper ?? false,
        target_price: item.target_price ?? null,
      }]).select();

      if (error) throw error;
      if (data && data[0]) {
        await supabase.from('transactions').insert([{
          position_id: data[0].id,
          type: 'Open',
          quantity: item.quantity,
          price: item.entry_price,
          note: 'Initial Entry',
        }]);
      }
    },
    onSuccess: invalidate,
  });
}

export function useRollPosition() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ originalPosition, rollData }: { originalPosition: Position; rollData: RollData }) => {
      // Close existing
      await supabase.from('transactions').insert([{
        position_id: originalPosition.id,
        type: 'Close',
        quantity: rollData.closeQty,
        price: rollData.closePrice,
        note: 'Rolled Position',
      }]);

      await supabase.from('positions').update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        exit_type: 'ROLL',
      }).eq('id', originalPosition.id);

      // Open new
      const { data: newPosData } = await supabase.from('positions').insert([{
        ticker: originalPosition.ticker,
        strike: rollData.newStrike,
        type: rollData.newType,
        expiration: rollData.newExpiration,
        setup: originalPosition.setup,
        status: 'active',
        entry_score: originalPosition.entry_score,
        current_score: originalPosition.current_score,
        score_updated_at: new Date().toISOString(),
        notes: `Rolled from ${originalPosition.ticker} $${originalPosition.strike} ${formatDate(originalPosition.expiration)}`,
        stop_reason: originalPosition.stop_reason,
        owner: originalPosition.owner || null,
      }]).select();

      if (newPosData && newPosData[0]) {
        await supabase.from('transactions').insert([{
          position_id: newPosData[0].id,
          type: 'Open',
          quantity: rollData.newQty,
          price: rollData.newPrice,
          note: 'Rolled from prev position',
        }]);
      }
    },
    onSuccess: invalidate,
  });
}

export function useAddToWatchlist() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async (item: WatchlistItem) => {
      const { error } = await supabase.from('positions').insert([{
        ticker: item.ticker,
        strike: item.strike,
        type: item.type,
        expiration: item.expiration,
        setup: item.setup,
        strategy: item.strategy || null,
        status: 'watchlist',
        entry_score: item.entry_score,
        ideal_entry: item.ideal_entry,
        target_price: item.target_price,
        stop_reason: item.stop_reason,
        notes: item.notes,
        legs: item.legs,
        owner: item.owner || null,
        tech_score: item.tech_score,
        tech_score_manual: item.tech_score,
        tech_score_source: item.tech_score_source || 'manual',
        direction: item.direction || null,
        market_state: item.market_state || null,
        trade_profile: item.trade_profile || null,
        iv_rank_entry: item.iv_rank_entry ?? null,
        iv_regime_entry: item.iv_regime_entry || null,
      }]);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useDeletePosition() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('positions').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useMoveToActive() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ position, qty, price }: { position: Position; qty: number; price: number }) => {
      await supabase.from('positions').update({
        status: 'active',
        current_score: position.entry_score,
        score_updated_at: new Date().toISOString(),
      }).eq('id', position.id);

      await supabase.from('transactions').insert([{
        position_id: position.id,
        type: 'Open',
        quantity: qty,
        price: price,
        note: 'Moved from Watchlist',
      }]);
    },
    onSuccess: invalidate,
  });
}
