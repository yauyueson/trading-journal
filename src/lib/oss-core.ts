/**
 * OSS Core - Options Scoring System v2.3
 * ═══════════════════════════════════════════════════════════════
 * SINGLE SOURCE OF TRUTH for all scoring algorithms.
 *
 * This module is the canonical implementation. API serverless functions
 * mirror this file via api/_shared/scoring.js.
 *
 * v2.2 Changes:
 * - NEW: Gamma/Theta Ratio (G/T) — "cost of gamma" metric for LOQ
 * - LOQ weights redistributed to accommodate G/T dimension
 * - Day-trade weights updated (G/T emphasized for intraday)
 *
 * DO NOT duplicate these functions elsewhere.
 * ═══════════════════════════════════════════════════════════════
 */

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export const HARD_FILTER_DEFAULTS = {
    minMid: 0.15,
    minOpenInterest: 200,
    maxSpreadPctCeiling: 0.12,
} as const;

export const DTE_BUCKETS = [
    { label: '0-14',   min: 0,   max: 14  },
    { label: '15-30',  min: 15,  max: 30  },
    { label: '31-60',  min: 31,  max: 60  },
    { label: '61-120', min: 61,  max: 120 },
    { label: '121+',   min: 121, max: Infinity },
] as const;

export const MIN_BUCKET_SIZE = 3;

export type Strategy = 'long' | 'short';

export interface CreditSpreadMetrics {
    credit: number;
    width: number;
    shortDelta: number;
    shortStrike: number;
    currentPrice: number;
    /** If set, POP is derived from delta at breakeven (more accurate than short-strike delta). */
    deltaAtBreakeven?: number;
}

export interface DebitSpreadMetrics {
    debit: number;
    width: number;
    longDelta: number;
    longPrice: number;
    currentPrice: number;
}

// ────────────────────────────────────────────────────────────────
// Math Primitives (with edge-case guards)
// ────────────────────────────────────────────────────────────────

/**
 * Safe linear interpolation.
 * Guards against degenerate interval (x1 === x2) by returning midpoint.
 */
export function lerp(x: number, x1: number, x2: number, y1: number, y2: number): number {
    if (x2 === x1) return (y1 + y2) / 2;
    return y1 + (y2 - y1) * ((x - x1) / (x2 - x1));
}

/**
 * Standard sigmoid σ(x) = 1 / (1 + e^(-x)).
 * Input is clamped to [-50, 50] to prevent floating-point overflow.
 */
export function sigmoid(x: number): number {
    const clamped = Math.max(-50, Math.min(50, x));
    return 1 / (1 + Math.exp(-clamped));
}

// ────────────────────────────────────────────────────────────────
// Lambda Soft Compression
// ────────────────────────────────────────────────────────────────

/**
 * Compress extreme Lambda values to prevent Z-Score explosion.
 * Lambda ≤ 20: pass-through. Lambda > 20: soft log-linear decay.
 */
export function compressLambda(lambda: number): number {
    const THRESHOLD = 20;
    const DECAY_RATE = 0.1;
    if (lambda <= THRESHOLD) return lambda;
    return THRESHOLD + (lambda - THRESHOLD) * DECAY_RATE;
}

// ────────────────────────────────────────────────────────────────
// Raw Metric Calculations
// ────────────────────────────────────────────────────────────────

/**
 * Lambda (Λ) - True Leverage Ratio.
 * Guards against penny options (price ≤ 0.01).
 */
export function calculateLambda(delta: number, stockPrice: number, optionPrice: number): number {
    if (optionPrice <= 0.01) return 0;
    return Math.abs(delta) * (stockPrice / optionPrice);
}

/**
 * Gamma Efficiency (Γeff) - Explosiveness per dollar.
 */
export function calculateGammaEfficiency(gamma: number, optionPrice: number): number {
    if (optionPrice <= 0.01) return 0;
    return gamma / optionPrice;
}

/**
 * Theta Burn (TB) - Daily time decay rate.
 */
export function calculateThetaBurn(theta: number, optionPrice: number): number {
    if (optionPrice <= 0.01) return 0;
    return Math.abs(theta) / optionPrice;
}

