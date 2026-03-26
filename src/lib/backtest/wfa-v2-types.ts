/**
 * WFA v2 Type Definitions
 *
 * Comprehensive Walk-Forward Analysis with:
 * - TPE Bayesian optimization
 * - Statistical validation (DSR, PBO, Monte Carlo)
 * - Regime analysis
 * - Multi-objective ranking
 * - 4-layer validation pipeline
 */

import type { WalkForwardMode, DirConfTier } from './types';
import type { OptionTrade, SimConfig, OptionSimAnalytics, SignalPresetKey, EntrySignal } from './option-sim';

// Re-export for convenience
export type { OptionTrade, SimConfig, OptionSimAnalytics, SignalPresetKey };

// ── DTE Profile ─────────────────────────────────────────

export type DTEProfile = 'swing' | 'short';

/** Profile-specific parameter bounds for TPE optimization */
export interface ProfileBounds {
  creditDTERange: [number, number];
  creditSpreadWidth: [number, number];     // [min, max]
  creditShortDelta: [number, number];
  creditProfitTarget: [number, number];
  creditTimeStopDTE: [number, number];
  monitoringIntervalDays: [number, number];
}

export const PROFILE_BOUNDS: Record<DTEProfile, ProfileBounds> = {
  swing: {
    creditDTERange: [45, 65],
    creditSpreadWidth: [5, 25],
    creditShortDelta: [0.15, 0.40],
    creditProfitTarget: [0.20, 0.40],
    creditTimeStopDTE: [3, 14],
    monitoringIntervalDays: [1, 3],
  },
  short: {
    creditDTERange: [7, 21],
    creditSpreadWidth: [1, 10],
    creditShortDelta: [0.25, 0.50],
    creditProfitTarget: [0.30, 0.70],
    creditTimeStopDTE: [1, 3],
    monitoringIntervalDays: [1, 1],
  },
};

// ── TPE Optimizer Types ─────────────────────────────────

export interface TPEConfig {
  /** Random samples before modeling (default 30) */
  nStartup: number;
  /** Total evaluations including startup (default 500) */
  nTotal: number;
  /** Top fraction considered "good" (default 0.25) */
  gamma: number;
  /** Candidates sampled per iteration (default 24) */
  nCandidates: number;
  /** Random seed for reproducibility */
  seed: number;
}

export const DEFAULT_TPE_CONFIG: TPEConfig = {
  nStartup: 30,
  nTotal: 500,
  gamma: 0.25,
  nCandidates: 24,
  seed: 42,
};

export interface GridConfig {
  /** Explicit parameter arrays for factorial sweep */
  creditShortDelta?: number[];
  creditSpreadWidth?: number[];
  creditProfitTarget?: number[];
  creditStopLossMultiple?: number[];
  creditTimeStopDTE?: number[];
  creditDeltaStop?: number[];
  minIVRank?: number[];
  vrpFilter?: number[];
  contangoFilter?: number[];
  slopeFilter?: number[];
  maxIVSkew?: number[];
  maxPerTicker?: number[];
  maxPositions?: number[];
  signalWeightPreset?: SignalPresetKey[];
  useSmvVol?: boolean[];
  dirConfTier?: DirConfTier[];
}

/** A single continuous parameter spec for TPE */
export interface ContinuousParam {
  name: string;
  low: number;
  high: number;
  log?: boolean;  // sample in log space
}

/** A single integer parameter spec for TPE */
export interface IntegerParam {
  name: string;
  low: number;
  high: number;
}

/** A single categorical parameter spec for TPE */
export interface CategoricalParam {
  name: string;
  choices: (string | boolean)[];
}

export interface ParameterSpace {
  continuous: ContinuousParam[];
  integer: IntegerParam[];
  categorical: CategoricalParam[];
}

/** A single TPE trial */
export interface TPETrial {
  trialId: number;
  params: Record<string, number | string | boolean>;
  objective: number;  // composite score (higher = better)
}

export interface TPEResult {
  bestTrial: TPETrial;
  allTrials: TPETrial[];
  bestParams: Record<string, number | string | boolean>;
  bestObjective: number;
  elapsedMs: number;
}

// ── Statistical Validation Types ────────────────────────

