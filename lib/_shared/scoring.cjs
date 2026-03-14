/**
 * OSS Core - Options Scoring System v2.3 (API Mirror)
 * ═══════════════════════════════════════════════════════════════
 * MIRROR of src/lib/oss-core.ts for Vercel Serverless Functions.
 *
 * Keep in sync with the canonical TypeScript source.
 *
 * v2.2 Changes:
 * - NEW: Gamma/Theta Ratio (G/T) — "cost of gamma" metric for LOQ
 * - LOQ weights redistributed to accommodate G/T dimension
 * - Day-trade weights updated (G/T emphasized for intraday)
 * ═══════════════════════════════════════════════════════════════
 */

// ────────────────────────────────────────────────────────────────
// Math Primitives
// ────────────────────────────────────────────────────────────────

const lerp = (x, x1, x2, y1, y2) => {
    if (x2 === x1) return (y1 + y2) / 2;
    return y1 + (y2 - y1) * ((x - x1) / (x2 - x1));
};

const sigmoidFn = (x) => {
    const clamped = Math.max(-50, Math.min(50, x));
    return 1 / (1 + Math.exp(-clamped));
};

// ────────────────────────────────────────────────────────────────
// Lambda Compression
// ────────────────────────────────────────────────────────────────

const compressLambda = (lambda) => {
    // Use log2 compression to prevent extreme lambda values from dominating z-scores
    // lambda=1 → 1.0, lambda=20 → 4.4, lambda=100 → 6.7, lambda=500 → 9.0
    const MIN_LAMBDA = 1;
    const clamped = Math.max(MIN_LAMBDA, lambda);
    return Math.log2(1 + clamped);
};

// ────────────────────────────────────────────────────────────────
// Theta Pain Curve (cap at 10 — v2.1)
// ────────────────────────────────────────────────────────────────

const getThetaPenalty = (thetaBurn) => {
    const SAFE_ZONE = 0.005;
    if (thetaBurn <= SAFE_ZONE) return 0;
    const excess = thetaBurn - SAFE_ZONE;
    return Math.min(Math.pow(excess * 100, 2) * 0.5, 10);
};

// ────────────────────────────────────────────────────────────────
// Breakeven Move & Penalty (v2.2)
// ────────────────────────────────────────────────────────────────

const calculateBreakevenMove = (strike, premium, stockPrice, optionType) => {
    if (stockPrice <= 0) return 1;
    const breakeven = optionType === 'Call' ? strike + premium : strike - premium;
    return Math.abs(breakeven - stockPrice) / stockPrice;
};

const getBreakevenPenalty = (breakevenMove, dte) => {
    const dteFactor = dte > 0 ? Math.sqrt(dte / 30) : 1;
    const adjusted = breakevenMove / dteFactor;

    if (adjusted <= 0.02) return 0.5;
    if (adjusted <= 0.05) return lerp(adjusted, 0.02, 0.05, 0.5, 0);
    if (adjusted <= 0.10) return lerp(adjusted, 0.05, 0.10, 0, -1.0);
    if (adjusted <= 0.20) return lerp(adjusted, 0.10, 0.20, -1.0, -2.0);
    return -2.0;
};

// ────────────────────────────────────────────────────────────────
// Volatility Skew (v2.3)
// ────────────────────────────────────────────────────────────────

const calculateSkew = (chain, currentPrice, targetDTE = 30) => {
    // Skew = (25d Put IV - 25d Call IV) / avg(Put IV, Call IV)
    // Equity skew standard: 25-delta OTM puts vs 25-delta OTM calls at the same expiration.
    // Uses layered tolerance search [0.08, 0.15] to find closest-to-0.25-delta options.
    // targetDTE should match the strategy expiration (passed from caller, not hardcoded).
    const targetChain = chain.filter(o => Math.abs(o.dte - targetDTE) < 15); // ±14 DTE window
    if (targetChain.length < 6) return 0;

    // Layered search: try tight tolerance first, then widen if no match
    for (const tolerance of [0.08, 0.15]) {
        const puts = targetChain.filter(o => o.type === 'Put' && Math.abs(o.delta + 0.25) < tolerance);
        const calls = targetChain.filter(o => o.type === 'Call' && Math.abs(o.delta - 0.25) < tolerance);

        if (puts.length > 0 && calls.length > 0) {
            // Find closest to target delta
            const put = puts.reduce((a, b) => Math.abs(b.delta + 0.25) < Math.abs(a.delta + 0.25) ? b : a);
            const call = calls.reduce((a, b) => Math.abs(b.delta - 0.25) < Math.abs(a.delta - 0.25) ? b : a);

            if (put.iv > 0 && call.iv > 0) {
                return (put.iv - call.iv) / ((put.iv + call.iv) / 2);
            }
        }
    }

    return 0;
};

// ────────────────────────────────────────────────────────────────
// Slippage Modeling (v2.4 — OI/volume adjusted)
// ────────────────────────────────────────────────────────────────

/**
 * Estimate fill slippage for a single option leg.
 *
 * Base slippage = 10% of bid/ask spread (conservative mid-fill assumption).
 * Liquidity multiplier penalizes illiquid options: even a tight quoted spread
 * carries higher effective slippage when OI is thin.
 *
 * liquidityMultiplier = clamp(1 + √(500/OI), 1.0, 2.5)
 *   OI ≥ 500  → multiplier ≤ 2.0   (moderate penalty)
 *   OI = 1000 → 1 + √0.5 ≈ 1.71
 *   OI = 5000 → 1 + √0.1 ≈ 1.32
 *   OI ≥ 10000 → ≈ 1.22 (near 1, well-covered)
 *
 * @param {number} bid
 * @param {number} ask
 * @param {number} [openInterest] - Option open interest (optional; defaults to no OI penalty)
 * @returns {number} Estimated slippage in dollars
 */
const estimateSlippage = (bid, ask, openInterest = null) => {
    const spread = ask - bid;
    const baseSlippage = spread * 0.10;
    if (openInterest == null || openInterest <= 0) return baseSlippage;
    const liquidityMultiplier = Math.min(2.5, Math.max(1.0, 1 + Math.sqrt(500 / openInterest)));
    return baseSlippage * liquidityMultiplier;
};

