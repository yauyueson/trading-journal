import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import { formatDate } from '../lib/utils';
import { requireSupabaseData, throwIfSupabaseError } from '../lib/supabaseResult';
import { buildExecutionTicketAuditRowFromDirectAdd, isGovernedDirectAddStrategy } from '../lib/executionTickets';
import type { Position, PositionAction, DirectAddItem, WatchlistItem, RollData, PositionLeg } from '../lib/types';

export interface PMCCRollShortInput {
  position: Position;
  /** Debit paid per share to close the existing short leg. */
  closeCost: number;
  /** New short leg strike. */
  newStrike: number;
  /** New short leg expiration (YYYY-MM-DD). */
  newExpiration: string;
  /** Credit received per share for the new short leg. */
  newCredit: number;
  /** Quantity for the cycle (defaults to existing cycle qty / position qty). */
  cycleQty?: number;
}

function useInvalidatePositionsAndTransactions() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.positions });
    queryClient.invalidateQueries({ queryKey: queryKeys.transactions });
  };
}

function useInvalidatePositions() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.positions });
  };
}

/** Factory for simple single-field position update mutations */
function usePositionFieldUpdate<K extends string>(
  field: K,
  column: string = field,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string } & Record<K, unknown>) => {
      throwIfSupabaseError(await supabase.from('positions').update({ [column]: vars[field] }).eq('id', vars.id));
      return vars;
    },
    onSuccess: vars => {
      queryClient.setQueryData<Position[]>(queryKeys.positions, old => {
        if (!old) return old;
        return old.map(position =>
          position.id === vars.id
            ? { ...position, [column]: vars[field] } as Position
            : position,
        );
      });
    },
  });
}

/** Insert a transaction + optionally close the position */
export function usePositionAction() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ id, action, exitType }: { id: string; action: PositionAction; exitType?: Position['exit_type'] }) => {
      throwIfSupabaseError(await supabase.from('transactions').insert([{
        position_id: id,
        type: action.type,
        quantity: action.quantity,
        price: action.price,
        note: action.type,
      }]));
      if (action.type === 'Close') {
        throwIfSupabaseError(await supabase.from('positions').update({
          status: 'closed',
          closed_at: new Date().toISOString(),
          ...(exitType ? { exit_type: exitType } : {}),
        }).eq('id', id));
      } else if (action.type === 'Take Profit' || action.type === 'Size Down') {
        // Auto-close if remaining quantity is 0
        const { data: txns } = throwIfSupabaseError(await supabase
          .from('transactions')
          .select('quantity')
          .eq('position_id', id));
        const remaining = (txns || []).reduce((sum, t) => sum + t.quantity, 0);
        if (remaining <= 0) {
          throwIfSupabaseError(await supabase.from('positions').update({
            status: 'closed',
            closed_at: new Date().toISOString(),
            exit_type: action.type === 'Take Profit' ? 'TP' : 'MANUAL',
          }).eq('id', id));
        }
      }
    },
    onSuccess: invalidate,
  });
}

export function useUpdateScore() {
  const invalidate = useInvalidatePositions();
  return useMutation({
    mutationFn: async ({ id, score }: { id: string; score: number }) => {
      throwIfSupabaseError(await supabase.from('positions').update({
        current_score: score,
        tech_score: score,
        tech_score_manual: score,
        tech_score_source: 'manual',
        score_updated_at: new Date().toISOString(),
        tech_score_updated_at: new Date().toISOString(),
      }).eq('id', id));
    },
    onSuccess: invalidate,
  });
}

export function useUpdatePrice() {
  return usePositionFieldUpdate<'price'>('price', 'current_price');
}

export function useUpdateTarget() {
  return usePositionFieldUpdate<'target'>('target', 'target_price');
}

export function useUpdateStop() {
  return usePositionFieldUpdate<'stopPrice'>('stopPrice', 'stop_price');
}

