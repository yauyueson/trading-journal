// lib/polygon-client.js
// Client for Polygon.io (MASSIVE) API
// Handles authentication, rate limiting, and response mapping.

const BASE_URL = 'https://api.polygon.io';

// Load environment variables in non-Vercel environments (e.g. local scripts)
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config(); // fallback to .env if needed

// Simple In-Memory Cache (generic Polygon fetches)
const cache = new Map();
const CACHE_TTL_MS = 60000; // 60 seconds

// In-flight request deduplication: concurrent identical fetches share a single Promise
const inflightRequests = new Map();

// Per-ticker option chain cache: same ticker within TTL reuses result (reduces API cost, keeps algo consistent)
const optionChainCache = new Map();
const OPTION_CHAIN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (reference + snapshot data stable within session)

// ── Client-side rate limiter (proactive, prevents 429s before they happen) ───────────
// Polygon free tier: 5 calls/minute. Override with POLYGON_RATE_LIMIT_RPM env var.
// Paid tiers can set higher (e.g. 100). Cache hits never count against this limit.
const _rlTimestamps = [];
let _rlChain = Promise.resolve(); // Serialises limit checks — no race conditions

function _acquireRateSlot() {
    _rlChain = _rlChain.then(async () => {
        const rpm = parseInt(process.env.POLYGON_RATE_LIMIT_RPM || '5');
        const now = Date.now();
        const window = 60_000;

        // Evict timestamps outside the rolling 60 s window
        while (_rlTimestamps.length > 0 && _rlTimestamps[0] <= now - window) _rlTimestamps.shift();

        if (_rlTimestamps.length >= rpm) {
            const waitMs = _rlTimestamps[0] + window - now + 50; // +50 ms buffer
            if (waitMs > 9000) {
                // Abort rather than blow Vercel's 15 s budget; caller gets a clean error
                throw new Error(`[Polygon] Rate limit: ${_rlTimestamps.length}/${rpm} RPM — would wait ${Math.ceil(waitMs / 1000)}s (set POLYGON_RATE_LIMIT_RPM in .env.local and Vercel, e.g. 100 for paid tier)`);
            }
            console.log(`[Polygon] Rate limit (${_rlTimestamps.length}/${rpm} RPM) — waiting ${waitMs}ms`);
            await new Promise(r => setTimeout(r, waitMs));
            // Re-evict after the wait
            const t = Date.now();
            while (_rlTimestamps.length > 0 && _rlTimestamps[0] <= t - window) _rlTimestamps.shift();
        }

        _rlTimestamps.push(Date.now());
    });
    return _rlChain;
}
// ─────────────────────────────────────────────────────────────────────────────

function getCacheKey(endpoint, params) {
    return `${endpoint}?${new URLSearchParams(params).toString()}`;
}

/** Endpoint-aware cache TTL: daily candles 10 min (immutable after close); snapshots 60s. */
function getCacheTTL(endpoint) {
    if (endpoint.startsWith('/v2/aggs/')) return 10 * 60 * 1000; // 10 min for candles (daily bars immutable)
    return CACHE_TTL_MS; // 60s for snapshots and everything else
}

/**
 * Get the API key from environment variables.
 * @returns {string|null}
 */
function getAPIKey() {
    return process.env.POLYGON_API_KEY || null;
}

/**
 * Fetch data from Polygon.io with Caching
 * @param {string} endpoint 
 * @param {object} params 
 * @param {boolean} useCache
 */
