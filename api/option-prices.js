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
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
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
            greeksNote: `Market delta ${(delta || 0).toFixed(3)} flagged; BSM delta ${bsmDelta.toFixed(3)} used`
        };
    }
    return { delta, gamma, theta, vega, iv, greeksSuspicious: false };
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive underlying price from put-call parity: S ≈ C_mid - P_mid + K
 * Uses near-ATM options (30-60 DTE) for best accuracy.
 */
function _deriveUnderlyingFromChain(chain) {
    // Group by strike+expiration, find call/put pairs
    const pairs = {};
    for (const o of chain) {
        const exp = o.expiration || o.expiry;
        if (!o.strike || !exp) continue;
        const dte = o.dte ?? 0;
        if (dte < 7 || dte > 60) continue;
        const key = `${o.strike}_${exp}`;
        if (!pairs[key]) pairs[key] = { strike: o.strike };
        const mid = o.mid > 0 ? o.mid : (o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : 0);
        if ((o.type === 'Call' || o.type === 'call') && mid > 0) pairs[key].callMid = mid;
        if ((o.type === 'Put' || o.type === 'put') && mid > 0) pairs[key].putMid = mid;
    }

    // Collect derived prices from all valid pairs, take median for robustness
    const derivedPrices = [];
    for (const p of Object.values(pairs)) {
        if (!p.callMid || !p.putMid) continue;
        const s = p.callMid - p.putMid + p.strike;
        if (s > 0) derivedPrices.push(s);
    }

    if (derivedPrices.length < 3) return null;
    derivedPrices.sort((a, b) => a - b);
    const median = derivedPrices[Math.floor(derivedPrices.length / 2)];
    return Number(median.toFixed(2));
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const dataSource = (process.env.DATA_SOURCE || 'CBOE').trim().toUpperCase();

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
    if (dataSource === 'POLYGON' || dataSource === 'ORATS') {
        return await handleORATS(legs, res);
    } else {
        return await handleCBOE(legs, res);
    }
}

async function handleORATS(legs, res) {
    try {
        const { getOptionChain, getUnderlyingPrice } = await import('../lib/orats-client.js');

        // Group legs by ticker so we fetch one chain per ticker (2 API calls per ticker instead of N per leg)
        const tickerToLegs = new Map();
        for (const leg of legs) {
            const t = (leg.ticker || '').toUpperCase();
            if (!t) continue;
            if (!tickerToLegs.has(t)) tickerToLegs.set(t, []);
            tickerToLegs.get(t).push(leg);
        }

        const chainByTicker = new Map();
        const freshUnderlyingByTicker = new Map();
        for (const ticker of tickerToLegs.keys()) {
            const [chain, freshPrice] = await Promise.all([
                getOptionChain(ticker, {}),
                getUnderlyingPrice(ticker).catch(() => null)
            ]);
            chainByTicker.set(ticker, chain || []);
            if (freshPrice != null && freshPrice > 0) {
                freshUnderlyingByTicker.set(ticker, freshPrice);
            } else if (chain && chain.length > 0) {
                // Fallback: derive underlying from put-call parity when stock snapshot is unavailable
                const pcpPrice = _deriveUnderlyingFromChain(chain);
                if (pcpPrice != null) {
                    freshUnderlyingByTicker.set(ticker, pcpPrice);
                }
            }
        }

        // Resolve each leg from the chain for its ticker (match by expiration, strike, type)
        const results = [];
        for (const leg of legs) {
            const ticker = (leg.ticker || '').toUpperCase();
            const chain = chainByTicker.get(ticker) || [];
            const exp = normalizeExpiration(leg.expiration);
            const strikeNum = parseFloat(leg.strike);
            const typeNorm = (leg.type || '').toLowerCase().includes('put') ? 'Put' : 'Call';

            const option = chain.find(
                (o) =>
                    (o.expiration === exp || (o.expiration && o.expiration.slice(0, 10) === exp)) &&
                    Number(o.strike) === strikeNum &&
                    (o.type === typeNorm || (o.type && o.type.toLowerCase().includes(typeNorm.toLowerCase())))
            );

            if (option) {
                // Prefer mid (live bid/ask) over stale last trade price.
                // option.mid is computed in normalizePolygonOption from live bid/ask.
                const mid = option.mid || ((option.bid > 0 && option.ask > 0) ? (option.bid + option.ask) / 2 : 0);
                const price = mid > 0 ? mid : (option.last > 0 ? option.last : 0);
                const priceSource = mid > 0 ? 'mid' : (option.last > 0 ? 'last' : 'none');

                // Use fresh underlying price from stock snapshot (more reliable than options snapshot)
                const freshUnderlying = freshUnderlyingByTicker.get(ticker);
                const underlyingPrice = freshUnderlying || option.underlyingPrice || 0;

                results.push({
                    ...leg,
                    success: true,
                    price,
                    symbol: option.symbol || generateOCCSymbol(leg.ticker, exp, leg.type, leg.strike),
                    data: { ...option, mid, underlyingPrice },
                    priceSource,
                    bid: option.bid,
                    ask: option.ask,
                    underlyingPrice,
                    ...validateGreeks(
                        { delta: option.delta, gamma: option.gamma, theta: option.theta, vega: option.vega, iv: option.iv },
                        underlyingPrice,
                        strikeNum,
                        option.dte || 30,
                        leg.type
                    ),
                    dataSource: 'ORATS'
                });
            } else {
                results.push({ ...leg, success: false, error: 'Option not found in chain' });
            }
        }

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
