// api/live-prices.js
// Lightweight endpoint: fetch current stock prices from Tiingo IEX for multiple tickers.
// Used by the Signals tab to display live market prices alongside EOD candle-based signals.
// Tiingo IEX supports batch queries (1 API call for all tickers) and returns real-time prices.

const TIINGO_BASE = 'https://api.tiingo.com';

export default async function handler(req, res) {
    try {
        const { tickers } = req.query;
        if (!tickers) return res.status(400).json({ error: 'Missing tickers parameter' });

        const token = process.env.TIINGO_API_TOKEN;
        if (!token) return res.status(500).json({ error: 'TIINGO_API_TOKEN not configured' });

        const tickerList = tickers
            .split(',')
            .map(t => t.trim().toUpperCase())
            .filter(Boolean)
            .slice(0, 50); // safety cap

        if (tickerList.length === 0) return res.status(400).json({ error: 'No valid tickers' });

        // Tiingo IEX endpoint: real-time prices during market hours, last close after hours.
        // Single call for all tickers, returns 1 row per ticker.
        const url = `${TIINGO_BASE}/iex/?tickers=${tickerList.join(',')}&token=${token}`;

        const tiingoRes = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
        });
        if (!tiingoRes.ok) {
            throw new Error(`Tiingo API error: ${tiingoRes.status}`);
        }

        const data = await tiingoRes.json();

        const prices = {};
        for (const row of data) {
            const t = (row.ticker || '').toUpperCase();
            if (t && !prices[t]) {
                // tngoLast = last traded price; last = IEX last; close = EOD close fallback
                const price = row.tngoLast ?? row.last ?? row.close;
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
