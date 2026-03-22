/**
 * Option Chain Cache — SQLite + ORATS historical fetcher
 *
 * Fetches historical option chains from ORATS /hist/strikes and caches
 * them locally in SQLite. Historical data is immutable so once cached,
 * a (ticker, date) pair is never re-fetched.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ── Types ────────────────────────────────────────────────

export interface ChainRow {
  ticker: string;
  trade_date: string;
  expir_date: string;
  dte: number;
  strike: number;
  stock_price: number;
  call_bid: number;
  call_mid: number;
  call_ask: number;
  call_iv: number;
  call_volume: number;
  call_oi: number;
  put_bid: number;
  put_mid: number;
  put_ask: number;
  put_iv: number;
  put_volume: number;
  put_oi: number;
  delta: number;    // call-side delta; put delta = delta - 1
  gamma: number;
  theta: number;
  vega: number;
}

export interface StrikeMatch {
  row: ChainRow;
  type: 'Call' | 'Put';
  bid: number;
  ask: number;
  mid: number;
  iv: number;
  delta: number;   // signed delta (negative for puts)
  volume: number;
  oi: number;
}

export interface SpreadMatch {
  short: StrikeMatch;
  long: StrikeMatch;
  netCredit: number;
  requestedSpreadWidth?: number;
  spreadWidth: number;
  maxLoss: number;
}

// ── ORATS API ────────────────────────────────────────────

const ORATS_BASE = 'https://api.orats.io/datav2';
const ORATS_FIELDS = [
  'ticker', 'tradeDate', 'expirDate', 'dte', 'strike', 'stockPrice',
  'callBidPrice', 'callValue', 'callAskPrice',
  'putBidPrice', 'putValue', 'putAskPrice',
  'callMidIv', 'putMidIv',
  'callVolume', 'putVolume', 'callOpenInterest', 'putOpenInterest',
  'delta', 'gamma', 'theta', 'vega',
].join(',');

let _apiCallCount = 0;
export function getApiCallCount(): number { return _apiCallCount; }
export function resetApiCallCount(): void { _apiCallCount = 0; }

async function fetchORATSHistStrikes(
  token: string,
  ticker: string,
  tradeDate: string,
  deltaRange?: [number, number],
  dteRange?: [number, number],
): Promise<any[]> {
  const params = new URLSearchParams({
    token,
    ticker: ticker.toUpperCase(),
    tradeDate,
    fields: ORATS_FIELDS,
  });
  if (deltaRange) params.set('delta', `${deltaRange[0]},${deltaRange[1]}`);
  if (dteRange) params.set('dte', `${dteRange[0]},${dteRange[1]}`);

  const url = `${ORATS_BASE}/hist/strikes?${params}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ORATS hist/strikes ${res.status}: ${text}`);
  }

  _apiCallCount++;
  const json = await res.json();
  return json.data || [];
}

// ── SQLite Database ──────────────────────────────────────

let _db: Database.Database | null = null;
let _findContractStmt: Database.Statement | null = null;

export function initDB(dbPath?: string): Database.Database {
  if (_db) return _db;

  const resolvedPath = dbPath || path.resolve(process.cwd(), 'data', 'option-chains.sqlite');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(resolvedPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS option_chains (
      ticker TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      expir_date TEXT NOT NULL,
      dte INTEGER NOT NULL,
      strike REAL NOT NULL,
      stock_price REAL NOT NULL,
      call_bid REAL, call_mid REAL, call_ask REAL,
      call_iv REAL, call_volume INTEGER, call_oi INTEGER,
      put_bid REAL, put_mid REAL, put_ask REAL,
      put_iv REAL, put_volume INTEGER, put_oi INTEGER,
      delta REAL, gamma REAL, theta REAL, vega REAL,
      fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (ticker, trade_date, expir_date, strike)
    );
    CREATE INDEX IF NOT EXISTS idx_chain_lookup ON option_chains(ticker, trade_date, dte);
    CREATE INDEX IF NOT EXISTS idx_chain_delta ON option_chains(ticker, trade_date, delta);

    CREATE TABLE IF NOT EXISTS fetch_log (
      ticker TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      rows_fetched INTEGER,
      fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (ticker, trade_date)
    );
  `);

  // v2: ORATS cores cache for VRP, contango, slope, smvVol
  _db.exec(`
    CREATE TABLE IF NOT EXISTS orats_cores_cache (
      ticker TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      iv30 REAL,
      rv30 REAL,
      iv60 REAL,
      slope REAL,
      deriv REAL,
      smv_vol REAL,
      or_fcst_20d REAL,
      fcst_r2 REAL,
      contango REAL,
      vrp REAL,
      PRIMARY KEY (ticker, trade_date)
    );
  `);

  return _db;
}

export function closeDB(): void {
  _findContractStmt = null;
  if (_db) { _db.close(); _db = null; }
}

// ── Cache Operations ─────────────────────────────────────

function isCached(ticker: string, date: string): boolean {
  const db = initDB();
  const row = db.prepare('SELECT 1 FROM fetch_log WHERE ticker = ? AND trade_date = ?').get(ticker, date);
  return !!row;
}

function insertRows(rows: ChainRow[]): void {
  const db = initDB();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO option_chains
    (ticker, trade_date, expir_date, dte, strike, stock_price,
     call_bid, call_mid, call_ask, call_iv, call_volume, call_oi,
     put_bid, put_mid, put_ask, put_iv, put_volume, put_oi,
     delta, gamma, theta, vega)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const logInsert = db.prepare('INSERT OR REPLACE INTO fetch_log (ticker, trade_date, rows_fetched) VALUES (?, ?, ?)');

  const doInsert = db.transaction((r: ChainRow[]) => {
    for (const row of r) {
      insert.run(
        row.ticker, row.trade_date, row.expir_date, row.dte, row.strike, row.stock_price,
        row.call_bid, row.call_mid, row.call_ask, row.call_iv, row.call_volume, row.call_oi,
        row.put_bid, row.put_mid, row.put_ask, row.put_iv, row.put_volume, row.put_oi,
        row.delta, row.gamma, row.theta, row.vega,
      );
    }
    if (r.length > 0) {
      logInsert.run(r[0].ticker, r[0].trade_date, r.length);
    }
  });

  doInsert(rows);
}

function mapORATSRow(row: any): ChainRow {
  return {
    ticker: row.ticker,
    trade_date: row.tradeDate,
    expir_date: row.expirDate,
    dte: row.dte ?? 0,
    strike: row.strike ?? 0,
    stock_price: row.stockPrice ?? 0,
    call_bid: row.callBidPrice ?? 0,
    call_mid: row.callValue ?? 0,
    call_ask: row.callAskPrice ?? 0,
    call_iv: row.callMidIv ?? 0,
    call_volume: row.callVolume ?? 0,
    call_oi: row.callOpenInterest ?? 0,
    put_bid: row.putBidPrice ?? 0,
    put_mid: row.putValue ?? 0,
    put_ask: row.putAskPrice ?? 0,
    put_iv: row.putMidIv ?? 0,
    put_volume: row.putVolume ?? 0,
    put_oi: row.putOpenInterest ?? 0,
    delta: row.delta ?? 0,
    gamma: row.gamma ?? 0,
    theta: row.theta ?? 0,
    vega: row.vega ?? 0,
  };
}

// ── Public API ───────────────────────────────────────────

/**
 * Fetch historical chain for a ticker on a date.
 * Returns cached data if available, otherwise fetches from ORATS.
 */
