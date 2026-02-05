/**
 * Options Scoring System (OSS) - Core Algorithms
 * Version: 2.1 (Hybrid Scoring / IV Optimized)
 * 
 * Implements:
 * - 4-Card Method for IV Term Structure
 * - LOQ (Long Option Quality) for buyers
 * - CSQ (Credit Spread Quality) for sellers
 */

// ============================================================
// Types
// ============================================================

export interface OptionData {
    symbol: string;
    strike: number;
    type: 'Call' | 'Put';
    expiration: string;
    dte: number;
    bid: number;
    ask: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    iv: number;
    volume: number;
    openInterest: number;
}

export interface RawMetrics {
    lambda: number;
    gammaEfficiency: number;
    thetaBurn: number;
}

export interface SellerMetrics {
    pop: number;        // Probability of Profit
    edge: number;       // Seller's Edge
    spreadPct: number;  // Bid-Ask Spread %
}

export interface ScoredOption {
    option: OptionData;
    metrics: RawMetrics | SellerMetrics;
    zScores: Record<string, number>;
    score: number;
}

export type Strategy = 'long' | 'short';

// ============================================================
// Raw Metric Calculations
// ============================================================

/**
 * Lambda (Λ) - True Leverage Ratio
 * Formula: Lambda = |Delta| × (Stock Price / Option Price)
 * High Lambda = High leverage, small capital controls large exposure
 */
export function calculateLambda(delta: number, stockPrice: number, optionPrice: number): number {
    if (optionPrice <= 0) return 0;
    return Math.abs(delta) * (stockPrice / optionPrice);
}

/**
 * Gamma Efficiency (Γeff) - Explosiveness per dollar
 * Formula: Gamma / Option Price
 * High = Delta accelerates quickly on favorable moves
 */
export function calculateGammaEfficiency(gamma: number, optionPrice: number): number {
    if (optionPrice <= 0) return 0;
    return gamma / optionPrice;
}

/**
 * Theta Burn (TB) - Daily time decay rate
 * Formula: |Theta| / Option Price
 * Lower is better for buyers (less daily bleed)
 */
export function calculateThetaBurn(theta: number, optionPrice: number): number {
    if (optionPrice <= 0) return 0;
    return Math.abs(theta) / optionPrice;
}

/**
 * Theta Pain Curve - 指数型惩罚 (Exponential Penalty)
 * 
 * 设计理念：
 * - 安全区 (≤0.5%/天): 零惩罚，对 LEAPS 友好
 * - 超出安全区: 惩罚呈二次增长
 * - 封顶 50 分，防止极端值炸穿评分
 * 
 * 示例：
 * - 0.3%/天 → 0 (安全)
 * - 1.0%/天 → 0.125 分
 * - 3.0%/天 → 3.125 分
 * - 6.0%/天 → 15.125 分 (剧痛)
 */
export function getThetaPenalty(thetaBurn: number): number {
    const SAFE_ZONE = 0.005; // 0.5% daily decay is acceptable

    if (thetaBurn <= SAFE_ZONE) {
        return 0;
    }

    const excess = thetaBurn - SAFE_ZONE;
    const penalty = Math.pow(excess * 100, 2) * 0.5;

    return Math.min(penalty, 50); // Cap at 50 to prevent score explosion
}

/**
 * Probability of Profit (POP) - For sellers
 * Approximation: 1 - |Delta|
 */
export function calculatePOP(delta: number): number {
    return 1 - Math.abs(delta);
}

/**
 * Seller's Edge - Expected value for credit sellers
 * Formula: POP × Premium Received
 */
export function calculateSellerEdge(pop: number, premium: number): number {
    return pop * premium;
}

/**
 * Spread Percentage - Liquidity measure
 * Formula: (Ask - Bid) / Mid
 */
export function calculateSpreadPct(bid: number, ask: number): number {
    const mid = (bid + ask) / 2;
    if (mid <= 0) return 1; // 100% spread = illiquid
    return (ask - bid) / mid;
}