/**
 * Gamma/Theta Ratio (G/T) - Cost of Gamma (v2.2).
 *
 * Measures how much gamma you receive per unit of theta decay.
 * High G/T = cheap gamma (good for buyers).
 * Low G/T  = expensive gamma (bad for buyers).
 *
 * Soft compression at threshold 5 to prevent Z-Score explosion.
 * When theta is negligible (< 0.001), caps at 5 if gamma > 0.
 */
export function calculateGammaThetaRatio(gamma: number, theta: number): number {
    const absTheta = Math.abs(theta);
    if (absTheta < 0.001) return gamma > 0 ? 5 : 0;
    const raw = gamma / absTheta;
    const THRESHOLD = 5;
    const DECAY_RATE = 0.1;
    if (raw <= THRESHOLD) return raw;
    return THRESHOLD + (raw - THRESHOLD) * DECAY_RATE;
}

/**
 * Breakeven Move % - True expiration breakeven (v2.3).
 *
 * Call: BE = K + premium   → Move% = |BE − S| / S
 * Put:  BE = K − premium   → Move% = |BE − S| / S
 *
 * Returns a decimal (0.05 = 5% move needed).
 * Guards against stockPrice ≤ 0 (returns 1.0 = unrealistic).
 */
export function calculateBreakevenMove(
    strike: number, premium: number, stockPrice: number, optionType: 'Call' | 'Put'
): number {
    if (stockPrice <= 0) return 1;
    const breakeven = optionType === 'Call' ? strike + premium : strike - premium;
    return Math.abs(breakeven - stockPrice) / stockPrice;
}

/**
 * Breakeven Penalty/Bonus - DTE-adjusted reality check (v2.2).
 *
 * Normalizes breakeven by sqrt(DTE/30) so longer-dated options are not
 * unfairly penalized (stock has more time to move).
 *
 * Adjusted BE ≤ 2%:   +0.5  (very achievable)
 * Adjusted BE 2-5%:   lerp(+0.5, 0)
 * Adjusted BE 5-10%:  lerp(0, -1.0)
 * Adjusted BE 10-20%: lerp(-1.0, -2.0)
 * Adjusted BE > 20%:  -2.0  (capped, unrealistic)
 */
export function getBreakevenPenalty(breakevenMove: number, dte: number): number {
    const dteFactor = dte > 0 ? Math.sqrt(dte / 30) : 1;
    const adjusted = breakevenMove / dteFactor;

    if (adjusted <= 0.02) return 0.5;
    if (adjusted <= 0.05) return lerp(adjusted, 0.02, 0.05, 0.5, 0);
    if (adjusted <= 0.10) return lerp(adjusted, 0.05, 0.10, 0, -1.0);
    if (adjusted <= 0.20) return lerp(adjusted, 0.10, 0.20, -1.0, -2.0);
    return -2.0;
}

/**
 * Theta Pain Curve - Quadratic penalty for high time decay.
 *
 * Safe zone: ≤ 0.5%/day → 0 penalty.
 * Beyond safe zone: quadratic growth, capped at 10 (v2.1).
 */
export function getThetaPenalty(thetaBurn: number): number {
    const SAFE_ZONE = 0.005;
    if (thetaBurn <= SAFE_ZONE) return 0;
    const excess = thetaBurn - SAFE_ZONE;
    return Math.min(Math.pow(excess * 100, 2) * 0.5, 10);
}

/**
 * POP (Probability of Profit) - For sellers.
 */
export function calculatePOP(delta: number): number {
    return 1 - Math.abs(delta);
}

/**
 * Seller's Edge - Expected win amount for credit sellers (upside only).
 */
export function calculateSellerEdge(pop: number, premium: number): number {
    return pop * premium;
}

/**
 * Expected Value (EV) - Full risk-adjusted return for credit spreads (v2.2).
 *
 * EV = (POP × Credit) - ((1-POP) × MaxRisk)
 *
 * Integrates both upside and downside into a single metric.
 * Positive EV = edge in seller's favor; Negative EV = expected loss.
 */
export function calculateExpectedValue(pop: number, credit: number, maxRisk: number): number {
    return (pop * credit) - ((1 - pop) * maxRisk);
}

