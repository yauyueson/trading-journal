// api/strategy-recommend.js
// Strategy Recommender API - Intelligent Options Strategy Selection
// Based on IV Regime and User Direction (BULL/BEAR)
// Uses shared scoring module (Single Source of Truth)
// Modules loaded inside handler via dynamic import() so failures return JSON on Vercel.

let compressLambda, calculateGammaThetaRatio, calculateBreakevenMove, getBreakevenPenalty,
    calculateExpectedValue, getThetaPenalty, getDeltaBonus, zScores, getIVRiskFactor,
    calculateLOQRaw, normalizeScoreTo100, normalizeLOQScoresWithDynamicBaseline, calculateSpreadPct,
    getCleanATM_IV, calculateTargetIV, parseChain, calculateSkew, estimateSlippage, getGammaRiskPenalty;
let saveTickerIVSnapshot;
let _scoringLoaded = false;

async function ensureScoring() {
    if (_scoringLoaded) return;
    const scoringUrl = new URL('./_shared/scoring.cjs', import.meta.url).href;
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
    getIVRiskFactor = scoring.getIVRiskFactor;
    calculateLOQRaw = scoring.calculateLOQRaw;
    normalizeScoreTo100 = scoring.normalizeScoreTo100;
    normalizeLOQScoresWithDynamicBaseline = scoring.normalizeLOQScoresWithDynamicBaseline;
    calculateSpreadPct = scoring.calculateSpreadPct;
    getCleanATM_IV = scoring.getCleanATM_IV;
    calculateTargetIV = scoring.calculateTargetIV;
    parseChain = scoring.parseChain;
    calculateSkew = scoring.calculateSkew;
    estimateSlippage = scoring.estimateSlippage;
    getGammaRiskPenalty = scoring.getGammaRiskPenalty;
    try {
        const ivUrl = new URL('./_shared/ivHistory.cjs', import.meta.url).href;
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

function detectRegime(iv30, iv90, rv20) {
    if (!iv30 || !iv90 || iv90 === 0) {
        return {
            ivRatio: 1.0,
            ivRvRatio: null,
            mode: 'NEUTRAL',
            advice: 'Insufficient Data for IV Ratio. Defaulting to Neutral.'
        };
    }

    const termRatio = iv30 / iv90;
    const ivRvRatio = rv20 ? (iv30 * 100) / rv20 : null;

    let mode = 'NEUTRAL';
    let advice = 'Neutral IV: Either strategy viable, compare scores';

    if (termRatio > 1.05) {
        mode = 'CREDIT';
        advice = 'Backwardation (Expensive near-term): Sell Credit Spreads';
    } else if (termRatio < 0.95) {
        mode = 'DEBIT';
        advice = 'Contango (Cheap near-term IV): Buy Debit Spreads';
    }

    return { ivRatio: termRatio, ivRvRatio, mode, advice };
}

function generateStrategyNote(strategyType, metrics) {
    const pros = [];
    const cons = [];

    // Common Metrics
    if (metrics.ev && metrics.ev > 20) pros.push("High Expected Value (+EV)");
    if (metrics.pop && metrics.pop > 70) pros.push("High Probability of Profit");
    if (metrics.roi && metrics.roi > 30) pros.push("Excellent ROI (>30%)");

    // Credit Specific
    if (strategyType === 'CREDIT') {
        if (metrics.theta && metrics.theta > 0.1) pros.push("Strong Theta Decay");
        if (metrics.skewBonus > 0) pros.push("Volatility Skew Edge (Overpriced)");
        if (metrics.ivRvRatio > 1.25) pros.push("High Volatility Premium");

        if (metrics.gammaPenalty < 0) cons.push("High Gamma Risk (Short DTE)");
        if (metrics.slippageImpact > 0.15) cons.push("Low Liquidity / High Slippage");
        if (metrics.earningsRisk) cons.push("Earnings Event Risk");
    }

    // Debit Specific
    if (strategyType === 'DEBIT') {
        if (metrics.lambda > 8) pros.push("High Leverage (Lambda > 8)");
        if (metrics.ivRvRatio < 0.85) pros.push("Cheap Volatility (Undervalued)");
        if (metrics.deltaBonus > 0) pros.push("Good Directional Exposure");

        if (metrics.slippageImpact > 0.15) cons.push("Wide Spread / Slippage Drag");
        if (metrics.theta && metrics.theta < -0.1) cons.push("High Theta Decay (Time Risk)");
    }

    let note = "";
    if (pros.length > 0) note += `✅ Pros: ${pros.join(', ')}. `;
    if (cons.length > 0) note += `⚠️ Cons: ${cons.join(', ')}.`;

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

function buildCreditSpreads(chain, type, currentPrice, ivRvRatio, daysUntilEarnings, skew) {
    const results = [];
    const widths = [5, 10];

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
            const pop = deltaAtBE != null ? 1 - Math.abs(deltaAtBE) : 1 - Math.abs(shortLeg.delta);
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

            // 2. Skew Adjustment (New)
            let skewBonus = 0;
            // If Skew is positive (Puts > Calls), Credit Put Spreads are favored
            if (skew > 0.05 && type === 'Put') skewBonus = 10;
            // If Skew is negative (Calls > Puts), Credit Call Spreads are favored
            if (skew < -0.05 && type === 'Call') skewBonus = 10;

            let scoreDTE = 50;
            if (dte >= 30 && dte <= 45) scoreDTE = 100;
            else if (dte >= 21 && dte < 30) scoreDTE = 75;
            else if (dte > 45 && dte <= 60) scoreDTE = 80;
            else if (dte < 21) scoreDTE = 20;

            let finalScore = (0.20 * scoreEV) + (0.20 * scoreROI) + (0.20 * scorePOP) + (0.15 * scoreDistance) + (0.25 * scoreDTE) + skewBonus + gammaPenalty;
            if (includesEarnings) finalScore -= 25;

            if (effectiveROI < 10) continue; // Lowered ROI floor because we are using net effective ROI now

            const maxContracts = calculateMaxContracts(effectiveMaxRisk);

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

function buildDebitSpreads(chain, type, currentPrice, ivRvRatio) {
    const results = [];
    const widths = [2.5, 5];

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

            const debit = longLeg.ask - shortLeg.bid;
            const maxProfit = width - debit;
            const maxRisk = debit;

            if (debit <= 0 || maxRisk <= 0) continue;

            const riskReward = maxProfit / debit;
            const mid = (longLeg.bid + longLeg.ask) / 2;

            if (mid <= 0) continue;

            const spreadPctVal = (longLeg.ask - longLeg.bid) / mid;

            if (debit >= width * 0.55) continue;
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
            const pop = Math.abs(longLeg.delta) - 0.05;
            const expectedValue = (effectiveMaxProfit * pop) - (effectiveDebit * (1 - pop));

            const lambdaScore = Math.min((compLambda / 20) * 100, 100);
            const rrScore = Math.min((riskReward / 3) * 100, 100);
            const deltaScore = 50 + deltaBonus * 12.5;

            const finalScore = (0.4 * lambdaScore) + (0.35 * rrScore) + (0.25 * deltaScore);
            const finalScore = (0.4 * lambdaScore) + (0.35 * rrScore) + (0.25 * deltaScore);

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

function scoreSingleLegs(chain, type, ivRvRatio, currentPrice) {
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
        const lambda = Math.abs(opt.delta) * (currentPrice / mid);
        const gammaEff = opt.gamma / mid;
        const thetaBurn = Math.abs(opt.theta) / mid;
        const gammaThetaRatio = calculateGammaThetaRatio(opt.gamma, opt.theta);
        const breakevenMove = calculateBreakevenMove(mid, opt.delta, currentPrice);
        const spreadPctVal = (opt.ask - opt.bid) / mid;
        processed.push({ opt, mid, lambda, gammaEff, thetaBurn, gammaThetaRatio, breakevenMove, spreadPct: spreadPctVal });
    }

    if (processed.length === 0) return [];

    const compressedLambdas = processed.map(p => compressLambda(p.lambda));
    const gammas = processed.map(p => p.gammaEff);
    const thetas = processed.map(p => p.thetaBurn);
    const gtRatios = processed.map(p => p.gammaThetaRatio);
    const zL = zScores(compressedLambdas);
    const zG = zScores(gammas);
    const zT = zScores(thetas);
    const zGT = zScores(gtRatios);

    const ivRankAdj = 0; // IV Rank/Percentile removed; regime uses IV Ratio + IV/RV only
    const rawScores = processed.map((p, i) => {
        const deltaBonus = getDeltaBonus(p.opt.delta);
        const bePenalty = getBreakevenPenalty(p.breakevenMove, p.opt.dte);
        return calculateLOQRaw(zL[i], zG[i], zT[i], ivRankAdj, deltaBonus, p.thetaBurn, false, zGT[i], bePenalty, p.opt.dte);
    });
    const scores = normalizeLOQScoresWithDynamicBaseline(rawScores);
    return processed.map((p, i) => {
        const score = scores[i];

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
            score,
            whyThis: `λ=${p.lambda.toFixed(1)}, Δ=${Math.abs(p.opt.delta).toFixed(2)}${ivRvRatio && ivRvRatio < 0.85 ? ', Cheap Vol (Ref)' : ''}`
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

    const { ticker, direction = 'BULL', targetDte } = req.query;

    if (!ticker) {
        return res.status(400).json({ error: 'Missing ticker parameter' });
    }

    const upperTicker = ticker.toUpperCase();
    const isBull = direction.toUpperCase() === 'BULL';
    const dteTarget = targetDte ? parseInt(targetDte) : 30;

    try {
        await ensureScoring();
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;

        // 1. Parallel Fetching
        const [cboeRes, rv30, daysUntilEarnings] = await Promise.all([
            fetch(cboeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.ok ? r.json() : null),
            fetchRV30(upperTicker),
            fetchEarnings(upperTicker)
        ]);

        if (!cboeRes?.data?.options) {
            return res.status(404).json({ error: 'No options data found or API error' });
        }

        const currentPrice = cboeRes.data.current_price;
        const allOptions = cboeRes.data.options;

        const fullChain = parseChain(allOptions, currentPrice, null);
        const strategyChain = parseChain(allOptions, currentPrice, dteTarget);

        const iv30 = calculateTargetIV(fullChain, 30, currentPrice);
        const iv90 = calculateTargetIV(fullChain, 90, currentPrice);

        // Calculate Skew (v2.3)
        const skew = calculateSkew(fullChain, currentPrice, 30);

        const regime = detectRegime(iv30, iv90, rv30);

        if (iv30 != null) {
            await saveTickerIVSnapshot(upperTicker, iv30, iv90);
        }

        const creditStrat = isBull ? 'Put' : 'Call';
        const debitStrat = isBull ? 'Call' : 'Put';
        const legStrat = isBull ? 'Call' : 'Put';

        // 2. Build Strategies (regime uses IV Ratio + IV/RV only; no IV Rank/Percentile)
        const creditSpreads = buildCreditSpreads(strategyChain, creditStrat, currentPrice, regime.ivRvRatio, daysUntilEarnings, skew);
        const debitSpreads = buildDebitSpreads(strategyChain, debitStrat, currentPrice, regime.ivRvRatio);
        const singleLegs = scoreSingleLegs(strategyChain, legStrat, regime.ivRvRatio, currentPrice);

        let recommendedStrategy = 'CREDIT_SPREAD';

        // 3. Strategy Selection based on Regime & Scores
        if (regime.mode === 'DEBIT') {
            recommendedStrategy = 'DEBIT_SPREAD';
        } else if (regime.mode === 'NEUTRAL') {
            const topCredit = creditSpreads[0]?.score || 0;
            const topDebit = debitSpreads[0]?.score || 0;
            if (topDebit > topCredit) recommendedStrategy = 'DEBIT_SPREAD';
        }

        if (recommendedStrategy === 'CREDIT_SPREAD' && creditSpreads.length === 0) recommendedStrategy = 'DEBIT_SPREAD';
        if (recommendedStrategy === 'DEBIT_SPREAD' && debitSpreads.length === 0) recommendedStrategy = 'SINGLE_LEG';
        if (recommendedStrategy === 'SINGLE_LEG' && singleLegs.length === 0 && creditSpreads.length > 0) recommendedStrategy = 'CREDIT_SPREAD';

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
                iv30: iv30 ? Number((iv30 * 100).toFixed(1)) : null,
                iv90: iv90 ? Number((iv90 * 100).toFixed(1)) : null,
                rv30: rv30 ? Number(rv30.toFixed(1)) : null,
                ivRvRatio: regime.ivRvRatio ? Number(regime.ivRvRatio.toFixed(3)) : null,
                mode: regime.mode,
                advice: regime.advice
            },
            recommendedStrategy,
            strategies: {
                CREDIT_SPREAD: creditSpreads,
                DEBIT_SPREAD: debitSpreads,
                SINGLE_LEG: singleLegs,
                _regimeMeta: { skew }
            }
        });

    } catch (error) {
        const errMsg = error && typeof error.message === 'string' ? error.message : String(error);
        console.error('Strategy API Error:', errMsg);
        return res.status(500).json({ error: 'Internal Server Error', message: errMsg });
    }
}