// ────────────────────────────────────────────────────────────────
// Gamma Risk (v2.3)
// ────────────────────────────────────────────────────────────────

/**
 * Gamma Risk Penalty (v2.4 - Enhanced)
 * Penalizes high gamma exposure on short-dated options.
 * Now uses actual gamma value relative to position size.
 * @param {number} gamma Gamma value
 * @param {number} theta Theta value (unused but kept for API compatibility)
 * @param {number} dte Days to expiration
 * @param {number} spotPrice Underlying price (optional, for normalization)
 * @param {number} mid Option mid price (optional, for normalization)
 * @returns {number} Penalty score (0 to -30)
 */
const getGammaRiskPenalty = (gamma, theta, dte, spotPrice = null, mid = null) => {
    if (dte > 14) return 0; // Only punitive for < 14 DTE

    // If spot and mid provided, use normalized gamma exposure
    if (spotPrice != null && mid != null && mid > 0) {
        // Dollar gamma per $1 premium: higher = more explosion risk
        const gammaExposure = (gamma * spotPrice) / mid;

        // DTE-based thresholds
        if (dte <= 5) {
            // Very short DTE: penalize if gamma exposure > 0.5
            if (gammaExposure > 1.0) return -30;
            if (gammaExposure > 0.5) return -20;
            return -10; // Base penalty for < 5 DTE
        }
        if (dte <= 10) {
            if (gammaExposure > 1.5) return -15;
            if (gammaExposure > 0.8) return -8;
            return 0;
        }
        // 11-14 DTE: mild penalty only if extreme gamma
        if (gammaExposure > 2.0) return -5;
        return 0;
    }

    // Fallback: DTE-only logic (legacy behavior)
    if (dte <= 5) return -25;
    if (dte <= 10) return -10;
    return 0;
};

// ────────────────────────────────────────────────────────────────
// Dollar Gamma (v2.8 — price-independent gamma exposure)
// ────────────────────────────────────────────────────────────────

/**
 * Dollar Gamma = γ × S² / 100
 * Industry standard. Unlike gammaEff = γ/price, eliminates ~0.8 correlation with Lambda.
 */
const calculateDollarGamma = (gamma, currentPrice) => {
    return gamma * currentPrice * currentPrice / 100;
};

// ────────────────────────────────────────────────────────────────
// Gamma/Theta Ratio (v2.2 — cost of gamma)
// ────────────────────────────────────────────────────────────────

const calculateGammaThetaRatio = (gamma, theta) => {
    const absTheta = Math.abs(theta);
    if (absTheta < 0.001) return gamma > 0 ? 5 : 0;
    const raw = gamma / absTheta;
    const THRESHOLD = 5;
    const DECAY_RATE = 0.1;
    if (raw <= THRESHOLD) return raw;
    return THRESHOLD + (raw - THRESHOLD) * DECAY_RATE;
};

// ────────────────────────────────────────────────────────────────
// Delta Bonus (LERP v2.1)
// ────────────────────────────────────────────────────────────────

const getDeltaBonus = (delta) => {
    const absDelta = Math.abs(delta);
    if (absDelta < 0.15) return -2.0;
    if (absDelta < 0.30) return lerp(absDelta, 0.15, 0.30, -2.0, -0.5);
    if (absDelta < 0.50) return lerp(absDelta, 0.30, 0.50, -0.5, 1.0);
    if (absDelta < 0.70) return lerp(absDelta, 0.50, 0.70, 1.0, 0.5);
    if (absDelta <= 1.0) return lerp(absDelta, 0.70, 1.0, 0.5, 0);
    return 0;
};

// ────────────────────────────────────────────────────────────────
// Z-Score Normalization
// ────────────────────────────────────────────────────────────────

const zScores = (values) => {
    const n = values.length;
    if (n < 2) return values.map(() => 0);
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1;
    return values.map((v) => (v - mean) / std);
};

// ────────────────────────────────────────────────────────────────
// Hard Filter Defaults & DTE Buckets
// ────────────────────────────────────────────────────────────────

const HARD_FILTER_DEFAULTS = {
    minMid: 0.10,
    minOpenInterest: 50,
    maxSpreadPctCeiling: 0.35,
};

// Stricter tier for credit spreads — sellers need tighter fills
const HARD_FILTER_CREDIT = {
    minMid: 0.10,
    minOpenInterest: 50,
    maxSpreadPctCeiling: 0.30,
};

const DTE_BUCKETS = [
    { label: '0-7', min: 0, max: 7 },
    { label: '8-14', min: 8, max: 14 },
    { label: '15-30', min: 15, max: 30 },
    { label: '31-60', min: 31, max: 60 },
    { label: '61-120', min: 61, max: 120 },
    { label: '121+', min: 121, max: Infinity },
];

// Z-scores from fewer than 8 samples have chi-squared df<7 variance — effectively noise.
// Thin buckets (0-7 DTE, 121+) fall back to pool-wide stats, which is the correct behavior.
const MIN_BUCKET_SIZE = 8;

const zScoresByBucket = (values, dtes, minBucketSize = MIN_BUCKET_SIZE) => {
    const n = values.length;
    if (n < 2) return values.map(() => 0);

    const poolMean = values.reduce((s, v) => s + v, 0) / n;
    const poolStd = Math.sqrt(values.reduce((s, v) => s + (v - poolMean) ** 2, 0) / n) || 1;

    const bucketIndex = dtes.map((dte) => {
        for (let b = 0; b < DTE_BUCKETS.length; b++) {
            if (dte >= DTE_BUCKETS[b].min && dte <= DTE_BUCKETS[b].max) return b;
        }
        return DTE_BUCKETS.length - 1;
    });

    const bucketStats = new Map();
    for (let b = 0; b < DTE_BUCKETS.length; b++) {
        const indices = [];
        for (let i = 0; i < n; i++) {
            if (bucketIndex[i] === b) indices.push(i);
        }
        if (indices.length >= minBucketSize) {
            const bMean = indices.reduce((s, idx) => s + values[idx], 0) / indices.length;
            const bStd = Math.sqrt(indices.reduce((s, idx) => s + (values[idx] - bMean) ** 2, 0) / indices.length) || 1;
            bucketStats.set(b, { mean: bMean, std: bStd });
        }
    }

    return values.map((v, i) => {
        const stats = bucketStats.get(bucketIndex[i]);
        const mean = stats ? stats.mean : poolMean;
        const std = stats ? stats.std : poolStd;
        return (v - mean) / std;
    });
};

