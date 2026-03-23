// api/backtest-data.js
// Unified backtest data endpoint.
// ?type=candles — fetch extended candle history (Supabase cache → Tiingo)
// ?type=iv      — fetch ORATS historical IV data (Supabase cache → ORATS)

import { getCandles, getIntradayCandles, getIntraday5MinCandles } from '../lib/tiingo-client.js';
import { getHistoricalCores } from '../lib/orats-client.js';

// ── 4H Aggregator ────────────────────────────────────────────────────────────
// Mirrors the `candles_4h` SQLite view: group 1H bars by (date, hour/4) into
// two blocks per day:
//   Block 2: hours 9-11 (morning session, ~09:30–13:30 ET)
//   Block 3: hours 12-15 (afternoon session, ~13:30–16:00 ET)

function aggregate1HTo4H(hourlyCandles) {
    if (!hourlyCandles || hourlyCandles.length === 0) return [];

    // Group by (date, block)
    const groups = new Map();
    for (const c of hourlyCandles) {
        const block = Math.floor(c.hour / 4);
        const key = `${c.date}|${block}`;
        if (!groups.has(key)) {
            groups.set(key, { date: c.date, block, candles: [] });
        }
        groups.get(key).candles.push(c);
    }

    // Reduce each group to a single 4H bar
    const bars = [];
    for (const [, group] of groups) {
        const sorted = group.candles.sort((a, b) => a.timestamp - b.timestamp);
        if (sorted.length === 0) continue;
        bars.push({
            timestamp: sorted[0].timestamp,
            datetime: sorted[0].datetime,
            date: group.date,
            block: group.block,
            open: sorted[0].open,
            high: Math.max(...sorted.map(c => c.high)),
            low: Math.min(...sorted.map(c => c.low)),
            close: sorted[sorted.length - 1].close,
            volume: sorted.reduce((sum, c) => sum + c.volume, 0),
        });
    }

    return bars.sort((a, b) => a.timestamp - b.timestamp);
}

// ── 130M Aggregator ──────────────────────────────────────────────────────────
// Group 5-min bars into 3 × 130-minute blocks per trading day (9:30–16:00 ET):
//   Block 0: 09:30–11:40 (26 five-min bars)
//   Block 1: 11:40–13:50 (26 five-min bars)
//   Block 2: 13:50–16:00 (26 five-min bars)

function aggregate5MinTo130M(bars5min) {
    if (!bars5min || bars5min.length === 0) return [];

    const groups = new Map();
    for (const c of bars5min) {
        const minutesSince930 = (c.hour * 60 + c.minute) - 570; // 570 = 9:30 in minutes
        if (minutesSince930 < 0) continue; // pre-market
        const block = Math.min(Math.floor(minutesSince930 / 130), 2);
        const key = `${c.date}|${block}`;
        if (!groups.has(key)) {
            groups.set(key, { date: c.date, block, candles: [] });
        }
        groups.get(key).candles.push(c);
    }

    const bars = [];
    for (const [, group] of groups) {
        const sorted = group.candles.sort((a, b) => a.timestamp - b.timestamp);
        if (sorted.length === 0) continue;
        bars.push({
            timestamp: sorted[0].timestamp,
            datetime: sorted[0].datetime,
            date: group.date,
            block: group.block,
            open: sorted[0].open,
            high: Math.max(...sorted.map(c => c.high)),
            low: Math.min(...sorted.map(c => c.low)),
            close: sorted[sorted.length - 1].close,
            volume: sorted.reduce((sum, c) => sum + c.volume, 0),
        });
    }

    return bars.sort((a, b) => a.timestamp - b.timestamp);
}

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

// ── 130M Cache Helpers ───────────────────────────────────────────────────────
// Stores 3 bars/day using timeframe='130M_0','130M_1','130M_2' to fit
// into the PK (ticker, date, timeframe) without schema changes.

