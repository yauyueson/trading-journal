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

/** Endpoint-aware cache TTL: daily candles 10 min (immutable after close); other candles 5 min; underlying price 2 min; snapshots 60s. */
function getCacheTTL(endpoint) {
    if (endpoint.startsWith('/v2/aggs/')) return 10 * 60 * 1000; // 10 min for candles (daily bars immutable)
    if (endpoint.includes('/v2/snapshot/') && endpoint.includes('/markets/stocks/')) return 2 * 60 * 1000; // 2 min for underlying price
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
    try {
        const data = await fetchPolygon(
            `/v2/snapshot/locale/us/markets/stocks/tickers/${ticker.toUpperCase()}`,
            {},
            true
        );
        const t = data?.ticker;
        if (!t) return null;
        const lastTrade = t.lastTrade?.price ?? t.lastTrade?.p;
        if (typeof lastTrade === 'number' && lastTrade > 0) return lastTrade;
        const lastQuote = t.lastQuote;
        if (lastQuote && (lastQuote.bid != null || lastQuote.ask != null)) {
            const bid = Number(lastQuote.bid ?? lastQuote.bid_price ?? 0);
            const ask = Number(lastQuote.ask ?? lastQuote.ask_price ?? 0);
            if (bid > 0 && ask > 0) return (bid + ask) / 2;
            if (bid > 0) return bid;
            if (ask > 0) return ask;
        }
        const prevClose = t.prevDay?.c ?? t.prevDay?.close;
        if (typeof prevClose === 'number' && prevClose > 0) return prevClose;
        return null;
    } catch (e) {
        console.warn('getUnderlyingPrice error:', e?.message);
        return null;
    }
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
        underlying_ticker: ticker.toUpperCase(),
        limit: 1000
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
    // Previously used exact-date match which returned empty if no expiration fell on that date
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
        const data = await fetchPolygon('/v3/reference/options/contracts', params);

        if (!data.results || data.results.length === 0) return [];

        // Now fetch snapshots for these contracts to get real-time prices and Greeks
        const chain = await enrichWithSnapshots(ticker, data.results);
        optionChainCache.set(cacheKey, { timestamp: Date.now(), chain });
        return chain;
    } catch (e) {
        console.error("getOptionChain error:", e);
        return [];
    }
}

/**
 * Enrich contract data with snapshot data (prices, Greeks, IV)
 */
async function enrichWithSnapshots(underlying, contracts) {
    if (!contracts || contracts.length === 0) return [];

    const results = [];
    try {
        // 1. Fetch the entire chain snapshot once (high-performance bulk endpoint)
        const snapshotData = await fetchPolygon(`/v3/snapshot/options/${underlying.toUpperCase()}`);

        // 2. Map snapshots by their ticker (OCC symbol)
        const snapshotMap = new Map();
        if (snapshotData.results && snapshotData.results.length > 0) {
            snapshotData.results.forEach(result => {
                if (result.details && result.details.ticker) {
                    snapshotMap.set(result.details.ticker, result);
                }
            });
        }

        // 3. Merge each contract with its snapshot data
        contracts.forEach(contract => {
            const snapshot = snapshotMap.get(contract.ticker);
            if (snapshot) {
                results.push(mergeContractAndSnapshot(contract, snapshot));
            } else {
                // If no snapshot, use contract data only (will have no prices/greeks)
                results.push(normalizeContractOnly(contract));
            }
        });
    } catch (e) {
        console.error("Error in enrichWithSnapshots:", e);
        // Fallback: Return what we can with contract data only
        contracts.forEach(contract => {
            results.push(normalizeContractOnly(contract));
        });
    }

    return results;
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
 * Merge contract metadata with snapshot data
 */
function mergeContractAndSnapshot(contract, snapshot) {
    const lastQuote = snapshot.last_quote || {};
    const greeks = snapshot.greeks || {};

    // Calculate DTE
    const expDate = new Date(contract.expiration_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));

    return {
        symbol: contract.ticker,
        strike: Number(contract.strike_price),
        type: contract.contract_type === 'call' ? 'Call' : 'Put',
        expiration: contract.expiration_date,
        dte: dte,
        bid: Number(lastQuote.bid || 0),
        ask: Number(lastQuote.ask || 0),
        last: Number(snapshot.last_trade?.price || lastQuote.last || 0),
        volume: Number(snapshot.day?.volume || 0),
        openInterest: Number(snapshot.open_interest || 0),
        iv: Number(greeks.implied_volatility || 0),
        delta: Number(greeks.delta || 0),
        gamma: Number(greeks.gamma || 0),
        theta: Number(greeks.theta || 0),
        vega: Number(greeks.vega || 0),
        underlyingPrice: Number(snapshot.underlying_asset?.price || 0),
        inTheMoney: contract.contract_type === 'call'
            ? (snapshot.underlying_asset?.price || 0) > contract.strike_price
            : (snapshot.underlying_asset?.price || 0) < contract.strike_price,
        probabilityITM: 0 // Polygon doesn't provide this, would need to calculate
    };
}

/**
 * Normalize contract data without snapshot (no prices/greeks)
 */
function normalizeContractOnly(contract) {
    const expDate = new Date(contract.expiration_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));

    return {
        symbol: contract.ticker,
        strike: Number(contract.strike_price),
        type: contract.contract_type === 'call' ? 'Call' : 'Put',
        expiration: contract.expiration_date,
        dte: dte,
        bid: 0,
        ask: 0,
        last: 0,
        volume: 0,
        openInterest: 0,
        iv: 0,
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
        underlyingPrice: 0,
        inTheMoney: false,
        probabilityITM: 0
    };
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

    return {
        symbol: details.ticker || '',
        strike: Number(details.strike_price || 0),
        type: details.contract_type === 'call' ? 'Call' : 'Put',
        expiration: details.expiration_date || '',
        dte: dte,
        bid: Number(lastQuote.bid || 0),
        ask: Number(lastQuote.ask || 0),
        last: Number(polygonData.last_trade?.price || 0),
        volume: Number(polygonData.day?.volume || 0),
        openInterest: Number(polygonData.open_interest || 0),
        iv: Number(greeks.implied_volatility || 0),
        delta: Number(greeks.delta || 0),
        gamma: Number(greeks.gamma || 0),
        theta: Number(greeks.theta || 0),
        vega: Number(greeks.vega || 0),
        underlyingPrice: Number(polygonData.underlying_asset?.price || 0),
        inTheMoney: details.contract_type === 'call'
            ? (polygonData.underlying_asset?.price || 0) > (details.strike_price || 0)
            : (polygonData.underlying_asset?.price || 0) < (details.strike_price || 0),
        probabilityITM: 0 // Not provided by Polygon
    };
}
