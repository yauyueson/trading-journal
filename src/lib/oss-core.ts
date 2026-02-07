/**
 * OSS Core - Options Scoring System v2.1
 * ═══════════════════════════════════════════════════════════════
 * SINGLE SOURCE OF TRUTH for all scoring algorithms.
 *
 * This module is the canonical implementation. API serverless functions
 * mirror this file via api/_shared/scoring.js.
 *
 * DO NOT duplicate these functions elsewhere.
 * ═══════════════════════════════════════════════════════════════
 */

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type Strategy = 'long' | 'short';

export interface CreditSpreadMetrics {
    credit: number;
    width: number;
    shortDelta: number;
    shortStrike: number;
    currentPrice: number;
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
 * Seller's Edge - Expected value for credit sellers.
 */
export function calculateSellerEdge(pop: number, premium: number): number {
    return pop * premium;
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

// ────────────────────────────────────────────────────────────────
// LOQ Weights & Score
// ────────────────────────────────────────────────────────────────

/** Standard mode weights */
export const LOQ_WEIGHTS = {
    lambda: 0.40,
    gammaEff: 0.30,
    thetaBurn: -0.15,
    deltaBonus: 0.15,
} as const;

/** Day-trade mode weights (DTE ≤ 5) */
export const LOQ_DT_WEIGHTS = {
    lambda: 0.40,
    gammaEff: 0.50,
    thetaBurn: -0.05,
    penaltyMult: 0.2,
} as const;

/**
 * Calculate raw LOQ score.
 *
 * Supports both Standard and Day-Trade mode via `isDayTrade` flag.
 */
export function calculateLOQRaw(
    zLambda: number,
    zGammaEff: number,
    zThetaBurn: number,
    ivAdjustment: number,
    deltaBonus: number = 0,
    thetaBurn: number = 0,
    isDayTrade: boolean = false,
): number {
    const thetaPenalty = getThetaPenalty(thetaBurn);

    if (isDayTrade) {
        return (
            LOQ_DT_WEIGHTS.lambda * zLambda +
            LOQ_DT_WEIGHTS.gammaEff * zGammaEff +
            LOQ_DT_WEIGHTS.thetaBurn * zThetaBurn +
            LOQ_WEIGHTS.deltaBonus * deltaBonus +
            ivAdjustment -
            thetaPenalty * LOQ_DT_WEIGHTS.penaltyMult
        );
    }

    return (
        LOQ_WEIGHTS.lambda * zLambda +
        LOQ_WEIGHTS.gammaEff * zGammaEff +
        LOQ_WEIGHTS.thetaBurn * zThetaBurn +
        LOQ_WEIGHTS.deltaBonus * deltaBonus +
        ivAdjustment -
        thetaPenalty
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
 */
export function calculateCSQRaw(
    zEdge: number,
    zPOP: number,
    zSpread: number,
    ivAdjustment: number,
): number {
    return (
        CSQ_WEIGHTS.edge * zEdge +
        CSQ_WEIGHTS.pop * zPOP +
        CSQ_WEIGHTS.spread * zSpread +
        ivAdjustment
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

// ────────────────────────────────────────────────────────────────
// Single-Position LOQ (Portfolio Use)
// ────────────────────────────────────────────────────────────────

/**
 * Calculate LOQ for a single position without a comparison pool.
 * Uses reference baselines and applies Lambda compression.
 */
export function calculateSingleLOQ(
    delta: number,
    gamma: number,
    theta: number,
    stockPrice: number,
    optionPrice: number,
    ivRatio: number = 1.0,
): number {
    const rawLambda = calculateLambda(delta, stockPrice, optionPrice);
    const compLambda = compressLambda(rawLambda);
    const gammaEff = calculateGammaEfficiency(gamma, optionPrice);
    const thetaBurn = calculateThetaBurn(theta, optionPrice);

    // Reference baselines (no pool available)
    const zLambda = (compLambda - 8) / 4;
    const zGamma = (gammaEff - 0.02) / 0.015;
    const zTheta = (thetaBurn - 0.03) / 0.02;

    const deltaBonus = getDeltaBonus(delta);
    const ivAdjustment = getIVAdjustment(ivRatio, 'long');
    const rawScore = calculateLOQRaw(zLambda, zGamma, zTheta, ivAdjustment, deltaBonus, thetaBurn);

    return normalizeScoreTo100(rawScore);
}

// ────────────────────────────────────────────────────────────────
// Spread Scoring
// ────────────────────────────────────────────────────────────────

/**
 * Credit Spread Score (CSQ+).
 * ROI 40% | POP 40% | Distance 20%.
 */
export function calculateCreditSpreadScore(metrics: CreditSpreadMetrics): number {
    const { credit, width, shortDelta, shortStrike, currentPrice } = metrics;
    const maxRisk = width - credit;
    if (maxRisk <= 0) return 0;

    const roi = (credit / maxRisk) * 100;
    const pop = 1 - Math.abs(shortDelta);
    const distance = currentPrice > 0 ? Math.abs(currentPrice - shortStrike) / currentPrice : 0;

    const scoreROI = Math.min(roi * 4, 100);
    const scorePOP = pop * 100;
    const scoreDistance = Math.min(distance * 1000, 100);

    const finalScore = 0.4 * scoreROI + 0.4 * scorePOP + 0.2 * scoreDistance;
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
