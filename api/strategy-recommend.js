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

const getVolatilityRegimeAdjustment = (termStructureRatio, ivRvRatio, strategy) => {
    // defaults
    const isContango = termStructureRatio < 1.0;
    const isBackwardation = termStructureRatio > 1.05;

    // If IV/RV is missing, fallback to simple Term Structure logic
    if (ivRvRatio === undefined || ivRvRatio === null || isNaN(ivRvRatio)) {
        const simpleRisk = getIVRiskFactor(termStructureRatio);
        return strategy === 'long' ? (1 - simpleRisk) * 5 : (simpleRisk - 1) * 5;
    }

    const isCheap = ivRvRatio < 0.95;
    const isExpensive = ivRvRatio > 1.1;

    let adjustment = 0;

    // 1. Value Zone (Contango + Low VRP) -> Strong Buy
    if (isContango && isCheap) {
        adjustment = +2.5;
    }
    // 2. Momentum Zone (Backwardation + Low VRP) -> Buying ok
    else if (isBackwardation && isCheap) {
        adjustment = +1.0;
    }
    // 3. Trap Zone (Contango + High VRP) -> Avoid
    else if (isContango && isExpensive) {
        adjustment = -2.0;
    }
    // 4. Fear Zone (Backwardation + High VRP) -> Strong Sell
    else if (isBackwardation && isExpensive) {
        adjustment = -3.0;
    }
    // Mixed
    else {
        const termScore = (1 - termStructureRatio) * 5;
        const vrpScore = (1 - ivRvRatio) * 5;
        adjustment = (termScore + vrpScore) / 2;
    }

    if (strategy !== 'long') {
        return -adjustment;
    }

    return adjustment;
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
// REGIME DETECTION (4-Card Method)
// =============================================================================

// =============================================================================
// REGIME DETECTION (Strict Interpolation Method)
// =============================================================================

/**
 * Get Clean ATM IV (The Golden Rule)
 * Average of ATM Call and Put IV to remove skew/noise
 */
function getCleanATM_IV(chain, currentPrice) {
    if (!chain || chain.length === 0) return null;

    // Group by strike
    const strikes = {};
    chain.forEach(opt => {
        if (!strikes[opt.strike]) strikes[opt.strike] = {};
        strikes[opt.strike][opt.type] = opt;
    });

    // Find strike closest to spot price that has BOTH Call and Put
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

    // Sanity check for bad data
    if (!atmCall.iv || !atmPut.iv) return null;

    return (atmCall.iv + atmPut.iv) / 2;
}

/**
 * Calculate Target IV using Linear Interpolation
 * IV_target = IV_near + (IV_far - IV_near) * weight
 */
function calculateTargetIV(allOptions, targetDTE, currentPrice) {
    // 1. Get all unique DTEs available sorted
    const dtes = [...new Set(allOptions.map(o => o.dte))].sort((a, b) => a - b);

    if (dtes.length === 0) return null;

    // Exact match check
    if (dtes.includes(targetDTE)) {
        const chain = allOptions.filter(o => o.dte === targetDTE);
        return getCleanATM_IV(chain, currentPrice);
    }

    // 2. Find near and far DTEs
    let nearDTE = null;
    let farDTE = null;

    for (const dte of dtes) {
        if (dte < targetDTE) nearDTE = dte;
        if (dte > targetDTE) {
            farDTE = dte;
            break;
        }
    }

    // If we can't bracket the target date, we can't interpolate accurately.
    // Fallback: If we have data very close (e.g. within 2 days), use it?
    // User demand: "Data Integrity ... Term Structure Completeness" -> Fallback to null implies system downgrade.
    if (nearDTE === null || farDTE === null) return null;

    // 3. Get ATM IVs for those dates
    const chainNear = allOptions.filter(o => o.dte === nearDTE);
    const chainFar = allOptions.filter(o => o.dte === farDTE);

    const ivNear = getCleanATM_IV(chainNear, currentPrice);
    const ivFar = getCleanATM_IV(chainFar, currentPrice);

    if (ivNear === null || ivFar === null) return null;

    // 4. Interpolate
    const timeRange = farDTE - nearDTE;
    const timeToTarget = targetDTE - nearDTE;
    const weight = timeToTarget / timeRange;

    return ivNear + (ivFar - ivNear) * weight;
}

/**
 * Fetch RV20 from Nasdaq (Internal Logic)
 */
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
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9'
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

        const recentReturns = returns.slice(-20);
        const mean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
        const variance = recentReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (recentReturns.length - 1);
        const annualizedRV = Math.sqrt(variance) * Math.sqrt(252) * 100;

        return annualizedRV;
    } catch (e) {
        console.error("RV Fetch Error:", e);
        return null;
    }
}

