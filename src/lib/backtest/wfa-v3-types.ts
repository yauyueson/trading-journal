/**
 * WFA v3 Type Definitions
 *
 * Extends v2 types with intraday-specific fields:
 * - indicatorPeriodMultiplier for 4H signal scaling
 * - BSM repricing parameters for intraday monitoring
 * - Shorter WFA windows (2 years of data)
 */

import type {
  DTEProfile,
  TPEConfig,
  ParameterSpace,
  WFAv2Result,
  WFAv2Window,
  StatsResult,
  HoldoutResult,
  PerRegimeMetrics,
  RankedConfig,
  ProfileBounds,
  GridConfig,
} from './wfa-v2-types';
import type { SignalPresetKey, SimConfig, EntrySignal, OptionTrade } from './option-sim';
import type { PeriodMultiplier } from './intraday-signals';

// Re-export v2 types used by v3
export type {
  DTEProfile,
  TPEConfig,
  ParameterSpace,
  WFAv2Window,
  StatsResult,
  HoldoutResult,
  PerRegimeMetrics,
  RankedConfig,
  SignalPresetKey,
  SimConfig,
  EntrySignal,
  OptionTrade,
};

// ── v3-Specific Profile Bounds ──────────────────────────

/** v3 short DTE profile with intraday monitoring */
export const V3_PROFILE_BOUNDS: ProfileBounds = {
  creditDTERange: [7, 21],
  creditSpreadWidth: [1, 10],
  creditShortDelta: [0.10, 0.50],
  creditProfitTarget: [0.30, 0.70],
  creditTimeStopDTE: [1, 3],
  monitoringIntervalDays: [1, 1],  // Not used — 4H monitoring replaces this
};

// ── v3 Grid Config ──────────────────────────────────────

export interface V3GridConfig extends GridConfig {
  indicatorPeriodMultiplier?: PeriodMultiplier[];
}

export const V3_SHORT_GRID: V3GridConfig = {
  signalWeightPreset: ['ema', 'mom', 'em', 'full', 'vol'],
  creditShortDelta: [0.25, 0.30, 0.35, 0.40, 0.45, 0.50],
  creditSpreadWidth: [1, 5, 10],
  creditProfitTarget: [0.30, 0.35, 0.40, 0.45, 0.50],
  minIVRank: [0, 10, 20, 30, 40, 50],
  creditTimeStopDTE: [1, 3],
  maxPositions: [5, 10],
  maxPerTicker: [3, 5],
  indicatorPeriodMultiplier: [1.5, 2.0, 2.5, 3.0],
};

// ── v3 SimConfig Extension ──────────────────────────────

/** Fields added to SimConfig for v3 intraday monitoring */
export interface V3SimConfigExtension {
  /** Indicator period multiplier for 4H signals */
  indicatorPeriodMultiplier: PeriodMultiplier;
  /** BSM kappa (O-U mean reversion speed) */
  bsmKappa: number;
  /** BSM risk-free rate */
  bsmRiskFreeRate: number;
  /** IV theta source used for O-U mean reversion */
  ivThetaSource: 'entry_iv' | 'hv60' | 'orats_iv60';
  /** Enable daily calibration to real chain */
  dailyCalibration: boolean;
  /** Intraday monitoring timeframe */
  intradayTimeframe: '4H';
}

// ── v3 WFA Config ───────────────────────────────────────

export interface WFAv3Config {
  // Window structure (shorter for 2-year data)
  trainWindowDays: number;     // 252 (1yr)
  forwardStepDays: number;     // 63 (1 quarter)
  purgeGapDays: number;        // 21
  mode: 'rolling';

  // Date range
  startDate: string;
  endDate: string;
  holdoutDays: number;         // 63 (last quarter reserved)

  // Tickers
  tickers: string[];

  // Portfolio
  startingCapital: number;     // 100_000

  // Optimization
  optimizerMode: 'ga' | 'tpe' | 'grid';
  trials: number;              // default 200
  seed: number;                // default 42

  // Statistical validation
  bootstrapResamples: number;  // 5_000
  cscvBlocks: number;          // 8 (fewer windows = fewer blocks)
  maxCscvCombinations: number; // 3000

  // Workers
  maxWorkers: number;

  // v3-specific
  intradayDBPath?: string;     // defaults to data/intraday-candles.sqlite
  chainDBPath?: string;        // defaults to data/option-chains.sqlite

  // BSM parameters
  bsmKappa: number;            // default 4.0
  bsmRiskFreeRate: number;     // default 0.04
  ivThetaSource: 'entry_iv' | 'hv60' | 'orats_iv60';
  dailyCalibration: boolean;   // default true
}

export const DEFAULT_WFA_V3_CONFIG: WFAv3Config = {
  trainWindowDays: 252,
  forwardStepDays: 63,
  purgeGapDays: 21,
  mode: 'rolling',
  startDate: '2024-03-01',    // ~2 years of intraday data
  endDate: '2026-03-15',
  holdoutDays: 63,
  tickers: [
    'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA',
    'AMZN', 'MSFT', 'META', 'NFLX', 'GOOG', 'GS', 'COST',
  ],
  startingCapital: 100_000,
  optimizerMode: 'ga',
  trials: 200,
  seed: 42,
  bootstrapResamples: 5_000,
  cscvBlocks: 8,
  maxCscvCombinations: 3000,
  maxWorkers: 8,
  bsmKappa: 4.0,
  bsmRiskFreeRate: 0.04,
  ivThetaSource: 'hv60',
  dailyCalibration: true,
};

// ── v3 Worker Message Types ─────────────────────────────

export interface V3WorkerEvalTask {
  type: 'eval';
  taskId: string;
  presetKey: SignalPresetKey;
  periodMultiplier: PeriodMultiplier;
  dateStart: string;
  dateEnd: string;
  config: SimConfig;
  maxDate: string;
}

export interface V3WorkerEvalResult {
  type: 'result';
  taskId: string;
  trades: OptionTrade[];
}

export interface V3WorkerInitResult {
  type: 'ready';
}

// ── v3 Result Type ──────────────────────────────────────

/** v3 result extends v2 result with intraday metadata */
export interface WFAv3Result extends WFAv2Result {
  /** v3-specific metadata */
  v3Meta: {
    intradayTimeframe: '4H';
    indicatorPeriodMultiplier: PeriodMultiplier;
    bsmKappa: number;
    bsmRiskFreeRate: number;
    ivThetaSource: 'entry_iv' | 'hv60' | 'orats_iv60';
    dailyCalibration: boolean;
    intraday4HBars: number;   // total 4H bars loaded
    signalSetsPrecomputed: number; // multipliers × presets
  };
}
