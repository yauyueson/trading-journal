/**
 * OSS Core - Options Scoring System v2.2 (API Mirror)
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

const calculateBreakevenMove = (optionPrice, delta, stockPrice) => {
    const absDelta = Math.abs(delta);
    if (absDelta < 0.01 || stockPrice <= 0) return 1;
    return optionPrice / (absDelta * stockPrice);
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

// ────────────────────────────────────────────────────────────────
// LOQ / CSQ Raw Score
// ────────────────────────────────────────────────────────────────

const LOQ_WEIGHTS = { lambda: 0.30, gammaEff: 0.20, gammaThetaRatio: 0.15, thetaBurn: -0.10, deltaBonus: 0.15, breakevenPenalty: 0.10 };
const LOQ_DT_WEIGHTS = { lambda: 0.30, gammaEff: 0.35, gammaThetaRatio: 0.20, thetaBurn: -0.05, breakevenPenalty: 0.05, penaltyMult: 0.2 };

const calculateLOQRaw = (zLambda, zGammaEff, zThetaBurn, ivAdjustment, deltaBonus = 0, thetaBurn = 0, isDayTrade = false, zGammaThetaRatio = 0, breakevenPenalty = 0) => {
    const thetaPenalty = getThetaPenalty(thetaBurn);

    if (isDayTrade) {
        return (
            LOQ_DT_WEIGHTS.lambda * zLambda +
            LOQ_DT_WEIGHTS.gammaEff * zGammaEff +
            LOQ_DT_WEIGHTS.gammaThetaRatio * zGammaThetaRatio +
            LOQ_DT_WEIGHTS.thetaBurn * zThetaBurn +
            LOQ_WEIGHTS.deltaBonus * deltaBonus +
            LOQ_DT_WEIGHTS.breakevenPenalty * breakevenPenalty +
            ivAdjustment -
            thetaPenalty * LOQ_DT_WEIGHTS.penaltyMult
        );
    }

    return (
        LOQ_WEIGHTS.lambda * zLambda +
        LOQ_WEIGHTS.gammaEff * zGammaEff +
        LOQ_WEIGHTS.gammaThetaRatio * zGammaThetaRatio +
        LOQ_WEIGHTS.thetaBurn * zThetaBurn +
        LOQ_WEIGHTS.deltaBonus * deltaBonus +
        LOQ_WEIGHTS.breakevenPenalty * breakevenPenalty +
        ivAdjustment -
        thetaPenalty
    );
};

const CSQ_WEIGHTS = { edge: 0.50, pop: 0.30, spread: -0.20 };

const calculateCSQRaw = (zEdge, zPOP, zSpread, ivAdjustment) => {
    return CSQ_WEIGHTS.edge * zEdge + CSQ_WEIGHTS.pop * zPOP + CSQ_WEIGHTS.spread * zSpread + ivAdjustment;
};

// ────────────────────────────────────────────────────────────────
// Score Normalization
// ────────────────────────────────────────────────────────────────

const normalizeScoreTo100 = (rawScore) => {
    const scaled = 50 + rawScore * 12.5;
    return Math.max(0, Math.min(100, Math.round(scaled)));
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

// ────────────────────────────────────────────────────────────────
// OCC Symbol Parser
// ────────────────────────────────────────────────────────────────

/**
 * Parse raw CBOE options array into a normalized chain.
 * Optionally filters by DTE bucket via targetDTE.
 */
const parseChain = (options, currentPrice, targetDTE = null) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const minStrike = currentPrice * 0.85;
    const maxStrike = currentPrice * 1.15;

    const result = [];

    for (const opt of options) {
        const symbol = opt.option || '';
        const dateMatch = symbol.match(/(\d{6})[CP]/);
        let dte = 30;
        let expiration = '';

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
        const strike = strikeMatch ? parseInt(strikeMatch[1]) / 1000 : 0;

        // Early strike range filter
        if (strike < minStrike || strike > maxStrike) continue;

        const type = symbol.includes('C') && symbol.match(/\d{6}C/) ? 'Call' : 'Put';

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
            bid: opt.bid || 0,
            ask: opt.ask || 0,
            delta: opt.delta || 0,
            gamma: opt.gamma || 0,
            theta: opt.theta || 0,
            vega: opt.vega || 0,
            iv: opt.iv || 0,
            volume: opt.volume || 0,
            openInterest: opt.open_interest || 0,
        });
    }

    return result;
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
    getIVRiskFactor,
    getIVAdjustment,
    calculateLOQRaw,
    calculateCSQRaw,
    normalizeScoreTo100,
    calculateSpreadPct,
    calculateExpectedValue,
    getCleanATM_IV,
    calculateTargetIV,
    parseChain,
    LOQ_WEIGHTS,
    LOQ_DT_WEIGHTS,
    CSQ_WEIGHTS,
};
