// api/strategy-recommend.js
// Strategy Recommender API - Intelligent Options Strategy Selection
// Based on IV Regime and User Direction (BULL/BEAR)
// Uses shared scoring module (Single Source of Truth)
// Modules loaded inside handler via dynamic import() so failures return JSON on Vercel.

import fs from 'fs';
import path from 'path';
import { getAppSettings } from './_shared/getAppSettings.js';

// ── Inline BSM helper (no external dep) ──────────────────────────────────────
// Normal CDF approximation (Abramowitz & Stegun, max error 7.5e-8)
function _normCDF(x) {
    if (x < -8) return 0;
    if (x > 8) return 1;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1.0 / (1.0 + p * Math.abs(x));
    const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
    const cdf = 1.0 - poly * Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
    return 0.5 * (1.0 + sign * (2 * cdf - 1));
}
/**
 * BSM N(d2): risk-neutral probability a call expires ITM.
 * For puts: P(ITM) = 1 - bsmN2(S, K, T, sigma)
 * d2 = (ln(S/K) - 0.5*σ²*T) / (σ*√T)  [r≈0]
 */
function _bsmN2(S, K, T, sigma) {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0.5;
    const d2 = (Math.log(S / K) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
    return _normCDF(d2);
}
// ─────────────────────────────────────────────────────────────────────────────

// #region agent log
function _dbg(payload) {
    try {
        const logPath = path.join(process.cwd(), '.cursor', 'debug.log');
        fs.appendFileSync(logPath, JSON.stringify({ ...payload, timestamp: Date.now() }) + '\n');
    } catch (_) { }
}
// #endregion

let compressLambda, calculateDollarGamma, calculateGammaThetaRatio, calculateBreakevenMove, getBreakevenPenalty,
    calculateExpectedValue, getThetaPenalty, getDeltaBonus, zScores, zScoresByBucket, HARD_FILTER_DEFAULTS, HARD_FILTER_CREDIT,
    getIVRiskFactor, getIVAdjustment, getIVRankAdjustment, getVolForecastAdjustment, getRelativeIVAdjustmentLOQ, getRelativeIVAdjustmentCSQ,
    calculateLOQRaw, normalizeScoreTo100, normalizeLOQScoresWithDynamicBaseline, calculateSpreadPct,
    getCleanATM_IV, calculateTargetIV, buildIVTermStructure, parseChain, calculateSkew, estimateSlippage, getGammaRiskPenalty,
    getSkewBonusForCreditSpread, calculateUnifiedScore;
let saveTickerIVSnapshot;
let _scoringLoaded = false;

async function ensureScoring() {
    if (_scoringLoaded) return;
    const scoringUrl = new URL('../lib/_shared/scoring.cjs', import.meta.url).href;
    const scoringMod = await import(scoringUrl);
    const scoring = scoringMod.default ?? scoringMod;
    if (!scoring || typeof scoring.compressLambda !== 'function') {
        throw new Error('Scoring module load failed: missing exports');
    }
    compressLambda = scoring.compressLambda;
    calculateDollarGamma = scoring.calculateDollarGamma;
    calculateGammaThetaRatio = scoring.calculateGammaThetaRatio;
    calculateBreakevenMove = scoring.calculateBreakevenMove;
    getBreakevenPenalty = scoring.getBreakevenPenalty;
    calculateExpectedValue = scoring.calculateExpectedValue;
    getThetaPenalty = scoring.getThetaPenalty;
    getDeltaBonus = scoring.getDeltaBonus;
    zScores = scoring.zScores;
    zScoresByBucket = scoring.zScoresByBucket;
    HARD_FILTER_DEFAULTS = scoring.HARD_FILTER_DEFAULTS;
    HARD_FILTER_CREDIT = scoring.HARD_FILTER_CREDIT;
    getIVRiskFactor = scoring.getIVRiskFactor;
    getIVAdjustment = scoring.getIVAdjustment;
    getIVRankAdjustment = scoring.getIVRankAdjustment;
    getVolForecastAdjustment = scoring.getVolForecastAdjustment;
    getRelativeIVAdjustmentLOQ = scoring.getRelativeIVAdjustmentLOQ;
    getRelativeIVAdjustmentCSQ = scoring.getRelativeIVAdjustmentCSQ;
    calculateLOQRaw = scoring.calculateLOQRaw;
    normalizeScoreTo100 = scoring.normalizeScoreTo100;
    normalizeLOQScoresWithDynamicBaseline = scoring.normalizeLOQScoresWithDynamicBaseline;
    calculateSpreadPct = scoring.calculateSpreadPct;
    getCleanATM_IV = scoring.getCleanATM_IV;
    calculateTargetIV = scoring.calculateTargetIV;
    buildIVTermStructure = scoring.buildIVTermStructure;
    parseChain = scoring.parseChain;
    calculateSkew = scoring.calculateSkew;
    estimateSlippage = scoring.estimateSlippage;
    getGammaRiskPenalty = scoring.getGammaRiskPenalty;
    getSkewBonusForCreditSpread = scoring.getSkewBonusForCreditSpread;
    calculateUnifiedScore = scoring.calculateUnifiedScore;
    try {
        const ivUrl = new URL('../lib/_shared/ivHistory.cjs', import.meta.url).href;
        const ivMod = await import(ivUrl);
        const iv = ivMod.default ?? ivMod;
        saveTickerIVSnapshot = iv.saveTickerIVSnapshot;
    } catch (_) {
        saveTickerIVSnapshot = async () => { };
    }
    _scoringLoaded = true;
}

// =============================================================================
// DATA FETCHING UTILITIES
// =============================================================================
// RV (Realized Volatility): prefer ORATS cores (orHv30d), fallback to manual
// computation from Tiingo candles: log returns → population variance (÷N) → annualize (sqrt(252)*100).
//
// NOTE (F13 — Forensic Audit v1.1): We use ÷N (population variance), not ÷N-1
// (Bessel correction). This is consistent with market convention — most vol desks,
// Bloomberg HIVG, CBOE VIX methodology, and risk systems use ÷N. The ÷N-1 correction
// upward-biases RV30 by ~3% for N=30, making IV/RV ratios look lower than market standard
// and weakly biasing regime detection toward DEBIT. For N=30, the difference is small
// (sqrt(30/29) ≈ 1.017) but systematic.

/**
 * Shared RV30 computation from an array of closing prices.
 * Uses population variance (÷N) — market convention for realized vol.
 * @param {number[]} closes Array of closing prices (chronological order)
 * @returns {number|null} Annualized RV as % (e.g., 25.5 = 25.5%), or null if insufficient data
 */
function _computeRV30(closes) {
    if (!closes || closes.length < 11) return null; // Need at least 11 prices for 10 returns
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
        returns.push(Math.log(closes[i] / closes[i - 1]));
    }
    const recentReturns = returns.slice(-30);
    if (recentReturns.length < 10) return null;
    const n = recentReturns.length;
    const mean = recentReturns.reduce((a, b) => a + b, 0) / n;
    // Population variance: ÷N — consistent with market convention for realized vol
    // (Most vol desks and risk systems use ÷N; the ÷(N-1) Bessel correction upward-biases
    // RV30 by ~3%, making IV/RV ratios look slightly lower than they are and weakly
    // biasing regime detection toward DEBIT.)
    const variance = recentReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    return Math.sqrt(variance * 252) * 100;
}

/**
 * Derive underlying stock price from put-call parity on the option chain.
 * S ≈ call_mid - put_mid + strike (for ATM options with same strike/expiry).
 * Returns derived price if within 10% of lastClose, else null.
 */
function _derivePriceFromPutCallParity(chainData, lastClose) {
    if (!chainData || chainData.length === 0 || !lastClose) return null;

    // Group by strike+expiry, find pairs with both Call and Put
    // Note: ORATS uses 'expiration', CBOE uses 'expiry' — handle both
    const pairs = {};
    for (const o of chainData) {
        const exp = o.expiration || o.expiry;
        if (!o.strike || !exp) continue;
        // Skip very short or very long DTE
        const dte = o.dte ?? 0;
        if (dte < 7 || dte > 60) continue;
        const key = `${o.strike}_${exp}`;
        if (!pairs[key]) pairs[key] = { strike: o.strike, expiry: exp, dte };
        if (o.type === 'call' || o.type === 'Call') pairs[key].call = o;
        if (o.type === 'put' || o.type === 'Put') pairs[key].put = o;
    }

    // Find the pair closest to lastClose with valid prices on both sides
    let bestPair = null;
    let bestDist = Infinity;
    for (const p of Object.values(pairs)) {
        if (!p.call || !p.put) continue;
        const callMid = _getMid(p.call);
        const putMid = _getMid(p.put);
        if (callMid <= 0 || putMid <= 0) continue;
        const dist = Math.abs(p.strike - lastClose);
        if (dist < bestDist) {
            bestDist = dist;
            bestPair = { ...p, callMid, putMid };
        }
    }

    if (!bestPair) return null;

    // Put-call parity: S = C - P + K (ignoring dividends/interest for short DTE)
    const derived = bestPair.callMid - bestPair.putMid + bestPair.strike;

    // Sanity check: within 10% of lastClose
    if (Math.abs(derived - lastClose) / lastClose > 0.10) return null;

    return Number(derived.toFixed(2));
}

function _getMid(opt) {
    if (opt.mid > 0) return opt.mid;
    if (opt.bid > 0 && opt.ask > 0) return (opt.bid + opt.ask) / 2;
    if (opt.last > 0) return opt.last;
    if (opt.close > 0) return opt.close;
    return 0;
}

/**
 * Calculate 30-day Realized Volatility from Tiingo daily candles.
 * @param {string} ticker Stock symbol
 * @returns {Promise<number|null>} RV30 as annualized % (e.g., 25.5 = 25.5%) or null on failure
 */
async function calculateRV30FromCandles(ticker) {
    try {
        const { getCandles } = await import('../lib/tiingo-client.js');

        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(toDate.getDate() - 60); // Fetch 60 days to ensure enough trading days
        const toStr = toDate.toISOString().split('T')[0];
        const fromStr = fromDate.toISOString().split('T')[0];

        const candles = await getCandles(ticker, fromStr, toStr, 'day');
        if (!candles || candles.length < 10) return null;

        const closes = candles.map(c => c.close);
        const rv30 = _computeRV30(closes);
        if (rv30 != null) console.log(`[RV30 Calc] ${ticker}: ${rv30.toFixed(2)}% (from Tiingo)`);
        return rv30;
    } catch (e) {
        console.error("RV30 Calculation Error (Tiingo):", e);
        return null;
    }
}

/**
 * Fallback: compute RV30 ourselves from Nasdaq historical prices (same formula as above).
 * Used when ORATS cores and Tiingo are unavailable. Still our own calculation, not an API RV field.
 * Handles multiple response shapes (tradesTable.rows, close/Close).
 * @param {string} ticker Stock symbol
 * @returns {Promise<number|null>} RV30 as annualized % or null
 */
async function fetchRV30FromNasdaq(ticker) {
    try {
        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(toDate.getDate() - 45);
        const toStr = toDate.toISOString().split('T')[0];
        const fromStr = fromDate.toISOString().split('T')[0];
        const url = `https://api.nasdaq.com/api/quote/${ticker.toUpperCase()}/historical?assetclass=stocks&fromdate=${fromStr}&todate=${toStr}&limit=40`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        if (!response.ok) {
            console.warn(`[RV30 Nasdaq] ${ticker}: HTTP ${response.status}`);
            return null;
        }
        const data = await response.json();
        const rows = data?.data?.tradesTable?.rows || data?.data?.historicalPrices?.data || (Array.isArray(data?.data) ? data.data : []);
        if (!Array.isArray(rows) || rows.length < 5) {
            console.warn(`[RV30 Nasdaq] ${ticker}: insufficient rows (${rows?.length ?? 0})`);
            return null;
        }
        const parseClose = (row) => {
            const raw = row.close ?? row.Close ?? row.closePrice ?? row.value;
            if (raw == null) return NaN;
            const s = String(raw).replace(/\$/g, '').replace(/,/g, '').trim();
            return parseFloat(s);
        };
        const prices = rows
            .map(parseClose)
            .filter(p => !isNaN(p) && p > 0);
        if (prices.length < 5) {
            console.warn(`[RV30 Nasdaq] ${ticker}: too few valid prices (${prices.length})`);
            return null;
        }
        const annualizedRV = _computeRV30(prices);
        if (annualizedRV == null) return null;
        console.log(`[RV30 Nasdaq] ${ticker}: ${annualizedRV.toFixed(2)}% (from Nasdaq)`);
        return Number(annualizedRV.toFixed(2));
    } catch (e) {
        console.error("RV30 Fallback (Nasdaq) Error:", e);
        return null;
    }
}