export async function fetchHistoricalChain(
  token: string,
  ticker: string,
  date: string,
  deltaRange?: [number, number],
  dteRange?: [number, number],
): Promise<ChainRow[]> {
  // Check cache first
  if (isCached(ticker, date)) {
    return getCachedChain(ticker, date);
  }

  // Fetch from ORATS
  const rawRows = await fetchORATSHistStrikes(token, ticker, date, deltaRange, dteRange);
  if (rawRows.length === 0) {
    // Log empty fetch so we don't retry
    const db = initDB();
    db.prepare('INSERT OR REPLACE INTO fetch_log (ticker, trade_date, rows_fetched) VALUES (?, ?, 0)').run(ticker, date);
    return [];
  }

  const chainRows = rawRows.map(mapORATSRow);
  insertRows(chainRows);
  return chainRows;
}

/**
 * Get cached chain data from SQLite (no API call).
 */
export function getCachedChain(ticker: string, date: string): ChainRow[] {
  const db = initDB();
  return db.prepare(
    'SELECT * FROM option_chains WHERE ticker = ? AND trade_date = ? ORDER BY expir_date, strike'
  ).all(ticker, date) as ChainRow[];
}

/**
 * Cache-only chain read with optional delta/DTE filtering.
 * Returns [] if not cached. No API call — for WFA batch computation.
 */