/**
 * Spread Percentage - Liquidity measure.
 */
export function calculateSpreadPct(bid: number, ask: number): number {
    const mid = (bid + ask) / 2;
    if (mid <= 0) return 1;
    return (ask - bid) / mid;
}

// ────────────────────────────────────────────────────────────────
// Delta Bonus (LERP v2.1 — smooth transitions)
// ────────────────────────────────────────────────────────────────

/**
 * Delta Bonus with linear interpolation between breakpoints.
 *
 * |Δ| < 0.15          → -2.0 (lottery penalty, flat)
 * |Δ| 0.15 – 0.30     → lerp(-2.0, -0.5)
 * |Δ| 0.30 – 0.50     → lerp(-0.5, +1.0) (sweet spot)
 * |Δ| 0.50 – 0.70     → lerp(+1.0, +0.5)
 * |Δ| 0.70 – 1.00     → lerp(+0.5, 0)
 */
export function getDeltaBonus(delta: number): number {
    const absDelta = Math.abs(delta);
    if (absDelta < 0.15) return -2.0;
    if (absDelta < 0.30) return lerp(absDelta, 0.15, 0.30, -2.0, -0.5);
    if (absDelta < 0.50) return lerp(absDelta, 0.30, 0.50, -0.5, 1.0);
    if (absDelta < 0.70) return lerp(absDelta, 0.50, 0.70, 1.0, 0.5);
    if (absDelta <= 1.0) return lerp(absDelta, 0.70, 1.0, 0.5, 0);
    return 0;
}

// ────────────────────────────────────────────────────────────────
// Z-Score Normalization
// ────────────────────────────────────────────────────────────────

/**
 * Normalize an array of values to Z-Scores.
 * Returns all zeros if n < 2 or all values are identical (std = 0).
 */
export function normalizeToZScores(values: number[]): number[] {
    const n = values.length;
    if (n < 2) return values.map(() => 0);
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1;
    return values.map(v => (v - mean) / std);
}

/**
 * Normalize values to Z-Scores within DTE buckets.
 * Items are grouped by DTE bucket; z-scores are computed per bucket.
 * Falls back to pool-wide stats if a bucket has fewer than minBucketSize items.
 */
export function normalizeToZScoresByBucket(
    values: number[], dtes: number[], minBucketSize: number = MIN_BUCKET_SIZE
): number[] {
    const n = values.length;
    if (n < 2) return values.map(() => 0);

    // Pool-wide stats (fallback)
    const poolMean = values.reduce((s, v) => s + v, 0) / n;
    const poolStd = Math.sqrt(values.reduce((s, v) => s + (v - poolMean) ** 2, 0) / n) || 1;

    // Assign each item to a bucket index
    const bucketIndex = dtes.map(dte => {
        for (let b = 0; b < DTE_BUCKETS.length; b++) {
            if (dte >= DTE_BUCKETS[b].min && dte <= DTE_BUCKETS[b].max) return b;
        }
        return DTE_BUCKETS.length - 1; // fallback to last bucket
    });

    // Compute per-bucket stats
    const bucketStats: Map<number, { mean: number; std: number }> = new Map();
    for (let b = 0; b < DTE_BUCKETS.length; b++) {
        const indices: number[] = [];
        for (let i = 0; i < n; i++) {
            if (bucketIndex[i] === b) indices.push(i);
        }
        if (indices.length >= minBucketSize) {
            const bMean = indices.reduce((s, idx) => s + values[idx], 0) / indices.length;
            const bStd = Math.sqrt(indices.reduce((s, idx) => s + (values[idx] - bMean) ** 2, 0) / indices.length) || 1;
            bucketStats.set(b, { mean: bMean, std: bStd });
        }
    }

    // Compute z-scores using bucket stats or pool-wide fallback
    return values.map((v, i) => {
        const stats = bucketStats.get(bucketIndex[i]);
        const mean = stats ? stats.mean : poolMean;
        const std = stats ? stats.std : poolStd;
        return (v - mean) / std;
    });
}

// ────────────────────────────────────────────────────────────────
// IV Risk Factor & Adjustment (Sigmoid Phase Transition)
// ────────────────────────────────────────────────────────────────

