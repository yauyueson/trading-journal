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
    const THRESHOLD = 20;
    const DECAY_RATE = 0.1;
    if (lambda <= THRESHOLD) return lambda;
    return THRESHOLD + (lambda - THRESHOLD) * DECAY_RATE;
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
    // Skew = (25d Put IV - 25d Call IV) / 50d ATM IV
    // Simplification: Use OTM Puts (Delta ~0.25) vs OTM Calls (Delta ~0.25)
    const targetChain = chain.filter(o => Math.abs(o.dte - targetDTE) < 15); // strict DTE window
    if (targetChain.length < 10) return 0;

    const puts = targetChain.filter(o => o.type === 'Put' && Math.abs(o.delta + 0.25) < 0.10); // Look for -0.25 delta
    const calls = targetChain.filter(o => o.type === 'Call' && Math.abs(o.delta - 0.25) < 0.10); // Look for +0.25 delta

    // Fallback: use wider delta range if no match
    const put = puts.length ? puts.reduce((prev, curr) => Math.abs(curr.delta + 0.25) < Math.abs(prev.delta + 0.25) ? curr : prev) : null;
    const call = calls.length ? calls.reduce((prev, curr) => Math.abs(curr.delta - 0.25) < Math.abs(prev.delta - 0.25) ? curr : prev) : null;

    if (!put || !call) return 0;

    // Use IV if available
    if (put.iv > 0 && call.iv > 0) {
        return (put.iv - call.iv) / ((put.iv + call.iv) / 2);
    }
    return 0;
};

// ────────────────────────────────────────────────────────────────
// Slippage Modeling (v2.3)
// ────────────────────────────────────────────────────────────────

const estimateSlippage = (bid, ask) => {
    const spread = ask - bid;
    // Conservative: assume we lose 10% of the spread width in slippage from the mid
    return spread * 0.10;
};

// ────────────────────────────────────────────────────────────────
// Gamma Risk (v2.3)
// ────────────────────────────────────────────────────────────────

const getGammaRiskPenalty = (gamma, theta, dte) => {
    if (dte > 14) return 0; // Only punitive for < 14 DTE
    // Gamma risk is high when Gamma is high relative to Theta income
    // Or just absolute Gamma is too high (explosion risk)

    // Normalized check: if Gamma is huge (0.15+ for e.g. SPY is massive, but for small stocks 0.15 is low)
    // Better to use Gamma/Theta ratio or just penalize low DTE if Gamma is rising

    // Simple logic: if < 5 DTE, severe penalty. 5-14 DTE, mild penalty.
    if (dte <= 5) return -25;
    if (dte <= 10) return -10;
    return 0;
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
    minMid: 0.15,
    minOpenInterest: 200,
    maxSpreadPctCeiling: 0.12,
};

const DTE_BUCKETS = [
    { label: '0-14', min: 0, max: 14 },
    { label: '15-30', min: 15, max: 30 },
    { label: '31-60', min: 31, max: 60 },
    { label: '61-120', min: 61, max: 120 },
    { label: '121+', min: 121, max: Infinity },
];

const MIN_BUCKET_SIZE = 3;

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
    const k = 12;
    const x0 = 1.10;
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

const getIVRankAdjustment = (ivRank, strategy) => {
    if (ivRank == null || ivRank < 0 || ivRank > 1) return 0;
    if (strategy === 'long') {
        if (ivRank < 0.3) return 0.5;
        if (ivRank > 0.7) return -0.5;
        return 0;
    }
    if (ivRank < 0.3) return -0.3;
    if (ivRank > 0.7) return 0.5;
    return 0;
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

const LOQ_WEIGHTS = { lambda: 0.30, gammaEff: 0.20, gammaThetaRatio: 0.15, thetaBurn: -0.10, deltaBonus: 0.15, breakevenPenalty: 0.10 };
const LOQ_DT_WEIGHTS = { lambda: 0.30, gammaEff: 0.35, gammaThetaRatio: 0.20, thetaBurn: -0.05, breakevenPenalty: 0.05, penaltyMult: 0.2 };

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
        gammaEff: mix(LOQ_DT_WEIGHTS.gammaEff, LOQ_WEIGHTS.gammaEff),
        gammaThetaRatio: mix(LOQ_DT_WEIGHTS.gammaThetaRatio, LOQ_WEIGHTS.gammaThetaRatio),
        thetaBurn: mix(LOQ_DT_WEIGHTS.thetaBurn, LOQ_WEIGHTS.thetaBurn),
        deltaBonus,
        breakevenPenalty: mix(LOQ_DT_WEIGHTS.breakevenPenalty, LOQ_WEIGHTS.breakevenPenalty),
        penaltyMult: mix(LOQ_DT_WEIGHTS.penaltyMult, 1),
    };
};

const LOQ_VEGA_EFF_WEIGHT_POS = 0.05;
const LOQ_VEGA_EFF_WEIGHT_NEG = -0.03;
const CSQ_VEGA_PENALTY_WEIGHT = -0.05;

