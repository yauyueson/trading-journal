// src/lib/strategyConfig.ts
// Frontend config — imports strategy-config.json at build time.
// To update: edit data/strategy-config.json and redeploy.
// Falls back to STRATEGY_PROFILES defaults if import fails.

import { STRATEGY_PROFILES, type StrategyType } from './strategyProfiles';
import configJson from '../../data/strategy-config.json';

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

const _config = configJson as unknown as StrategyConfig;

/** Return strategy config (build-time import, no network call) */
export function useStrategyConfig() {
  return { data: _config };
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
