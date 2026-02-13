// lib/market-data-client.js
// Client for MarketData.app API
// Handles authentication, rate limiting, and response mapping.

const BASE_URL = 'https://api.marketdata.app/v1';

// Simple In-Memory Cache
const cache = new Map();
const CACHE_TTL_MS = 5000; // 5 seconds

function getCacheKey(endpoint, params) {
    return `${endpoint}?${new URLSearchParams(params).toString()}`;
}

/**
 * Get the API token from environment variables.
 * @returns {string|null}
 */
function getToken() {
    return process.env.MARKET_DATA_TOKEN || null;
}

/**
 * Fetch data from MarketData.app with Caching
 * @param {string} endpoint 
 * @param {object} params 
 * @param {boolean} useCache
 */
async function fetchMarketData(endpoint, params = {}, useCache = true) {
    const token = getToken();
    if (!token) {
        throw new Error('MARKET_DATA_TOKEN not configured');
    }

    const cacheKey = getCacheKey(endpoint, params);
    if (useCache && cache.has(cacheKey)) {
        const { timestamp, data } = cache.get(cacheKey);
        if (Date.now() - timestamp < CACHE_TTL_MS) {
            // console.log(`[Cache Hit] ${cacheKey}`);
            return data;
        } else {
            cache.delete(cacheKey);
        }
    }

    const url = new URL(`${BASE_URL}${endpoint}`);
    // Append token to URL params as 'token' is often supported, or use Header.
    // MarketData.app usually accepts token in query string or Bearer header.
    // Documentation says "Authorization: Bearer <token>" is best practice.

    Object.keys(params).forEach(key => {
        if (params[key] !== undefined && params[key] !== null) {
            url.searchParams.append(key, params[key]);
        }
    });

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
    };

    try {
        const response = await fetch(url.toString(), { headers });

        if (!response.ok) {
            // Handle 401 Unauthorized, 429 Rate Limit, etc.
            const errorText = await response.text();
            throw new Error(`MarketData API Error ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        if (data.s !== 'ok') {
            // specific MarketData.app error status
            throw new Error(`MarketData API returned status: ${data.s} - ${data.errmsg || 'Unknown error'}`);
        }

        if (useCache) {
            cache.set(cacheKey, { timestamp: Date.now(), data });
        }

        return data;
    } catch (error) {
        console.error(`Fetch error for ${endpoint}:`, error.message);
        throw error;
    }
}

/**
 * Format Unix timestamp to YYYY-MM-DD
 * @param {number} unixTimestamp 
 */
function formatExpiration(unixTimestamp) {
    // MarketData often returns expiration as Unix timestamp
    const date = new Date(unixTimestamp * 1000); // Unix is usually seconds
    return date.toISOString().split('T')[0];
}

/**
 * Get list of expirations for a ticker
 * @param {string} ticker 
 */
export async function getExpirations(ticker) {
    try {
        const data = await fetchMarketData(`/options/expirations/${ticker.toUpperCase()}/`);
        if (!data || data.s === 'error') return [];
        const raw = Array.isArray(data) ? data : (data.expirations || data.expirationDates || data.dates);
        if (!raw || !Array.isArray(raw) || raw.length === 0) return [];
        // Normalize: Unix (seconds) -> YYYY-MM-DD; already string -> keep
        return raw.map((d) => (typeof d === 'number' ? new Date(d * 1000).toISOString().slice(0, 10) : String(d)));
    } catch (e) {
        console.warn("getExpirations error:", e);
        return [];
    }
}

/**
 * Get Bulk Quotes for multiple Option Symbols
 * @param {string[]} occSymbols Array of OCC strings
 */
export async function getQuotes(occSymbols) {
    if (!occSymbols || occSymbols.length === 0) return [];

    // Split into chunks if necessary (API might limit URL length or count)
    // For now assuming Reasonable count (< 20)
    const symbolsJoined = occSymbols.join(',');

    try {
        // Endpoint: /v1/options/quotes?optionSymbol=A,B,C
        const data = await fetchMarketData('/options/quotes/', { optionSymbol: symbolsJoined });
        return mapResponseToInternal(data);
    } catch (e) {
        console.error("getQuotes error:", e);
        return [];
    }
}

/**
 * Fetch Option Chain with filters
 * @param {string} ticker 
 * @param {object} filters 
 */
export async function getOptionChain(ticker, filters = {}) {
    // defaults
    const params = {
        ...filters
    };

    // Handle internal DTE range filtering if API doesn't support it directly
    // MarketData requires 'expiration' for specific dates.
    // If minDte/maxDte is provided without specific expiration, we must:
    // 1. Fetch all expirations
    // 2. Filter expirations by DTE range
    // 3. Fetch chains for those expirations in parallel

    // Check if we need complex DTE handling
    const hasDteRange = filters.minDte !== undefined || filters.maxDte !== undefined;
    const hasExplicitExpiration = filters.expiration !== undefined;

    if (hasDteRange && !hasExplicitExpiration) {
        try {
            const minDte = filters.minDte ?? 0;
            const maxDte = filters.maxDte ?? 365;

            // 1. Get Expirations
            const expirations = await getExpirations(ticker);
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // 2. Filter matching dates
            const matchingExps = expirations.filter(expStr => {
                const expDate = new Date(expStr);
                const diffTime = Math.abs(expDate - today);
                const dte = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                return dte >= minDte && dte <= maxDte;
            });

            if (matchingExps.length === 0) return [];

            // Limit concurrent requests (e.g. max 5) or optimize logic
            // Note: Scanner might trigger many.

            // 3. Fetch all matches
            const promises = matchingExps.map(exp => {
                // Remove DTE filters from recursive call to avoid infinite loop (and pass expiration)
                const { minDte, maxDte, ...rest } = filters;
                return getOptionChain(ticker, { ...rest, expiration: exp });
            });

            const results = await Promise.all(promises);
            return results.flat();

        } catch (e) {
            console.error("Error handling DTE range:", e);
            // Fallback: try simple fetch or error
            return [];
        }
    }

    // Normal single-request flow

    // Filters mapping:
    // minDelta, maxDelta -> delta (range: "min-max")
    // minStrike, maxStrike -> strike (range: "min-max")

    // Construct range strings if separate min/max provided
    if (filters.minDelta !== undefined || filters.maxDelta !== undefined) {
        const min = filters.minDelta ?? 0;
        const max = filters.maxDelta ?? 1;
        params.delta = `${min}-${max}`;
        delete params.minDelta;
        delete params.maxDelta;
    }

    // Clean up DTE params if passed but no recursion happened (e.g. specific expiration used)
    delete params.minDte;
    delete params.maxDte;

    if (filters.minStrike !== undefined || filters.maxStrike !== undefined) {
        const min = filters.minStrike ?? 0;
        const max = filters.maxStrike ?? 10000;
        params.strike = `${min}-${max}`;
        delete params.minStrike;
        delete params.maxStrike;
    }

    // Only 'call' or 'put' side? 
    // internal uses 'Call'/'Put', API uses 'call'/'put' (checking docs if case sensitive)
    // usually lowercase is safer for APIs.
    if (filters.side) {
        params.side = filters.side.toLowerCase();
    }

    // Explicit date format fix if needed (YYYY-MM-DD expected)
    // assuming input is correct.

    // Call API
    const data = await fetchMarketData(`/options/chain/${ticker.toUpperCase()}/`, params);

    return mapResponseToInternal(data);
}

/**
 * Fetch historical candles
 * @param {string} ticker 
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 * @param {string} resolution 'D', 'W', 'M', '1', '5', '15', '60'
 */
export async function getCandles(ticker, from, to, resolution = 'D') {
    try {
        const params = {
            from,
            to,
            resolution
        };
        const data = await fetchMarketData(`/stocks/candles/${resolution}/${ticker.toUpperCase()}/`, params);

        // MarketData returns { s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] }
        if (data.s !== 'ok' || !Array.isArray(data.t)) return [];

        const count = data.t.length;
        const results = [];
        for (let i = 0; i < count; i++) {
            results.push({
                date: new Date(data.t[i] * 1000).toISOString().split('T')[0],
                open: Number(data.o[i]),
                high: Number(data.h[i]),
                low: Number(data.l[i]),
                close: Number(data.c[i]),
                volume: Number(data.v[i])
            });
        }
        return results;
    } catch (e) {
        console.error("getCandles error:", e);
        return [];
    }
}

function mapResponseToInternal(data) {
    if (!data) return [];

    const count = Array.isArray(data.strike) ? data.strike.length : (Array.isArray(data) ? data.length : 0);
    const results = [];

    // Helper to get value at index i whether data is columnar or row-based
    const get = (field, i) => {
        if (Array.isArray(data[field])) return data[field][i]; // Columnar
        if (data[i] && data[i][field] !== undefined) return data[i][field]; // Row-based
        return null;
    };

    // If data is just an array of objects
    if (Array.isArray(data)) {
        return data.map(normalizeOption);
    }

    // If data is columnar (keys exist in root object and are arrays)
    if (data.optionSymbol && Array.isArray(data.optionSymbol)) {
        for (let i = 0; i < count; i++) {
            const opt = {
                optionSymbol: get('optionSymbol', i),
                underlyingSymbol: get('underlyingSymbol', i),
                expiration: get('expiration', i),
                side: get('side', i),
                strike: get('strike', i),
                daysToExpiration: get('daysToExpiration', i) ?? get('dte', i),
                bid: get('bid', i),
                ask: get('ask', i),
                mid: get('mid', i),
                last: get('last', i),
                volume: get('volume', i),
                openInterest: get('openInterest', i),
                impliedVolatility: get('impliedVolatility', i) ?? get('iv', i),
                delta: get('delta', i),
                gamma: get('gamma', i),
                theta: get('theta', i),
                vega: get('vega', i),
                underlyingPrice: get('underlyingPrice', i),
                inTheMoney: get('inTheMoney', i),
                probabilityITM: get('probabilityITM', i) ?? get('probITM', i) ?? get('probability_itm', i)
            };
            results.push(normalizeOption(opt));
        }
        return results;
    }

    return [];
}

function normalizeOption(apiOpt) {
    return {
        symbol: apiOpt.optionSymbol,
        strike: Number(apiOpt.strike),
        type: apiOpt.side ? (apiOpt.side.toLowerCase() === 'call' ? 'Call' : 'Put') : 'Unknown',
        expiration: typeof apiOpt.expiration === 'number' ? formatExpiration(apiOpt.expiration) : apiOpt.expiration,
        dte: Number(apiOpt.daysToExpiration || apiOpt.dte || 0),
        bid: Number(apiOpt.bid || 0),
        ask: Number(apiOpt.ask || 0),
        last: Number(apiOpt.last || 0),
        volume: Number(apiOpt.volume || 0),
        openInterest: Number(apiOpt.openInterest || 0),
        iv: Number(apiOpt.impliedVolatility || apiOpt.iv || 0),
        delta: Number(apiOpt.delta || 0),
        gamma: Number(apiOpt.gamma || 0),
        theta: Number(apiOpt.theta || 0),
        vega: Number(apiOpt.vega || 0),
        underlyingPrice: Number(apiOpt.underlyingPrice || 0),
        inTheMoney: apiOpt.inTheMoney,
        probabilityITM: Number(apiOpt.probabilityITM || apiOpt.probITM || apiOpt.probability_itm || 0)
    };
}
