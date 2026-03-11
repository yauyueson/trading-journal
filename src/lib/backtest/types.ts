/**
 * Signal Quality Backtester — Type Definitions
 *
 * ATR-based TP/SL backtesting with optional BSM synthetic options repricing.
 * Phase 1: constant-IV BSM repricing converts stock returns to option returns.
 */

import type { TechScoreOptions } from '../tech-analysis';

// ── Config ──────────────────────────────────────────────

export type Timeframe = '1D';

/** Quality gates — fixed thresholds, NOT optimizable */
export interface QualityGates {
  minADX: number;           // Hard gate: skip signal if ADX < this (default 15)
  minRVOL: number;          // Hard gate: skip signal if RVOL < this (default 0.5)
  useCoherence: boolean;    // Score multiplier: 3/3→1.10x, 2/3→1.00x, 1/3→0.85x, 0/3→0.70x
  useSqueeze: boolean;      // Score multiplier: squeeze active → 1.05x
}

export const DEFAULT_QUALITY_GATES: QualityGates = {
  minADX: 15,
  minRVOL: 0.5,
  useCoherence: true,
  useSqueeze: true,
};

// ── Options Pricing Config (BSM Repricing) ───────────────

export type IVSource = 'hv20' | 'hv30' | 'fixed' | 'orats';

export type SpreadType = 'single' | 'vertical';

export interface OptionsPricingConfig {
  enabled: boolean;
  entryDTE: number;           // DTE at entry (default 30)
  riskFreeRate: number;       // decimal (0.04 = 4%)
  ivSource: IVSource;         // 'hv20' | 'hv30' | 'fixed' | 'orats'
  fixedIV?: number;           // decimal, used when ivSource='fixed' (e.g. 0.25)
  // Phase 2: IV dynamics (O-U mean reversion)
  ivDynamics?: IVDynamicsConfig;
  // Premium-based TP/SL (default when options pricing enabled)
  premiumTP?: number;           // TP at X% premium gain (default 0.50 = 50%)
  premiumSL?: number;           // SL at X% premium loss (default 0.50 = 50%)
  // Phase 3: Spread pricing
  spreadType?: SpreadType;    // default 'single'
  spreadWidthMode?: 'atr' | 'fixed';  // default 'fixed'
  spreadWidthATR?: number;    // vertical spread width as ATR multiple (default 1.0)
  spreadWidthFixed?: number;  // vertical spread width in dollars (default 1)
}

export const DEFAULT_OPTIONS_PRICING: OptionsPricingConfig = {
  enabled: true,
  entryDTE: 30,
  riskFreeRate: 0.04,
  ivSource: 'orats',
};

// ── Slippage Model ───────────────────────────────────────

/** Adverse-fill slippage applied at entry/exit (NOT optimizable) */
export interface SlippageConfig {
  enabled: boolean;
  entryBps: number;          // basis points applied adversely at entry (default 5)
  exitBps: number;           // basis points applied adversely at exit (default 5)
}

export const DEFAULT_SLIPPAGE: SlippageConfig = {
  enabled: false,
  entryBps: 5,
  exitBps: 5,
};

// ── IV Dynamics (O-U Mean Reversion) ─────────────────────

/** Ornstein-Uhlenbeck IV evolution for BSM repricing (Phase 2) */
export interface IVDynamicsConfig {
  enabled: boolean;
  /** Mean reversion speed (annualized). kappa=4.0 ≈ 0.016/day */
  kappa: number;
  /** Use HV60 as long-run mean theta. If false, uses entry IV. */
  useHV60ForTheta: boolean;
  /** Vol of vol (reserved for future stochastic mode). */
  sigmaVol: number;
  /** Stochastic mode: add noise term. Default false (deterministic O-U). */
  stochastic: boolean;
}

export const DEFAULT_IV_DYNAMICS: IVDynamicsConfig = {
  enabled: true,
  kappa: 4.0,
  useHV60ForTheta: true,
  sigmaVol: 0.6,
  stochastic: false,
};