export function getCachedChainFiltered(
  ticker: string,
  date: string,
  deltaRange?: [number, number],
  dteRange?: [number, number],
): ChainRow[] {
  if (!isCached(ticker, date)) return [];
  const rows = getCachedChain(ticker, date);
  return rows.filter(r => {
    if (deltaRange && (r.delta < deltaRange[0] || r.delta > deltaRange[1])) return false;
    if (dteRange && (r.dte < dteRange[0] || r.dte > dteRange[1])) return false;
    return true;
  });
}

/**
 * Find the best strike matching a target delta within a DTE range.
 * Returns the strike closest to targetDelta for the nearest monthly expiry in the DTE range.
 */
export function findStrikeByDelta(
  chain: ChainRow[],
  targetDelta: number,
  type: 'Call' | 'Put',
  dteRange: [number, number],
  minVolume: number = 0,
): StrikeMatch | null {
  // Filter by DTE range
  const filtered = chain.filter(r => r.dte >= dteRange[0] && r.dte <= dteRange[1]);
  if (filtered.length === 0) return null;

  // Prefer monthly expiries (3rd Friday) — find the most liquid expiry
  const byExpiry = new Map<string, ChainRow[]>();
  for (const r of filtered) {
    const arr = byExpiry.get(r.expir_date);
    if (arr) arr.push(r);
    else byExpiry.set(r.expir_date, [r]);
  }

  // Pick expiry with most OI (proxy for monthly)
  let bestExpiry: string | null = null;
  let bestOI = -1;
  for (const [exp, rows] of byExpiry) {
    const totalOI = rows.reduce((s, r) => s + (type === 'Call' ? r.call_oi : r.put_oi), 0);
    if (totalOI > bestOI) { bestOI = totalOI; bestExpiry = exp; }
  }
  if (!bestExpiry) return null;

  const expiryRows = byExpiry.get(bestExpiry)!;

  // Find closest delta to target
  let best: ChainRow | null = null;
  let bestDist = Infinity;
  for (const r of expiryRows) {
    const d = type === 'Call' ? r.delta : (r.delta - 1);
    const vol = type === 'Call' ? r.call_volume : r.put_volume;
    if (minVolume > 0 && vol < minVolume) continue;
    const dist = Math.abs(Math.abs(d) - Math.abs(targetDelta));
    if (dist < bestDist) { bestDist = dist; best = r; }
  }

  if (!best) return null;

  const isCall = type === 'Call';
  return {
    row: best,
    type,
    bid: isCall ? best.call_bid : best.put_bid,
    ask: isCall ? best.call_ask : best.put_ask,
    mid: isCall ? best.call_mid : best.put_mid,
    iv: isCall ? best.call_iv : best.put_iv,
    delta: isCall ? best.delta : (best.delta - 1),
    volume: isCall ? best.call_volume : best.put_volume,
    oi: isCall ? best.call_oi : best.put_oi,
  };
}

/**
 * Find short + long legs for a credit spread.
 * Short leg at shortDelta, long leg `width` points further OTM.
 */
