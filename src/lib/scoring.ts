/**
 * Options Scoring System (OSS) v2.3
 * ═══════════════════════════════════════════════════════════════
 * Re-exports core algorithms from oss-core.ts and provides
 * higher-level batch scoring + IV term structure analysis.
 *
 * All primitive scoring functions live in oss-core.ts.
 * ═══════════════════════════════════════════════════════════════
 */

// ────────────────────────────────────────────────────────────────
// Re-export core algorithms (Single Source of Truth)
// ────────────────────────────────────────────────────────────────
export {
    // Types
    type Strategy,
    type CreditSpreadMetrics,
    type DebitSpreadMetrics,

    // Math primitives
    lerp,
    sigmoid,

    // Metric calculations
    compressLambda,
    calculateLambda,
    calculateGammaEfficiency,
    calculateThetaBurn,
    calculateGammaThetaRatio,
    calculateBreakevenMove,
    getBreakevenPenalty,
    getThetaPenalty,
    calculatePOP,
    calculateSellerEdge,
    calculateExpectedValue,
    calculateSpreadPct,

    // Delta Bonus (LERP v2.1)
    getDeltaBonus,

    // Z-Score
    normalizeToZScores,
    normalizeToZScoresByBucket,

    // Hard filter defaults & DTE buckets
    HARD_FILTER_DEFAULTS,
    DTE_BUCKETS,
    MIN_BUCKET_SIZE,

    // IV
    getIVRiskFactor,
    getIVAdjustment,
    getIVRankAdjustment,
    getRelativeIVAdjustmentLOQ,
    getRelativeIVAdjustmentCSQ,

    // LOQ / CSQ scoring (v2.4 Vega)
    LOQ_WEIGHTS,
    LOQ_DT_WEIGHTS,
    LOQ_VEGA_EFF_WEIGHT_POS,
    LOQ_VEGA_EFF_WEIGHT_NEG,
    CSQ_VEGA_PENALTY_WEIGHT,
    getLOQWeightsForDTE,
    type LOQWeightsForDTE,
    CSQ_WEIGHTS,
    calculateLOQRaw,
    calculateCSQRaw,
    normalizeScoreTo100,
    normalizeLOQScoresWithDynamicBaseline,

    // Single-position scoring
    calculateSingleLOQ,
    calculateSingleLOQWithFactors,

    // Spread scoring
    calculateCreditSpreadScore,
    calculateDebitSpreadScore,
} from './oss-core';

// ────────────────────────────────────────────────────────────────
// Local imports for batch functions
// ────────────────────────────────────────────────────────────────
import {
    compressLambda as _compressLambda,
    calculateLambda as _calculateLambda,
    calculateGammaEfficiency as _calculateGammaEfficiency,
    calculateThetaBurn as _calculateThetaBurn,
    calculateGammaThetaRatio as _calculateGammaThetaRatio,
    calculateBreakevenMove as _calculateBreakevenMove,
    getBreakevenPenalty as _getBreakevenPenalty,
    calculatePOP as _calculatePOP,
    calculateSellerEdge as _calculateSellerEdge,
    calculateSpreadPct as _calculateSpreadPct,
    getDeltaBonus as _getDeltaBonus,
    normalizeToZScores as _normalizeToZScores,
    normalizeToZScoresByBucket as _normalizeToZScoresByBucket,
    HARD_FILTER_DEFAULTS as _HARD_FILTER_DEFAULTS,
    getIVAdjustment as _getIVAdjustment,
    getRelativeIVAdjustmentLOQ as _getRelativeIVAdjustmentLOQ,
    getRelativeIVAdjustmentCSQ as _getRelativeIVAdjustmentCSQ,
    calculateLOQRaw as _calculateLOQRaw,
    calculateCSQRaw as _calculateCSQRaw,
    normalizeScoreTo100 as _normalizeScoreTo100,
    normalizeLOQScoresWithDynamicBaseline as _normalizeLOQScoresWithDynamicBaseline,
    getLOQWeightsForDTE as _getLOQWeightsForDTE,
    getThetaPenalty as _getThetaPenalty,
    getLOQVegaWeight as _getLOQVegaWeight,
    type Strategy as StrategyType,
} from './oss-core';