export function useUpdateNotes() {
  return usePositionFieldUpdate<'notes'>('notes');
}

export function useUpdateOwner() {
  return usePositionFieldUpdate<'owner'>('owner');
}

export function useUpdatePaper() {
  return usePositionFieldUpdate<'isPaper'>('isPaper', 'is_paper');
}

export function useAddDirect() {
  const invalidate = useInvalidatePositionsAndTransactions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (item: DirectAddItem) => {
      let activePositions = queryClient.getQueryData<Position[]>(queryKeys.positions) ?? [];
      if (isGovernedDirectAddStrategy(item.strategy_type)) {
        const { data } = throwIfSupabaseError(await supabase
          .from('positions')
          .select('id,ticker,strike,type,expiration,status,setup,entry_score,current_score,strategy_type,is_paper,max_risk_entry')
          .eq('status', 'active'));
        activePositions = (data ?? []) as Position[];
      }
      const ticketAuditRow = buildExecutionTicketAuditRowFromDirectAdd(item, activePositions);
      if (ticketAuditRow) {
        throwIfSupabaseError(await supabase.from('execution_tickets').insert([ticketAuditRow]));
        if (ticketAuditRow.decision === 'blocked') {
          throw new Error(`Execution ticket blocked: ${ticketAuditRow.blocks.join('; ')}`);
        }
      }

      const data = requireSupabaseData(await supabase.from('positions').insert([{
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
      }]).select(), 'Position insert returned no rows');

      if (data && data[0]) {
        if (ticketAuditRow) {
          throwIfSupabaseError(await supabase
            .from('execution_tickets')
            .update({ position_id: data[0].id })
            .eq('ticket_id', ticketAuditRow.ticket_id));
        }

        throwIfSupabaseError(await supabase.from('transactions').insert([{
          position_id: data[0].id,
          type: 'Open',
          quantity: item.quantity,
          price: item.entry_price,
          note: 'Initial Entry',
        }]));

        // Fill-quality capture: best-effort. If the insert fails (missing
        // table, schema drift, RLS), log and move on — don't fail the trade
        // entry on a diagnostics hiccup.
        if (item.fill_diagnostics) {
          const d = item.fill_diagnostics;
          try {
            const { error } = await supabase.from('fill_diagnostics').insert([{
              position_id: data[0].id,
              chain_fetched_at: d.chainFetchedAt,
              strategy_type: d.strategyType,
              quantity: d.quantity,
              actual_net_debit: d.actualNetDebit,
              actual_long_debit: d.actualLongDebit,
              actual_short_credit: d.actualShortCredit,
              legs: d.legs,
              predicted_net_debit: d.predictedNetDebit,
              predicted_slippage: d.predictedSlippage,
              slippage_delta_abs: d.slippageDeltaAbs,
            }]);
            if (error) console.warn('[fill_diagnostics] insert failed (non-fatal):', error.message);
          } catch (err) {
            console.warn('[fill_diagnostics] insert threw (non-fatal):', err);
          }
        }
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
      throwIfSupabaseError(await supabase.from('transactions').insert([{
        position_id: originalPosition.id,
        type: 'Close',
        quantity: rollData.closeQty,
        price: rollData.closePrice,
        note: 'Rolled Position',
      }]));

      throwIfSupabaseError(await supabase.from('positions').update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        exit_type: 'ROLL',
      }).eq('id', originalPosition.id));

      // Open new
      const newPosData = requireSupabaseData(await supabase.from('positions').insert([{
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
      }]).select(), 'Rolled position insert returned no rows');

      if (newPosData && newPosData[0]) {
        throwIfSupabaseError(await supabase.from('transactions').insert([{
          position_id: newPosData[0].id,
          type: 'Open',
          quantity: rollData.newQty,
          price: rollData.newPrice,
          note: 'Rolled from prev position',
        }]));
      }
    },
    onSuccess: invalidate,
  });
}

