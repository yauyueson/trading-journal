// api/strategy-recommend.js
// Strategy Recommender API - Intelligent Options Strategy Selection
// Based on IV Regime and User Direction (BULL/BEAR)
// Uses shared scoring module (Single Source of Truth)
// Modules loaded inside handler via dynamic import() so failures return JSON on Vercel.

let compressLambda, calculateGammaThetaRatio, calculateBreakevenMove, getBreakevenPenalty,
    calculateExpectedValue, getThetaPenalty, getDeltaBonus, zScores, getIVRiskFactor,
    getIVRankAdjustment, calculateLOQRaw, normalizeScoreTo100, calculateSpreadPct,
    getCleanATM_IV, calculateTargetIV, parseChain;
let saveTickerIVSnapshot, getIVRank;
let _scoringLoaded = false;

async function ensureScoring() {
    if (_scoringLoaded) return;
    const scoring = (await import('./_shared/scoring.js')).default;
    compressLambda = scoring.compressLambda;
    calculateGammaThetaRatio = scoring.calculateGammaThetaRatio;
    calculateBreakevenMove = scoring.calculateBreakevenMove;
    getBreakevenPenalty = scoring.getBreakevenPenalty;
    calculateExpectedValue = scoring.calculateExpectedValue;
    getThetaPenalty = scoring.getThetaPenalty;
    getDeltaBonus = scoring.getDeltaBonus;
    zScores = scoring.zScores;
    getIVRiskFactor = scoring.getIVRiskFactor;
    getIVRankAdjustment = scoring.getIVRankAdjustment;
    calculateLOQRaw = scoring.calculateLOQRaw;
    normalizeScoreTo100 = scoring.normalizeScoreTo100;
    calculateSpreadPct = scoring.calculateSpreadPct;
    getCleanATM_IV = scoring.getCleanATM_IV;
    calculateTargetIV = scoring.calculateTargetIV;
    parseChain = scoring.parseChain;
    try {
        const iv = (await import('./_shared/ivHistory.js')).default;
        saveTickerIVSnapshot = iv.saveTickerIVSnapshot;
        getIVRank = iv.getIVRank;
    } catch (_) {
        saveTickerIVSnapshot = async () => {};
        getIVRank = async () => ({ ivRank: null, ivPercentile: null, currentIv30: null, minIv: null, maxIv: null, sampleDays: 0 });
    }
    _scoringLoaded = true;
}

// =============================================================================
// DATA FETCHING UTILITIES
// =============================================================================

async function fetchRV20(ticker) {
    try {
        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(toDate.getDate() - 45);
        const toStr = toDate.toISOString().split('T')[0];
        const fromStr = fromDate.toISOString().split('T')[0];

        const url = `https://api.nasdaq.com/api/quote/${ticker.toUpperCase()}/historical?assetclass=stocks&fromdate=${fromStr}&todate=${toStr}&limit=40`;
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

// =============================================================================
// STRATEGY BUILDERS
// =============================================================================

function calculateMaxContracts(maxRisk) {
    const ACCOUNT_RISK_LIMIT = 57; // 1% of $5,700
    if (maxRisk <= 0) return 0;
    return Math.floor(ACCOUNT_RISK_LIMIT / (maxRisk * 100));
}

function buildCreditSpreads(chain, type, currentPrice, ivRvRatio, daysUntilEarnings) {
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
            const roi = (credit / maxRisk) * 100;
            const pop = 1 - Math.abs(shortLeg.delta);
            const distance = Math.abs(currentPrice - shortLeg.strike) / currentPrice;
            const dte = shortLeg.dte;

            // Earnings Guard
            const includesEarnings = daysUntilEarnings !== null && daysUntilEarnings <= dte && daysUntilEarnings >= 0;
            const earningsRisk = includesEarnings && daysUntilEarnings <= 10;
            if (earningsRisk) continue;

            // Scoring (v2.2 — EV-enhanced)
            const ev = calculateExpectedValue(pop, credit, maxRisk);
            const evRatio = credit > 0 ? ev / credit : 0;
            const scoreEV = Math.max(0, Math.min(100, 50 + evRatio * 100));

            const scoreROI = Math.min(roi * 4, 100);
            const scorePOP = pop * 100;
            const scoreDistance = Math.min(distance * 1000, 100);

            let scoreDTE = 50;
            if (dte >= 30 && dte <= 45) scoreDTE = 100;
            else if (dte >= 21 && dte < 30) scoreDTE = 75;
            else if (dte > 45 && dte <= 60) scoreDTE = 80;
            else if (dte < 21) scoreDTE = 20;

            let finalScore = (0.20 * scoreEV) + (0.20 * scoreROI) + (0.20 * scorePOP) + (0.15 * scoreDistance) + (0.25 * scoreDTE);
            if (includesEarnings) finalScore -= 25;

            if (roi < 15) continue;

            const maxContracts = calculateMaxContracts(maxRisk);

            const whyThisParts = [];
            if (ev > 0) whyThisParts.push(`+EV $${ev.toFixed(2)}`);
            if (roi > 20) whyThisParts.push(`${roi.toFixed(0)}% ROI`);
            if (ivRvRatio && ivRvRatio > 1.25) whyThisParts.push('High IV Premium (Ref)');
            if (scoreDTE >= 75) whyThisParts.push('Theta Zone');
            if (maxContracts > 0) whyThisParts.push(`Max size: ${maxContracts}`);

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
                breakeven: type === 'Put' ? shortLeg.strike - credit : shortLeg.strike + credit,
                score: Math.min(100, Math.max(0, Math.round(finalScore))),
                whyThis: whyThisParts.join(', ') || 'Balanced Risk/Reward',
                recommendation: {
                    maxContracts,
                    action: "SELL (Open)"
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
            if (riskReward < 1.5) continue;
            if (spreadPctVal > 0.15) continue;

            // Scoring
            const lambda = Math.abs(longLeg.delta) * (currentPrice / mid);
            const compLambda = compressLambda(lambda);
            const deltaBonus = getDeltaBonus(longLeg.delta);
            const pop = Math.abs(longLeg.delta) - 0.05;
            const expectedValue = (maxProfit * pop) - (maxRisk * (1 - pop));

            const lambdaScore = Math.min((compLambda / 20) * 100, 100);
            const rrScore = Math.min((riskReward / 3) * 100, 100);
            const deltaScore = 50 + deltaBonus * 12.5;

            const finalScore = (0.4 * lambdaScore) + (0.35 * rrScore) + (0.25 * deltaScore);
            const maxContracts = calculateMaxContracts(maxRisk);

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
                    maxContracts,
                    action: "BUY (Open)"
                }
            });
        }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

