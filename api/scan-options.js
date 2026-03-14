// api/scan-options.js
// OSS v2.1 Scanner - Vercel Serverless Function
// Uses shared scoring module (Single Source of Truth)

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
    compressLambda,
    calculateDollarGamma,
    calculateGammaThetaRatio,
    calculateBreakevenMove,
    getBreakevenPenalty,
    getThetaPenalty,
    getDeltaBonus,
    zScores,
    zScoresByBucket,
    HARD_FILTER_DEFAULTS,
    getIVAdjustment,
    getRelativeIVAdjustmentLOQ,
    getRelativeIVAdjustmentCSQ,
    calculateLOQRaw,
    calculateCSQRaw,
    buildLOQFactors,
    buildCSQFactors,
    normalizeScoreTo100,
    normalizeLOQScoresWithDynamicBaseline,
    calculateSpreadPct,
    getCleanATM_IV,
    calculateTargetIV,
    parseChain,
} = require('../lib/_shared/scoring.cjs');
const { saveTickerIVSnapshot } = require('../lib/_shared/ivHistory.cjs');

// ---------------------------------------------------------
// Main Handler
// ---------------------------------------------------------
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const activeProfile = req.query.activeProfile === 'shortTerm' ? 'shortTerm' : 'swing';
    const dteDefaults = activeProfile === 'shortTerm' ? { min: '5', max: '21' } : { min: '20', max: '60' };
    const {
        ticker,
        strategy = 'long',
        dteMin = dteDefaults.min,
        dteMax = dteDefaults.max,
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

        const dataSource = (process.env.DATA_SOURCE || 'CBOE').trim().toUpperCase();
        let options = [];
        let currentPrice = 0;
        let cboeTimestamp = null;
        let quoteFreshness = null;

        if (dataSource === 'POLYGON' || dataSource === 'ORATS') {
            // 'POLYGON' accepted as legacy alias → routes to ORATS
            const { getOptionChain, getUnderlyingPrice, checkQuoteFreshness } = await import('../lib/orats-client.js');
            console.log(`Scanning ${upperTicker} via ORATS`);

            // Get underlying price first so we request only the strike range we use (reduces payload/API)
            const underlyingPrice = await getUnderlyingPrice(upperTicker);
            const minStrike = underlyingPrice > 0 ? underlyingPrice * (1 - strikeRangeNum) : undefined;
            const maxStrike = underlyingPrice > 0 ? underlyingPrice * (1 + strikeRangeNum) : undefined;

            const filters = {
                minDte: dteMinNum,
                maxDte: dteMaxNum
            };
            if (minStrike != null && maxStrike != null) {
                filters.minStrike = minStrike;
                filters.maxStrike = maxStrike;
            }
            if (direction === 'call') filters.side = 'call';
            if (direction === 'put') filters.side = 'put';

            const chainData = await getOptionChain(upperTicker, filters);

            if (chainData && chainData.length > 0) {
                options = chainData;
                // Prefer fresh stock snapshot price; only use chain underlying if it agrees
                const chainUP = chainData.find(o => o.underlyingPrice > 0)?.underlyingPrice || 0;
                if (underlyingPrice > 0) {
                    const div = chainUP > 0 ? Math.abs(chainUP - underlyingPrice) / underlyingPrice : 1;
                    currentPrice = div <= 0.15 ? chainUP : underlyingPrice;
                } else {
                    currentPrice = chainUP;
                }
                quoteFreshness = checkQuoteFreshness(chainData);
            } else {
                return res.status(200).json({ success: true, results: [], context: { note: 'No data from ORATS' } });
            }

        } else {
            // CBOE Legacy
            const response = await fetch(cboeUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (!response.ok) {
                return res.status(response.status).json({ error: 'CBOE API error', status: response.status });
            }

            const data = await response.json();

            if (!data.data?.options) {
                return res.status(404).json({ error: 'No options data found' });
            }

            currentPrice = data.data.current_price;
            options = data.data.options;
            cboeTimestamp = data.timestamp;
        }

        // Parse full chain for IV calculation
        const fullChain = parseChain(options, currentPrice, null);

        // 4.1 — Degraded data detection: CBOE sometimes returns chains with all-zero Greeks.
        const zeroGreeksCount = fullChain.filter(o => o.delta === 0 && o.gamma === 0 && o.vega === 0).length;
        const dataQuality = fullChain.length > 0 && zeroGreeksCount / fullChain.length > 0.5 ? 'degraded' : 'ok';

        // F6.4 — CBOE fallback produces meaningless scores (all Greeks=0 → LOQ/CSQ ≈ 50 for everything)
        const scoresReliable = !(dataSource === 'CBOE' && dataQuality === 'degraded');

        // Hard filters — single pass combining filter + metric calculation
        const minStrike = currentPrice * (1 - strikeRangeNum);
        const maxStrike = currentPrice * (1 + strikeRangeNum);

        const processed = [];

        for (const opt of fullChain) {
            // DTE filter
            if (opt.dte < dteMinNum || opt.dte > dteMaxNum) continue;

            // Strike range filter
            if (opt.strike < minStrike || opt.strike > maxStrike) continue;

            // Direction filter
            if (direction === 'call' && opt.type !== 'Call') continue;
            if (direction === 'put' && opt.type !== 'Put') continue;

            // Liquidity guards
            if (opt.bid <= 0 || opt.ask <= 0) continue;
            const mid = (opt.bid + opt.ask) / 2;
            if (mid <= 0) continue;
            if (mid < HARD_FILTER_DEFAULTS.minMid) continue;
            if (opt.openInterest < HARD_FILTER_DEFAULTS.minOpenInterest) continue;

            const effectiveMaxSpreadPct = Math.min(maxSpreadPctNum, HARD_FILTER_DEFAULTS.maxSpreadPctCeiling);
            const spreadPct = calculateSpreadPct(opt.bid, opt.ask);
            if (spreadPct > effectiveMaxSpreadPct) continue;

            // Volume filter
            if (opt.volume < minVolumeNum) continue;

            // Delta filter
            const absDelta = Math.abs(opt.delta);
            if (absDelta < minDeltaNum || absDelta > maxDeltaNum) continue;

            // Calculate metrics inline (single pass)
            if (strategy === 'long') {
                const lambda = Math.abs(opt.delta) * (currentPrice / mid);
                const dollarGamma = calculateDollarGamma(opt.gamma, currentPrice);
                const thetaBurn = Math.abs(opt.theta) / mid;
                const gammaThetaRatio = calculateGammaThetaRatio(opt.gamma, opt.theta);
                const breakevenMove = calculateBreakevenMove(opt.strike, mid, currentPrice, opt.type);
                processed.push({ opt, mid, spreadPct, lambda, dollarGamma, thetaBurn, gammaThetaRatio, breakevenMove });
            } else {
                const pop = 1 - Math.abs(opt.delta);
                const edge = pop * mid;
                processed.push({ opt, mid, spreadPct, pop, edge });
            }
        }

        if (processed.length === 0) {
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

        // Calculate IV Ratio using strict interpolation
        const iv30 = calculateTargetIV(fullChain, 30, currentPrice);
        const iv90 = calculateTargetIV(fullChain, 90, currentPrice);

        let ivRatio = 1.0;
        if (iv30 && iv90 && iv90 > 0) {
            ivRatio = iv30 / iv90;
            if (ivRatio > 2.0 || ivRatio < 0.5) ivRatio = 1.0;
        }

        const ivStatus = ivRatio < 0.95 ? 'contango' : ivRatio > 1.05 ? 'backwardation' : 'neutral';
        let ivAdjustment = getIVAdjustment(ivRatio, strategy);

        if (iv30 != null) {
            await saveTickerIVSnapshot(upperTicker, iv30, iv90);
        }

        // Fetch IV rank + put-call ratio from ORATS cores (single call replaces separate getIVRank)
        let scanIVRank = 0.5; // neutral default
        let scanPutCallRatio = null;
        try {
            const { getCores: oratsGetCores } = await import('../lib/orats-client.js');
            const scanCores = await oratsGetCores(upperTicker);
            if (scanCores) {
                if (scanCores.ivPctile1y != null) {
                    scanIVRank = scanCores.ivPctile1y / 100; // 0–100 → 0–1
                    console.log(`[scan-options] ${upperTicker}: ORATS ivRank=${scanIVRank.toFixed(3)} (from cores)`);
                }
                if (scanCores.pVolu > 0 && scanCores.cVolu > 0) {
                    scanPutCallRatio = Number((scanCores.pVolu / scanCores.cVolu).toFixed(3));
                }
            }
        } catch (_) { /* keep neutral default */ }

        // Score
        let results;

        if (strategy === 'long') {
            const compressedLambdas = processed.map((p) => compressLambda(p.lambda));
            const dollarGammas = processed.map((p) => p.dollarGamma);
            const thetas = processed.map((p) => p.thetaBurn);
            const gtRatios = processed.map((p) => p.gammaThetaRatio);
            const dtes = processed.map((p) => p.opt.dte);
            const vegaEfficiencies = processed.map((p) => (p.opt.vega || 0) / (p.mid || 0.01));
            const zL = zScoresByBucket(compressedLambdas, dtes);
            const zDG = zScoresByBucket(dollarGammas, dtes);
            const zT = zScoresByBucket(thetas, dtes);
            const zGT = zScoresByBucket(gtRatios, dtes);
            const zVegaEff = zScoresByBucket(vegaEfficiencies, dtes);

            const rawScores = processed.map((p, i) => {
                const atmIV = calculateTargetIV(fullChain, p.opt.dte, currentPrice);
                const relIvAdj = getRelativeIVAdjustmentLOQ(p.opt.iv, atmIV);
                const deltaBonus = getDeltaBonus(p.opt.delta);
                const bePenalty = getBreakevenPenalty(p.breakevenMove, p.opt.dte);
                return calculateLOQRaw(zL[i], zDG[i], zT[i], ivAdjustment + relIvAdj, deltaBonus, p.thetaBurn, isDayTradeMode, zGT[i], bePenalty, p.opt.dte, zVegaEff[i]);
            });
            const loqScores = normalizeLOQScoresWithDynamicBaseline(rawScores);

            results = processed.map((p, i) => {
                const score = loqScores[i];
                const atmIV = calculateTargetIV(fullChain, p.opt.dte, currentPrice);
                const relIvAdj = getRelativeIVAdjustmentLOQ(p.opt.iv, atmIV);
                const deltaBonus = getDeltaBonus(p.opt.delta);
                const bePenalty = getBreakevenPenalty(p.breakevenMove, p.opt.dte);
                const factors = buildLOQFactors(
                    zL[i], zDG[i], zT[i],
                    ivAdjustment + relIvAdj, deltaBonus, p.thetaBurn,
                    zGT[i], bePenalty, p.opt.dte, zVegaEff[i]
                );
                return {
                    symbol: p.opt.symbol,
                    strike: p.opt.strike,
                    type: p.opt.type,
                    expiration: p.opt.expiration,
                    dte: p.opt.dte,
                    price: Math.round(p.mid * 100) / 100,
                    score,
                    factors,
                    metrics: {
                        lambda: Math.round(p.lambda * 100) / 100,
                        dollarGamma: Math.round(p.dollarGamma * 100) / 100,
                        thetaBurn: Math.round(p.thetaBurn * 10000) / 10000,
                        gammaThetaRatio: Math.round(p.gammaThetaRatio * 1000) / 1000,
                        breakevenMove: Math.round(p.breakevenMove * 10000) / 10000,
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
            const dtes = processed.map((p) => p.opt.dte);
            const vegaEfficiencies = processed.map((p) => (p.opt.vega || 0) / (p.mid || 0.01));
            const zE = zScoresByBucket(edges, dtes);
            const zP = zScoresByBucket(pops, dtes);
            const zS = zScoresByBucket(spreads, dtes);
            const zVegaEff = zScoresByBucket(vegaEfficiencies, dtes);

            results = processed.map((p, i) => {
                const atmIV = calculateTargetIV(fullChain, p.opt.dte, currentPrice);
                const relIvAdj = getRelativeIVAdjustmentCSQ(p.opt.iv, atmIV);
                // Vega penalty conditioned on IV Rank: at high IV Rank, selling high-vega is desirable.
                // Vega penalty scaled by IV rank: at high IV rank, selling high-vega is desirable
                const vegaPenalty = -0.05 * Math.max(0, 1 - scanIVRank) * zVegaEff[i];
                const rawScore = calculateCSQRaw(zE[i], zP[i], zS[i], ivAdjustment + relIvAdj, vegaPenalty);
                const score = normalizeScoreTo100(rawScore);
                const factors = buildCSQFactors(
                    zE[i], zP[i], zS[i],
                    ivAdjustment + relIvAdj, vegaPenalty
                );
                return {
                    symbol: p.opt.symbol,
                    strike: p.opt.strike,
                    type: p.opt.type,
                    expiration: p.opt.expiration,
                    dte: p.opt.dte,
                    price: Math.round(p.mid * 100) / 100,
                    score,
                    factors,
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
            dataQuality,
            scoresReliable,
            context: {
                ticker: upperTicker,
                currentPrice,
                ivRatio: Math.round(ivRatio * 1000) / 1000,
                iv30: iv30 ? Math.round(iv30 * 1000) / 1000 : null,
                iv90: iv90 ? Math.round(iv90 * 1000) / 1000 : null,
                ivRank: scanIVRank !== 0.5 ? Number(scanIVRank.toFixed(3)) : null,
                putCallRatio: scanPutCallRatio,
                ivStatus,
                strategy,
                totalOptions: options.length,
                filteredCount: processed.length,
                cboeTimestamp: cboeTimestamp ?? null,
                quoteFreshness: quoteFreshness ?? null
            },
            results
        });

    } catch (error) {
        console.error('Scan API Error:', error.message);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
}
