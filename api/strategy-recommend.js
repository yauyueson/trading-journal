// api/strategy-recommend.js
// Strategy Recommender API - Intelligent Options Strategy Selection
// Based on IV Regime and User Direction (BULL/BEAR)
// Uses shared scoring module (Single Source of Truth)
// Modules loaded inside handler via dynamic import() so failures return JSON on Vercel.

let compressLambda, calculateGammaThetaRatio, calculateBreakevenMove, getBreakevenPenalty,
    calculateExpectedValue, getThetaPenalty, getDeltaBonus, zScores, zScoresByBucket, HARD_FILTER_DEFAULTS,
    getIVRiskFactor, getIVAdjustment, getIVRankAdjustment, getRelativeIVAdjustmentLOQ, getRelativeIVAdjustmentCSQ,
    calculateLOQRaw, normalizeScoreTo100, normalizeLOQScoresWithDynamicBaseline, calculateSpreadPct,
    getCleanATM_IV, calculateTargetIV, buildIVTermStructure, parseChain, calculateSkew, estimateSlippage, getGammaRiskPenalty,
    getSkewBonusForCreditSpread, calculateUnifiedScore;
let saveTickerIVSnapshot, getIVRank;
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
    calculateGammaThetaRatio = scoring.calculateGammaThetaRatio;
    calculateBreakevenMove = scoring.calculateBreakevenMove;
    getBreakevenPenalty = scoring.getBreakevenPenalty;
    calculateExpectedValue = scoring.calculateExpectedValue;
    getThetaPenalty = scoring.getThetaPenalty;
    getDeltaBonus = scoring.getDeltaBonus;
    zScores = scoring.zScores;
    zScoresByBucket = scoring.zScoresByBucket;
    HARD_FILTER_DEFAULTS = scoring.HARD_FILTER_DEFAULTS;
    getIVRiskFactor = scoring.getIVRiskFactor;
    getIVAdjustment = scoring.getIVAdjustment;
    getIVRankAdjustment = scoring.getIVRankAdjustment;
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
        getIVRank = iv.getIVRank;
    } catch (_) {
        saveTickerIVSnapshot = async () => { };
        getIVRank = async () => ({ ivRank: null, ivPercentile: null, sampleDays: 0 });
    }
    _scoringLoaded = true;
}

// =============================================================================
// DATA FETCHING UTILITIES
// =============================================================================

