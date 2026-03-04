import type { ScoreFactor } from './scoring';

export interface Position {
    id: string;
    ticker: string;
    strike: number;
    type: string;
    expiration: string;
    status: 'watchlist' | 'active' | 'closed';
    setup: string;
    strategy?: string;
    entry_score: number;
    current_score: number;
    entry_loq_score?: number;
    score_updated_at?: string;
    ideal_entry?: number;
    current_price?: number;
    stop_reason?: string;
    target_price?: number;
    /** Manual stop loss price (per contract). If set, overrides calculated stop. */
    stop_price?: number;
    notes?: string;
    created_at?: string;
    closed_at?: string;
    legs?: PositionLeg[];
    owner?: 'Yuchen' | 'Annie' | null;
    // Tech Score Automation
    tech_score?: number;
    tech_score_auto?: number;
    tech_score_manual?: number;
    tech_score_source?: 'auto' | 'manual';
    tech_score_updated_at?: string;
    tech_data?: any;
    // Pine Signal inputs (Layer 1 → Layer 2 handoff)
    direction?: 'BULL' | 'BEAR';
    market_state?: string;
    // Retrospective categorization (captured at entry, cannot be reconstructed)
    trade_profile?: string;
    iv_rank_entry?: number;
    iv_regime_entry?: string;
    // Analytics columns (added via migration)
    max_risk_entry?: number;   // net debit or (spread width − credit) per contract
    exit_type?: 'TP' | 'SL' | 'TIME' | 'MANUAL' | 'ROLL';
}

export interface PositionLeg {
    strike: number;
    type: string;
    side: 'long' | 'short';
    expiration: string;
}

export interface Transaction {
    id: string;
    position_id: string;
    type: 'Open' | 'Size Up' | 'Size Down' | 'Take Profit' | 'Close';
    quantity: number;
    price: number;
    date: string;
    note?: string;
}

export interface LiveData {
    price?: number;
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    rho?: number;
    iv?: number;
    score?: number;
    isDayTrade?: boolean;
    ivRatio?: number;
    /** Explainability: top contributors and penalties for Opt Score (when computed). */
    factors?: ScoreFactor[];
}

export interface GreeksHistory {
    id: string;
    position_id: string;
    iv: number;
    delta: number;
    recorded_at: string;
}

// ────────────────────────────────────────────────────────────────
// Watchlist / Add-to-Watchlist Item
// ────────────────────────────────────────────────────────────────

export interface WatchlistItem {
    ticker: string;
    strike: number;
    type: string;
    expiration: string;
    setup?: string;
    strategy?: string;
    entry_score?: number | null;
    current_score?: number | null;
    current_price?: number | null;
    ideal_entry?: number | null;
    target_price?: number | null;
    stop_reason?: string;
    notes?: string;
    legs?: PositionLeg[];
    owner?: 'Yuchen' | 'Annie' | null;
    tech_score?: number;
    tech_score_source?: 'auto' | 'manual';
    // Pine Signal inputs (captured at recommendation time)
    direction?: 'BULL' | 'BEAR';
    market_state?: string;
    // Retrospective categorization (captured at entry)
    trade_profile?: string;
    iv_rank_entry?: number;
    iv_regime_entry?: string;
}

// ────────────────────────────────────────────────────────────────
// Direct Add Position
// ────────────────────────────────────────────────────────────────

export interface DirectAddItem {
    ticker: string;
    strike: number;
    type: string;
    expiration: string;
    setup: string;
    strategy?: string;
    entry_score: number;
    stop_reason?: string;
    quantity: number;
    entry_price: number;
    legs?: PositionLeg[];
    owner?: 'Yuchen' | 'Annie' | null;
    tech_score?: number;
    tech_score_source?: 'auto' | 'manual';
    // Pine Signal inputs + entry analytics (mirrors WatchlistItem)
    direction?: 'BULL' | 'BEAR';
    iv_regime_entry?: string;   // 'CREDIT' | 'DEBIT' | 'NEUTRAL'
    max_risk_entry?: number;    // net debit, or (spread width − credit) × 100
}

// ────────────────────────────────────────────────────────────────
// Strategy Recommender Types
// ────────────────────────────────────────────────────────────────

/** Term structure slope tier for fine-tuning regime (strong contango/backwardation). */
export type SlopeTier = 'strong_backwardation' | 'backwardation' | 'flat' | 'contango' | 'strong_contango';

export interface StrategyRegime {
    ivRatio: number | null;
    /** Term structure slope (IV30−IV90)/IV90. Positive = backwardation, negative = contango. */
    slope: number | null;
    slopeTier: SlopeTier | null;
    iv30: number | null;
    iv90: number | null;
    rv30: number | null;
    ivRvRatio: number | null;
    /** IV Rank: current IV30 percentile in 252d range (0–1). null when insufficient history. */
    ivRank: number | null;
    /** IV Percentile: fraction of past days with IV30 below current (0–1). */
    ivPercentile: number | null;
    /** Number of days in ticker_iv_snapshots used to compute IV Rank. */
    ivRankSampleDays?: number;
    /** Source of IV Rank data: 'live_iv' (real IV), 'rv_proxy' (estimated from RV), or null. */
    ivRankSource?: 'live_iv' | 'rv_proxy' | null;
    /** IV30 change over last 5 trading days (pp). Positive = rising IV. */
    iv5dChange?: number | null;
    /** IV trend direction derived from 5d change. Rising IV = avoid selling premium. */
    ivTrend?: 'rising' | 'falling' | 'flat' | null;
    mode: 'CREDIT' | 'DEBIT' | 'NEUTRAL';
    advice: string;
    /** Longer explanation of why this regime favors Credit/Debit/Neutral and what to do. */
    adviceDetail?: string | null;
}