/**
 * IV Risk Factor using Sigmoid phase transition model.
 *
 * Ratio is clamped to [0.5, 2.0] before processing.
 * Returns ~0.9 (contango/safe) to ~1.3 (backwardation/danger).
 */
export function getIVRiskFactor(ratio: number): number {
    const clamped = Math.max(0.5, Math.min(2.0, ratio));
    const k = 12;
    const x0 = 1.10;
    const raw = sigmoid(k * (clamped - x0));
    return 0.9 + raw * 0.4;
}

/**
 * IV Adjustment for scoring.
 *
 * Buyers (long):  (1 - riskFactor) * 5  → +0.5 contango, -1.5 backwardation
 * Sellers (short): (riskFactor - 1) * 5  → -0.5 contango, +1.5 backwardation
 */
export function getIVAdjustment(ivRatio: number, strategy: Strategy): number {
    const riskFactor = getIVRiskFactor(ivRatio);
    if (strategy === 'long') {
        return (1 - riskFactor) * 5;
    }
    return (riskFactor - 1) * 5;
}

/**
 * IV Rank Adjustment - Historical IV context (v2.2).
 *
 * ivRank in [0, 1]: where current IV sits vs 52-week min/max.
 * - Low rank (< 0.3): IV cheap → favor buyers, penalize sellers
 * - High rank (> 0.7): IV expensive → favor sellers, penalize buyers
 *
 * Returns 0 if ivRank is null (no history). Add this on top of getIVAdjustment.
 */
export function getIVRankAdjustment(ivRank: number | null, strategy: Strategy): number {
    if (ivRank == null || ivRank < 0 || ivRank > 1) return 0;
    if (strategy === 'long') {
        if (ivRank < 0.3) return 0.5;
        if (ivRank > 0.7) return -0.5;
        return 0;
    }
    if (ivRank < 0.3) return -0.3;
    if (ivRank > 0.7) return 0.5;
    return 0;
}

/**
 * Relative IV adjustment for LOQ (long options).
 * Uses same-DTE ATM IV as benchmark: option IV vs ATM IV.
 * - Ratio < 1 (cheap vol): small bonus (buy cheap volatility).
 * - Ratio > 1 (expensive): small penalty (avoid overpaying).
 * Capped ±0.4 so it does not dominate the score.
 */
export function getRelativeIVAdjustmentLOQ(
    optionIv: number | null | undefined,
    atmIvSameDTE: number | null | undefined
): number {
    if (optionIv == null || atmIvSameDTE == null || atmIvSameDTE <= 0) return 0;
    const ratio = optionIv / atmIvSameDTE;
    const raw = (1 - ratio) * 0.5;
    return Math.max(-0.4, Math.min(0.4, raw));
}

/**
 * Relative IV adjustment for CSQ (short options).
 * Uses same-DTE ATM IV as benchmark.
 * - Ratio > 1 (expensive vol): small bonus (sell expensive volatility).
 * - Ratio < 1 (cheap): small penalty. Combined with vega penalty to avoid over-exposure to vol crush.
 * Capped ±0.4.
 */
export function getRelativeIVAdjustmentCSQ(
    optionIv: number | null | undefined,
    atmIvSameDTE: number | null | undefined
): number {
    if (optionIv == null || atmIvSameDTE == null || atmIvSameDTE <= 0) return 0;
    const ratio = optionIv / atmIvSameDTE;
    const raw = (ratio - 1) * 0.5;
    return Math.max(-0.4, Math.min(0.4, raw));
}

// ────────────────────────────────────────────────────────────────
// LOQ Weights & Score
// ────────────────────────────────────────────────────────────────

/** Standard mode weights (v2.2 — G/T + Breakeven) */
export const LOQ_WEIGHTS = {
    lambda: 0.30,
    gammaEff: 0.20,
    gammaThetaRatio: 0.15,
    thetaBurn: -0.10,
    deltaBonus: 0.15,
    breakevenPenalty: 0.10,
} as const;

/** Day-trade mode weights (DTE ≤ 5, v2.2 — G/T emphasized, BE de-emphasized) */
export const LOQ_DT_WEIGHTS = {
    lambda: 0.30,
    gammaEff: 0.35,
    gammaThetaRatio: 0.20,
    thetaBurn: -0.05,
    breakevenPenalty: 0.05,
    penaltyMult: 0.2,
} as const;

