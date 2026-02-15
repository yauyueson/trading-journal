// api/option-prices.js
// Universal Fetcher for Options (Single or Bulk)
// Supports GET (query params) for single leg and POST (body) for bulk.

import { generateOCCSymbol, normalizeExpiration } from '../lib/_shared/utils.js';

// ── Inline BSM Greeks validator ───────────────────────────────────────────────
// Validates market-provided Greeks against Black-Scholes theory.
// Flags suspicious data (delta=0 on ATM option, gamma=0) caused by stale feeds.

function _normCDF(x) {
    if (x < -8) return 0;
    if (x > 8) return 1;
    const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1.0 / (1.0 + p * Math.abs(x));
    const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
    const cdf = 1.0 - poly * Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
    return 0.5 * (1.0 + sign * (2 * cdf - 1));
}

/**
 * Compute BSM delta for validation.
 * Call delta = N(d1); Put delta = N(d1) - 1
 * d1 = (ln(S/K) + 0.5*σ²*T) / (σ*√T)
 */
function _bsmDelta(S, K, T, sigma, isCall) {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return isCall ? 0.5 : -0.5;
    const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
    return isCall ? _normCDF(d1) : _normCDF(d1) - 1;
}

/**
 * Validate market Greeks against BSM. Returns a (possibly corrected) Greeks object.
 * If market delta differs from BSM delta by >0.15, marks as suspicious and uses BSM.
 *
 * @param {{ delta, gamma, theta, vega, iv }} greeks - Market-provided Greeks
 * @param {number} S - Underlying price
 * @param {number} K - Strike price
 * @param {number} dte - Days to expiration
 * @param {string} type - 'Call' or 'Put'
 * @returns {{ delta, gamma, theta, vega, iv, greeksSuspicious: boolean }}
 */
function validateGreeks(greeks, S, K, dte, type) {
    const { delta, gamma, theta, vega, iv } = greeks;
    const T = (dte || 1) / 365;
    const sigma = iv > 0 ? iv : 0.30; // fallback 30% IV if missing
    const isCall = type === 'Call';
    const bsmDelta = _bsmDelta(S, K, T, sigma, isCall);

    // Detect obviously bad data: delta=0 on near-ATM option, or wrong sign
    const absDelta = Math.abs(delta || 0);
    const expectedSign = isCall ? 1 : -1;
    const wrongSign = (delta || 0) * expectedSign < 0;
    const zeroOnATM = absDelta < 0.05 && Math.abs(S - K) / S < 0.10; // delta=0 within 10% of ATM
    const largeDivergence = Math.abs((delta || 0) - bsmDelta) > 0.15;

    if (wrongSign || zeroOnATM || largeDivergence) {
        return {
            delta: bsmDelta,
            gamma: gamma || 0,
            theta: theta || 0,
            vega: vega || 0,
            iv: iv || sigma,
            greeksSuspicious: true,
            greeksNote: `Market delta ${(delta||0).toFixed(3)} flagged; BSM delta ${bsmDelta.toFixed(3)} used`
        };
    }
    return { delta, gamma, theta, vega, iv, greeksSuspicious: false };
}
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const dataSource = process.env.DATA_SOURCE || 'CBOE';

    // 1. Determine Legs (Single vs Bulk)
    let legs = [];
    if (req.method === 'POST') {
        legs = req.body.legs || [];
    } else {
        const { ticker, expiration, strike, type } = req.query;
        if (ticker && expiration && strike && type) {
            legs = [{ ticker, expiration, strike, type }];
        }
    }

    if (legs.length === 0) {
        return res.status(400).json({ error: 'Missing parameters or legs' });
    }

    // 2. Process based on Data Source
    if (dataSource === 'POLYGON') {
        return await handlePolygon(legs, res);
    } else {
        return await handleCBOE(legs, res);
    }
}