// ============================================================
// Z-Score Normalization
// ============================================================

/**
 * Calculate mean of array
 */
function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Calculate standard deviation
 */
function stdDev(values: number[]): number {
    if (values.length < 2) return 1; // Avoid division by zero
    const avg = mean(values);
    const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
    return Math.sqrt(mean(squaredDiffs)) || 1;
}

/**
 * Normalize array values to Z-Scores
 * Z = (x - mean) / stdDev
 */
export function normalizeToZScores(values: number[]): number[] {
    const avg = mean(values);
    const std = stdDev(values);
    return values.map(v => (v - avg) / std);
}

// ============================================================
// IV Term Structure: 4-Card Method
// ============================================================

interface IVTermResult {
    ivRatio: number;
    iv30: number | null;
    iv90: number | null;
    status: 'contango' | 'neutral' | 'backwardation';
}

/**
 * Find ATM IV for a target DTE using 2-card interpolation
 * Looks for the two strikes bracketing current price
 */
function getATMIV(
    chain: OptionData[],
    currentPrice: number,
    targetDTE: number,
    tolerance: number = 10
): number | null {
    // Filter calls near target DTE
    const candidates = chain.filter(
        opt => opt.type === 'Call' && Math.abs(opt.dte - targetDTE) <= tolerance
    );

    if (candidates.length < 2) return null;

    // Sort by strike
    candidates.sort((a, b) => a.strike - b.strike);

    // Find strikes bracketing current price
    for (let i = 0; i < candidates.length - 1; i++) {
        if (candidates[i].strike <= currentPrice && candidates[i + 1].strike >= currentPrice) {
            return (candidates[i].iv + candidates[i + 1].iv) / 2;
        }
    }

    // Fallback: use closest strike
    const closest = candidates.reduce((prev, curr) =>
        Math.abs(curr.strike - currentPrice) < Math.abs(prev.strike - currentPrice) ? curr : prev
    );
    return closest.iv;
}

/**
 * Calculate IV Term Structure Ratio using 4-Card Method
 * Ratio = IV_30d / IV_90d
 */
export function calculateIVRatio(chain: OptionData[], currentPrice: number): IVTermResult {
    const iv30 = getATMIV(chain, currentPrice, 30);
    const iv90 = getATMIV(chain, currentPrice, 90);

    // Default to neutral if data unavailable
    if (!iv30 || !iv90 || iv90 === 0) {
        return { ivRatio: 1.0, iv30, iv90, status: 'neutral' };
    }

    const ratio = iv30 / iv90;

    let status: 'contango' | 'neutral' | 'backwardation';
    if (ratio < 0.95) {
        status = 'contango';
    } else if (ratio > 1.05) {
        status = 'backwardation';
    } else {
        status = 'neutral';
    }

    return { ivRatio: ratio, iv30, iv90, status };
}

// ============================================================
// IV Adjustment (Absolute Threshold)
// ============================================================

/**
 * Get IV penalty/bonus based on absolute thresholds (Thermometer)
 * 
 * For Buyers (LOQ):
 *   < 0.95 (Contango): +0.5 bonus
 *   0.95-1.05: -1.0 penalty
 *   > 1.10: -3.0 penalty (danger zone)
 * 
 * For Sellers (CSQ):
 *   > 1.05: +2.0 bonus (panic premium)
 *   < 0.90: -1.0 penalty
 *   else: 0
 */
export function getIVAdjustment(ivRatio: number, strategy: Strategy): number {
    const riskFactor = getIVRiskFactor(ivRatio);

    if (strategy === 'long') {
        // 安全时(riskFactor=0.9)加分，危险时(riskFactor=1.3)减分
        // Range: +0.5 (contango) to -1.5 (backwardation)
        return (1 - riskFactor) * 5;
    } else {
        // Seller: 危险时加分（卖高IV），安全时中性
        // Range: -0.5 (contango) to +1.5 (backwardation)
        return (riskFactor - 1) * 5;
    }
}

