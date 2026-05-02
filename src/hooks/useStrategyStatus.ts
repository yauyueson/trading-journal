import { useMemo } from 'react';
import {
  ACTIVE_STRATEGIES,
  STRATEGY_PROFILES,
  type StrategyType,
  type StrategyProfile,
} from '../lib/strategyProfiles';
import type { Position } from '../lib/types';
import { usePositions } from './usePositions';

export type StrategyState = 'open' | 'ready' | 'waiting';

export interface StrategyStatus {
  strategy: StrategyType;
  profile: StrategyProfile;
  openPosition: Position | null;
  state: StrategyState;
  /** BCD only — trading days since last close (≥10 = eligible). */
  tradingDaysSince?: number;
  /** BCD only — next emission date (YYYY-MM-DD). */
  nextEmissionDate?: string;
  /** BCD only — calendar days until next emission (negative if already eligible). */
  daysUntilEmission?: number;
  /** Open only — open since date (YYYY-MM-DD). */
  openSinceDate?: string;
}

function addTradingDays(from: Date, n: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function deriveStatus(strategy: StrategyType, positions: Position[]): StrategyStatus {
  const profile = STRATEGY_PROFILES[strategy];
  const openPosition =
    positions.find(p => p.strategy_type === strategy && p.status === 'active') ?? null;

  if (openPosition) {
    return {
      strategy,
      profile,
      openPosition,
      state: 'open',
      openSinceDate: openPosition.created_at?.slice(0, 10),
    };
  }

  if (strategy === 'bcd') {
    const lastClosed =
      positions
        .filter(p => p.strategy_type === strategy && p.status === 'closed')
        .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))[0] ?? null;

    const ref = lastClosed?.closed_at ?? lastClosed?.created_at ?? null;
    if (!ref) {
      // Never traded — eligible to enter immediately.
      return {
        strategy,
        profile,
        openPosition: null,
        state: 'ready',
        tradingDaysSince: 10,
      };
    }

    const refDate = new Date(ref);
    const today = new Date();
    const tradingDaysSince = Math.max(
      0,
      Math.round((today.getTime() - refDate.getTime()) / (86400000 * 1.4)),
    );
    const nextEmission = addTradingDays(refDate, 10);
    const daysUntilEmission = Math.ceil(
      (nextEmission.getTime() - today.getTime()) / 86400000,
    );

    return {
      strategy,
      profile,
      openPosition: null,
      state: tradingDaysSince >= 10 ? 'ready' : 'waiting',
      tradingDaysSince,
      nextEmissionDate: formatDateOnly(nextEmission),
      daysUntilEmission,
    };
  }

  // PMCC — always-in when flat.
  return { strategy, profile, openPosition: null, state: 'ready' };
}

export function useStrategyStatus(): StrategyStatus[] {
  const { data: positions = [] } = usePositions();
  return useMemo(
    () => ACTIVE_STRATEGIES.map(s => deriveStatus(s, positions)),
    [positions],
  );
}
