// api/option-prices.js
// Universal Fetcher for Options (Single or Bulk)
// Supports GET (query params) for single leg and POST (body) for bulk.

import { generateOCCSymbol, normalizeExpiration } from '../lib/_shared/utils.js';

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
                            iv: snapshot.iv,
                            delta: snapshot.delta,
                            gamma: snapshot.gamma,
                            theta: snapshot.theta,
                            vega: snapshot.vega,
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
                results.push({
                    ...leg,
                    success: true,
                    symbol: occSymbol,
                    price: parseFloat(price?.toFixed(2) || 0),
                    priceSource: source,
                    bid: match.bid,
                    ask: match.ask,
                    iv: match.iv,
                    delta: match.delta,
                    gamma: match.gamma,
                    theta: match.theta,
                    vega: match.vega,
                    underlyingPrice: data.data.current_price,
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