async function fetchPolygon(endpoint, params = {}, useCache = true) {
    const apiKey = getAPIKey();
    if (!apiKey) {
        throw new Error('POLYGON_API_KEY not configured');
    }

    // Add API key to params
    const fullParams = { ...params, apiKey };

    const cacheKey = getCacheKey(endpoint, fullParams);
    if (useCache && cache.has(cacheKey)) {
        const { timestamp, data } = cache.get(cacheKey);
        if (Date.now() - timestamp < getCacheTTL(endpoint)) {
            return data;
        } else {
            cache.delete(cacheKey);
        }
    }

    // Request coalescing: if an identical request is already in-flight, reuse its Promise
    if (inflightRequests.has(cacheKey)) {
        console.log(`[Polygon] [coalesced] ${endpoint}`);
        return inflightRequests.get(cacheKey);
    }

    const promise = (async () => {
        // Acquire a rate-limit slot before hitting the network (cache hits skip this)
        await _acquireRateSlot();

        const url = new URL(`${BASE_URL}${endpoint}`);
        Object.keys(fullParams).forEach(key => {
            if (fullParams[key] !== undefined && fullParams[key] !== null) {
                url.searchParams.append(key, fullParams[key]);
            }
        });

        const MAX_RETRIES = 2;
        const RETRY_DELAYS = [500, 1500];

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(url.toString(), {
                    headers: {
                        'Accept': 'application/json'
                    }
                });

                // Retry on 429 (rate limit) or 5xx server errors
                if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
                    let delay = RETRY_DELAYS[attempt] || 1500;
                    if (response.status === 429) {
                        const retryAfter = response.headers.get('Retry-After');
                        if (retryAfter) {
                            const retryMs = parseInt(retryAfter) * 1000;
                            if (!isNaN(retryMs) && retryMs > 0 && retryMs <= 60000) delay = Math.min(retryMs, 60000);
                        }
                    }
                    console.warn(`[Polygon] ${endpoint}: HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Polygon API Error ${response.status}: ${errorText}`);
                }

                const data = await response.json();

                // Polygon uses "status" field instead of "s"
                if (data.status !== 'OK' && data.status !== 'DELAYED') {
                    throw new Error(`Polygon API returned status: ${data.status} - ${data.error || 'Unknown error'}`);
                }

                if (useCache) {
                    cache.set(cacheKey, { timestamp: Date.now(), data });
                }

                return data;
            } catch (error) {
                if (attempt < MAX_RETRIES && error.message && !error.message.includes('Polygon API Error')) {
                    // Network error — retry
                    console.warn(`[Polygon] ${endpoint}: network error, retrying in ${RETRY_DELAYS[attempt]}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
                    continue;
                }
                console.error(`Fetch error for ${endpoint}:`, error.message);
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
 * Get underlying (stock) price for strike-range filtering without full chain fetch.
 * Uses Polygon stocks snapshot; fallback to prevDay close if no live quote.
 * @param {string} ticker Stock symbol (e.g. SPY)
 * @returns {Promise<number|null>} Price or null on failure
 */
export async function getUnderlyingPrice(ticker) {
    // Use latest daily candle close (works on all Polygon plans).
    // Stock snapshot endpoint (/v2/snapshot/stocks/) requires a separate Stocks
    // subscription and returns 403 on Options-only plans, so we skip it entirely.
    try {
        const to = new Date().toISOString().split('T')[0];
        const fromD = new Date();
        fromD.setDate(fromD.getDate() - 7); // look back a week to handle weekends/holidays
        const from = fromD.toISOString().split('T')[0];
        const candles = await getCandles(ticker, from, to, 'day', 1);
        if (candles.length > 0) {
            const price = candles[candles.length - 1].close;
            if (typeof price === 'number' && price > 0) return price;
        }
    } catch (e) {
        console.warn('[getUnderlyingPrice] candle fetch failed:', e?.message);
    }

    return null;
}

/**
 * Get list of expirations for a ticker
 * @param {string} ticker 
 */
export async function getExpirations(ticker) {
    try {
        // Polygon doesn't have a dedicated expirations endpoint
        // We need to fetch all contracts and extract unique expirations
        const data = await fetchPolygon('/v3/reference/options/contracts', {
            underlying_ticker: ticker.toUpperCase(),
            limit: 1000, // Get many contracts to find all expirations
            order: 'asc',
            sort: 'expiration_date'
        });

        if (!data.results || data.results.length === 0) return [];

        // Extract unique expiration dates
        const expirations = new Set();
        data.results.forEach(contract => {
            if (contract.expiration_date) {
                expirations.add(contract.expiration_date);
            }
        });

        return Array.from(expirations).sort();
    } catch (e) {
        console.warn("getExpirations error:", e);
        return [];
    }
}

/**
 * Get Bulk Quotes for multiple Option Symbols
 * Note: Polygon doesn't support true bulk quotes in one call
 * We'll need to make multiple requests
 * @param {string[]} occSymbols Array of OCC strings
 */
export async function getQuotes(occSymbols) {
    if (!occSymbols || occSymbols.length === 0) return [];

    const results = [];

    // Process in chunks to avoid overwhelming the API
    const CHUNK_SIZE = 10;
    for (let i = 0; i < occSymbols.length; i += CHUNK_SIZE) {
        const chunk = occSymbols.slice(i, i + CHUNK_SIZE);

        const promises = chunk.map(async (occSymbol) => {
            try {
                // Extract underlying ticker from OCC symbol (first 1-4 chars before date)
                const underlying = extractUnderlyingFromOCC(occSymbol);
                const data = await fetchPolygon(`/v3/snapshot/options/${underlying}/${occSymbol}`);

                if (data.results) {
                    return normalizePolygonOption(data.results);
                }
                return null;
            } catch (e) {
                console.error(`Error fetching ${occSymbol}:`, e.message);
                return null;
            }
        });

        const chunkResults = await Promise.all(promises);
        results.push(...chunkResults.filter(r => r !== null));
    }

    return results;
}

function optionChainCacheKey(ticker, filters) {
    const f = filters || {};
    const parts = [
        ticker.toUpperCase(),
        f.minDte ?? '', f.maxDte ?? '', f.dte ?? '',
        f.expiration ?? '',
        f.side ?? '',
        f.minStrike ?? '', f.maxStrike ?? ''
    ];
    return parts.join('|');
}

/**
 * Fetch Option Chain with filters
 * Uses 1-minute per-(ticker, filters) cache to reduce API usage and keep algorithm consistent for repeated requests.
 * @param {string} ticker 
 * @param {object} filters { minDte, maxDte, dte, expiration, side, minStrike, maxStrike }
 */
export async function getOptionChain(ticker, filters = {}) {
    const cacheKey = optionChainCacheKey(ticker, filters);
    const cached = optionChainCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < OPTION_CHAIN_CACHE_TTL_MS) {
        return cached.chain;
    }

    const params = {
        limit: 250 // Max limit for snapshot endpoint
    };

    // Handle DTE filtering by converting to expiration date range
    if (filters.minDte !== undefined || filters.maxDte !== undefined) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (filters.minDte !== undefined) {
            const minDate = new Date(today);
            minDate.setDate(minDate.getDate() + filters.minDte);
            params['expiration_date.gte'] = minDate.toISOString().split('T')[0];
        }

        if (filters.maxDte !== undefined) {
            const maxDate = new Date(today);
            maxDate.setDate(maxDate.getDate() + filters.maxDte);
            params['expiration_date.lte'] = maxDate.toISOString().split('T')[0];
        }
    }

    // Specific expiration
    if (filters.expiration) {
        params.expiration_date = filters.expiration;
    }

    // DTE target → date RANGE (±7d) so we always capture nearby expirations
    if (filters.dte !== undefined && !filters.minDte && !filters.maxDte) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const minDate = new Date(today);
        minDate.setDate(minDate.getDate() + Math.max(1, filters.dte - 7));
        const maxDate = new Date(today);
        maxDate.setDate(maxDate.getDate() + filters.dte + 7);
        params['expiration_date.gte'] = minDate.toISOString().split('T')[0];
        params['expiration_date.lte'] = maxDate.toISOString().split('T')[0];
    }

    // Contract type (call/put)
    if (filters.side) {
        params.contract_type = filters.side.toLowerCase();
    }

    // Strike price range
    if (filters.minStrike !== undefined) {
        params['strike_price.gte'] = filters.minStrike;
    }
    if (filters.maxStrike !== undefined) {
        params['strike_price.lte'] = filters.maxStrike;
    }

    try {
        let allResults = [];
        let endpoint = `/v3/snapshot/options/${ticker.toUpperCase()}`;
        let currentParams = { ...params };

        while (endpoint) {
            const data = await fetchPolygon(endpoint, currentParams);
            if (data.results) {
                allResults.push(...data.results);
            }
            if (data.next_url) {
                endpoint = data.next_url.replace('https://api.polygon.io', '');
                if (endpoint.includes('?')) {
                    const [path, qs] = endpoint.split('?');
                    endpoint = path;
                    const urlParams = new URLSearchParams(qs);
                    currentParams = Object.fromEntries(urlParams.entries());
                    if (currentParams.apiKey) delete currentParams.apiKey;
                } else {
                    currentParams = {};
                }
            } else {
                endpoint = null;
            }
        }

        if (allResults.length === 0) return [];

        // Now fetch snapshots for these contracts to get real-time prices and Greeks
        const chain = allResults.map(normalizePolygonOption);
        optionChainCache.set(cacheKey, { timestamp: Date.now(), chain });
        return chain;
    } catch (e) {
        console.error("getOptionChain error:", e);
        return [];
    }
}

// Long-lived candle store: accumulates candles per (ticker, multiplier, timespan).
// Avoids re-fetching immutable historical data on every request.
// Key: `${TICKER}|${mult}|${timespan}`  →  { candles[], fromDate, lastDate }
const candleStore = new Map();

/**
 * Raw candle fetch — no store logic, just HTTP → normalized array.
 */
async function _fetchRawCandles(ticker, from, to, timespan, mult) {
    const params = { adjusted: 'true', sort: 'asc', limit: '5000' };
    const endpoint = `/v2/aggs/ticker/${ticker.toUpperCase()}/range/${mult}/${timespan}/${from}/${to}`;
    const data = await fetchPolygon(endpoint, params);

    if (!data.results || !Array.isArray(data.results)) {
        console.warn(`[getCandles] ${ticker} ${mult}${timespan} ${from}→${to}: no results (resultsCount: ${data.resultsCount ?? 'undefined'})`);
        return [];
    }

    return data.results.map(c => ({
        timestamp: c.t,
        date: new Date(c.t).toISOString().split('T')[0],
        open: Number(c.o),
        high: Number(c.h),
        low: Number(c.l),
        close: Number(c.c),
        volume: Number(c.v)
    }));
}

/**
 * Fetch historical candles with incremental top-up cache.
 *
 * On the first call for a (ticker, timespan) the full range is fetched and stored.
 * On subsequent calls where the stored history already covers `from`, only new
 * candles are fetched:
 *   - Daily:    fetch from lastDate+1 (daily bars are complete & immutable once closed)
 *   - Intraday: re-fetch from lastDate (today's bars grow during the session)
 *
 * This means calling getCandles('TSLA', …, 'day') tomorrow costs 1 candle, not 150.
 *
 * @param {string} ticker
 * @param {string} from  YYYY-MM-DD
 * @param {string} to    YYYY-MM-DD
 * @param {string} timespan  'day' | 'hour' | 'minute'
 * @param {number} [multiplier=1]
 */
export async function getCandles(ticker, from, to, timespan = 'day', multiplier = 1) {
    try {
        const mult = multiplier == null || multiplier < 1 ? 1 : multiplier;
        const storeKey = `${ticker.toUpperCase()}|${mult}|${timespan}`;
        const stored = candleStore.get(storeKey);

        if (stored && from >= stored.fromDate) {
            // We have at least as much history as requested. Top up if needed.
            let topUpFrom;
            if (timespan === 'day') {
                // Daily bars are immutable once closed — fetch from the next calendar day
                const d = new Date(stored.lastDate + 'T12:00:00Z');
                d.setUTCDate(d.getUTCDate() + 1);
                topUpFrom = d.toISOString().split('T')[0];
            } else {
                // Intraday bars grow during the session — re-fetch the last stored date
                topUpFrom = stored.lastDate;
            }

            if (topUpFrom <= to) {
                const newCandles = await _fetchRawCandles(ticker, topUpFrom, to, timespan, mult);
                if (newCandles.length > 0) {
                    // Drop stored candles that overlap with the re-fetched window, then merge
                    const kept = stored.candles.filter(c => c.date < topUpFrom);
                    stored.candles = [...kept, ...newCandles];
                    stored.lastDate = stored.candles[stored.candles.length - 1].date;
                    console.log(`[Candle Store] ${ticker} ${mult}${timespan}: +${newCandles.length} new candles (total: ${stored.candles.length})`);
                }
            }

            // Return only candles within the requested window
            return stored.candles.filter(c => c.date >= from && c.date <= to);
        }

        // Full fetch — first time, or requested window starts before what we have stored
        const candles = await _fetchRawCandles(ticker, from, to, timespan, mult);
        if (candles.length > 0) {
            candleStore.set(storeKey, {
                candles,
                fromDate: candles[0].date,
                lastDate: candles[candles.length - 1].date
            });
            console.log(`[Candle Store] ${ticker} ${mult}${timespan}: loaded ${candles.length} candles (${candles[0].date} → ${candles[candles.length - 1].date})`);
        }
        return candles;
    } catch (e) {
        console.error(`[getCandles] ${ticker} ${multiplier ?? 1}${timespan} ${from}→${to}: FAILED —`, e?.message || e);
        return [];
    }
}

/**
 * Get single option snapshot (with Greeks and real-time data)
 */
export async function getOptionSnapshot(underlying, occSymbol) {
    try {
        const data = await fetchPolygon(`/v3/snapshot/options/${underlying.toUpperCase()}/${occSymbol}`);

        if (data.results) {
            return normalizePolygonOption(data.results);
        }
        return null;
    } catch (e) {
        console.error(`getOptionSnapshot error for ${occSymbol}:`, e);
        return null;
    }
}

// ========== HELPER FUNCTIONS ==========

/**
 * Extract underlying ticker from OCC symbol
 * Example: SPY250221C00580000 -> SPY
 */
function extractUnderlyingFromOCC(occSymbol) {
    // OCC format: [TICKER][YYMMDD][C/P][STRIKE*1000]
    // Ticker is variable length (1-6 chars), followed by 6-digit date
    // Look for the 6-digit date pattern
    const match = occSymbol.match(/^([A-Z]+)\d{6}/);
    return match ? match[1] : occSymbol.substring(0, 3); // Fallback to first 3 chars
}


/**
 * Normalize Polygon option snapshot to internal format
 */
function normalizePolygonOption(polygonData) {
    const details = polygonData.details || {};
    const lastQuote = polygonData.last_quote || {};
    const greeks = polygonData.greeks || {};

    // Calculate DTE
    const expDate = new Date(details.expiration_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));

    // Polygon returns nanosecond timestamps in last_quote.last_updated
    const quoteUpdatedNs = lastQuote.last_updated || polygonData.last_updated || 0;
    const quoteUpdatedMs = quoteUpdatedNs > 1e15 ? quoteUpdatedNs / 1e6 : quoteUpdatedNs; // ns→ms

    // Use ?? (nullish coalescing) instead of || so that genuine zero values are preserved.
    // With ||, bid=0 would fallback to day.vwap which is completely wrong.
    const rawBid = lastQuote.bid ?? lastQuote.bid_price ?? null;
    const rawAsk = lastQuote.ask ?? lastQuote.ask_price ?? null;
    const rawLast = polygonData.last_trade?.price ?? null;
    const dayClose = polygonData.day?.close ?? polygonData.day?.previous_close ?? null;

    // Only use day data as fallback when live quotes are truly missing (null/undefined), not zero
    const bid = rawBid != null ? Number(rawBid) : (dayClose != null ? Number(dayClose) : 0);
    const ask = rawAsk != null ? Number(rawAsk) : (dayClose != null ? Number(dayClose) : 0);
    const last = rawLast != null ? Number(rawLast) : (dayClose != null ? Number(dayClose) : 0);

    // Compute mid price: prefer live bid/ask, fall back to last trade
    const mid = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (last > 0 ? last : 0);

    return {
        symbol: details.ticker || '',
        strike: Number(details.strike_price || 0),
        type: details.contract_type === 'call' ? 'Call' : 'Put',
        expiration: details.expiration_date || '',
        dte: dte,
        bid,
        ask,
        last,
        mid,
        volume: Number(polygonData.day?.volume || 0),
        openInterest: Number(polygonData.open_interest || 0),
        iv: Number(polygonData.implied_volatility || greeks.implied_volatility || 0),
        delta: Number(greeks.delta || 0),
        gamma: Number(greeks.gamma || 0),
        theta: Number(greeks.theta || 0),
        vega: Number(greeks.vega || 0),
        underlyingPrice: Number(polygonData.underlying_asset?.price ?? 0),
        inTheMoney: details.contract_type === 'call'
            ? (polygonData.underlying_asset?.price ?? 0) > (details.strike_price || 0)
            : (polygonData.underlying_asset?.price ?? 0) < (details.strike_price || 0),
        probabilityITM: 0, // Not provided by Polygon
        quoteUpdatedMs, // millisecond timestamp of last quote update
    };
}

/**
 * Check quote freshness for a set of normalized options.
 * Returns { staleQuotes, freshQuotes, oldestQuoteAge, isStale }.
 * Stale = quote >5min old during US market hours (9:30-16:00 ET).
 */
export function checkQuoteFreshness(chain, maxAgeMs = 5 * 60 * 1000) {
    const now = Date.now();
    // Check if currently US market hours (ET = UTC-5 or UTC-4 DST)
    const etNow = new Date(now);
    const utcH = etNow.getUTCHours();
    const utcM = etNow.getUTCMinutes();
    // EST: UTC-5 → market 14:30-21:00 UTC. EDT: UTC-4 → market 13:30-20:00 UTC.
    // Approximate: market open 13:30-21:00 UTC covers both.
    const utcMinutes = utcH * 60 + utcM;
    const isMarketHours = utcMinutes >= 13 * 60 + 30 && utcMinutes <= 21 * 60;

    if (!isMarketHours) return { staleQuotes: 0, freshQuotes: chain.length, oldestQuoteAgeMs: 0, isStale: false };

    let staleQuotes = 0;
    let oldestAge = 0;
    for (const opt of chain) {
        if (!opt.quoteUpdatedMs || opt.quoteUpdatedMs <= 0) continue;
        const age = now - opt.quoteUpdatedMs;
        if (age > oldestAge) oldestAge = age;
        if (age > maxAgeMs) staleQuotes++;
    }

    return {
        staleQuotes,
        freshQuotes: chain.length - staleQuotes,
        oldestQuoteAgeMs: oldestAge,
        isStale: staleQuotes > chain.length * 0.5, // majority stale = flag
    };
}
