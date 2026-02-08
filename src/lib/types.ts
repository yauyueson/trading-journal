export interface Position {
    id: string;
    ticker: string;
    strike: number;
    type: string;
    expiration: string;
    status: 'watchlist' | 'active' | 'closed';
    setup: string;
    entry_score: number;
    current_score: number;
    entry_loq_score?: number;
    score_updated_at?: string;
    ideal_entry?: number;
    current_price?: number;
    stop_reason?: string;
    target_price?: number;
    notes?: string;
    created_at?: string;
    closed_at?: string;
    legs?: PositionLeg[];
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
    entry_score?: number | null;
    current_score?: number | null;
    current_price?: number | null;
    ideal_entry?: number | null;
    target_price?: number | null;
    stop_reason?: string;
    notes?: string;
    legs?: PositionLeg[];
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
    entry_score: number;
    stop_reason?: string;
    quantity: number;
    entry_price: number;
}

// ────────────────────────────────────────────────────────────────
// Strategy Recommender Types
// ────────────────────────────────────────────────────────────────

export interface StrategyRegime {
    ivRatio: number | null;
    iv30: number | null;
    iv90: number | null;
    rv30: number | null;
    ivRvRatio: number | null;
    mode: 'CREDIT' | 'DEBIT' | 'NEUTRAL';
    advice: string;
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
    breakeven: number;
    distance?: number;
    lambda?: number;
    recommendation?: { maxContracts: number; action: string };
}

export interface SingleLegRecommendation {
    type: string;
    score: number;
    whyThis: string;
    strike: number;
    expiration: string;
    dte: number;
    price: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    lambda: number;
    gammaEff: number;
    thetaBurn: number;
    volume: number;
    openInterest: number;
}

export type Recommendation = SpreadRecommendation | SingleLegRecommendation;

export interface StrategyResult {
    success: boolean;
    context: StrategyContext;
    regime: StrategyRegime;
    recommendedStrategy: 'CREDIT_SPREAD' | 'DEBIT_SPREAD' | 'SINGLE_LEG';
    strategies: {
        CREDIT_SPREAD: SpreadRecommendation[];
        DEBIT_SPREAD: SpreadRecommendation[];
        SINGLE_LEG: SingleLegRecommendation[];
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
    Strategy
} from './scoring';
