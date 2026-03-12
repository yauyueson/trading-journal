// api/live-prices.js
// Lightweight endpoint: fetch current stock prices from ORATS for multiple tickers.
// Used by the Signals tab to display live market prices alongside EOD candle-based signals.

const ORATS_BASE = 'https://api.orats.io/datav2';

export default async function handler(req, res) {
    try {
        const { tickers } = req.query;
        if (!tickers) return res.status(400).json({ error: 'Missing tickers parameter' });

        const token = process.env.ORATS_API_TOKEN;
        if (!token) return res.status(500).json({ error: 'ORATS_API_TOKEN not configured' });

        const tickerList = tickers
            .split(',')
            .map(t => t.trim().toUpperCase())
            .filter(Boolean)
            .slice(0, 50); // safety cap

        if (tickerList.length === 0) return res.status(400).json({ error: 'No valid tickers' });

        // Batch fetch from ORATS /strikes — request minimal fields + wide DTE range
        // to ensure at least one row per ticker regardless of expiration cycle.
        const params = new URLSearchParams({
            token,
            ticker: tickerList.join(','),
            fields: 'ticker,stockPrice,spotPrice',
            dte: '10,65',
        });

        const oratsRes = await fetch(`${ORATS_BASE}/strikes?${params}`);
        if (!oratsRes.ok) {
            throw new Error(`ORATS API error: ${oratsRes.status}`);
        }

        const data = await oratsRes.json();

        // Deduplicate: first row per ticker wins (they all carry the same stockPrice)
        const prices = {};
        for (const row of data.data || []) {
            const t = row.ticker;
            if (t && !prices[t]) {
                const price = row.stockPrice ?? row.spotPrice;
                if (typeof price === 'number' && price > 0) {
                    prices[t] = price;
                }
            }
        }

        // 1-minute Vercel edge cache — short TTL since these are live market prices
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
        return res.status(200).json({ prices });
    } catch (err) {
        console.error('[live-prices]', err);
        return res.status(500).json({ error: err.message || 'Failed to fetch prices' });
    }
}
