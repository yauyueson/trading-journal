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

function detectRegime(allOptions, currentPrice) {
    // Calculate IV30 and IV90 using strict interpolation
    const iv30 = calculateTargetIV(allOptions, 30, currentPrice);
    const iv90 = calculateTargetIV(allOptions, 90, currentPrice);

    // Sanity Check: If data is missing
    if (!iv30 || !iv90 || iv90 === 0) {
        return {
            ivRatio: 1.0,
            iv30: iv30,
            iv90: iv90,
            mode: 'NEUTRAL',
            advice: '⚖️ Insufficient Data for IV Ratio. Defaulting to Neutral.'
        };
    }

    const ratio = iv30 / iv90;

    // Sanity Check: Extreme outliers (user specified > 2.0 or < 0.5)
    if (ratio > 2.0 || ratio < 0.5) {
        return {
            ivRatio: 1.0, // Reset to neutral to avoid bad recommendations
            iv30,
            iv90,
            mode: 'NEUTRAL',
            advice: '⚠️ IV Ratio Outlier Detected. Data may be unreliable.'
        };
    }

    if (ratio < 0.95) {
        return {
            ivRatio: ratio,
            iv30,
            iv90,
            mode: 'DEBIT',
            advice: '🟢 Contango (Cheap IV): Buy Debit Spreads / Long Options'
        };
    } else if (ratio > 1.05) {
        return {
            ivRatio: ratio,
            iv30,
            iv90,
            mode: 'CREDIT',
            advice: '🔴 Backwardation (Expensive IV): Sell Credit Spreads'
        };
    } else {
        return {
            ivRatio: ratio,
            iv30,
            iv90,
            mode: 'NEUTRAL',
            advice: '⚖️ Neutral IV: Either strategy viable, compare scores'
        };
    }
}

// =============================================================================
// CREDIT SPREAD BUILDER
// =============================================================================

function buildCreditSpreads(chain, type, currentPrice) {
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
            const spreadPct = ((shortLeg.ask - shortLeg.bid) / ((shortLeg.ask + shortLeg.bid) / 2));

            // Expected Value
            const expectedValue = (credit * pop) - (maxRisk * (1 - pop));

            // Hard filter: ROI too low or liquidity too poor
            if (roi < 15 || spreadPct > 0.10) continue;

            // CSQ Spread Score: 40% ROI + 40% POP + 20% Distance
            const scoreROI = Math.min(roi * 4, 100); // 25% ROI = 100 pts
            const scorePOP = pop * 100;
            const scoreDistance = Math.min(distance * 1000, 100); // 10% OTM = 100 pts

            const finalScore = Math.round(0.4 * scoreROI + 0.4 * scorePOP + 0.2 * scoreDistance);

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

function buildDebitSpreads(chain, type, currentPrice) {
    const results = [];
    const widths = [2.5, 5];

    // Anchor: Long Leg with Delta 0.40 - 0.70 (Wider range)
    const longs = chain.filter(o =>
        o.type === type &&
        Math.abs(o.delta) >= 0.40 &&
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
            const debit = longLeg.ask - shortLeg.bid;
            const maxProfit = width - debit;
            const maxRisk = debit;
            const riskReward = maxProfit / debit;
            const spreadPct = ((longLeg.ask - longLeg.bid) / ((longLeg.ask + longLeg.bid) / 2));

            // Hard filters (Relaxed)
            // Allow Debit up to 50% of width (1:1 R:R), minimum 1.0 R:R
            if (debit <= 0 || debit >= width * 0.50) continue;
            if (riskReward < 1.0) continue;
            if (spreadPct > 0.10) continue;

            // Calculate Lambda for long leg
            const mid = (longLeg.bid + longLeg.ask) / 2;
            const lambda = Math.abs(longLeg.delta) * (currentPrice / mid);
            const compLambda = compressLambda(lambda);
            const deltaBonus = getDeltaBonus(longLeg.delta);

            // Pop & EV
            const pop = Math.abs(longLeg.delta) - 0.05; // Conservative approximation
            const expectedValue = (maxProfit * pop) - (maxRisk * (1 - pop));

            // LOQ Spread Score
            const lambdaScore = Math.min((compLambda / 20) * 100, 100);
            const rrScore = Math.min((riskReward / 3) * 100, 100);
            const deltaScore = 50 + deltaBonus * 12.5;

            const finalScore = Math.round(0.4 * lambdaScore + 0.35 * rrScore + 0.25 * deltaScore);

            const whyThis = `${riskReward.toFixed(1)}:1 reward-to-risk, λ=${lambda.toFixed(1)} leverage`;

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

function scoreSingleLegs(chain, type, ivRatio, currentPrice) {
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
    const riskFactor = getIVRiskFactor(ivRatio);
    const ivAdj = (1 - riskFactor) * 5;

    return processed.map((p, i) => {
        const deltaBonus = getDeltaBonus(p.opt.delta);
        const thetaPenalty = getThetaPenalty(p.thetaBurn);
        const rawScore = 0.40 * zL[i] + 0.30 * zG[i] - 0.15 * zT[i] + 0.15 * deltaBonus + ivAdj - thetaPenalty;
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
        // Fetch full chain from CBOE
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;
        const response = await fetch(cboeUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: 'CBOE API error', status: response.status });
        }

        const data = await response.json();

        if (!data.data || !data.data.options) {
            return res.status(404).json({ error: 'No options data found' });
        }

        const currentPrice = data.data.current_price;
        const allOptions = data.data.options;

        // Parse FULL chain for strict IV Term Structure calculation (Interpolation needs all DTEs)
        const fullChain = parseChain(allOptions, currentPrice, null);

        // Filter options based on target DTE for strategy generation
        const strategyChain = parseChain(allOptions, currentPrice, dteTarget);

        // Detect IV Regime using Strict Interpolation
        const regime = detectRegime(fullChain, currentPrice);

        // Generate ALL recommendations
        const creditStrat = isBull ? 'Put' : 'Call';
        const debitStrat = isBull ? 'Call' : 'Put';
        const legStrat = isBull ? 'Call' : 'Put';

        const creditSpreads = buildCreditSpreads(strategyChain, creditStrat, currentPrice);
        const debitSpreads = buildDebitSpreads(strategyChain, debitStrat, currentPrice);
        const singleLegs = scoreSingleLegs(strategyChain, legStrat, regime.ivRatio, currentPrice);

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
                cboeTimestamp: data.data.timestamp || null
            },
            regime: {
                ivRatio: Number(regime.ivRatio.toFixed(3)),
                iv30: regime.iv30 ? Number((regime.iv30 * 100).toFixed(1)) : null,
                iv90: regime.iv90 ? Number((regime.iv90 * 100).toFixed(1)) : null,
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