// ────────────────────────────────────────────────────────────────
// Types (kept here for backward compatibility)
// ────────────────────────────────────────────────────────────────

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
    gammaThetaRatio: number;
    breakevenMove: number;
}

export interface SellerMetrics {
    pop: number;
    edge: number;
    spreadPct: number;
}

export interface ScoredOption {
    option: OptionData;
    metrics: RawMetrics | SellerMetrics;
    zScores: Record<string, number>;
    score: number;
}

// ────────────────────────────────────────────────────────────────
// IV Term Structure: 4-Card Method (frontend version)
// ────────────────────────────────────────────────────────────────

export interface IVTermResult {
    ivRatio: number;
    iv30: number | null;
    iv90: number | null;
    status: 'contango' | 'neutral' | 'backwardation';
}

/**
 * Find ATM IV for a target DTE using linear interpolation between expirations.
 *
 * Instead of requiring an expiration within ±10 DTE (which fails for ~30% of tickers
 * without weekly options), we find the two nearest expirations bracketing the target DTE
 * and linearly interpolate IV between them.
 *
 * Example: expirations at 75 DTE (IV=28%) and 105 DTE (IV=24%)
 *   IV90 = lerp(75→105, 28%→24%, target=90) ≈ 26.5%
 */
function getATMIV(
    chain: OptionData[],
    currentPrice: number,
    targetDTE: number,
): number | null {
    // Get ATM IV per unique expiration (using closest-to-ATM call strike)
    const expirationMap = new Map<number, number>(); // dte → atm IV
    const calls = chain.filter(opt => opt.type === 'Call');
    // Group by DTE bucket (round to whole days to merge minor DTE rounding differences)
    for (const opt of calls) {
        const dte = Math.round(opt.dte);
        if (!expirationMap.has(dte)) {
            expirationMap.set(dte, Infinity); // sentinel
        }
        // Track the option closest to ATM for this expiration
        const distCurrent = Math.abs(opt.strike - currentPrice);
        const bestDistKey = `${dte}_dist`;
        const stored = (expirationMap as any)[bestDistKey] ?? Infinity;
        if (distCurrent < stored) {
            (expirationMap as any)[bestDistKey] = distCurrent;
            expirationMap.set(dte, opt.iv);
        }
    }

    const sortedDTEs = Array.from(expirationMap.keys()).sort((a, b) => a - b);
    if (sortedDTEs.length === 0) return null;

    // Exact or very close match (within 3 days) — no need to interpolate
    const exact = sortedDTEs.find(d => Math.abs(d - targetDTE) <= 3);
    if (exact !== undefined) return expirationMap.get(exact) ?? null;

    // Variance-based interpolation between the two bracketing expirations
    // Variance = σ²·T/252 is linear in calendar time; interpolating in variance space
    // avoids overstating IV in backwardation (linear would give 25% vs correct 22.4%).
    const below = sortedDTEs.filter(d => d < targetDTE);
    const above = sortedDTEs.filter(d => d > targetDTE);
    if (below.length > 0 && above.length > 0) {
        const d1 = below[below.length - 1];
        const d2 = above[0];
        const iv1 = expirationMap.get(d1)!;
        const iv2 = expirationMap.get(d2)!;
        const varNear = iv1 * iv1 * d1 / 252;
        const varFar  = iv2 * iv2 * d2 / 252;
        const varTarget = varNear + (varFar - varNear) * (targetDTE - d1) / (d2 - d1);
        if (varTarget <= 0) return null;
        return Math.sqrt(varTarget * 252 / targetDTE);
    }

    // Extrapolation: use nearest available if target is outside the chain's DTE range
    if (below.length > 0) return expirationMap.get(below[below.length - 1]) ?? null;
    if (above.length > 0) return expirationMap.get(above[0]) ?? null;
    return null;
}

/**
 * Calculate IV Term Structure Ratio using 4-Card Method.
 */
