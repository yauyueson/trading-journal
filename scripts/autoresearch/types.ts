/**
 * Autoresearch Harness — Shared Types
 *
 * Defines the contract between strategy.ts (agent-editable) and runner.ts (infrastructure).
 * The agent modifies strategy.ts freely; these types define the stable interface.
 */

import type { BacktestCandle } from '../../src/lib/backtest/types';
import type { ChainRow, StrikeMatch, SpreadMatch } from '../../src/lib/backtest/chain-cache';
import type { EntrySignal, SimConfig, OptionTrade } from '../../src/lib/backtest/option-sim';

// Re-export for convenience in strategy.ts
export type { BacktestCandle, ChainRow, StrikeMatch, SpreadMatch, EntrySignal, SimConfig, OptionTrade };

// ── TickerDataBundle ────────────────────────────────────

export interface RegimeData {
  vrp?: number;
  contango?: number;
  vrpPct?: number;
  contangoPct?: number;
  slope?: number;
}

/**
 * Pre-loaded data for one ticker, passed to strategy.generateSignals().
 * Contains candles, technical indicators, and regime data.
 * The agent uses this to implement any entry logic without I/O.
 */
export interface TickerDataBundle {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
  emas: Map<number, number[]>;   // period (8,13,21,34,55) → full EMA series
  regimeByDate: Map<string, RegimeData>;
}

// ── ChainLookup ─────────────────────────────────────────

/**
 * Chain-cache accessor interface for custom evaluators.
 * Provides O(1) lookups into the 44M-contract SQLite cache
 * without requiring the strategy to import chain-cache directly.
 */
export interface ChainLookup {
  getCachedChain: (ticker: string, date: string) => ChainRow[];
  getCachedChainFiltered: (ticker: string, date: string, deltaRange?: [number, number], dteRange?: [number, number]) => ChainRow[];
  findStrikeByDelta: (chain: ChainRow[], targetDelta: number, type: 'Call' | 'Put', dteRange: [number, number], minVolume?: number) => StrikeMatch | null;
  findSpreadStrikes: (chain: ChainRow[], shortDelta: number, width: number, type: 'Call' | 'Put', dteRange: [number, number], minVolume?: number) => SpreadMatch | null;
  findContractDirect: (ticker: string, date: string, strike: number, expiry: string, type: 'Call' | 'Put') => StrikeMatch | null;
}

// ── StrategyDefinition ──────────────────────────────────

/**
 * The interface every strategy.ts must export.
 * The agent can freely modify everything inside the exported object,
 * but the shape must conform to this interface.
 */
export interface StrategyDefinition {
  /** Human-readable strategy name (shown in leaderboard) */
  name: string;

  /** Which tickers this strategy trades */
  tickers: string[];

  /**
   * Generate entry signals from pre-loaded ticker data.
   * Called once per ticker. The agent puts all custom entry logic here.
   * Return EntrySignal[] — can be any combination of CALL/PUT directions.
   */
  generateSignals(data: TickerDataBundle): EntrySignal[];

  /**
   * Build the SimConfig for evaluation.
   * Controls: mode, delta, DTE, width, TP/SL, trailing lock, etc.
   * Can return different configs per ticker/direction.
   */
  buildConfig(ticker: string, direction: 'CALL' | 'PUT'): SimConfig;

  /**
   * Optional: custom trade evaluator for novel structures.
   * If not provided, the worker uses standard simulators based on config.mode:
   *   CREDIT_SPREAD → simulateCreditSpread()
   *   LEAP → simulateLeap()
   *   etc.
   *
   * Implement this for strategies the standard engine doesn't support
   * (diagonals, PMCC, calendar spreads, etc.).
   *
   * MUST return OptionTrade with dailyMtM[] for portfolio metrics.
   * Return null to skip a signal.
   */
  customEvaluator?: (
    signal: EntrySignal,
    config: SimConfig,
    allTradingDates: string[],
    maxDate: string,
    chainLookup: ChainLookup,
  ) => OptionTrade | null;

  /** Portfolio constraints */
  portfolio: {
    maxPositions: number;
    maxPerTicker: number;
    startingCapital: number;
  };

