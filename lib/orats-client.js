// lib/orats-client.js
// Client for ORATS Data API — options chains, Greeks, IV, earnings
// Primary options data client (ORATS API).

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const BASE_URL = 'https://api.orats.io/datav2';

// ── Caching ────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 60_000; // 60s for general fetches

const optionChainCache = new Map();
const OPTION_CHAIN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-flight request deduplication
const inflightRequests = new Map();

// ── Rate limiter (1000 RPM for ORATS) ──────────────────────────────────────────
const _rlTimestamps = [];
let _rlChain = Promise.resolve();

function _acquireRateSlot() {
    _rlChain = _rlChain.then(async () => {
        const rpm = parseInt(process.env.ORATS_RATE_LIMIT_RPM || '1000');
        const now = Date.now();
        const window = 60_000;

        while (_rlTimestamps.length > 0 && _rlTimestamps[0] <= now - window) _rlTimestamps.shift();

        if (_rlTimestamps.length >= rpm) {
            const waitMs = _rlTimestamps[0] + window - now + 50;
            if (waitMs > 9000) {
                throw new Error(`[ORATS] Rate limit: ${_rlTimestamps.length}/${rpm} RPM — would wait ${Math.ceil(waitMs / 1000)}s`);
            }
            console.log(`[ORATS] Rate limit (${_rlTimestamps.length}/${rpm} RPM) — waiting ${waitMs}ms`);
            await new Promise(r => setTimeout(r, waitMs));
            const t = Date.now();
            while (_rlTimestamps.length > 0 && _rlTimestamps[0] <= t - window) _rlTimestamps.shift();
        }

        _rlTimestamps.push(Date.now());
    });
    return _rlChain;
}

// ── Core fetch ─────────────────────────────────────────────────────────────────

function getCacheKey(endpoint, params) {
    return `${endpoint}?${new URLSearchParams(params).toString()}`;
}

function getCacheTTL(endpoint) {
    if (endpoint.includes('/hist/')) return 10 * 60 * 1000; // 10 min for historical (immutable)
    return CACHE_TTL_MS;
}

function getAPIToken() {
    return process.env.ORATS_API_TOKEN || null;
}

/**
 * Fetch data from ORATS API with caching, dedup, and retry.
 */
