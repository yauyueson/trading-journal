// api/backfill-iv-history.js
// Backfill ticker_iv_snapshots with historical 30d Realized Volatility from MarketData.app/Polygon.io candles.
// GET /api/backfill-iv-history?ticker=SPY   → backfill one ticker
// GET /api/backfill-iv-history?mode=popular → backfill top 20 tickers (SPY, QQQ, Mag7, etc.)
// Uses same Supabase table as IV Rank; past dates get iv30 = RV (decimal).

import { createClient } from '@supabase/supabase-js';

// standard candle format: { date, open, high, low, close, volume }

const ROLLING_DAYS = 30;
// Polygon free tier: 5 req/min => 12s delay. We use 15s to be safe.
const POLYGON_DELAY_MS = 15000;

const POPULAR_TICKERS = [
    'SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'TLT', // Indices/ETFs
    'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'AMZN', 'GOOGL', 'META', 'NFLX', // Big Tech
    'COIN', 'MSTR', 'PLTR', 'HOOD', 'ROKU' // High Beta/Crypto
];

function getSupabase() {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    return { url, key };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { ticker, mode } = req.query;

    let targetTickers = [];
    if (ticker) {
        targetTickers = ticker.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
    } else if (mode === 'popular') {
        targetTickers = POPULAR_TICKERS;
    } else {
        return res.status(400).json({
            error: 'Missing params',
            usage: '?ticker=SPY,QQQ or ?mode=popular'
        });
    }

    const { url: supabaseUrl, key: supabaseKey } = getSupabase();
    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Supabase not configured' });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    const results = [];
    let getCandles;
    try {
        const polygonModule = await import('../lib/polygon-client.js');
        getCandles = polygonModule.getCandles;
    } catch (e) {
        return res.status(500).json({ error: 'Failed to import polygon-client', details: e.message });
    }

    console.log(`Starting backfill for ${targetTickers.length} tickers: ${targetTickers.join(', ')}`);

    for (let i = 0; i < targetTickers.length; i++) {
        const t = targetTickers[i];

        // Rate limit delay (skip for first one)
        if (i > 0) {
            console.log(`Waiting ${POLYGON_DELAY_MS}ms for rate limit...`);
            await sleep(POLYGON_DELAY_MS);
        }

        try {
            // 1. Calculate date range (approx 2 years to get decent history)
            const today = new Date();
            const from = new Date(today);
            from.setDate(today.getDate() - 500); // ~1.5 years

            const fromStr = from.toISOString().split('T')[0];
            const toStr = today.toISOString().split('T')[0];

            console.log(`[${i + 1}/${targetTickers.length}] Fetching ${t} candles...`);

            // 2. Fetch candles via Polygon
            const points = await getCandles(t, fromStr, toStr, 'day');

            if (!points || points.length === 0) {
                results.push({ ticker: t, status: 'skipped', reason: 'No candle data' });
                continue;
            }

            const sortedPoints = points.sort((a, b) => a.date.localeCompare(b.date));
            if (sortedPoints.length < ROLLING_DAYS + 1) {
                results.push({ ticker: t, status: 'skipped', reason: `Insufficient data (${sortedPoints.length} days)` });
                continue;
            }

            // 3. Compute RV30
            const snapshots = computeRollingRV(sortedPoints);

            // 4. Upsert - Batch by 100
            const BATCH_SIZE = 100;
            let upsertedCount = 0;
            for (let j = 0; j < snapshots.length; j += BATCH_SIZE) {
                const chunk = snapshots.slice(j, j + BATCH_SIZE);
                const rows = chunk.map(s => ({
                    ticker: t,
                    recorded_date: s.date,
                    iv30: s.rv30,
                    iv90: null, // RV30 backfill, no IV data
                }));

                const { error } = await supabase
                    .from('ticker_iv_snapshots')
                    .upsert(rows, { onConflict: 'ticker,recorded_date' });

                if (error) {
                    console.warn(`Backfill upsert failed for ${t} batch ${j}:`, error.message);
                } else {
                    upsertedCount += rows.length;
                }
            }

            console.log(`  -> Upserted ${upsertedCount} rows for ${t}`);
            results.push({ ticker: t, status: 'ok', daysBackfilled: upsertedCount });

        } catch (e) {
            console.error(`Error processing ${t}:`, e);
            results.push({ ticker: t, status: 'error', message: e.message });
        }
    }

    return res.status(200).json({ success: true, results });
}
