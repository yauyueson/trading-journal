// src/lib/strategyConfig.ts
// Frontend config — reads from AppSettings context (Supabase-backed).
// Falls back to build-time JSON import if context value is not yet available.

import { STRATEGY_PROFILES, type StrategyType } from './strategyProfiles';
import { useAppSettings } from '../context/AppSettingsContext';
import { DEFAULT_APP_SETTINGS } from './types/settings';
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
  minDirConfidence: number;
}

export interface StrategyConfig {
  version: string;
  source: string;
  profiles: Record<string, StrategyConfigProfile>;
}

const _buildTimeConfig = configJson as unknown as StrategyConfig;

/** Return strategy config — prefers Supabase-backed AppSettings, falls back to build-time JSON */
export function useStrategyConfig() {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { settings } = useAppSettings();
    if (settings.creditSpread) {
      return {
        data: {
          version: 'live',
          source: 'supabase',
          profiles: settings.creditSpread as Record<string, StrategyConfigProfile>,
        } as StrategyConfig,
      };
    }
  } catch {
    // Outside provider — use build-time config
  }
  return { data: _buildTimeConfig };
}

/** Non-hook version for use outside React components */
export function getBuildTimeConfig(): StrategyConfig {
  return _buildTimeConfig;
}

/** Get default credit spread config (for reset buttons) */
export function getDefaultCreditSpreadConfig() {
  return DEFAULT_APP_SETTINGS.creditSpread!;
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
    minDirConfidence: p.minDirConfidence ?? 50,
  };
}