async function fetchORATS(endpoint, params = {}, useCache = true) {
    const token = getAPIToken();
    if (!token) {
        throw new Error('ORATS_API_TOKEN not configured');
    }

    const fullParams = { ...params, token };
    const cacheKey = getCacheKey(endpoint, fullParams);

    if (useCache && cache.has(cacheKey)) {
        const { timestamp, data } = cache.get(cacheKey);
        if (Date.now() - timestamp < getCacheTTL(endpoint)) {
            return data;
        } else {
            cache.delete(cacheKey);
        }
    }

    if (inflightRequests.has(cacheKey)) {
        console.log(`[ORATS] [coalesced] ${endpoint}`);
        return inflightRequests.get(cacheKey);
    }

    const promise = (async () => {
        await _acquireRateSlot();

        const url = new URL(`${BASE_URL}${endpoint}`);
        for (const [key, val] of Object.entries(fullParams)) {
            if (val !== undefined && val !== null) {
                url.searchParams.append(key, val);
            }
        }

        const MAX_RETRIES = 2;
        const RETRY_DELAYS = [500, 1500];

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(url.toString(), {
                    headers: { 'Accept': 'application/json' }
                });

                if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
                    const delay = RETRY_DELAYS[attempt] || 1500;
                    console.warn(`[ORATS] ${endpoint}: HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`ORATS API Error ${response.status}: ${errorText}`);
                }

                const data = await response.json();

                if (useCache) {
                    cache.set(cacheKey, { timestamp: Date.now(), data });
                }

                return data;
            } catch (error) {
                if (attempt < MAX_RETRIES && !error.message?.includes('ORATS API Error')) {
                    console.warn(`[ORATS] ${endpoint}: network error, retrying in ${RETRY_DELAYS[attempt]}ms`);
                    await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
                    continue;
                }
                console.error(`[ORATS] Fetch error for ${endpoint}:`, error.message);
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

// ── Normalization ──────────────────────────────────────────────────────────────

// Fields to request from /strikes to minimize payload
const STRIKES_FIELDS = [
    'ticker', 'tradeDate', 'expirDate', 'dte', 'strike',
    'stockPrice', 'spotPrice',
    'delta', 'gamma', 'theta', 'vega',
    'callBidPrice', 'callValue', 'callAskPrice',
    'putBidPrice', 'putValue', 'putAskPrice',
    'callBidIv', 'callMidIv', 'callAskIv',
    'putBidIv', 'putMidIv', 'putAskIv',
    'callVolume', 'callOpenInterest',
    'putVolume', 'putOpenInterest',
    'updatedAt'
].join(',');

/**
 * Normalize a single ORATS strike row into two normalized options (call + put).
 * ORATS returns one row per strike containing both call and put data.
 *
 * Output matches the internal format used by parseChain() in scoring.cjs:
 * { symbol, strike, type, expiration, dte, bid, ask, last, mid,
 *   volume, openInterest, iv, delta, gamma, theta, vega,
 *   underlyingPrice, inTheMoney, quoteUpdatedMs }
 */
function normalizeORATSStrike(row) {
    const stockPrice = row.stockPrice ?? row.spotPrice ?? 0;
    const expiration = row.expirDate; // already YYYY-MM-DD
    const dte = row.dte ?? 0;
    const strike = row.strike ?? 0;
    const ticker = row.ticker || '';
    const updatedMs = row.updatedAt ? new Date(row.updatedAt).getTime() : Date.now();

    // Call delta from ORATS; put delta = call delta - 1 (put-call parity)
    const callDelta = row.delta ?? 0;
    const putDelta = callDelta - 1;

    // Gamma, vega are identical for call/put at the same strike
    const gamma = row.gamma ?? 0;
    const vega = row.vega ?? 0;

    // Theta: ORATS provides call-side theta. Put theta ≈ call theta + r*K*e^(-rT)
    // For short DTE equity options the difference is negligible, so we use the same value.
    const theta = row.theta ?? 0;

    // Use ?? to preserve genuine zero values (bid=0 is valid, not missing)
    const callBid = row.callBidPrice ?? 0;
    const callAsk = row.callAskPrice ?? 0;
    const callMid = row.callValue ?? ((callBid > 0 && callAsk > 0) ? (callBid + callAsk) / 2 : 0);

    const putBid = row.putBidPrice ?? 0;
    const putAsk = row.putAskPrice ?? 0;
    const putMid = row.putValue ?? ((putBid > 0 && putAsk > 0) ? (putBid + putAsk) / 2 : 0);

    const results = [];

    // Call option
    results.push({
        symbol: ticker,
        strike,
        type: 'Call',
        expiration,
        dte,
        bid: callBid,
        ask: callAsk,
        last: 0, // ORATS does not provide last trade price
        mid: callMid,
        volume: row.callVolume ?? 0,
        openInterest: row.callOpenInterest ?? 0,
        iv: row.callMidIv ?? 0, // Already decimal (0.30 = 30%)
        delta: callDelta,
        gamma,
        theta,
        vega,
        underlyingPrice: stockPrice,
        inTheMoney: stockPrice > strike,
        probabilityITM: Math.abs(callDelta),  // P(ITM) ≈ |delta| (first-order BSM approximation)
        quoteUpdatedMs: updatedMs,
    });

    // Put option
    results.push({
        symbol: ticker,
        strike,
        type: 'Put',
        expiration,
        dte,
        bid: putBid,
        ask: putAsk,
        last: 0,
        mid: putMid,
        volume: row.putVolume ?? 0,
        openInterest: row.putOpenInterest ?? 0,
        iv: row.putMidIv ?? 0,
        delta: putDelta,
        gamma,
        theta,
        vega,
        underlyingPrice: stockPrice,
        inTheMoney: stockPrice < strike,
        probabilityITM: Math.abs(putDelta),  // P(ITM) ≈ |delta|
        quoteUpdatedMs: updatedMs,
    });

    return results;
}

// ── Exported functions ──────────────────────────────────────────────────────────

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
 * Fetch option chain with filters.
 * @param {string} ticker
 * @param {object} filters { minDte, maxDte, dte, expiration, side, minStrike, maxStrike }
 * @returns {Promise<object[]>} Normalized options array
 */
export async function getOptionChain(ticker, filters = {}) {
    const cacheKey = optionChainCacheKey(ticker, filters);
    const cached = optionChainCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < OPTION_CHAIN_CACHE_TTL_MS) {
        return cached.chain;
    }

    // Build ORATS query params
    const params = {
        ticker: ticker.toUpperCase(),
        fields: STRIKES_FIELDS,
    };

    // DTE filtering: ORATS accepts dte=MIN,MAX
    if (filters.minDte !== undefined || filters.maxDte !== undefined) {
        const minDte = filters.minDte ?? 0;
        const maxDte = filters.maxDte ?? 500;
        params.dte = `${minDte},${maxDte}`;
    }

    // Single DTE target → ±7 day range
    if (filters.dte !== undefined && filters.minDte === undefined && filters.maxDte === undefined) {
        const minDte = Math.max(0, filters.dte - 7);
        const maxDte = filters.dte + 7;
        params.dte = `${minDte},${maxDte}`;
    }

    // Specific expiration → post-filter (ORATS doesn't have expiration param on /strikes)
    // Strike range → post-filter
    // Side (call/put) → post-filter (ORATS returns both in each row)

    try {
        const data = await fetchORATS('/strikes', params);

        if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
            console.warn(`[ORATS] getOptionChain(${ticker}): no data returned`);
            return [];
        }

        // Flatten: each strike row → 2 normalized options (call + put)
        let chain = [];
        for (const row of data.data) {
            chain.push(...normalizeORATSStrike(row));
        }

        // Post-filters
        if (filters.expiration) {
            chain = chain.filter(o => o.expiration === filters.expiration);
        }
        if (filters.side) {
            const side = filters.side.toLowerCase();
            chain = chain.filter(o => o.type.toLowerCase() === side);
        }
        if (filters.minStrike !== undefined) {
            chain = chain.filter(o => o.strike >= filters.minStrike);
        }
        if (filters.maxStrike !== undefined) {
            chain = chain.filter(o => o.strike <= filters.maxStrike);
        }

        optionChainCache.set(cacheKey, { timestamp: Date.now(), chain });
        return chain;
    } catch (e) {
        console.error(`[ORATS] getOptionChain(${ticker}) error:`, e.message);
        return [];
    }
}

/**
 * Get underlying (stock) price for a ticker.
 * ORATS includes stockPrice in every /strikes response.
 * @param {string} ticker
 * @returns {Promise<number|null>}
 */
export async function getUnderlyingPrice(ticker) {
    try {
        // Lightweight call: fetch 1 strike row just to get stockPrice
        const data = await fetchORATS('/strikes', {
            ticker: ticker.toUpperCase(),
            fields: 'stockPrice,spotPrice',
            dte: '25,35', // narrow DTE range for minimal data
        });

        if (data.data && data.data.length > 0) {
            const price = data.data[0].stockPrice ?? data.data[0].spotPrice ?? null;
            if (typeof price === 'number' && price > 0) return price;
        }
    } catch (e) {
        console.warn('[ORATS] getUnderlyingPrice failed:', e?.message);
    }
    return null;
}

/**
 * Check quote freshness for a set of normalized options.
 * Reads quoteUpdatedMs from normalized chain to detect stale quotes.
 */
export function checkQuoteFreshness(chain, maxAgeMs = 5 * 60 * 1000) {
    const now = Date.now();
    const etNow = new Date(now);
    const utcH = etNow.getUTCHours();
    const utcM = etNow.getUTCMinutes();
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
        isStale: staleQuotes > chain.length * 0.5,
    };
}

// ── Bonus ORATS-specific exports (Phase 4 enrichment) ──────────────────────────

/**
 * Get core data (200+ fields: IV percentile, HV, earnings, dollar gamma, skew, correlations).
 * @param {string} ticker
 * @returns {Promise<object|null>}
 */
export async function getCores(ticker) {
    try {
        const data = await fetchORATS('/cores', { ticker: ticker.toUpperCase() });
        if (data.data && data.data.length > 0) return data.data[0];
    } catch (e) {
        console.warn('[ORATS] getCores failed:', e?.message);
    }
    return null;
}

/**
 * Get historical core data for a ticker.
 * @param {string} ticker
 * @param {string} [tradeDate] Specific date (YYYY-MM-DD) or omit for all history
 * @returns {Promise<object[]>}
 */
export async function getHistoricalCores(ticker, tradeDate) {
    try {
        const params = { ticker: ticker.toUpperCase() };
        if (tradeDate) params.tradeDate = tradeDate;
        const data = await fetchORATS('/hist/cores', params);
        return data.data || [];
    } catch (e) {
        console.warn('[ORATS] getHistoricalCores failed:', e?.message);
        return [];
    }
}
