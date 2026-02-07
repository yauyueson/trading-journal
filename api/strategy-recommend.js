// api/strategy-recommend.js
// Strategy Recommender API - Intelligent Options Strategy Selection
// Based on IV Regime and User Direction (BULL/BEAR)

// =============================================================================
// SCORING UTILITIES (Shared with scan-options.js)
// =============================================================================

const getIVRiskFactor = (ratio) => {
    const k = 12;
    const x0 = 1.10;
    const raw = 1 / (1 + Math.exp(-k * (ratio - x0)));
    return 0.9 + raw * 0.4;
};

const getDeltaBonus = (delta) => {
    const absDelta = Math.abs(delta);
    const lerp = (x, x1, x2, y1, y2) =>
        y1 + (y2 - y1) * ((x - x1) / (x2 - x1));

    if (absDelta < 0.15) return -2.0;
    if (absDelta < 0.30) return lerp(absDelta, 0.15, 0.30, -2.0, -0.5);
    if (absDelta < 0.50) return lerp(absDelta, 0.30, 0.50, -0.5, 1.0);
    if (absDelta < 0.70) return lerp(absDelta, 0.50, 0.70, 1.0, 0.5);
    if (absDelta <= 1.0) return lerp(absDelta, 0.70, 1.0, 0.5, 0);
    return 0;
};

const compressLambda = (lambda) => {
    const threshold = 20;
    const decayRate = 0.1;
    if (lambda <= threshold) return lambda;
    return threshold + (lambda - threshold) * decayRate;
};

const getThetaPenalty = (thetaBurn) => {
    const SAFE_ZONE = 0.005;
    if (thetaBurn <= SAFE_ZONE) return 0;
    const excess = thetaBurn - SAFE_ZONE;
    return Math.min(Math.pow(excess * 100, 2) * 0.5, 10);
};

const zScores = (values) => {
    const n = values.length;
    if (n < 2) return values.map(() => 0);
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1;
    return values.map(v => (v - mean) / std);
};

// =============================================================================
// DATA FETCHING UTILITIES
// =============================================================================

function getCleanATM_IV(chain, currentPrice) {
    if (!chain || chain.length === 0) return null;

    const strikes = {};
    chain.forEach(opt => {
        if (!strikes[opt.strike]) strikes[opt.strike] = {};
        strikes[opt.strike][opt.type] = opt;
    });

    let bestStrike = null;
    let minDiff = Infinity;

    Object.keys(strikes).forEach(strikeStr => {
        const strike = parseFloat(strikeStr);
        if (strikes[strike].Call && strikes[strike].Put) {
            const diff = Math.abs(strike - currentPrice);
            if (diff < minDiff) {
                minDiff = diff;
                bestStrike = strike;
            }
        }
    });

    if (bestStrike === null) return null;

    const atmCall = strikes[bestStrike].Call;
    const atmPut = strikes[bestStrike].Put;

    if (!atmCall.iv || !atmPut.iv) return null;

    return (atmCall.iv + atmPut.iv) / 2;
}