export function findSpreadStrikes(
  chain: ChainRow[],
  shortDelta: number,
  width: number,
  type: 'Call' | 'Put',
  dteRange: [number, number],
  minVolume: number = 0,
): SpreadMatch | null {
  const shortLeg = findStrikeByDelta(chain, shortDelta, type, dteRange, minVolume);
  if (!shortLeg) return null;

  // Find long leg (wing) — further OTM by `width` dollars
  const longStrike = type === 'Put'
    ? shortLeg.row.strike - width
    : shortLeg.row.strike + width;

  // Find the closest strike to the target long strike in the same expiry
  const expiryRows = chain.filter(r =>
    r.expir_date === shortLeg.row.expir_date &&
    r.dte >= dteRange[0] && r.dte <= dteRange[1]
  );

  let bestLong: ChainRow | null = null;
  let bestDist = Infinity;
  for (const r of expiryRows) {
    const dist = Math.abs(r.strike - longStrike);
    if (dist < bestDist) { bestDist = dist; bestLong = r; }
  }

  if (!bestLong || bestLong.strike === shortLeg.row.strike) return null;

  const isCall = type === 'Call';
  const longMatch: StrikeMatch = {
    row: bestLong,
    type,
    bid: isCall ? bestLong.call_bid : bestLong.put_bid,
    ask: isCall ? bestLong.call_ask : bestLong.put_ask,
    mid: isCall ? bestLong.call_mid : bestLong.put_mid,
    iv: isCall ? bestLong.call_iv : bestLong.put_iv,
    delta: isCall ? bestLong.delta : (bestLong.delta - 1),
    volume: isCall ? bestLong.call_volume : bestLong.put_volume,
    oi: isCall ? bestLong.call_oi : bestLong.put_oi,
  };

  const netCredit = shortLeg.mid - longMatch.mid;
  const actualWidth = Math.abs(shortLeg.row.strike - bestLong.strike);

  if (netCredit <= 0) return null; // No credit = no trade

  return {
    short: shortLeg,
    long: longMatch,
    netCredit,
    requestedSpreadWidth: width,
    spreadWidth: actualWidth,
    maxLoss: actualWidth - netCredit,
  };
}

/**
 * Prefetch chains for a list of dates (with progress callback).
 */
export async function prefetchDates(
  token: string,
  ticker: string,
  dates: string[],
  deltaRange?: [number, number],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let fetched = 0;
  for (let i = 0; i < dates.length; i++) {
    if (!isCached(ticker, dates[i])) {
      await fetchHistoricalChain(token, ticker, dates[i], deltaRange);
      fetched++;
      // Rate limiting: pause briefly between calls
      if (fetched % 50 === 0) await new Promise(r => setTimeout(r, 1000));
    }
    onProgress?.(i + 1, dates.length);
  }
  return fetched;
}

/**
 * Batch fetch chains for multiple tickers on a single date (1 API call).
 * ORATS accepts comma-delimited tickers.
 */
export async function fetchMultiTickerChain(
  token: string,
  tickers: string[],
  date: string,
  deltaRange?: [number, number],
): Promise<Map<string, ChainRow[]>> {
  const result = new Map<string, ChainRow[]>();

  // Check which tickers need fetching
  const needed: string[] = [];
  for (const t of tickers) {
    if (isCached(t, date)) {
      result.set(t, getCachedChain(t, date));
    } else {
      needed.push(t);
    }
  }

  if (needed.length === 0) return result;

  // Fetch all needed tickers in 1 API call
  const rawRows = await fetchORATSHistStrikes(
    token,
    needed.join(','),
    date,
    deltaRange,
  );

  // Group by ticker and cache
  const byTicker = new Map<string, any[]>();
  for (const row of rawRows) {
    const t = row.ticker;
    if (!byTicker.has(t)) byTicker.set(t, []);
    byTicker.get(t)!.push(row);
  }

  for (const t of needed) {
    const rows = byTicker.get(t) || [];
    const chainRows = rows.map(mapORATSRow);
    if (chainRows.length > 0) {
      insertRows(chainRows);
    } else {
      // Log empty fetch
      const db = initDB();
      db.prepare('INSERT OR REPLACE INTO fetch_log (ticker, trade_date, rows_fetched) VALUES (?, ?, 0)').run(t, date);
    }
    result.set(t, chainRows);
  }

  return result;
}

/**
 * Prefetch all dates for multiple tickers. Uses multi-ticker batching.
 * Returns number of API calls made.
 */
