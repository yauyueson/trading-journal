// api/backfill-iv-history.js
// Backfill ticker_iv_snapshots with historical 30d Realized Volatility from MarketData.app candles.
// GET /api/backfill-iv-history?ticker=SPY   → backfill one ticker
// GET /api/backfill-iv-history?ticker=SPY,QQQ,AAPL → backfill multiple
// Uses same Supabase table as IV Rank; past dates get iv30 = RV (decimal).

import { getCandles } from './market-data-client.js';

const ROLLING_DAYS = 30;

function getSupabase() {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    return { url, key };
}

async function fetchAllHistorical(ticker) {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - 400); // sufficient buffer for ~252 trading days

    const fromStr = fromDate.toISOString().split('T')[0];
    const toStr = toDate.toISOString().split('T')[0];

    // standard candle format: { date, open, high, low, close, volume }
    const candles = await getCandles(ticker, fromStr, toStr, 'D');

    // Sort just in case, though API usually returns sorted
    return candles.sort((a, b) => a.date.localeCompare(b.date));
}

function computeRollingRV(sortedPoints, rollingDays = ROLLING_DAYS) {
    const results = [];
    if (!sortedPoints || sortedPoints.length < rollingDays + 1) return results;

    for (let i = rollingDays; i < sortedPoints.length; i++) {
        const window = sortedPoints.slice(i - rollingDays, i + 1);
        const prices = window.map((p) => p.close);
        const returns = [];
        for (let j = 1; j < prices.length; j++) {
            returns.push(Math.log(prices[j] / prices[j - 1]));
        }

        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
        const std = Math.sqrt(variance);
        const annualized = std * Math.sqrt(252);

        results.push({
            date: window[window.length - 1].date,
            rv30: annualized
        });
    }
    return results;
}

async function upsertSnapshots(supabaseUrl, supabaseKey, ticker, snapshots) {
    const tickerUpper = ticker.toUpperCase();
    // Batch upsert could be optimized, but doing sequential for simplicity/safety
    // or we can Promise.all chunks. Let's do sequential for now to avoid rate limits if any on Supabase
    // Actually Supabase handles concurrent requests well. Let's do batches of 50.

    const BATCH_SIZE = 50;
    for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
        const chunk = snapshots.slice(i, i + BATCH_SIZE);
        const rows = chunk.map(s => ({
            ticker: tickerUpper,
            recorded_date: s.date,
            iv30: s.rv30,
            iv90: null,
        }));

        try {
            await fetch(`${supabaseUrl}/rest/v1/ticker_iv_snapshots`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates,on_conflict=ticker,recorded_date',
                },
                body: JSON.stringify(rows),
            });
        } catch (e) {
            console.warn('Backfill batch upsert failed for', ticker, chunk[0].date, e.message);
        }
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { ticker } = req.query;
    if (!ticker) return res.status(400).json({ error: 'Missing ticker (e.g. ?ticker=SPY or ?ticker=SPY,QQQ,AAPL)' });

    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) {
        return res.status(400).json({
            error: 'Polygon API token not set',
            message: 'Set POLYGON_API_KEY in environment',
            ticker: ticker.toUpperCase()
        });
    }

    const { url: supabaseUrl, key: supabaseKey } = getSupabase();
    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Supabase not configured (SUPABASE_URL / SUPABASE_ANON_KEY)' });
    }

    const tickers = ticker.split(',').map((t) => t.trim()).filter(Boolean);
    const results = [];

    for (const t of tickers) {
        try {
            const { getCandles } = await import('./polygon-client.js');

            // 2. Calculate date range
            const today = new Date();
            const from = new Date(today);
            from.setDate(today.getDate() - 400); // sufficient buffer for ~252 trading days, adjusted from 60 to match original intent

            const fromStr = from.toISOString().split('T')[0];
            const toStr = today.toISOString().split('T')[0];

            console.log(`Fetching candles for ${t} from ${fromStr} to ${toStr}...`);

            // 3. Fetch candles via Polygon
            const points = await getCandles(t, fromStr, toStr, 'day'); // Renamed 'candles' to 'points' to match original variable name for RV calculation

            if (!points || points.length === 0) {
                const reason = points === null
                    ? 'No candle data (check POLYGON_API_KEY and Polygon API / network)'
                    : `Need ${ROLLING_DAYS + 1}+ days, got ${points.length}`;
                results.push({ ticker: t.toUpperCase(), status: 'skipped', reason });
                continue;
            }
            // Sort just in case, though API usually returns sorted
            const sortedPoints = points.sort((a, b) => a.date.localeCompare(b.date));

            if (sortedPoints.length < ROLLING_DAYS + 1) {
                const reason = `Need ${ROLLING_DAYS + 1}+ days, got ${sortedPoints.length}`;
                results.push({ ticker: t.toUpperCase(), status: 'skipped', reason });
                continue;
            }

            const snapshots = computeRollingRV(sortedPoints);
            await upsertSnapshots(supabaseUrl, supabaseKey, t, snapshots);
            results.push({ ticker: t.toUpperCase(), status: 'ok', daysBackfilled: snapshots.length });
        } catch (e) {
            console.error(e);
            results.push({ ticker: t.toUpperCase(), status: 'error', message: e.message });
        }
    }

    return res.status(200).json({ success: true, results });
}
