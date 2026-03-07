// api/backtest-iv.js
// Fetch ORATS historical IV data for backtesting.
// Priority: Supabase orats_iv_cache → ORATS API fallback.

import { getHistoricalCores } from '../lib/orats-client.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Load cached IV data from Supabase orats_iv_cache.
 */
async function getCachedIV(ticker, from, to) {
    if (!SUPABASE_URL || !SUPABASE_ANON) return null;

    try {
        const params = new URLSearchParams({
            select: 'date,iv30d,iv60d,hv20d,hv30d,hv60d',
            ticker: `eq.${ticker.toUpperCase()}`,
            date: `gte.${from}`,
            order: 'date.asc',
        });
        if (to) params.append('date', `lte.${to}`);

        const url = `${SUPABASE_URL}/rest/v1/orats_iv_cache?${params}`;
        const res = await fetch(url, {
            headers: {
                'apikey': SUPABASE_ANON,
                'Authorization': `Bearer ${SUPABASE_ANON}`,
            },
        });

        if (!res.ok) return null;

        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) return null;

        return rows.map(r => ({
            date: r.date,
            iv30d: r.iv30d != null ? Number(r.iv30d) : null,
            iv60d: r.iv60d != null ? Number(r.iv60d) : null,
            hv20d: r.hv20d != null ? Number(r.hv20d) : null,
            hv30d: r.hv30d != null ? Number(r.hv30d) : null,
            hv60d: r.hv60d != null ? Number(r.hv60d) : null,
        }));
    } catch (err) {
        console.warn('[backtest-iv] Cache lookup failed:', err.message);
        return null;
    }
}

/**
 * Fetch historical cores from ORATS and extract IV fields.
 */
async function fetchORATSIV(ticker, from, to) {
    // getHistoricalCores returns all history when tradeDate is omitted.
    // For date-range filtering, we fetch all and filter client-side
    // (ORATS /hist/cores doesn't support date ranges natively).
    const cores = await getHistoricalCores(ticker);
    if (!cores || cores.length === 0) return [];

    return cores
        .filter(c => {
            const d = c.tradeDate || c.date;
            return d && d >= from && (!to || d <= to);
        })
        .map(c => ({
            date: c.tradeDate || c.date,
            iv30d: c.iv30d != null ? Number(c.iv30d) : null,
            iv60d: c.iv60d != null ? Number(c.iv60d) : null,
            hv20d: c.clsHv20d != null ? Number(c.clsHv20d) : null,
            hv30d: c.clsHv30d != null ? Number(c.clsHv30d) : null,
            hv60d: c.clsHv60d != null ? Number(c.clsHv60d) : null,
        }));
}

/**
 * Upsert IV rows to Supabase cache (fire-and-forget).
 */
async function cacheIVRows(ticker, rows) {
    const key = SUPABASE_SERVICE || SUPABASE_ANON;
    if (!SUPABASE_URL || !key || rows.length === 0) return;

    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map(r => ({
            ticker: ticker.toUpperCase(),
            date: r.date,
            iv30d: r.iv30d,
            iv60d: r.iv60d,
            hv20d: r.hv20d,
            hv30d: r.hv30d,
            hv60d: r.hv60d,
        }));

        try {
            await fetch(`${SUPABASE_URL}/rest/v1/orats_iv_cache`, {
                method: 'POST',
                headers: {
                    'apikey': key,
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates',
                },
                body: JSON.stringify(batch),
            });
        } catch (err) {
            console.warn('[backtest-iv] Cache upsert failed:', err.message);
        }
    }
}

export default async function handler(req, res) {
    try {
        const { ticker, from, to } = req.query;

        if (!ticker) {
            return res.status(400).json({ error: 'Missing ticker parameter' });
        }

        const endDate = to || new Date().toISOString().split('T')[0];
        const startDate = from || (() => {
            const d = new Date();
            d.setFullYear(d.getFullYear() - 2);
            return d.toISOString().split('T')[0];
        })();

        let iv = null;
        let source = 'orats';

        // Try cache first
        iv = await getCachedIV(ticker, startDate, endDate);
        if (iv && iv.length > 0) {
            source = 'cache';
            console.log(`[backtest-iv] ${ticker}: ${iv.length} IV rows from cache`);
        }

        // Fallback to ORATS API
        if (!iv || iv.length === 0) {
            iv = await fetchORATSIV(ticker, startDate, endDate);
            source = 'orats';
            console.log(`[backtest-iv] ${ticker}: ${iv.length} IV rows from ORATS`);

            // Cache for next time (fire-and-forget)
            if (iv.length > 0) {
                cacheIVRows(ticker, iv).catch(() => {});
            }
        }

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
        return res.status(200).json({
            success: true,
            ticker: ticker.toUpperCase(),
            from: startDate,
            to: endDate,
            count: iv.length,
            source,
            iv,
        });
    } catch (err) {
        console.error('[backtest-iv]', err);
        return res.status(500).json({ error: err.message || 'Failed to fetch IV data' });
    }
}