export interface DSRResult {
  /** Observed annualized Sharpe ratio */
  observedSR: number;
  /** Expected max SR from random trials */
  expectedMaxSR: number;
  /** Deflated Sharpe Ratio (probability SR is real) */
  dsr: number;
  /** Number of independent trials */
  nTrials: number;
  /** Skewness of returns */
  skewness: number;
  /** Kurtosis of returns */
  kurtosis: number;
}

export interface PBOResult {
  /** Probability of Backtest Overfitting (0-1, lower = better) */
  pbo: number;
  /** Logit PBO: log(pbo/(1-pbo)) — more sensitive near extremes */
  logitPBO: number;
  /** Spearman rank correlation IS vs OOS */
  rankCorrelation: number;
  /** Number of CSCV combinations tested */
  nCombinations: number;
}

export interface BootstrapCI {
  ci5: number;
  ci50: number;
  ci95: number;
}

export interface BootstrapResult {
  sharpe: BootstrapCI;
  maxDD: BootstrapCI;
  totalReturn: BootstrapCI;
  winRate: BootstrapCI;
  nResamples: number;
  blockSize: number;
}

export interface PermutationTestResult {
  observedValue: number;
  pValue: number;
  /** Summary statistics of the null distribution */
  nullMean: number;
  nullStd: number;
}

export interface BHCorrectedResult {
  configId: string;
  rawPValue: number;
  adjustedPValue: number;
  significant: boolean;
}

export interface ParameterStability {
  paramName: string;
  values: number[];       // value per window
  mean: number;
  stdDev: number;
  cv: number;             // coefficient of variation
  isStable: boolean;      // cv < 0.30
}

export interface StatsResult {
  dsr: DSRResult;
  pbo: PBOResult;
  bootstrap: BootstrapResult;
  permutationPValue: number;
  permutation: PermutationTestResult;
  bhCorrected: BHCorrectedResult[];
  paramStability: ParameterStability[];
}

// ── Regime Analysis Types ───────────────────────────────

export type VIXRegime = 'low' | 'mid' | 'high';

export interface RegimeClassification {
  date: string;
  vixClose: number;
  regime: VIXRegime;
}

export interface PerRegimeMetrics {
  regime: VIXRegime;
  tradeCount: number;
  sharpe: number;
  winRate: number;
  avgPnl: number;
  maxDD: number;
  avgHoldDays: number;
  totalPnl: number;
}

// ── Multi-Objective Ranking Types ───────────────────────

export interface CompositeWeights {
  sharpe: number;      // default 0.35
  maxDD: number;       // default 0.25
  wfe: number;         // default 0.15
  stability: number;   // default 0.15
  dsr: number;         // default 0.10
}

export const DEFAULT_COMPOSITE_WEIGHTS: CompositeWeights = {
  sharpe: 0.35,
  maxDD: 0.25,
  wfe: 0.15,
  stability: 0.15,
  dsr: 0.10,
};

export interface RankedConfig {
  configId: string;
  params: Record<string, number | string | boolean>;
  compositeScore: number;
  sharpe: number;
  maxDD: number;
  wfe: number;
  stability: number;
  dsr: number;
  winRate: number;
  totalPnl: number;
  tradeCount: number;
  isParetoOptimal: boolean;
}

// ── WFA v2 Window & Result Types ────────────────────────

export interface WFAv2Window {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  bestConfig: SimConfig;
  bestTrainSharpe: number;
  trainTradeCount: number;
  oosTrades: OptionTrade[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTradeCount: number;
}

export interface HoldoutResult {
  trades: OptionTrade[];
  sharpe: number;
  winRate: number;
  maxDD: number;
  totalPnl: number;
  tradeCount: number;
  /** holdout Sharpe / OOS Sharpe — flag if < 0.50 */
  degradation: number;
}

export interface WFAv2Result {
  // Layer 2: OOS walk-forward
  oos: {
    windows: WFAv2Window[];
    allTrades: OptionTrade[];
    sharpe: number;
    winRate: number;
    maxDD: number;
    totalPnl: number;
    wfEfficiency: number;
    equityCurve: { date: string; equity: number }[];
    metricBasis?: 'daily_portfolio' | 'trade_hold_legacy';
  };

