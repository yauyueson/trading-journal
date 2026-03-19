// src/lib/strategyConfig.ts
// Frontend config hook — fetches from /api/strategy-config endpoint.
// Caches in React Query (staleTime 5min). Falls back to STRATEGY_PROFILES defaults.

import { useQuery } from '@tanstack/react-query';
import { STRATEGY_PROFILES, type StrategyType } from './strategyProfiles';

export interface StrategyConfigProfile {
  signalPreset: string;
  defaultDelta: number;
  defaultWidth: number;
  dteMin: number;
  dteMax: number;
  dtePeak: number;
  profitTarget: number;
  ivRankMin: number;
  timeStopDTE: number;
  maxPositions: number;
  maxPerTicker: number;
  adxGate: number | null;
  rvolGate: number;
  minScore: number;
}

export interface StrategyConfig {
  version: string;
  source: string;
  profiles: Record<string, StrategyConfigProfile>;
}

/** Fetch strategy config from API, cache for 5 min */
export function useStrategyConfig() {
  return useQuery<StrategyConfig>({
    queryKey: ['strategy-config'],
    queryFn: async () => {
      const res = await fetch('/api/strategy-config');
      if (!res.ok) throw new Error('Failed to fetch strategy config');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** Get a profile from config, falling back to STRATEGY_PROFILES */
export function getConfigProfile(
  config: StrategyConfig | undefined,
  strategy: StrategyType
): StrategyConfigProfile {
  if (config?.profiles?.[strategy]) {
    return config.profiles[strategy];
  }
  // Fallback from compile-time defaults
  const p = STRATEGY_PROFILES[strategy];
  return {
    signalPreset: p.signalPreset,
    defaultDelta: p.defaultDelta,
    defaultWidth: p.defaultWidth,
    dteMin: p.dteMin,
    dteMax: p.dteMax,
    dtePeak: p.dtePeak,
    profitTarget: p.profitTarget,
    ivRankMin: p.ivRankMin,
    timeStopDTE: p.timeStopDTE,
    maxPositions: p.maxPositions ?? 5,
    maxPerTicker: p.maxPerTicker,
    adxGate: p.adxGate ?? null,
    rvolGate: p.rvolGate ?? 0.5,
    minScore: p.minScore ?? 70,
  };
}