// ── Regime-Adaptive Quality Gates ────────────────────────

/** Regime-conditional quality gate overrides (NOT optimizable) */
export interface RegimeGateConfig {
  enabled: boolean;
  // Trending regime (ADX > 25)
  trendingADX: number;      // min ADX when trending (default 20, stricter)
  trendingRVOL: number;     // min RVOL when trending (default 0.3, relaxed)
  trendingCoherence: [number, number, number, number]; // [3/3, 2/3, 1/3, 0/3]
  // Ranging regime (ADX < 20)
  rangingADX: number;       // min ADX when ranging (default 10, relaxed)
  rangingRVOL: number;      // min RVOL when ranging (default 0.8, stricter)
  rangingCoherence: [number, number, number, number];
}

export const DEFAULT_REGIME_GATES: RegimeGateConfig = {
  enabled: false,
  trendingADX: 20,
  trendingRVOL: 0.3,
  trendingCoherence: [1.15, 1.00, 0.85, 0.60],
  rangingADX: 10,
  rangingRVOL: 0.8,
  rangingCoherence: [1.05, 1.00, 0.85, 0.80],
};

export interface BacktestConfig {
  ticker: string;
  startDate: string;              // YYYY-MM-DD
  endDate: string;                // YYYY-MM-DD
  timeframe: Timeframe;           // '1D' = daily
  // Signal filters
  minScore: number;               // Min tech score to trigger (default 70)
  minConfidence: number;          // Min setup confidence 0-3 (default 2)
  allowedSetups: string[];        // ['All'] or specific setup names
  directionFilter: 'ALL' | 'CALL' | 'PUT';
  // Entry
  cooldownBars: number;           // Min bars between entries (default 21)
  // TP/SL (ATR multiples)
  tpAtr: number;                  // TP = entry ± tpAtr × ATR (default 2.5)
  slAtr: number;                  // SL = entry ∓ slAtr × ATR (default 1.5)
  useEntryQualityAdjust: boolean; // Adjust TP/SL by entry quality (default true)
  timeStopBars: number;           // Force close after N bars (default 21)
  // Score-based stop loss: exit if composite score drops below this (0 = disabled)
  scoreStopThreshold: number;     // default 55; 0 to disable
  // Options-aware
  thetaDecayRate: number;         // Decay rate for time penalty (default 0.03)
  // Look-forward windows for MFE/MAE
  mfeWindows: number[];           // [3, 5, 7, 10, 14, 21, 30]
  // Indicator tuning
  indicatorOptions: TechScoreOptions;
  // V4 quality gates (fixed filters, not optimizable)
  qualityGates: QualityGates;
  // BSM synthetic options repricing (Phase 1)
  optionsPricing?: OptionsPricingConfig;
  // Adverse-fill slippage model
  slippage?: SlippageConfig;
  // Regime-adaptive quality gate overrides
  regimeGates?: RegimeGateConfig;
}

export const DEFAULT_CONFIG: BacktestConfig = {
  ticker: 'SPY',
  startDate: '2021-01-01',
  endDate: '2026-03-05',
  timeframe: '1D',
  minScore: 70,
  minConfidence: 0,
  allowedSetups: ['All'],
  directionFilter: 'ALL',
  cooldownBars: 3,
  tpAtr: 2.5,
  slAtr: 1.5,
  useEntryQualityAdjust: true,
  scoreStopThreshold: 55,
  timeStopBars: 21,
  thetaDecayRate: 0.03,
  mfeWindows: [3, 5, 7, 10, 14, 21, 30],
  indicatorOptions: {},
  qualityGates: DEFAULT_QUALITY_GATES,
};

// ── Candle (matches tiingo-client.js output) ─────────────