// ────────────────────────────────────────────────────────────────
// IV Risk Factor & Adjustment
// ────────────────────────────────────────────────────────────────

const getIVRiskFactor = (ratio) => {
    const clamped = Math.max(0.5, Math.min(2.0, ratio));
    const k = 8;
    const x0 = 1.00;
    const raw = sigmoidFn(k * (clamped - x0));
    return 0.9 + raw * 0.4;
};

const getIVAdjustment = (ivRatio, strategy) => {
    const riskFactor = getIVRiskFactor(ivRatio);
    if (strategy === 'long') {
        return (1 - riskFactor) * 5;
    }
    return (riskFactor - 1) * 5;
};

const getIVRankAdjustment = (ivRank, strategy, sampleDays = 180) => {
    if (ivRank == null || ivRank < 0 || ivRank > 1) return 0;
    const confidence = Math.min(1, Math.sqrt(sampleDays / 180));
    // Continuous sigmoid: center at 0.5, smooth ramp ±0.5
    const centered = ivRank - 0.5;
    const sigmoid = centered / (Math.abs(centered) + 0.15);
    const magnitude = sigmoid * 0.5 / (0.5 / (0.5 + 0.15));
    const raw = strategy === 'long' ? -magnitude : magnitude;
    return raw * confidence;
};

/**
 * Vol Forecast Adjustment — forward-looking edge from ORATS (v3.0).
 * Compares ORATS 20d vol forecast to current IV30.
 * Scaled by forecast R² quality. Returns 0 when unavailable or quality < 0.1.
 */
const getVolForecastAdjustment = (orFcst20d, iv30, fcstR2, strategy) => {
    if (orFcst20d == null || iv30 == null || iv30 <= 0) return 0;
    const quality = Math.max(0, Math.min(1, fcstR2 ?? 0));
    if (quality < 0.1) return 0;
    const diff = Math.max(-0.8, Math.min(0.8, (orFcst20d / iv30) - 1));
    const raw = strategy === 'long' ? diff : -diff;
    return raw * quality;
};

/**
 * Relative IV adjustment for LOQ: option IV vs same-DTE ATM IV.
 * Cheap vol (ratio < 1) → bonus; expensive (ratio > 1) → penalty. Capped ±0.4.
 */
const getRelativeIVAdjustmentLOQ = (optionIv, atmIvSameDTE) => {
    if (optionIv == null || atmIvSameDTE == null || atmIvSameDTE <= 0) return 0;
    const ratio = optionIv / atmIvSameDTE;
    const raw = (1 - ratio) * 0.5;
    return Math.max(-0.4, Math.min(0.4, raw));
};

/**
 * Relative IV adjustment for CSQ: option IV vs same-DTE ATM IV.
 * Expensive vol (ratio > 1) → bonus (sell rich); cheap → penalty. Capped ±0.4.
 */
const getRelativeIVAdjustmentCSQ = (optionIv, atmIvSameDTE) => {
    if (optionIv == null || atmIvSameDTE == null || atmIvSameDTE <= 0) return 0;
    const ratio = optionIv / atmIvSameDTE;
    const raw = (ratio - 1) * 0.5;
    return Math.max(-0.4, Math.min(0.4, raw));
};

// ────────────────────────────────────────────────────────────────
// LOQ / CSQ Raw Score
// ────────────────────────────────────────────────────────────────

// DESIGN NOTE: Z-score coefficients intentionally sum to 0.95 (standard) / 0.90 (day-trade).
// ivAdjustment and vegaBonus are additive terms outside the weighted z-score framework
// (they operate on different scales). These are NOT probability weights that must sum to 1.
const LOQ_WEIGHTS = { lambda: 0.30, dollarGamma: 0.20, gammaThetaRatio: 0.15, thetaBurn: 0, deltaBonus: 0.15, breakevenPenalty: 0.15 };
const LOQ_DT_WEIGHTS = { lambda: 0.30, dollarGamma: 0.35, gammaThetaRatio: 0.20, thetaBurn: 0, breakevenPenalty: 0.05, penaltyMult: 0.2 };

const getLOQWeightsForDTE = (dte) => {
    const deltaBonus = LOQ_WEIGHTS.deltaBonus;
    if (dte <= 5) {
        return { ...LOQ_DT_WEIGHTS, deltaBonus };
    }
    if (dte >= 15) {
        return { ...LOQ_WEIGHTS, penaltyMult: 1 };
    }
    const t = (dte - 5) / 10;
    const mix = (a, b) => a + (b - a) * t;
    return {
        lambda: mix(LOQ_DT_WEIGHTS.lambda, LOQ_WEIGHTS.lambda),
        dollarGamma: mix(LOQ_DT_WEIGHTS.dollarGamma, LOQ_WEIGHTS.dollarGamma),
        gammaThetaRatio: mix(LOQ_DT_WEIGHTS.gammaThetaRatio, LOQ_WEIGHTS.gammaThetaRatio),
        thetaBurn: mix(LOQ_DT_WEIGHTS.thetaBurn, LOQ_WEIGHTS.thetaBurn),
        deltaBonus,
        breakevenPenalty: mix(LOQ_DT_WEIGHTS.breakevenPenalty, LOQ_WEIGHTS.breakevenPenalty),
        penaltyMult: mix(LOQ_DT_WEIGHTS.penaltyMult, 1),
    };
};

/** @deprecated Use getLOQVegaWeight(dte, ivAdjustment) instead — flat constant no longer used internally. */
const LOQ_VEGA_EFF_WEIGHT_POS = 0.05;
/** @deprecated Use getLOQVegaWeight(dte, ivAdjustment) instead. */
const LOQ_VEGA_EFF_WEIGHT_NEG = -0.03;
const CSQ_VEGA_PENALTY_WEIGHT = -0.05;