  // Layer 3: Holdout validation
  holdout: HoldoutResult;

  // Statistical validation
  stats: StatsResult;

  // Regime analysis
  regimes: PerRegimeMetrics[];

  // Best config
  bestConfig: SimConfig;
  ranking: RankedConfig[];
  paretoFrontier: RankedConfig[];

  // Profile
  dteProfile: DTEProfile;

  // Metadata
  totalEvaluations: number;
  elapsedMs: number;
}

// ── Main WFA v2 Config ──────────────────────────────────

export interface WFAv2Config {
  // Window structure
  trainWindowDays: number;     // 504 (2yr)
  forwardStepDays: number;     // 126 (6mo)
  purgeGapDays: number;        // 65
  mode: WalkForwardMode;

  // Date range
  startDate: string;
  endDate: string;
  holdoutDays: number;         // 126 (last 6mo reserved)

  // Tickers
  tickers: string[];

  // Portfolio
  startingCapital: number;     // 100_000

  // Optimization
  optimizerMode: 'tpe' | 'grid';
  tpeConfig: TPEConfig;
  gridConfig?: GridConfig;

  // Strategy profile
  dteProfile: DTEProfile | 'both';

  // Statistical validation
  bootstrapResamples: number;  // 10_000
  cscvBlocks: number;          // 16
  maxCscvCombinations: number; // 5000

  // Workers
  maxWorkers: number;          // 13 (15 - 2)
}

export const DEFAULT_WFA_V2_CONFIG: WFAv2Config = {
  trainWindowDays: 504,
  forwardStepDays: 126,
  purgeGapDays: 65,
  mode: 'rolling',
  startDate: '2018-01-01',
  endDate: '2026-02-28',
  holdoutDays: 126,
  tickers: [
    'SPY', 'QQQ', 'GOOGL', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
    'AAPL', 'NVDA', 'AMD', 'COST', 'AMZN', 'AVGO',
  ],
  startingCapital: 100_000,
  optimizerMode: 'tpe',
  tpeConfig: DEFAULT_TPE_CONFIG,
  dteProfile: 'swing',
  bootstrapResamples: 10_000,
  cscvBlocks: 16,
  maxCscvCombinations: 5000,
  maxWorkers: 13,
};

// ── Worker Message Types ────────────────────────────────

export interface WorkerEvalTask {
  type: 'evaluate';
  trialId: number;
  windowIndex: number;
  config: SimConfig;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  signals: EntrySignal[];
  allTradingDates: string[];
  endDate: string;  // for position carry
}

export interface WorkerEvalResult {
  type: 'result';
  trialId: number;
  windowIndex: number;
  trainSharpe: number;
  trainTradeCount: number;
  oosTrades: OptionTrade[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
}

export interface WorkerInitTask {
  type: 'init';
  dbPath: string;
}

export interface WorkerInitResult {
  type: 'ready';
}

export type WorkerMessage = WorkerEvalTask | WorkerInitTask;
export type WorkerResponse = WorkerEvalResult | WorkerInitResult;

// ── ORATS Cores Cache Types ─────────────────────────────

export interface ORATSCoresRow {
  ticker: string;
  trade_date: string;
  iv30: number;
  rv30: number;
  iv60: number;
  slope: number;
  deriv: number;
  smv_vol: number;
  or_fcst_20d: number;
  fcst_r2: number;
  contango: number;   // precomputed: IV60/IV30 - 1
  vrp: number;        // precomputed: IV30² - RV30²
}

// ── Extended EntrySignal (v2) ───────────────────────────

/** Additional fields enriched from ORATS cores for v2 filtering */
export interface V2SignalEnrichment {
  vrp?: number;          // IV²-RV² variance risk premium
  contango?: number;     // IV60/IV30 - 1
  slope?: number;        // ORATS skew slope
  smvVol?: number;       // smoothed vol
}

/** Extended SimConfig fields for v2 filters */
export interface V2SimConfigExtension {
  vrpFilter?: number;       // min VRP to enter (0 = disabled)
  contangoFilter?: number;  // min contango to enter (0 = disabled)
  slopeFilter?: number;     // min slope to enter (0 = disabled)
  useSmvVol?: boolean;      // use smvVol for pricing instead of midIv
}