async function getCached130MCandles(ticker, from, to) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    try {
        const params = new URLSearchParams({
            select: 'date,open,high,low,close,volume,timeframe',
            ticker: `eq.${ticker.toUpperCase()}`,
            timeframe: 'in.(130M_0,130M_1,130M_2)',
            date: `gte.${from}`,
            order: 'date.asc,timeframe.asc',
            limit: '400',
        });
        if (to) params.append('date', `lte.${to}`);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/stock_candles?${params}`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
        });
        if (!res.ok) return null;
        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) return null;
        return rows.map(r => {
            const block = parseInt(r.timeframe.split('_')[1], 10);
            return {
                timestamp: new Date(r.date + 'T00:00:00Z').getTime() + block * 130 * 60000,
                date: r.date,
                block,
                open: Number(r.open),
                high: Number(r.high),
                low: Number(r.low),
                close: Number(r.close),
                volume: Number(r.volume),
            };
        });
    } catch (err) {
        console.warn('[backtest-data/130M] Cache lookup failed:', err.message);
        return null;
    }
}

async function cache130MCandles(ticker, bars) {
    const key = SUPABASE_SERVICE || SUPABASE_KEY;
    if (!SUPABASE_URL || !key || bars.length === 0) return;
    const BATCH = 500;
    for (let i = 0; i < bars.length; i += BATCH) {
        const batch = bars.slice(i, i + BATCH).map(b => ({
            ticker: ticker.toUpperCase(),
            date: b.date,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: Math.round(b.volume),
            timeframe: `130M_${b.block}`,
        }));
        try {
            const r = await fetch(`${SUPABASE_URL}/rest/v1/stock_candles`, {
                method: 'POST',
                headers: {
                    'apikey': key,
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates',
                },
                body: JSON.stringify(batch),
            });
            if (!r.ok) console.warn(`[backtest-data/130M] Cache upsert batch failed: HTTP ${r.status}`);
        } catch (err) {
            console.warn('[backtest-data/130M] Cache upsert failed:', err.message);
        }
    }
}

// Paginated 5-min fetch to work within Tiingo IEX 2000-tick limit.
// Splits date range into 30-day chunks (~1,950 ticks each at 5min freq).
async function fetchPaginated5Min(ticker, startDate, endDate) {
    const CHUNK_DAYS = 30;
    const allBars = [];
    let cs = new Date(startDate + 'T12:00:00Z');
    const end = new Date(endDate + 'T12:00:00Z');
    while (cs <= end) {
        const ce = new Date(Math.min(cs.getTime() + (CHUNK_DAYS - 1) * 86400000, end.getTime()));
        const bars = await getIntraday5MinCandles(
            ticker.toUpperCase(),
            cs.toISOString().slice(0, 10),
            ce.toISOString().slice(0, 10)
        );
        allBars.push(...bars);
        cs = new Date(ce.getTime() + 86400000);
    }
    return allBars;
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

    // ── 130M path: cache-first with paginated backfill ──
    if (tf === '130M' && (!candles || candles.length === 0)) {
        // Try Supabase cache first
        candles = await getCached130MCandles(ticker, startDate, endDate);
        if (candles && candles.length > 0) {
            // Check if cache covers up to today — top up if stale
            const lastCachedDate = candles[candles.length - 1].date;
            const today = new Date().toISOString().split('T')[0];
            if (lastCachedDate < today) {
                // Top up: fetch only missing days (well under 2000-tick limit)
                const d = new Date(lastCachedDate + 'T12:00:00Z');
                d.setUTCDate(d.getUTCDate() + 1);
                const topUpFrom = d.toISOString().split('T')[0];
                const newBars5m = await getIntraday5MinCandles(ticker.toUpperCase(), topUpFrom, endDate);
                if (newBars5m.length > 0) {
                    const newBars130m = aggregate5MinTo130M(newBars5m);
                    candles = [...candles, ...newBars130m];
                    cache130MCandles(ticker, newBars130m).catch(e => console.warn('[backtest-data/130M] top-up cache write failed:', e.message));
                    console.log(`[backtest-data/130M] ${ticker}: topped up ${newBars130m.length} bars (${topUpFrom} → ${endDate})`);
                }
            }
            source = 'cache';
            console.log(`[backtest-data/130M] ${ticker}: ${candles.length} 130M bars from cache`);
        } else {
            // Cold cache: paginated backfill from Tiingo IEX 5-min
            const allBars5m = await fetchPaginated5Min(ticker, startDate, endDate);
            candles = aggregate5MinTo130M(allBars5m);
            source = 'tiingo-iex-130m';
            console.log(`[backtest-data/130M] ${ticker}: ${allBars5m.length} 5min bars → ${candles.length} 130M bars (cold backfill)`);
            // Cache for next time (fire-and-forget)
            if (candles.length > 0) cache130MCandles(ticker, candles).catch(e => console.warn('[backtest-data/130M] cold-fill cache write failed:', e.message));
        }
    }

    // Guard: if 130M path produced no data, return error rather than falling through to daily bars
    if (tf === '130M' && (!candles || candles.length === 0)) {
        return res.status(502).json({ error: `No 130M data available for ${ticker}. Tiingo IEX may not have 5-min data for this ticker.` });
    }

    if (!candles || candles.length === 0) {
        if (tf === '4H') {
            // Fetch 1H bars from Tiingo IEX, aggregate to 4H blocks
            const hourly = await getIntradayCandles(ticker.toUpperCase(), startDate, endDate);
            candles = aggregate1HTo4H(hourly);
            source = 'tiingo-iex-4h';
            console.log(`[backtest-data/candles] ${ticker}: ${hourly.length} 1H bars → ${candles.length} 4H bars`);
        } else {
            candles = await getCandles(ticker.toUpperCase(), startDate, endDate, 'day', 1);
            source = 'tiingo';
        }
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