export interface LOQWeightsForDTE {
    lambda: number;
    gammaEff: number;
    gammaThetaRatio: number;
    thetaBurn: number;
    deltaBonus: number;
    breakevenPenalty: number;
    penaltyMult: number;
}

/**
 * Get LOQ weights by DTE — smooth transition instead of binary Day Trade vs Standard (v2.2).
 *
 * DTE ≤ 5:  full day-trade weights (gamma heavy, theta/BE light)
 * DTE 5–15: lerp from DT → Standard (no score jump at 6 DTE)
 * DTE ≥ 15: standard weights
 */
export function getLOQWeightsForDTE(dte: number): LOQWeightsForDTE {
    const deltaBonus = LOQ_WEIGHTS.deltaBonus;
    if (dte <= 5) {
        return {
            lambda: LOQ_DT_WEIGHTS.lambda,
            gammaEff: LOQ_DT_WEIGHTS.gammaEff,
            gammaThetaRatio: LOQ_DT_WEIGHTS.gammaThetaRatio,
            thetaBurn: LOQ_DT_WEIGHTS.thetaBurn,
            deltaBonus,
            breakevenPenalty: LOQ_DT_WEIGHTS.breakevenPenalty,
            penaltyMult: LOQ_DT_WEIGHTS.penaltyMult,
        };
    }
    if (dte >= 15) {
        return {
            lambda: LOQ_WEIGHTS.lambda,
            gammaEff: LOQ_WEIGHTS.gammaEff,
            gammaThetaRatio: LOQ_WEIGHTS.gammaThetaRatio,
            thetaBurn: LOQ_WEIGHTS.thetaBurn,
            deltaBonus,
            breakevenPenalty: LOQ_WEIGHTS.breakevenPenalty,
            penaltyMult: 1,
        };
    }
    const t = (dte - 5) / 10;
    const mix = (a: number, b: number) => a + (b - a) * t;
    return {
        lambda: mix(LOQ_DT_WEIGHTS.lambda, LOQ_WEIGHTS.lambda),
        gammaEff: mix(LOQ_DT_WEIGHTS.gammaEff, LOQ_WEIGHTS.gammaEff),
        gammaThetaRatio: mix(LOQ_DT_WEIGHTS.gammaThetaRatio, LOQ_WEIGHTS.gammaThetaRatio),
        thetaBurn: mix(LOQ_DT_WEIGHTS.thetaBurn, LOQ_WEIGHTS.thetaBurn),
        deltaBonus,
        breakevenPenalty: mix(LOQ_DT_WEIGHTS.breakevenPenalty, LOQ_WEIGHTS.breakevenPenalty),
        penaltyMult: mix(LOQ_DT_WEIGHTS.penaltyMult, 1),
    };
}

/** Vega efficiency weight when IV is low (long-friendly): reward high vega/premium. */
export const LOQ_VEGA_EFF_WEIGHT_POS = 0.05;
/** Vega efficiency weight when IV is high: mild penalty to avoid buying highest vega. */
export const LOQ_VEGA_EFF_WEIGHT_NEG = -0.03;
/** CSQ: mild penalty weight for high vega/premium (seller more sensitive to vol). */
export const CSQ_VEGA_PENALTY_WEIGHT = -0.05;

/**
 * Calculate raw LOQ score (v2.2 — G/T + Breakeven + DTE‑continuous weights).
 * v2.4: optional vegaZ (z-score of vega/premium); IV low → bonus for high vega, IV high → mild penalty.
 *
 * When `dte` is provided, uses getLOQWeightsForDTE(dte) and ignores `isDayTrade`.
 * Otherwise uses legacy isDayTrade (true = DT weights, false = Standard).
 */
