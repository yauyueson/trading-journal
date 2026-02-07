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

// ============================================================
// Global Baselines (v2.2.1 Harmony)
// These ensure consistent scoring across Portfolio and Scanner
// ============================================================
export const BASELINES = {
    long: {
        lambda: { mean: 8, std: 4 },
        gammaEff: { mean: 0.02, std: 0.015 },
        thetaBurn: { mean: 0.03, std: 0.02 }
    },
    short: {
        edge: { mean: 0.8, std: 0.4 },
        pop: { mean: 0.7, std: 0.15 },
        spread: { mean: 0.03, std: 0.03 }
    }
};

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

/**
 * Volatility Risk Premium Factor (IV/RV Ratio)
 * 
 * Logic:
 * - IV/RV > 1.2: Options are expensive (Good for sellers, Bad for buyers)
 * - IV/RV < 0.8: Options are cheap (Good for buyers, Bad for sellers)
 * 
 * Returns adjustment:
 * - Buyers: +1.0 (Cheap) to -1.0 (Expensive)
 * - Sellers: -1.0 (Cheap) to +1.0 (Expensive)
 */
/**
 * Volatility Regime Adjustment (Matrix)
 * 
 * Combines IV Term Structure (IV30/IV90) and IV/RV Ratio (IV30/RV20)
 * to determine the true "value" of options.
 * 
 * Quadrants:
 * 1. Value Zone (Contango + Low VRP): Strong Buy
 * 2. Momentum Zone (Backwardation + Low VRP): Speculative Buy
 * 3. Trap Zone (Contango + High VRP): Avoid/Sell
 * 4. Fear Zone (Backwardation + High VRP): Strong Sell
 */
