// api/backtest-data.js
// Unified backtest data endpoint.
// ?type=candles — fetch extended candle history (Supabase cache → Tiingo)
// ?type=iv      — fetch ORATS historical IV data (Supabase cache → ORATS)

import { getCandles } from '../lib/tiingo-client.js';
import { getHistoricalCores } from '../lib/orats-client.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Candles ──────────────────────────────────────────────────────────────────

async function getCachedCandles(ticker, from, to, timeframe = '1D') {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    try {
        const params = new URLSearchParams({
            select: 'date,open,high,low,close,volume',
            ticker: `eq.${ticker.toUpperCase()}`,
            timeframe: `eq.${timeframe}`,
            date: `gte.${from}`,
            order: 'date.asc',
            limit: '5000',
        });
        if (to) params.append('date', `lte.${to}`);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/stock_candles?${params}`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
        });
        if (!res.ok) return null;
        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) return null;
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
        console.warn('[backtest-data/candles] Cache lookup failed:', err.message);
        return null;
    }
}

async function handleCandles(req, res) {
    const { ticker, from, to, timeframe } = req.query;
    if (!ticker) return res.status(400).json({ error: 'Missing ticker parameter' });

    const endDate = to || new Date().toISOString().split('T')[0];
    const startDate = from || (() => {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 2);
        d.setMonth(d.getMonth() - 6);
        return d.toISOString().split('T')[0];
    })();
    const tf = timeframe || '1D';

    const msPerDay = 86400000;
    const rangeDays = (new Date(endDate) - new Date(startDate)) / msPerDay;
    const minExpected = Math.floor(rangeDays * 0.65);

    let candles = null;
    let source = 'tiingo';

    if (tf === '1D') {
        candles = await getCachedCandles(ticker, startDate, endDate, tf);
        if (candles && candles.length > 0) {
            if (candles.length >= minExpected) {
                source = 'cache';
                console.log(`[backtest-data/candles] ${ticker}: ${candles.length} candles from cache`);
            } else {
                console.log(`[backtest-data/candles] ${ticker}: cache has ${candles.length} but expected ~${minExpected} — falling back to Tiingo`);
                candles = null;
            }
        }
    }

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
}

// ── IV ────────────────────────────────────────────────────────────────────────

async function getCachedIV(ticker, from, to) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    try {
        const params = new URLSearchParams({
            select: 'date,iv30d,iv60d,hv20d,hv30d,hv60d',
            ticker: `eq.${ticker.toUpperCase()}`,
            date: `gte.${from}`,
            order: 'date.asc',
            limit: '10000',
        });
        if (to) params.append('date', `lte.${to}`);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/orats_iv_cache?${params}`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
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
        console.warn('[backtest-data/iv] Cache lookup failed:', err.message);
        return null;
    }
}

async function cacheIVRows(ticker, rows) {
    const key = SUPABASE_SERVICE || SUPABASE_KEY;
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
            console.warn('[backtest-data/iv] Cache upsert failed:', err.message);
        }
    }
}

async function handleIV(req, res) {
    const { ticker, from, to } = req.query;
    if (!ticker) return res.status(400).json({ error: 'Missing ticker parameter' });

    const endDate = to || new Date().toISOString().split('T')[0];
    const startDate = from || (() => {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 2);
        return d.toISOString().split('T')[0];
    })();

    let iv = await getCachedIV(ticker, startDate, endDate);
    let source = 'orats';

    if (iv && iv.length > 0) {
        source = 'cache';
        console.log(`[backtest-data/iv] ${ticker}: ${iv.length} IV rows from cache`);
    } else {
        const cores = await getHistoricalCores(ticker);
        iv = (cores || [])
            .filter(c => {
                const d = c.tradeDate || c.date;
                return d && d >= startDate && (!endDate || d <= endDate);
            })
            .map(c => ({
                date: c.tradeDate || c.date,
                iv30d: c.iv30d != null ? Number(c.iv30d) : null,
                iv60d: c.iv60d != null ? Number(c.iv60d) : null,
                hv20d: c.clsHv20d != null ? Number(c.clsHv20d) : null,
                hv30d: c.clsHv30d != null ? Number(c.clsHv30d) : null,
                hv60d: c.clsHv60d != null ? Number(c.clsHv60d) : null,
            }));
        console.log(`[backtest-data/iv] ${ticker}: ${iv.length} IV rows from ORATS`);
        if (iv.length > 0) cacheIVRows(ticker, iv).catch(() => {});
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
}

// ── Router ────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    try {
        const { type } = req.query;
        if (type === 'iv') return handleIV(req, res);
        if (!type || type === 'candles') return handleCandles(req, res);
        return res.status(400).json({ error: `Unknown type "${type}". Use candles or iv.` });
    } catch (err) {
        console.error('[backtest-data]', err);
        return res.status(500).json({ error: err.message || 'Internal error' });
    }
}