function scoreSingleLegs(chain, type, ivRvRatio, currentPrice, ivRank = null) {
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

    const ivRankAdj = getIVRankAdjustment(ivRank, 'long');
    return processed.map((p, i) => {
        const deltaBonus = getDeltaBonus(p.opt.delta);
        const bePenalty = getBreakevenPenalty(p.breakevenMove, p.opt.dte);
        const rawScore = calculateLOQRaw(zL[i], zG[i], zT[i], ivRankAdj, deltaBonus, p.thetaBurn, false, zGT[i], bePenalty, p.opt.dte);
        const score = normalizeScoreTo100(rawScore);

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

const DEBUG_LOG = (loc, msg, data, hyp) => {
    fetch('http://127.0.0.1:7242/ingest/137ba6e0-38b1-42b1-9ed2-dd177adfbbbb', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: loc, message: msg, data: data || {}, timestamp: Date.now(), hypothesisId: hyp }) }).catch(() => {});
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { ticker, direction = 'BULL', targetDte } = req.query;
    // #region agent log
    DEBUG_LOG('strategy-recommend.js:handler', 'handler start', { ticker, direction, targetDte }, 'H2');
    // #endregion

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
            fetchRV20(upperTicker),
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

        const regime = detectRegime(iv30, iv90, rv30);

        if (iv30 != null) {
            // #region agent log
            DEBUG_LOG('strategy-recommend.js:beforeIV', 'before IV snapshot/rank', { upperTicker }, 'H3');
            // #endregion
            await saveTickerIVSnapshot(upperTicker, iv30, iv90);
            const rankInfo = await getIVRank(upperTicker);
            // #region agent log
            DEBUG_LOG('strategy-recommend.js:afterIV', 'after getIVRank', { ivRank: rankInfo.ivRank, sampleDays: rankInfo.sampleDays }, 'H3');
            // #endregion
            regime.ivRank = rankInfo.ivRank;
            regime.ivPercentile = rankInfo.ivPercentile;
            regime.ivRankSampleDays = rankInfo.sampleDays;
        }

        const creditStrat = isBull ? 'Put' : 'Call';
        const debitStrat = isBull ? 'Call' : 'Put';
        const legStrat = isBull ? 'Call' : 'Put';

        // 2. Build Strategies
        const creditSpreads = buildCreditSpreads(strategyChain, creditStrat, currentPrice, regime.ivRvRatio, daysUntilEarnings);
        const debitSpreads = buildDebitSpreads(strategyChain, debitStrat, currentPrice, regime.ivRvRatio);
        const singleLegs = scoreSingleLegs(strategyChain, legStrat, regime.ivRvRatio, currentPrice, regime.ivRank);

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

        // #region agent log
        DEBUG_LOG('strategy-recommend.js:success', 'sending 200 JSON', { recommendedStrategy }, 'H2');
        // #endregion
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
                ivRank: regime.ivRank != null ? Number(regime.ivRank.toFixed(3)) : null,
                ivPercentile: regime.ivPercentile != null ? Number(regime.ivPercentile.toFixed(3)) : null,
                ivRankSampleDays: regime.ivRankSampleDays ?? null,
                mode: regime.mode,
                advice: regime.advice
            },
            recommendedStrategy,
            strategies: {
                CREDIT_SPREAD: creditSpreads,
                DEBIT_SPREAD: debitSpreads,
                SINGLE_LEG: singleLegs
            }
        });

    } catch (error) {
        const errMsg = error && typeof error.message === 'string' ? error.message : String(error);
        // #region agent log
        DEBUG_LOG('strategy-recommend.js:catch', 'handler error', { message: errMsg }, 'H2');
        // #endregion
        console.error('Strategy API Error:', errMsg);
        return res.status(500).json({ error: 'Internal Server Error', message: errMsg });
    }
}
