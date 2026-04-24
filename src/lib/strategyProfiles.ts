/**
 * Strategy profile definitions.
 *
 * Active strategies (Phase F1 adoptions, sealed 2026-04-23):
 *   - bcd: Bull Call Debit Spread on QQQ, $2K-friendly.
 *   - pmcc: PMCC Diagonal on QQQ, $10K+ tier.
 *
 * Retired strategies kept for backward compat with existing DB rows.
 */

export type StrategyType = 'swing' | 'shortTerm' | 'dte5' | 'bcd' | 'pmcc';

/**
 * Structural shape of a strategy. Used by P&L, risk sizing, and UI
 * components that need to branch on credit/debit/diagonal.
 */
export type StrategyKind = 'credit_spread' | 'debit_spread' | 'diagonal';

export interface StrategyProfile {
  label: string;
  shortLabel: string;
  kind: StrategyKind;

  // Credit/debit spread params (two legs, SAME expiry).
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

  // Diagonal-only fields (PMCC). Optional on the interface so
  // credit/debit strategies don't need to set them.
  longDteMin?: number;
  longDteMax?: number;
  longDeltaMin?: number;
  longDeltaMax?: number;
  shortDteMin?: number;
  shortDteMax?: number;
  shortDeltaMin?: number;
  shortDeltaMax?: number;
  /** Diagonal: take-profit on the long LEAP leg (e.g. 0.60 = close LEAP at +60% P&L). */
  longProfitTarget?: number;
  /** Diagonal: take-profit on each short-leg cycle (e.g. 0.50 = close short when short-cycle P&L reaches 50%). */
  shortProfitTarget?: number;
  /** Diagonal: stop-loss on the long LEAP (e.g. 0.35 = close LEAP at -35% P&L). */
  longStopLoss?: number;
  /** Diagonal: roll the short leg when underlying price gets within this fraction of the short strike (e.g. 0.02 = 2%). */
  rollTriggerMoneyness?: number;

  // Universe
  tickers?: string[];
  direction?: 'bull' | 'bear';
}

/** Strategy types that are no longer active — kept for backward compat with DB data. */
export const RETIRED_STRATEGIES: ReadonlySet<StrategyType> = new Set<StrategyType>([
  'swing',
  'shortTerm',
  'dte5',
]);

/** Only active strategy types shown in UI. Both are concurrent (different capital tiers). */
export const ACTIVE_STRATEGIES: readonly StrategyType[] = ['bcd', 'pmcc'];