export function calculateIVRatio(chain: OptionData[], currentPrice: number): IVTermResult {
    const iv30 = getATMIV(chain, currentPrice, 30);
    const iv90 = getATMIV(chain, currentPrice, 90);

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

// ────────────────────────────────────────────────────────────────
// Batch Scoring Types
// ────────────────────────────────────────────────────────────────

export interface ScanContext {
    ticker: string;
    currentPrice: number;
    ivRatio: number;
    ivStatus: 'contango' | 'neutral' | 'backwardation';
    strategy: StrategyType;
}

/** Build explainability factors for LOQ (long) raw score components. */
function buildLOQFactors(
    zLambda: number, zGammaEff: number, zThetaBurn: number,
    ivAdjustment: number, deltaBonus: number, thetaBurn: number,
    zGT: number, bePenalty: number, dte: number, zVegaEff: number
): ScoreFactor[] {
    const w = _getLOQWeightsForDTE(dte);
    const thetaPenalty = _getThetaPenalty(thetaBurn);
    const vegaWeight = _getLOQVegaWeight(dte, ivAdjustment);
    const vegaBonus = vegaWeight * zVegaEff;
    const items: ScoreFactor[] = [
        { name: 'Lambda', impact: w.lambda * zLambda, description: 'Leverage (compressed); higher in sweet spot helps.', value: undefined },
        { name: 'Gamma Eff', impact: w.gammaEff * zGammaEff, description: 'Explosiveness per dollar.', value: undefined },
        { name: 'Theta (Z)', impact: w.thetaBurn * zThetaBurn, description: 'Relative theta burn vs pool.', value: undefined },
        { name: 'G/T Ratio', impact: w.gammaThetaRatio * zGT, description: 'Gamma per unit theta (cost of gamma).', value: undefined },
        { name: 'Delta Bonus', impact: w.deltaBonus * deltaBonus, description: 'Strike alignment; sweet spot 0.30–0.50.', value: undefined },
        { name: 'BE Penalty', impact: w.breakevenPenalty * bePenalty, description: 'Breakeven difficulty (DTE-adjusted).', value: undefined },
        { name: 'IV / Term', impact: ivAdjustment, description: 'IV term structure vs strategy (contango/backwardation).', value: undefined },
        { name: 'Theta Penalty', impact: -thetaPenalty * w.penaltyMult, description: 'Time decay penalty.', value: thetaBurn !== 0 ? `${(thetaBurn * 100).toFixed(2)}%/day` : undefined },
        { name: 'Vega', impact: vegaBonus, description: 'Vega exposure; DTE-adaptive weight.', value: undefined },
    ];
    return items.filter(f => Math.abs(f.impact) > 0.01).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)).slice(0, 8);
}

/** Build explainability factors for CSQ (short) raw score components. */
function buildCSQFactors(
    zEdge: number, zPOP: number, zSpread: number,
    ivAdjustment: number, vegaPenalty: number
): ScoreFactor[] {
    const { edge: we, pop: wp, spread: ws } = { edge: 0.50, pop: 0.30, spread: -0.20 };
    const items: ScoreFactor[] = [
        { name: 'Edge', impact: we * zEdge, description: "Seller's expected win amount.", value: undefined },
        { name: 'POP', impact: wp * zPOP, description: 'Probability of profit.', value: undefined },
        { name: 'Spread%', impact: ws * zSpread, description: 'Tighter spread improves score.', value: undefined },
        { name: 'IV / Term', impact: ivAdjustment, description: 'Regime/term structure alignment.', value: undefined },
        { name: 'Vega Penalty', impact: vegaPenalty, description: 'High vega/premium penalized for sellers.', value: undefined },
    ];
    return items.filter(f => Math.abs(f.impact) > 0.01).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)).slice(0, 6);
}

/** Factor for structured explainability (P1-5). Impact = points added or subtracted. */
export interface ScoreFactor {
    name: string;
    impact: number;
    description: string;
    value?: string | number;
}