export async function prefetchAll(
  token: string,
  tickers: string[],
  dates: string[],
  deltaRange?: [number, number],
  onProgress?: (done: number, total: number, apiCalls: number) => void,
  concurrency: number = 5,
): Promise<number> {
  let apiCalls = 0;

  // Find dates that need any fetching
  const datesToFetch: string[] = [];
  for (const date of dates) {
    const allCached = tickers.every(t => isCached(t, date));
    if (!allCached) datesToFetch.push(date);
  }

  if (datesToFetch.length === 0) {
    onProgress?.(dates.length, dates.length, 0);
    return 0;
  }

  // Process in concurrent batches
  for (let i = 0; i < datesToFetch.length; i += concurrency) {
    const batch = datesToFetch.slice(i, i + concurrency);
    const promises = batch.map(date =>
      fetchMultiTickerChain(token, tickers, date, deltaRange)
    );
    await Promise.all(promises);
    apiCalls += batch.length;
    onProgress?.(Math.min(i + concurrency, datesToFetch.length), datesToFetch.length, apiCalls);
  }

  return apiCalls;
}

/**
 * Get cache stats.
 */
export function getCacheStats(): { totalRows: number; totalDates: number; tickers: string[] } {
  const db = initDB();
  const rowCount = (db.prepare('SELECT COUNT(*) as c FROM option_chains').get() as any).c;
  const dateCount = (db.prepare('SELECT COUNT(*) as c FROM fetch_log').get() as any).c;
  const tickerRows = db.prepare('SELECT DISTINCT ticker FROM fetch_log ORDER BY ticker').all() as { ticker: string }[];
  return {
    totalRows: rowCount,
    totalDates: dateCount,
    tickers: tickerRows.map(r => r.ticker),
  };
}

/**
 * Look up a specific contract on a specific date.
 * Used for monitoring/exit: find the same strike+expiry on a later date.
 */
export function findContract(
  chain: ChainRow[],
  strike: number,
  expiry: string,
  type: 'Call' | 'Put',
): StrikeMatch | null {
  const row = chain.find(r => r.expir_date === expiry && Math.abs(r.strike - strike) < 0.01);
  if (!row) return null;

  const isCall = type === 'Call';
  return {
    row,
    type,
    bid: isCall ? row.call_bid : row.put_bid,
    ask: isCall ? row.call_ask : row.put_ask,
    mid: isCall ? row.call_mid : row.put_mid,
    iv: isCall ? row.call_iv : row.put_iv,
    delta: isCall ? row.delta : (row.delta - 1),
    volume: isCall ? row.call_volume : row.put_volume,
    oi: isCall ? row.call_oi : row.put_oi,
  };
}

/**
 * Direct SQL lookup for a specific contract (strike + expiry) on a given date.
 * Uses the PRIMARY KEY index — O(1) vs getCachedChain+findContract which loads
 * the entire chain (~3K rows) then filters. ~3000x less data for monitoring loops.
 */
export function findContractDirect(
  ticker: string,
  date: string,
  strike: number,
  expiry: string,
  type: 'Call' | 'Put',
): StrikeMatch | null {
  const db = initDB();
  if (!_findContractStmt) {
    _findContractStmt = db.prepare(
      'SELECT * FROM option_chains WHERE ticker = ? AND trade_date = ? AND expir_date = ? AND strike BETWEEN ? AND ? LIMIT 1',
    );
  }
  const row = _findContractStmt.get(ticker, date, expiry, strike - 0.01, strike + 0.01) as ChainRow | undefined;
  if (!row) return null;

  const isCall = type === 'Call';
  return {
    row,
    type,
    bid: isCall ? row.call_bid : row.put_bid,
    ask: isCall ? row.call_ask : row.put_ask,
    mid: isCall ? row.call_mid : row.put_mid,
    iv: isCall ? row.call_iv : row.put_iv,
    delta: isCall ? row.delta : (row.delta - 1),
    volume: isCall ? row.call_volume : row.put_volume,
    oi: isCall ? row.call_oi : row.put_oi,
  };
}

// ── ORATS Cores Cache (v2) ──────────────────────────────

export interface ORATSCoresRow {
  ticker: string;
  trade_date: string;
  iv30: number;
  rv30: number;
  iv60: number;
  slope: number;
  deriv: number;
  smv_vol: number;
  or_fcst_20d: number;
  fcst_r2: number;
  contango: number;
  vrp: number;
}

