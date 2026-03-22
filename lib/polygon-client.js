// lib/polygon-client.js
// Client for Polygon.io API — intraday OHLCV candles for short-term backtesting.
// Free tier: 5 API calls/min, 2 years historical intraday.

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const BASE_URL = 'https://api.polygon.io';

// ── Rate limiter (5 RPM for Polygon free tier) ─────────────────────────────────
const _rlTimestamps = [];
let _rlChain = Promise.resolve();

function _acquireRateSlot() {
    _rlChain = _rlChain.then(async () => {
        const rpm = parseInt(process.env.POLYGON_RATE_LIMIT_RPM || '5');
        const now = Date.now();
        const window = 60_000;

        while (_rlTimestamps.length > 0 && _rlTimestamps[0] <= now - window) _rlTimestamps.shift();

        if (_rlTimestamps.length >= rpm) {
            const waitMs = _rlTimestamps[0] + window - now + 100;
            console.log(`[Polygon] Rate limit (${_rlTimestamps.length}/${rpm} RPM) — waiting ${Math.ceil(waitMs / 1000)}s`);
            await new Promise(r => setTimeout(r, waitMs));
            const t = Date.now();
            while (_rlTimestamps.length > 0 && _rlTimestamps[0] <= t - window) _rlTimestamps.shift();
        }

        _rlTimestamps.push(Date.now());
    });
    return _rlChain;
}

// ── In-flight dedup ─────────────────────────────────────────────────────────────
const inflightRequests = new Map();

function getAPIKey() {
    return process.env.POLYGON_API_KEY || null;
}

/**
 * Fetch data from Polygon API with retry and dedup.
 */
async function fetchPolygon(endpoint, params = {}) {
    const apiKey = getAPIKey();
    if (!apiKey) {
        throw new Error('POLYGON_API_KEY not configured');
    }

    const url = new URL(`${BASE_URL}${endpoint}`);
    url.searchParams.append('apiKey', apiKey);
    for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null) {
            url.searchParams.append(key, String(val));
        }
    }

    const cacheKey = url.toString();
    if (inflightRequests.has(cacheKey)) {
        return inflightRequests.get(cacheKey);
    }

    const promise = (async () => {
        await _acquireRateSlot();

        const MAX_RETRIES = 2;
        const RETRY_DELAYS = [1000, 3000];

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(url.toString());

                if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
                    const delay = RETRY_DELAYS[attempt] || 3000;
                    console.warn(`[Polygon] ${endpoint}: HTTP ${response.status}, retrying in ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Polygon API Error ${response.status}: ${errorText}`);
                }

                return await response.json();
            } catch (error) {
                if (attempt < MAX_RETRIES && !error.message?.includes('Polygon API Error')) {
                    console.warn(`[Polygon] ${endpoint}: network error, retrying in ${RETRY_DELAYS[attempt]}ms`);
                    await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
                    continue;
                }
                throw error;
            }
        }
    })();

    inflightRequests.set(cacheKey, promise);
    try {
        return await promise;
    } finally {
        inflightRequests.delete(cacheKey);
    }
}

/**
 * Fetch aggregate (OHLCV) bars from Polygon.
 *
 * @param {string} ticker     e.g. "SPY"
 * @param {number} multiplier e.g. 1
 * @param {string} timespan   "minute", "hour", "day", "week", "month"
 * @param {string} from       YYYY-MM-DD
 * @param {string} to         YYYY-MM-DD
 * @param {object} [opts]     { adjusted, sort, limit }
 * @returns {Promise<Array<{timestamp:number, date:string, open:number, high:number, low:number, close:number, volume:number, vwap:number, transactions:number}>>}
 */
export async function getAggregates(ticker, multiplier, timespan, from, to, opts = {}) {
    const { adjusted = true, sort = 'asc', limit = 50000 } = opts;

    let allResults = [];
    let nextUrl = null;

    // First request
    const endpoint = `/v2/aggs/ticker/${ticker.toUpperCase()}/range/${multiplier}/${timespan}/${from}/${to}`;
    const data = await fetchPolygon(endpoint, { adjusted, sort, limit });

    if (data.results && Array.isArray(data.results)) {
        allResults.push(...data.results);
    }

    // Pagination — Polygon returns next_url for large result sets
    nextUrl = data.next_url || null;
    while (nextUrl) {
        await _acquireRateSlot();
        const res = await fetch(`${nextUrl}&apiKey=${getAPIKey()}`);
        if (!res.ok) break;
        const page = await res.json();
        if (page.results && Array.isArray(page.results)) {
            allResults.push(...page.results);
        }
        nextUrl = page.next_url || null;
    }

    // Normalize to match existing candle shape
    return allResults.map(bar => {
        const ts = bar.t; // Unix ms timestamp
        const d = new Date(ts);
        const dateStr = d.toISOString().split('T')[0];
        const timeStr = d.toISOString().slice(0, 19).replace('T', ' ');

        return {
            timestamp: ts,
            date: dateStr,
            datetime: timeStr,
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            volume: bar.v,
            vwap: bar.vw || 0,
            transactions: bar.n || 0,
        };
    });
}
