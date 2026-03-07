// api/backtest-candles.js
// Fetch extended candle history for backtesting.
// Priority: Supabase stock_candles cache → Tiingo API fallback.

import { getCandles } from '../lib/tiingo-client.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

/**
 * Try to load candles from Supabase stock_candles table.
 * Returns candles array or null if table doesn't exist / no data.
 */
async function getCachedCandles(ticker, from, to, timeframe = '1D') {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;

    try {
        const params = new URLSearchParams({
            select: 'date,open,high,low,close,volume',
            ticker: `eq.${ticker.toUpperCase()}`,
            timeframe: `eq.${timeframe}`,
            date: `gte.${from}`,
            order: 'date.asc',
            limit: '5000',  // Supabase REST default cap is 1000; backtest needs 2000+ bars
        });
        if (to) params.append('date', `lte.${to}`);

        // Use REST API (no JS client dependency in API routes)
        const url = `${SUPABASE_URL}/rest/v1/stock_candles?${params}`;
        const res = await fetch(url, {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
        });

        if (!res.ok) return null;

        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) return null;

        // Normalize to match expected candle shape
        return rows.map(r => ({
            timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
            date: r.date,
            open: Number(r.open),
            high: Number(r.high),
            low: Number(r.low),
            close: Number(r.close),
            volume: Number(r.volume),
        }));
    } catch (err) {
        console.warn('[backtest-candles] Supabase cache lookup failed:', err.message);
        return null;
    }
}

export default async function handler(req, res) {
    try {
        const { ticker, from, to, timeframe } = req.query;

        if (!ticker) {
            return res.status(400).json({ error: 'Missing ticker parameter' });
        }

        const endDate = to || new Date().toISOString().split('T')[0];
        const startDate = from || (() => {
            const d = new Date();
            d.setFullYear(d.getFullYear() - 2);
            d.setMonth(d.getMonth() - 6);
            return d.toISOString().split('T')[0];
        })();

        const tf = timeframe || '1D';
        let candles = null;
        let source = 'tiingo';

        // Try Supabase cache first (daily only)
        if (tf === '1D') {
            candles = await getCachedCandles(ticker, startDate, endDate, tf);
            if (candles && candles.length > 0) {
                source = 'cache';
                console.log(`[backtest-candles] ${ticker}: ${candles.length} candles from Supabase cache`);
            }
        }

        // Fallback to Tiingo
        if (!candles || candles.length === 0) {
            const timespan = tf === '4H' ? 'hour' : 'day';
            const multiplier = tf === '4H' ? 4 : 1;
            candles = await getCandles(ticker.toUpperCase(), startDate, endDate, timespan, multiplier);
            source = 'tiingo';
        }

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
        return res.status(200).json({
            success: true,
            ticker: ticker.toUpperCase(),
            from: startDate,
            to: endDate,
            timeframe: tf,
            count: candles.length,
            source,
            candles,
        });
    } catch (err) {
        console.error('[backtest-candles]', err);
        return res.status(500).json({ error: err.message || 'Failed to fetch candles' });
    }
}
