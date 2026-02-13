// api/polygon-client.js
// Client for Polygon.io (MASSIVE) API
// Handles authentication, rate limiting, and response mapping.

const BASE_URL = 'https://api.polygon.io';

// Simple In-Memory Cache
const cache = new Map();
const CACHE_TTL_MS = 5000; // 5 seconds

function getCacheKey(endpoint, params) {
    return `${endpoint}?${new URLSearchParams(params).toString()}`;
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
        if (Date.now() - timestamp < CACHE_TTL_MS) {
            return data;
        } else {
            cache.delete(cacheKey);
        }
    }

    const url = new URL(`${BASE_URL}${endpoint}`);
    Object.keys(fullParams).forEach(key => {
        if (fullParams[key] !== undefined && fullParams[key] !== null) {
            url.searchParams.append(key, fullParams[key]);
        }
    });

    try {
        const response = await fetch(url.toString(), {
            headers: {
                'Accept': 'application/json'
            }
        });

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
        console.error(`Fetch error for ${endpoint}:`, error.message);
        throw error;
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

/**
 * Fetch Option Chain with filters
 * @param {string} ticker 
 * @param {object} filters 
 */
export async function getOptionChain(ticker, filters = {}) {
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

    // Specific DTE (for exact match like dte=30)
    if (filters.dte !== undefined && !filters.minDte && !filters.maxDte) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const targetDate = new Date(today);
        targetDate.setDate(targetDate.getDate() + filters.dte);
        params.expiration_date = targetDate.toISOString().split('T')[0];
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
        return await enrichWithSnapshots(ticker, data.results);

    } catch (e) {
        console.error("getOptionChain error:", e);
        return [];
    }
}

/**
 * Enrich contract data with snapshot data (prices, Greeks, IV)
 */
async function enrichWithSnapshots(underlying, contracts) {
    // Polygon snapshot endpoint can handle multiple contracts
    // But we need to make multiple calls for large chains
    const CHUNK_SIZE = 50;
    const results = [];

    for (let i = 0; i < contracts.length; i += CHUNK_SIZE) {
        const chunk = contracts.slice(i, i + CHUNK_SIZE);

        try {
            // Use the chain snapshot endpoint
            const snapshotData = await fetchPolygon(`/v3/snapshot/options/${underlying.toUpperCase()}`);

            if (snapshotData.results && snapshotData.results.length > 0) {
                // Create a map for quick lookup
                const snapshotMap = new Map();
                snapshotData.results.forEach(result => {
                    if (result.details && result.details.ticker) {
                        snapshotMap.set(result.details.ticker, result);
                    }
                });

                // Merge contract info with snapshot data
                chunk.forEach(contract => {
                    const snapshot = snapshotMap.get(contract.ticker);
                    if (snapshot) {
                        results.push(mergeContractAndSnapshot(contract, snapshot));
                    } else {
                        // If no snapshot, use contract data only (will have no prices/greeks)
                        results.push(normalizeContractOnly(contract));
                    }
                });
            } else {
                // No snapshots available, use contract data only
                chunk.forEach(contract => {
                    results.push(normalizeContractOnly(contract));
                });
            }
        } catch (e) {
            console.error("Error fetching snapshots:", e);
            // Fallback to contract data only
            chunk.forEach(contract => {
                results.push(normalizeContractOnly(contract));
            });
        }
    }

    return results;
}

/**
 * Fetch historical candles
 * @param {string} ticker 
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 * @param {string} timespan 'day', 'hour', 'minute'
 */
export async function getCandles(ticker, from, to, timespan = 'day') {
    try {
        const params = {
            adjusted: 'true',
            sort: 'asc'
        };

        const endpoint = `/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/${timespan}/${from}/${to}`;
        const data = await fetchPolygon(endpoint, params);

        if (!data.results || !Array.isArray(data.results)) return [];

        return data.results.map(candle => ({
            date: new Date(candle.t).toISOString().split('T')[0],
            open: Number(candle.o),
            high: Number(candle.h),
            low: Number(candle.l),
            close: Number(candle.c),
            volume: Number(candle.v)
        }));
    } catch (e) {
        console.error("getCandles error:", e);
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
