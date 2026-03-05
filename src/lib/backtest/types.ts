/**
 * Signal Quality Backtester — Type Definitions
 *
 * Stock-price-only backtesting with ATR-based TP/SL and optional theta decay penalty.
 * No options data needed — validates signal quality before committing to options trades.
 */

// ── Config ──────────────────────────────────────────────

export interface BacktestConfig {
  ticker: string;
  startDate: string;              // YYYY-MM-DD
  endDate: string;                // YYYY-MM-DD
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
}

export const DEFAULT_CONFIG: BacktestConfig = {
  ticker: 'SPY',
  startDate: '2024-01-01',
  endDate: '2026-03-05',
  minScore: 70,
  minConfidence: 2,
  allowedSetups: ['All'],
  directionFilter: 'ALL',
  cooldownBars: 21,
  tpAtr: 2.5,
  slAtr: 1.5,
  useEntryQualityAdjust: true,
  timeStopBars: 21,
  thetaDecayRate: 0.03,
  mfeWindows: [3, 5, 7, 10, 14, 21, 30],
};

// ── Candle (matches polygon-client.js output) ───────────

export interface BacktestCandle {
  date: string;       // YYYY-MM-DD
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
  tpAtrRange: number[];
  slAtrRange: number[];
  minScoreRange: number[];
  minConfidenceRange: number[];
  setupGroups: string[][];
  thetaDecayRange: number[];
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