/**
 * IV Risk Factor - Sigmoid 相变模型 (Phase Transition)
 * 
 * 设计理念：
 * - 市场情绪在"冷静"和"恐慌"之间突变
 * - Sigmoid 函数模拟这种相变
 * - k=12 提供平滑但明确的过渡
 * - x0=1.10 作为临界点
 * 
 * 返回值：
 * - ~0.9 = 安全 (Contango, ratio < 1.0)
 * - ~1.0 = 中性 (ratio ≈ 1.05)
 * - ~1.3 = 危险 (Backwardation, ratio > 1.15)
 */
export function getIVRiskFactor(ratio: number): number {
    const k = 12;     // Steepness (12 = gradual transition)
    const x0 = 1.10;  // Critical point

    const raw = 1 / (1 + Math.exp(-k * (ratio - x0)));

    // Map to 0.9 - 1.3 multiplier range
    return 0.9 + raw * 0.4;
}

// ============================================================
// LOQ Score (Long Option Quality)
// ============================================================

// STABLE VERSION: Weights adjusted to reduce OTM bias
const LOQ_WEIGHTS = {
    lambda: 0.40,      // Reduced from 0.45
    gammaEff: 0.30,    // Reduced from 0.35
    thetaBurn: -0.15,  // Reduced penalty from -0.20
    deltaBonus: 0.15   // NEW: Reward ATM, penalize lottery
};

/**
 * Delta Bonus: Reward ATM options, penalize lottery tickets
 * |Δ| < 0.15  → -2.0  (Lottery ticket penalty)
 * |Δ| 0.15-0.30 → -0.5  (Aggressive zone mild penalty)
 * |Δ| 0.30-0.50 → +1.0  (Sweet spot bonus)
 * |Δ| 0.50-0.70 → +0.5  (Stable zone bonus)
 * |Δ| > 0.70  → 0     (Deep ITM neutral)
 */
export function getDeltaBonus(delta: number): number {
    const absDelta = Math.abs(delta);
    if (absDelta < 0.15) return -2.0;
    if (absDelta < 0.30) return -0.5;
    if (absDelta <= 0.50) return 1.0;
    if (absDelta <= 0.70) return 0.5;
    return 0;
}

/**
 * Calculate LOQ score for a single option (STABLE VERSION)
 * 
 * Formula: 0.40×z(Λ) + 0.30×z(Γeff) - 0.15×z(TB) + 0.15×ΔBonus + IV_Adjustment - ThetaPainPenalty
 * 
 * Returns raw Z-weighted score (can be negative)
 */
export function calculateLOQRaw(
    zLambda: number,
    zGammaEff: number,
    zThetaBurn: number,
    ivAdjustment: number,
    deltaBonus: number = 0,
    thetaBurn: number = 0  // Raw theta burn for pain curve
): number {
    const thetaPenalty = getThetaPenalty(thetaBurn);

    return (
        LOQ_WEIGHTS.lambda * zLambda +
        LOQ_WEIGHTS.gammaEff * zGammaEff +
        LOQ_WEIGHTS.thetaBurn * zThetaBurn +
        LOQ_WEIGHTS.deltaBonus * deltaBonus +
        ivAdjustment -
        thetaPenalty  // Exponential pain penalty for short-dated options
    );
}

/**
 * Convert raw score to 0-100 scale
 * Uses sigmoid-like transformation
 */
export function normalizeScoreTo100(rawScore: number): number {
    // Map typical range [-4, 4] to [0, 100]
    // Using: score = 50 + (rawScore × 12.5), clamped
    const scaled = 50 + rawScore * 12.5;
    return Math.max(0, Math.min(100, Math.round(scaled)));
}

// ============================================================
// CSQ Score (Credit Spread Quality)
// ============================================================

const CSQ_WEIGHTS = {
    edge: 0.50,
    pop: 0.30,
    spread: -0.20  // Negative because lower spread is better
};

