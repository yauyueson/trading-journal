/**
 * IV History - Ticker-level IV snapshots for IV Rank / IV Percentile.
 *
 * Requires Supabase table: ticker_iv_snapshots (ticker, recorded_date, iv30, iv90).
 * See docs/04_数据库设计.md migration for schema.
 *
 * - saveTickerIVSnapshot: upsert today's iv30/iv90 for a ticker (call after scan/strategy).
 * - getIVRank: fetch last 252 days, auto-backfills RV proxy if < 200 samples,
 *   return { ivRank, ivPercentile, currentIv30, minIv, maxIv, sampleDays, ivRankSource }.
 */

const WINDOW_DAYS = 252;
/** Minimum number of daily snapshots needed to report IV Rank / IV Percentile.
 *  60 trading days ≈ 3 months — below this the min/max window is too narrow and
 *  IV Rank is meaningless (e.g. 10 days → 100% rank just because IV ticked up).
 *  Fewer → return null (show N/A). */
const MIN_SAMPLES_FOR_RANK = 60;
/** Trigger inline RV backfill when total samples (live + rv_proxy) are below this.
 *  200 ≈ 80% of the 252-day window — ensures most of the 52-week range is covered. */
const MIN_BACKFILL_THRESHOLD = 200;
/** RV30 rolling window for backfill computation. */
const RV_ROLLING_DAYS = 30;
/** When falling back to rv_proxy rows, scale by this factor to approximate IV (IV ≈ RV × 1.15 due to volatility risk premium). */
const RV_TO_IV_SCALE = 1.15;

/** Track which tickers have been backfilled this process to avoid repeated Polygon calls. */
const _backfilledThisProcess = new Set();

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

// =============================================================================
// INLINE RV BACKFILL — fetches Polygon daily candles, computes RV30, upserts
// =============================================================================

/**
 * Fetch daily candles directly from Polygon REST API (no ESM imports needed).
 * Returns array of { date: 'YYYY-MM-DD', close: number } sorted ascending.
 */
async function _fetchDailyCandles(ticker, fromDate, toDate) {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) {
        console.warn('[IVHistory backfill] POLYGON_API_KEY not set — skipping backfill');
        return [];
    }

    const url = `https://api.polygon.io/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[IVHistory backfill] Polygon candles ${res.status} for ${ticker}`);
            return [];
        }
        const data = await res.json();
        if (!data.results || data.results.length === 0) return [];
        return data.results.map(r => ({
            date: new Date(r.t).toISOString().slice(0, 10),
            close: r.c,
        }));
    } catch (e) {
        console.warn(`[IVHistory backfill] Polygon fetch error for ${ticker}:`, e.message);
        return [];
    }
}

/**
 * Compute rolling 30-day realized volatility from sorted daily closes.
 * Returns array of { date, rv30 } (annualized decimal, e.g. 0.35 = 35%).
 */
function _computeRollingRV(sortedPoints) {
    const results = [];
    if (!sortedPoints || sortedPoints.length < RV_ROLLING_DAYS + 1) return results;

    for (let i = RV_ROLLING_DAYS; i < sortedPoints.length; i++) {
        const window = sortedPoints.slice(i - RV_ROLLING_DAYS, i + 1);
        const prices = window.map(p => p.close);
        const returns = [];
        for (let j = 1; j < prices.length; j++) {
            returns.push(Math.log(prices[j] / prices[j - 1]));
        }
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
        const annualized = Math.sqrt(variance) * Math.sqrt(252);
        results.push({ date: window[window.length - 1].date, rv30: annualized });
    }
    return results;
}

/**
 * Inline backfill: fetch ~500 days of Polygon candles → compute RV30 → upsert as rv_proxy.
 * Called automatically by getIVRank when total samples < MIN_BACKFILL_THRESHOLD.
 * Skips if already backfilled this process or if Polygon key is missing.
 */
