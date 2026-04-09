/**
 * Strategy profile definitions for Swing and Short-Term credit spreads.
 * Centralizes all DTE/delta/width/TP parameters so pages and APIs
 * can read the active profile instead of hardcoding values.
 */

export type StrategyType = 'swing' | 'shortTerm' | 'dte5';

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
  /** Credit multiple SL — close at market if spread cost >= N x entry credit. 0 = disabled. */
  stopLossMultiple: number;
  /** Trailing lock activation — lock profit floor when unrealized profit reaches N% of max. 0 = disabled. */
  trailingActivatePct: number;
  /** Trailing lock floor — floor level as N% of TP target profit. Only active after activation. */
  trailingFloorPct: number;
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

/** Strategy types that are no longer active — kept for backward compat with DB data */
export const RETIRED_STRATEGIES: ReadonlySet<StrategyType> = new Set(['swing', 'shortTerm']);

/** Only active strategy types shown in UI */
export const ACTIVE_STRATEGIES: readonly StrategyType[] = ['dte5'];

export const STRATEGY_PROFILES: Record<StrategyType, StrategyProfile> = {
  dte5: {
    label: 'DTE5 Bull Put (Validated)',
    shortLabel: 'DTE5',
    dteMin: 2,
    dteMax: 7,
    dtePeak: 5,
    dteSigma: 2,
    deltaMin: 0.20,
    deltaMax: 0.30,
    defaultDelta: 0.30,       // short leg delta
    spreadWidths: [10],
    defaultWidth: 10,
    profitTarget: 1.0,        // hold-to-expiry = 100% of credit
    stopLossMultiple: 2.5,    // close at market if spread cost >= 2.5x entry credit
    trailingActivatePct: 0.50, // lock profit when 50% of max profit reached
    trailingFloorPct: 0.50,   // floor at 50% of TP target (locks half the gains)
    ivRankMin: 0,             // no IV rank filter (EMA55 gate replaces)
    timeStopDTE: 0,           // hold-to-expiry, no time stop
    dteOptions: [
      { label: 'DTE5', val: 5, text: '2-7d' },
    ],
    widthOptions: [{ label: '$10', val: 10 }],
    subtitle: 'QQQ Only \u2022 Bull Put \u2022 Delta 30/20 \u2022 DTE 5 \u2022 EMA55 \u2022 SL 2.5x \u2022 TL 50/50',
    signalPreset: 'ema',
    maxPerTicker: 1,
    maxPositions: 1,
    adxGate: null,
    rvolGate: 0,
    minScore: 0,              // EMA55 gate replaces tech score
    minDirConfidence: 0,
  },
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
    spreadWidths: [5, 10, 15, 20],
    defaultWidth: 20,
    profitTarget: 0.40,
    stopLossMultiple: 0,
    trailingActivatePct: 0,
    trailingFloorPct: 0,
    ivRankMin: 0,
    timeStopDTE: 3,
    dteOptions: [
      { label: 'Short', val: 37, text: '30-45d' },
      { label: 'Optimal', val: 55, text: '45-65d' },
      { label: 'Extended', val: 75, text: '65-90d' },
    ],
    widthOptions: [
      { label: '$5', val: 5 },
      { label: '$10', val: 10 },
      { label: '$15', val: 15 },
      { label: '$20', val: 20 },
    ],
    subtitle: 'Delta 0.35 \u2022 DTE 45-65 \u2022 $20 width \u2022 TP 40% \u2022 No SL',
    signalPreset: 'vol',
    maxPerTicker: 3,
    maxPositions: 5,
    adxGate: null,
    rvolGate: 0.5,
    minScore: 70,
    minDirConfidence: 70,
  },
  shortTerm: {
    label: 'Short DTE 130M (7-21 DTE)',
    shortLabel: 'ST',
    dteMin: 7,
    dteMax: 21,
    dtePeak: 14,
    dteSigma: 5,
    deltaMin: 0.25,
    deltaMax: 0.50,
    defaultDelta: 0.45,
    spreadWidths: [2.5, 5, 10],
    defaultWidth: 10,
    profitTarget: 0.50,
    stopLossMultiple: 0,
    trailingActivatePct: 0,
    trailingFloorPct: 0,
    ivRankMin: 20,
    timeStopDTE: 1,
    dteOptions: [
      { label: 'Weekly', val: 7, text: '5-10d' },
      { label: 'Optimal', val: 14, text: '7-21d' },
      { label: 'Extended', val: 21, text: '14-28d' },
    ],
    widthOptions: [
      { label: '$2.5', val: 2.5 },
      { label: '$5', val: 5 },
      { label: '$10', val: 10 },
    ],
    subtitle: 'Delta 0.45 \u2022 DTE 7-21 \u2022 $10 width \u2022 TP 50% \u2022 No SL',
    signalPreset: 'em',
    maxPerTicker: 2,
    maxPositions: 5,
    adxGate: null,
    rvolGate: 0.5,
    minScore: 70,
    minDirConfidence: 0,
  },
};

export function getProfile(strategy: StrategyType): StrategyProfile {
  return STRATEGY_PROFILES[strategy];
}

/** Merge live config values (from Supabase) with UI metadata from STRATEGY_PROFILES */
export function getMergedProfile(
  strategy: StrategyType,
  liveConfig?: Partial<Record<StrategyType, Partial<StrategyProfile>>>
): StrategyProfile {
  const base = STRATEGY_PROFILES[strategy];
  if (!liveConfig) return base;
  return { ...base, ...liveConfig[strategy] };
}

/** Derive the strategy type from a selected DTE value */
export function deriveStrategyFromDte(dteVal: number): StrategyType {
  // DTE5 validated strategy: 2-7 DTE
  if (dteVal <= 7) return 'dte5';
  // Legacy: shortTerm 7-21, swing 45+
  if (STRATEGY_PROFILES.shortTerm.dteOptions.some(o => o.val === dteVal)) return 'shortTerm';
  if (STRATEGY_PROFILES.swing.dteOptions.some(o => o.val === dteVal)) return 'swing';
  return dteVal < 30 ? 'shortTerm' : 'swing';
}
