// api/option-prices-bulk.js
// Bulk Fetcher for Options
// Accepts a list of option descriptors, returns map of data.

import { generateOCCSymbol, normalizeExpiration } from '../lib/_shared/utils.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { legs } = req.body; // Expecting { legs: [{ ticker, expiration, strike, type, id }] }
    // 'id' is optional, useful for mapping back to position ID on frontend

    if (!legs || !Array.isArray(legs) || legs.length === 0) {
        return res.status(400).json({ error: 'Missing or empty "legs" array' });
    }

    const dataSource = process.env.DATA_SOURCE || 'CBOE';

    // Group by source (Polygon vs CBOE)
    // Polygon doesn't support true bulk in one call like MarketData did
    // We need to make concurrent individual requests

    if (dataSource !== 'POLYGON') {
        // Fallback: This endpoint is primarily for optimization.
        // If stuck on CBOE, frontend should probably assume legacy behavior or we loop here.
        // For now, let's just return error or implement loop.
        // Implementing loop to keep frontend logic simple.
        return await handleCBOEBulk(legs, res);
    }

    try {
        const { getOptionSnapshot } = await import('../lib/polygon-client.js');

        // 1. Build request map
        const requestMap = new Map(); // occ -> { underlying, legs[] }

        legs.forEach(leg => {
            const exp = normalizeExpiration(leg.expiration);
            const occ = generateOCCSymbol(leg.ticker, exp, leg.type, leg.strike);
            if (occ) {
                if (!requestMap.has(occ)) {
                    requestMap.set(occ, {
                        underlying: leg.ticker.toUpperCase(),
                        occ: occ,
                        legs: []
                    });
                }
                requestMap.get(occ).legs.push(leg);
            }
        });

        if (requestMap.size === 0) {
            return res.json({ success: true, results: [] });
        }

        // 2. Fetch in chunks (Polygon doesn't support bulk, need concurrent individual calls)
        console.log(`[Bulk] Fetching ${requestMap.size} symbols via Polygon.io...`);
        const CHUNK_SIZE = 10;
        const entries = Array.from(requestMap.values());
        const results = [];

        for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
            const chunk = entries.slice(i, i + CHUNK_SIZE);

            const promises = chunk.map(async ({ underlying, occ, legs: reqLegs }) => {
                try {
                    const snapshot = await getOptionSnapshot(underlying, occ);

                    if (snapshot) {
                        // Map to all requesting legs
                        return reqLegs.map(reqLeg => ({
                            ...reqLeg,
                            price: snapshot.last > 0 ? snapshot.last : ((snapshot.bid + snapshot.ask) / 2 || 0),
                            data: snapshot,
                            success: true
                        }));
                    } else {
                        return reqLegs.map(reqLeg => ({
                            ...reqLeg,
                            success: false,
                            error: 'No snapshot data'
                        }));
                    }
                } catch (e) {
                    console.error(`Error fetching ${occ}:`, e.message);
                    return reqLegs.map(reqLeg => ({
                        ...reqLeg,
                        success: false,
                        error: e.message
                    }));
                }
            });

            const chunkResults = await Promise.all(promises);
            chunkResults.forEach(legResults => {
                if (Array.isArray(legResults)) {
                    results.push(...legResults);
                }
            });
        }

        return res.status(200).json({
            success: true,
            count: results.length,
            results,
            timestamp: Date.now()
        });

    } catch (error) {
        console.error("Bulk Fetch Error:", error);
        return res.status(500).json({ error: error.message });
    }
}

async function handleCBOEBulk(legs, res) {
    // Loop CBOE calls (Slow, but maintains interface)
    // Warning: High chance of timeout or rate limit
    console.warn("[Bulk] CBOE Bulk requested - Looping individually (Slow)");

    const results = [];
    const limit = 5; // Concurrency limit

    // Chunking
    for (let i = 0; i < legs.length; i += limit) {
        const chunk = legs.slice(i, i + limit);
        const promises = chunk.map(async (leg) => {
            try {
                // Internal fetch to own API (or direct logic)
                // Using direct fetch logic would be better to avoid HTTP overhead
                // But for now, let's just use the existing handler logic if possible?
                // Importing handler from option-price.js is tricky due to default export.
                // Better to just URL fetch internal API or reuse logic?
                // Let's assume URL fetch for simplicity of implementation here.

                // Construct URL for option-price
                const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
                const host = process.env.VERCEL_URL || 'localhost:3000';
                const baseUrl = `${protocol}://${host}`;

                const params = new URLSearchParams({
                    ticker: leg.ticker,
                    expiration: normalizeExpiration(leg.expiration),
                    strike: leg.strike,
                    type: leg.type
                });

                const resp = await fetch(`${baseUrl}/api/option-price?${params}`);
                const data = await resp.json();

                return {
                    ...leg,
                    price: data.price,
                    data: data, // returns formatted object
                    success: resp.ok
                };
            } catch (e) {
                console.error("CBOE Loop Error:", e);
                return { ...leg, success: false, error: e.message };
            }
        });

        const chunkRes = await Promise.all(promises);
        results.push(...chunkRes);
    }

    return res.status(200).json({
        success: true,
        count: results.length,
        results,
        timestamp: Date.now()
    });
}