async function fetchEarnings(ticker) {
    try {
        const url = `https://api.nasdaq.com/api/quote/${ticker.toUpperCase()}/info?assetclass=stocks`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) return null;
        const data = await response.json();
        const notifications = data?.data?.notifications || [];

        for (const notif of notifications) {
            const eventTypes = notif?.eventTypes || [];
            for (const event of eventTypes) {
                if (event.eventName === 'Earnings Date' || event.id === 'upcoming_events') {
                    const message = event.message || '';
                    const match = message.match(/Earnings Date\s*:\s*(.+)/i);
                    if (match) {
                        const dateStr = match[1].trim().replace(/\s*(AMC|BMO)$/i, '');
                        const parsedDate = new Date(dateStr);
                        if (!isNaN(parsedDate.getTime())) {
                            const today = new Date();
                            today.setHours(0, 0, 0, 0);
                            return Math.ceil((parsedDate - today) / (1000 * 60 * 60 * 24));
                        }
                    }
                }
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

// =============================================================================
// ENTRY PROFILES — Setup → DTE peak, delta range, allowChase
// =============================================================================
// Credit spread strategy: DTE 45-65 optimal, delta 0.30-0.45, no setup dependency
const DEFAULT_ENTRY_PROFILE = { dtePeak: 55, deltaRange: [0.30, 0.45], allowChase: false };

function getEntryProfile() {
    return DEFAULT_ENTRY_PROFILE;
}

/** Term structure slope = (IV30 - IV90) / IV90. Positive = backwardation, negative = contango. */
const SLOPE_STRONG_BACK = 0.15;   // termRatio > 1.15
const SLOPE_BACK = 0.05;         // termRatio > 1.05
const SLOPE_FLAT_LO = -0.05;     // termRatio >= 0.95
const SLOPE_CONTANGO = -0.15;    // termRatio < 0.95

function detectRegime(iv30, iv90, rv30, ivHvXernRatio) {
    if (!iv30 || !iv90 || iv90 === 0) {
        return {
            ivRatio: 1.0,
            slope: null,
            slopeTier: 'flat',
            ivRvRatio: null,
            mode: 'NEUTRAL',
            advice: 'Insufficient Data for IV Ratio. Defaulting to Neutral.',
            adviceDetail: 'Not enough options data to compute IV term structure (IV30/IV90). Without it we cannot favor credit vs debit; use the scores on each strategy tab to pick.'
        };
    }

    const termRatio = iv30 / iv90;
    const slope = (iv30 - iv90) / iv90;
    const iv30Pct = iv30 * 100; // Convert to % for readability (iv30 stored as decimal, e.g. 0.30 = 30%)
    // Prefer ORATS ex-earnings IV/HV ratio (strips earnings-driven vol spikes from both IV and HV)
    // Prevents false "cheap IV" signal post-earnings when RV30 is inflated by the earnings move
    const ivRvRatio = (ivHvXernRatio != null && ivHvXernRatio > 0)
        ? ivHvXernRatio
        : (rv30 ? iv30Pct / rv30 : null);
    // VRP = IV30(%) - RV30(%) — positive means market paying premium above realized vol (seller-friendly)
    const vrp = rv30 != null ? iv30Pct - rv30 : null;

    // Absolute IV level context
    const ivLevel = iv30Pct >= 40 ? 'elevated' : iv30Pct <= 20 ? 'suppressed' : 'normal';
    const ivLevelNote = ivLevel === 'elevated'
        ? `IV30 is elevated (${iv30Pct.toFixed(1)}%): even in backwardation, buyers should be cautious of overpaying; size credit spreads carefully. `
        : ivLevel === 'suppressed'
            ? `IV30 is low (${iv30Pct.toFixed(1)}%): premiums are thin—credit spreads collect less; debit spreads are relatively cheap. `
            : '';
    const vrpNote = vrp != null
        ? vrp > 5
            ? `VRP is +${vrp.toFixed(1)}% (IV well above RV): strong seller's edge—market is paying meaningfully above recent realized vol. `
            : vrp < 0
                ? `VRP is ${vrp.toFixed(1)}% (IV below RV): vol is cheap vs recent realized—sellers have no premium edge; consider buyers or stay selective. `
                : ''
        : '';

    let slopeTier = 'flat';
    if (slope >= SLOPE_STRONG_BACK) slopeTier = 'strong_backwardation';
    else if (slope >= SLOPE_BACK) slopeTier = 'backwardation';
    else if (slope <= SLOPE_CONTANGO) slopeTier = 'strong_contango';
    else if (slope < SLOPE_FLAT_LO) slopeTier = 'contango';

    let mode = 'NEUTRAL';
    let advice = 'Neutral IV: Either strategy viable, compare scores';
    let adviceDetail = 'IV30 and IV90 are close (ratio near 1), so the term structure is flat. Neither selling nor buying volatility has a clear edge from term structure alone. Compare the scores and metrics (EV, ROI, POP, R:R) across Credit Spreads, Debit Spreads, and Long Options to choose.';
    if (ivLevelNote) adviceDetail += ' ' + ivLevelNote;
    if (vrpNote) adviceDetail += vrpNote;

    if (termRatio > 1.05) {
        mode = 'CREDIT';
        advice = slopeTier === 'strong_backwardation'
            ? 'Strong Backwardation: Favor Credit Spreads'
            : 'Backwardation (Expensive near-term): Sell Credit Spreads';
        adviceDetail = slopeTier === 'strong_backwardation'
            ? 'Term structure slope is strongly positive (IV30 well above IV90)—short-dated options are rich vs longer-dated. Selling premium (credit spreads) has a clear term-structure edge. '
            : 'Near-term IV (IV30) is higher than IV90—backwardation. Short-dated options are priced rich vs longer-dated, so selling premium (credit spreads) is favored. ';
        if (ivLevelNote) adviceDetail += ivLevelNote;
        if (vrpNote) adviceDetail += vrpNote;
        else if (ivRvRatio != null) {
            if (ivRvRatio > 1.05) {
                adviceDetail += `IV/RV is ${ivRvRatio.toFixed(2)}: the market is paying a volatility premium vs recent realized; credit spreads let you collect that premium with defined risk. `;
            } else if (ivRvRatio < 0.95) {
                adviceDetail += `IV/RV is ${ivRvRatio.toFixed(2)} (below 1): implied is cheap vs realized, so the edge for selling premium is smaller; still consider credit if term structure and other metrics (EV, POP, distance) are strong. `;
            }
        }
        adviceDetail += 'Prefer 30–45 DTE to balance theta decay and gamma risk.';
    } else if (termRatio < 0.95) {
        mode = 'DEBIT';
        advice = slopeTier === 'strong_contango'
            ? 'Strong Contango: Favor Debit Spreads / Long Options'
            : 'Contango (Cheap near-term IV): Buy Debit Spreads';
        adviceDetail = slopeTier === 'strong_contango'
            ? 'Term structure slope is strongly negative (IV30 well below IV90)—near-term options are cheap vs far-term. Buying premium (debit spreads, long options) is favored by term structure. '
            : 'IV30 is lower than IV90—contango. Near-term options are relatively cheap vs far-term (no big near-term event premium). ';
        if (ivLevelNote) adviceDetail += ivLevelNote;
        if (vrpNote) adviceDetail += vrpNote;
        else if (ivRvRatio != null) {
            if (ivRvRatio < 1) {
                adviceDetail += `IV/RV is ${ivRvRatio.toFixed(2)} (below 1): realized vol has been higher than implied, so long options can benefit from a vol or directional move without overpaying. Debit spreads reduce cost and cap risk vs a single long while keeping leverage. `;
            } else {
                adviceDetail += `IV/RV is ${ivRvRatio.toFixed(2)} (above 1): options are still priced above recent realized vol (VRP positive). Favor debit spreads selectively: long-leg delta 0.50–0.65, risk/reward ≥ 1.5, DTE 30–45. `;
            }
        }
        adviceDetail += 'Debit spreads cap risk and keep positive delta with lower capital than a naked long.';
    }

    return { ivRatio: termRatio, slope, slopeTier, ivRvRatio, vrp, ivLevel, mode, advice, adviceDetail };
}

function generateStrategyNote(strategyType, metrics) {
    const pros = [];
    const cons = [];

    // Common Metrics — full sentences for clarity
    if (metrics.ev && metrics.ev > 20) pros.push("Expected value is meaningfully positive, so the trade has a statistical edge over many repetitions.");
    if (metrics.pop && metrics.pop > 70) pros.push("Probability of profit is high (above 70%), which supports a premium-selling or defined-risk approach.");
    if (metrics.roi && metrics.roi > 30) pros.push("Return on capital at risk is strong (ROI > 30%), making the risk/reward attractive for the capital deployed.");

    // Credit Specific
    if (strategyType === 'CREDIT') {
        if (metrics.theta && metrics.theta > 0.1) pros.push("Theta decay is favorable: time works in your favor as the short option loses value.");
        if (metrics.skewBonus > 0) pros.push("Volatility skew favors this side: the options you are selling are relatively overpriced vs the hedge.");
        if (metrics.ivRvRatio > 1.25) pros.push("Implied volatility is elevated vs recent realized vol, so you are being well compensated for selling premium.");

        if (metrics.gammaPenalty < 0) cons.push("Gamma risk is elevated (typical for short-dated shorts); price moves can accelerate against you near expiry.");
        if (metrics.slippageImpact > 0.15) cons.push("Bid-ask spread or liquidity may cost a meaningful part of the credit; consider limit orders and size.");
        if (metrics.earningsRisk) cons.push("Earnings fall within the option life; consider avoiding or using a different expiration to reduce event risk.");
    }

    // Debit Specific
    if (strategyType === 'DEBIT') {
        if (metrics.lambda > 8) pros.push("Leverage (lambda) is high, so a small move in the underlying can produce a proportionally larger P&L.");
        if (metrics.ivRvRatio != null && metrics.ivRvRatio < 0.85) pros.push("Volatility is cheap relative to recent realized; long options are not overpaying for vol.");
        if (metrics.deltaBonus > 0) pros.push("Delta exposure is well aligned with your direction, giving good participation in the underlying move.");

        if (metrics.ivRvRatio != null && metrics.ivRvRatio > 1.1) cons.push("IV is above recent realized vol (you are paying VRP); prefer selective entries with R:R ≥ 1.5 and DTE 30–45.");
        if (metrics.slippageImpact > 0.15) cons.push("Wide bid-ask or low liquidity can add slippage to the debit; use limit orders and check volume/OI.");
        if (metrics.theta && metrics.theta < -0.1) cons.push("Time decay is meaningful; the position loses value if the underlying does not move enough before expiry.");
    }

    let note = "";
    if (pros.length > 0) note += `✅ Pros: ${pros.join(' ')}`;
    if (cons.length > 0) note += (note ? ' ' : '') + `⚠️ Cons: ${cons.join(' ')}`;

    return note.trim();
}

// =============================================================================
// EARNINGS IV PREMIUM ESTIMATE (Fix 3D)
// =============================================================================

/**
 * Estimate the earnings-driven IV premium for options spanning an earnings event.
 *
 * Uses variance decomposition (jump + diffusion) rather than a simple DTE scaling factor:
 *
 *   totalVar(DTE) = jumpVar + (DTE - 1) × dailyVar
 *   jumpVar  = IV² × DTE/252 - dailyVar × (DTE - 1)
 *   where dailyVar is the option's own daily diffusion variance: (IV × sqrt((DTE-1)/DTE))² / 252
 *
 *   impliedJumpMove = sqrt(jumpVar) × currentPrice
 *
 * Example: DTE=7, IV=50%
 *   Old formula: postIV = 50% × sqrt(6/7) ≈ 46.3%       (understates crush)
 *   New formula: strips full jump component → postIV ≈ 36-40%  (realistic)
 *
 * Returns null if the option doesn't span earnings or IV is unavailable.
 *
 * @param {number|null} daysUntilEarnings
 * @param {number} dte - Days to expiration of the option
 * @param {number|null} iv - Implied volatility (decimal, e.g. 0.30 = 30%)
 * @param {number} currentPrice - Underlying spot price
 * @returns {{ impliedEarningsMove: number, earningsMovePct: number, postEarningsIVEstimate: number } | null}
 */
function estimateEarningsPremium(daysUntilEarnings, dte, iv, currentPrice) {
    if (daysUntilEarnings == null || daysUntilEarnings < 0 || daysUntilEarnings > dte) return null;
    if (!iv || iv <= 0 || !currentPrice || currentPrice <= 0 || dte <= 0) return null;

    // --- Variance decomposition ---
    // Total annualized variance carried by the option over its life:
    const totalVar = iv * iv * dte / 252;                  // σ²·T (in annual units)

    // Estimate post-earnings daily variance by stripping one event-day:
    // Non-event daily variance = totalVar / DTE (uniform diffusion assumption)
    // Jump variance = totalVar − (DTE − 1) × dailyDiffusionVar
    const dailyVar = totalVar / dte;                     // uniform daily diffusion estimate
    const jumpVar = Math.max(0, totalVar - dailyVar * (dte - 1)); // can't be negative
    const diffuseVar = totalVar - jumpVar;                 // non-event total variance

    // Implied earnings move (1-SD jump, in price terms)
    const impliedEarningsMove = Math.sqrt(jumpVar) * currentPrice;  // σ_jump × S
    const earningsMovePct = Math.sqrt(jumpVar) * 100;           // as % of price

    // Post-earnings realized IV: back-solve from remaining diffusion variance
    // postIV = sqrt(diffuseVar × 252 / max(DTE-1, 1))
    const remainingDTE = Math.max(dte - 1, 1);
    const postIV = dte > 1
        ? Math.sqrt(Math.max(0, diffuseVar) * 252 / remainingDTE)
        : iv * 0.65; // flat fallback for 1 DTE (mostly just expiry-day noise)

    return {
        impliedEarningsMove: Number(impliedEarningsMove.toFixed(2)),
        earningsMovePct: Number(earningsMovePct.toFixed(2)),
        postEarningsIVEstimate: Number((postIV * 100).toFixed(1)), // as %
        daysUntilEarnings
    };
}

// =============================================================================
// STRATEGY BUILDERS
// =============================================================================



/** Get delta at or near targetStrike from chain (same type & expiration). Interpolates between strikes for POP-from-breakeven. */
function getDeltaAtStrike(chain, optionType, expiration, targetStrike) {
    const same = chain.filter(o => o.type === optionType && o.expiration === expiration);
    if (same.length === 0) return null;
    same.sort((a, b) => a.strike - b.strike);
    const below = same.filter(o => o.strike <= targetStrike);
    const above = same.filter(o => o.strike > targetStrike);
    const a = below.length ? below[below.length - 1] : same[0];
    const b = above.length ? above[0] : same[same.length - 1];
    if (a.strike === b.strike) return a.delta;
    const t = (targetStrike - a.strike) / (b.strike - a.strike);
    return a.delta + t * (b.delta - a.delta);
}

/** Get Probability ITM at or near targetStrike. Interpolates. */
function getProbITMAtStrike(chain, optionType, expiration, targetStrike) {
    const same = chain.filter(o => o.type === optionType && o.expiration === expiration);
    if (same.length === 0) return null;
    same.sort((a, b) => a.strike - b.strike);
    const below = same.filter(o => o.strike <= targetStrike);
    const above = same.filter(o => o.strike > targetStrike);
    const a = below.length ? below[below.length - 1] : same[0];
    const b = above.length ? above[0] : same[same.length - 1];

    // Check if probITM is available
    if (typeof a.probabilityITM !== 'number') return null;

    if (a.strike === b.strike) return a.probabilityITM;
    const t = (targetStrike - a.strike) / (b.strike - a.strike);
    return a.probabilityITM + t * (b.probabilityITM - a.probabilityITM);
}

function buildCreditSpreads(chain, type, currentPrice, ivRvRatio, daysUntilEarnings, skew, customWidth, ivRank = null, anomaly = false, dtePeak = 55, sampleDays = 60, volFcstAdj = 0) {
    const results = [];
    const widths = customWidth ? [customWidth] : [10, 5];
    const ivRankAdj = getIVRankAdjustment(ivRank ?? null, 'short', sampleDays);
    const atmIV = getCleanATM_IV(chain, currentPrice);

    // Rejection diagnostics
    const _diag = { ivBelow30: 0, noDeltaMatch: 0, noLongLeg: 0, noLiquidity: 0, lowOI: 0, lowBid: 0, wideSpread: 0, earningsGuard: 0, slippageKill: 0, lowROI: 0, spreadCeiling: 0 };

    const candidateShorts = chain.filter(o => o.type === type && Math.abs(o.delta) >= 0.25 && Math.abs(o.delta) <= 0.45);
    // Filter on ticker-level IV Rank (0-1), not individual option IV
    const ivRankPass = ivRank == null || ivRank >= 0.30;
    const shorts = ivRankPass ? candidateShorts : [];
    _diag.ivBelow30 = ivRankPass ? 0 : candidateShorts.length;
    _diag.noDeltaMatch = chain.filter(o => o.type === type).length - candidateShorts.length;

    for (const shortLeg of shorts) {
        for (const width of widths) {
            const longStrike = type === 'Put' ? shortLeg.strike - width : shortLeg.strike + width;
            // Find nearest strike to target; allow up to 20% tolerance on width
            const sameSideExp = chain.filter(o =>
                o.type === type && o.expiration === shortLeg.expiration
            );
            let longLeg = sameSideExp.find(o => Math.abs(o.strike - longStrike) < 0.1);
            if (!longLeg) {
                // Snap to nearest available strike within tolerance
                const maxDrift = width * 0.2; // allow 20% drift (e.g. $3 on a $15 width)
                let bestMatch = null;
                let bestDist = Infinity;
                for (const o of sameSideExp) {
                    const dist = Math.abs(o.strike - longStrike);
                    if (dist < bestDist && dist <= maxDrift) {
                        bestDist = dist;
                        bestMatch = o;
                    }
                }
                longLeg = bestMatch;
            }

            if (!longLeg) {
                _diag.noLongLeg++;
                if (_diag.noLongLeg <= 3) {
                    const availStrikes = sameSideExp.map(o => o.strike).sort((a, b) => a - b);
                    console.log(`[noLongLeg] short=$${shortLeg.strike} ${type}, need long=$${longStrike} (±${(width * 0.2).toFixed(1)}), chain strikes=[${availStrikes.slice(0, 5).join(',')}...${availStrikes.slice(-5).join(',')}] (${availStrikes.length} total)`);
                }
                continue;
            }
            // Recalculate actual width based on matched strike
            const actualWidth = Math.abs(shortLeg.strike - longLeg.strike);

            // Liquidity Guard (Composite)
            if (shortLeg.bid <= 0 || longLeg.ask <= 0) { _diag.noLiquidity++; continue; }

            // Hard filters on both legs — credit spreads use stricter tier
            const HF = HARD_FILTER_CREDIT;
            const shortMid = (shortLeg.bid + shortLeg.ask) / 2;
            const longMid = (longLeg.bid + longLeg.ask) / 2;
            if (shortMid < HF.minMid || longMid < HF.minMid) { _diag.noLiquidity++; continue; }
            // Short leg needs full OI; long leg (protection) only needs 10 — brokers fill spreads as packages
            if (shortLeg.openInterest < HF.minOpenInterest || longLeg.openInterest < 10) { _diag.lowOI++; continue; }
            const spreadBid = shortLeg.bid - longLeg.ask;
            const spreadAsk = shortLeg.ask - longLeg.bid;
            const spreadMid = (spreadBid + spreadAsk) / 2;

            if (spreadBid <= 0.10) { _diag.lowBid++; continue; }

            const spreadPct = spreadMid > 0 ? (spreadAsk - spreadBid) / spreadMid : 1.0;

            // Key Metrics — use mid-market fill for scoring (spreadBid is floor viability check above)
            const credit = spreadMid;
            const maxRisk = actualWidth - credit;
            const breakeven = type === 'Put' ? shortLeg.strike - credit : shortLeg.strike + credit;
            const deltaAtBE = getDeltaAtStrike(chain, type, shortLeg.expiration, breakeven);
            const probITMAtBE = getProbITMAtStrike(chain, type, shortLeg.expiration, breakeven);

            // Prioritize Probability of ITM field if available, else derive from Delta at BE,
            // else use BSM N(d2) at breakeven (more accurate than 1-|delta| for OTM options)
            let pop;
            if (probITMAtBE != null && probITMAtBE > 0) {
                pop = 1 - probITMAtBE;
            } else if (deltaAtBE != null) {
                pop = 1 - Math.abs(deltaAtBE);
            } else {
                const dte0 = shortLeg.dte || 30;
                const iv0 = shortLeg.iv || 0.3;
                const T = dte0 / 365;
                // For credit spreads (put spread: breakeven below current price → put → POP = N(d2))
                const pITM = type === 'Put'
                    ? 1 - _bsmN2(currentPrice, breakeven, T, iv0)  // P(S < BE) for put
                    : _bsmN2(currentPrice, breakeven, T, iv0);      // P(S > BE) for call
                pop = 1 - pITM;
            }
            const roi = (credit / maxRisk) * 100;
            const distance = Math.abs(currentPrice - shortLeg.strike) / currentPrice;
            const dte = shortLeg.dte;

            // Earnings awareness (no hard block — score penalty applied below instead)
            const includesEarnings = daysUntilEarnings !== null && daysUntilEarnings <= dte && daysUntilEarnings >= 0;

            // 4. Slippage Modeling — OI-adjusted (illiquid options penalized even with tight quoted spreads)
            // 2.5: brokers fill 2-leg spread orders as packages, so multiply per-leg sum by 0.7
            const slippage1 = estimateSlippage(shortLeg.bid, shortLeg.ask, shortLeg.openInterest);
            const slippage2 = estimateSlippage(longLeg.bid, longLeg.ask, longLeg.openInterest);
            const totalSlippage = (slippage1 + slippage2) * 0.7;
            const effectiveCredit = credit - totalSlippage; // Real-world fill

            if (effectiveCredit <= 0) { _diag.slippageKill++; continue; } // If slippage eats all profit, skip

            const effectiveMaxRisk = actualWidth - effectiveCredit;
            const effectiveROI = (effectiveCredit / effectiveMaxRisk) * 100;

            // Use consistent spread ceiling across all strategies
            if (spreadPct > HF.maxSpreadPctCeiling) { _diag.spreadCeiling++; continue; }

            // Scoring (v2.2 — EV-enhanced + Slippage)
            const ev = calculateExpectedValue(pop, effectiveCredit, effectiveMaxRisk);
            const evRatio = effectiveCredit > 0 ? ev / effectiveCredit : 0;
            const scoreEV = Math.max(0, Math.min(100, 50 + evRatio * 100));

            const scoreROI = Math.min(effectiveROI * 4, 100);
            const scorePOP = pop * 100;
            const scoreDistance = Math.min(distance * 1000, 100);

            // 5. Gamma Risk — pass spot and mid for proper normalization (avoids TSLA vs SPY price distortion)
            const gammaPenalty = getGammaRiskPenalty(shortLeg.gamma, shortLeg.theta, dte, currentPrice, shortMid);

            // Relative IV (same-DTE ATM): sell expensive vol → small bonus; vega penalty already limits vol crush exposure
            const relativeIVBonus = getRelativeIVAdjustmentCSQ(shortLeg.iv, atmIV) * 15;

            // 2. Skew Adjustment: magnitude-based bonus (|skew| larger → same-direction bonus scales 5..15, capped)
            const skewBonus = getSkewBonusForCreditSpread(skew, type);

            // Smooth Gaussian DTE curve: peak is setup-aware (dtePeak), σ=15
            // Momentum setups (Breakout, Perfect Storm) peak at DTE=14; Trend/Directional at 55
            const scoreDTE = Math.round(100 * Math.exp(-0.5 * Math.pow((dte - dtePeak) / 15, 2)));

            // Earnings penalty scaling (2.6): proportional to implied move size
            const earningsPremium = includesEarnings
                ? estimateEarningsPremium(daysUntilEarnings, dte, shortLeg.iv, currentPrice)
                : null;
            const earningsMovePct = earningsPremium?.earningsMovePct ?? 5;
            const earningsScale = includesEarnings ? Math.min(2.0, Math.max(1.0, earningsMovePct / 5)) : 1.0;

            let finalScore = (0.20 * scoreEV) + (0.20 * scoreROI) + (0.20 * scorePOP) + (0.15 * scoreDistance) + (0.25 * scoreDTE) + skewBonus + gammaPenalty + relativeIVBonus;
            finalScore += ivRankAdj * 2 + volFcstAdj * 2;
            if (includesEarnings) finalScore -= 25 * earningsScale;
            if (anomaly && dte <= 35) finalScore -= 30; // Anomaly IV (e.g. Earnings) → Penalize short-dated short sellers

            if (effectiveROI < 10) { _diag.lowROI++; continue; } // Lowered ROI floor because we are using net effective ROI now

            const whyThisParts = [];
            if (ev > 0) whyThisParts.push(`+EV $${ev.toFixed(2)}`);
            if (effectiveROI > 15) whyThisParts.push(`${effectiveROI.toFixed(0)}% ROI (Adj)`);
            if (ivRvRatio && ivRvRatio > 1.25) whyThisParts.push('High IV Premium');
            if (scoreDTE >= 75) whyThisParts.push('Theta Zone');
            if (skewBonus > 0) whyThisParts.push('Skew Edge');
            if (gammaPenalty < 0) whyThisParts.push('Gamma Risk');

            const note = generateStrategyNote('CREDIT', {
                ev,
                pop: pop * 100,
                roi: effectiveROI,
                skewBonus,
                ivRvRatio,
                gammaPenalty,
                slippageImpact: totalSlippage / credit, // % of credit lost to slippage
                dte
            });

            results.push({
                type: type === 'Put' ? 'Credit Put Spread' : 'Credit Call Spread',
                shortLeg: { ...shortLeg, price: shortLeg.bid },
                longLeg: { ...longLeg, price: longLeg.ask },
                width: actualWidth,
                netCredit: Number(effectiveCredit.toFixed(2)),   // Slippage-adjusted (matches scorer)
                maxRisk: Number(effectiveMaxRisk.toFixed(2)),    // Slippage-adjusted
                maxProfit: Number(effectiveCredit.toFixed(2)),   // = netCredit for credit spreads
                roi: Number(effectiveROI.toFixed(1)),            // Slippage-adjusted ROI
                pop: Number((pop * 100).toFixed(1)),
                expectedValue: Number(ev.toFixed(2)),    // ev already uses effectiveCredit & effectiveMaxRisk
                // Holding-period EV: swing trader exits at 50% profit OR 50% stop-loss (not at expiry)
                evHold: (() => {
                    return Number((pop * 0.5 * effectiveCredit - (1 - pop) * 0.5 * effectiveMaxRisk).toFixed(2));
                })(),
                evDaily: (() => {
                    const dte = shortLeg.dte || 30;
                    const evH = pop * 0.5 * effectiveCredit - (1 - pop) * 0.5 * effectiveMaxRisk;
                    const holdDays = Math.max(1, dte * (pop * 0.5 + (1 - pop) * 0.30));
                    return Number((evH / holdDays).toFixed(4));
                })(),
                distance: Number((distance * 100).toFixed(1)),
                breakeven,
                score: Math.min(100, Math.max(0, Math.round(finalScore))),
                whyThis: whyThisParts.join(', ') || 'Balanced Risk/Reward',
                ...(earningsPremium ? { earningsPremium } : {}),
                recommendation: {
                    action: "SELL (Open)",
                    note
                }
            });
        }
    }
    const sorted = results.sort((a, b) => b.score - a.score).slice(0, 5);
    sorted._diagnostics = _diag;
    return sorted;
}

function buildDebitSpreads(chain, type, currentPrice, ivRvRatio, customWidth, ivRank = null, daysUntilEarnings = null, anomaly = false, dtePeak = 37, deltaRange = [0.45, 0.70], sampleDays = 60, volFcstAdj = 0) {
    const results = [];
    const widths = customWidth ? [customWidth] : [2.5, 5];
    const ivRankAdj = getIVRankAdjustment(ivRank ?? null, 'long', sampleDays);
    const [deltaMin, deltaMax] = deltaRange;

    const longs = chain.filter(o =>
        o.type === type &&
        Math.abs(o.delta) >= deltaMin &&
        Math.abs(o.delta) <= deltaMax
    );

    for (const longLeg of longs) {
        for (const width of widths) {
            const shortStrike = type === 'Call' ? longLeg.strike + width : longLeg.strike - width;
            const sameSideExp = chain.filter(o =>
                o.type === type && o.expiration === longLeg.expiration
            );
            let shortLeg = sameSideExp.find(o => Math.abs(o.strike - shortStrike) < 0.1);
            if (!shortLeg) {
                const maxDrift = width * 0.2;
                let bestDist = Infinity;
                for (const o of sameSideExp) {
                    const dist = Math.abs(o.strike - shortStrike);
                    if (dist < bestDist && dist <= maxDrift) { bestDist = dist; shortLeg = o; }
                }
            }

            if (!shortLeg) continue;
            const actualWidth = Math.abs(longLeg.strike - shortLeg.strike);

            // Hard filters on both legs
            const longMidDS = (longLeg.bid + longLeg.ask) / 2;
            const shortMidDS = (shortLeg.bid + shortLeg.ask) / 2;
            if (longMidDS < HARD_FILTER_DEFAULTS.minMid || shortMidDS < HARD_FILTER_DEFAULTS.minMid) continue;
            if (longLeg.openInterest < HARD_FILTER_DEFAULTS.minOpenInterest || shortLeg.openInterest < HARD_FILTER_DEFAULTS.minOpenInterest) continue;

            // Use mid-market fill for scoring; worst-case is longLeg.ask - shortLeg.bid
            const debitBid = longLeg.bid - shortLeg.ask;
            const debitAsk = longLeg.ask - shortLeg.bid;
            const debit = (debitBid + debitAsk) / 2;
            const maxProfit = actualWidth - debit;
            const maxRisk = debit;

            if (debit <= 0 || maxRisk <= 0) continue;

            const riskReward = maxProfit / debit;
            const mid = (longLeg.bid + longLeg.ask) / 2;

            if (mid <= 0) continue;

            const spreadPctVal = (longLeg.ask - longLeg.bid) / mid;

            if (debit >= actualWidth * 0.55) continue;
            // if (riskReward < 1.5) continue; // Relaxed in favor of EV check
            if (spreadPctVal > HARD_FILTER_DEFAULTS.maxSpreadPctCeiling) continue; // Consistent with credit spreads

            // 4. Slippage (Debit) — OI-adjusted
            // 2.5: brokers fill 2-leg spread orders as packages, so multiply per-leg sum by 0.7
            const slippage1 = estimateSlippage(longLeg.bid, longLeg.ask, longLeg.openInterest);
            const slippage2 = estimateSlippage(shortLeg.bid, shortLeg.ask, shortLeg.openInterest);
            const totalSlippage = (slippage1 + slippage2) * 0.7;
            const effectiveDebit = debit + totalSlippage; // Higher cost
            const effectiveMaxProfit = actualWidth - effectiveDebit;

            if (effectiveDebit >= actualWidth * 0.70) continue; // Too expensive after slippage

            // Scoring (Enhanced v2.3 — 6 dimensions aligned with LOQ)
            const lambda = Math.abs(longLeg.delta) * (currentPrice / mid);
            const compLambda = compressLambda(lambda);
            const deltaBonus = getDeltaBonus(longLeg.delta);

            const breakeven = type === 'Call' ? longLeg.strike + debit : longLeg.strike - debit;
            const deltaAtBE = getDeltaAtStrike(chain, type, longLeg.expiration, breakeven);
            const probITMAtBE = getProbITMAtStrike(chain, type, longLeg.expiration, breakeven);

            // Debit Spread POP: Probability ITM at Breakeven
            // Prefer market-provided probability, then delta-at-BE, then BSM N(d2) fallback
            let pop;
            if (probITMAtBE != null && probITMAtBE > 0) {
                pop = probITMAtBE;
            } else if (deltaAtBE != null) {
                pop = Math.abs(deltaAtBE);
            } else {
                const dteDS = longLeg.dte || 30;
                const ivDS = longLeg.iv || 0.3;
                const TDS = dteDS / 365;
                // P(profitable at expiry): call needs S > BE, put needs S < BE
                pop = type === 'Call'
                    ? _bsmN2(currentPrice, breakeven, TDS, ivDS)       // N(d2) for call
                    : 1 - _bsmN2(currentPrice, breakeven, TDS, ivDS);  // 1-N(d2) for put
            }
            const expectedValue = (effectiveMaxProfit * pop) - (effectiveDebit * (1 - pop));

            // 1. Lambda score (leverage)
            const lambdaScore = Math.min((compLambda / 20) * 100, 100);

            // 2. Risk/Reward score
            const rrScore = Math.min((riskReward / 3) * 100, 100);

            // 3. Delta score (moneyness)
            const deltaScore = 50 + deltaBonus * 12.5;

            // 4. Theta decay penalty (NEW)
            const thetaBurn = Math.abs(longLeg.theta || 0) / effectiveDebit;
            const thetaPenalty = getThetaPenalty(thetaBurn);

            // 5. Breakeven penalty (NEW)
            const beMove = calculateBreakevenMove(longLeg.strike, effectiveDebit, currentPrice, type);
            const bePenalty = getBreakevenPenalty(beMove, longLeg.dte || 30);

            // 6. EV score (NEW)
            const evRatio = effectiveDebit > 0 ? expectedValue / effectiveDebit : 0;
            const evScore = Math.max(0, Math.min(100, 50 + evRatio * 50));

            // Weighted scoring: lambda(25%) + R:R(25%) + delta(15%) + EV(20%) + BE(10%) + theta(-5%)
            // DTE score uses setup-tuned Gaussian peak (dtePeak)
            const scoreDTEDebit = Math.round(100 * Math.exp(-0.5 * Math.pow((longLeg.dte - dtePeak) / 15, 2)));
            // Earnings penalty scaling for debit spreads (2.6)
            const dteDS = longLeg.dte || 30;
            const includesEarningsDS = daysUntilEarnings !== null && daysUntilEarnings >= 0 && daysUntilEarnings <= dteDS;
            const earningsPremiumDS = includesEarningsDS
                ? estimateEarningsPremium(daysUntilEarnings, dteDS, longLeg.iv, currentPrice)
                : null;
            const earningsMovePctDS = earningsPremiumDS?.earningsMovePct ?? 5;
            const earningsScaleDS = includesEarningsDS ? Math.min(2.0, Math.max(1.0, earningsMovePctDS / 5)) : 1.0;

            let finalScore = (0.25 * lambdaScore) + (0.25 * rrScore) + (0.15 * deltaScore) +
                (0.20 * evScore) + (0.10 * (50 + bePenalty * 12.5)) - (0.05 * thetaPenalty) + (0.05 * scoreDTEDebit);
            finalScore += ivRankAdj * 2 + volFcstAdj * 2;
            if (includesEarningsDS) finalScore -= 15 * earningsScaleDS; // Earnings → IV crush risk for debit buyers
            if (anomaly && (longLeg.dte || 30) <= 35) finalScore -= 20; // Anomaly IV → Penalize buyers due to IV crush risk

            // When IV/RV > 1.10 (contango but paying VRP), favor more selective debits: R:R ≥ 1.5, DTE 30–45, delta 0.50–0.65
            if (ivRvRatio != null && ivRvRatio > 1.10) {
                if (riskReward >= 1.5) finalScore += 8;
                const dte = longLeg.dte ?? 0;
                if (dte >= 30 && dte <= 45) finalScore += 8;
                const absDelta = Math.abs(longLeg.delta);
                if (absDelta >= 0.50 && absDelta <= 0.65) finalScore += 6;
                if (riskReward < 1.5) finalScore -= 10; // Penalize low R:R when vol is expensive
            }

            const note = generateStrategyNote('DEBIT', {
                ev: expectedValue,
                pop: pop * 100,
                lambda,
                ivRvRatio,
                slippageImpact: totalSlippage / debit,
                deltaBonus
            });

            results.push({
                type: type === 'Call' ? 'Debit Call Spread' : 'Debit Put Spread',
                longLeg: { ...longLeg, price: longLeg.ask },
                shortLeg: { ...shortLeg, price: shortLeg.bid },
                width: actualWidth,
                netDebit: Number(debit.toFixed(2)),
                maxRisk: Number(maxRisk.toFixed(2)),
                maxProfit: Number(maxProfit.toFixed(2)),
                riskReward: Number(riskReward.toFixed(2)),
                lambda: Number(lambda.toFixed(1)),
                pop: Number((pop * 100).toFixed(1)),
                expectedValue: Number(expectedValue.toFixed(2)),
                breakeven: type === 'Call' ? longLeg.strike + debit : longLeg.strike - debit,
                score: Math.min(100, Math.max(0, Math.round(finalScore))),
                whyThis: `R/R ${riskReward.toFixed(1)}:1, λ=${lambda.toFixed(1)}${ivRvRatio && ivRvRatio < 0.85 ? ', Cheap Vol (Ref)' : ''}`,
                ...(earningsPremiumDS ? { earningsPremium: earningsPremiumDS } : {}),
                recommendation: {
                    action: "BUY (Open)",
                    note
                }
            });
        }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

function scoreSingleLegs(chain, type, ivRvRatio, currentPrice, ivRatio = 1.0, ivRank = null, sampleDays = 60, volFcstAdj = 0) {
    const filtered = chain.filter(o =>
        o.type === type &&
        Math.abs(o.delta) >= 0.25 &&
        Math.abs(o.delta) <= 0.60 &&
        o.bid > 0 && o.ask > 0
    );

    if (filtered.length === 0) return [];

    const processed = [];
    for (const opt of filtered) {
        const mid = (opt.bid + opt.ask) / 2;
        if (mid <= 0) continue;
        if (mid < HARD_FILTER_DEFAULTS.minMid) continue;
        if (opt.openInterest < HARD_FILTER_DEFAULTS.minOpenInterest) continue;
        const spreadPctVal = (opt.ask - opt.bid) / mid;
        if (spreadPctVal > HARD_FILTER_DEFAULTS.maxSpreadPctCeiling) continue;
        const lambda = Math.abs(opt.delta) * (currentPrice / mid);
        const dollarGamma = calculateDollarGamma(opt.gamma, currentPrice);
        const thetaBurn = Math.abs(opt.theta) / mid;
        const gammaThetaRatio = calculateGammaThetaRatio(opt.gamma, opt.theta);
        const breakevenMove = calculateBreakevenMove(opt.strike, mid, currentPrice, opt.type);
        processed.push({ opt, mid, lambda, dollarGamma, thetaBurn, gammaThetaRatio, breakevenMove, spreadPct: spreadPctVal });
    }

    if (processed.length === 0) return [];

    const compressedLambdas = processed.map(p => compressLambda(p.lambda));
    const dollarGammas = processed.map(p => p.dollarGamma);
    const thetas = processed.map(p => p.thetaBurn);
    const gtRatios = processed.map(p => p.gammaThetaRatio);
    const dtes = processed.map(p => p.opt.dte);
    const vegaEfficiencies = processed.map(p => (p.opt.vega || 0) / (p.mid || 0.01));
    const zL = zScoresByBucket(compressedLambdas, dtes);
    const zDG = zScoresByBucket(dollarGammas, dtes);
    const zT = zScoresByBucket(thetas, dtes);
    const zGT = zScoresByBucket(gtRatios, dtes);
    const zVegaEff = zScoresByBucket(vegaEfficiencies, dtes);

    const atmIV = getCleanATM_IV(chain, currentPrice);
    const ivAdjustment = getIVAdjustment(ivRatio ?? 1.0, 'long');
    const ivRankAdj = getIVRankAdjustment(ivRank ?? null, 'long', sampleDays);
    const rawScores = processed.map((p, i) => {
        const relIvAdj = getRelativeIVAdjustmentLOQ(p.opt.iv, atmIV);
        const deltaBonus = getDeltaBonus(p.opt.delta);
        const bePenalty = getBreakevenPenalty(p.breakevenMove, p.opt.dte);
        return calculateLOQRaw(zL[i], zDG[i], zT[i], ivAdjustment + ivRankAdj + volFcstAdj + relIvAdj, deltaBonus, p.thetaBurn, false, zGT[i], bePenalty, p.opt.dte, zVegaEff[i]);
    });
    const scores = normalizeLOQScoresWithDynamicBaseline(rawScores);
    return processed.map((p, i) => {
        const score = scores[i];
        // POP = probability of profit at expiry (same definition as debit spread: breakeven-based)
        const breakeven = type === 'Call' ? p.opt.strike + p.mid : p.opt.strike - p.mid;
        const probITMAtBE = getProbITMAtStrike(chain, type, p.opt.expiration, breakeven);
        const deltaAtBE = getDeltaAtStrike(chain, type, p.opt.expiration, breakeven);
        let pop;
        if (probITMAtBE != null && probITMAtBE > 0) {
            pop = probITMAtBE; // P(S>BE) for call, P(S<BE) for put
        } else if (deltaAtBE != null) {
            pop = type === 'Call' ? Math.max(0, Math.min(1, deltaAtBE)) : Math.max(0, Math.min(1, -deltaAtBE));
        } else {
            // BSM N(d2) fallback: better than |delta|-0.05 for OTM options
            const dteLO = p.opt.dte || 30;
            const ivLO = p.opt.iv || 0.3;
            const TLO = dteLO / 365;
            const n2 = _bsmN2(currentPrice, breakeven, TLO, ivLO);
            pop = Math.max(0, Math.min(1, type === 'Call' ? n2 : 1 - n2));
        }

        const whyThis = `λ=${p.lambda.toFixed(1)}, Δ=${Math.abs(p.opt.delta).toFixed(2)}${ivRvRatio && ivRvRatio < 0.85 ? ', Cheap Vol (Ref)' : ''}`;
        const noteParts = [];
        if (p.lambda >= 8) noteParts.push('High leverage (lambda) gives strong participation in the underlying move for limited capital.');
        if (ivRvRatio != null && ivRvRatio < 0.9) noteParts.push('Implied volatility is cheap vs recent realized vol, so you are not overpaying for the option.');
        noteParts.push(`Delta around ${Math.abs(p.opt.delta).toFixed(2)} offers a balance between direction and cost; gamma/theta are scored relative to peers in the chain.`);
        const note = '✅ ' + noteParts.join(' ');

        return {
            type: `Long ${type}`,
            strike: p.opt.strike,
            expiration: p.opt.expiration,
            dte: p.opt.dte,
            price: Number(p.mid.toFixed(2)),
            delta: p.opt.delta,
            gamma: p.opt.gamma,
            theta: p.opt.theta,
            vega: p.opt.vega,
            lambda: p.lambda,
            dollarGamma: p.dollarGamma,
            thetaBurn: p.thetaBurn,
            volume: p.opt.volume,
            openInterest: p.opt.openInterest,
            bid: p.opt.bid,
            ask: p.opt.ask,
            pop: Number((pop * 100).toFixed(1)),
            score,
            whyThis,
            recommendation: { action: 'BUY (Open)', note }
        };
    }).sort((a, b) => b.score - a.score).slice(0, 5);
}

// =============================================================================
// IRON CONDOR BUILDER
// =============================================================================

function buildIronCondors(chain, currentPrice, ivRvRatio, daysUntilEarnings, skew, customWidth, ivRank = null, anomaly = false, sampleDays = 60, volFcstAdj = 0) {
    const results = [];
    const widths = customWidth ? [customWidth] : [5, 10];
    const ivRankAdj = getIVRankAdjustment(ivRank ?? null, 'short', sampleDays);
    const HF = HARD_FILTER_CREDIT;

    // Find unique expirations that have both put and call options
    const expirations = [...new Set(chain.map(o => o.expiration))];

    for (const exp of expirations) {
        const expChain = chain.filter(o => o.expiration === exp);
        const dte = expChain[0]?.dte;
        if (!dte || dte < 21 || dte > 60) continue; // IC sweet spot: 21-60 DTE

        // Earnings awareness (score penalty applied below, no hard block)
        const includesEarnings = daysUntilEarnings !== null && daysUntilEarnings <= dte && daysUntilEarnings >= 0;

        // Find short put candidates (below price, 15-25Δ)
        const shortPuts = expChain.filter(o =>
            o.type === 'Put' &&
            Math.abs(o.delta) >= 0.15 &&
            Math.abs(o.delta) <= 0.25 &&
            o.bid > 0 && o.ask > 0
        );

        // Find short call candidates (above price, 15-25Δ)
        const shortCalls = expChain.filter(o =>
            o.type === 'Call' &&
            Math.abs(o.delta) >= 0.15 &&
            Math.abs(o.delta) <= 0.25 &&
            o.bid > 0 && o.ask > 0
        );

        for (const shortPut of shortPuts) {
            for (const shortCall of shortCalls) {
                // Short call must be above current price, short put below
                if (shortCall.strike <= currentPrice || shortPut.strike >= currentPrice) continue;

                for (const width of widths) {
                    // Long legs: further OTM protection
                    const longPutStrike = shortPut.strike - width;
                    const longCallStrike = shortCall.strike + width;
                    const maxDrift = width * 0.2;

                    let longPut = expChain.find(o =>
                        o.type === 'Put' && Math.abs(o.strike - longPutStrike) < 0.1
                    );
                    if (!longPut) {
                        let bestDist = Infinity;
                        for (const o of expChain) {
                            if (o.type !== 'Put') continue;
                            const dist = Math.abs(o.strike - longPutStrike);
                            if (dist < bestDist && dist <= maxDrift) { bestDist = dist; longPut = o; }
                        }
                    }
                    let longCall = expChain.find(o =>
                        o.type === 'Call' && Math.abs(o.strike - longCallStrike) < 0.1
                    );
                    if (!longCall) {
                        let bestDist = Infinity;
                        for (const o of expChain) {
                            if (o.type !== 'Call') continue;
                            const dist = Math.abs(o.strike - longCallStrike);
                            if (dist < bestDist && dist <= maxDrift) { bestDist = dist; longCall = o; }
                        }
                    }

                    if (!longPut || !longCall) continue;
                    const actualPutWidth = Math.abs(shortPut.strike - longPut.strike);
                    const actualCallWidth = Math.abs(shortCall.strike - longCall.strike);
                    const icWidth = Math.max(actualPutWidth, actualCallWidth);

                    // Liquidity checks: short legs need full OI, long legs (protection) only need 10
                    const shortLegs = [shortPut, shortCall];
                    const longLegs = [longPut, longCall];
                    const allLegsOK = shortLegs.every(l => {
                        const mid = (l.bid + l.ask) / 2;
                        return mid >= HF.minMid && l.openInterest >= HF.minOpenInterest;
                    }) && longLegs.every(l => {
                        const mid = (l.bid + l.ask) / 2;
                        return mid >= HF.minMid && l.openInterest >= 10;
                    });
                    if (!allLegsOK) continue;

                    // Credit calculation: put side + call side
                    const putCreditBid = shortPut.bid - longPut.ask;
                    const putCreditAsk = shortPut.ask - longPut.bid;
                    const putCredit = (putCreditBid + putCreditAsk) / 2;

                    const callCreditBid = shortCall.bid - longCall.ask;
                    const callCreditAsk = shortCall.ask - longCall.bid;
                    const callCredit = (callCreditBid + callCreditAsk) / 2;

                    if (putCredit <= 0 || callCredit <= 0) continue;

                    // Spread % check on each side
                    const putSpreadPct = putCredit > 0 ? (putCreditAsk - putCreditBid) / putCredit : 1;
                    const callSpreadPct = callCredit > 0 ? (callCreditAsk - callCreditBid) / callCredit : 1;
                    if (putSpreadPct > HF.maxSpreadPctCeiling || callSpreadPct > HF.maxSpreadPctCeiling) continue;

                    const totalCredit = putCredit + callCredit;
                    // Max risk = width of wider side - total credit (only one side can lose)
                    const maxRisk = icWidth - totalCredit;
                    if (maxRisk <= 0) continue;

                    // Slippage on all 4 legs — brokers fill spread orders as packages (2.5: multiply by 0.5)
                    const rawSlippage =
                        estimateSlippage(shortPut.bid, shortPut.ask, shortPut.openInterest) +
                        estimateSlippage(longPut.bid, longPut.ask, longPut.openInterest) +
                        estimateSlippage(shortCall.bid, shortCall.ask, shortCall.openInterest) +
                        estimateSlippage(longCall.bid, longCall.ask, longCall.openInterest);
                    const totalSlippage = rawSlippage * 0.5;
                    const effectiveCredit = totalCredit - totalSlippage;
                    if (effectiveCredit <= 0) continue;

                    const effectiveMaxRisk = icWidth - effectiveCredit;
                    const effectiveROI = (effectiveCredit / effectiveMaxRisk) * 100;
                    if (effectiveROI < 8) continue; // IC needs at least 8% ROI to be worth it

                    // Breakeven range
                    const lowerBreakeven = shortPut.strike - totalCredit;
                    const upperBreakeven = shortCall.strike + totalCredit;
                    const rangeWidth = upperBreakeven - lowerBreakeven;
                    const rangePct = rangeWidth / currentPrice;

                    // POP estimation: probability price stays within breakeven range
                    // Use BSM to estimate P(lowerBE < S < upperBE) at expiry
                    const iv = (shortPut.iv + shortCall.iv) / 2 || 0.3;
                    const T = dte / 365;
                    const pAboveLower = _bsmN2(currentPrice, lowerBreakeven, T, iv);  // P(S > lowerBE)
                    const pAboveUpper = _bsmN2(currentPrice, upperBreakeven, T, iv);  // P(S > upperBE)
                    const pop = pAboveLower - pAboveUpper; // P(lowerBE < S < upperBE)

                    // Directional alignment score (2.4): reward wider wing on the skew-favored side.
                    // skew > 0 (puts rich) → wider put wing is better. skew < 0 → wider call wing.
                    const putDistance = (currentPrice - shortPut.strike) / currentPrice;
                    const callDistance = (shortCall.strike - currentPrice) / currentPrice;
                    let alignmentScore;
                    const absSkewIC = Math.abs(skew || 0);
                    if (absSkewIC > 0.03) {
                        // Directionally skewed: reward wider wing on the expensive side
                        const putWingWider = putDistance > callDistance;
                        const aligned = (skew > 0 && putWingWider) || (skew < 0 && !putWingWider);
                        if (aligned) {
                            const widthRatio = Math.min(putDistance, callDistance) / Math.max(putDistance, callDistance);
                            alignmentScore = 60 + (1 - widthRatio) * 40; // Wider divergence → higher score
                        } else {
                            alignmentScore = 40 * (Math.min(putDistance, callDistance) / Math.max(putDistance, callDistance));
                        }
                    } else {
                        // Neutral skew: fall back to symmetry
                        const symmetryRatio = Math.min(putDistance, callDistance) / Math.max(putDistance, callDistance);
                        alignmentScore = symmetryRatio * 100;
                    }

                    // Scoring: POP (40%) + Credit/Risk (25%) + Alignment (15%) + DTE curve (20%)
                    const scorePOP = pop * 100;
                    const scoreROI = Math.min(effectiveROI * 3, 100);
                    const scoreDTE = Math.round(100 * Math.exp(-0.5 * Math.pow((dte - 37) / 15, 2)));

                    let finalScore = (0.40 * scorePOP) + (0.25 * scoreROI) + (0.15 * alignmentScore) + (0.20 * scoreDTE);
                    finalScore += ivRankAdj * 2 + volFcstAdj * 2;

                    // IV/RV bonus: IC benefits from high IV (selling premium on both sides)
                    if (ivRvRatio != null && ivRvRatio > 1.20) finalScore += 8;
                    if (ivRvRatio != null && ivRvRatio > 1.40) finalScore += 5;

                    // Anomaly penalty: IV spike makes short-term ICs risky
                    if (anomaly && dte <= 35) finalScore -= 25;
                    if (includesEarnings) {
                        const earningsPremiumIC = estimateEarningsPremium(daysUntilEarnings, dte, (shortPut.iv + shortCall.iv) / 2 || 0.3, currentPrice);
                        const earningsMovePctIC = earningsPremiumIC?.earningsMovePct ?? 5;
                        const earningsScaleIC = Math.min(2.0, Math.max(1.0, earningsMovePctIC / 5));
                        finalScore -= 20 * earningsScaleIC;
                    }

                    const whyThisParts = [];
                    if (pop > 0.50) whyThisParts.push(`${(pop * 100).toFixed(0)}% POP`);
                    if (effectiveROI > 12) whyThisParts.push(`${effectiveROI.toFixed(0)}% ROI`);
                    if (alignmentScore > 75) whyThisParts.push(absSkewIC > 0.03 ? 'Good Wing Alignment' : 'Balanced Wings');
                    if (ivRvRatio && ivRvRatio > 1.20) whyThisParts.push('Rich Premium');
                    if (rangePct > 0.10) whyThisParts.push(`${(rangePct * 100).toFixed(1)}% Range`);

                    results.push({
                        type: 'Iron Condor',
                        putSide: {
                            shortLeg: { ...shortPut, price: shortPut.bid },
                            longLeg: { ...longPut, price: longPut.ask },
                            credit: Number(putCredit.toFixed(2)),
                        },
                        callSide: {
                            shortLeg: { ...shortCall, price: shortCall.bid },
                            longLeg: { ...longCall, price: longCall.ask },
                            credit: Number(callCredit.toFixed(2)),
                        },
                        // Unified fields for scoring compatibility
                        shortLeg: { ...shortPut, price: shortPut.bid, dte },
                        longLeg: { ...longPut, price: longPut.ask },
                        width: icWidth,
                        netCredit: Number(totalCredit.toFixed(2)),
                        maxRisk: Number(maxRisk.toFixed(2)),
                        maxProfit: Number(totalCredit.toFixed(2)),
                        roi: Number((totalCredit / maxRisk * 100).toFixed(1)),
                        pop: Number((pop * 100).toFixed(1)),
                        expectedValue: Number(((totalCredit * pop) - (maxRisk * (1 - pop))).toFixed(2)),
                        lowerBreakeven: Number(lowerBreakeven.toFixed(2)),
                        upperBreakeven: Number(upperBreakeven.toFixed(2)),
                        rangePct: Number((rangePct * 100).toFixed(1)),
                        alignment: Number(alignmentScore.toFixed(0)),
                        score: Math.min(100, Math.max(0, Math.round(finalScore))),
                        whyThis: whyThisParts.join(', ') || 'Neutral Premium Collection',
                        recommendation: {
                            action: "SELL (Open)",
                            note: `✅ Iron Condor: Collect $${totalCredit.toFixed(2)} credit. Price must stay between $${lowerBreakeven.toFixed(2)} and $${upperBreakeven.toFixed(2)} (${(rangePct * 100).toFixed(1)}% range). ${pop > 0.55 ? 'Good probability of profit.' : 'Moderate probability — consider widening wings.'} ${ivRvRatio && ivRvRatio > 1.20 ? 'IV premium is rich — favorable for selling.' : ''}`
                        }
                    });
                }
            }
        }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { ticker, direction = 'BULL', targetDte, spreadWidth, targetStrategy, setup, entryContext, entryQuality } = req.query;

    if (!ticker) {
        return res.status(400).json({ error: 'Missing ticker parameter' });
    }

    // d8: % distance of close from EMA-8, sent by frontend from tech score result.
    // Used to auto-detect 'overextended' without requiring the user to check it manually.
    const d8Str = req.query.d8 ? String(req.query.d8).replace(/[^-0-9.]/g, '') : null;
    const d8Param = d8Str != null ? parseFloat(d8Str) : null;

    // v4 Entry Context: 'OPTIMAL' | 'ACCEPTABLE' | 'MARGINAL' | 'CHASING'
    // entryQuality: 0-100 numeric score from calculateTechScoreV4()
    const entryCtx = entryContext ? String(entryContext).toUpperCase() : null;
    const entryQualityNum = entryQuality
        ? Math.min(100, Math.max(0, parseFloat(String(entryQuality).replace(/[^0-9.]/g, ''))))
        : null;

    const upperTicker = ticker.toUpperCase();
    const isBull = direction.toUpperCase() === 'BULL';
    const targetDteStr = targetDte ? String(targetDte).replace(/[^0-9]/g, '') : '55';
    const dteTarget = parseInt(targetDteStr) || 55;

    const widthStr = spreadWidth ? String(spreadWidth).replace(/[^0-9.]/g, '') : null;
    const widthParam = widthStr ? parseFloat(widthStr) : null;

    try {
        await ensureScoring();
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;

        const dataSource = (process.env.DATA_SOURCE || 'CBOE').trim().toUpperCase();
        // Track which source was actually used (may differ from configured if fallback occurs)
        let actualDataSource = dataSource;
        let allOptions = [];
        let currentPrice = 0;
        let cboeRes = null;
        let rv30 = null;
        let daysUntilEarnings = null;
        let quoteFreshness = null;

        // Pre-declare candle arrays at handler scope so batch 1 can share them
        let dailyCandles = null;

        let oratsSuccess = false;

        // Import ORATS enrichment functions at handler scope
        const { getCores: oratsGetCores } = await import('../lib/orats-client.js');
        // Single getCores() call provides: RV30, IV rank/percentile, earnings, implied move, contango
        let oratsCores = null;
        let oratsEnrich = {};

        if (dataSource === 'POLYGON' || dataSource === 'ORATS') {
            // 'POLYGON' accepted as legacy alias → routes to ORATS
            console.log(`Using ORATS for ${upperTicker}`);
            const { getOptionChain, getUnderlyingPrice, checkQuoteFreshness } = await import('../lib/orats-client.js');
            const { getCandles } = await import('../lib/tiingo-client.js');

            // Date ranges for candle fetches
            const toDate = new Date();
            const toStr = toDate.toISOString().split('T')[0];
            const fromDaily = new Date(toDate);
            fromDaily.setDate(toDate.getDate() - 150); // 150 calendar days ≈ 105 trading days; max indicator lookback is 100 bars
            const fromDailyStr = fromDaily.toISOString().split('T')[0];
            const fromIntraday = new Date(toDate);
            fromIntraday.setDate(toDate.getDate() - 365); // Extended from 200 → 365 days for more 1h/4h bars
            const fromIntradayStr = fromIntraday.toISOString().split('T')[0];

            // Batch 1: parallel fetch — daily candles + ORATS cores (RV30, IV rank, earnings, implied move)
            const [dailyCandlesResult, coresResult] = await Promise.all([
                getCandles(upperTicker, fromDailyStr, toStr, 'day'),
                oratsGetCores(upperTicker).catch(e => {
                    console.warn(`[ORATS cores] ${upperTicker}: failed (${e?.message})`);
                    return null;
                }),
            ]);
            dailyCandles = dailyCandlesResult;
            oratsCores = coresResult;

            // Extract enrichment from ORATS cores (single API call replaces getCores + getIVRank + fetchEarnings)
            // Additional fields: slope (skew), vol forecast, ex-earnings VRP, liquidity, takeover
            oratsEnrich = oratsCores ? {
                slope: oratsCores.slope ?? null,              // skew: fitted IV change per 10-delta
                deriv: oratsCores.deriv ?? null,              // curvature (smile shape)
                orFcst20d: oratsCores.orFcst20d != null ? oratsCores.orFcst20d / 100 : null, // normalize % → decimal (ORATS cores returns %, e.g. 49.35 = 49.35%)
                fcstR2: oratsCores.fcstR2 ?? null,            // forecast quality (0-1)
                ivHvXernRatio: oratsCores.ivHvXernRatio ?? null, // IV/HV ex-earnings
                avgOptVolu20d: oratsCores.avgOptVolu20d ?? null, // 20d avg option volume
                tkOver: oratsCores.tkOver ?? 0,               // takeover flag (0 or 1)
            } : {};
            if (oratsCores) {
                // RV30
                if (oratsCores.orHv30d || oratsCores.clsHv30d) {
                    rv30 = ((oratsCores.orHv30d ?? oratsCores.clsHv30d) * 100); // decimal → %
                    console.log(`[RV30 ORATS] ${upperTicker}: ${rv30.toFixed(2)}% (from cores)`);
                }
                // Earnings: daysToNextErn is a pre-computed integer
                if (oratsCores.daysToNextErn != null && oratsCores.daysToNextErn >= 0) {
                    daysUntilEarnings = oratsCores.daysToNextErn;
                    console.log(`[Earnings ORATS] ${upperTicker}: ${daysUntilEarnings} days until earnings`);
                }
                if (oratsEnrich.slope != null) console.log(`[Skew ORATS] ${upperTicker}: slope=${oratsEnrich.slope.toFixed(4)}, deriv=${oratsEnrich.deriv?.toFixed(4) ?? 'N/A'}`);
                if (oratsEnrich.orFcst20d != null) console.log(`[VolFcst ORATS] ${upperTicker}: fcst20d=${(oratsEnrich.orFcst20d * 100).toFixed(1)}%, R²=${oratsEnrich.fcstR2?.toFixed(3) ?? 'N/A'}`);
                if (oratsEnrich.tkOver === 1) console.log(`[TAKEOVER] ${upperTicker}: flagged as takeover target`);
            }

            // RV30 fallback: compute from Tiingo candles
            if (rv30 == null && dailyCandles && dailyCandles.length >= 11) {
                const closes = dailyCandles.map(c => c.close);
                rv30 = _computeRV30(closes);
                if (rv30 != null) console.log(`[RV30 Calc] ${upperTicker}: ${rv30.toFixed(2)}% (from Tiingo candles)`);
            }

            // Earnings fallback: scrape Nasdaq if ORATS cores didn't provide earnings
            if (daysUntilEarnings == null) {
                daysUntilEarnings = await fetchEarnings(upperTicker);
            }

            // Derive underlying price from last daily close (avoids a separate snapshot call)
            // ±20% strike filter is wide enough that yesterday's close is accurate enough
            const lastClose = dailyCandles?.length > 0 ? dailyCandles[dailyCandles.length - 1].close : null;
            console.log(`[Batch 1] ${upperTicker}: ${dailyCandles?.length ?? 0} daily candles, cores=${!!oratsCores}`);

            try {
                // Single reference call covering DTE 23–97 (spans both ~30 and ~90 DTE windows)
                // Filtered in memory below — saves one API call vs separate dte:30 + dte:90 fetches
                // Widen strike range to accommodate spread width on lower-priced stocks
                // Base ±20% + spread width headroom (e.g. $15 width on $120 stock = 12.5%)
                const widthPadding = (lastClose && widthParam) ? (widthParam / lastClose) + 0.08 : 0;
                const strikePadding = Math.max(0.20, 0.15 + widthPadding);
                const minStrike = lastClose ? lastClose * (1 - strikePadding) : undefined;
                const maxStrike = lastClose ? lastClose * (1 + strikePadding) : undefined;
                const strikeFilter = (minStrike != null && maxStrike != null) ? { minStrike, maxStrike } : {};

                let chainData = await getOptionChain(upperTicker, { minDte: 0, maxDte: 160, ...strikeFilter });
                if (!chainData?.length) {
                    console.warn('ORATS chain empty with DTE 0–160, trying without DTE...');
                    chainData = await getOptionChain(upperTicker, {}) || [];
                }
                if (chainData.length > 0) {
                    const hasQuotes = chainData.some(o => o.bid > 0 || o.ask > 0);
                    if (hasQuotes) {
                        allOptions = chainData;
                        const valid = chainData.find(o => o.underlyingPrice > 0);
                        const chainUnderlying = valid ? valid.underlyingPrice : 0;

                        // Validate chain underlying against last daily close.
                        // Option chain underlying prices can be stale.
                        // If divergence > 15%, treat as unreliable and fall back.
                        const divergence = lastClose && chainUnderlying ? Math.abs(chainUnderlying - lastClose) / lastClose : 1;
                        if (chainUnderlying > 0 && divergence <= 0.15) {
                            currentPrice = chainUnderlying;
                        } else {
                            if (chainUnderlying > 0 && divergence > 0.15) {
                                console.warn(`[Underlying] ${upperTicker}: chain says $${chainUnderlying.toFixed(2)} but daily close is $${lastClose?.toFixed(2)} (${(divergence * 100).toFixed(1)}% divergence) — discarding stale chain price`);
                            }
                            currentPrice = lastClose ?? 0;
                        }

                        // Put-call parity derivation: get intraday-accurate price from option chain
                        // when underlying_asset.price is missing, unreliable, or matches stale close.
                        // S ≈ call_mid - put_mid + strike (for same strike/expiry)
                        if ((!currentPrice || currentPrice === 0 || currentPrice === lastClose || divergence > 0.15) && lastClose > 0) {
                            try {
                                const pcpPrice = _derivePriceFromPutCallParity(chainData, lastClose);
                                if (pcpPrice != null) {
                                    console.log(`[Put-Call Parity] ${upperTicker}: derived $${pcpPrice.toFixed(2)} vs candle close $${lastClose.toFixed(2)}`);
                                    currentPrice = pcpPrice;
                                }
                            } catch (e) {
                                console.warn('[Put-Call Parity] derivation failed:', e.message);
                            }
                        }

                        // Fallback: Use ORATS stock snapshot
                        if (!currentPrice || currentPrice === 0 || currentPrice === lastClose) {
                            try {
                                const freshPrice = await getUnderlyingPrice(upperTicker);
                                if (freshPrice != null && freshPrice > 0) {
                                    console.log(`[getUnderlyingPrice] ${upperTicker}: $${freshPrice.toFixed(2)}`);
                                    currentPrice = freshPrice;
                                }
                            } catch (e) {
                                console.warn('[getUnderlyingPrice] failed:', e.message);
                            }
                        }

                        // Last resort: CBOE underlying price
                        if (!currentPrice || currentPrice === 0) {
                            try {
                                console.log(`[ORATS Fallback] Fetching CBOE for ${upperTicker} underlying price...`);
                                const cRes = await fetch(cboeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.ok ? r.json() : null);
                                if (cRes?.data?.current_price) {
                                    currentPrice = cRes.data.current_price;
                                }
                            } catch (e) { }
                        }

                        oratsSuccess = true;
                        quoteFreshness = checkQuoteFreshness(chainData);
                        if (quoteFreshness.isStale) {
                            console.warn(`[ORATS] Stale quotes detected: ${quoteFreshness.staleQuotes}/${chainData.length} older than 5min (oldest: ${Math.round(quoteFreshness.oldestQuoteAgeMs / 60000)}min)`);
                        }
                    } else {
                        console.warn('ORATS returned 0 bids/asks. Falling back to CBOE...');
                    }
                } else {
                    console.warn('ORATS returned empty chain. Falling back to CBOE...');
                }

            } catch (err) {
                console.error('ORATS fetch failed. Falling back to CBOE. Error:', err.message);
            }
        }

        if (!oratsSuccess) {
            // CBOE Legacy — fetch daily candles in batch 1 so RV30 and tech score share them
            actualDataSource = 'CBOE';
            const { getCandles: _getCandles } = await import('../lib/tiingo-client.js');
            const _toDate = new Date();
            const _toStr = _toDate.toISOString().split('T')[0];
            const _fromDay = new Date(_toDate);
            _fromDay.setDate(_toDate.getDate() - 150);
            const _fromDayStr = _fromDay.toISOString().split('T')[0];

            const cboePromises = [
                fetch(cboeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.ok ? r.json() : null),
                _getCandles(upperTicker, _fromDayStr, _toStr, 'day'),
            ];
            // Only fetch earnings from Nasdaq if ORATS cores didn't provide it
            if (daysUntilEarnings == null) cboePromises.push(fetchEarnings(upperTicker));
            const cboeResults = await Promise.all(cboePromises);
            cboeRes = cboeResults[0];
            dailyCandles = cboeResults[1];
            if (cboeResults[2] !== undefined) daysUntilEarnings = cboeResults[2];

            if (!cboeRes?.data?.options) {
                return res.status(404).json({ error: 'No options data found or API error' });
            }

            currentPrice = cboeRes.data.current_price;
            allOptions = cboeRes.data.options;

            // Compute RV30 inline from candles
            if (dailyCandles && dailyCandles.length >= 11) {
                const closes = dailyCandles.map(c => c.close);
                rv30 = _computeRV30(closes);
                if (rv30 != null) console.log(`[RV30 Calc] ${upperTicker}: ${rv30.toFixed(2)}% (from CBOE path daily candles)`);
            }
        }

        // RV30: prefer ORATS cores → Tiingo candles → Nasdaq fallback
        if (rv30 == null) {
            rv30 = await fetchRV30FromNasdaq(upperTicker);
            if (rv30 != null) console.log(`[Strategy Recommend] ${upperTicker}: RV30 from Nasdaq fallback`);
        }
        if (rv30 == null) {
            console.warn(`[Strategy Recommend] ${upperTicker}: RV30 N/A (all sources failed); IV/RV will show N/A`);
        }

        // Pass wider strike padding to parseChain so long legs aren't filtered out
        const chainStrikePad = (currentPrice && widthParam) ? Math.max(0.15, 0.10 + (widthParam / currentPrice) + 0.08) : 0.15;
        const fullChain = parseChain(allOptions, currentPrice, null, chainStrikePad);

        // 4.1 — Degraded data detection: CBOE sometimes returns chains with all-zero Greeks.
        const zeroGreeksCount = fullChain.filter(o => o.delta === 0 && o.gamma === 0 && o.vega === 0).length;
        const dataQuality = fullChain.length > 0 && zeroGreeksCount / fullChain.length > 0.5 ? 'degraded' : 'ok';

        // F6.4 — CBOE fallback produces meaningless scores (all Greeks=0 → LOQ/CSQ ≈ 50)
        const scoresReliable = !(actualDataSource === 'CBOE' && dataQuality === 'degraded');

        // Derive strategyChain: include the closest N expirations to the target DTE.
        // This avoids rigid window edges that miss monthly expirations by 1-2 days.
        let strategyChain = fullChain;
        if (dteTarget != null) {
            // Get unique expirations sorted by distance from target
            const expirations = [...new Set(fullChain.map(o => o.expiration))];
            const expWithDte = expirations.map(exp => {
                const opt = fullChain.find(o => o.expiration === exp);
                return { exp, dte: opt?.dte ?? 0 };
            }).sort((a, b) => Math.abs(a.dte - dteTarget) - Math.abs(b.dte - dteTarget));

            // Take the 3 closest expirations to the target DTE
            const selectedExps = new Set(expWithDte.slice(0, 3).map(e => e.exp));
            strategyChain = fullChain.filter(o => selectedExps.has(o.expiration));

            const selectedDtes = expWithDte.slice(0, 3).map(e => `${e.dte}d(${e.exp})`).join(', ');
            console.log(`[DTE Select] ${upperTicker}: target=${dteTarget}, selected=${selectedDtes}, chain=${strategyChain.length} options`);
        }

        // Build complete IV Term Structure (v2.4 - MarketData upgrade)
        const ivSurface = buildIVTermStructure(fullChain, currentPrice);
        const iv30 = ivSurface.iv30;
        const iv90 = ivSurface.iv90;

        // Calculate Skew — prefer ORATS fitted slope (robust), fallback to chain-based 25-delta search
        const skew = oratsEnrich.slope != null
            ? oratsEnrich.slope
            : calculateSkew(fullChain, currentPrice, dteTarget);

        const chainStrikes = strategyChain.map(o => o.strike);
        const chainStrikeRange = chainStrikes.length > 0 ? { min: Math.min(...chainStrikes), max: Math.max(...chainStrikes) } : null;
        console.log(`[Strategy Recommend] ${upperTicker}: fullChain=${fullChain.length}, strategyChain=${strategyChain.length}, allOptions=${allOptions.length}`);
        console.log(`[Strategy Recommend] ${upperTicker}: price=$${currentPrice}, strikePad=${(chainStrikePad * 100).toFixed(0)}%, strikeRange=$${chainStrikeRange?.min ?? '?'}–$${chainStrikeRange?.max ?? '?'}, widthParam=${widthParam}`);
        console.log(`[Strategy Recommend] ${upperTicker}: IV30=${iv30}, IV90=${iv90}, RV30=${rv30}`);
        console.log(`[Strategy Recommend] ${upperTicker}: DTE buckets in fullChain: ${[...new Set(fullChain.map(o => o.dte))].sort((a, b) => a - b).join(', ')}`);
        const regime = detectRegime(iv30, iv90, rv30, oratsEnrich.ivHvXernRatio);
        console.log(`[Strategy Recommend] ${upperTicker}: regime=${regime.mode}, ivRvRatio=${regime.ivRvRatio}`);

        // Enhance regime advice with anomaly detection
        if (ivSurface.anomaly) {
            regime.advice = '⚠️ IV Spike Detected: Potential Earnings Event';
            regime.adviceDetail = `Near-term IV is ${ivSurface.anomalyRatio.toFixed(2)}x higher than 30-day IV, suggesting an upcoming catalyst (likely earnings). Consider: (1) Avoid selling premium near-term, (2) Use post-event expirations, or (3) Size smaller if trading through the event.`;
        }

        if (iv30 != null) {
            await saveTickerIVSnapshot(upperTicker, iv30, iv90);
        }

        // 2.3 — Regime Hysteresis: prevent flapping near thresholds.
        // Require stronger signal to flip: CREDIT→DEBIT needs termRatio < 0.90, DEBIT→CREDIT needs > 1.10.
        const termRatio = (iv30 && iv90 > 0) ? iv30 / iv90 : 1.0;
        try {
            const sbUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
            const sbKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
            if (sbUrl && sbKey) {
                const threeDaysAgo = new Date();
                threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
                const fromDate = threeDaysAgo.toISOString().slice(0, 10);
                const hParams = new URLSearchParams({ ticker: `eq.${upperTicker}`, recorded_date: `gte.${fromDate}`, order: 'recorded_date.desc', limit: '3' });
                const hRes = await fetch(`${sbUrl}/rest/v1/ticker_iv_snapshots?${hParams}`, {
                    headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` },
                    signal: AbortSignal.timeout(2000),
                });
                if (hRes.ok) {
                    const snapRows = await hRes.json();
                    if (snapRows && snapRows.length >= 2) {
                        const historicalModes = snapRows.map(r => {
                            const ratio = r.iv30 && r.iv90 > 0 ? r.iv30 / r.iv90 : 1.0;
                            return ratio > 1.05 ? 'CREDIT' : ratio < 0.95 ? 'DEBIT' : 'NEUTRAL';
                        });
                        const persistentMode = historicalModes.every(m => m === historicalModes[0]) ? historicalModes[0] : null;
                        if (persistentMode && persistentMode !== regime.mode && regime.mode !== 'NEUTRAL') {
                            if (persistentMode === 'CREDIT' && regime.mode === 'DEBIT' && termRatio >= 0.90) {
                                regime.mode = 'CREDIT';
                                regime.advice += ' [Regime stable: Hysteresis applied]';
                                console.log(`[Hysteresis] ${upperTicker}: Keeping CREDIT (termRatio=${termRatio.toFixed(3)}, needs <0.90 to flip)`);
                            } else if (persistentMode === 'DEBIT' && regime.mode === 'CREDIT' && termRatio <= 1.10) {
                                regime.mode = 'DEBIT';
                                regime.advice += ' [Regime stable: Hysteresis applied]';
                                console.log(`[Hysteresis] ${upperTicker}: Keeping DEBIT (termRatio=${termRatio.toFixed(3)}, needs >1.10 to flip)`);
                            }
                        }
                    }
                }
            }
        } catch (hysteresisErr) {
            console.warn('[Hysteresis] Non-critical query failed:', hysteresisErr.message);
        }

        // IV Rank: extract from ORATS cores (already fetched in batch 1), fallback to ivHistory.cjs
        let ivRank = null, ivPercentile = null, ivRankSampleDays = 0, ivRankSource = null;
        let iv5dChange = null, ivTrend = null, autoBackfillTriggered = false;
        if (oratsCores && oratsCores.ivPctile1y != null) {
            // ORATS cores ivPctile1y is 0–100; normalize to 0–1 for downstream scoring
            ivPercentile = oratsCores.ivPctile1y / 100;
            ivRank = ivPercentile; // ivPctile1y is the percentile rank
            ivRankSampleDays = 252; // ORATS uses 1-year window
            ivRankSource = 'orats';
            console.log(`[IV Rank ORATS] ${upperTicker}: pct=${ivPercentile?.toFixed(3)} (from cores)`);
        }

        // Compute IV momentum from ticker_iv_snapshots (5-day change)
        const sbUrlMom = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
        const sbKeyMom = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
        if (iv5dChange == null && sbUrlMom && sbKeyMom) {
            try {
                const snapRes = await fetch(
                    `${sbUrlMom}/rest/v1/ticker_iv_snapshots?ticker=eq.${upperTicker}&source=eq.live_iv&order=recorded_date.desc&limit=6`,
                    { headers: { apikey: sbKeyMom, Authorization: `Bearer ${sbKeyMom}` } }
                );
                if (snapRes.ok) {
                    const snaps = await snapRes.json();
                    if (snaps.length >= 2) {
                        const latest = snaps[0].iv30;
                        const oldest = snaps[snaps.length - 1].iv30;
                        if (latest != null && oldest != null && oldest > 0) {
                            iv5dChange = Number(((latest - oldest) * 100).toFixed(1)); // pp
                            const changePct = ((latest - oldest) / oldest) * 100;
                            ivTrend = changePct > 10 ? 'rising' : changePct < -10 ? 'falling' : 'flat';
                            console.log(`[IV Momentum] ${upperTicker}: ${iv5dChange}pp (${ivTrend}), ${snaps.length} snapshots`);
                        }
                    }
                }
            } catch (_) { /* non-critical */ }
        }

        // 2. Build Targeted Strategy based on Pine Script recommendation
        const ivScoreInput = ivPercentile ?? ivRank;
        let targetRecs = [];
        const decodedStrategy = targetStrategy ? decodeURIComponent(targetStrategy) : 'Credit Put Spread';

        // --- Entry Profile: convert setup name → concrete builder params ---
        const entryProfile = getEntryProfile();
        let { dtePeak, deltaRange, allowChase } = entryProfile;

        // v4 Entry Context overrides: adjust DTE peak and delta range based on entry quality
        //   OPTIMAL  → pullback to 4H EMA support; tighten DTE (less theta bleed) + raise delta
        //   CHASING  → extended above EMA; lengthen DTE (more time for pullback) + lower delta
        if (entryCtx === 'OPTIMAL') {
            dtePeak = Math.max(14, Math.round(dtePeak * 0.75));
            deltaRange = [
                Math.min(parseFloat((deltaRange[0] + 0.05).toFixed(2)), 0.65),
                Math.min(parseFloat((deltaRange[1] + 0.05).toFixed(2)), 0.80)
            ];
            console.log(`[EntryContext] ${entryCtx}: dtePeak→${dtePeak}, deltaRange→[${deltaRange}]`);
        } else if (entryCtx === 'CHASING') {
            dtePeak = Math.min(45, Math.round(dtePeak * 1.25));
            deltaRange = [
                Math.max(parseFloat((deltaRange[0] - 0.05).toFixed(2)), 0.35),
                Math.max(parseFloat((deltaRange[1] - 0.10).toFixed(2)), 0.50)
            ];
            console.log(`[EntryContext] ${entryCtx}: dtePeak→${dtePeak}, deltaRange→[${deltaRange}]`);
        }

        // Auto-detect overextended from d8:
        //   If d8 > 1.5% for BULL (price is >1.5% above EMA-8) it's a chase entry.
        //   If d8 < -1.5% for BEAR (price is >1.5% below EMA-8) same risk.
        // The user's manual flag is an OR gate — either the user flags it or d8 signals it.
        const autoOverextended = d8Param != null
            ? (isBull ? d8Param > 1.5 : d8Param < -1.5)
            : false;

        if (autoOverextended) {
            console.log(`[EntryProfile] ${upperTicker}: auto-flagging overextended (d8=${d8Param?.toFixed(2)}, direction=${isBull ? 'BULL' : 'BEAR'})`);
        }

        // Vol forecast adjustment (ORATS forward-looking)
        const volFcstAdj = getVolForecastAdjustment(
            oratsEnrich.orFcst20d, iv30, oratsEnrich.fcstR2,
            isBull ? 'long' : 'short'
        );
        if (volFcstAdj !== 0) {
            console.log(`[VolForecast] ${upperTicker}: adj=${volFcstAdj.toFixed(3)}, fcst20d=${oratsEnrich.orFcst20d}, iv30=${iv30?.toFixed(4)}, R²=${oratsEnrich.fcstR2}`);
        }

        // Collect rejection diagnostics from spread builders
        let rejectionDiagnostics = null;

        if (decodedStrategy === 'Auto-Select Strategy') {
            if (isBull) {
                const creditRes = buildCreditSpreads(strategyChain, 'Put', currentPrice, regime.ivRvRatio, daysUntilEarnings, skew, widthParam, ivScoreInput, ivSurface.anomaly, dtePeak, ivRankSampleDays, volFcstAdj);
                rejectionDiagnostics = creditRes._diagnostics || null;
                targetRecs = [
                    ...creditRes,
                    ...buildDebitSpreads(strategyChain, 'Call', currentPrice, regime.ivRvRatio, widthParam, ivScoreInput, daysUntilEarnings, ivSurface.anomaly, dtePeak, deltaRange, ivRankSampleDays, volFcstAdj),
                    ...scoreSingleLegs(strategyChain, 'Call', regime.ivRvRatio, currentPrice, regime.ivRatio, ivScoreInput, ivRankSampleDays, volFcstAdj),
                    ...buildIronCondors(strategyChain, currentPrice, regime.ivRvRatio, daysUntilEarnings, skew, widthParam, ivScoreInput, ivSurface.anomaly, ivRankSampleDays, volFcstAdj)
                ];
            } else {
                const creditRes = buildCreditSpreads(strategyChain, 'Call', currentPrice, regime.ivRvRatio, daysUntilEarnings, skew, widthParam, ivScoreInput, ivSurface.anomaly, dtePeak, ivRankSampleDays, volFcstAdj);
                rejectionDiagnostics = creditRes._diagnostics || null;
                targetRecs = [
                    ...creditRes,
                    ...buildDebitSpreads(strategyChain, 'Put', currentPrice, regime.ivRvRatio, widthParam, ivScoreInput, daysUntilEarnings, ivSurface.anomaly, dtePeak, deltaRange, ivRankSampleDays, volFcstAdj),
                    ...scoreSingleLegs(strategyChain, 'Put', regime.ivRvRatio, currentPrice, regime.ivRatio, ivScoreInput, ivRankSampleDays, volFcstAdj),
                    ...buildIronCondors(strategyChain, currentPrice, regime.ivRvRatio, daysUntilEarnings, skew, widthParam, ivScoreInput, ivSurface.anomaly, ivRankSampleDays, volFcstAdj)
                ];
            }
        } else if (decodedStrategy === 'Credit Put Spread') {
            targetRecs = buildCreditSpreads(strategyChain, 'Put', currentPrice, regime.ivRvRatio, daysUntilEarnings, skew, widthParam, ivScoreInput, ivSurface.anomaly, dtePeak, ivRankSampleDays, volFcstAdj);
            rejectionDiagnostics = targetRecs._diagnostics || null;
        } else if (decodedStrategy === 'Debit Call Spread') {
            targetRecs = buildDebitSpreads(strategyChain, 'Call', currentPrice, regime.ivRvRatio, widthParam, ivScoreInput, daysUntilEarnings, ivSurface.anomaly, dtePeak, deltaRange, ivRankSampleDays, volFcstAdj);
        } else if (decodedStrategy === 'Long Call') {
            targetRecs = scoreSingleLegs(strategyChain, 'Call', regime.ivRvRatio, currentPrice, regime.ivRatio, ivScoreInput, ivRankSampleDays, volFcstAdj);
        } else if (decodedStrategy === 'Credit Call Spread') {
            targetRecs = buildCreditSpreads(strategyChain, 'Call', currentPrice, regime.ivRvRatio, daysUntilEarnings, skew, widthParam, ivScoreInput, ivSurface.anomaly, dtePeak, ivRankSampleDays, volFcstAdj);
            rejectionDiagnostics = targetRecs._diagnostics || null;
        } else if (decodedStrategy === 'Debit Put Spread') {
            targetRecs = buildDebitSpreads(strategyChain, 'Put', currentPrice, regime.ivRvRatio, widthParam, ivScoreInput, daysUntilEarnings, ivSurface.anomaly, dtePeak, deltaRange, ivRankSampleDays, volFcstAdj);
        } else if (decodedStrategy === 'Long Put') {
            targetRecs = scoreSingleLegs(strategyChain, 'Put', regime.ivRvRatio, currentPrice, regime.ivRatio, ivScoreInput, ivRankSampleDays, volFcstAdj);
        } else if (decodedStrategy === 'Iron Condor') {
            targetRecs = buildIronCondors(strategyChain, currentPrice, regime.ivRvRatio, daysUntilEarnings, skew, widthParam, ivScoreInput, ivSurface.anomaly, ivRankSampleDays, volFcstAdj);
        }

        // Build rejection summary: chain-level + spread-builder-level diagnostics
        const chainDteRange = strategyChain.length > 0
            ? { min: Math.min(...strategyChain.map(o => o.dte)), max: Math.max(...strategyChain.map(o => o.dte)) }
            : null;
        const _rejectionSummary = {
            fullChainSize: fullChain.length,
            strategyChainSize: strategyChain.length,
            dteWindow: dteTarget != null ? { target: dteTarget, range: 10, actual: chainDteRange } : null,
            ...(rejectionDiagnostics ? { filters: rejectionDiagnostics } : {}),
        };

        // 3. Score the targeted strategy using the unified algorithm
        const unifiedOpts = {
            anomaly: ivSurface.anomaly || false,
            termStrength: regime.slopeTier || undefined
        };

        for (const rec of targetRecs) {
            let simCat = 'CREDIT_SPREAD';
            const recType = rec.type || decodedStrategy;
            if (recType.includes('Debit')) simCat = 'DEBIT_SPREAD';
            if (recType.includes('Long')) simCat = 'SINGLE_LEG';
            if (recType === 'Iron Condor') simCat = 'IRON_CONDOR';

            const creditSpreadType = (simCat === 'CREDIT_SPREAD' && recType.includes('Put')) ? 'Put' : 'Call';

            // Iron Condor has its own comprehensive scorer — skip unified re-scoring
            if (simCat === 'IRON_CONDOR') {
                rec.setup = '';
                rec.strategyCategory = simCat;
                rec.unifiedScore = rec.score;
                rec.factors = rec.factors || [];
            } else {
                const { score: unifiedScore, factors } = calculateUnifiedScore(
                    rec,
                    simCat,
                    regime.mode,
                    regime.ivRvRatio,
                    { ...unifiedOpts, skew, creditSpreadType }
                );

                rec.setup = '';
                rec.strategyCategory = simCat;
                rec.unifiedScore = unifiedScore;
                // Overwrite the normal score with unifiedScore so UI doesn't need branching
                rec.score = unifiedScore;
                rec.factors = factors || [];
            }
        }
        targetRecs.sort((a, b) => b.unifiedScore - a.unifiedScore);

        // 3c. Pine Risk Flags Adjustments
        // overextended is an OR of the user's manual flag AND the auto-detected d8 flag
        const overextended = req.query.overextended === 'true' || autoOverextended;
        const mtfConflict = req.query.mtfConflict === 'true';
        const lowVolume = req.query.lowVolume === 'true';
        const nearEarnings = req.query.nearEarnings === 'true';
        const highVolatility = req.query.highVolatility === 'true';
        const priceReversing = req.query.priceReversing === 'true';

        for (const pick of targetRecs) {
            let flagBonus = 0;
            const flagNotes = [];
            const isDebit = pick.strategyCategory === 'DEBIT_SPREAD' || pick.strategyCategory === 'SINGLE_LEG';
            const isCredit = pick.strategyCategory === 'CREDIT_SPREAD';
            const isIC = pick.strategyCategory === 'IRON_CONDOR';
            const _dte = pick.shortLeg?.dte || pick.longLeg?.dte || 30;

            if (overextended) {
                if (isDebit) {
                    flagBonus -= 30;
                    flagNotes.push('⚠️ Overextended: Debit strategies heavily penalized due to mean-reversion risk.');
                } else if (isCredit) {
                    flagBonus += 15;
                    flagNotes.push('🛡️ Overextended: Credit spreads benefit from mean-reversion environment — theta decay continues regardless.');
                }
            }

            if (mtfConflict) {
                if (_dte > 21) {
                    flagBonus -= 20;
                    flagNotes.push('⚠️ MTF Conflict: Long DTE penalized because higher timeframe trend opposes setup.');
                } else {
                    flagBonus += 10;
                    flagNotes.push('🛡️ MTF Conflict: Short DTE scalp boosted to avoid higher timeframe trend.');
                }
            }

            if (lowVolume) {
                if (isDebit) {
                    flagBonus -= 25;
                    flagNotes.push('⚠️ Low Volume: Debit strategies penalized — momentum trades require volume confirmation.');
                } else if (isIC) {
                    flagBonus += 15;
                    flagNotes.push('🛡️ Low Volume: Iron Condors boosted for range-bound low-volume chop.');
                }
            }

            if (nearEarnings) {
                if (isDebit) {
                    flagBonus -= 40;
                    flagNotes.push('🚫 Near Earnings: Long vega structures heavily penalized due to IV crush risk.');
                } else {
                    flagBonus += 10;
                    flagNotes.push('🛡️ Near Earnings: Short vega boosted for IV crush, but maintain caution.');
                }
            }

            if (highVolatility) {
                if (isCredit) {
                    flagBonus += 10;
                    flagNotes.push('🔥 High Volatility: Favors credit spreads to capture IV premium and benefit from IV crush.');
                } else if (isDebit) {
                    flagBonus -= 15;
                    flagNotes.push('⚠️ High Volatility: Debit spreads at higher risk of IV crush; premium is expensive.');
                }
            }

            if (priceReversing) {
                if (isDebit || pick.strategyCategory === 'SINGLE_LEG') {
                    flagBonus -= 25;
                    flagNotes.push('🔄 Price Reversing: Direction-heavy strategies penalized due to lack of stable trend momentum.');
                } else if (isIC) {
                    flagBonus += 15;
                    flagNotes.push('🛡️ Price Reversing: Excellent environment for Iron Condors as price reverts to the mean.');
                } else if (isCredit) {
                    flagBonus -= 5;
                    flagNotes.push('🔄 Price Reversing: Use caution even with credit spreads during trend transitions.');
                }
            }

            if (flagBonus !== 0) {
                pick.score = Math.max(0, Math.min(100, (pick.score || 0) + flagBonus));
                pick.unifiedScore = Math.max(0, Math.min(100, (pick.unifiedScore || 0) + flagBonus));
                if (Array.isArray(pick.factors)) {
                    pick.factors.push({
                        name: 'Pine Risk Flags',
                        impact: flagBonus,
                        description: flagNotes.join(' '),
                        value: undefined,
                    });
                }
            }

            // 3d. v4 Entry Context adjustments
            // OPTIMAL  → price near EMA support → debit strategies get maximum leverage
            // CHASING  → extended entry above EMA → credit collects theta while price reverts
            // MARGINAL → entry quality borderline → slight debit penalty
            // ACCEPTABLE → neutral; no adjustment
            if (entryCtx) {
                let ecBonus = 0;
                const ecNotes = [];

                if (entryCtx === 'OPTIMAL') {
                    if (isDebit) {
                        ecBonus += 20;
                        ecNotes.push('✦ OPTIMAL Entry: Price near EMA support with momentum reset — debit strategies boosted.');
                    } else if (isCredit) {
                        ecBonus -= 10;
                        ecNotes.push('↓ OPTIMAL Entry: Near-support entry favors debit over credit; credit still valid if IV regime strongly favors selling.');
                    }
                } else if (entryCtx === 'CHASING') {
                    if (isCredit) {
                        ecBonus += 15;
                        ecNotes.push('🛡️ CHASING Entry: Price extended above EMA — credit spreads collect theta while price reverts.');
                    } else if (isDebit) {
                        ecBonus -= 20;
                        ecNotes.push('⚠️ CHASING Entry: Extended entry — debit strategies face mean-reversion risk; consider credit instead.');
                    }
                } else if (entryCtx === 'MARGINAL') {
                    if (isDebit) {
                        ecBonus -= 5;
                        ecNotes.push('⚠️ MARGINAL Entry: Entry quality suboptimal — reduce size or wait for a better setup.');
                    }
                }
                // ACCEPTABLE: no adjustment

                if (ecBonus !== 0) {
                    pick.score = Math.max(0, Math.min(100, (pick.score || 0) + ecBonus));
                    pick.unifiedScore = Math.max(0, Math.min(100, (pick.unifiedScore || 0) + ecBonus));
                    if (Array.isArray(pick.factors)) {
                        pick.factors.push({
                            name: 'v4 Entry Context',
                            impact: ecBonus,
                            description: ecNotes.join(' '),
                            value: entryCtx,
                        });
                    }
                }
            }
        }
        targetRecs.sort((a, b) => b.unifiedScore - a.unifiedScore);

        // If Auto-Select Strategy mode, truncate to top 5 out of all structures generated
        if (decodedStrategy === 'Auto-Select Strategy') {
            targetRecs = targetRecs.slice(0, 5);
        }

        const contextIV = iv30 ?? null;
        const earningsPremiumContext = contextIV && currentPrice > 0
            ? estimateEarningsPremium(daysUntilEarnings, dteTarget, contextIV, currentPrice)
            : null;

        // 4.2 — Fire-and-forget: persist top-5 candidates for Score→P&L validation
        try {
            const sbUrl2 = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
            const sbKey2 = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
            const top5 = targetRecs.slice(0, 5);
            if (top5.length > 0 && sbUrl2 && sbKey2) {
                const rows = top5.map(r => {
                    const isSpread = 'shortLeg' in r && 'longLeg' in r;
                    return {
                        ticker: upperTicker,
                        strategy_type: r.type || 'UNKNOWN',
                        strategy_category: r.strategyCategory || (isSpread ? 'CREDIT_SPREAD' : 'SINGLE_LEG'),
                        unified_score: typeof r.unifiedScore === 'number' ? r.unifiedScore : null,
                        ev_risk_ratio: typeof r.evRiskRatio === 'number' ? r.evRiskRatio : null,
                        pop: typeof r.pop === 'number' ? r.pop : null,
                        regime_mode: regime.mode || null,
                        iv_rank: ivRank != null ? ivRank : null,
                        direction: isBull ? 'BULL' : 'BEAR',
                        short_strike: isSpread ? (r.shortLeg?.strike ?? null) : (r.strike ?? null),
                        long_strike: isSpread ? (r.longLeg?.strike ?? null) : null,
                        expiration: isSpread ? (r.shortLeg?.expiration ?? null) : (r.expiration ?? null),
                        entry_mid: isSpread
                            ? (r.netCredit ?? r.netDebit ?? null)
                            : (r.price ?? null),
                    };
                });
                // Fire-and-forget — don't await, don't block response
                fetch(`${sbUrl2}/rest/v1/candidate_snapshots`, {
                    method: 'POST',
                    headers: {
                        'apikey': sbKey2,
                        'Authorization': `Bearer ${sbKey2}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=minimal',
                    },
                    body: JSON.stringify(rows),
                    signal: AbortSignal.timeout(3000),
                }).then(r => {
                    if (!r.ok) r.text().then(t => console.warn('[Strategy Recommend] candidate_snapshots insert failed:', t));
                }).catch(e => console.warn('[Strategy Recommend] candidate_snapshots fetch error:', e?.message));
            }
        } catch (snapErr) {
            console.warn('[Strategy Recommend] candidate_snapshots fire-and-forget error:', snapErr?.message);
        }

        // ── Score History Audit Trail (F10 — Forensic Audit v1.1) ──────────
        // Fire-and-forget: log top scored options for drift analysis.
        try {
            const sbUrl3 = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
            const sbKey3 = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
            if (sbUrl3 && sbKey3 && targetRecs.length > 0) {
                const isSpreadRec = (r) => 'shortLeg' in r && 'longLeg' in r;
                const historyRows = targetRecs.slice(0, 10).map(r => ({
                    ticker: upperTicker,
                    expiration: isSpreadRec(r) ? (r.shortLeg?.expiration || null) : (r.expiration ?? null),
                    strike: isSpreadRec(r) ? (r.shortLeg?.strike || null) : (r.strike ?? null),
                    option_type: isSpreadRec(r) ? null : (r.type ?? null),
                    score: r.unifiedScore ?? r.score ?? 0,
                    score_type: r.strategyCategory || 'UNIFIED',
                    factors: r.unifiedFactors ? JSON.stringify(r.unifiedFactors) : null,
                    regime_mode: regime.mode,
                    iv_rank: ivRank,
                    data_source: actualDataSource,
                }));
                fetch(`${sbUrl3}/rest/v1/score_history`, {
                    method: 'POST',
                    headers: {
                        'apikey': sbKey3,
                        'Authorization': `Bearer ${sbKey3}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=minimal',
                    },
                    body: JSON.stringify(historyRows),
                    signal: AbortSignal.timeout(3000),
                }).then(r => {
                    if (!r.ok) r.text().then(t => console.warn('[Strategy Recommend] score_history insert failed:', t));
                }).catch(e => console.warn('[Strategy Recommend] score_history fetch error:', e?.message));
            }
        } catch (histErr) {
            console.warn('[Strategy Recommend] score_history fire-and-forget error:', histErr?.message);
        }

        return res.status(200).json({
            success: true,
            autoBackfillTriggered,
            dataSource: actualDataSource,   // 'ORATS' or 'CBOE' (fallback)
            dataQuality,                    // 'degraded' when >50% of options have zero Greeks
            scoresReliable,                 // false when CBOE + degraded → scores are meaningless
            quoteFreshness: quoteFreshness ?? null, // { isStale, staleQuotes, oldestQuoteAgeMs }
            context: {
                ticker: upperTicker,
                currentPrice,
                direction: isBull ? 'BULL' : 'BEAR',
                targetDte: dteTarget,
                daysUntilEarnings,
                earningsSource: oratsCores?.daysToNextErn != null ? 'orats' : 'nasdaq',
                impliedMovePct: oratsCores?.impliedMove != null ? Number(oratsCores.impliedMove.toFixed(2)) : null,   // ORATS already in % (e.g. 8.5 = 8.5%)
                impErnMvPct: oratsCores?.impErnMv != null ? Number(oratsCores.impErnMv.toFixed(2)) : null,           // ORATS already in % (e.g. 13.8 = 13.8%)
                putCallRatio: oratsCores ? Number(((oratsCores.pVolu || 0) / Math.max(oratsCores.cVolu || 1, 1)).toFixed(3)) : null,
                contango: oratsCores?.contango ?? null,
                tkOver: oratsEnrich?.tkOver === 1 || undefined,
                avgOptVolu20d: oratsEnrich?.avgOptVolu20d ?? null,
                volForecast: oratsEnrich?.orFcst20d != null ? {
                    fcst20d: Number((oratsEnrich.orFcst20d * 100).toFixed(1)),
                    r2: oratsEnrich.fcstR2 != null ? Number(oratsEnrich.fcstR2.toFixed(3)) : null,
                } : null,
                ...(earningsPremiumContext ? { earningsPremium: earningsPremiumContext } : {})
            },
            regime: {
                ivRatio: regime.ivRatio != null ? Number(regime.ivRatio.toFixed(3)) : null,
                slope: regime.slope != null ? Number(regime.slope.toFixed(3)) : null,
                slopeTier: regime.slopeTier || null,
                iv30: iv30 != null ? Number((iv30 * 100).toFixed(1)) : null,
                iv90: iv90 != null ? Number((iv90 * 100).toFixed(1)) : null,
                rv30: rv30 != null ? Number(rv30.toFixed(1)) : null,
                ivRvRatio: regime.ivRvRatio != null ? Number(regime.ivRvRatio.toFixed(3)) : null,
                ivRank: ivRank != null ? Number(ivRank.toFixed(3)) : null,
                ivPercentile: ivPercentile != null ? Number(ivPercentile.toFixed(3)) : null,
                ivRankSampleDays: ivRankSampleDays,
                ivRankSource: ivRankSource,
                // IV Momentum (v2.4): direction of IV30 over last 5 trading days
                iv5dChange: iv5dChange,
                ivTrend: ivTrend,
                mode: regime.mode,
                advice: regime.advice,
                adviceDetail: regime.adviceDetail || null,
                vrp: regime.vrp != null ? Number(regime.vrp.toFixed(1)) : null,
                ivLevel: regime.ivLevel || null,
                ivSurface: {
                    iv7: ivSurface.iv7 ? Number((ivSurface.iv7 * 100).toFixed(1)) : null,
                    iv14: ivSurface.iv14 ? Number((ivSurface.iv14 * 100).toFixed(1)) : null,
                    iv30: ivSurface.iv30 ? Number((ivSurface.iv30 * 100).toFixed(1)) : null,
                    iv60: ivSurface.iv60 ? Number((ivSurface.iv60 * 100).toFixed(1)) : null,
                    iv90: ivSurface.iv90 ? Number((ivSurface.iv90 * 100).toFixed(1)) : null,
                    iv120: ivSurface.iv120 ? Number((ivSurface.iv120 * 100).toFixed(1)) : null,
                    anomaly: ivSurface.anomaly || false,
                    anomalyRatio: ivSurface.anomalyRatio ? Number(ivSurface.anomalyRatio.toFixed(2)) : null
                }
            },
            recommendedStrategy: decodedStrategy,
            entryProfileMeta: {
                dtePeak,
                deltaRange,
                allowChase,
                autoOverextended,
                d8: d8Param,
                entryContext: entryCtx,
                entryQuality: entryQualityNum,
            },
            strategies: {
                TARGET_STRATEGY: targetRecs,
                _regimeMeta: { skew }
            },
            rejectionDiagnostics: targetRecs.length === 0 ? _rejectionSummary : undefined,
        });

    } catch (error) {
        const errMsg = error && typeof error.message === 'string' ? error.message : String(error);
        console.error('Strategy API Error:', errMsg);
        return res.status(500).json({ error: 'Internal Server Error', message: errMsg });
    }
}