export function getVolatilityRegimeAdjustment(
    termStructureRatio: number,
    ivRvRatio: number | undefined | null,
    strategy: Strategy
): number {
    // defaults
    const isContango = termStructureRatio < 1.0;
    const isBackwardation = termStructureRatio > 1.05;

    // If IV/RV is missing, fallback to simple Term Structure logic
    if (ivRvRatio === undefined || ivRvRatio === null || isNaN(ivRvRatio)) {
        const simpleRisk = getIVRiskFactor(termStructureRatio);
        return strategy === 'long' ? (1 - simpleRisk) * 5 : (simpleRisk - 1) * 5;
    }

    const isCheap = ivRvRatio < 0.95;
    const isExpensive = ivRvRatio > 1.1;

    let adjustment = 0;

    // --- REGIME LOGIC ---

    // 1. Value Zone (Contango + Low VRP)
    // Options are cheap historically AND cheap vs realized movement.
    // Best time to buy.
    if (isContango && isCheap) {
        adjustment = +2.5;
    }

    // 2. Momentum Zone (Backwardation + Low VRP)
    // Options look expensive (Backwa.) but Realized Vol is huge.
    // Market is moving fast. Buying is okay (chasing momentum).
    else if (isBackwardation && isCheap) {
        adjustment = +1.0;
    }

    // 3. Trap Zone (Contango + High VRP)
    // Options look cheap (Contango) but Price Action is dead (High VRP).
    // Market markers are overpricing options relative to actual movement.
    // "Value Trap" for buyers.
    else if (isContango && isExpensive) {
        adjustment = -2.0;
    }

    // 4. Fear Zone (Backwardation + High VRP)
    // Options are expensive historically AND expensive vs realized.
    // Panic pricing. Best time to sell.
    else if (isBackwardation && isExpensive) {
        adjustment = -3.0;
    }

    // Neutral / Mixed zones
    else {
        // Linear interpolation for the middle ground
        const termScore = (1 - termStructureRatio) * 5; // >0 if Contango
        const vrpScore = (1 - ivRvRatio) * 5;           // >0 if Cheap
        adjustment = (termScore + vrpScore) / 2;
    }

    // Flip for Sellers
    if (strategy === 'short') {
        return -adjustment;
    }

    return adjustment;
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
    ivRvRatio?: number; // Volatility Risk Premium
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
        ivRvRatio?: number;
    } = {}
): { context: ScanContext; results: ScoredResult[] } {

    const {
        dteMin = 20,
        dteMax = 60,
        strikeRangePercent = 0.30,
        minVolume = 50,
        maxSpreadPct = 0.10,
        ivRvRatio
    } = filters;

    // Calculate IV Ratio
    const ivResult = calculateIVRatio(chain, currentPrice);

    // Combine IV Term Structure + IV/RV Ratio into a Regime Score
    const totalIvAdjustment = getVolatilityRegimeAdjustment(ivResult.ivRatio, ivRvRatio, strategy);

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
        scored = processed.map((p, i) => {
            const thetaBurnValue = (p as any).thetaBurn;
            const lambda = (p as any).lambda;
            const gammaEff = (p as any).gammaEff;

            // Use Global Baselines for consistency
            const zLambda = (lambda - BASELINES.long.lambda.mean) / BASELINES.long.lambda.std;
            const zGamma = (gammaEff - BASELINES.long.gammaEff.mean) / BASELINES.long.gammaEff.std;
            const zTheta = (thetaBurnValue - BASELINES.long.thetaBurn.mean) / BASELINES.long.thetaBurn.std;

            // Deal Breaker: Spread > 15% = Score 0
            if (p.spreadPct > 0.15) {
                return {
                    symbol: p.opt.symbol,
                    strike: p.opt.strike, // ... fill rest with dummy or existing
                    type: p.opt.type,
                    expiration: p.opt.expiration,
                    dte: p.opt.dte,
                    price: p.mid,
                    score: 0, // KILLED
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
            }

            const deltaBonus = getDeltaBonus(p.opt.delta);
            const rawScore = calculateLOQRaw(zLambda, zGamma, zTheta, totalIvAdjustment, deltaBonus, thetaBurnValue);
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
        scored = processed.map((p, i) => {
            const edge = (p as any).edge;
            const pop = (p as any).pop;
            const spread = p.spreadPct;

            // Use Global Baselines
            const zEdge = (edge - BASELINES.short.edge.mean) / BASELINES.short.edge.std;
            const zPop = (pop - BASELINES.short.pop.mean) / BASELINES.short.pop.std;
            const zSpread = (spread - BASELINES.short.spread.mean) / BASELINES.short.spread.std;

            // Deal Breaker: Spread > 15% = Score 0
            if (p.spreadPct > 0.15) {
                return {
                    symbol: p.opt.symbol,
                    strike: p.opt.strike,
                    type: p.opt.type,
                    expiration: p.opt.expiration,
                    dte: p.opt.dte,
                    price: p.mid,
                    score: 0,
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
            }

            const rawScore = calculateCSQRaw(zEdge, zPop, zSpread, totalIvAdjustment);
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
            ivRvRatio: filters.ivRvRatio,
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
    const zLambda = (lambda - BASELINES.long.lambda.mean) / BASELINES.long.lambda.std;
    const zGamma = (gammaEff - BASELINES.long.gammaEff.mean) / BASELINES.long.gammaEff.std;
    const zTheta = (thetaBurn - BASELINES.long.thetaBurn.mean) / BASELINES.long.thetaBurn.std;

    const deltaBonus = getDeltaBonus(delta);
    const totalIvAdjustment = getVolatilityRegimeAdjustment(ivRatio, 1.0, 'long');
    const rawScore = calculateLOQRaw(zLambda, zGamma, zTheta, totalIvAdjustment, deltaBonus, thetaBurn);

    return normalizeScoreTo100(rawScore);
}
// ============================================================
// SPREAD SCORING (Ported from Strategy Recommender)
// ============================================================

const compressLambda = (lambda: number): number => {
    const threshold = 20;
    const decayRate = 0.1;
    if (lambda <= threshold) return lambda;
    return threshold + (lambda - threshold) * decayRate;
};

export interface CreditSpreadMetrics {
    credit: number;
    width: number;
    shortDelta: number;
    shortStrike: number;
    currentPrice: number;
    ivAdjustment?: number;
}

export function calculateCreditSpreadScore(metrics: CreditSpreadMetrics): number {
    const { credit, width, shortDelta, shortStrike, currentPrice } = metrics;
    const maxRisk = width - credit;
    if (maxRisk <= 0) return 0;

    const roi = (credit / maxRisk) * 100;
    const pop = 1 - Math.abs(shortDelta);
    const distance = Math.abs(currentPrice - shortStrike) / currentPrice;

    // Score components
    const scoreROI = Math.min(roi * 4, 100);             // 25% ROI = 100 pts
    const scorePOP = pop * 100;                          // 100% POP = 100 pts
    const scoreDistance = Math.min(distance * 1000, 100); // 10% OTM = 100 pts

    const finalScore = 0.4 * scoreROI + 0.4 * scorePOP + 0.2 * scoreDistance + (metrics.ivAdjustment || 0);
    return Math.round(Math.min(100, Math.max(0, finalScore)));
}

export interface DebitSpreadMetrics {
    debit: number;
    width: number;
    longDelta: number;
    longPrice: number;
    currentPrice: number;
    ivAdjustment?: number;
}

export function calculateDebitSpreadScore(metrics: DebitSpreadMetrics): number {
    const { debit, width, longDelta, longPrice, currentPrice } = metrics;
    const maxProfit = width - debit;
    if (debit <= 0) return 0;

    const riskReward = maxProfit / debit;

    // Lambda (Leverage)
    // Note: Use longPrice as 'mid' approximation if mid not available
    const lambda = longPrice > 0 ? Math.abs(longDelta) * (currentPrice / longPrice) : 0;
    const compLambda = compressLambda(lambda);

    // Delta Bonus
    const deltaBonus = getDeltaBonus(longDelta);

    // Score components
    const lambdaScore = Math.min((compLambda / 20) * 100, 100); // Lambda 20 = 100 pts
    const rrScore = Math.min((riskReward / 3) * 100, 100);      // 1:3 R:R = 100 pts
    const deltaScore = 50 + deltaBonus * 12.5;

    const finalScore = 0.4 * lambdaScore + 0.35 * rrScore + 0.25 * deltaScore + (metrics.ivAdjustment || 0);
    return Math.round(Math.min(100, Math.max(0, finalScore)));
}