/**
 * DTE-adaptive vega weight for LOQ (long options / buyers).
 * Mirrors oss-core.ts getLOQVegaWeight.
 *
 * Weight grows linearly from 0.03 (day-trade, DTE≤5) to 0.15 (long-dated, DTE≥60).
 * ivAdjustment > 0 (low IV, buyer-friendly): positive vega weight
 * ivAdjustment < 0 (high IV, buyer-unfriendly): negative weight × 0.6
 */
const getLOQVegaWeight = (dte, ivAdjustment) => {
    const d = dte ?? 30;
    const baseWeight = Math.min(0.15, Math.max(0.03, 0.03 + (0.12 * Math.min(Math.max(d - 5, 0), 55)) / 55));
    if (ivAdjustment > 0) return baseWeight;
    if (ivAdjustment < 0) return -baseWeight * 0.6;
    return 0;
};

const calculateLOQRaw = (zLambda, zDollarGamma, zThetaBurn, ivAdjustment, deltaBonus = 0, thetaBurn = 0, isDayTrade = false, zGammaThetaRatio = 0, breakevenPenalty = 0, dte = null, vegaZ = 0) => {
    const thetaPenalty = getThetaPenalty(thetaBurn);
    const w = dte != null
        ? getLOQWeightsForDTE(dte)
        : isDayTrade
            ? { ...LOQ_DT_WEIGHTS, deltaBonus: LOQ_WEIGHTS.deltaBonus }
            : { ...LOQ_WEIGHTS, penaltyMult: 1 };

    const vegaWeight = getLOQVegaWeight(dte, ivAdjustment);
    const vegaBonus = vegaWeight * vegaZ;

    return (
        w.lambda * zLambda +
        w.dollarGamma * zDollarGamma +
        w.gammaThetaRatio * zGammaThetaRatio +
        w.thetaBurn * zThetaBurn +
        w.deltaBonus * deltaBonus +
        w.breakevenPenalty * breakevenPenalty +
        ivAdjustment -
        thetaPenalty * w.penaltyMult +
        vegaBonus
    );
};

const CSQ_WEIGHTS = { edge: 0.50, pop: 0.30, spread: -0.20 };

const calculateCSQRaw = (zEdge, zPOP, zSpread, ivAdjustment, vegaPenalty = 0) => {
    return CSQ_WEIGHTS.edge * zEdge + CSQ_WEIGHTS.pop * zPOP + CSQ_WEIGHTS.spread * zSpread + ivAdjustment + vegaPenalty;
};

// ────────────────────────────────────────────────────────────────
// Structured explainability (P1-5: factors[])
// ────────────────────────────────────────────────────────────────

const buildLOQFactors = (zLambda, zDollarGamma, zThetaBurn, ivAdjustment, deltaBonus, thetaBurn, zGT, bePenalty, dte, zVegaEff) => {
    const w = dte != null ? getLOQWeightsForDTE(dte) : { ...LOQ_WEIGHTS, penaltyMult: 1 };
    const thetaPenalty = getThetaPenalty(thetaBurn);
    const vegaWeight = getLOQVegaWeight(dte, ivAdjustment);
    const vegaBonus = vegaWeight * zVegaEff;
    const items = [
        { name: 'Lambda', impact: w.lambda * zLambda, description: 'Leverage (compressed); higher in sweet spot helps.', value: undefined },
        { name: 'Dollar Gamma', impact: w.dollarGamma * zDollarGamma, description: 'Price-independent gamma exposure (γ × S² / 100).', value: undefined },
        { name: 'G/T Ratio', impact: w.gammaThetaRatio * zGT, description: 'Gamma per unit theta (cost of gamma).', value: undefined },
        { name: 'Delta Bonus', impact: w.deltaBonus * deltaBonus, description: 'Strike alignment; sweet spot 0.30–0.50.', value: undefined },
        { name: 'BE Penalty', impact: w.breakevenPenalty * bePenalty, description: 'Breakeven difficulty (DTE-adjusted).', value: undefined },
        { name: 'IV / Term', impact: ivAdjustment, description: 'IV term structure vs strategy (contango/backwardation).', value: undefined },
        { name: 'Theta Penalty', impact: -thetaPenalty * w.penaltyMult, description: 'Time decay penalty.', value: thetaBurn !== 0 ? `${(thetaBurn * 100).toFixed(2)}%/day` : undefined },
        { name: 'Vega', impact: vegaBonus, description: 'Vega exposure; DTE-adaptive weight.', value: undefined },
    ];
    return items.filter(f => Math.abs(f.impact) > 0.01).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)).slice(0, 8);
};

const buildCSQFactors = (zEdge, zPOP, zSpread, ivAdjustment, vegaPenalty) => {
    const items = [
        { name: 'Edge', impact: CSQ_WEIGHTS.edge * zEdge, description: "Seller's expected win amount.", value: undefined },
        { name: 'POP', impact: CSQ_WEIGHTS.pop * zPOP, description: 'Probability of profit.', value: undefined },
        { name: 'Spread%', impact: CSQ_WEIGHTS.spread * zSpread, description: 'Tighter spread improves score.', value: undefined },
        { name: 'IV / Term', impact: ivAdjustment, description: 'Regime/term structure alignment.', value: undefined },
        { name: 'Vega Penalty', impact: vegaPenalty, description: 'High vega/premium penalized for sellers.', value: undefined },
    ];
    return items.filter(f => Math.abs(f.impact) > 0.01).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)).slice(0, 6);
};

// ────────────────────────────────────────────────────────────────
// Score Normalization
// ────────────────────────────────────────────────────────────────

const normalizeScoreTo100 = (rawScore) => {
    const scaled = 50 + rawScore * 12.5;
    return Math.max(0, Math.min(100, Math.round(scaled)));
};

/**
 * Dynamic baseline: normalize raw LOQ scores to 0-100 using the pool's distribution.
 * Makes scores comparable within the same chain/scan (cross-ticker fair).
 */
const normalizeLOQScoresWithDynamicBaseline = (rawScores) => {
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
};