function calculateTargetIV(allOptions, targetDTE, currentPrice) {
    const dtes = [...new Set(allOptions.map(o => o.dte))].sort((a, b) => a - b);

    if (dtes.length === 0) return null;

    if (dtes.includes(targetDTE)) {
        const chain = allOptions.filter(o => o.dte === targetDTE);
        return getCleanATM_IV(chain, currentPrice);
    }

    let nearDTE = null;
    let farDTE = null;

    for (const dte of dtes) {
        if (dte < targetDTE) nearDTE = dte;
        if (dte > targetDTE) {
            farDTE = dte;
            break;
        }
    }

    if (nearDTE === null || farDTE === null) return null;

    const chainNear = allOptions.filter(o => o.dte === nearDTE);
    const chainFar = allOptions.filter(o => o.dte === farDTE);

    const ivNear = getCleanATM_IV(chainNear, currentPrice);
    const ivFar = getCleanATM_IV(chainFar, currentPrice);

    if (ivNear === null || ivFar === null) return null;

    const timeRange = farDTE - nearDTE;
    const timeToTarget = targetDTE - nearDTE;
    const weight = timeToTarget / timeRange;

    return ivNear + (ivFar - ivNear) * weight;
}

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
        // 使用总体标准差 (Population StdDev) 以符合机构口径，并改用 30D 窗口以匹配 IV30
        const variance = recentReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recentReturns.length;
        const annualizedRV = Math.sqrt(variance) * Math.sqrt(252) * 100;

        return annualizedRV;
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
                            const diffDays = Math.ceil((parsedDate - today) / (1000 * 60 * 60 * 24));
                            return diffDays;
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
            advice: '⚖️ Insufficient Data for IV Ratio. Defaulting to Neutral.'
        };
    }

    const termRatio = iv30 / iv90;
    const ivRvRatio = rv20 ? (iv30 * 100) / rv20 : null;

    let mode = 'NEUTRAL';
    let advice = '⚖️ Neutral IV: Either strategy viable, compare scores';

    if (termRatio > 1.05) {
        mode = 'CREDIT';
        advice = '🔴 Backwardation (Expensive near-term): Sell Credit Spreads';
    }
    else if (ivRvRatio && ivRvRatio > 1.35) {
        mode = 'CREDIT';
        advice = '💎 High Risk Premium (IV > RV): Market overestimating move. Sell Credit.';
    }
    else if (termRatio < 0.95) {
        mode = 'DEBIT';
        advice = '🟢 Contango (Cheap near-term IV): Buy Debit Spreads';
    }
    else if (ivRvRatio && ivRvRatio < 0.85) {
        mode = 'DEBIT';
        // 稳健版本：使用 30D HV 减少单日异常波动影响，匹配 IV30 周期
        advice = '🚀 Momentum Alert (RV30 > IV30): Stock moving faster than priced. Buy Debit.';
    }

    return { ivRatio: termRatio, ivRvRatio, mode, advice };
}

// =============================================================================
// STRATEGY BUILDERS
// =============================================================================

function calculateMaxContracts(maxRisk) {
    const ACCOUNT_RISK_LIMIT = 57; // 1% of $5,700
    if (maxRisk <= 0) return 0;
    return Math.floor(ACCOUNT_RISK_LIMIT / (maxRisk * 100)); // risk * 100 for dollar amount
}