/**
 * Calculate CSQ score for a single option
 * 
 * Formula: 0.50×z(Edge) + 0.30×z(POP) - 0.20×z(Spread) + IV_Adjustment
 */
export function calculateCSQRaw(
    zEdge: number,
    zPOP: number,
    zSpread: number,
    ivAdjustment: number
): number {
    return (
        CSQ_WEIGHTS.edge * zEdge +
        CSQ_WEIGHTS.pop * zPOP +
        CSQ_WEIGHTS.spread * zSpread +
        ivAdjustment
    );
}

// ============================================================
// Batch Scoring
// ============================================================

export interface ScanContext {
    ticker: string;
    currentPrice: number;
    ivRatio: number;
    ivStatus: 'contango' | 'neutral' | 'backwardation';
    strategy: Strategy;
}

export interface ScoredResult {
    symbol: string;
    strike: number;
    type: 'Call' | 'Put';
    expiration: string;
    dte: number;
    price: number;
    score: number;
    metrics: {
        lambda?: number;
        gammaEff?: number;
        thetaBurn?: number;
        pop?: number;
        edge?: number;
        spreadPct: number;
    };
    greeks: {
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        iv: number;
    };
    liquidity: {
        volume: number;
        openInterest: number;
        bid: number;
        ask: number;
    };
}

/**
 * Score all options in a chain for a given strategy
 * Applies hard filters, calculates metrics, Z-scores, and final scores
 */