// ────────────────────────────────────────────────────────────────
// Metric Helpers
// ────────────────────────────────────────────────────────────────

const calculateSpreadPct = (bid, ask) => {
    const mid = (bid + ask) / 2;
    if (mid <= 0) return 1;
    return (ask - bid) / mid;
};

const calculateExpectedValue = (pop, credit, maxRisk, exitMultiplier = 0.92) => {
    return (pop * credit) - ((1 - pop) * maxRisk * exitMultiplier);
};

// ────────────────────────────────────────────────────────────────
// IV Term Structure (Strict Interpolation)
// ────────────────────────────────────────────────────────────────

/**
 * Get ATM IV for a chain at a specific DTE.
 * Requires both Call and Put at the same strike (proper ATM averaging).
 */
const getCleanATM_IV = (chain, currentPrice) => {
    if (!chain || chain.length === 0) return null;

    const strikes = {};
    for (const opt of chain) {
        if (!strikes[opt.strike]) strikes[opt.strike] = {};
        strikes[opt.strike][opt.type] = opt;
    }

    let bestStrike = null;
    let minDiff = Infinity;

    for (const strikeStr of Object.keys(strikes)) {
        const strike = parseFloat(strikeStr);
        if (strikes[strike].Call && strikes[strike].Put) {
            const diff = Math.abs(strike - currentPrice);
            if (diff < minDiff) {
                minDiff = diff;
                bestStrike = strike;
            }
        }
    }

    if (bestStrike === null) return null;

    const atmCall = strikes[bestStrike].Call;
    const atmPut = strikes[bestStrike].Put;

    if (!atmCall.iv || !atmPut.iv) return null;
    return (atmCall.iv + atmPut.iv) / 2;
};

/**
 * Calculate IV at a target DTE using variance-based temporal interpolation.
 *
 * WHY variance-based? Total variance = σ²·T is additive (calendar spread math).
 * Linear interpolation of IV itself overstates mid-term IV in backwardation and
 * understates in contango. Correct approach:
 *   totalVar_target = lerp(targetDTE, nearDTE, farDTE, iv_near²·nearDTE/252, iv_far²·farDTE/252)
 *   iv_target = sqrt(totalVar_target × 252 / targetDTE)
 *
 * Example: IV30=30%, IV90=20%, targetDTE=60
 *   Linear: 25.0%   (overstated in backwardation)
 *   Variance-based: 22.4%  (correct)
 */
const calculateTargetIV = (allOptions, targetDTE, currentPrice) => {
    const dtes = [...new Set(allOptions.map((o) => o.dte))].sort((a, b) => a - b);
    if (dtes.length === 0) return null;

    if (dtes.includes(targetDTE)) {
        const chain = allOptions.filter((o) => o.dte === targetDTE);
        return getCleanATM_IV(chain, currentPrice);
    }

    let nearDTE = null;
    let farDTE = null;

    for (const dte of dtes) {
        if (dte < targetDTE) nearDTE = dte;
        if (dte > targetDTE) { farDTE = dte; break; }
    }

    if (nearDTE === null || farDTE === null) return null;

    const chainNear = allOptions.filter((o) => o.dte === nearDTE);
    const chainFar = allOptions.filter((o) => o.dte === farDTE);

    const ivNear = getCleanATM_IV(chainNear, currentPrice);
    const ivFar = getCleanATM_IV(chainFar, currentPrice);

    if (ivNear === null || ivFar === null) return null;

    // Variance-based interpolation: variance = σ²·T/252 is linear in calendar time
    const varNear = ivNear * ivNear * nearDTE / 252;
    const varFar = ivFar * ivFar * farDTE / 252;
    const varTarget = lerp(targetDTE, nearDTE, farDTE, varNear, varFar);
    if (varTarget <= 0) return null;
    return Math.sqrt(varTarget * 252 / targetDTE);
};

/**
 * Build complete IV Term Structure for visualization and regime detection.
 * Returns: { iv7, iv14, iv30, iv60, iv90, iv120, anomaly }
 * anomaly: true if IV7/IV30 > 1.3 (potential earnings spike)
 */
const buildIVTermStructure = (allOptions, currentPrice) => {
    const structure = {
        iv7: calculateTargetIV(allOptions, 7, currentPrice),
        iv14: calculateTargetIV(allOptions, 14, currentPrice),
        iv30: calculateTargetIV(allOptions, 30, currentPrice),
        iv60: calculateTargetIV(allOptions, 60, currentPrice),
        iv90: calculateTargetIV(allOptions, 90, currentPrice),
        iv120: calculateTargetIV(allOptions, 120, currentPrice),
        anomaly: false
    };

    // Anomaly detection: IV7/IV30 > 1.3 suggests near-term event (earnings)
    if (structure.iv7 && structure.iv30 && structure.iv30 > 0) {
        const ratio = structure.iv7 / structure.iv30;
        if (ratio > 1.3) {
            structure.anomaly = true;
            structure.anomalyRatio = ratio;
        }
    }

    return structure;
};


// ────────────────────────────────────────────────────────────────
// OCC Symbol Parser
// ────────────────────────────────────────────────────────────────

/**
 * Parse raw options array into a normalized chain.
 * Supports both CBOE (OCC symbol parsing) and MarketData.app (pre-normalized) formats.
 * Optionally filters by DTE bucket via targetDTE.
 */
