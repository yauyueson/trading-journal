// api/cron-iv-backfill.js
// Backfill ORATS historical IV data for all watchlist tickers.
// First run: fetches 10 years of history per ticker → orats_iv_cache.
// Daily runs: only fetches tickers where cache is stale (< yesterday).
// ORATS /hist/cores returns ALL history in 1 call per ticker (no date range param).

import { getHistoricalCores } from '../lib/orats-client.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

// Same 27 tickers used by backtester + signal scanner
const SCAN_TICKERS = [
    'SPY', 'QQQ', 'GOOG', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
    'AAPL', 'NVDA', 'AMD', 'COST', 'IREN', 'BA', 'AMZN', 'HOOD',
    'CRWV', 'COIN', 'MSTR', 'PLTR', 'AVGO', 'LULU', 'UBER', 'GS',
    'UNH', 'IWM', 'GLD',
];

const DELAY_MS = 300;
const BATCH_SIZE = 500;
const YEARS_BACK = 10;

/**
 * Get the most recent cached date per ticker from orats_iv_cache.
 * Returns Map<ticker, maxDate>.
 */
async function getCacheCoverage(tickers) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return new Map();

    const coverage = new Map();

    // Query max date per ticker — Supabase REST doesn't support GROUP BY,
    // so we query each ticker's latest row (fast with PK index).
    const tickerList = tickers.map(t => `"${t}"`).join(',');
    const params = new URLSearchParams({
        select: 'ticker,date',
        ticker: `in.(${tickers.join(',')})`,
        order: 'date.desc',
        limit: '1',
    });

    // Fetch one query per ticker in parallel (batched for speed)
    const promises = tickers.map(async (ticker) => {
        try {
            const p = new URLSearchParams({
                select: 'date',
                ticker: `eq.${ticker}`,
                order: 'date.desc',
                limit: '1',
            });
            const res = await fetch(`${SUPABASE_URL}/rest/v1/orats_iv_cache?${p}`, {
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                },
            });
            if (res.ok) {
                const rows = await res.json();
                if (rows.length > 0) coverage.set(ticker, rows[0].date);
            }
        } catch { /* ignore */ }
    });

    await Promise.all(promises);
    return coverage;
}

/**
 * Upsert IV rows to Supabase cache.
 */
async function upsertBatch(rows) {
    if (!SUPABASE_URL || !SUPABASE_KEY || rows.length === 0) return 0;

    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        try {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/orats_iv_cache`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates',
                },
                body: JSON.stringify(batch),
            });
            if (res.ok) upserted += batch.length;
            else console.warn(`[iv-backfill] Upsert batch failed: ${res.status}`);
        } catch (err) {
            console.warn(`[iv-backfill] Upsert error:`, err.message);
        }
    }
    return upserted;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Auth check
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'];
    const isManual = req.query.manual === '1';
    if (cronSecret && !isManual && authHeader !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: 'Supabase not configured' });
    }

    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - YEARS_BACK);
    const cutoff = cutoffDate.toISOString().split('T')[0]; // e.g. 2016-03-07

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    // Skip weekends: if yesterday is Sunday, use Friday
    const dow = yesterday.getDay();
    if (dow === 0) yesterday.setDate(yesterday.getDate() - 2); // Sun → Fri
    if (dow === 6) yesterday.setDate(yesterday.getDate() - 1); // Sat → Fri
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    console.log(`[iv-backfill] Checking cache coverage for ${SCAN_TICKERS.length} tickers (cutoff: ${cutoff}, target: ${yesterdayStr})`);

    // 1. Check which tickers need updating
    const coverage = await getCacheCoverage(SCAN_TICKERS);
    const needsUpdate = SCAN_TICKERS.filter(t => {
        const maxDate = coverage.get(t);
        if (!maxDate) return true; // No cache at all
        return maxDate < yesterdayStr; // Stale cache
    });

    console.log(`[iv-backfill] ${needsUpdate.length}/${SCAN_TICKERS.length} tickers need update. Skipped: ${SCAN_TICKERS.length - needsUpdate.length}`);

    if (needsUpdate.length === 0) {
        return res.status(200).json({
            success: true,
            message: 'All tickers already cached',
            processed: 0,
            skipped: SCAN_TICKERS.length,
            totalUpserted: 0,
        });
    }

    // 2. Fetch and upsert each ticker
    const results = [];
    let totalUpserted = 0;

    for (let i = 0; i < needsUpdate.length; i++) {
        const ticker = needsUpdate[i];
        if (i > 0) await new Promise(r => setTimeout(r, DELAY_MS));

        try {
            console.log(`[iv-backfill] ${i + 1}/${needsUpdate.length} Fetching ${ticker}...`);
            const cores = await getHistoricalCores(ticker);

            if (!cores || cores.length === 0) {
                results.push({ ticker, status: 'no-data', rows: 0 });
                continue;
            }

            // Filter to last 10 years and extract IV fields
            const rows = cores
                .filter(c => {
                    const d = c.tradeDate || c.date;
                    return d && d >= cutoff;
                })
                .map(c => ({
                    ticker: ticker.toUpperCase(),
                    date: c.tradeDate || c.date,
                    iv30d: c.iv30d != null ? Number(c.iv30d) : null,
                    iv60d: c.iv60d != null ? Number(c.iv60d) : null,
                    hv20d: c.clsHv20d != null ? Number(c.clsHv20d) : null,
                    hv30d: c.clsHv30d != null ? Number(c.clsHv30d) : null,
                    hv60d: c.clsHv60d != null ? Number(c.clsHv60d) : null,
                }));

            const upserted = await upsertBatch(rows);
            totalUpserted += upserted;
            results.push({ ticker, status: 'ok', rows: upserted });
            console.log(`[iv-backfill] ${ticker}: ${upserted} rows cached`);
        } catch (err) {
            console.error(`[iv-backfill] ${ticker} failed:`, err.message);
            results.push({ ticker, status: 'error', error: err.message });
        }
    }

    console.log(`[iv-backfill] Done. ${totalUpserted} total rows upserted across ${needsUpdate.length} tickers`);

    return res.status(200).json({
        success: true,
        processed: needsUpdate.length,
        skipped: SCAN_TICKERS.length - needsUpdate.length,
        totalUpserted,
        results,
    });
}