export function scoreOptionsChain(
    chain: OptionData[],
    currentPrice: number,
    strategy: Strategy,
    filters: {
        dteMin?: number;
        dteMax?: number;
        strikeRangePercent?: number;
        minVolume?: number;
        maxSpreadPct?: number;
    } = {}
): { context: ScanContext; results: ScoredResult[] } {

    const {
        dteMin = 20,
        dteMax = 60,
        strikeRangePercent = 0.30,
        minVolume = 50,
        maxSpreadPct = 0.10
    } = filters;

    // Calculate IV Ratio
    const ivResult = calculateIVRatio(chain, currentPrice);
    const ivAdjustment = getIVAdjustment(ivResult.ivRatio, strategy);

    // Hard filters
    const minStrike = currentPrice * (1 - strikeRangePercent);
    const maxStrike = currentPrice * (1 + strikeRangePercent);

    const filtered = chain.filter(opt => {
        const mid = (opt.bid + opt.ask) / 2;
        const spreadPct = calculateSpreadPct(opt.bid, opt.ask);

        return (
            opt.dte >= dteMin &&
            opt.dte <= dteMax &&
            opt.strike >= minStrike &&
            opt.strike <= maxStrike &&
            opt.volume >= minVolume &&
            spreadPct <= maxSpreadPct &&
            mid > 0
        );
    });

    if (filtered.length === 0) {
        return {
            context: {
                ticker: '',
                currentPrice,
                ivRatio: ivResult.ivRatio,
                ivStatus: ivResult.status,
                strategy
            },
            results: []
        };
    }

    // Calculate raw metrics
    const processed = filtered.map(opt => {
        const mid = (opt.bid + opt.ask) / 2;
        const spreadPct = calculateSpreadPct(opt.bid, opt.ask);

        if (strategy === 'long') {
            return {
                opt,
                mid,
                spreadPct,
                lambda: calculateLambda(opt.delta, currentPrice, mid),
                gammaEff: calculateGammaEfficiency(opt.gamma, mid),
                thetaBurn: calculateThetaBurn(opt.theta, mid)
            };
        } else {
            const pop = calculatePOP(opt.delta);
            return {
                opt,
                mid,
                spreadPct,
                pop,
                edge: calculateSellerEdge(pop, mid),
            };
        }
    });

    // Z-Score normalization
    let scored: ScoredResult[];

    if (strategy === 'long') {
        const lambdas = processed.map(p => (p as any).lambda);
        const gammas = processed.map(p => (p as any).gammaEff);
        const thetas = processed.map(p => (p as any).thetaBurn);

        const zLambdas = normalizeToZScores(lambdas);
        const zGammas = normalizeToZScores(gammas);
        const zThetas = normalizeToZScores(thetas);

        scored = processed.map((p, i) => {
            const thetaBurnValue = (p as any).thetaBurn;
            const rawScore = calculateLOQRaw(zLambdas[i], zGammas[i], zThetas[i], ivAdjustment, 0, thetaBurnValue);
            const score = normalizeScoreTo100(rawScore);

            return {
                symbol: p.opt.symbol,
                strike: p.opt.strike,
                type: p.opt.type,
                expiration: p.opt.expiration,
                dte: p.opt.dte,
                price: p.mid,
                score,
                metrics: {
                    lambda: (p as any).lambda,
                    gammaEff: (p as any).gammaEff,
                    thetaBurn: (p as any).thetaBurn,
                    spreadPct: p.spreadPct
                },
                greeks: {
                    delta: p.opt.delta,
                    gamma: p.opt.gamma,
                    theta: p.opt.theta,
                    vega: p.opt.vega,
                    iv: p.opt.iv
                },
                liquidity: {
                    volume: p.opt.volume,
                    openInterest: p.opt.openInterest,
                    bid: p.opt.bid,
                    ask: p.opt.ask
                }
            };
        });
    } else {
        // Seller strategy
        const edges = processed.map(p => (p as any).edge);
        const pops = processed.map(p => (p as any).pop);
        const spreads = processed.map(p => p.spreadPct);

        const zEdges = normalizeToZScores(edges);
        const zPops = normalizeToZScores(pops);
        const zSpreads = normalizeToZScores(spreads);

        scored = processed.map((p, i) => {
            const rawScore = calculateCSQRaw(zEdges[i], zPops[i], zSpreads[i], ivAdjustment);
            const score = normalizeScoreTo100(rawScore);

            return {
                symbol: p.opt.symbol,
                strike: p.opt.strike,
                type: p.opt.type,
                expiration: p.opt.expiration,
                dte: p.opt.dte,
                price: p.mid,
                score,
                metrics: {
                    pop: (p as any).pop,
                    edge: (p as any).edge,
                    spreadPct: p.spreadPct
                },
                greeks: {
                    delta: p.opt.delta,
                    gamma: p.opt.gamma,
                    theta: p.opt.theta,
                    vega: p.opt.vega,
                    iv: p.opt.iv
                },
                liquidity: {
                    volume: p.opt.volume,
                    openInterest: p.opt.openInterest,
                    bid: p.opt.bid,
                    ask: p.opt.ask
                }
            };
        });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return {
        context: {
            ticker: filtered[0]?.symbol?.slice(0, 6).trim() || '',
            currentPrice,
            ivRatio: ivResult.ivRatio,
            ivStatus: ivResult.status,
            strategy
        },
        results: scored
    };
}

/**
 * Calculate LOQ score for a single position (Portfolio use)
 * Used when we don't have a full chain for comparison
 */
export function calculateSingleLOQ(
    delta: number,
    gamma: number,
    theta: number,
    stockPrice: number,
    optionPrice: number,
    ivRatio: number = 1.0
): number {
    const lambda = calculateLambda(delta, stockPrice, optionPrice);
    const gammaEff = calculateGammaEfficiency(gamma, optionPrice);
    const thetaBurn = calculateThetaBurn(theta, optionPrice);

    // Without a pool, we use reference baselines
    // Good Lambda: 5-15, Good GammaEff: 0.01-0.05, Good ThetaBurn: 0-0.05
    const zLambda = (lambda - 8) / 4;  // Baseline: 8, std: 4
    const zGamma = (gammaEff - 0.02) / 0.015;
    const zTheta = (thetaBurn - 0.03) / 0.02;

    const ivAdjustment = getIVAdjustment(ivRatio, 'long');
    const rawScore = calculateLOQRaw(zLambda, zGamma, zTheta, ivAdjustment, 0, thetaBurn);

    return normalizeScoreTo100(rawScore);
}