async function fetchRV30(ticker) {
    try {
        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(toDate.getDate() - 60); // Fetch 60 days to ensure enough trading days for 30-day window
        const toStr = toDate.toISOString().split('T')[0];
        const fromStr = fromDate.toISOString().split('T')[0];

        const url = `https://api.nasdaq.com/api/quote/${ticker.toUpperCase()}/historical?assetclass=stocks&fromdate=${fromStr}&todate=${toStr}&limit=60`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) return null;
        const data = await response.json();
        const rows = data?.data?.tradesTable?.rows || [];
        if (rows.length < 5) return null;

        const prices = rows
            .map(row => parseFloat(row.close.replace('$', '').replace(',', '')))
            .filter(price => !isNaN(price))
            .reverse();

        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push(Math.log(prices[i] / prices[i - 1]));
        }

        const recentReturns = returns.slice(-30);
        const mean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
        const variance = recentReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recentReturns.length;
        return Math.sqrt(variance) * Math.sqrt(252) * 100;
    } catch (e) {
        console.error("RV Fetch Error:", e);
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
                        const dateStr = match[1].trim();
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

/** Term structure slope = (IV30 - IV90) / IV90. Positive = backwardation, negative = contango. */
const SLOPE_STRONG_BACK = 0.15;   // termRatio > 1.15
const SLOPE_BACK = 0.05;         // termRatio > 1.05
const SLOPE_FLAT_LO = -0.05;     // termRatio >= 0.95
const SLOPE_CONTANGO = -0.15;    // termRatio < 0.95

function detectRegime(iv30, iv90, rv20) {
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
    const ivRvRatio = rv20 ? (iv30 * 100) / rv20 : null;

    let slopeTier = 'flat';
    if (slope >= SLOPE_STRONG_BACK) slopeTier = 'strong_backwardation';
    else if (slope >= SLOPE_BACK) slopeTier = 'backwardation';
    else if (slope <= SLOPE_CONTANGO) slopeTier = 'strong_contango';
    else if (slope < SLOPE_FLAT_LO) slopeTier = 'contango';

    let mode = 'NEUTRAL';
    let advice = 'Neutral IV: Either strategy viable, compare scores';
    let adviceDetail = 'IV30 and IV90 are close (ratio near 1), so the term structure is flat. Neither selling nor buying volatility has a clear edge from term structure alone. Compare the scores and metrics (EV, ROI, POP, R:R) across Credit Spreads, Debit Spreads, and Long Options to choose.';

    if (termRatio > 1.05) {
        mode = 'CREDIT';
        advice = slopeTier === 'strong_backwardation'
            ? 'Strong Backwardation: Favor Credit Spreads'
            : 'Backwardation (Expensive near-term): Sell Credit Spreads';
        adviceDetail = slopeTier === 'strong_backwardation'
            ? 'Term structure slope is strongly positive (IV30 well above IV90)—short-dated options are rich vs longer-dated. Selling premium (credit spreads) has a clear term-structure edge. '
            : 'Near-term IV (IV30) is higher than IV90—backwardation. Short-dated options are priced rich vs longer-dated, so selling premium (credit spreads) is favored. ';
        if (ivRvRatio != null) {
            if (ivRvRatio > 1.05) {
                adviceDetail += `IV/RV is ${ivRvRatio.toFixed(2)} (above 1): the market is paying a volatility premium vs recent realized; credit spreads let you collect that premium with defined risk. `;
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
        if (ivRvRatio != null) {
            if (ivRvRatio < 1) {
                adviceDetail += `IV/RV is ${ivRvRatio.toFixed(2)} (below 1): realized vol has been higher than implied, so long options can benefit from a vol or directional move without overpaying. Debit spreads reduce cost and cap risk vs a single long while keeping leverage. `;
            } else {
                adviceDetail += `IV/RV is ${ivRvRatio.toFixed(2)} (above 1): options are still priced above recent realized vol—you are paying volatility risk premium (VRP). So favor debit spreads only when selective: long-leg delta 0.50–0.65, risk/reward ≥ 1.5, DTE 30–45. If you have no strong direction and want to earn VRP, a small size credit spread (good distance, liquidity, avoid earnings) can also be appropriate since IV > RV is statistically seller-friendly. `;
            }
        }
        adviceDetail += 'Debit spreads cap risk and keep positive delta with lower capital than a naked long.';
    }

    return { ivRatio: termRatio, slope, slopeTier, ivRvRatio, mode, advice, adviceDetail };
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

function buildCreditSpreads(chain, type, currentPrice, ivRvRatio, daysUntilEarnings, skew, customWidth, ivRank = null) {
    const results = [];
    const widths = customWidth ? [customWidth] : [5, 10];
    const ivRankAdj = getIVRankAdjustment(ivRank ?? null, 'short');
    const atmIV = getCleanATM_IV(chain, currentPrice);

    const shorts = chain.filter(o =>
        o.type === type &&
        Math.abs(o.delta) >= 0.20 &&
        Math.abs(o.delta) <= 0.40
    );

    for (const shortLeg of shorts) {
        for (const width of widths) {
            const longStrike = type === 'Put' ? shortLeg.strike - width : shortLeg.strike + width;
            const longLeg = chain.find(o =>
                o.type === type &&
                o.expiration === shortLeg.expiration &&
                Math.abs(o.strike - longStrike) < 0.1
            );

            if (!longLeg) continue;

            // Liquidity Guard (Composite)
            if (shortLeg.bid <= 0 || longLeg.ask <= 0) continue;

            // Hard filters on both legs
            const shortMid = (shortLeg.bid + shortLeg.ask) / 2;
            const longMid = (longLeg.bid + longLeg.ask) / 2;
            if (shortMid < HARD_FILTER_DEFAULTS.minMid || longMid < HARD_FILTER_DEFAULTS.minMid) continue;
            if (shortLeg.openInterest < HARD_FILTER_DEFAULTS.minOpenInterest || longLeg.openInterest < HARD_FILTER_DEFAULTS.minOpenInterest) continue;
            const spreadBid = shortLeg.bid - longLeg.ask;
            const spreadAsk = shortLeg.ask - longLeg.bid;
            const spreadMid = (spreadBid + spreadAsk) / 2;

            if (spreadBid <= 0.10) continue;

            const spreadPct = spreadMid > 0 ? (spreadAsk - spreadBid) / spreadMid : 1.0;
            if (spreadPct > 0.15) continue;

            // Key Metrics
            const credit = spreadBid;
            const maxRisk = width - credit;
            const breakeven = type === 'Put' ? shortLeg.strike - credit : shortLeg.strike + credit;
            const deltaAtBE = getDeltaAtStrike(chain, type, shortLeg.expiration, breakeven);
            const probITMAtBE = getProbITMAtStrike(chain, type, shortLeg.expiration, breakeven);

            // Prioritize Probability of ITM field if available, else derive from Delta at BE, else fallback to short leg delta
            let pop;
            if (probITMAtBE != null && probITMAtBE > 0) {
                pop = 1 - probITMAtBE;
            } else if (deltaAtBE != null) {
                pop = 1 - Math.abs(deltaAtBE);
            } else {
                pop = 1 - Math.abs(shortLeg.delta);
            }
            const roi = (credit / maxRisk) * 100;
            const distance = Math.abs(currentPrice - shortLeg.strike) / currentPrice;
            const dte = shortLeg.dte;

            // Earnings Guard
            const includesEarnings = daysUntilEarnings !== null && daysUntilEarnings <= dte && daysUntilEarnings >= 0;
            const earningsRisk = includesEarnings && daysUntilEarnings <= 10;
            if (earningsRisk) continue;

            // 4. Slippage Modeling (New)
            // Instead of hard filter > 0.15, we penalize the credit
            const slippage1 = estimateSlippage(shortLeg.bid, shortLeg.ask);
            const slippage2 = estimateSlippage(longLeg.bid, longLeg.ask);
            const totalSlippage = slippage1 + slippage2;
            const effectiveCredit = credit - totalSlippage; // Real-world fill

            if (effectiveCredit <= 0) continue; // If slippage eats all profit, skip

            const effectiveMaxRisk = width - effectiveCredit;
            const effectiveROI = (effectiveCredit / effectiveMaxRisk) * 100;

            // Hard filter relaxed from 0.15 to 0.30 to allow wider spreads if EV is good
            if (spreadPct > 0.30) continue;

            // Scoring (v2.2 — EV-enhanced + Slippage)
            const ev = calculateExpectedValue(pop, effectiveCredit, effectiveMaxRisk);
            const evRatio = effectiveCredit > 0 ? ev / effectiveCredit : 0;
            const scoreEV = Math.max(0, Math.min(100, 50 + evRatio * 100));

            const scoreROI = Math.min(effectiveROI * 4, 100);
            const scorePOP = pop * 100;
            const scoreDistance = Math.min(distance * 1000, 100);

            // 5. Gamma Risk (New)
            const gammaPenalty = getGammaRiskPenalty(shortLeg.gamma, shortLeg.theta, dte);

            // Relative IV (same-DTE ATM): sell expensive vol → small bonus; vega penalty already limits vol crush exposure
            const relativeIVBonus = getRelativeIVAdjustmentCSQ(shortLeg.iv, atmIV) * 15;

            // 2. Skew Adjustment: magnitude-based bonus (|skew| larger → same-direction bonus scales 5..15, capped)
            const skewBonus = getSkewBonusForCreditSpread(skew, type);

            let scoreDTE = 50;
            if (dte >= 30 && dte <= 45) scoreDTE = 100;
            else if (dte >= 21 && dte < 30) scoreDTE = 75;
            else if (dte > 45 && dte <= 60) scoreDTE = 80;
            else if (dte < 21) scoreDTE = 20;

            let finalScore = (0.20 * scoreEV) + (0.20 * scoreROI) + (0.20 * scorePOP) + (0.15 * scoreDistance) + (0.25 * scoreDTE) + skewBonus + gammaPenalty + relativeIVBonus;
            finalScore += ivRankAdj * 2;
            if (includesEarnings) finalScore -= 25;

            if (effectiveROI < 10) continue; // Lowered ROI floor because we are using net effective ROI now

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
                width,
                netCredit: Number(credit.toFixed(2)),
                maxRisk: Number(maxRisk.toFixed(2)),
                maxProfit: Number(credit.toFixed(2)),
                roi: Number(roi.toFixed(1)),
                pop: Number((pop * 100).toFixed(1)),
                expectedValue: Number(((credit * pop) - (maxRisk * (1 - pop))).toFixed(2)),
                distance: Number((distance * 100).toFixed(1)),
                breakeven,
                score: Math.min(100, Math.max(0, Math.round(finalScore))),
                whyThis: whyThisParts.join(', ') || 'Balanced Risk/Reward',
                recommendation: {
                    action: "SELL (Open)",
                    note
                }
            });
        }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

function buildDebitSpreads(chain, type, currentPrice, ivRvRatio, customWidth, ivRank = null) {
    const results = [];
    const widths = customWidth ? [customWidth] : [2.5, 5];
    const ivRankAdj = getIVRankAdjustment(ivRank ?? null, 'long');

    const longs = chain.filter(o =>
        o.type === type &&
        Math.abs(o.delta) >= 0.45 &&
        Math.abs(o.delta) <= 0.70
    );

    for (const longLeg of longs) {
        for (const width of widths) {
            const shortStrike = type === 'Call' ? longLeg.strike + width : longLeg.strike - width;
            const shortLeg = chain.find(o =>
                o.type === type &&
                o.expiration === longLeg.expiration &&
                Math.abs(o.strike - shortStrike) < 0.1
            );

            if (!shortLeg) continue;

            // Hard filters on both legs
            const longMidDS = (longLeg.bid + longLeg.ask) / 2;
            const shortMidDS = (shortLeg.bid + shortLeg.ask) / 2;
            if (longMidDS < HARD_FILTER_DEFAULTS.minMid || shortMidDS < HARD_FILTER_DEFAULTS.minMid) continue;
            if (longLeg.openInterest < HARD_FILTER_DEFAULTS.minOpenInterest || shortLeg.openInterest < HARD_FILTER_DEFAULTS.minOpenInterest) continue;

            const debit = longLeg.ask - shortLeg.bid;
            const maxProfit = width - debit;
            const maxRisk = debit;

            if (debit <= 0 || maxRisk <= 0) continue;

            const riskReward = maxProfit / debit;
            const mid = (longLeg.bid + longLeg.ask) / 2;

            if (mid <= 0) continue;

            const spreadPctVal = (longLeg.ask - longLeg.bid) / mid;

            if (debit >= width * 0.55) continue;
            // if (riskReward < 1.5) continue; // Relaxed in favor of EV check
            if (spreadPctVal > 0.30) continue; // Relaxed filter for slippage model

            // 4. Slippage (Debit)
            const slippage1 = estimateSlippage(longLeg.bid, longLeg.ask);
            const slippage2 = estimateSlippage(shortLeg.bid, shortLeg.ask);
            const totalSlippage = slippage1 + slippage2;
            const effectiveDebit = debit + totalSlippage; // Higher cost
            const effectiveMaxProfit = width - effectiveDebit;

            if (effectiveDebit >= width * 0.70) continue; // Too expensive after slippage

            // Scoring
            const lambda = Math.abs(longLeg.delta) * (currentPrice / mid);
            const compLambda = compressLambda(lambda);
            const deltaBonus = getDeltaBonus(longLeg.delta);

            const breakeven = type === 'Call' ? longLeg.strike + debit : longLeg.strike - debit;
            const deltaAtBE = getDeltaAtStrike(chain, type, longLeg.expiration, breakeven);
            const probITMAtBE = getProbITMAtStrike(chain, type, longLeg.expiration, breakeven);

            // Debit Spread POP: Probability ITM at Breakeven
            let pop;
            if (probITMAtBE != null && probITMAtBE > 0) {
                pop = probITMAtBE;
            } else if (deltaAtBE != null) {
                pop = Math.abs(deltaAtBE);
            } else {
                pop = Math.abs(longLeg.delta) - 0.05; // Fallback heuristic
            }
            const expectedValue = (effectiveMaxProfit * pop) - (effectiveDebit * (1 - pop));

            const lambdaScore = Math.min((compLambda / 20) * 100, 100);
            const rrScore = Math.min((riskReward / 3) * 100, 100);
            const deltaScore = 50 + deltaBonus * 12.5;

            let finalScore = (0.4 * lambdaScore) + (0.35 * rrScore) + (0.25 * deltaScore);
            finalScore += ivRankAdj * 2;

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
                width,
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
                recommendation: {
                    action: "BUY (Open)",
                    note
                }
            });
        }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

function scoreSingleLegs(chain, type, ivRvRatio, currentPrice, ivRatio = 1.0, ivRank = null) {
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
        const gammaEff = opt.gamma / mid;
        const thetaBurn = Math.abs(opt.theta) / mid;
        const gammaThetaRatio = calculateGammaThetaRatio(opt.gamma, opt.theta);
        const breakevenMove = calculateBreakevenMove(opt.strike, mid, currentPrice, opt.type);
        processed.push({ opt, mid, lambda, gammaEff, thetaBurn, gammaThetaRatio, breakevenMove, spreadPct: spreadPctVal });
    }

    if (processed.length === 0) return [];

    const compressedLambdas = processed.map(p => compressLambda(p.lambda));
    const gammas = processed.map(p => p.gammaEff);
    const thetas = processed.map(p => p.thetaBurn);
    const gtRatios = processed.map(p => p.gammaThetaRatio);
    const dtes = processed.map(p => p.opt.dte);
    const vegaEfficiencies = processed.map(p => (p.opt.vega || 0) / (p.mid || 0.01));
    const zL = zScoresByBucket(compressedLambdas, dtes);
    const zG = zScoresByBucket(gammas, dtes);
    const zT = zScoresByBucket(thetas, dtes);
    const zGT = zScoresByBucket(gtRatios, dtes);
    const zVegaEff = zScoresByBucket(vegaEfficiencies, dtes);

    const atmIV = getCleanATM_IV(chain, currentPrice);
    const ivAdjustment = getIVAdjustment(ivRatio ?? 1.0, 'long');
    const ivRankAdj = getIVRankAdjustment(ivRank ?? null, 'long');
    const rawScores = processed.map((p, i) => {
        const relIvAdj = getRelativeIVAdjustmentLOQ(p.opt.iv, atmIV);
        const deltaBonus = getDeltaBonus(p.opt.delta);
        const bePenalty = getBreakevenPenalty(p.breakevenMove, p.opt.dte);
        return calculateLOQRaw(zL[i], zG[i], zT[i], ivAdjustment + ivRankAdj + relIvAdj, deltaBonus, p.thetaBurn, false, zGT[i], bePenalty, p.opt.dte, zVegaEff[i]);
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
            pop = Math.max(0, Math.min(1, Math.abs(p.opt.delta) - 0.05));
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
            gammaEff: p.gammaEff,
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
// MAIN HANDLER
// =============================================================================

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { ticker, direction = 'BULL', targetDte, spreadWidth } = req.query;

    if (!ticker) {
        return res.status(400).json({ error: 'Missing ticker parameter' });
    }

    const upperTicker = ticker.toUpperCase();
    const isBull = direction.toUpperCase() === 'BULL';
    const dteTarget = targetDte ? parseInt(targetDte) : 30;
    const widthParam = spreadWidth ? parseFloat(spreadWidth) : null;

    try {
        await ensureScoring();
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;

        const dataSource = process.env.DATA_SOURCE || 'CBOE';
        let allOptions = [];
        let currentPrice = 0;
        let cboeRes = null;
        let rv30 = null;
        let daysUntilEarnings = null;

        if (dataSource === 'POLYGON') {
            console.log(`Using Polygon.io for ${upperTicker}`);
            const { getOptionChain, getUnderlyingPrice } = await import('../lib/polygon-client.js');

            // Parallel fetch: ancillary data + underlying price (for strike-range filter to reduce payload)
            const [rv30, daysUntilEarnings, underlyingPrice] = await Promise.all([
                fetchRV30(upperTicker),
                fetchEarnings(upperTicker),
                getUnderlyingPrice(upperTicker)
            ]);

            try {
                // Only request DTE 30 and 90 (IV term structure) with strike range ±20% to reduce payload/API usage
                const strikePadding = 0.20;
                const minStrike = underlyingPrice && underlyingPrice > 0 ? underlyingPrice * (1 - strikePadding) : undefined;
                const maxStrike = underlyingPrice && underlyingPrice > 0 ? underlyingPrice * (1 + strikePadding) : undefined;
                const strikeFilter = (minStrike != null && maxStrike != null) ? { minStrike, maxStrike } : {};

                const [chain30, chain90] = await Promise.all([
                    getOptionChain(upperTicker, { dte: 30, ...strikeFilter }),
                    getOptionChain(upperTicker, { dte: 90, ...strikeFilter })
                ]);
                const seen = new Set();
                let chainData = [];
                for (const o of [...(chain30 || []), ...(chain90 || [])]) {
                    if (o?.symbol && !seen.has(o.symbol)) {
                        seen.add(o.symbol);
                        chainData.push(o);
                    }
                }
                if (!chainData.length) {
                    console.warn('Polygon chain empty with dte 30/90, trying without DTE...');
                    chainData = await getOptionChain(upperTicker, {}) || [];
                }
                if (chainData.length > 0) {
                    allOptions = chainData;
                    const valid = chainData.find(o => o.underlyingPrice > 0);
                    currentPrice = valid ? valid.underlyingPrice : 0;
                } else {
                    console.warn('Polygon returned empty chain');
                    throw new Error('Empty Polygon chain');
                }

            } catch (err) {
                console.error('Polygon fetch failed:', err);
                throw err;
            }

        } else {
            // CBOE Legacy
            // 1. Parallel Fetching
            [cboeRes, rv30, daysUntilEarnings] = await Promise.all([
                fetch(cboeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.ok ? r.json() : null),
                fetchRV30(upperTicker),
                fetchEarnings(upperTicker)
            ]);

            if (!cboeRes?.data?.options) {
                return res.status(404).json({ error: 'No options data found or API error' });
            }

            currentPrice = cboeRes.data.current_price;
            allOptions = cboeRes.data.options;
        }

        const fullChain = parseChain(allOptions, currentPrice, null);
        const strategyChain = parseChain(allOptions, currentPrice, dteTarget);

        // Build complete IV Term Structure (v2.4 - MarketData upgrade)
        const ivSurface = buildIVTermStructure(fullChain, currentPrice);
        const iv30 = ivSurface.iv30;
        const iv90 = ivSurface.iv90;

        // Calculate Skew (v2.3)
        const skew = calculateSkew(fullChain, currentPrice, 30);

        const regime = detectRegime(iv30, iv90, rv30);

        // Enhance regime advice with anomaly detection
        if (ivSurface.anomaly) {
            regime.advice = '⚠️ IV Spike Detected: Potential Earnings Event';
            regime.adviceDetail = `Near-term IV is ${ivSurface.anomalyRatio.toFixed(2)}x higher than 30-day IV, suggesting an upcoming catalyst (likely earnings). Consider: (1) Avoid selling premium near-term, (2) Use post-event expirations, or (3) Size smaller if trading through the event.`;
        }

        if (iv30 != null) {
            await saveTickerIVSnapshot(upperTicker, iv30, iv90);
        }

        const ivRankResult = await getIVRank(upperTicker);
        const ivRank = ivRankResult?.ivRank ?? null;
        const ivPercentile = ivRankResult?.ivPercentile ?? null;
        const ivRankSampleDays = ivRankResult?.sampleDays ?? 0;

        const creditStrat = isBull ? 'Put' : 'Call';
        const debitStrat = isBull ? 'Call' : 'Put';
        const legStrat = isBull ? 'Call' : 'Put';

        // 2. Build Strategies (regime includes IV Rank for LOQ single-leg scoring)
        const creditSpreads = buildCreditSpreads(strategyChain, creditStrat, currentPrice, regime.ivRvRatio, daysUntilEarnings, skew, widthParam, ivRank);
        const debitSpreads = buildDebitSpreads(strategyChain, debitStrat, currentPrice, regime.ivRvRatio, widthParam, ivRank);
        const singleLegs = scoreSingleLegs(strategyChain, legStrat, regime.ivRvRatio, currentPrice, regime.ivRatio, ivRank);

        // 3. Unified Cross-Strategy Scoring — Top Picks (skew favor, termStrength, anomaly down-weight for short-term credit)
        const unifiedOpts = {
            anomaly: ivSurface.anomaly || false,
            termStrength: regime.slopeTier || undefined
        };
        const topPicks = [];
        for (const rec of creditSpreads) {
            const creditSpreadType = rec.type && rec.type.includes('Put') ? 'Put' : 'Call';
            topPicks.push({
                ...rec,
                strategyCategory: 'CREDIT_SPREAD',
                unifiedScore: calculateUnifiedScore(rec, 'CREDIT_SPREAD', regime.mode, regime.ivRvRatio, { ...unifiedOpts, skew, creditSpreadType }),
            });
        }
        for (const rec of debitSpreads) {
            topPicks.push({
                ...rec,
                strategyCategory: 'DEBIT_SPREAD',
                unifiedScore: calculateUnifiedScore(rec, 'DEBIT_SPREAD', regime.mode, regime.ivRvRatio, unifiedOpts),
            });
        }
        for (const rec of singleLegs) {
            topPicks.push({
                ...rec,
                strategyCategory: 'SINGLE_LEG',
                unifiedScore: calculateUnifiedScore(rec, 'SINGLE_LEG', regime.mode, regime.ivRvRatio, unifiedOpts),
            });
        }
        topPicks.sort((a, b) => b.unifiedScore - a.unifiedScore);

        // 4. Strategy Selection — driven by unified score (replaces flawed cross-score comparison)
        let recommendedStrategy = 'CREDIT_SPREAD';
        if (topPicks.length > 0) {
            recommendedStrategy = topPicks[0].strategyCategory;
        } else if (regime.mode === 'DEBIT') {
            recommendedStrategy = 'DEBIT_SPREAD';
        }
        // Safety fallbacks for empty arrays
        if (recommendedStrategy === 'CREDIT_SPREAD' && creditSpreads.length === 0) {
            recommendedStrategy = debitSpreads.length > 0 ? 'DEBIT_SPREAD' : 'SINGLE_LEG';
        }
        if (recommendedStrategy === 'DEBIT_SPREAD' && debitSpreads.length === 0) {
            recommendedStrategy = singleLegs.length > 0 ? 'SINGLE_LEG' : 'CREDIT_SPREAD';
        }
        if (recommendedStrategy === 'SINGLE_LEG' && singleLegs.length === 0) {
            recommendedStrategy = creditSpreads.length > 0 ? 'CREDIT_SPREAD' : 'DEBIT_SPREAD';
        }

        return res.status(200).json({
            success: true,
            context: {
                ticker: upperTicker,
                currentPrice,
                direction: isBull ? 'BULL' : 'BEAR',
                targetDte: dteTarget,
                daysUntilEarnings
            },
            regime: {
                ivRatio: regime.ivRatio ? Number(regime.ivRatio.toFixed(3)) : null,
                slope: regime.slope != null ? Number(regime.slope.toFixed(3)) : null,
                slopeTier: regime.slopeTier || null,
                iv30: iv30 ? Number((iv30 * 100).toFixed(1)) : null,
                iv90: iv90 ? Number((iv90 * 100).toFixed(1)) : null,
                rv30: rv30 ? Number(rv30.toFixed(1)) : null,
                ivRvRatio: regime.ivRvRatio ? Number(regime.ivRvRatio.toFixed(3)) : null,
                ivRank: ivRank != null ? Number(ivRank.toFixed(3)) : null,
                ivPercentile: ivPercentile != null ? Number(ivPercentile.toFixed(3)) : null,
                ivRankSampleDays: ivRankSampleDays,
                mode: regime.mode,
                advice: regime.advice,
                adviceDetail: regime.adviceDetail || null,
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
            recommendedStrategy,
            strategies: {
                CREDIT_SPREAD: creditSpreads,
                DEBIT_SPREAD: debitSpreads,
                SINGLE_LEG: singleLegs,
                TOP_PICKS: topPicks,
                _regimeMeta: { skew }
            }
        });

    } catch (error) {
        const errMsg = error && typeof error.message === 'string' ? error.message : String(error);
        console.error('Strategy API Error:', errMsg);
        return res.status(500).json({ error: 'Internal Server Error', message: errMsg });
    }
}