const calculateLOQRaw = (zLambda, zGammaEff, zThetaBurn, ivAdjustment, deltaBonus = 0, thetaBurn = 0, isDayTrade = false, zGammaThetaRatio = 0, breakevenPenalty = 0, dte = null, vegaZ = 0) => {
    const thetaPenalty = getThetaPenalty(thetaBurn);
    const w = dte != null
        ? getLOQWeightsForDTE(dte)
        : isDayTrade
            ? { ...LOQ_DT_WEIGHTS, deltaBonus: LOQ_WEIGHTS.deltaBonus }
            : { ...LOQ_WEIGHTS, penaltyMult: 1 };

    const vegaWeight = ivAdjustment > 0 ? LOQ_VEGA_EFF_WEIGHT_POS : (ivAdjustment < 0 ? LOQ_VEGA_EFF_WEIGHT_NEG : 0);
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
};

const CSQ_WEIGHTS = { edge: 0.50, pop: 0.30, spread: -0.20 };

const calculateCSQRaw = (zEdge, zPOP, zSpread, ivAdjustment, vegaPenalty = 0) => {
    return CSQ_WEIGHTS.edge * zEdge + CSQ_WEIGHTS.pop * zPOP + CSQ_WEIGHTS.spread * zSpread + ivAdjustment + vegaPenalty;
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

const calculateExpectedValue = (pop, credit, maxRisk) => {
    return (pop * credit) - ((1 - pop) * maxRisk);
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
 * Calculate IV at a target DTE using temporal interpolation.
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

    return lerp(targetDTE, nearDTE, farDTE, ivNear, ivFar);
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
const parseChain = (options, currentPrice, targetDTE = null) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const minStrike = currentPrice * 0.85;
    const maxStrike = currentPrice * 1.15;

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

/** Map EV/Risk ratio to 0-100 using fixed anchors (not pool-relative). */
const normalizeEVRisk = (evRiskRatio) => {
    // EV/Risk typically ranges from -0.5 (bad) to +0.5 (excellent)
    const clamped = Math.max(-0.5, Math.min(0.5, evRiskRatio));
    return (clamped + 0.5) * 100;
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
        const sBid = candidate.shortLeg?.price || 0;
        const sAsk = candidate.shortLeg?.price || 0;
        liqScore = calculateLiquidityScore(sBid, sAsk, sVol, sOI);
    } else if (strategyCategory === 'DEBIT_SPREAD') {
        const maxRisk = candidate.maxRisk;
        const ev = candidate.expectedValue;
        evRiskRatio = maxRisk > 0 ? ev / maxRisk : 0;
        pop = (candidate.pop || 0) / 100;
        const sVol = (candidate.shortLeg?.volume || 0) + (candidate.longLeg?.volume || 0);
        const sOI = (candidate.shortLeg?.openInterest || 0) + (candidate.longLeg?.openInterest || 0);
        const lBid = candidate.longLeg?.price || 0;
        const lAsk = candidate.longLeg?.price || 0;
        liqScore = calculateLiquidityScore(lBid, lAsk, sVol, sOI);
    } else {
        // SINGLE_LEG: same EV/Risk and POP semantics as spreads. POP = breakeven-based when candidate.pop provided (from scoreSingleLegs); else delta heuristic.
        const price = candidate.price;
        const maxRisk = price;
        const maxProfitCapped = 2 * price;
        pop = candidate.pop != null ? (candidate.pop / 100) : Math.max(0, Math.min(1, Math.abs(candidate.delta || 0) - 0.05));
        const ev = (pop * maxProfitCapped) - ((1 - pop) * maxRisk);
        evRiskRatio = maxRisk > 0 ? ev / maxRisk : 0;
        liqScore = calculateLiquidityScore(
            candidate.bid || 0, candidate.ask || 0,
            candidate.volume || 0, candidate.openInterest || 0
        );
    }

    const normEVRisk = normalizeEVRisk(evRiskRatio);
    const normPOP = Math.max(0, Math.min(100, pop * 100));
    const regimeBonus = calculateRegimeBonus(strategyCategory, regimeMode, ivRvRatio, termStrength);
    let normRegime = Math.min(100, regimeBonus * 5);
    if (anomaly && strategyCategory === 'CREDIT_SPREAD' && (dte == null || dte <= 30)) {
        normRegime = normRegime * 0.55;
    }
    const normLiquidity = Math.max(0, Math.min(100, liqScore));

    let raw = (0.40 * normEVRisk) + (0.20 * normPOP) + (0.25 * normRegime) + (0.15 * normLiquidity);
    if (opts && opts.skew != null) {
        const creditSpreadType = opts.creditSpreadType || null;
        raw += getSkewFavorForUnifiedScore(opts.skew, strategyCategory, creditSpreadType);
    }
    return Math.max(0, Math.min(100, Math.round(raw)));
};

// ────────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    lerp,
    sigmoidFn,
    compressLambda,
    getThetaPenalty,
    calculateGammaThetaRatio,
    calculateBreakevenMove,
    getBreakevenPenalty,
    getDeltaBonus,
    zScores,
    zScoresByBucket,
    HARD_FILTER_DEFAULTS,
    DTE_BUCKETS,
    MIN_BUCKET_SIZE,
    getIVRiskFactor,
    getIVAdjustment,
    getIVRankAdjustment,
    getRelativeIVAdjustmentLOQ,
    getRelativeIVAdjustmentCSQ,
    getLOQWeightsForDTE,
    calculateLOQRaw,
    calculateCSQRaw,
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
    getSkewFavorForUnifiedScore
};