async function handlePolygon(legs, res) {
    try {
        const { getOptionSnapshot } = await import('../lib/polygon-client.js');
        const results = [];

        // Concurrent fetching for Polygon (since it doesn't have a true bulk API)
        const CHUNK_SIZE = 10;
        for (let i = 0; i < legs.length; i += CHUNK_SIZE) {
            const chunk = legs.slice(i, i + CHUNK_SIZE);
            const promises = chunk.map(async (leg) => {
                const exp = normalizeExpiration(leg.expiration);
                const occ = generateOCCSymbol(leg.ticker, exp, leg.type, leg.strike);
                try {
                    const snapshot = await getOptionSnapshot(leg.ticker.toUpperCase(), occ);
                    if (snapshot) {
                        return {
                            ...leg,
                            success: true,
                            price: snapshot.last > 0 ? snapshot.last : ((snapshot.bid + snapshot.ask) / 2 || 0),
                            symbol: occ,
                            data: snapshot,
                            priceSource: snapshot.last > 0 ? 'last' : 'mid',
                            bid: snapshot.bid,
                            ask: snapshot.ask,
                            ...validateGreeks(
                                { delta: snapshot.delta, gamma: snapshot.gamma, theta: snapshot.theta, vega: snapshot.vega, iv: snapshot.iv },
                                snapshot.underlyingPrice || snapshot.underlying_price || 0,
                                parseFloat(leg.strike), snapshot.dte || 30, leg.type
                            ),
                            dataSource: 'Polygon.io'
                        };
                    }
                    return { ...leg, success: false, error: 'No snapshot data' };
                } catch (e) {
                    return { ...leg, success: false, error: e.message };
                }
            });
            results.push(...(await Promise.all(promises)));
        }

        // Response format compatibility
        if (legs.length === 1) {
            return res.status(results[0].success ? 200 : 404).json(results[0]);
        }
        return res.status(200).json({ success: true, results, timestamp: Date.now() });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}

async function handleCBOE(legs, res) {
    // For CBOE, we still have to loop individually if it's bulk
    const results = [];
    for (const leg of legs) {
        try {
            const upperTicker = leg.ticker.toUpperCase();
            const exp = normalizeExpiration(leg.expiration);
            const occSymbol = generateOCCSymbol(upperTicker, exp, leg.type, leg.strike);
            const cboeSymbol = occSymbol.replace(/\s/g, '');

            const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${upperTicker}.json`;
            const response = await fetch(cboeUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });

            if (!response.ok) {
                results.push({ ...leg, success: false, error: `CBOE Error ${response.status}` });
                continue;
            }

            const data = await response.json();
            const options = data?.data?.options || [];
            const match = options.find(opt => opt.option === cboeSymbol);

            if (match) {
                let price = match.last_trade_price;
                let source = 'last';
                if (match.bid > 0 && match.ask > 0) {
                    price = (match.bid + match.ask) / 2;
                    source = 'mid';
                }
                const underlyingPrice = data.data.current_price || 0;
                // Compute DTE from expiration string (YYYYMMDD in OCC symbol)
                const expStr = exp; // normalizeExpiration already applied
                const dteDays = expStr ? Math.max(0, Math.round((new Date(expStr).getTime() - Date.now()) / 86400000)) : 30;
                results.push({
                    ...leg,
                    success: true,
                    symbol: occSymbol,
                    price: parseFloat(price?.toFixed(2) || 0),
                    priceSource: source,
                    bid: match.bid,
                    ask: match.ask,
                    ...validateGreeks(
                        { delta: match.delta, gamma: match.gamma, theta: match.theta, vega: match.vega, iv: match.iv },
                        underlyingPrice, parseFloat(leg.strike), dteDays, leg.type
                    ),
                    underlyingPrice,
                    dataSource: 'CBOE'
                });
            } else {
                results.push({ ...leg, success: false, error: 'Option not found' });
            }
        } catch (e) {
            results.push({ ...leg, success: false, error: e.message });
        }
    }

    if (legs.length === 1) {
        return res.status(results[0].success ? 200 : 404).json(results[0]);
    }
    return res.status(200).json({ success: true, results, timestamp: Date.now() });
}