export function calculateLOQRaw(
    zLambda: number,
    zGammaEff: number,
    zThetaBurn: number,
    ivAdjustment: number,
    deltaBonus: number = 0,
    thetaBurn: number = 0,
    isDayTrade: boolean = false,
    zGammaThetaRatio: number = 0,
    breakevenPenalty: number = 0,
    dte: number | null = null,
    vegaZ: number = 0,
): number {
    const thetaPenalty = getThetaPenalty(thetaBurn);
    const w =
        dte != null
            ? getLOQWeightsForDTE(dte)
            : isDayTrade
              ? {
                    ...LOQ_DT_WEIGHTS,
                    deltaBonus: LOQ_WEIGHTS.deltaBonus,
                    penaltyMult: LOQ_DT_WEIGHTS.penaltyMult,
                }
              : {
                    ...LOQ_WEIGHTS,
                    penaltyMult: 1,
                };

    const vegaWeight =
        ivAdjustment > 0 ? LOQ_VEGA_EFF_WEIGHT_POS : ivAdjustment < 0 ? LOQ_VEGA_EFF_WEIGHT_NEG : 0;
    const vegaBonus = vegaWeight * vegaZ;

    return (
        w.lambda * zLambda +
        w.gammaEff * zGammaEff +
        w.gammaThetaRatio * zGammaThetaRatio +
        w.thetaBurn * zThetaBurn +
        w.deltaBonus * deltaBonus +
        w.breakevenPenalty * breakevenPenalty +
        ivAdjustment -
        thetaPenalty * w.penaltyMult +
        vegaBonus
    );
}

// ────────────────────────────────────────────────────────────────
// CSQ Weights & Score
// ────────────────────────────────────────────────────────────────

export const CSQ_WEIGHTS = {
    edge: 0.50,
    pop: 0.30,
    spread: -0.20,
} as const;

/**
 * Calculate raw CSQ score.
 * v2.4: optional vegaPenalty — mild penalty for high vega/premium (seller more sensitive to vol).
 */
export function calculateCSQRaw(
    zEdge: number,
    zPOP: number,
    zSpread: number,
    ivAdjustment: number,
    vegaPenalty: number = 0,
): number {
    return (
        CSQ_WEIGHTS.edge * zEdge +
        CSQ_WEIGHTS.pop * zPOP +
        CSQ_WEIGHTS.spread * zSpread +
        ivAdjustment +
        vegaPenalty
    );
}

// ────────────────────────────────────────────────────────────────
// Score Normalization (0–100)
// ────────────────────────────────────────────────────────────────

/**
 * Map raw Z-weighted score to 0–100.
 * Z=0 → 50, Z=+4 → 100, Z=-4 → 0.
 */
export function normalizeScoreTo100(rawScore: number): number {
    const scaled = 50 + rawScore * 12.5;
    return Math.max(0, Math.min(100, Math.round(scaled)));
}

/**
 * Normalize an array of raw LOQ scores to 0–100 using the pool's distribution (dynamic baseline).
 * Eliminates cross-ticker unfairness: scores are comparable within the same pool (e.g. same chain or same scan).
 * mean → 50, +1 std → 70, -1 std → 30; scale uses 20 pts per z so 2.5 z ≈ 0–100.
 */
export function normalizeLOQScoresWithDynamicBaseline(rawScores: number[]): number[] {
    const n = rawScores.length;
    if (n === 0) return [];
    if (n === 1) return [50];
    const mean = rawScores.reduce((s, v) => s + v, 0) / n;
    const variance = rawScores.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance) || 1;
    return rawScores.map((raw) => {
        const z = (raw - mean) / std;
        const scaled = 50 + z * 20;
        return Math.max(0, Math.min(100, Math.round(scaled)));
    });
}

// ────────────────────────────────────────────────────────────────
// Single-Position LOQ (Portfolio Use)
// ────────────────────────────────────────────────────────────────

/**
 * Calculate LOQ for a single position without a comparison pool.
 * Uses reference baselines and applies Lambda compression.
 * v2.2: includes G/T Ratio and Breakeven Penalty.
 * v2.3: uses true expiration breakeven when strike/optionType are provided.
 */