export const STRATEGY_PROFILES: Record<StrategyType, StrategyProfile> = {
  bcd: {
    label: 'BCD Wide (F1 Adopted)',
    shortLabel: 'BCD',
    kind: 'debit_spread',
    dteMin: 30,
    dteMax: 60,
    dtePeak: 45,
    dteSigma: 10,
    deltaMin: 0.20,
    deltaMax: 0.50,
    defaultDelta: 0.50,        // long leg delta (the bullish leg we're buying)
    spreadWidths: [5, 10, 15, 20],
    defaultWidth: 10,
    profitTarget: 0.50,        // close at +50% of debit paid
    stopLossMultiple: 0,       // no credit-multiple SL for debit
    trailingActivatePct: 0,
    trailingFloorPct: 0,
    ivRankMin: 0,
    timeStopDTE: 7,            // close when short leg has 7 DTE remaining (matches debitMinExitDTE)
    dteOptions: [
      { label: 'Short', val: 35, text: '30-45d' },
      { label: 'Optimal', val: 45, text: '30-60d' },
      { label: 'Extended', val: 55, text: '45-60d' },
    ],
    widthOptions: [
      { label: '$5', val: 5 },
      { label: '$10', val: 10 },
      { label: '$15', val: 15 },
      { label: '$20', val: 20 },
    ],
    subtitle: 'QQQ Only • Bull Call Debit • Long δ 0.50 / Short δ 0.20 • DTE 30-60 • PT 50% • 10d cadence',
    signalPreset: 'cadence10d',
    maxPerTicker: 1,
    maxPositions: 1,
    adxGate: null,
    rvolGate: 0,
    minScore: 0,
    minDirConfidence: 0,
    tickers: ['QQQ'],
    direction: 'bull',
  },
  pmcc: {
    label: 'PMCC pt60 (F1 Adopted)',
    shortLabel: 'PMCC',
    kind: 'diagonal',
    // Base dte/delta fields describe the SHORT leg (the cycle leg).
    dteMin: 30,
    dteMax: 45,
    dtePeak: 37,
    dteSigma: 7,
    deltaMin: 0.20,
    deltaMax: 0.30,
    defaultDelta: 0.25,        // short-leg delta
    spreadWidths: [],          // PMCC is a diagonal — width is emergent, not configured
    defaultWidth: 0,
    profitTarget: 0.50,        // short-leg cycle PT (mirrors shortProfitTarget)
    stopLossMultiple: 0,
    trailingActivatePct: 0,
    trailingFloorPct: 0,
    ivRankMin: 0,
    timeStopDTE: 0,
    dteOptions: [
      { label: 'Monthly', val: 37, text: '30-45d' },
    ],
    widthOptions: [],
    subtitle: 'QQQ Only • PMCC • Long δ 0.70-0.80 DTE 240-300 • Short δ 0.20-0.30 DTE 30-45 • Long PT 60% • Always-in',
    signalPreset: 'alwaysIn',
    maxPerTicker: 1,
    maxPositions: 1,
    adxGate: null,
    rvolGate: 0,
    minScore: 0,
    minDirConfidence: 0,
    // Diagonal-specific
    longDteMin: 240,
    longDteMax: 300,
    longDeltaMin: 0.70,
    longDeltaMax: 0.80,
    shortDteMin: 30,
    shortDteMax: 45,
    shortDeltaMin: 0.20,
    shortDeltaMax: 0.30,
    longProfitTarget: 0.60,       // close LEAP at +60%
    shortProfitTarget: 0.50,      // close each short cycle at +50%
    longStopLoss: 0.35,           // close LEAP at -35%
    rollTriggerMoneyness: 0.02,   // roll short when underlying within 2% of short strike
    tickers: ['QQQ'],
    direction: 'bull',
  },
  dte5: {
    label: 'DTE5 Bull Put (Retired)',
    shortLabel: 'DTE5',
    kind: 'credit_spread',
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
    subtitle: 'QQQ Only • Bull Put • Delta 30/20 • DTE 5 • EMA55 • SL 2.5x • TL 50/50 (RETIRED under F0)',
    signalPreset: 'ema',
    maxPerTicker: 1,
    maxPositions: 1,
    adxGate: null,
    rvolGate: 0,
    minScore: 0,              // EMA55 gate replaces tech score
    minDirConfidence: 0,
    tickers: ['QQQ'],
    direction: 'bull',
  },
  swing: {
    label: 'Swing (45-65 DTE)',
    shortLabel: 'Swing',
    kind: 'credit_spread',
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
    subtitle: 'Delta 0.35 • DTE 45-65 • $20 width • TP 40% • No SL',
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
    kind: 'credit_spread',
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
    subtitle: 'Delta 0.45 • DTE 7-21 • $10 width • TP 50% • No SL',
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


/** Derive the strategy type from a selected DTE value. Used by legacy entry flows. */
export function deriveStrategyFromDte(dteVal: number): StrategyType {
  // BCD F1 (30-60 DTE) — the currently active small-account strategy.
  if (dteVal >= 30 && dteVal <= 60) return 'bcd';
  // Legacy DTE5 (retired): 2-7 DTE
  if (dteVal <= 7) return 'dte5';
  // Legacy: shortTerm 7-21, swing 45+
  if (STRATEGY_PROFILES.shortTerm.dteOptions.some(o => o.val === dteVal)) return 'shortTerm';
  if (STRATEGY_PROFILES.swing.dteOptions.some(o => o.val === dteVal)) return 'swing';
  return dteVal < 30 ? 'shortTerm' : 'swing';
}