  /** Walk-forward analysis parameters */
  wfa: {
    trainWindowDays: number;    // e.g. 252 (~1 year)
    forwardStepDays: number;    // e.g. 126 (~6 months)
    purgeGapDays: number;       // e.g. 10 (prevent look-ahead)
    mode: 'rolling' | 'anchored';
    holdoutCount?: number;      // default 2
  };
}

// ── RunResult ───────────────────────────────────────────

export interface RunResult {
  strategyName: string;
  timestamp: string;
  // Standalone metrics
  oosSharpe: number;
  oosMaxDD: number;
  oosWinRate: number;
  oosTrades: number;
  oosTotalPnl: number;
  // Combined with DTE5
  combinedSharpe: number;
  correlationWithDTE5: number;
  combinedMaxDD: number;
  // Holdout validation
  holdoutSharpe: number;
  holdoutTrades: number;
  // SPY Information Ratio — market-regime-neutral alpha check
  // IR = (strategy returns - SPY returns) mean / stdev × sqrt(252)
  // A strategy with IR > 0 beats SPY on risk-adjusted basis even in bad markets.
  // Complements raw Sharpe: holdout Sharpe might be low because the regime was
  // bad for everyone, but if IR is still positive the strategy is doing its job.
  oosSpyIR: number;
  oosSpyExcessReturn: number;      // annualized excess return over SPY in selection period
  holdoutSpyIR: number;
  holdoutSpyExcessReturn: number;  // annualized excess return over SPY in holdout period
  // WFA quality
  avgTrainSharpe: number;
  wfEfficiency: number;
  // Validity checks
  passesMinTrades: boolean;
  passesMaxDD: boolean;
  passesWFA: boolean;
  passesHoldout: boolean;             // holdout Sharpe >= 0 (absolute)
  passesHoldoutOrIR: boolean;         // holdout Sharpe >= 0 OR holdout SPY IR >= 0 (beat market)
  passesSanity: boolean;              // OOS Sharpe <= 3.0 (catches simulator bugs)
  isValid: boolean;
  // Overfitting diagnostics
  holdoutOOSRatio: number;           // holdoutSharpe / oosSharpe — closer to 1.0 = less overfit
  bootstrapSharpe95CI: [number, number];  // 95% CI on standalone OOS Sharpe
  bootstrapSignificant: boolean;     // is lower bound of CI > 0?
  attemptNumber: number;             // which attempt this is (for multiple testing awareness)
  deflatedSharpe: number;            // Sharpe adjusted for multiple testing (Bailey-López de Prado)
  // Diagnostics
  exitTypeBreakdown: Record<string, number>;
  signalsGenerated: number;         // total signals before WFA filtering
  signalsSkippedNoChain: number;    // signals skipped due to missing chain data (from worker)
  errorMessage?: string;
  elapsedMs: number;
}

// ── DTE5 Baseline ───────────────────────────────────────

export interface DTE5Baseline {
  dates: string[];
  dailyReturns: number[];
  equityCurve: { date: string; equity: number }[];
  oosSharpe: number;
}

// ── Worker Protocol ─────────────────────────────────────

export interface WorkerInitData {
  signals: EntrySignal[];
  allTradingDates: string[];
  executionConfig: {
    maxPositions: number;
    maxPerTicker: number;
    startingCapital: number;
  };
  startingCapital: number;
  /** If 'standard', worker uses built-in simulators. If 'custom', worker expects evaluator function in each work item. */
  evaluatorMode: 'standard' | 'custom';
}

export interface WindowDef {
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
}

export interface WorkItem {
  type: 'eval';
  id: number;
  simConfig: SimConfig;
  selectionWindows: WindowDef[];
  holdoutWindows: WindowDef[];
}

export interface WindowResult {
  windowIdx: number;
  trainSharpe: number;
  oosSharpe: number;
  oosWR: number;
  oosMaxDD: number;
  oosTradeCount: number;
}

export interface WorkResult {
  type: 'result';
  id: number;
  selectionResults: WindowResult[];
  allOOSTrades: OptionTrade[];
  holdoutTrades: OptionTrade[];
  error?: string;
}