/**
 * Update a single leg's metadata (strike, expiration, openedCredit/Debit) on a position.
 * Identifies the leg by index in position.legs. Used by the click-to-edit subleg UI.
 */
export function useUpdateLeg() {
  const invalidate = useInvalidatePositions();
  return useMutation({
    mutationFn: async ({ position, legIndex, patch }: { position: Position; legIndex: number; patch: Partial<PositionLeg> }) => {
      const legs = position.legs ?? [];
      if (legIndex < 0 || legIndex >= legs.length) throw new Error(`leg index ${legIndex} out of range`);
      const updated = legs.map((leg, i) => i === legIndex ? { ...leg, ...patch } : leg);
      throwIfSupabaseError(await supabase.from('positions').update({ legs: updated }).eq('id', position.id));
    },
    onSuccess: invalidate,
  });
}

/**
 * Roll the SHORT leg of a PMCC diagonal, leaving the long LEAP untouched.
 * Marks the current active short as closed (with closedAt + closedCost) and
 * appends a new active short leg. Records two transactions for cycle audit.
 */
export function useRollPMCCShort() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ position, closeCost, newStrike, newExpiration, newCredit, cycleQty }: PMCCRollShortInput) => {
      const legs = position.legs ?? [];
      const activeShortIdx = legs.findIndex(l => l.side === 'short' && !l.closedAt);
      if (activeShortIdx < 0) throw new Error('PMCC has no active short leg to roll');
      const oldShort = legs[activeShortIdx];
      const qty = cycleQty ?? oldShort.cycleQty ?? 1;

      const closedShort: PositionLeg = {
        ...oldShort,
        closedAt: new Date().toISOString(),
        closedCost: closeCost,
        cycleQty: qty,
      };
      const newShort: PositionLeg = {
        strike: newStrike,
        type: oldShort.type,
        side: 'short',
        expiration: newExpiration,
        openedCredit: newCredit,
        cycleQty: qty,
      };
      const updatedLegs = [...legs];
      updatedLegs[activeShortIdx] = newShort;
      updatedLegs.push(closedShort);

      throwIfSupabaseError(await supabase.from('positions').update({
        legs: updatedLegs,
      }).eq('id', position.id));

      throwIfSupabaseError(await supabase.from('transactions').insert([
        {
          position_id: position.id,
          type: 'Take Profit',
          quantity: qty,
          price: closeCost,
          note: `PMCC roll: close short K=${oldShort.strike} exp=${oldShort.expiration}`,
        },
        {
          position_id: position.id,
          type: 'Take Profit',
          quantity: -qty,
          price: newCredit,
          note: `PMCC roll: open short K=${newStrike} exp=${newExpiration}`,
        },
      ]));
    },
    onSuccess: invalidate,
  });
}

export function useAddToWatchlist() {
  const invalidate = useInvalidatePositions();
  return useMutation({
    mutationFn: async (item: WatchlistItem) => {
      throwIfSupabaseError(await supabase.from('positions').insert([{
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
      }]));
    },
    onSuccess: invalidate,
  });
}

export function useDeletePosition() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async (id: string) => {
      throwIfSupabaseError(await supabase.from('positions').delete().eq('id', id));
    },
    onSuccess: invalidate,
  });
}

export function useMoveToActive() {
  const invalidate = useInvalidatePositionsAndTransactions();
  return useMutation({
    mutationFn: async ({ position, qty, price }: { position: Position; qty: number; price: number }) => {
      throwIfSupabaseError(await supabase.from('positions').update({
        status: 'active',
        current_score: position.entry_score,
        score_updated_at: new Date().toISOString(),
      }).eq('id', position.id));

      throwIfSupabaseError(await supabase.from('transactions').insert([{
        position_id: position.id,
        type: 'Open',
        quantity: qty,
        price: price,
        note: 'Moved from Watchlist',
      }]));
    },
    onSuccess: invalidate,
  });
}
