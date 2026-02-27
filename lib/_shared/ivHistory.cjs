/**
 * IV History - Ticker-level IV snapshots for IV Rank / IV Percentile.
 *
 * Requires Supabase table: ticker_iv_snapshots (ticker, recorded_date, iv30, iv90).
 * See docs/04_数据库设计.md migration for schema.
 *
 * - saveTickerIVSnapshot: upsert today's iv30/iv90 for a ticker (call after scan/strategy).
 * - getIVRank: fetch last 252 days, return { ivRank, ivPercentile, currentIv30, minIv, maxIv, sampleDays }.
 */

const WINDOW_DAYS = 252;
/** Minimum number of daily snapshots needed to report IV Rank / IV Percentile. Fewer → return null (show N/A). */
const MIN_SAMPLES_FOR_RANK = 5;

function getSupabase() {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    return { url, key };
}

/** Use service role for writes when available so INSERT is allowed despite RLS on ticker_iv_snapshots. */
function getSupabaseForWrite() {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    return { url, key };
}

function todayISO() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
}

function windowStartISO() {
    const d = new Date();
    d.setDate(d.getDate() - WINDOW_DAYS);
    return d.toISOString().slice(0, 10);
}

/**
 * Upsert one row: (ticker, recorded_date = today, iv30, iv90).
 * No-op if Supabase env not set.
 */
async function saveTickerIVSnapshot(ticker, iv30, iv90) {
    const { url, key } = getSupabaseForWrite();
    if (!url || !key || iv30 == null) return;

    const recordedDate = todayISO();
    const body = JSON.stringify({
        ticker: (ticker || '').toUpperCase(),
        recorded_date: recordedDate,
        iv30: Number(iv30),
        iv90: iv90 != null ? Number(iv90) : null,
    });

    try {
        const res = await fetch(`${url}/rest/v1/ticker_iv_snapshots`, {
            method: 'POST',
            headers: {
                'apikey': key,
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates,on_conflict=ticker,recorded_date',
            },
            body,
        });
        if (!res.ok) {
            var _body = await res.text();
            console.warn('IV snapshot save failed:', res.status, _body);
        }
    } catch (e) {
        console.warn('IV snapshot save error:', e.message);
    }
}

/**
 * Fetch last WINDOW_DAYS of snapshots for ticker; compute IV Rank and IV Percentile.
 * Returns { ivRank, ivPercentile, currentIv30, minIv, maxIv, sampleDays } or { ivRank: null, ... } if no data.
 */
async function getIVRank(ticker) {
    const { url, key } = getSupabase();
    if (!url || !key || !ticker) return { ivRank: null, ivPercentile: null, currentIv30: null, minIv: null, maxIv: null, sampleDays: 0 };

    const fromDate = windowStartISO();
    const params = new URLSearchParams({
        ticker: `eq.${(ticker || '').toUpperCase()}`,
        recorded_date: `gte.${fromDate}`,
        order: 'recorded_date.desc',
        limit: '400',
    });

    try {
        const res = await fetch(`${url}/rest/v1/ticker_iv_snapshots?${params}`, {
            headers: {
                'apikey': key,
                'Authorization': `Bearer ${key}`,
            },
        });
        if (!res.ok) return { ivRank: null, ivPercentile: null, currentIv30: null, minIv: null, maxIv: null, sampleDays: 0 };

        const rows = await res.json();
        if (!rows || rows.length === 0) return { ivRank: null, ivPercentile: null, currentIv30: null, minIv: null, maxIv: null, sampleDays: 0 };

        const iv30Values = rows.map((r) => (r.iv30 != null ? Number(r.iv30) : null)).filter((v) => v != null);
        if (iv30Values.length === 0) return { ivRank: null, ivPercentile: null, currentIv30: null, minIv: null, maxIv: null, sampleDays: 0 };

        const n = iv30Values.length;
        const currentIv30 = iv30Values[0];
        const minIv = Math.min(...iv30Values);
        const maxIv = Math.max(...iv30Values);
        const span = maxIv - minIv;

        if (n < MIN_SAMPLES_FOR_RANK) {
            return { ivRank: null, ivPercentile: null, currentIv30, minIv, maxIv, sampleDays: n };
        }

        const ivRank = span > 0 ? (currentIv30 - minIv) / span : null;
        const countBelow = iv30Values.filter((v) => v < currentIv30).length;
        const ivPercentile = n > 0 ? countBelow / n : null;

        // IV Momentum: 5-trading-day relative change in IV30 (rows sorted desc, index 5 ≈ 5d ago).
        // IMPORTANT: iv30 is stored as a decimal (e.g. 0.30 = 30%), so we use relative % change
        // to avoid the threshold being impossible to reach with decimal values.
        // Thresholds: >10% relative increase = rising, <-10% relative decrease = falling.
        const iv5dAgo = iv30Values.length >= 6 ? iv30Values[5] : null;
        const iv5dChange = iv5dAgo != null ? Number((currentIv30 - iv5dAgo).toFixed(4)) : null;
        const iv5dChangePct = (iv5dAgo != null && iv5dAgo > 0)
            ? Number(((currentIv30 - iv5dAgo) / iv5dAgo * 100).toFixed(1))
            : null;
        const ivTrend = iv5dChangePct == null ? null
            : iv5dChangePct > 10 ? 'rising'
                : iv5dChangePct < -10 ? 'falling'
                    : 'flat';

        return {
            ivRank: ivRank != null ? Math.max(0, Math.min(1, ivRank)) : null,
            ivPercentile: ivPercentile != null ? Math.max(0, Math.min(1, ivPercentile)) : null,
            currentIv30,
            minIv,
            maxIv,
            sampleDays: n,
            // IV Momentum fields (v2.4+)
            iv5dChange,        // Absolute decimal change (e.g. 0.02 = IV went from 0.30 to 0.32)
            iv5dChangePct,     // Relative % change (e.g. +6.7%) — use this for trend classification
            ivTrend,
        };
    } catch (e) {
        console.warn('IV rank fetch error:', e.message);
        return { ivRank: null, ivPercentile: null, currentIv30: null, minIv: null, maxIv: null, sampleDays: 0 };
    }
}

module.exports = { saveTickerIVSnapshot, getIVRank, WINDOW_DAYS };
