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
  /** Raw 20-day historical vol per candle index, aligned to candles[]. Optional. */
  hv20?: (number | null)[];
  dateToIdx: Map<string, number>;
  emas: Map<number, number[]>;   // period (8,13,21,34,55,200) → full EMA series
  regimeByDate: Map<string, RegimeData>;
}

// ── MarketContext ──────────────────────────────────────

/**
 * Market-level data passed to generateSignals() alongside per-ticker data.
 * Enables cross-asset regime gates (e.g., "don't enter when SPY < EMA200").
 */
export interface MarketContext {
  /** SPY daily closes indexed by date */
  spyByDate: Map<string, { close: number; ema200: number }>;
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
   * Optional: one-time precomputation hook invoked by the runner before
   * the per-ticker generateSignals loop. Receives the full tickerDataMap so
   * strategies can build cross-ticker derived data (e.g. breadth, relative-
   * vol percentile) without needing the serialized data-cache.json on disk.
   * Called exactly once per runner invocation.
   */
  prepare?(tickerDataMap: Map<string, TickerDataBundle>, market: MarketContext): void;

  /**
   * Generate entry signals from pre-loaded ticker data.
   * Called once per ticker. The agent puts all custom entry logic here.
   * Return EntrySignal[] — can be any combination of CALL/PUT directions.
   *
   * `market` provides SPY data for cross-asset regime gates
   * (e.g., skip entries when SPY < EMA200).
   */
  generateSignals(data: TickerDataBundle, market: MarketContext): EntrySignal[];

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

  /**
   * Optional: config variants for batch evaluation in a single run.
   * Each variant overrides specific SimConfig fields from buildConfig().
   *
   * The runner evaluates the base strategy as variant 1, THEN appends each
   * configVariant. Do NOT add an explicit empty-override entry for the
   * incumbent — the runner will detect the name collision and skip it with
   * a warning. If you need a sanity-anchor reproduction of the base, use
   * configVariants only for strict overrides.
   *
   * Use with `--screen` flag for fast triage before full evaluation.
   */
  configVariants?: ConfigVariant[];
}

// ── ConfigVariant ──────────────────────────────────────