const ORATS_CORES_FIELDS = [
  'ticker', 'tradeDate',
  'iv30d', 'orHv30d', 'iv60d',
  'slope', 'deriv', 'smvVol',
  'orFcst20d', 'fcstR2',
].join(',');

function isCoresCached(ticker: string, date: string): boolean {
  const db = initDB();
  const row = db.prepare('SELECT 1 FROM orats_cores_cache WHERE ticker = ? AND trade_date = ?').get(ticker, date);
  return !!row;
}

function mapORATSCoresRow(row: any): ORATSCoresRow {
  const iv30 = row.iv30d ?? 0;
  const rv30 = row.orHv30d ?? 0;
  const iv60 = row.iv60d ?? 0;
  return {
    ticker: row.ticker,
    trade_date: row.tradeDate,
    iv30,
    rv30,
    iv60,
    slope: row.slope ?? 0,
    deriv: row.deriv ?? 0,
    smv_vol: row.smvVol ?? 0,
    or_fcst_20d: row.orFcst20d ?? 0,
    fcst_r2: row.fcstR2 ?? 0,
    contango: iv30 > 0 ? (iv60 / iv30) - 1 : 0,
    vrp: (iv30 * iv30) - (rv30 * rv30),
  };
}

/**
 * Fetch ORATS cores data for a ticker on a date.
 * Returns cached data if available, otherwise fetches from ORATS /hist/cores.
 */
export async function fetchHistoricalCores(
  token: string,
  ticker: string,
  date: string,
): Promise<ORATSCoresRow | null> {
  if (isCoresCached(ticker, date)) {
    return getCachedCores(ticker, date);
  }

  const params = new URLSearchParams({
    token,
    ticker: ticker.toUpperCase(),
    tradeDate: date,
    fields: ORATS_CORES_FIELDS,
  });

  const url = `${ORATS_BASE}/hist/cores?${params}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!res.ok) {
    return null;
  }

  _apiCallCount++;
  const json = await res.json();
  const data = json.data || [];
  if (data.length === 0) return null;

  const coresRow = mapORATSCoresRow(data[0]);
  insertCoresRow(coresRow);
  return coresRow;
}

function insertCoresRow(row: ORATSCoresRow): void {
  const db = initDB();
  db.prepare(`
    INSERT OR REPLACE INTO orats_cores_cache
    (ticker, trade_date, iv30, rv30, iv60, slope, deriv, smv_vol, or_fcst_20d, fcst_r2, contango, vrp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.ticker, row.trade_date, row.iv30, row.rv30, row.iv60,
    row.slope, row.deriv, row.smv_vol, row.or_fcst_20d, row.fcst_r2,
    row.contango, row.vrp,
  );
}

/**
 * Get cached cores data (no API call).
 */
export function getCachedCores(ticker: string, date: string): ORATSCoresRow | null {
  const db = initDB();
  const row = db.prepare(
    'SELECT * FROM orats_cores_cache WHERE ticker = ? AND trade_date = ?'
  ).get(ticker, date) as ORATSCoresRow | undefined;
  return row ?? null;
}

/**
 * Get all cached cores for a ticker in a date range.
 */
export function getCachedCoresRange(
  ticker: string,
  startDate: string,
  endDate: string,
): ORATSCoresRow[] {
  const db = initDB();
  return db.prepare(
    'SELECT * FROM orats_cores_cache WHERE ticker = ? AND trade_date >= ? AND trade_date <= ? ORDER BY trade_date'
  ).all(ticker, startDate, endDate) as ORATSCoresRow[];
}

/**
 * Batch prefetch cores for multiple tickers across a date range.
 */
export async function prefetchCoresAll(
  token: string,
  tickers: string[],
  dates: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let fetched = 0;
  const total = tickers.length * dates.length;
  let done = 0;

  for (const ticker of tickers) {
    for (const date of dates) {
      if (!isCoresCached(ticker, date)) {
        await fetchHistoricalCores(token, ticker, date);
        fetched++;
        if (fetched % 50 === 0) await new Promise(r => setTimeout(r, 1000));
      }
      done++;
      onProgress?.(done, total);
    }
  }
  return fetched;
}
