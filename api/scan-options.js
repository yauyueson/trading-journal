// api/scan-options.js
// OSS v2.1 Scanner - Vercel Serverless Function

// === Scoring Helper Functions ===

// 1. IV Sigmoid Phase Transition
const getIVRiskFactor = (ratio) => {
    const k = 12;
    const x0 = 1.10;
    const raw = 1 / (1 + Math.exp(-k * (ratio - x0)));
    return 0.9 + raw * 0.4;
};

// 2. IV Adjustment
const getIVAdjustment = (ivRatio, strategy) => {
    const riskFactor = getIVRiskFactor(ivRatio);
    if (strategy === 'long') {
        return (1 - riskFactor) * 5;
    } else {
        return (riskFactor - 1) * 5;
    }
};

// 3. Lambda Soft Compression
const compressLambda = (lambda) => {
    const threshold = 20;
    const decayRate = 0.1;
    if (lambda <= threshold) return lambda;
    return threshold + (lambda - threshold) * decayRate;
};

// 4. Theta Pain Curve (Exponential Penalty)
const getThetaPenalty = (thetaBurn) => {
    const SAFE_ZONE = 0.005;
    if (thetaBurn <= SAFE_ZONE) return 0;
    const excess = thetaBurn - SAFE_ZONE;
    return Math.min(Math.pow(excess * 100, 2) * 0.5, 10);
};

// 5. Delta Bonus
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

// Z-Score normalization
const zScores = (values) => {
    const n = values.length;
    if (n < 2) return values.map(() => 0);
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1;
    return values.map(v => (v - mean) / std);
};

// =============================================================================
// STRICT IV CALCULATION
// =============================================================================

const getCleanATM_IV = (chain, currentPrice) => {
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

    if (!atmCall.iv || !atmPut.iv) return null;

    return (atmCall.iv + atmPut.iv) / 2;
};

const calculateTargetIV = (allOptions, targetDTE, currentPrice) => {
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
};