async function _ensureIVHistory(ticker) {
    const upperTicker = (ticker || '').toUpperCase();
    if (_backfilledThisProcess.has(upperTicker)) return;
    _backfilledThisProcess.add(upperTicker); // mark immediately to prevent concurrent dupes

    const { url: sbUrl, key: sbKey } = getSupabaseForWrite();
    if (!sbUrl || !sbKey) return;

    const today = new Date();
    const from = new Date(today);
    from.setDate(today.getDate() - 500); // ~1.5 years of candles
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = today.toISOString().slice(0, 10);

    console.log(`[IVHistory] ${upperTicker}: backfilling RV proxy (${fromStr} → ${toStr})…`);

    const candles = await _fetchDailyCandles(upperTicker, fromStr, toStr);
    if (candles.length < RV_ROLLING_DAYS + 1) {
        console.warn(`[IVHistory] ${upperTicker}: only ${candles.length} candles — not enough for RV30`);
        return;
    }

    const snapshots = _computeRollingRV(candles);
    if (snapshots.length === 0) return;

    // Batch upsert 100 rows at a time
    const BATCH = 100;
    let upserted = 0;
    for (let i = 0; i < snapshots.length; i += BATCH) {
        const rows = snapshots.slice(i, i + BATCH).map(s => ({
            ticker: upperTicker,
            recorded_date: s.date,
            iv30: s.rv30,
            iv90: null,
            source: 'rv_proxy',
        }));

        try {
            const res = await fetch(`${sbUrl}/rest/v1/ticker_iv_snapshots`, {
                method: 'POST',
                headers: {
                    'apikey': sbKey,
                    'Authorization': `Bearer ${sbKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates,on_conflict=ticker,recorded_date',
                },
                body: JSON.stringify(rows),
            });
            if (res.ok) upserted += rows.length;
            else console.warn(`[IVHistory] ${upperTicker}: upsert batch failed`, res.status);
        } catch (e) {
            console.warn(`[IVHistory] ${upperTicker}: upsert error`, e.message);
        }
    }
    console.log(`[IVHistory] ${upperTicker}: backfilled ${upserted} rv_proxy rows`);
}

// =============================================================================
// GET IV RANK — with automatic backfill
// =============================================================================

/**
 * Fetch last WINDOW_DAYS of snapshots for ticker; compute IV Rank and IV Percentile.
 * If total samples < MIN_BACKFILL_THRESHOLD, auto-backfills RV proxy from Polygon
 * candles INLINE (awaited) so the result includes 52-week context immediately.
 *
 * Returns { ivRank, ivPercentile, currentIv30, minIv, maxIv, sampleDays, ivRankSource,
 *           iv5dChange, iv5dChangePct, ivTrend, autoBackfilled } or { ivRank: null, ... } if no data.
 *
 * Priority: uses live_iv rows first. If < MIN_SAMPLES_FOR_RANK, falls back to rv_proxy rows
 * (scaled by RV_TO_IV_SCALE ≈ 1.15 to approximate IV) and sets ivRankSource='rv_proxy'.
 */
async function getIVRank(ticker) {
    const nullResult = { ivRank: null, ivPercentile: null, currentIv30: null, minIv: null, maxIv: null, sampleDays: 0, ivRankSource: null, autoBackfilled: false };
    const { url, key } = getSupabase();
    if (!url || !key || !ticker) return nullResult;

    const upperTicker = (ticker || '').toUpperCase();

    // Inner function: fetch rows & compute rank
    async function _computeRank() {
        const fromDate = windowStartISO();
        const baseParams = {
            ticker: `eq.${upperTicker}`,
            recorded_date: `gte.${fromDate}`,
            order: 'recorded_date.desc',
            limit: '400',
        };

        let liveRows = [];
        let rvRows = [];

        const paramsLive = new URLSearchParams({ ...baseParams, source: 'eq.live_iv' });
        const resLive = await fetch(`${url}/rest/v1/ticker_iv_snapshots?${paramsLive}`, {
            headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
        });

        if (resLive.ok) {
            liveRows = await resLive.json();
            const paramsRv = new URLSearchParams({ ...baseParams, source: 'eq.rv_proxy' });
            const resRv = await fetch(`${url}/rest/v1/ticker_iv_snapshots?${paramsRv}`, {
                headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
            });
            if (resRv.ok) rvRows = await resRv.json();
        } else {
            // source column may not exist yet — retry without it (pre-migration fallback)
            const paramsAll = new URLSearchParams(baseParams);
            const resAll = await fetch(`${url}/rest/v1/ticker_iv_snapshots?${paramsAll}`, {
                headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
            });
            if (!resAll.ok) return { ...nullResult, _totalSamples: 0 };
            const allRows = await resAll.json();
            liveRows = allRows.filter(r => r.iv90 != null);
            rvRows = allRows.filter(r => r.iv90 == null);
            if (liveRows.length === 0) liveRows = allRows;
        }

        const liveIvValues = liveRows.map(r => r.iv30 != null ? Number(r.iv30) : null).filter(v => v != null);
        const rvIvValues = rvRows.map(r => r.iv30 != null ? Number(r.iv30) * RV_TO_IV_SCALE : null).filter(v => v != null);
        const totalSamples = liveIvValues.length + rvIvValues.length;

        const useLive = liveIvValues.length >= MIN_SAMPLES_FOR_RANK;

        let iv30Values;
        let ivRankSource;

        if (useLive) {
            iv30Values = liveIvValues;
            ivRankSource = 'live_iv';
        } else if (rvIvValues.length >= MIN_SAMPLES_FOR_RANK) {
            const currentLive = liveIvValues.length > 0 ? liveIvValues[0] : null;
            iv30Values = currentLive != null
                ? [currentLive, ...rvIvValues.slice(1)]
                : rvIvValues;
            ivRankSource = 'rv_proxy';
        } else {
            const currentIv30 = liveIvValues.length > 0 ? liveIvValues[0] : null;
            const allAvailable = [...liveIvValues, ...rvIvValues];
            return {
                ivRank: null, ivPercentile: null,
                currentIv30,
                minIv: allAvailable.length > 0 ? Math.min(...allAvailable) : null,
                maxIv: allAvailable.length > 0 ? Math.max(...allAvailable) : null,
                sampleDays: liveIvValues.length,
                ivRankSource: null,
                _totalSamples: totalSamples,
            };
        }

        if (iv30Values.length === 0) return { ...nullResult, _totalSamples: totalSamples };

        const n = iv30Values.length;
        const currentIv30 = iv30Values[0];
        const minIv = Math.min(...iv30Values);
        const maxIv = Math.max(...iv30Values);
        const span = maxIv - minIv;

        const ivRank = span > 0 ? (currentIv30 - minIv) / span : null;
        const countBelow = iv30Values.filter(v => v < currentIv30).length;
        const ivPercentile = n > 0 ? countBelow / n : null;

        // IV Momentum: 5-trading-day relative change
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
            iv5dChange,
            iv5dChangePct,
            ivTrend,
            _totalSamples: totalSamples,
        };
    }

    try {
        // First attempt
        let result = await _computeRank();
        const totalSamples = result._totalSamples || 0;

        // Auto-backfill if insufficient history
        if (totalSamples < MIN_BACKFILL_THRESHOLD) {
            await _ensureIVHistory(upperTicker);
            // Re-compute with the newly-inserted rv_proxy rows
            result = await _computeRank();
            result.autoBackfilled = true;
        } else {
            result.autoBackfilled = false;
        }

        // Strip internal field
        delete result._totalSamples;
        return result;
    } catch (e) {
        console.warn('IV rank fetch error:', e.message);
        return nullResult;
    }
}

module.exports = { saveTickerIVSnapshot, getIVRank, WINDOW_DAYS };
