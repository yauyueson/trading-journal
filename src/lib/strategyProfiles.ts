/**
 * Strategy profile definitions for Swing and Short-Term credit spreads.
 * Centralizes all DTE/delta/width/TP parameters so pages and APIs
 * can read the active profile instead of hardcoding values.
 */

export type StrategyType = 'swing' | 'shortTerm';

export interface StrategyProfile {
  label: string;
  shortLabel: string;
  dteMin: number;
  dteMax: number;
  dtePeak: number;
  dteSigma: number;
  deltaMin: number;
  deltaMax: number;
  defaultDelta: number;
  spreadWidths: number[];
  defaultWidth: number;
  profitTarget: number;
  ivRankMin: number;
  timeStopDTE: number;
  dteOptions: { label: string; val: number; text: string }[];
  widthOptions: { label: string; val: number }[];
  subtitle: string;
  signalPreset: string;
  maxPerTicker: number;
  maxPositions: number;
  adxGate: number | null;
  rvolGate: number;
  minScore: number;
  minDirConfidence: number;
}

export const STRATEGY_PROFILES: Record<StrategyType, StrategyProfile> = {
  swing: {
    label: 'Swing (45-65 DTE)',
    shortLabel: 'Swing',
    dteMin: 45,
    dteMax: 65,
    dtePeak: 55,
    dteSigma: 15,
    deltaMin: 0.28,
    deltaMax: 0.42,
    defaultDelta: 0.35,
    spreadWidths: [5, 10, 15],
    defaultWidth: 10,
    profitTarget: 0.30,
    ivRankMin: 20,
    timeStopDTE: 5,
    dteOptions: [
      { label: 'Short', val: 37, text: '30-45d' },
      { label: 'Optimal', val: 55, text: '45-65d' },
      { label: 'Extended', val: 75, text: '65-90d' },
    ],
    widthOptions: [
      { label: '$5', val: 5 },
      { label: '$10', val: 10 },
      { label: '$15', val: 15 },
    ],
    subtitle: 'Delta 0.35 \u2022 DTE 45-65 \u2022 $10 width \u2022 TP 30% \u2022 No SL',
    signalPreset: 'vol',
    maxPerTicker: 3,
    maxPositions: 5,
    adxGate: null,
    rvolGate: 0.5,
    minScore: 70,
    minDirConfidence: 50,
  },
  shortTerm: {
    label: 'Short DTE (7-21 DTE)',
    shortLabel: 'ST',
    dteMin: 7,
    dteMax: 21,
    dtePeak: 14,
    dteSigma: 5,
    deltaMin: 0.25,
    deltaMax: 0.40,
    defaultDelta: 0.35,
    spreadWidths: [1, 2.5, 5],
    defaultWidth: 1,
    profitTarget: 0.35,
    ivRankMin: 50,
    timeStopDTE: 1,
    dteOptions: [
      { label: 'Weekly', val: 7, text: '5-10d' },
      { label: 'Optimal', val: 14, text: '7-21d' },
      { label: 'Extended', val: 21, text: '14-28d' },
    ],
    widthOptions: [
      { label: '$1', val: 1 },
      { label: '$2.5', val: 2.5 },
      { label: '$5', val: 5 },
    ],
    subtitle: 'Delta 0.35 \u2022 DTE 7-21 \u2022 $1 width \u2022 TP 35% \u2022 No SL',
    signalPreset: 'em',
    maxPerTicker: 5,
    maxPositions: 5,
    adxGate: 15,
    rvolGate: 0.5,
    minScore: 70,
    minDirConfidence: 40,
  },
};

export function getProfile(strategy: StrategyType): StrategyProfile {
  return STRATEGY_PROFILES[strategy];
}

/** Derive the strategy type from a selected DTE value */
export function deriveStrategyFromDte(dteVal: number): StrategyType {
  // If the DTE value matches any shortTerm option, it's shortTerm
  if (STRATEGY_PROFILES.shortTerm.dteOptions.some(o => o.val === dteVal)) return 'shortTerm';
  // If it matches any swing option, it's swing
  if (STRATEGY_PROFILES.swing.dteOptions.some(o => o.val === dteVal)) return 'swing';
  // Fallback: below 30 = shortTerm, else swing
  return dteVal < 30 ? 'shortTerm' : 'swing';
}
