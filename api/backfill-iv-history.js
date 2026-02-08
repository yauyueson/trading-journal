// api/backfill-iv-history.js
// Backfill ticker_iv_snapshots with historical 30d Realized Volatility from Nasdaq stock prices.
// GET /api/backfill-iv-history?ticker=SPY   → backfill one ticker
// GET /api/backfill-iv-history?ticker=SPY,QQQ,AAPL → backfill multiple (comma-separated)
// Uses same Supabase table as IV Rank; past dates get iv30 = RV (decimal). Today's real IV overwrites when you run Strategy/Scan.

const WINDOW_DAYS = 252;
const ROLLING_DAYS = 30;

function getSupabase() {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    return { url, key };
}

async function fetchNasdaqHistoricalChunk(ticker, fromStr, toStr) {
    const url = `https://api.nasdaq.com/api/quote/${ticker.toUpperCase()}/historical?assetclass=stocks&fromdate=${fromStr}&todate=${toStr}&limit=60`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.data?.tradesTable?.rows || [];
}

function parseClose(row) {
    const c = row.close ?? row.Close;
    const close = typeof c === 'string' ? parseFloat(c.replace('$', '').replace(',', '')) : Number(c);
    return isNaN(close) ? null : close;
}

function parseDateFromRow(row) {
    for (const k of Object.keys(row)) {
        const v = row[k];
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
        if (typeof v === 'string' && /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v)) {
            const d = new Date(v);
            if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
        }
    }
    return null;
}

function addDays(isoDate, days) {
    const d = new Date(isoDate + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function isWeekday(isoDate) {
    const d = new Date(isoDate + 'T12:00:00Z');
    const day = d.getUTCDay();
    return day >= 1 && day <= 5;
}

async function fetchAllHistorical(ticker) {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - 400);
    const allPoints = [];
    let from = new Date(fromDate);
    const to = new Date(toDate);
    while (from <= to) {
        const toChunk = new Date(from);
        toChunk.setDate(toChunk.getDate() + 59);
        const toStr = (toChunk > to ? to : toChunk).toISOString().split('T')[0];
        const fromStr = from.toISOString().split('T')[0];
        const rows = await fetchNasdaqHistoricalChunk(ticker, fromStr, toStr);
        const withClose = rows.map((r) => ({ close: parseClose(r), date: parseDateFromRow(r) })).filter((x) => x.close != null);
        if (withClose.length === 0) {
            from.setDate(from.getDate() + 60);
            continue;
        }
        const haveDates = withClose.every((x) => x.date);
        if (haveDates) {
            withClose.sort((a, b) => a.date.localeCompare(b.date));
            for (const p of withClose) allPoints.push({ date: p.date, close: p.close });
        } else {
            const closes = withClose.map((x) => x.close);
            const reversed = closes.reverse();
            let cur = fromStr;
            for (let i = 0; i < reversed.length; i++) {
                while (!isWeekday(cur) && cur <= toStr) cur = addDays(cur, 1);
                if (cur > toStr) break;
                allPoints.push({ date: cur, close: reversed[i] });
                cur = addDays(cur, 1);
            }
        }
        from.setDate(from.getDate() + 60);
        if (rows.length < 2) break;
    }
    const byDate = {};
    for (const p of allPoints) byDate[p.date] = p.close;
    const sortedDates = Object.keys(byDate).sort();
    return sortedDates.map((d) => ({ date: d, close: byDate[d] }));
}

function computeRollingRV(sortedPoints, rollingDays = ROLLING_DAYS) {
    const results = [];
    for (let i = rollingDays; i < sortedPoints.length; i++) {
        const window = sortedPoints.slice(i - rollingDays, i + 1);
        const prices = window.map((p) => p.close);
        const returns = [];
        for (let j = 1; j < prices.length; j++) returns.push(Math.log(prices[j] / prices[j - 1]));
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
        const std = Math.sqrt(variance);
        const annualized = std * Math.sqrt(252);
        results.push({ date: window[window.length - 1].date, rv30: annualized });
    }
    return results;
}

async function upsertSnapshots(supabaseUrl, supabaseKey, ticker, snapshots) {
    const tickerUpper = ticker.toUpperCase();
    for (const s of snapshots) {
        const body = JSON.stringify({
            ticker: tickerUpper,
            recorded_date: s.date,
            iv30: s.rv30,
            iv90: null,
        });
        try {
            await fetch(`${supabaseUrl}/rest/v1/ticker_iv_snapshots`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates,on_conflict=ticker,recorded_date',
                },
                body,
            });
        } catch (e) {
            console.warn('Backfill upsert failed for', ticker, s.date, e.message);
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

    const { url: supabaseUrl, key: supabaseKey } = getSupabase();
    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Supabase not configured (SUPABASE_URL / SUPABASE_ANON_KEY)' });
    }

    const tickers = ticker.split(',').map((t) => t.trim()).filter(Boolean);
    const results = [];

    for (const t of tickers) {
        try {
            const points = await fetchAllHistorical(t);
            if (points.length < ROLLING_DAYS + 1) {
                results.push({ ticker: t.toUpperCase(), status: 'skipped', reason: `Need ${ROLLING_DAYS + 1}+ days, got ${points.length}` });
                continue;
            }
            const snapshots = computeRollingRV(points);
            await upsertSnapshots(supabaseUrl, supabaseKey, t, snapshots);
            results.push({ ticker: t.toUpperCase(), status: 'ok', daysBackfilled: snapshots.length });
        } catch (e) {
            results.push({ ticker: t.toUpperCase(), status: 'error', message: e.message });
        }
    }

    return res.status(200).json({ success: true, results });
}