function buildCreditSpreads(chain, type, currentPrice, ivRvRatio, daysUntilEarnings) {
    const results = [];
    const widths = [5, 10]; // Could be adaptive based on price

    // Safety check: Filter out low DTE if earnings or strictly enforce logic
    // Anchor: Short Leg with Delta 0.20 - 0.40
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

            // --- LIQUIDITY GUARD (COMPOSITE) ---
            // Conservative: Sell at Bid, Buy Back (Close) at Ask
            // Spread Bid = Short Bid - Long Ask (Your entry credit - conservative)
            // Spread Ask = Short Ask - Long Bid (Your exit debit - conservative)
            const spreadBid = shortLeg.bid - longLeg.ask;
            const spreadAsk = shortLeg.ask - longLeg.bid;
            const spreadMid = (spreadBid + spreadAsk) / 2;

            // Filter: Positive Credit Required
            if (spreadBid <= 0.10) continue;

            const spreadPct = spreadMid > 0 ? (spreadAsk - spreadBid) / spreadMid : 1.0;
            if (spreadPct > 0.15) continue; // Hard liquidity filter

            // --- KEY METRICS ---
            const credit = spreadBid; // Conservative Credit
            const maxRisk = width - credit;
            const roi = (credit / maxRisk) * 100;
            const pop = 1 - Math.abs(shortLeg.delta);
            const distance = Math.abs(currentPrice - shortLeg.strike) / currentPrice;
            const dte = shortLeg.dte;

            // --- EARNINGS GUARD ---
            // If earnings are within DTE, penalize heavily or filter
            const includesEarnings = daysUntilEarnings !== null && daysUntilEarnings <= dte && daysUntilEarnings >= 0;
            const earningsRisk = includesEarnings && daysUntilEarnings <= 10;

            if (earningsRisk) continue; // Skip Credit Spreads if Earnings within 10 days (Gamma Risk)

            // --- SCORING ---
            // 1. ROI Score (Cap at 25%)
            const scoreROI = Math.min(roi * 4, 100);
            // 2. POP Score
            const scorePOP = pop * 100;
            // 3. Distance Score
            const scoreDistance = Math.min(distance * 1000, 100);

            // 4. DTE Sweet Spot (30-45 is ideal)
            let scoreDTE = 50;
            if (dte >= 30 && dte <= 45) scoreDTE = 100;
            else if (dte >= 21 && dte < 30) scoreDTE = 75;
            else if (dte > 45 && dte <= 60) scoreDTE = 80;
            else if (dte < 21) scoreDTE = 20; // DTE Penalty

            // 5. IV/RV Boost
            // If IV is expensive (IV > RV), boost credit score
            let ivBoost = 0;
            if (ivRvRatio && ivRvRatio > 1.25) ivBoost = 15;
            if (ivRvRatio && ivRvRatio < 0.90) ivBoost = -15;

            let finalScore = (0.35 * scoreROI) + (0.30 * scorePOP) + (0.15 * scoreDistance) + (0.20 * scoreDTE) + ivBoost;
            if (includesEarnings) finalScore -= 25; // Penalty if holding through earnings (even if > 10d)

            // Hard filter: ROI check
            if (roi < 15) continue;

            const maxContracts = calculateMaxContracts(maxRisk);

            // Why This Logic
            const whyThisParts = [];
            if (roi > 20) whyThisParts.push(`${roi.toFixed(0)}% ROI`);
            if (ivBoost > 0) whyThisParts.push('High IV Premium');
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
                    maxContracts: maxContracts,
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

    // Anchor: Long Leg with Delta 0.45 - 0.70
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

            const debit = longLeg.ask - shortLeg.bid; // Conservative Debit
            const maxProfit = width - debit;
            const maxRisk = debit;

            // Check for valid debit
            if (debit <= 0 || maxRisk <= 0) continue;

            const riskReward = maxProfit / debit;
            const mid = (longLeg.bid + longLeg.ask) / 2;

            if (mid <= 0) continue; // Avoid division by zero

            const spreadPct = (longLeg.ask - longLeg.bid) / mid;

            // --- FILTERS ---
            if (debit >= width * 0.55) continue; // Cost > 55% of width is bad
            if (riskReward < 1.5) continue; // Strict R/R filter (v2.3)
            if (spreadPct > 0.15) continue; // Liquidity check

            // --- SCORING ---
            const lambda = Math.abs(longLeg.delta) * (currentPrice / mid);
            const compLambda = compressLambda(lambda);
            const deltaBonus = getDeltaBonus(longLeg.delta);
            const pop = Math.abs(longLeg.delta) - 0.05;
            const expectedValue = (maxProfit * pop) - (maxRisk * (1 - pop));

            const lambdaScore = Math.min((compLambda / 20) * 100, 100);
            const rrScore = Math.min((riskReward / 3) * 100, 100);
            const deltaScore = 50 + deltaBonus * 12.5;

            // IV/RV Adjustment
            // If IV is cheap (IV < RV), boost Debit score
            let ivAdj = 0;
            if (ivRvRatio && ivRvRatio < 0.85) ivAdj = 15;
            if (ivRvRatio && ivRvRatio > 1.15) ivAdj = -15;

            const finalScore = (0.4 * lambdaScore) + (0.35 * rrScore) + (0.25 * deltaScore) + ivAdj;
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
                whyThis: `R/R ${riskReward.toFixed(1)}:1, λ=${lambda.toFixed(1)}${ivAdj > 0 ? ', Cheap Vol' : ''}`,
                recommendation: {
                    maxContracts: maxContracts,
                    action: "BUY (Open)"
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
        Math.abs(o.delta) <= 0.60
    );

    if (filtered.length === 0) return [];

    const processed = filtered.map(opt => {
        const mid = (opt.bid + opt.ask) / 2;
        if (mid <= 0) return null;
        const lambda = Math.abs(opt.delta) * (currentPrice / mid);
        const gammaEff = opt.gamma / mid;
        const thetaBurn = Math.abs(opt.theta) / mid;
        const spreadPct = (opt.ask - opt.bid) / mid;
        return { opt, mid, lambda, gammaEff, thetaBurn, spreadPct };
    }).filter(p => p !== null);

    const compressedLambdas = processed.map(p => compressLambda(p.lambda));
    const gammas = processed.map(p => p.gammaEff);
    const thetas = processed.map(p => p.thetaBurn);
    const zL = zScores(compressedLambdas);
    const zG = zScores(gammas);
    const zT = zScores(thetas);

    return processed.map((p, i) => {
        const deltaBonus = getDeltaBonus(p.opt.delta);
        const thetaPenalty = getThetaPenalty(p.thetaBurn);

        let ivAdj = 0;
        if (ivRvRatio && ivRvRatio < 0.85) ivAdj = 10; // Cheap vol good for buying long
        if (ivRvRatio && ivRvRatio > 1.15) ivAdj = -10; // Expensive vol bad for buying long

        const rawScore = 0.40 * zL[i] + 0.30 * zG[i] - 0.15 * zT[i] + 0.15 * deltaBonus + ivAdj - thetaPenalty;
        const score = Math.max(0, Math.min(100, Math.round(50 + rawScore * 12.5)));

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
            whyThis: `λ=${p.lambda.toFixed(1)}, Δ=${Math.abs(p.opt.delta).toFixed(2)}${ivAdj > 0 ? ', Cheap Vol' : ''}`
        };
    }).sort((a, b) => b.score - a.score).slice(0, 5);
}

