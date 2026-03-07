// lib/tiingo-client.js
// Client for Tiingo API — stock OHLCV candles for backtesting + technical analysis.
// Primary stock candle data client.
// Free tier: 50 req/hr, 1000/day, 500 unique symbols/month.
// Full history back to IPO for most US equities.

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const BASE_URL = 'https://api.tiingo.com';

// ── Rate limiter (50 RPM for Tiingo free tier) ────────────────────────────────
const _rlTimestamps = [];
let _rlChain = Promise.resolve();

function _acquireRateSlot() {
    _rlChain = _rlChain.then(async () => {
        const rpm = parseInt(process.env.TIINGO_RATE_LIMIT_RPM || '50');
        const now = Date.now();
        const window = 60_000;

        while (_rlTimestamps.length > 0 && _rlTimestamps[0] <= now - window) _rlTimestamps.shift();

        if (_rlTimestamps.length >= rpm) {
            const waitMs = _rlTimestamps[0] + window - now + 50;
            if (waitMs > 30000) {
                throw new Error(`[Tiingo] Rate limit: ${_rlTimestamps.length}/${rpm} RPM — would wait ${Math.ceil(waitMs / 1000)}s`);
            }
            console.log(`[Tiingo] Rate limit (${_rlTimestamps.length}/${rpm} RPM) — waiting ${waitMs}ms`);
            await new Promise(r => setTimeout(r, waitMs));
            const t = Date.now();
            while (_rlTimestamps.length > 0 && _rlTimestamps[0] <= t - window) _rlTimestamps.shift();
        }

        _rlTimestamps.push(Date.now());
    });
    return _rlChain;
}

// ── In-flight dedup ────────────────────────────────────────────────────────────
const inflightRequests = new Map();

function getAPIToken() {
    return process.env.TIINGO_API_TOKEN || null;
}

/**
 * Fetch data from Tiingo API with retry and dedup.
 */
async function fetchTiingo(endpoint, params = {}) {
    const token = getAPIToken();
    if (!token) {
        throw new Error('TIINGO_API_TOKEN not configured');
    }

    const url = new URL(`${BASE_URL}${endpoint}`);
    for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null) {
            url.searchParams.append(key, val);
        }
    }

    const cacheKey = url.toString();
    if (inflightRequests.has(cacheKey)) {
        console.log(`[Tiingo] [coalesced] ${endpoint}`);
        return inflightRequests.get(cacheKey);
    }

    const promise = (async () => {
        await _acquireRateSlot();

        const MAX_RETRIES = 2;
        const RETRY_DELAYS = [500, 1500];

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(url.toString(), {
                    headers: {
                        'Authorization': `Token ${token}`,
                        'Content-Type': 'application/json',
                    }
                });

                if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
                    const delay = RETRY_DELAYS[attempt] || 1500;
                    console.warn(`[Tiingo] ${endpoint}: HTTP ${response.status}, retrying in ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Tiingo API Error ${response.status}: ${errorText}`);
                }

                return await response.json();
            } catch (error) {
                if (attempt < MAX_RETRIES && !error.message?.includes('Tiingo API Error')) {
                    console.warn(`[Tiingo] ${endpoint}: network error, retrying in ${RETRY_DELAYS[attempt]}ms`);
                    await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
                    continue;
                }
                console.error(`[Tiingo] Fetch error for ${endpoint}:`, error.message);
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

// ── Candle store (incremental top-up cache) ──────────────────────────────────
// Accumulates candles per (ticker, multiplier, timespan).
// Key: `${TICKER}|${mult}|${timespan}` → { candles[], fromDate, lastDate }
const candleStore = new Map();

/**
 * Raw candle fetch — no store logic, just HTTP → normalized array.
 * Tiingo returns adjusted prices by default.
 */
async function _fetchRawCandles(ticker, from, to) {
    const data = await fetchTiingo(`/tiingo/daily/${ticker.toLowerCase()}/prices`, {
        startDate: from,
        endDate: to,
        format: 'json',
    });

    if (!Array.isArray(data) || data.length === 0) {
        console.warn(`[Tiingo] ${ticker} ${from}→${to}: no results`);
        return [];
    }

    // Normalize Tiingo response to match existing candle shape.
    // Use adjusted prices (adjOpen/adjClose etc.) for split+dividend consistency.
    return data.map(c => {
        const dateStr = c.date ? c.date.split('T')[0] : '';
        return {
            timestamp: c.date ? new Date(c.date).getTime() : 0,
            date: dateStr,
            open: Number(c.adjOpen ?? c.open ?? 0),
            high: Number(c.adjHigh ?? c.high ?? 0),
            low: Number(c.adjLow ?? c.low ?? 0),
            close: Number(c.adjClose ?? c.close ?? 0),
            volume: Number(c.adjVolume ?? c.volume ?? 0),
        };
    });
}

/**
 * Fetch historical candles with incremental top-up cache.
 * Fetch OHLCV candles with incremental top-up caching.
 *
 * Note: Tiingo only provides daily candles on the free tier.
 * The `timespan` and `multiplier` params are accepted for API compatibility
 * but only 'day'/1 is supported.
 *
 * @param {string} ticker
 * @param {string} from  YYYY-MM-DD
 * @param {string} to    YYYY-MM-DD
 * @param {string} [timespan='day']  Only 'day' supported on Tiingo free tier
 * @param {number} [multiplier=1]
 */
export async function getCandles(ticker, from, to, timespan = 'day', multiplier = 1) {
    if (timespan !== 'day' || (multiplier && multiplier !== 1)) {
        console.warn(`[Tiingo] Only daily candles supported. Requested: ${multiplier}${timespan}. Falling back to daily.`);
    }

    try {
        const storeKey = `${ticker.toUpperCase()}|1|day`;
        const stored = candleStore.get(storeKey);

        if (stored && from >= stored.fromDate) {
            // Top up from the day after our last stored candle
            const d = new Date(stored.lastDate + 'T12:00:00Z');
            d.setUTCDate(d.getUTCDate() + 1);
            const topUpFrom = d.toISOString().split('T')[0];

            if (topUpFrom <= to) {
                const newCandles = await _fetchRawCandles(ticker, topUpFrom, to);
                if (newCandles.length > 0) {
                    const kept = stored.candles.filter(c => c.date < topUpFrom);
                    stored.candles = [...kept, ...newCandles];
                    stored.lastDate = stored.candles[stored.candles.length - 1].date;
                    console.log(`[Candle Store] ${ticker} daily: +${newCandles.length} new candles (total: ${stored.candles.length})`);
                }
            }

            return stored.candles.filter(c => c.date >= from && c.date <= to);
        }

        // Full fetch
        const candles = await _fetchRawCandles(ticker, from, to);
        if (candles.length > 0) {
            candleStore.set(storeKey, {
                candles,
                fromDate: candles[0].date,
                lastDate: candles[candles.length - 1].date,
            });
            console.log(`[Candle Store] ${ticker} daily: loaded ${candles.length} candles (${candles[0].date} → ${candles[candles.length - 1].date})`);
        }
        return candles;
    } catch (e) {
        console.error(`[Tiingo] getCandles(${ticker}, ${from}, ${to}): FAILED —`, e?.message || e);
        return [];
    }
}