async function detectRegime(allOptions, currentPrice, ticker, preFetchedRv20 = null) {
    // Calculate IV30 and IV90 using strict interpolation
    const iv30 = calculateTargetIV(allOptions, 30, currentPrice);
    const iv90 = calculateTargetIV(allOptions, 90, currentPrice);

    // Fetch RV20 (use pre-fetched if available)
    const rv20 = preFetchedRv20 !== null ? preFetchedRv20 : await fetchRV20(ticker);

    // Sanity Check: If data is missing
    if (!iv30 || !iv90 || iv90 === 0) {
        return {
            ivRatio: 1.0,
            iv30,
            iv90,
            rv20,
            ivRvRatio: null,
            mode: 'NEUTRAL',
            advice: '⚖️ Insufficient Data for IV Ratio. Defaulting to Neutral.'
        };
    }

    const termRatio = iv30 / iv90;
    const ivRvRatio = rv20 ? (iv30 * 100) / rv20 : null;

    let mode = 'NEUTRAL';
    let advice = '⚖️ Neutral IV: Either strategy viable, compare scores';

    // 1. Check for Term Structure Extreme (Backwardation)
    if (termRatio > 1.05) {
        mode = 'CREDIT';
        advice = '🔴 Backwardation (Expensive near-term): Sell Credit Spreads';
    }
    // 2. Check for Volatility Risk Premium (IV > RV)
    else if (ivRvRatio && ivRvRatio > 1.35) {
        mode = 'CREDIT';
        advice = '💎 High Risk Premium (IV > RV): Market overestimating move. Sell Credit.';
    }
    // 3. Check for Contango (Cheap near-term)
    else if (termRatio < 0.95) {
        mode = 'DEBIT';
        advice = '🟢 Contango (Cheap near-term IV): Buy Debit Spreads';
    }
    // 4. Check for Cheap RV (IV < RV)
    else if (ivRvRatio && ivRvRatio < 0.85) {
        mode = 'DEBIT';
        advice = '🚀 Momentum Alert (RV > IV): Stock moving faster than priced. Buy Debit.';
    }

    // Sanity Check: Extreme outliers
    if (termRatio > 2.0 || termRatio < 0.5) {
        return {
            ivRatio: 1.0,
            iv30,
            iv90,
            rv20,
            ivRvRatio,
            mode: 'NEUTRAL',
            advice: '⚠️ IV Ratio Outlier Detected. Data may be unreliable.'
        };
    }

    return {
        ivRatio: termRatio,
        iv30,
        iv90,
        rv20,
        ivRvRatio,
        mode,
        advice
    };
}

// =============================================================================
// CREDIT SPREAD BUILDER
// =============================================================================

