// api/option-prices-bulk.js
// Bulk Fetcher for Options
// Accepts a list of option descriptors, returns map of data.

import { generateOCCSymbol, normalizeExpiration } from './_shared/utils.js';

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

    // Group by source (MarketData vs CBOE)
    // Currently only MarketData supports true bulk efficiently via this endpoint's design
    // But we can fallback to parallel fetch for CBOE if needed (though dangerous for rate limits)

    if (dataSource !== 'MARKET_DATA') {
        // Fallback: This endpoint is primarily for MarketData optimization.
        // If stuck on CBOE, frontend should probably assume legacy behavior or we loop here.
        // For now, let's just return error or implement loop.
        // Implementing loop to keep frontend logic simple.
        return await handleCBOEBulk(legs, res);
    }

    try {
        const { getQuotes } = await import('./market-data-client.js');

        // 1. Generate OCC Symbols
        const symbolMap = new Map(); // occ -> [legParams...] (one OCC might be used by multiple positions?)
        const occList = [];

        legs.forEach(leg => {
            const exp = normalizeExpiration(leg.expiration);
            const occ = generateOCCSymbol(leg.ticker, exp, leg.type, leg.strike);
            if (occ) {
                if (!symbolMap.has(occ)) {
                    symbolMap.set(occ, []);
                    occList.push(occ);
                }
                symbolMap.get(occ).push(leg);
            }
        });

        if (occList.length === 0) {
            return res.json({ success: true, results: [] });
        }

        // 2. Fetch Bulk
        console.log(`[Bulk] Fetching ${occList.length} symbols via MarketData...`);
        const quotes = await getQuotes(occList);

        // 3. Map Results
        const results = [];

        // quotes is array of normalized option objects
        quotes.forEach(quote => {
            // Find request legs matching this quote
            // MarketData quote has 'symbol' which matches our OCC (hopefully)
            // But we can also match by attributes if needed.
            // normalizeOption returns 'symbol' as OCC found in API.

            // Try direct match
            const occ = quote.symbol;
            const requests = symbolMap.get(occ);

            if (requests) {
                requests.forEach(reqLeg => {
                    results.push({
                        ...reqLeg, // include original identifying info (id, etc)
                        price: quote.last > 0 ? quote.last : (quote.mid > 0 ? quote.mid : 0),
                        data: quote,
                        success: true
                    });
                });
                symbolMap.delete(occ); // Mark handled
            }
        });

        // Handle missing/failed
        symbolMap.forEach((requests, occ) => {
            requests.forEach(reqLeg => {
                results.push({
                    ...reqLeg,
                    success: false,
                    error: 'Not found'
                });
            });
        });

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