export function calculateSingleLOQ(
    delta: number,
    gamma: number,
    theta: number,
    stockPrice: number,
    optionPrice: number,
    ivRatio: number = 1.0,
    dte: number = 30,
    strike?: number,
    optionType?: 'Call' | 'Put',
): number {
    const rawLambda = calculateLambda(delta, stockPrice, optionPrice);
    const compLambda = compressLambda(rawLambda);
    const gammaEff = calculateGammaEfficiency(gamma, optionPrice);
    const thetaBurn = calculateThetaBurn(theta, optionPrice);
    const gtRatio = calculateGammaThetaRatio(gamma, theta);
    const beMove = strike != null && optionType
        ? calculateBreakevenMove(strike, optionPrice, stockPrice, optionType)
        : (Math.abs(delta) < 0.01 || stockPrice <= 0) ? 1 : optionPrice / (Math.abs(delta) * stockPrice);
    const bePenalty = getBreakevenPenalty(beMove, dte);

    // Reference baselines (no pool available)
    const zLambda = (compLambda - 8) / 4;
    const zGamma = (gammaEff - 0.02) / 0.015;
    const zTheta = (thetaBurn - 0.03) / 0.02;
    const zGT = (gtRatio - 0.5) / 0.4;

    const deltaBonus = getDeltaBonus(delta);
    const ivAdjustment = getIVAdjustment(ivRatio, 'long');
    const rawScore = calculateLOQRaw(zLambda, zGamma, zTheta, ivAdjustment, deltaBonus, thetaBurn, false, zGT, bePenalty, dte);

    return normalizeScoreTo100(rawScore);
}

// ────────────────────────────────────────────────────────────────
// Spread Scoring
// ────────────────────────────────────────────────────────────────

/**
 * Credit Spread Score (CSQ+, v2.2 — EV-enhanced).
 *
 * EV 30% | ROI 25% | POP 25% | Distance 20%.
 *
 * EV integrates probability and payoff into a single "is this trade worth it?"
 * metric. ROI and POP are kept as separate dimensions for ranking trades that
 * have similar EV but different risk profiles (lottery vs. grinder).
 */
export function calculateCreditSpreadScore(metrics: CreditSpreadMetrics): number {
    const { credit, width, shortDelta, shortStrike, currentPrice, deltaAtBreakeven } = metrics;
    const maxRisk = width - credit;
    if (maxRisk <= 0) return 0;

    const roi = (credit / maxRisk) * 100;
    const pop = deltaAtBreakeven != null ? 1 - Math.abs(deltaAtBreakeven) : 1 - Math.abs(shortDelta);
    const distance = currentPrice > 0 ? Math.abs(currentPrice - shortStrike) / currentPrice : 0;
    const ev = calculateExpectedValue(pop, credit, maxRisk);

    // EV score: evRatio = EV / Credit (expected return per dollar of premium)
    // Maps: -0.50 → 0, 0.0 → 50, +0.50 → 100
    const evRatio = credit > 0 ? ev / credit : 0;
    const scoreEV = Math.max(0, Math.min(100, 50 + evRatio * 100));

    const scoreROI = Math.min(roi * 4, 100);
    const scorePOP = pop * 100;
    const scoreDistance = Math.min(distance * 1000, 100);

    const finalScore = 0.30 * scoreEV + 0.25 * scoreROI + 0.25 * scorePOP + 0.20 * scoreDistance;
    return Math.round(Math.min(100, Math.max(0, finalScore)));
}

/**
 * Debit Spread Score (LOQ+).
 * Lambda 40% | Risk/Reward 35% | Delta Bonus 25%.
 */
export function calculateDebitSpreadScore(metrics: DebitSpreadMetrics): number {
    const { debit, width, longDelta, longPrice, currentPrice } = metrics;
    const maxProfit = width - debit;
    if (debit <= 0) return 0;

    const riskReward = maxProfit / debit;
    const lambda = longPrice > 0 ? Math.abs(longDelta) * (currentPrice / longPrice) : 0;
    const compLambda = compressLambda(lambda);
    const deltaBonus = getDeltaBonus(longDelta);

    const lambdaScore = Math.min((compLambda / 20) * 100, 100);
    const rrScore = Math.min((riskReward / 3) * 100, 100);
    const deltaScore = 50 + deltaBonus * 12.5;

    const finalScore = 0.4 * lambdaScore + 0.35 * rrScore + 0.25 * deltaScore;
    return Math.round(Math.min(100, Math.max(0, finalScore)));
}
