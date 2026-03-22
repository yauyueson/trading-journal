/**
 * WFA v3 Optimizer — Parameter Space + Config Builder
 *
 * Extends v2 optimizer with indicatorPeriodMultiplier as a new
 * categorical parameter. Reuses v2 TPE/grid infrastructure.
 */

import type { ParameterSpace, SignalPresetKey } from './wfa-v2-types';
import type { SimConfig } from './option-sim';
import type { PeriodMultiplier } from './intraday-signals';
import { PERIOD_MULTIPLIERS } from './intraday-signals';
import { V3_PROFILE_BOUNDS } from './wfa-v3-types';

// ── Parameter Space ─────────────────────────────────────

/**
 * Build v3 parameter space for short-DTE intraday optimization.
 * Same as v2 short profile but:
 * - Adds indicatorPeriodMultiplier as categorical [1.5, 2.0, 2.5, 3.0]
 * - Removes monitoringIntervalDays (replaced by 4H bar monitoring)
 */
export function buildV3ParameterSpace(): ParameterSpace {
  const bounds = V3_PROFILE_BOUNDS;

  return {
    continuous: [
      { name: 'creditShortDelta', low: bounds.creditShortDelta[0], high: bounds.creditShortDelta[1] },
      { name: 'creditSpreadWidth', low: bounds.creditSpreadWidth[0], high: bounds.creditSpreadWidth[1] },
      { name: 'creditProfitTarget', low: bounds.creditProfitTarget[0], high: bounds.creditProfitTarget[1] },
      // SL locked to no-stop: Phase 1 proved SL 2x destroys returns
      { name: 'creditStopLossMultiple', low: 50, high: 100 },
      // Delta stop
      { name: 'creditDeltaStop', low: 0, high: 0.05 },
      { name: 'minIVRank', low: 0, high: 50 },
      { name: 'vrpFilter', low: -0.05, high: 0.30 },
      { name: 'contangoFilter', low: -0.10, high: 0.20 },
      { name: 'maxIVSkew', low: 0.01, high: 0.20 },
      { name: 'slopeFilter', low: -5.0, high: 5.0 },
    ],
    integer: [
      { name: 'creditTimeStopDTE', low: bounds.creditTimeStopDTE[0], high: bounds.creditTimeStopDTE[1] },
      { name: 'maxPerTicker', low: 1, high: 10 },
      { name: 'maxPositions', low: 3, high: 15 },
    ],
    categorical: [
      { name: 'signalWeightPreset', choices: ['ema', 'mom', 'em', 'mf', 'full', 'mb', 'adx', 'vol'] },
      { name: 'useSmvVol', choices: [true, false] },
      { name: 'dirConfTier', choices: ['any', 'medium+', 'high'] },
      { name: 'indicatorPeriodMultiplier', choices: PERIOD_MULTIPLIERS.map(String) },
    ],
  };
}

// ── Config Builder ──────────────────────────────────────

/**
 * Convert raw params dict to a SimConfig for v3 intraday evaluation.
 * Same as v2's paramsToSimConfig but uses v3 short profile bounds.
 */
export function v3ParamsToSimConfig(
  params: Record<string, number | string | boolean>,
): SimConfig {
  const bounds = V3_PROFILE_BOUNDS;
  const fillMode = params.fillMode === 'mid' ? 'mid' : 'bidask';

  return {
    mode: 'CREDIT_SPREAD',
    // LEAP defaults (unused)
    leapDeltaRange: [0.65, 0.80],
    leapDTERange: [180, 365],
    leapProfitTarget: 0.50,
    leapStopLoss: 0.30,
    leapTimeStopDTE: 90,
    // Credit spread params
    creditShortDelta: params.creditShortDelta as number,
    creditSpreadWidth: params.creditSpreadWidth as number,
    creditDTERange: bounds.creditDTERange,
    creditProfitTarget: params.creditProfitTarget as number,
    creditStopLossMultiple: params.creditStopLossMultiple as number,
    creditTimeStopDTE: params.creditTimeStopDTE as number,
    creditDeltaStop: (params.creditDeltaStop as number) || undefined,
    monitoringIntervalDays: 1,  // Not used — 4H monitoring
    minIVRank: params.minIVRank as number,
    fillMode,
    slippage: {
      enabled: fillMode === 'bidask',
      fillMode: 'bidask',
      executionStyle: 'combo',
      baseImpactBps: 2,
      oiHalfLife: 500,
      maxOiFactor: 6,
      dteAccelDays: 7,
      dteAccelMultiplier: 3.0,
    },
    maxBidAskSpreadPct: undefined,
    minShortOI: undefined,
    maxGammaThetaRatio: undefined,
    maxIVSkew: (params.maxIVSkew as number) < 1 ? (params.maxIVSkew as number) : undefined,
    signalWeightPreset: params.signalWeightPreset as SignalPresetKey,
    vrpFilter: (params.vrpFilter as number) || undefined,
    contangoFilter: (params.contangoFilter as number) || undefined,
    slopeFilter: (params.slopeFilter as number) || undefined,
    useSmvVol: params.useSmvVol as boolean,
    dirConfTier: (params.dirConfTier as string) || 'any',
    indicatorPeriodMultiplier: extractPeriodMultiplier(params),
    bsmKappa: typeof params.bsmKappa === 'number' ? params.bsmKappa : 4.0,
    bsmRiskFreeRate: typeof params.bsmRiskFreeRate === 'number' ? params.bsmRiskFreeRate : 0.04,
    dailyCalibration: typeof params.dailyCalibration === 'boolean' ? params.dailyCalibration : true,
    ivThetaSource: (params.ivThetaSource as SimConfig['ivThetaSource']) || 'hv60',
  } as any;
}

/**
 * Extract the indicatorPeriodMultiplier from params.
 * Returns the multiplier value, defaulting to 2.0.
 */
export function extractPeriodMultiplier(
  params: Record<string, number | string | boolean>,
): PeriodMultiplier {
  const val = params.indicatorPeriodMultiplier;
  const parsed = typeof val === 'number'
    ? val
    : typeof val === 'string'
      ? Number(val)
      : Number.NaN;
  if (PERIOD_MULTIPLIERS.includes(parsed as PeriodMultiplier)) {
    return parsed as PeriodMultiplier;
  }
  return 2.0;
}