export interface ScoredResult {
    symbol: string;
    strike: number;
    type: 'Call' | 'Put';
    expiration: string;
    dte: number;
    price: number;
    score: number;
    /** Top contributors and penalties (explainability). */
    factors?: ScoreFactor[];
    metrics: {
        lambda?: number;
        gammaEff?: number;
        thetaBurn?: number;
        gammaThetaRatio?: number;
        breakevenMove?: number;
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

// ────────────────────────────────────────────────────────────────
// Discriminated processed types (eliminate `as any`)
// ────────────────────────────────────────────────────────────────

interface ProcessedBase {
    opt: OptionData;
    mid: number;
    spreadPct: number;
}

interface ProcessedLong extends ProcessedBase {
    strategy: 'long';
    lambda: number;
    gammaEff: number;
    thetaBurn: number;
    gammaThetaRatio: number;
    breakevenMove: number;
}

interface ProcessedShort extends ProcessedBase {
    strategy: 'short';
    pop: number;
    edge: number;
}

type ProcessedOption = ProcessedLong | ProcessedShort;

// ────────────────────────────────────────────────────────────────
// Batch Scoring
// ────────────────────────────────────────────────────────────────

export interface ScanFilters {
    dteMin?: number;
    dteMax?: number;
    strikeRangePercent?: number;
    minVolume?: number;
    maxSpreadPct?: number;
    isDayTrade?: boolean;
    minMid?: number;
    minOpenInterest?: number;
}

/**
 * Score all options in a chain for a given strategy.
 * Now supports Day Trade mode and uses Lambda compression.
 */
export function scoreOptionsChain(
    chain: OptionData[],
    currentPrice: number,
    strategy: StrategyType,
    filters: ScanFilters = {}
): { context: ScanContext; results: ScoredResult[] } {

    const {
        dteMin = 20,
        dteMax = 60,
        strikeRangePercent = 0.30,
        minVolume = 50,
        maxSpreadPct = 0.10,
        isDayTrade = false,
        minMid = _HARD_FILTER_DEFAULTS.minMid,
        minOpenInterest = _HARD_FILTER_DEFAULTS.minOpenInterest,
    } = filters;

    const effectiveMaxSpreadPct = Math.min(maxSpreadPct, _HARD_FILTER_DEFAULTS.maxSpreadPctCeiling);

    const ivResult = calculateIVRatio(chain, currentPrice);
    const ivAdjustment = _getIVAdjustment(ivResult.ivRatio, strategy);

    const minStrike = currentPrice * (1 - strikeRangePercent);
    const maxStrike = currentPrice * (1 + strikeRangePercent);

    // Single-pass filter + metric calculation
    const processed: ProcessedOption[] = [];

    for (const opt of chain) {
        if (opt.dte < dteMin || opt.dte > dteMax) continue;
        if (opt.strike < minStrike || opt.strike > maxStrike) continue;
        if (opt.volume < minVolume) continue;
        if (opt.bid <= 0 || opt.ask <= 0) continue;

        const mid = (opt.bid + opt.ask) / 2;
        if (mid <= 0) continue;
        if (mid < minMid) continue;
        if (opt.openInterest < minOpenInterest) continue;

        const spreadPct = _calculateSpreadPct(opt.bid, opt.ask);
        if (spreadPct > effectiveMaxSpreadPct) continue;

        if (strategy === 'long') {
            processed.push({
                strategy: 'long',
                opt,
                mid,
                spreadPct,
                lambda: _calculateLambda(opt.delta, currentPrice, mid),
                gammaEff: _calculateGammaEfficiency(opt.gamma, mid),
                thetaBurn: _calculateThetaBurn(opt.theta, mid),
                gammaThetaRatio: _calculateGammaThetaRatio(opt.gamma, opt.theta),
                breakevenMove: _calculateBreakevenMove(opt.strike, mid, currentPrice, opt.type),
            });
        } else {
            const pop = _calculatePOP(opt.delta);
            processed.push({
                strategy: 'short',
                opt,
                mid,
                spreadPct,
                pop,
                edge: _calculateSellerEdge(pop, mid),
            });
        }
    }

    if (processed.length === 0) {
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

    let scored: ScoredResult[];

    if (strategy === 'long') {
        const longItems = processed as ProcessedLong[];

        // Apply Lambda compression before Z-Score normalization
        const compressedLambdas = longItems.map(p => _compressLambda(p.lambda));
        const gammas = longItems.map(p => p.gammaEff);
        const thetas = longItems.map(p => p.thetaBurn);
        const gtRatios = longItems.map(p => p.gammaThetaRatio);
        const dtes = longItems.map(p => p.opt.dte);
        const vegaEfficiencies = longItems.map(p => (p.opt.vega ?? 0) / (p.mid || 0.01));

        const zLambdas = _normalizeToZScoresByBucket(compressedLambdas, dtes);
        const zGammas = _normalizeToZScoresByBucket(gammas, dtes);
        const zThetas = _normalizeToZScoresByBucket(thetas, dtes);
        const zGTRatios = _normalizeToZScoresByBucket(gtRatios, dtes);
        const zVegaEff = _normalizeToZScoresByBucket(vegaEfficiencies, dtes);

        const rawScores = longItems.map((p, i) => {
            const atmIV = getATMIV(chain, currentPrice, p.opt.dte);
            const relIvAdj = _getRelativeIVAdjustmentLOQ(p.opt.iv, atmIV);
            const deltaBonus = _getDeltaBonus(p.opt.delta);
            const bePenalty = _getBreakevenPenalty(p.breakevenMove, p.opt.dte);
            return _calculateLOQRaw(
                zLambdas[i], zGammas[i], zThetas[i],
                ivAdjustment + relIvAdj, deltaBonus, p.thetaBurn, isDayTrade, zGTRatios[i], bePenalty, p.opt.dte, zVegaEff[i]
            );
        });
        const loqScores = _normalizeLOQScoresWithDynamicBaseline(rawScores);

        scored = longItems.map((p, i) => {
            const score = loqScores[i];
            const atmIV = getATMIV(chain, currentPrice, p.opt.dte);
            const relIvAdj = _getRelativeIVAdjustmentLOQ(p.opt.iv, atmIV);
            const deltaBonus = _getDeltaBonus(p.opt.delta);
            const bePenalty = _getBreakevenPenalty(p.breakevenMove, p.opt.dte);
            const factors = buildLOQFactors(
                zLambdas[i], zGammas[i], zThetas[i],
                ivAdjustment + relIvAdj, deltaBonus, p.thetaBurn,
                zGTRatios[i], bePenalty, p.opt.dte, zVegaEff[i]
            );
            return {
                symbol: p.opt.symbol,
                strike: p.opt.strike,
                type: p.opt.type,
                expiration: p.opt.expiration,
                dte: p.opt.dte,
                price: p.mid,
                score,
                factors,
                metrics: {
                    lambda: p.lambda,
                    gammaEff: p.gammaEff,
                    thetaBurn: p.thetaBurn,
                    gammaThetaRatio: p.gammaThetaRatio,
                    breakevenMove: p.breakevenMove,
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
        const shortItems = processed as ProcessedShort[];

        const edges = shortItems.map(p => p.edge);
        const pops = shortItems.map(p => p.pop);
        const spreads = shortItems.map(p => p.spreadPct);
        const dtes = shortItems.map(p => p.opt.dte);
        const vegaEfficiencies = shortItems.map(p => (p.opt.vega ?? 0) / (p.mid || 0.01));

        const zEdges = _normalizeToZScoresByBucket(edges, dtes);
        const zPops = _normalizeToZScoresByBucket(pops, dtes);
        const zSpreads = _normalizeToZScoresByBucket(spreads, dtes);
        const zVegaEff = _normalizeToZScoresByBucket(vegaEfficiencies, dtes);

        scored = shortItems.map((p, i) => {
            const atmIV = getATMIV(chain, currentPrice, p.opt.dte);
            const relIvAdj = _getRelativeIVAdjustmentCSQ(p.opt.iv, atmIV);
            const vegaPenalty = -0.05 * zVegaEff[i];
            const rawScore = _calculateCSQRaw(zEdges[i], zPops[i], zSpreads[i], ivAdjustment + relIvAdj, vegaPenalty);
            const score = _normalizeScoreTo100(rawScore);
            const factors = buildCSQFactors(
                zEdges[i], zPops[i], zSpreads[i],
                ivAdjustment + relIvAdj, vegaPenalty
            );
            return {
                symbol: p.opt.symbol,
                strike: p.opt.strike,
                type: p.opt.type,
                expiration: p.opt.expiration,
                dte: p.opt.dte,
                price: p.mid,
                score,
                factors,
                metrics: {
                    pop: p.pop,
                    edge: p.edge,
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

    scored.sort((a, b) => b.score - a.score);

    return {
        context: {
            ticker: chain[0]?.symbol?.slice(0, 6).trim() || '',
            currentPrice,
            ivRatio: ivResult.ivRatio,
            ivStatus: ivResult.status,
            strategy
        },
        results: scored
    };
}
