/**
 * Options Scoring System (OSS) v2.1
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
    getThetaPenalty,
    calculatePOP,
    calculateSellerEdge,
    calculateSpreadPct,

    // Delta Bonus (LERP v2.1)
    getDeltaBonus,

    // Z-Score
    normalizeToZScores,

    // IV
    getIVRiskFactor,
    getIVAdjustment,

    // LOQ / CSQ scoring
    LOQ_WEIGHTS,
    LOQ_DT_WEIGHTS,
    CSQ_WEIGHTS,
    calculateLOQRaw,
    calculateCSQRaw,
    normalizeScoreTo100,

    // Single-position scoring
    calculateSingleLOQ,

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
    calculatePOP as _calculatePOP,
    calculateSellerEdge as _calculateSellerEdge,
    calculateSpreadPct as _calculateSpreadPct,
    getDeltaBonus as _getDeltaBonus,
    normalizeToZScores as _normalizeToZScores,
    getIVAdjustment as _getIVAdjustment,
    calculateLOQRaw as _calculateLOQRaw,
    calculateCSQRaw as _calculateCSQRaw,
    normalizeScoreTo100 as _normalizeScoreTo100,
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
 * Find ATM IV for a target DTE.
 * Uses Call-only with DTE tolerance and strike bracketing.
 */
function getATMIV(
    chain: OptionData[],
    currentPrice: number,
    targetDTE: number,
    tolerance: number = 10
): number | null {
    const candidates = chain.filter(
        opt => opt.type === 'Call' && Math.abs(opt.dte - targetDTE) <= tolerance
    );

    if (candidates.length < 2) return null;

    candidates.sort((a, b) => a.strike - b.strike);

    for (let i = 0; i < candidates.length - 1; i++) {
        if (candidates[i].strike <= currentPrice && candidates[i + 1].strike >= currentPrice) {
            return (candidates[i].iv + candidates[i + 1].iv) / 2;
        }
    }

    const closest = candidates.reduce((prev, curr) =>
        Math.abs(curr.strike - currentPrice) < Math.abs(prev.strike - currentPrice) ? curr : prev
    );
    return closest.iv;
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
    } = filters;

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

        const spreadPct = _calculateSpreadPct(opt.bid, opt.ask);
        if (spreadPct > maxSpreadPct) continue;

        if (strategy === 'long') {
            processed.push({
                strategy: 'long',
                opt,
                mid,
                spreadPct,
                lambda: _calculateLambda(opt.delta, currentPrice, mid),
                gammaEff: _calculateGammaEfficiency(opt.gamma, mid),
                thetaBurn: _calculateThetaBurn(opt.theta, mid),
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

        const zLambdas = _normalizeToZScores(compressedLambdas);
        const zGammas = _normalizeToZScores(gammas);
        const zThetas = _normalizeToZScores(thetas);

        scored = longItems.map((p, i) => {
            const deltaBonus = _getDeltaBonus(p.opt.delta);
            const rawScore = _calculateLOQRaw(
                zLambdas[i], zGammas[i], zThetas[i],
                ivAdjustment, deltaBonus, p.thetaBurn, isDayTrade
            );
            const score = _normalizeScoreTo100(rawScore);

            return {
                symbol: p.opt.symbol,
                strike: p.opt.strike,
                type: p.opt.type,
                expiration: p.opt.expiration,
                dte: p.opt.dte,
                price: p.mid,
                score,
                metrics: {
                    lambda: p.lambda,
                    gammaEff: p.gammaEff,
                    thetaBurn: p.thetaBurn,
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

        const zEdges = _normalizeToZScores(edges);
        const zPops = _normalizeToZScores(pops);
        const zSpreads = _normalizeToZScores(spreads);

        scored = shortItems.map((p, i) => {
            const rawScore = _calculateCSQRaw(zEdges[i], zPops[i], zSpreads[i], ivAdjustment);
            const score = _normalizeScoreTo100(rawScore);

            return {
                symbol: p.opt.symbol,
                strike: p.opt.strike,
                type: p.opt.type,
                expiration: p.opt.expiration,
                dte: p.opt.dte,
                price: p.mid,
                score,
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