export interface StrategyContext {
    ticker: string;
    currentPrice: number;
    direction: 'BULL' | 'BEAR';
    targetDte: number;
    daysUntilEarnings: number | null;
}

export interface SpreadLeg {
    strike: number;
    price: number;
    delta: number;
    expiration: string;
    dte: number;
    volume: number;
    openInterest: number;
}

export interface SpreadRecommendation {
    type: string;
    score: number;
    whyThis: string;
    /** Top contributors and penalties for this score (explainability). */
    factors?: ScoreFactor[];
    shortLeg: SpreadLeg;
    longLeg: SpreadLeg;
    width: number;
    netCredit?: number;
    netDebit?: number;
    maxRisk: number;
    maxProfit: number;
    roi?: number;
    riskReward?: number;
    pop?: number;
    expectedValue?: number;
    /** Holding-period EV: assumes 50% profit-target / 50% stop-loss exit, not holding to expiry. */
    evHold?: number;
    /** EV per day of expected hold time (cross-DTE comparison). */
    evDaily?: number;
    breakeven: number;
    distance?: number;
    lambda?: number;
    recommendation?: { maxContracts?: number; action: string; note?: string };
}

export interface SingleLegRecommendation {
    type: string;
    score: number;
    whyThis: string;
    /** Top contributors and penalties for this score (explainability). */
    factors?: ScoreFactor[];
    strike: number;
    expiration: string;
    dte: number;
    price: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    lambda: number;
    dollarGamma: number;
    thetaBurn: number;
    volume: number;
    openInterest: number;
    bid?: number;
    ask?: number;
    recommendation?: { action: string; note?: string };
}

export type Recommendation = SpreadRecommendation | SingleLegRecommendation;

export type StrategyCategory = 'CREDIT_SPREAD' | 'DEBIT_SPREAD' | 'SINGLE_LEG';

export type UnifiedSpreadCandidate = SpreadRecommendation & {
    strategyCategory: StrategyCategory;
    unifiedScore: number;
};

export type UnifiedSingleLegCandidate = SingleLegRecommendation & {
    strategyCategory: StrategyCategory;
    unifiedScore: number;
};

export type UnifiedCandidateType = UnifiedSpreadCandidate | UnifiedSingleLegCandidate;

export interface StrategyResult {
    success: boolean;
    /** True when the ticker had no IV history and a background backfill was triggered. Re-analyze after ~30s. */
    autoBackfillTriggered?: boolean;
    /** Which options data source was used: 'POLYGON' (real-time) or 'CBOE' (15-min delayed). */
    dataSource?: 'POLYGON' | 'CBOE';
    /** 'degraded' when >50% of parsed options have zero Greeks (CBOE data quality issue). */
    dataQuality?: 'ok' | 'degraded';
    /** false when CBOE + degraded data → scores are meaningless (~50 for everything). */
    scoresReliable?: boolean;
    /** Quote freshness info from Polygon (null for CBOE). */
    quoteFreshness?: { isStale: boolean; staleQuotes: number; oldestQuoteAgeMs: number } | null;
    context: StrategyContext;
    regime: StrategyRegime;
    recommendedStrategy: 'CREDIT_SPREAD' | 'DEBIT_SPREAD' | 'SINGLE_LEG';
    strategies: {
        TARGET_STRATEGY: Recommendation[];
        _regimeMeta?: { skew: number | null };
    };
}

// ────────────────────────────────────────────────────────────────
// Scanner Context (from API response)
// ────────────────────────────────────────────────────────────────

export interface ScannerApiContext {
    ticker: string;
    currentPrice: number;
    ivRatio: number;
    iv30: number | null;
    iv90: number | null;
    ivStatus: 'contango' | 'neutral' | 'backwardation';
    strategy: string;
    totalOptions: number;
    filteredCount: number;
    cboeTimestamp: string | null;
}

// ────────────────────────────────────────────────────────────────
// Position Action
// ────────────────────────────────────────────────────────────────

export interface PositionAction {
    type: string;
    quantity: number;
    price: number;
}

// ────────────────────────────────────────────────────────────────
// Roll Data
// ────────────────────────────────────────────────────────────────

export interface RollData {
    closeQty: number;
    closePrice: number;
    newStrike: number | string;
    newType: 'Call' | 'Put';
    newExpiration: string;
    newQty: number;
    newPrice: number;
}

// Scanner types (re-exported from scoring.ts for convenience)
export type {
    OptionData,
    ScoredResult,
    ScanContext,
    Strategy,
    ScoreFactor
} from './scoring';
