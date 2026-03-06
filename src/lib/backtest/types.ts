/**
 * Signal Quality Backtester — Type Definitions
 *
 * Stock-price-only backtesting with ATR-based TP/SL and optional theta decay penalty.
 * No options data needed — validates signal quality before committing to options trades.
 */

import type { TechScoreOptions } from '../tech-analysis';

// ── Config ──────────────────────────────────────────────

export type Timeframe = '1D';

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
  // Options-aware
  thetaDecayRate: number;         // Decay rate for time penalty (default 0.03)
  // Look-forward windows for MFE/MAE
  mfeWindows: number[];           // [3, 5, 7, 10, 14, 21, 30]
  // Indicator tuning
  indicatorOptions: TechScoreOptions;
}

export const DEFAULT_CONFIG: BacktestConfig = {
  ticker: 'SPY',
  startDate: '2024-01-01',
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
  timeStopBars: 21,
  thetaDecayRate: 0.03,
  mfeWindows: [3, 5, 7, 10, 14, 21, 30],
  indicatorOptions: {},
};

// ── Candle (matches polygon-client.js output) ───────────

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
}

// ── Trade ───────────────────────────────────────────────

export type EntryQuality = 'OPTIMAL' | 'ACCEPTABLE' | 'MARGINAL' | 'CHASING';
export type ExitType = 'TP' | 'SL' | 'TIME_STOP';
export type Tier = 'S' | 'A' | 'B';

export interface BacktestTrade {
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
}

// ── Monte Carlo ─────────────────────────────────────────

export interface MonteCarloResult {
  iterations: number;
  sharpe: { p5: number; p50: number; p95: number };
  maxDrawdown: { p5: number; p50: number; p95: number };
  finalReturn: { p5: number; p50: number; p95: number };
  isSignificant: boolean;       // true if p5 Sharpe > 0
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
  /** Use GA ('ga') or grid sweep ('sweep') for IS optimization */
  optimizer: 'ga' | 'sweep';
  /** GA settings (when optimizer='ga') */
  populationSize?: number;
  generations?: number;
  /** Sweep ranges (when optimizer='sweep') */
  sweepRanges?: Omit<SweepConfig, 'ticker' | 'startDate' | 'endDate' | 'timeframe'>;
  /** Whether to jointly optimize trade + indicator params (GA only) */
  jointOptimize?: boolean;
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

/** Indicator parameter set for sweep — each field is an array of values to try */
export interface IndicatorSweepParams {
  w_mb?: number[];          // e.g. [25, 30, 35]
  w_bxs?: number[];         // e.g. [20, 25, 30]
  w_bxl?: number[];         // e.g. [15, 20, 25]
  w_ema?: number[];         // e.g. [10, 15, 20]
  w_mom?: number[];         // e.g. [5, 10, 15]
  sc_mb_len?: number[];     // e.g. [60, 80, 100, 120]
  sc_osc_len?: number[];    // e.g. [5, 7, 10]
  sc_bx_s1?: number[];      // e.g. [3, 5, 8]
  sc_bx_s2?: number[];      // e.g. [15, 20, 25]
  sc_bx_l1?: number[];      // e.g. [15, 20, 25]
  sc_bx_l2?: number[];      // e.g. [10, 15, 20]
}

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
  // Indicator param sweep (optional — if omitted, uses defaults)
  indicatorSweep?: IndicatorSweepParams;
}

/** Optimize mode: GA-based indicator param optimization with fixed TP/SL */
export interface OptimizeConfig {
  ticker: string;
  /** Multi-ticker optimization: when provided, overrides `ticker` and evaluates across all */
  tickers?: string[];
  startDate: string;
  endDate: string;
  // Fixed trade params (not swept — ignored when jointOptimize=true)
  tpAtr: number;
  slAtr: number;
  minScore: number;
  minConfidence: number;
  thetaDecayRate: number;
  // GA settings (optional — sensible defaults)
  populationSize?: number;   // default 40
  generations?: number;      // default 30
  /** When true, GA also evolves tpAtr, slAtr, minScore, thetaDecayRate */
  jointOptimize?: boolean;
}

export interface OptimizeResult {
  results: BacktestResult[];
  rankedBySharpe: BacktestResult[];
  rankedByWinRate: BacktestResult[];
  bestOverall: BacktestResult | null;
  totalCombos: number;
  elapsedMs: number;
  generationHistory: { gen: number; bestFitness: number; avgFitness: number }[];
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