export interface BacktestCandle {
  date: string;       // YYYY-MM-DD (or YYYY-MM-DDTHH:mm for 4H)
  timestamp: number;  // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Pre-computed Signal ─────────────────────────────────

export interface PrecomputedSignal {
  barIndex: number;
  date: string;
  score: number;
  type: 'CALL' | 'PUT' | 'NEUTRAL';
  setup: string;
  confidence: number;
  d8: number;         // EMA-8 distance % (for entry quality)
  atr: number;        // ATR(14) at this bar
  close: number;
  // V4-specific (optional, populated in 4H mode)
  entryContext?: EntryQuality;
  dynamicTP?: number;   // V4's dynamic TP ATR mult
  dynamicSL?: number;   // V4's dynamic SL ATR mult
  // V4 quality gate data (populated in daily mode)
  adx?: number;
  rvol?: number;
  isSqueeze?: boolean;
  coherence?: number;   // 0-3 count of MB/BXS/BXL directional agreement
  // BSM repricing: rolling HV at signal bar (annualized decimal)
  ivEstimate?: number;    // HV20
  ivEstimate30?: number;  // HV30
  ivEstimate60?: number;  // HV60 (for O-U theta estimation)
  // ORATS real IV at signal bar (annualized decimal)
  oratsIV30?: number;     // Real ORATS IV30
  oratsIV60?: number;     // Real ORATS IV60
  // Regime at signal bar
  regime?: 'trending' | 'ranging' | 'neutral';
  // Sub-scores for GA correlation penalty
  subScores?: { sc_mb: number; sc_bxs: number; sc_bxl: number; sc_ema: number; sc_mom: number };
}

// ── Trade ───────────────────────────────────────────────

export type EntryQuality = 'OPTIMAL' | 'ACCEPTABLE' | 'MARGINAL' | 'CHASING';
export type ExitType = 'TP' | 'SL' | 'TIME_STOP' | 'SCORE_STOP';
export type Tier = 'S' | 'A' | 'B';

export interface BacktestTrade {
  ticker?: string;              // Set in multi-ticker optimize
  entryDate: string;
  entryPrice: number;           // Next bar's OPEN
  entryBar: number;
  direction: 'CALL' | 'PUT';
  setup: string;
  score: number;
  confidence: number;
  tier: Tier;                   // S(90+), A(80-89), B(70-79)
  entryQuality: EntryQuality;
  atrAtEntry: number;
  tpPrice: number;
  slPrice: number;
  // Exit
  exitDate: string;
  exitPrice: number;
  exitType: ExitType;
  holdDays: number;
  rawReturn: number;            // Stock price return %
  thetaAdjReturn: number;       // rawReturn × e^(-decayRate × holdDays)
  // MFE/MAE per window
  mfe: Record<number, number>;  // { 5: 0.032, 10: 0.045, ... }
  mae: Record<number, number>;  // { 5: -0.012, 10: -0.018, ... }
  // BSM synthetic option return (populated when optionsPricing enabled)
  optionReturn?: number;         // (V_exit - V_entry) / V_entry
  optionPriceEntry?: number;     // BSM price at entry
  optionPriceExit?: number;      // BSM price at exit
  strikeUsed?: number;           // K used for BSM
  ivAtEntry?: number;            // sigma used (annualized decimal)
  ivAtExit?: number;             // sigma at exit (may differ with O-U dynamics)
  entryDelta?: number;           // BSM delta at entry
  exitDelta?: number;            // BSM delta at exit
  // Vertical spread fields
  shortStrikeUsed?: number;
  shortOptionPriceEntry?: number;
  shortOptionPriceExit?: number;
  spreadWidth?: number;          // distance between strikes
  maxSpreadLoss?: number;        // defined-risk cap
  // Sub-scores for correlation analysis
  subScores?: { sc_mb: number; sc_bxs: number; sc_bxl: number; sc_ema: number; sc_mom: number };
}

// ── Analytics ───────────────────────────────────────────

export interface DirectionStats {
  count: number;
  winRate: number;
  avgReturn: number;
  avgReturnTheta: number;
}

export interface TierStats {
  count: number;
  winRate: number;
  avgReturn: number;
  avgReturnTheta: number;
  avgHoldDays: number;
}

export interface SetupStats {
  count: number;
  winRate: number;
  avgReturn: number;
  avgReturnTheta: number;
  avgHoldDays: number;
  tpHits: number;
  slHits: number;
  timeStops: number;
}

export interface BacktestAnalytics {
  totalSignals: number;
  totalTrades: number;
  winRate: number;              // % (raw return > 0)
  winRateTheta: number;         // % (theta-adjusted > 0)
  avgReturn: number;
  avgReturnTheta: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  avgHoldDays: number;
  // TP/SL breakdown
  tpHits: number;
  slHits: number;
  timeStops: number;
  scoreStops: number;
  // By direction
  callStats: DirectionStats;
  putStats: DirectionStats;
  // By tier
  tierS: TierStats;
  tierA: TierStats;
  tierB: TierStats;
  // By setup
  bySetup: Record<string, SetupStats>;
  // MFE/MAE averages per window
  avgMfe: Record<number, number>;
  avgMae: Record<number, number>;
  // Equity curve
  equityCurve: { date: string; cumReturn: number }[];
  sharpe: number;
  maxDrawdown: number;
  // Extended metrics
  sortino: number;              // Sharpe using downside deviation only
  calmar: number;               // Annualized return / max drawdown
  expectancy: number;           // avgWin×WR + avgLoss×LR (per trade expected %)
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  // Quality gate stats
  gateStats?: GateStats;
  // BSM option return analytics (primary when optionsPricing enabled)
  optionMode?: boolean;
  optionAvgReturn?: number;
  optionWinRate?: number;
  optionSharpe?: number;
  optionSortino?: number;
  optionProfitFactor?: number;
  optionExpectancy?: number;
  optionMaxDrawdown?: number;
  optionEquityCurve?: { date: string; cumReturn: number }[];
  // Stock return reference stats (secondary when optionMode=true)
  stockWinRate?: number;
  stockAvgReturn?: number;
  stockSharpe?: number;
  stockSortino?: number;
  stockProfitFactor?: number;
  // GA correlation penalty: avg pairwise |corr| of sub-scores
  avgSubScoreCorrelation?: number;
  // Monte Carlo permutation test
  monteCarlo?: MonteCarloResult;
}

export interface GateStats {
  adxFiltered: number;
  rvolFiltered: number;
  coherenceAdjusted: number;
  squeezeAdjusted: number;
}

// ── Monte Carlo ─────────────────────────────────────────

export interface MonteCarloResult {
  iterations: number;
  sharpe: { p5: number; p50: number; p95: number };
  maxDrawdown: { p5: number; p50: number; p95: number };
  finalReturn: { p5: number; p50: number; p95: number };
  isSignificant: boolean;       // true if p5 Sharpe > 0
  /** Block bootstrap (preserves time-series autocorrelation) */
  blockBootstrap?: {
    blockSize: number;
    sharpe: { p5: number; p50: number; p95: number };
    maxDrawdown: { p5: number; p50: number; p95: number };
    finalReturn: { p5: number; p50: number; p95: number };
    isSignificant: boolean;
  };
}

// ── Walk-Forward ────────────────────────────────────────

export type WalkForwardMode = 'rolling' | 'anchored';

export interface WalkForwardConfig {
  ticker: string;
  startDate: string;
  endDate: string;
  timeframe: Timeframe;
  /** In-sample window size in trading days */
  isWindowDays: number;         // default 252 (1 year)
  /** Out-of-sample window size in trading days */
  oosWindowDays: number;        // default 63 (1 quarter)
  /** 'rolling' = fixed IS window, 'anchored' = expanding IS from start */
  mode: WalkForwardMode;        // default 'anchored'
  /** Gap between IS end and OOS start to prevent look-ahead leakage.
   *  For options: must be >= max DTE (default 65). For stocks: 5 is sufficient. */
  purgeGapDays?: number;
  /** Use GA ('ga') or grid sweep ('sweep') for IS optimization */
  optimizer: 'ga' | 'sweep';
  /** GA settings (when optimizer='ga') */
  populationSize?: number;
  generations?: number;
  /** Sweep ranges (when optimizer='sweep') */
  sweepRanges?: Omit<SweepConfig, 'ticker' | 'startDate' | 'endDate' | 'timeframe'>;
}

export interface WalkForwardWindow {
  windowIndex: number;
  isStart: string;              // IS period start date
  isEnd: string;                // IS period end date
  oosStart: string;             // OOS period start date
  oosEnd: string;               // OOS period end date
  isBestConfig: BacktestConfig; // Best config found on IS data
  isBestFitness: number;
  oosResult: BacktestResult;    // Performance on OOS data
}

export interface WalkForwardResult {
  config: WalkForwardConfig;
  windows: WalkForwardWindow[];
  /** Aggregated OOS-only analytics (the real measure) */
  oosAnalytics: BacktestAnalytics;
  /** All OOS trades concatenated */
  oosTrades: BacktestTrade[];
  /** Walk-forward efficiency: OOS performance / IS performance */
  wfEfficiency: number;
  /** Monte Carlo on OOS trades */
  monteCarlo?: MonteCarloResult;
  totalEvals: number;
  elapsedMs: number;
}

// ── Results ─────────────────────────────────────────────

export interface BacktestResult {
  config: BacktestConfig;
  trades: BacktestTrade[];
  analytics: BacktestAnalytics;
}

// ── Sweep ───────────────────────────────────────────────

export interface SweepConfig {
  ticker: string;
  startDate: string;
  endDate: string;
  timeframe: Timeframe;
  tpAtrRange: number[];
  slAtrRange: number[];
  minScoreRange: number[];
  minConfidenceRange: number[];
  setupGroups: string[][];
  thetaDecayRange: number[];
  optionsPricing?: OptionsPricingConfig;
  slippage?: SlippageConfig;
  regimeGates?: RegimeGateConfig;
}

/** Optimize mode: GA-based indicator weight optimization with fixed TP/SL */
export interface OptimizeConfig {
  ticker: string;
  startDate: string;
  endDate: string;
  // Fixed trade params (not swept)
  tpAtr: number;
  slAtr: number;
  minScore: number;
  minConfidence: number;
  thetaDecayRate: number;
  scoreStopThreshold?: number;  // default 55; 0 to disable
  // GA settings (optional — sensible defaults)
  populationSize?: number;   // default 30
  generations?: number;      // default 20
  // Multi-ticker: if provided, GA averages fitness across all tickers (anti-overfitting)
  tickers?: string[];
  // Which parameter groups the GA optimizes (default: weights only)
  optimizeParams?: OptimizeParams;
  optionsPricing?: OptionsPricingConfig;
  slippage?: SlippageConfig;
  regimeGates?: RegimeGateConfig;
}

/** Toggle which parameter groups are included in GA optimization */
export interface OptimizeParams {
  weights: boolean;    // w_mb, w_bxs, w_bxl, w_ema, w_mom (5 genes, 4 free)
  periods: boolean;    // sc_mb_len, sc_osc_len, sc_bx_s1, sc_bx_s2, sc_bx_l1, sc_bx_l2 (6 genes)
  tpSl: boolean;       // tpAtr, slAtr (2 genes)
  minScore: boolean;   // minScore (1 gene)
  decay: boolean;      // thetaDecayRate (1 gene)
}

export const DEFAULT_OPTIMIZE_PARAMS: OptimizeParams = {
  weights: true,
  periods: false,
  tpSl: false,
  minScore: false,
  decay: false,
};

export interface OptimizeResult {
  results: BacktestResult[];
  rankedBySharpe: BacktestResult[];
  rankedByWinRate: BacktestResult[];
  bestOverall: BacktestResult | null;
  totalCombos: number;
  elapsedMs: number;
  generationHistory?: { gen: number; bestFitness: number; avgFitness: number }[];
}

export interface SweepResult {
  results: BacktestResult[];
  rankedBySharpe: BacktestResult[];
  rankedByWinRate: BacktestResult[];
  rankedByProfitFactor: BacktestResult[];
  bestOverall: BacktestResult | null;
  totalCombos: number;
  elapsedMs: number;
}
