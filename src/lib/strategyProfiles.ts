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
    spreadWidths: [10, 15, 20],
    defaultWidth: 15,
    profitTarget: 0.30,
    ivRankMin: 30,
    timeStopDTE: 7,
    dteOptions: [
      { label: 'Short', val: 37, text: '30-45d' },
      { label: 'Optimal', val: 55, text: '45-65d' },
      { label: 'Extended', val: 75, text: '65-90d' },
    ],
    widthOptions: [
      { label: '$10', val: 10 },
      { label: '$15', val: 15 },
      { label: '$20', val: 20 },
    ],
    subtitle: 'Delta 0.35 \u2022 DTE 45-65 \u2022 $15 width \u2022 TP 30% \u2022 No SL',
  },
  shortTerm: {
    label: 'Short-Term (7-14 DTE)',
    shortLabel: 'ST',
    dteMin: 7,
    dteMax: 14,
    dtePeak: 10,
    dteSigma: 5,
    deltaMin: 0.20,
    deltaMax: 0.40,
    defaultDelta: 0.40,
    spreadWidths: [2.5, 5, 7.5, 10],
    defaultWidth: 2.5,
    profitTarget: 0.40,
    ivRankMin: 40,
    timeStopDTE: 1,
    dteOptions: [
      { label: 'Weekly', val: 7, text: '5-10d' },
      { label: 'Optimal', val: 10, text: '7-14d' },
      { label: 'Extended', val: 17, text: '14-21d' },
    ],
    widthOptions: [
      { label: '$2.5', val: 2.5 },
      { label: '$5', val: 5 },
      { label: '$7.5', val: 7.5 },
      { label: '$10', val: 10 },
    ],
    subtitle: 'Delta 0.40 \u2022 DTE 7-14 \u2022 $2.5 width \u2022 TP 40% \u2022 No SL',
  },
};

export function getProfile(strategy: StrategyType): StrategyProfile {
  return STRATEGY_PROFILES[strategy];
}

/** All DTE options from both profiles, grouped by strategy for the unified DTE selector */
export const ALL_DTE_OPTIONS: { strategy: StrategyType; label: string; val: number; text: string }[] = [
  ...STRATEGY_PROFILES.shortTerm.dteOptions.map(o => ({ strategy: 'shortTerm' as StrategyType, ...o })),
  ...STRATEGY_PROFILES.swing.dteOptions.map(o => ({ strategy: 'swing' as StrategyType, ...o })),
];

/** Derive the strategy type from a selected DTE value */
export function deriveStrategyFromDte(dteVal: number): StrategyType {
  // If the DTE value matches any shortTerm option, it's shortTerm
  if (STRATEGY_PROFILES.shortTerm.dteOptions.some(o => o.val === dteVal)) return 'shortTerm';
  // If it matches any swing option, it's swing
  if (STRATEGY_PROFILES.swing.dteOptions.some(o => o.val === dteVal)) return 'swing';
  // Fallback: below 30 = shortTerm, else swing
  return dteVal < 30 ? 'shortTerm' : 'swing';
}