function buildCreditSpreads(chain, type, currentPrice, ivRvRatio, ivRatio) {
    const results = [];
    const widths = [5, 10];

    // Anchor: Short Leg with Delta 0.20 - 0.40
    const shorts = chain.filter(o =>
        o.type === type &&
        Math.abs(o.delta) >= 0.20 &&
        Math.abs(o.delta) <= 0.40
    );

    for (const shortLeg of shorts) {
        for (const width of widths) {
            // For Put Spread: Long is below Short (protection)
            // For Call Spread: Long is above Short (protection)
            const longStrike = type === 'Put'
                ? shortLeg.strike - width
                : shortLeg.strike + width;

            const longLeg = chain.find(o =>
                o.type === type &&
                o.expiration === shortLeg.expiration &&
                Math.abs(o.strike - longStrike) < 0.1
            );

            if (!longLeg) continue;

            // Calculate metrics
            const credit = shortLeg.bid - longLeg.ask;
            const maxRisk = width - credit;

            // Hard filter: must have positive credit and risk
            if (credit < 0.15 || maxRisk <= 0) continue;

            const roi = (credit / maxRisk) * 100;
            const pop = 1 - Math.abs(shortLeg.delta);
            const distance = Math.abs(currentPrice - shortLeg.strike) / currentPrice;
            // Expected Value
            const expectedValue = (credit * pop) - (maxRisk * (1 - pop));

            // Liquidity Guard (Composite Spread)
            const spreadBid = shortLeg.bid - longLeg.ask; // Conservative credit to open
            const spreadAsk = shortLeg.ask - longLeg.bid; // Conservative debit to close
            const spreadMid = (spreadBid + spreadAsk) / 2;
            const spreadPct = spreadMid > 0 ? (spreadAsk - spreadBid) / spreadMid : 1.0;

            // Hard filter: ROI too low or liquidity too poor (Complex Wide Spread)
            if (roi < 15 || spreadPct > 0.15) continue;

            const totalIvAdj = getVolatilityRegimeAdjustment(ivRatio, ivRvRatio, 'short');

            // CSQ Spread Score: 40% ROI + 40% POP + 20% Distance + VRP Adj
            const scoreROI = Math.min(roi * 4, 100); // 25% ROI = 100 pts
            const scorePOP = pop * 100;
            const scoreDistance = Math.min(distance * 1000, 100); // 10% OTM = 100 pts

            const finalScore = Math.round(0.4 * scoreROI + 0.4 * scorePOP + 0.2 * scoreDistance + totalIvAdj);

            // Generate "Why this?" explanation
            const whyThis = roi >= 25
                ? `High yield ${roi.toFixed(0)}% ROI with ${(pop * 100).toFixed(0)}% win rate`
                : `Balanced ${roi.toFixed(0)}% ROI, ${(distance * 100).toFixed(1)}% safety margin`;

            results.push({
                type: type === 'Put' ? 'Credit Put Spread' : 'Credit Call Spread',
                shortLeg: {
                    strike: shortLeg.strike,
                    expiration: shortLeg.expiration,
                    dte: shortLeg.dte,
                    price: shortLeg.bid,
                    delta: shortLeg.delta,
                    iv: shortLeg.iv,
                    volume: shortLeg.volume,
                    openInterest: shortLeg.openInterest
                },
                longLeg: {
                    strike: longLeg.strike,
                    expiration: longLeg.expiration,
                    price: longLeg.ask,
                    delta: longLeg.delta,
                    volume: longLeg.volume,
                    openInterest: longLeg.openInterest
                },
                width,
                netCredit: Number(credit.toFixed(2)),
                maxRisk: Number(maxRisk.toFixed(2)),
                maxProfit: Number(credit.toFixed(2)),
                roi: Number(roi.toFixed(1)),
                pop: Number((pop * 100).toFixed(1)),
                expectedValue: Number(expectedValue.toFixed(2)),
                distance: Number((distance * 100).toFixed(1)),
                breakeven: type === 'Put'
                    ? shortLeg.strike - credit
                    : shortLeg.strike + credit,
                score: Math.min(100, Math.max(0, finalScore)),
                whyThis
            });
        }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

// =============================================================================
// DEBIT SPREAD BUILDER
// =============================================================================

// =============================================================================
// DEBIT SPREAD BUILDER
// =============================================================================

function buildDebitSpreads(chain, type, currentPrice, ivRvRatio, ivRatio) {
    const results = [];
    const widths = [2.5, 5, 10]; // Added 10 for larger tickers

    // Anchor: Long Leg with Delta 0.45 - 0.70 (Sweet spot)
    const longs = chain.filter(o =>
        o.type === type &&
        Math.abs(o.delta) >= 0.45 &&
        Math.abs(o.delta) <= 0.70
    );

    for (const longLeg of longs) {
        for (const width of widths) {
            const shortStrike = type === 'Call'
                ? longLeg.strike + width
                : longLeg.strike - width;

            const shortLeg = chain.find(o =>
                o.type === type &&
                o.expiration === longLeg.expiration &&
                Math.abs(o.strike - shortStrike) < 0.1
            );

            if (!shortLeg) continue;

            // Calculate metrics
            const debit = longLeg.ask - shortLeg.bid; // Conservative debit
            const maxProfit = width - debit;
            const maxRisk = debit;

            // Hard filters
            if (debit <= 0 || debit >= width * 0.60) continue; // Cost < 60% of width
            const riskReward = maxProfit / maxRisk; // Proper R:R calculation
            if (riskReward < 1.5) continue; // Strict R:R per v2.3

            // Liquidity Guard
            const spreadBid = longLeg.bid - shortLeg.ask;
            const spreadAsk = longLeg.ask - shortLeg.bid;
            const spreadMid = (spreadBid + spreadAsk) / 2;
            const spreadPct = spreadMid > 0 ? (spreadAsk - spreadBid) / spreadMid : 1.0;

            if (spreadPct > 0.15) continue;

            // Scoring Factors
            const mid = (longLeg.bid + longLeg.ask) / 2;
            const lambda = mid > 0 ? Math.abs(longLeg.delta) * (currentPrice / mid) : 0;
            const compLambda = compressLambda(lambda);
            const deltaBonus = getDeltaBonus(longLeg.delta);
            const pop = Math.abs(longLeg.delta) - 0.05; // Approx
            const expectedValue = (maxProfit * pop) - (maxRisk * (1 - pop));

            // Scores
            const lambdaScore = Math.min((compLambda / 20) * 100, 100);
            const rrScore = Math.min((riskReward / 3) * 100, 100);
            const deltaScore = 50 + deltaBonus * 12.5;

            const totalIvAdj = getVolatilityRegimeAdjustment(ivRatio, ivRvRatio, 'long');
            const finalScore = Math.round(0.4 * lambdaScore + 0.35 * rrScore + 0.25 * deltaScore + totalIvAdj);

            const whyThis = `${riskReward.toFixed(1)}:1 R:R, λ=${lambda.toFixed(1)} leverage`;

            results.push({
                type: type === 'Call' ? 'Debit Call Spread' : 'Debit Put Spread',
                longLeg: {
                    strike: longLeg.strike,
                    expiration: longLeg.expiration,
                    dte: longLeg.dte,
                    price: longLeg.ask,
                    delta: longLeg.delta,
                    iv: longLeg.iv,
                    volume: longLeg.volume,
                    openInterest: longLeg.openInterest
                },
                shortLeg: {
                    strike: shortLeg.strike,
                    expiration: shortLeg.expiration,
                    price: shortLeg.bid,
                    delta: shortLeg.delta,
                    volume: shortLeg.volume,
                    openInterest: shortLeg.openInterest
                },
                width,
                netDebit: Number(debit.toFixed(2)),
                maxRisk: Number(maxRisk.toFixed(2)),
                maxProfit: Number(maxProfit.toFixed(2)),
                riskReward: Number(riskReward.toFixed(2)),
                lambda: Number(lambda.toFixed(1)),
                pop: Number((pop * 100).toFixed(1)),
                expectedValue: Number(expectedValue.toFixed(2)),
                breakeven: type === 'Call'
                    ? longLeg.strike + debit
                    : longLeg.strike - debit,
                score: Math.min(100, Math.max(0, finalScore)),
                whyThis
            });
        }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

// =============================================================================
// SINGLE LEG SCORER (LOQ-based)
// =============================================================================

function scoreSingleLegs(chain, type, ivRatio, ivRvRatio, currentPrice) {
    const filtered = chain.filter(o =>
        o.type === type &&
        Math.abs(o.delta) >= 0.25 &&
        Math.abs(o.delta) <= 0.60
    );

    if (filtered.length === 0) return [];

    // Calculate metrics
    const processed = filtered.map(opt => {
        const mid = (opt.bid + opt.ask) / 2;
        const lambda = Math.abs(opt.delta) * (currentPrice / mid);
        const gammaEff = opt.gamma / mid;
        const thetaBurn = Math.abs(opt.theta) / mid;
        const spreadPct = (opt.ask - opt.bid) / mid;
        return { opt, mid, lambda, gammaEff, thetaBurn, spreadPct };
    });

    // Z-Score normalize
    const compressedLambdas = processed.map(p => compressLambda(p.lambda));
    const gammas = processed.map(p => p.gammaEff);
    const thetas = processed.map(p => p.thetaBurn);
    const zL = zScores(compressedLambdas);
    const zG = zScores(gammas);
    const zT = zScores(thetas);

    // IV Adjustment
    const totalIvAdj = getVolatilityRegimeAdjustment(ivRatio, ivRvRatio, 'long');

    return processed.map((p, i) => {
        const deltaBonus = getDeltaBonus(p.opt.delta);
        const thetaPenalty = getThetaPenalty(p.thetaBurn);

        // Deal Breaker
        if (p.spreadPct > 0.15) return null;

        const rawScore = 0.40 * zL[i] + 0.30 * zG[i] - 0.15 * zT[i] + 0.15 * deltaBonus + totalIvAdj - thetaPenalty;
        const score = Math.max(0, Math.min(100, Math.round(50 + rawScore * 12.5)));

        return {
            type: `Long ${type}`,
            strike: p.opt.strike,
            expiration: p.opt.expiration,
            dte: p.opt.dte,
            price: Number(p.mid.toFixed(2)),
            delta: p.opt.delta,
            iv: p.opt.iv,
            gamma: p.opt.gamma,
            theta: p.opt.theta,
            vega: p.opt.vega,
            volume: p.opt.volume,
            openInterest: p.opt.openInterest,
            lambda: Number(p.lambda.toFixed(1)),
            gammaEff: Number(p.gammaEff.toFixed(4)),
            thetaBurn: Number(p.thetaBurn.toFixed(4)),
            score,
            whyThis: `λ=${p.lambda.toFixed(1)} leverage, Δ=${Math.abs(p.opt.delta).toFixed(2)} exposure`
        };
    }).sort((a, b) => b.score - a.score).slice(0, 5);
}

// =============================================================================
// CHAIN PARSER (CBOE Format)
// =============================================================================

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
        // Filter by strike range (15% around current price)
        const minStrike = currentPrice * 0.85;
        const maxStrike = currentPrice * 1.15;
        if (opt.strike < minStrike || opt.strike > maxStrike) return false;
        // Filter by DTE if specified
        if (targetDTE !== null) {
            if (targetDTE < 30) return opt.dte >= 14 && opt.dte < 30; // Short: 14-30
            if (targetDTE < 45) return opt.dte >= 30 && opt.dte < 45; // Med: 30-45
            if (targetDTE < 90) return opt.dte >= 45 && opt.dte < 90; // Long: 45-90
            return opt.dte >= 90; // Leaps: 90+
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
        // Fetch CBOE and RV20 in parallel
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;
        const [cboeResponse, rv20] = await Promise.all([
            fetch(cboeUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            }),
            fetchRV20(upperTicker)
        ]);

        if (!cboeResponse.ok) {
            return res.status(cboeResponse.status).json({ error: 'CBOE API error', status: cboeResponse.status });
        }

        const data = await cboeResponse.json();

        if (!data.data || !data.data.options) {
            return res.status(404).json({ error: 'No options data found' });
        }

        const currentPrice = data.data.current_price;
        const allOptions = data.data.options;

        // Parse FULL chain for strict IV Term Structure calculation (Interpolation needs all DTEs)
        const fullChain = parseChain(allOptions, currentPrice, null);

        // Filter options based on target DTE for strategy generation
        const strategyChain = parseChain(allOptions, currentPrice, dteTarget);

        // Detect IV Regime using Strict Interpolation (Passing pre-fetched rv20)
        const regime = await detectRegime(fullChain, currentPrice, upperTicker, rv20);

        // Generate ALL recommendations
        const creditStrat = isBull ? 'Put' : 'Call';
        const debitStrat = isBull ? 'Call' : 'Put';
        const legStrat = isBull ? 'Call' : 'Put';

        const creditSpreads = buildCreditSpreads(strategyChain, creditStrat, currentPrice, regime.ivRvRatio, regime.ivRatio);
        const debitSpreads = buildDebitSpreads(strategyChain, debitStrat, currentPrice, regime.ivRvRatio, regime.ivRatio);
        const singleLegs = scoreSingleLegs(strategyChain, legStrat, regime.ivRatio, regime.ivRvRatio, currentPrice).filter(x => x !== null);

        // Determine Recommended Strategy
        let recommendedStrategy = 'CREDIT_SPREAD';

        if (regime.mode === 'DEBIT') {
            recommendedStrategy = 'DEBIT_SPREAD';
        } else if (regime.mode === 'NEUTRAL') {
            // Tie-breaker: Check scores
            const topCredit = creditSpreads[0]?.score || 0;
            const topDebit = debitSpreads[0]?.score || 0;
            if (topDebit > topCredit) recommendedStrategy = 'DEBIT_SPREAD';
        }

        // Validation: If recommended has no results, fallback
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
                cboeTimestamp: data.timestamp || null
            },
            regime: {
                ivRatio: Number(regime.ivRatio.toFixed(3)),
                iv30: regime.iv30 ? Number((regime.iv30 * 100).toFixed(1)) : null,
                iv90: regime.iv90 ? Number((regime.iv90 * 100).toFixed(1)) : null,
                rv20: regime.rv20 ? Number(regime.rv20.toFixed(1)) : null,
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
