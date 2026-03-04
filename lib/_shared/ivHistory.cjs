/**
 * IV History - Ticker-level IV snapshots for IV Rank / IV Percentile.
 *
 * Requires Supabase table: ticker_iv_snapshots (ticker, recorded_date, iv30, iv90).
 * See docs/04_数据库设计.md migration for schema.
 *
 * - saveTickerIVSnapshot: upsert today's iv30/iv90 for a ticker (call after scan/strategy).
 * - getIVRank: fetch last 252 days, return { ivRank, ivPercentile, currentIv30, minIv, maxIv, sampleDays, ivRankSource }.
 */

const WINDOW_DAYS = 252;
/** Minimum number of daily snapshots needed to report IV Rank / IV Percentile. Fewer → return null (show N/A). */
const MIN_SAMPLES_FOR_RANK = 5;
/** When falling back to rv_proxy rows, scale by this factor to approximate IV (IV ≈ RV × 1.15 due to volatility risk premium). */
const RV_TO_IV_SCALE = 1.15;

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
        source: 'live_iv',
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
 * Returns { ivRank, ivPercentile, currentIv30, minIv, maxIv, sampleDays, ivRankSource } or { ivRank: null, ... } if no data.
 *
 * Priority: uses live_iv rows first. If < MIN_SAMPLES_FOR_RANK, falls back to rv_proxy rows
 * (scaled by RV_TO_IV_SCALE ≈ 1.15 to approximate IV) and sets ivRankSource='rv_proxy'.
 */
async function getIVRank(ticker) {
    const nullResult = { ivRank: null, ivPercentile: null, currentIv30: null, minIv: null, maxIv: null, sampleDays: 0, ivRankSource: null };
    const { url, key } = getSupabase();
    if (!url || !key || !ticker) return nullResult;

    const fromDate = windowStartISO();
    const upperTicker = (ticker || '').toUpperCase();
    const baseParams = {
        ticker: `eq.${upperTicker}`,
        recorded_date: `gte.${fromDate}`,
        order: 'recorded_date.desc',
        limit: '400',
    };

    try {
        // Try with source filter first (post-migration 009); fallback without if column doesn't exist yet
        let liveRows = [];
        let rvRows = [];
        let hasSourceColumn = true;

        const paramsLive = new URLSearchParams({ ...baseParams, source: 'eq.live_iv' });
        const resLive = await fetch(`${url}/rest/v1/ticker_iv_snapshots?${paramsLive}`, {
            headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
        });

        if (resLive.ok) {
            liveRows = await resLive.json();
            // Also fetch rv_proxy rows in case we need them as fallback
            const paramsRv = new URLSearchParams({ ...baseParams, source: 'eq.rv_proxy' });
            const resRv = await fetch(`${url}/rest/v1/ticker_iv_snapshots?${paramsRv}`, {
                headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
            });
            if (resRv.ok) rvRows = await resRv.json();
        } else {
            // source column may not exist yet — retry without it (pre-migration fallback)
            hasSourceColumn = false;
            const paramsAll = new URLSearchParams(baseParams);
            const resAll = await fetch(`${url}/rest/v1/ticker_iv_snapshots?${paramsAll}`, {
                headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
            });
            if (!resAll.ok) return nullResult;
            const allRows = await resAll.json();
            liveRows = allRows.filter(r => r.iv90 != null);
            rvRows = allRows.filter(r => r.iv90 == null);
            if (liveRows.length === 0) liveRows = allRows;
        }

        // Decide which source to use
        const liveIvValues = liveRows.map(r => r.iv30 != null ? Number(r.iv30) : null).filter(v => v != null);
        const useLive = liveIvValues.length >= MIN_SAMPLES_FOR_RANK;

        let iv30Values;
        let ivRankSource;

        if (useLive) {
            iv30Values = liveIvValues;
            ivRankSource = 'live_iv';
        } else {
            // Fallback: use rv_proxy rows scaled by RV_TO_IV_SCALE
            const rvIvValues = rvRows.map(r => r.iv30 != null ? Number(r.iv30) * RV_TO_IV_SCALE : null).filter(v => v != null);
            if (rvIvValues.length >= MIN_SAMPLES_FOR_RANK) {
                // Use the most recent live_iv value as currentIv30 if available, otherwise scale rv too
                const currentLive = liveIvValues.length > 0 ? liveIvValues[0] : null;
                iv30Values = currentLive != null
                    ? [currentLive, ...rvIvValues.slice(1)]  // real current IV + scaled RV history
                    : rvIvValues;
                ivRankSource = 'rv_proxy';
            } else {
                // Not enough data from either source
                const currentIv30 = liveIvValues.length > 0 ? liveIvValues[0] : null;
                const allAvailable = [...liveIvValues, ...rvIvValues];
                return {
                    ivRank: null, ivPercentile: null,
                    currentIv30,
                    minIv: allAvailable.length > 0 ? Math.min(...allAvailable) : null,
                    maxIv: allAvailable.length > 0 ? Math.max(...allAvailable) : null,
                    sampleDays: liveIvValues.length,
                    ivRankSource: null,
                };
            }
        }

        if (iv30Values.length === 0) return nullResult;

        const n = iv30Values.length;
        const currentIv30 = iv30Values[0];
        const minIv = Math.min(...iv30Values);
        const maxIv = Math.max(...iv30Values);
        const span = maxIv - minIv;

        const ivRank = span > 0 ? (currentIv30 - minIv) / span : null;
        const countBelow = iv30Values.filter((v) => v < currentIv30).length;
        const ivPercentile = n > 0 ? countBelow / n : null;

        // IV Momentum: 5-trading-day relative change in IV30 (rows sorted desc, index 5 ≈ 5d ago).
        // Only meaningful with live_iv data
        const momentumValues = liveIvValues.length >= 6 ? liveIvValues : iv30Values;
        const iv5dAgo = momentumValues.length >= 6 ? momentumValues[5] : null;
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
            ivRankSource,
            // IV Momentum fields (v2.4+)
            iv5dChange,        // Absolute decimal change (e.g. 0.02 = IV went from 0.30 to 0.32)
            iv5dChangePct,     // Relative % change (e.g. +6.7%) — use this for trend classification
            ivTrend,
        };
    } catch (e) {
        console.warn('IV rank fetch error:', e.message);
        return { ivRank: null, ivPercentile: null, currentIv30: null, minIv: null, maxIv: null, sampleDays: 0, ivRankSource: null };
    }
}

module.exports = { saveTickerIVSnapshot, getIVRank, WINDOW_DAYS };