export interface ConfigVariant {
  /** Human-readable variant name (shown in results table) */
  name: string;
  /** SimConfig field overrides — merged with base buildConfig() output */
  overrides: Partial<SimConfig>;
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
  holdoutTrades: number;             // legacy alias for newHoldoutTrades
  newHoldoutTrades?: number;         // trades entered during the holdout window
  carriedHoldoutTrades?: number;     // selection-entered trades with in-holdout dailyMtM
  passesHoldoutNewEntries?: boolean; // newHoldoutTrades >= MIN_NEW_HOLDOUT_TRADES (catches carry-only passes)
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
	  passesHoldoutOrIR: boolean;         // (legacy, diagnostic only) holdout Sharpe >= 0.3 OR holdout SPY IR >= 0.3 — disjunction was too permissive
	  passesHoldoutIRFloor?: boolean;     // holdout SPY IR >= 0 (non-negative IR floor)
	  passesHoldoutAndIR?: boolean;       // holdout Sharpe >= 0.3 AND holdout SPY IR >= 0 — the live gate wired into `isValid`
	  passesSanity: boolean;              // OOS Sharpe <= 3.0, OOS MaxDD >= 2%, per-trade edge < 0.95 (catches simulator bugs; Phase 1.c/d)
	  meanPerTradeEdge?: number;          // mean(grossPnl/maxProfit) across credit-spread OOS trades. Phase 1.d diagnostic; NaN/absent when < 20 CS trades.
	  passesStability?: boolean;          // holdoutOOSRatio ∈ [0.5, 2.0] — catches overfit (ratio <0.5) and data-snoop/lucky (ratio >2.0). Phase 1.b.
	  isValidForSearch: boolean;          // selection-only validity — agent-visible (no holdout leakage)
	  isValid: boolean;                   // includes holdout gate — stripped from agent leaderboard; for human/post-hoc analysis only
  // Overfitting diagnostics
  holdoutOOSRatio: number;           // holdoutSharpe / oosSharpe — closer to 1.0 = less overfit
  bootstrapSharpe95CI: [number, number];  // 95% CI on standalone OOS Sharpe
  bootstrapSignificant: boolean;     // is lower bound of CI > 0?
  attemptNumber: number;             // which attempt this is (for multiple testing awareness)
  deflatedSharpe: number;            // Sharpe adjusted for multiple testing (Bailey-López de Prado)
  // Phase 2.a (2026-04-20) — Newey-West effective sample size of the OOS
  // daily-return series. Diagnostic only, not a gate. Reveals when daily
  // returns are strongly autocorrelated (N_eff << N) so a human reviewer
  // can second-guess the bootstrap CI / deflated Sharpe. Agent-visible.
  nEffOosDaily?: number;
  nOosDaily?: number;                // raw length for context (days with P&L attribution)
  // Phase 2.c (2026-04-20) — Mertens closed-form SE on the annualized
  // Sharpe, using N_eff as the effective sample size and the OOS
  // returns' own skew/kurtosis. Independent second estimate of the SE
  // to sanity-check the bootstrap CI. Large disagreement with
  // (bootstrapSharpe95CI[1]-[0])/(2*1.96) flags model mis-specification.
  // Agent-visible.
  mertensSharpeSE?: number;
  mertensSkewness?: number;
  mertensKurtosis?: number;          // raw kurtosis (3 = normal)
  // Pre-registration audit trail (Phase 0.a.1 / Codex re-review Finding 2).
  // Captured once per run by scripts/autoresearch/lib/pre-reg-gate.ts.
  // Persisted in BOTH full and agent-visible leaderboards so the audit
  // survives console-log loss. `preRegBypassed=true` means the run skipped
  // the committed-pre-reg check via AUTORESEARCH_PREREG_BYPASS="<reason>".
  preRegBypassed?: boolean;
  preRegBypassReason?: string;
  preRegBlockHash?: string;       // sha256 of the Pre-Registration markdown block; undefined on bypass
  preRegGitSha?: string | null;   // git commit for .handoff/current.md; undefined on bypass
  preRegHoldoutWindowHash?: string; // canonical sha256:<64hex>; undefined on bypass
  // Adoption-gate provenance (Codex round-3 Finding 3). Records which version
  // of config/adoption-gates.json and which env-var overrides were in effect
  // when this row was written — required for post-hoc compliance audits.
  adoptionGatesRawHash?: string;        // sha256 of config/adoption-gates.json as loaded
  adoptionGatesEffectiveHash?: string;  // raw + env-overrides, for full provenance
  adoptionGatesOverrides?: Array<{ envVar: string; target: string; value: number }>;
  // Phase 0.a.5 provenance: binds each row to the exact strategy commit that
  // produced it, so the seal ceremony can refuse a stale row claimed under a
  // later commit. `strategyGitSha = null` means the strategy file was dirty
  // or untracked at run time — the seal refuses such rows.
  strategyGitSha?: string | null;
  // Phase 0.a.5 round-2 provenance (Codex F1): also bind the FULL repo state
  // at run time, not just the single strategy file's commit. `repoGitSha =
  // null` means the working tree had any uncommitted change when the runner
  // started. The seal refuses null or mismatched values. This catches drift
  // in imported helpers (e.g. src/lib/backtest/option-sim.ts) that the
  // strategy file's last-touch commit cannot detect.
  repoGitSha?: string | null;
  // Phase 0.a.5 round-2 provenance (Codex F1): git-blob SHA of the strategy
  // file content. Distinct strategy contents produce distinct blobs even if
  // committed in the same repo commit. Seal requires this to equal the
  // current strategy file's blob, preventing "point at a different clean
  // file touched in the same commit" confusion.
  strategyBlobSha?: string | null;
  // Phase 0.a.5 skip-holdout marker: `false` means the runner was invoked
  // with AUTORESEARCH_SKIP_HOLDOUT=1 and produced no real holdout evaluation.
  // The seal ceremony refuses any row with `holdoutEvaluated !== true`, so
  // skip-mode rows cannot be sealed even though the row still carries
  // synthetic `passesHoldoutAndIR` values derived from selection data.
  holdoutEvaluated?: boolean;
  // Phase 0.b.6 dataset-manifest provenance. The Pre-Registration block's
  // "Holdout Window Hash" is now semantically bound to config/dataset-
  // manifest.json: runner refuses when the two disagree. The manifest hash
  // and version are stamped onto every row so post-hoc audits can correlate
  // the row's declared date range with committed manifest history.
  datasetManifestHash?: string | null;
  datasetManifestVersion?: number;
  // Phase 0.b.7: sha256 of the per-ticker coverage summary
  // (ticker:first..last:count for each strategy ticker, canonicalized).
  // Lets the seal ceremony refuse rows produced against a different ticker
  // cache state than what's currently loaded. Closes Codex round-3 F1
  // (per-series truncation masked by union-based bounds check).
  tickerCoverageHash?: string | null;
  // Diagnostics
  exitTypeBreakdown: Record<string, number>;
  signalsGenerated: number;         // total signals before WFA filtering
  // NOTE: legacy/misnamed — this is "signals that did not become trades" across
  // selection + holdout (includes training-window signals, constraint rejects, and
  // true chain misses). See runner.ts where it is computed.
  signalsSkippedNoChain: number;
  // Naive baseline comparison (always-long, no signal timing)
  // Baseline uses same SimConfig but periodic entry (every N days) to test
  // whether signal timing adds alpha beyond leveraged beta.
  baselineOosSharpe?: number;
  baselineMaxDD?: number;
  baselineCorrelation?: number;     // baseline correlation with DTE5
  baselineSpyIR?: number;
  baselineTrades?: number;
  // Delta metrics: strategy minus baseline (positive IR = strategy better,
  // negative MaxDD/corr = strategy better)
  deltaSpyIR?: number;
  deltaMaxDD?: number;              // negative = strategy has lower drawdown
  deltaCorrelation?: number;        // negative = strategy has lower DTE5 correlation
  passesDeltaSpyIR?: boolean;       // deltaSpyIR > 0
  passesDeltaMaxDD?: boolean;       // deltaMaxDD <= 0
  passesDeltaCorr?: boolean;        // deltaCorrelation <= 0
  passesDeltaGates?: boolean;       // all three delta gates pass
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
  /** Optional separate config for PUT-direction signals. If present, PUT signals
   *  use putSimConfig and CALL signals use simConfig. Enables hybrid CALL/PUT strategies. */
  putSimConfig?: SimConfig;
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