function parseChain(options, currentPrice, targetDTE = null) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return options.map(opt => {
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

        const strikeMatch = symbol.match(/[CP](\d{8})$/);
        const strike = strikeMatch ? parseInt(strikeMatch[1]) / 1000 : 0;
        const type = symbol.includes('C') && symbol.match(/\d{6}C/) ? 'Call' : 'Put';

        return {
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
            openInterest: opt.open_interest || 0
        };
    }).filter(opt => {
        const minStrike = currentPrice * 0.85;
        const maxStrike = currentPrice * 1.15;
        if (opt.strike < minStrike || opt.strike > maxStrike) return false;

        if (targetDTE !== null) {
            if (targetDTE < 30) return opt.dte >= 14 && opt.dte < 30;
            if (targetDTE < 45) return opt.dte >= 30 && opt.dte < 45;
            if (targetDTE < 90) return opt.dte >= 45 && opt.dte < 90;
            return opt.dte >= 90;
        }
        return opt.dte > 0 && opt.dte <= 730;
    });
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
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;

        // 1. Parallel Fetching
        const [cboeRes, rv30, daysUntilEarnings] = await Promise.all([
            fetch(cboeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.ok ? r.json() : null),
            fetchRV20(upperTicker),
            fetchEarnings(upperTicker)
        ]);

        if (!cboeRes || !cboeRes.data || !cboeRes.data.options) {
            return res.status(404).json({ error: 'No options data found or API error' });
        }

        const currentPrice = cboeRes.data.current_price;
        const allOptions = cboeRes.data.options;

        const fullChain = parseChain(allOptions, currentPrice, null);
        const strategyChain = parseChain(allOptions, currentPrice, dteTarget);

        const iv30 = calculateTargetIV(fullChain, 30, currentPrice);
        const iv90 = calculateTargetIV(fullChain, 90, currentPrice);

        const regime = detectRegime(iv30, iv90, rv30);

        const creditStrat = isBull ? 'Put' : 'Call';
        const debitStrat = isBull ? 'Call' : 'Put';
        const legStrat = isBull ? 'Call' : 'Put';

        // 2. Build Strategies with improved guards
        const creditSpreads = buildCreditSpreads(strategyChain, creditStrat, currentPrice, regime.ivRvRatio, daysUntilEarnings);
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
                SINGLE_LEG: singleLegs
            }
        });

    } catch (error) {
        console.error('🚨 Strategy API Error:', error.message);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
}