const parseChain = (options, currentPrice, targetDTE = null, strikePadding = 0.15) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const minStrike = currentPrice * (1 - strikePadding);
    const maxStrike = currentPrice * (1 + strikePadding);

    const result = [];

    for (const opt of options) {
        let symbol, strike, type, expiration, dte;
        let bid, ask, delta, gamma, theta, vega, iv, volume, openInterest;

        // Detect format: CBOE has 'option' field (OCC symbol), MarketData has 'symbol' + direct fields
        const isCBOE = opt.option !== undefined;
        const isMarketData = opt.symbol !== undefined && opt.strike !== undefined;

        if (isMarketData) {
            // MarketData format: already normalized by market-data-client.js
            symbol = opt.symbol;
            strike = opt.strike;
            type = opt.type; // 'Call' or 'Put'
            expiration = opt.expiration; // YYYY-MM-DD
            dte = opt.dte;
            bid = opt.bid || 0;
            ask = opt.ask || 0;
            delta = opt.delta || 0;
            gamma = opt.gamma || 0;
            theta = opt.theta || 0;
            vega = opt.vega || 0;
            iv = opt.iv || 0;
            volume = opt.volume || 0;
            openInterest = opt.openInterest || 0;

        } else if (isCBOE) {
            // CBOE format: parse OCC symbol
            symbol = opt.option || '';
            const dateMatch = symbol.match(/(\d{6})[CP]/);
            dte = 30;
            expiration = '';

            if (dateMatch) {
                const dateStr = dateMatch[1];
                const yy = parseInt(dateStr.slice(0, 2));
                const mm = parseInt(dateStr.slice(2, 4));
                const dd = parseInt(dateStr.slice(4, 6));
                const expDate = new Date(2000 + yy, mm - 1, dd);
                dte = Math.ceil((expDate.getTime() - today.getTime()) / 86400000);
                expiration = `${2000 + yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
            }

            // Skip expired options
            if (dte <= 0) continue;

            const strikeMatch = symbol.match(/[CP](\d{8})$/);
            strike = strikeMatch ? parseInt(strikeMatch[1]) / 1000 : 0;

            type = symbol.includes('C') && symbol.match(/\d{6}C/) ? 'Call' : 'Put';

            bid = opt.bid || 0;
            ask = opt.ask || 0;
            delta = opt.delta || 0;
            gamma = opt.gamma || 0;
            theta = opt.theta || 0;
            vega = opt.vega || 0;
            iv = opt.iv || 0;
            volume = opt.volume || 0;
            openInterest = opt.open_interest || 0;
        } else {
            // Unknown format, skip
            continue;
        }

        // Early strike range filter
        if (strike < minStrike || strike > maxStrike) continue;

        // DTE bucket filter
        if (targetDTE !== null) {
            let inBucket = false;
            if (targetDTE < 30) inBucket = dte >= 14 && dte < 30;
            else if (targetDTE < 45) inBucket = dte >= 30 && dte < 45;
            else if (targetDTE < 90) inBucket = dte >= 45 && dte < 90;
            else inBucket = dte >= 90;
            if (!inBucket) continue;
        } else {
            if (dte > 730) continue;
        }

        // Greeks sanity checks: reject data errors that would corrupt scoring.
        // Call delta ∈ [0,1], Put delta ∈ [-1,0]; gamma ≥ 0 for long options; IV ≥ 0 always.
        if (Math.abs(delta) > 1 || gamma < 0 || iv < 0) continue;

        // Normalize IV to decimal form (0.30 = 30%) regardless of feed format.
        // Some CBOE feeds return IV as a percent (e.g. 30.5 instead of 0.305).
        // Threshold at 5.0 (500%): meme stocks (GME, AMC) can legitimately hit 200-400% IV.
        // A threshold of 2.0 would incorrectly clip these, destroying scoring accuracy.
        if (iv > 5.0) iv = iv / 100;

        result.push({
            symbol,
            strike,
            type,
            expiration,
            dte,
            bid,
            ask,
            delta,
            gamma,
            theta,
            vega,
            iv,
            volume,
            openInterest,
        });
    }

    return result;
};

// ────────────────────────────────────────────────────────────────
// Unified Cross-Strategy Scoring
// ────────────────────────────────────────────────────────────────

/**
 * Map EV/Risk ratio to 0-100 using per-category anchors (v2.8).
 *
 * Single [-0.5, +0.5] range caused credits to cluster mid-range while singles hit extremes.
 * Category-specific ranges restore full 0-100 spread for each strategy type.
 *
 * strategyCategory: 'CREDIT_SPREAD' | 'IRON_CONDOR' | 'DEBIT_SPREAD' | 'SINGLE_LEG' | default
 */
const normalizeEVRisk = (evRiskRatio, strategyCategory = null) => {
    let lo, hi;
    switch (strategyCategory) {
        case 'CREDIT_SPREAD':
        case 'IRON_CONDOR':
            lo = -0.15; hi = 0.20; break;
        case 'DEBIT_SPREAD':
            lo = -0.30; hi = 0.40; break;
        case 'SINGLE_LEG':
            lo = -1.0; hi = 2.0; break;
        default:
            lo = -0.5; hi = 0.5; break;
    }
    const clamped = Math.max(lo, Math.min(hi, evRiskRatio));
    return (clamped - lo) / (hi - lo) * 100;
};

/** Liquidity score: 70% bid-ask tightness + 30% volume/OI. Returns 0-100. */
const calculateLiquidityScore = (bid, ask, volume, openInterest) => {
    const mid = (bid + ask) / 2;
    if (mid <= 0) return 0;
    const spreadPct = (ask - bid) / mid;
    const spreadScore = Math.max(0, Math.min(100, 100 - spreadPct * 500));
    const volumeBonus = Math.min(50, (volume || 0) / 20);
    const oiBonus = Math.min(50, (openInterest || 0) / 100);
    const liqBonus = (volumeBonus + oiBonus) / 2;
    return 0.7 * spreadScore + 0.3 * liqBonus;
};

/**
 * Regime alignment bonus. Returns raw 0-20.
 * termStrength: 'strong_backwardation' | 'backwardation' | 'flat' | 'contango' | 'strong_contango' (optional)
 * Strong contango/backwardation add a small extra bonus for aligned strategies.
 */
const calculateRegimeBonus = (strategyCategory, regimeMode, ivRvRatio, termStrength) => {
    let bonus = 0;
    if (regimeMode === 'CREDIT') {
        if (strategyCategory === 'CREDIT_SPREAD') bonus += 15;
    } else if (regimeMode === 'DEBIT') {
        if (strategyCategory === 'DEBIT_SPREAD') bonus += 10;
        if (strategyCategory === 'SINGLE_LEG') bonus += 10;
    }
    if (ivRvRatio != null) {
        if (ivRvRatio > 1.2 && strategyCategory === 'CREDIT_SPREAD') bonus += 5;
        if (ivRvRatio < 0.85 && (strategyCategory === 'DEBIT_SPREAD' || strategyCategory === 'SINGLE_LEG')) bonus += 5;
    }
    if (termStrength === 'strong_backwardation' && regimeMode === 'CREDIT' && strategyCategory === 'CREDIT_SPREAD') bonus += 2;
    if (termStrength === 'strong_contango' && regimeMode === 'DEBIT' && (strategyCategory === 'DEBIT_SPREAD' || strategyCategory === 'SINGLE_LEG')) bonus += 2;
    return bonus;
};

/**
 * Skew bonus for credit spreads: scale by |skew| when direction favors the strategy, with cap.
 * - Put credit: favored when skew > 0 (put IV rich). Bonus 5..15 as |skew| goes from 0.05 to 0.25.
 * - Call credit: favored when skew < 0 (call IV rich). Same scaling.
 * Future: could use skew to adjust spread width (e.g. steeper put skew → slightly wider put credit spread).
 */
const getSkewBonusForCreditSpread = (skew, type) => {
    const absSkew = Math.abs(skew);
    const THRESHOLD = 0.05;
    const CAP_AT = 0.25;
    const BONUS_MIN = 5;
    const BONUS_MAX = 15;
    if (type === 'Put' && skew > THRESHOLD) {
        const t = Math.min(1, (absSkew - THRESHOLD) / (CAP_AT - THRESHOLD));
        return BONUS_MIN + t * (BONUS_MAX - BONUS_MIN);
    }
    if (type === 'Call' && skew < -THRESHOLD) {
        const t = Math.min(1, (absSkew - THRESHOLD) / (CAP_AT - THRESHOLD));
        return BONUS_MIN + t * (BONUS_MAX - BONUS_MIN);
    }
    return 0;
};

/**
 * Skew favor for Unified Score: 0–10 points when skew favors this strategy (credit spread only).
 * Used so "Skew favors this side" candidates get a small boost in cross-strategy ranking.
 */
const getSkewFavorForUnifiedScore = (skew, strategyCategory, creditSpreadType) => {
    if (strategyCategory !== 'CREDIT_SPREAD' || creditSpreadType == null) return 0;
    const absSkew = Math.abs(skew);
    const THRESHOLD = 0.05;
    const CAP_AT = 0.25;
    if (creditSpreadType === 'Put' && skew > THRESHOLD) {
        const t = Math.min(1, (absSkew - THRESHOLD) / (CAP_AT - THRESHOLD));
        return 5 + t * 5; // 5..10
    }
    if (creditSpreadType === 'Call' && skew < -THRESHOLD) {
        const t = Math.min(1, (absSkew - THRESHOLD) / (CAP_AT - THRESHOLD));
        return 5 + t * 5;
    }
    return 0;
};

/**
 * Unified cross-strategy score. Comparable across Credit Spread, Debit Spread, and Long Option.
 * Uses EV/Risk (40%), POP (20%), Regime alignment (25%), Liquidity (15%).
 * opts: { skew?, creditSpreadType?, anomaly?, termStrength? }
 * - skew/creditSpreadType: when skew favors this strategy, adds 0–10 points.
 * - anomaly: when true and strategy is short-term credit (DTE <= 30), regime component is down-weighted (IV spike / earnings risk).
 * - termStrength: passed to calculateRegimeBonus for strong contango/backwardation fine-tuning.
 */
const calculateUnifiedScore = (candidate, strategyCategory, regimeMode, ivRvRatio, opts = null) => {
    const anomaly = opts && opts.anomaly === true;
    const termStrength = opts && opts.termStrength;
    const dte = strategyCategory === 'SINGLE_LEG' ? (candidate.dte ?? null) : (candidate.shortLeg?.dte ?? null);

    let evRiskRatio, pop, liqScore;

    if (strategyCategory === 'CREDIT_SPREAD') {
        const maxRisk = candidate.maxRisk;
        const ev = candidate.expectedValue;
        evRiskRatio = maxRisk > 0 ? ev / maxRisk : 0;
        pop = (candidate.pop || 0) / 100;
        const sVol = (candidate.shortLeg?.volume || 0) + (candidate.longLeg?.volume || 0);
        const sOI = (candidate.shortLeg?.openInterest || 0) + (candidate.longLeg?.openInterest || 0);
        const sBid = candidate.shortLeg?.bid || 0;
        const sAsk = candidate.shortLeg?.ask || 0;
        liqScore = calculateLiquidityScore(sBid, sAsk, sVol, sOI);
    } else if (strategyCategory === 'DEBIT_SPREAD') {
        const maxRisk = candidate.maxRisk;
        const ev = candidate.expectedValue;
        evRiskRatio = maxRisk > 0 ? ev / maxRisk : 0;
        pop = (candidate.pop || 0) / 100;
        const sVol = (candidate.shortLeg?.volume || 0) + (candidate.longLeg?.volume || 0);
        const sOI = (candidate.shortLeg?.openInterest || 0) + (candidate.longLeg?.openInterest || 0);
        const lBid = candidate.longLeg?.bid || 0;
        const lAsk = candidate.longLeg?.ask || 0;
        liqScore = calculateLiquidityScore(lBid, lAsk, sVol, sOI);
    } else {
        // SINGLE_LEG: same EV/Risk and POP semantics as spreads. POP = breakeven-based when candidate.pop provided (from scoreSingleLegs); else delta heuristic.
        const price = candidate.price;
        const maxRisk = price;
        // Use lambda (leverage ratio) as the profit multiplier instead of a flat 2x cap.
        // Lambda = |δ| * S / price, so this scales with actual option characteristics.
        // Cap at 5x to prevent extreme values from dominating.
        const lambdaMult = Math.min(candidate.lambda || 2, 5);
        const maxProfitCapped = lambdaMult * price;
        pop = candidate.pop != null ? (candidate.pop / 100) : Math.max(0, Math.min(1, Math.abs(candidate.delta || 0) - 0.05));
        const ev = (pop * maxProfitCapped) - ((1 - pop) * maxRisk);
        evRiskRatio = maxRisk > 0 ? ev / maxRisk : 0;
        liqScore = calculateLiquidityScore(
            candidate.bid || 0, candidate.ask || 0,
            candidate.volume || 0, candidate.openInterest || 0
        );
    }

    const normEVRisk = normalizeEVRisk(evRiskRatio, strategyCategory);
    const normPOP = Math.max(0, Math.min(100, pop * 100));
    const regimeBonus = calculateRegimeBonus(strategyCategory, regimeMode, ivRvRatio, termStrength);
    let normRegime = Math.min(100, regimeBonus * 5);
    if (anomaly && strategyCategory === 'CREDIT_SPREAD' && (dte == null || dte <= 30)) {
        normRegime = normRegime * 0.55;
    }
    const normLiquidity = Math.max(0, Math.min(100, liqScore));

    // Pine Script setup-aware weighting (v2.8 — corrected direction):
    // WITH setup:    setup already validates direction → EV is more reliable → raise EV, lower Regime
    // WITHOUT setup: direction uncertain → rely more on regime alignment
    const hasPineSetup = opts && opts.setup && opts.setup !== '' && opts.setup !== 'Mixed' && opts.setup !== 'Other';
    const wEV = hasPineSetup ? 0.45 : 0.35;
    const wPOP = 0.20;
    const wRegime = hasPineSetup ? 0.20 : 0.30;
    const wLiq = 0.15;
    const evPts = wEV * normEVRisk;
    const popPts = wPOP * normPOP;
    const regimePts = wRegime * normRegime;
    const liqPts = wLiq * normLiquidity;
    let raw = evPts + popPts + regimePts + liqPts;
    let skewPts = 0;
    if (opts && opts.skew != null) {
        const creditSpreadType = opts.creditSpreadType || null;
        skewPts = getSkewFavorForUnifiedScore(opts.skew, strategyCategory, creditSpreadType);
        raw += skewPts;
    }

    const factors = [
        { name: 'EV/Risk', impact: Math.round(evPts * 10) / 10, description: 'Expected value vs max risk (40% of score).', value: evRiskRatio != null ? evRiskRatio.toFixed(3) : undefined },
        { name: 'POP', impact: Math.round(popPts * 10) / 10, description: 'Probability of profit (20% of score).', value: `${(pop * 100).toFixed(0)}%` },
        { name: 'Regime', impact: Math.round(regimePts * 10) / 10, description: 'IV regime alignment + IV/RV (25% of score).' + (anomaly && strategyCategory === 'CREDIT_SPREAD' ? ' Down-weighted (anomaly).' : ''), value: regimeMode },
        { name: 'Liquidity', impact: Math.round(liqPts * 10) / 10, description: 'Bid-ask tightness and volume/OI (15% of score).', value: undefined },
    ];
    if (skewPts !== 0) {
        factors.push({ name: 'Skew', impact: skewPts, description: 'Skew favors this strategy (Put/Call credit).', value: opts?.skew != null ? opts.skew.toFixed(3) : undefined });
    }

    const score = Math.max(0, Math.min(100, Math.round(raw)));
    return { score, factors };
};

// ────────────────────────────────────────────────────────────────
// Soft Penalties (P1-3)
// ────────────────────────────────────────────────────────────────

/**
 * Apply soft penalties to raw score based on liquidity, price, DTE, and OI.
 * These are continuous penalties (not hard filters) applied after z-score but before normalization.
 * @param {number} rawScore Raw score before normalization
 * @param {object} opt Option contract { bid, ask, dte, openInterest }
 * @param {number} mid Mid price
 * @returns {number} Adjusted raw score
 */
const applySoftPenalties = (rawScore, opt, mid) => {
    let penalty = 0;

    // 1. Liquidity penalty (continuous based on spread%)
    const spreadPct = (opt.ask - opt.bid) / mid;
    if (spreadPct > 0.05) {
        penalty -= Math.min(10, (spreadPct - 0.05) * 100);  // 0.05→0, 0.15→-10
    }

    // 2. Low price penalty (avoid z-score pollution from 1/mid effects)
    if (mid < 0.50) {
        penalty -= Math.min(8, (0.50 - mid) * 20);  // $0.50→0, $0.10→-8
    }

    // 3. Short DTE penalty (non-holding-to-expiry style)
    if (opt.dte < 14) {
        penalty -= Math.min(15, (14 - opt.dte) * 2);  // 14→0, 7→-14
    }

    // 4. Extremely low OI penalty (soft, hard filter already removed extremes)
    if (opt.openInterest < 500) {
        penalty -= Math.min(5, (500 - opt.openInterest) / 100);
    }

    return rawScore + penalty;
};

// ────────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    lerp,
    sigmoidFn,
    compressLambda,
    getThetaPenalty,
    calculateDollarGamma,
    calculateGammaThetaRatio,
    calculateBreakevenMove,
    getBreakevenPenalty,
    getDeltaBonus,
    zScores,
    zScoresByBucket,
    HARD_FILTER_DEFAULTS,
    HARD_FILTER_CREDIT,
    DTE_BUCKETS,
    MIN_BUCKET_SIZE,
    getIVRiskFactor,
    getIVAdjustment,
    getIVRankAdjustment,
    getVolForecastAdjustment,
    getRelativeIVAdjustmentLOQ,
    getRelativeIVAdjustmentCSQ,
    getLOQWeightsForDTE,
    getLOQVegaWeight,
    calculateLOQRaw,
    calculateCSQRaw,
    buildLOQFactors,
    buildCSQFactors,
    normalizeScoreTo100,
    normalizeLOQScoresWithDynamicBaseline,
    calculateSpreadPct,
    calculateExpectedValue,
    getCleanATM_IV,
    calculateTargetIV,
    buildIVTermStructure,
    parseChain,
    LOQ_WEIGHTS,
    LOQ_DT_WEIGHTS,
    CSQ_WEIGHTS,
    calculateSkew,
    estimateSlippage,
    getGammaRiskPenalty,
    normalizeEVRisk,
    calculateLiquidityScore,
    calculateRegimeBonus,
    calculateUnifiedScore,
    getSkewBonusForCreditSpread,
    getSkewFavorForUnifiedScore,
    applySoftPenalties
};