// ---------------------------------------------------------
// 🚀 Main Handler
// ---------------------------------------------------------
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const {
        ticker,
        strategy = 'long',
        dteMin = '20',
        dteMax = '60',
        strikeRange = '0.25',
        minVolume = '50',
        maxSpreadPct = '0.10',
        minDelta = '0',
        maxDelta = '1',
        direction = 'all',
        dayTrade = 'false'
    } = req.query;

    if (!ticker) {
        return res.status(400).json({ error: 'Missing ticker parameter' });
    }

    const dteMinNum = parseInt(dteMin);
    const dteMaxNum = parseInt(dteMax);
    const strikeRangeNum = parseFloat(strikeRange);
    const minVolumeNum = parseInt(minVolume);
    const maxSpreadPctNum = parseFloat(maxSpreadPct);
    const minDeltaNum = parseFloat(minDelta);
    const maxDeltaNum = parseFloat(maxDelta);
    const isDayTradeMode = dayTrade === 'true';

    try {
        const upperTicker = ticker.toUpperCase();
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
        const options = data.data.options;

        // Calculate DTE for each option
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const chain = options.map((opt) => {
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
        });

        // Hard filters
        const minStrike = currentPrice * (1 - strikeRangeNum);
        const maxStrike = currentPrice * (1 + strikeRangeNum);

        const filtered = chain.filter((opt) => {
            const mid = (opt.bid + opt.ask) / 2;
            const spreadPct = mid > 0 ? (opt.ask - opt.bid) / mid : 1;
            const absDelta = Math.abs(opt.delta);

            if (direction === 'call' && opt.type !== 'Call') return false;
            if (direction === 'put' && opt.type !== 'Put') return false;

            return (
                opt.dte >= dteMinNum &&
                opt.dte <= dteMaxNum &&
                opt.strike >= minStrike &&
                opt.strike <= maxStrike &&
                opt.volume >= minVolumeNum &&
                spreadPct <= maxSpreadPctNum &&
                mid > 0 &&
                absDelta >= minDeltaNum &&
                absDelta <= maxDeltaNum
            );
        });

        if (filtered.length === 0) {
            return res.status(200).json({
                success: true,
                context: {
                    ticker: upperTicker,
                    currentPrice,
                    ivRatio: 1.0,
                    ivStatus: 'neutral',
                    strategy,
                    totalOptions: options.length,
                    filteredCount: 0
                },
                results: []
            });
        }

        // Calculate IV Ratio using Strict Interpolation
        const iv30 = calculateTargetIV(chain, 30, currentPrice);
        const iv90 = calculateTargetIV(chain, 90, currentPrice);

        // Sanity Check
        let ivRatio = 1.0;
        if (iv30 && iv90 && iv90 > 0) {
            ivRatio = iv30 / iv90;
            // Outlier check
            if (ivRatio > 2.0 || ivRatio < 0.5) ivRatio = 1.0;
        }

        const ivStatus = ivRatio < 0.95 ? 'contango' : ivRatio > 1.05 ? 'backwardation' : 'neutral';
        const ivAdjustment = getIVAdjustment(ivRatio, strategy);

        // Calculate metrics
        const processed = filtered.map((opt) => {
            const mid = (opt.bid + opt.ask) / 2;
            const spreadPct = (opt.ask - opt.bid) / mid;

            if (strategy === 'long') {
                const lambda = Math.abs(opt.delta) * (currentPrice / mid);
                const gammaEff = opt.gamma / mid;
                const thetaBurn = Math.abs(opt.theta) / mid;
                return { opt, mid, spreadPct, lambda, gammaEff, thetaBurn };
            } else {
                const pop = 1 - Math.abs(opt.delta);
                const edge = pop * mid;
                return { opt, mid, spreadPct, pop, edge };
            }
        });

        let results;

        if (strategy === 'long') {
            const compressedLambdas = processed.map((p) => compressLambda(p.lambda));
            const gammas = processed.map((p) => p.gammaEff);
            const thetas = processed.map((p) => p.thetaBurn);
            const zL = zScores(compressedLambdas);
            const zG = zScores(gammas);
            const zT = zScores(thetas);

            results = processed.map((p, i) => {
                const deltaBonus = getDeltaBonus(p.opt.delta);
                const thetaPenalty = getThetaPenalty(p.thetaBurn);

                let wLambda = 0.40;
                let wGamma = 0.30;
                let wTheta = 0.15;
                let penaltyMultiplier = 1.0;

                if (isDayTradeMode) {
                    wLambda = 0.40;
                    wGamma = 0.50;
                    wTheta = 0.05;
                    penaltyMultiplier = 0.2;
                }

                const rawScore = (
                    wLambda * zL[i] +
                    wGamma * zG[i] -
                    wTheta * zT[i] +
                    0.15 * deltaBonus +
                    ivAdjustment -
                    (thetaPenalty * penaltyMultiplier)
                );

                const score = Math.max(0, Math.min(100, Math.round(50 + rawScore * 12.5)));
                return {
                    symbol: p.opt.symbol,
                    strike: p.opt.strike,
                    type: p.opt.type,
                    expiration: p.opt.expiration,
                    dte: p.opt.dte,
                    price: Math.round(p.mid * 100) / 100,
                    score,
                    metrics: {
                        lambda: Math.round(p.lambda * 100) / 100,
                        gammaEff: Math.round(p.gammaEff * 10000) / 10000,
                        thetaBurn: Math.round(p.thetaBurn * 10000) / 10000,
                        spreadPct: Math.round(p.spreadPct * 1000) / 1000
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
            const edges = processed.map((p) => p.edge);
            const pops = processed.map((p) => p.pop);
            const spreads = processed.map((p) => p.spreadPct);
            const zE = zScores(edges);
            const zP = zScores(pops);
            const zS = zScores(spreads);

            results = processed.map((p, i) => {
                const rawScore = 0.50 * zE[i] + 0.30 * zP[i] - 0.20 * zS[i] + ivAdjustment;
                const score = Math.max(0, Math.min(100, Math.round(50 + rawScore * 12.5)));
                return {
                    symbol: p.opt.symbol,
                    strike: p.opt.strike,
                    type: p.opt.type,
                    expiration: p.opt.expiration,
                    dte: p.opt.dte,
                    price: Math.round(p.mid * 100) / 100,
                    score,
                    metrics: {
                        pop: Math.round(p.pop * 1000) / 1000,
                        edge: Math.round(p.edge * 100) / 100,
                        spreadPct: Math.round(p.spreadPct * 1000) / 1000
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

        // Sort by score descending, take top 20
        results.sort((a, b) => b.score - a.score);
        results = results.slice(0, 20);

        return res.status(200).json({
            success: true,
            context: {
                ticker: upperTicker,
                currentPrice,
                ivRatio: Math.round(ivRatio * 1000) / 1000,
                iv30: iv30 ? Math.round(iv30 * 1000) / 1000 : null,
                iv90: iv90 ? Math.round(iv90 * 1000) / 1000 : null,
                ivStatus,
                strategy,
                totalOptions: options.length,
                filteredCount: filtered.length,
                cboeTimestamp: data.data.timestamp || null
            },
            results
        });

    } catch (error) {
        console.error('🚨 Scan API Error:', error.message);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
}
