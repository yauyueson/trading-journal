/**
 * Phase 1.g — DTE-range coverage on the chain cache.
 *
 * Before this phase, `fetch_log` was keyed on (ticker, trade_date) only,
 * so a fetch with `dteRange: [60, 330]` would mark the pair "cached" even
 * though a later caller requesting `dteRange: [2, 7]` would receive the
 * stale 60-330 slice. The production prefetch script's default range is
 * `[60, 330]`, so any new strategy with a different DTE band (DTE5 @ 2-7,
 * BXM @ 25-40) would silently hit incomplete cache.
 *
 * These tests stub `global.fetch` so we can control ORATS responses, point
 * the cache at a tmp SQLite DB, and verify that:
 *   1. A narrow fetch populates the cache and stamps the DTE range.
 *   2. A second call with the same range hits cache (no API call).
 *   3. A second call with a range NOT covered triggers a re-fetch.
 *   4. A second call with a sub-range of the first hits cache.
 *   5. A legacy NULL/NULL entry (pre-migration behavior) covers anything.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  initDB,
  closeDB,
  fetchHistoricalChain,
  getCachedChain,
  getApiCallCount,
  resetApiCallCount,
  clearFetchLogEntries,
} from '../src/lib/backtest/chain-cache';

interface OratsRow {
  ticker: string;
  tradeDate: string;
  expirDate: string;
  dte: number;
  strike: number;
  stockPrice: number;
  callBidPrice: number;
  callValue: number;
  callAskPrice: number;
  callMidIv: number;
  callSmvVol: number;
  callVolume: number;
  callOpenInterest: number;
  putBidPrice: number;
  putValue: number;
  putAskPrice: number;
  putMidIv: number;
  putSmvVol: number;
  putVolume: number;
  putOpenInterest: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

function makeOratsRow(
  ticker: string,
  tradeDate: string,
  dte: number,
  strike: number,
  expirDate?: string,
): OratsRow {
  // Synthetic expiry: T + dte days (used only to keep PKs distinct so
  // two different-DTE rows don't collide on option_chains' natural key).
  const exp = expirDate ?? (() => {
    const d = new Date(tradeDate);
    d.setUTCDate(d.getUTCDate() + dte);
    return d.toISOString().slice(0, 10);
  })();
  return {
    ticker,
    tradeDate,
    expirDate: exp,
    dte,
    strike,
    stockPrice: 450,
    callBidPrice: 5, callValue: 5.1, callAskPrice: 5.2, callMidIv: 0.2, callSmvVol: 0.2,
    callVolume: 100, callOpenInterest: 200,
    putBidPrice: 4, putValue: 4.1, putAskPrice: 4.2, putMidIv: 0.2, putSmvVol: 0.2,
    putVolume: 100, putOpenInterest: 200,
    delta: 0.5, gamma: 0.01, theta: -0.1, vega: 0.05,
  };
}

function makeOratsResponse(rows: OratsRow[]): { data: OratsRow[] } {
  return { data: rows };
}

describe('chain-cache DTE-range coverage (Phase 1.g)', () => {
  let tmpDir: string;
  let dbPath: string;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeDB(); // make sure we're not inheriting a previous test's singleton
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-cache-test-'));
    dbPath = path.join(tmpDir, 'chain.sqlite');
    initDB(dbPath);
    resetApiCallCount();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    closeDB();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stamps the requested DTE range on fetch_log_intervals after a narrow fetch', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 30, 450)]),
    } as unknown as Response);

    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [25, 40]);

    expect(getApiCallCount()).toBe(1);
    const db = new Database(dbPath, { readonly: true });
    const intervals = db.prepare(
      'SELECT dte_min, dte_max FROM fetch_log_intervals WHERE ticker=? AND trade_date=? ORDER BY dte_min',
    ).all('SPY', '2024-01-02') as { dte_min: number; dte_max: number }[];
    db.close();
    expect(intervals).toEqual([{ dte_min: 25, dte_max: 40 }]);
  });

  it('hits cache on a second call with the same DTE range', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 30, 450)]),
    } as unknown as Response);

    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [25, 40]);
    expect(getApiCallCount()).toBe(1);

    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [25, 40]);
    expect(getApiCallCount()).toBe(1); // no additional call
  });

  it('re-fetches when the new range is OUTSIDE the cached range', async () => {
    // First fetch: DTE [25, 40] — narrow slice.
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 30, 450)]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [25, 40]);
    expect(getApiCallCount()).toBe(1);

    // Second call: DTE [2, 7] — not covered. Expect another API call.
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 5, 450)]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [2, 7]);
    expect(getApiCallCount()).toBe(2);

    // Both intervals recorded separately — no false-union envelope.
    const db = new Database(dbPath, { readonly: true });
    const intervals = db.prepare(
      'SELECT dte_min, dte_max FROM fetch_log_intervals WHERE ticker=? AND trade_date=? ORDER BY dte_min',
    ).all('SPY', '2024-01-02') as { dte_min: number; dte_max: number }[];
    db.close();
    expect(intervals).toEqual([
      { dte_min: 2, dte_max: 7 },
      { dte_min: 25, dte_max: 40 },
    ]);

    // Both rows now live in option_chains.
    const rows = getCachedChain('SPY', '2024-01-02');
    const dtes = rows.map(r => r.dte).sort((a, b) => a - b);
    expect(dtes).toEqual([5, 30]);
  });

  it('does NOT report the middle of two disjoint fetches as covered', async () => {
    // Codex round-14 Finding 1: [7, 21] + [45, 65] MUST NOT imply [25, 40]
    // is covered. Single-envelope union would have flagged it TRUE.
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 14, 450)]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [7, 21]);

    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 55, 450)]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [45, 65]);

    expect(getApiCallCount()).toBe(2);

    // Requesting the middle band — neither interval covers it, must re-fetch.
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 32, 450)]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [25, 40]);
    expect(getApiCallCount()).toBe(3);
  });

  it('preserves rows_fetched when a side-band fetch returns empty', async () => {
    // Codex round-14 Finding 2: `rows_fetched` must not regress to 0 when a
    // later empty side-band fetch touches a populated date (or consumers
    // like scripts/repair-truncated-chains.ts mark good dates as broken).
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([
        makeOratsRow('SPY', '2024-01-02', 30, 445),
        makeOratsRow('SPY', '2024-01-02', 30, 450),
        makeOratsRow('SPY', '2024-01-02', 30, 455),
      ]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [25, 40]);

    // Empty side-band fetch.
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [2, 7]);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT rows_fetched FROM fetch_log WHERE ticker=? AND trade_date=?')
      .get('SPY', '2024-01-02') as { rows_fetched: number };
    db.close();
    expect(row.rows_fetched).toBe(3); // preserved; NOT overwritten to 0
  });

  it('hits cache when the new range is a SUB-range of the cached one', async () => {
    // First fetch: wide range [5, 60].
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([
        makeOratsRow('SPY', '2024-01-02', 10, 450),
        makeOratsRow('SPY', '2024-01-02', 30, 450),
        makeOratsRow('SPY', '2024-01-02', 50, 450),
      ]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [5, 60]);
    expect(getApiCallCount()).toBe(1);

    // Second call: narrow sub-range [20, 40]. Covered.
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [20, 40]);
    expect(getApiCallCount()).toBe(1); // no additional call
  });

  it('re-fetches when the caller wants the full chain but we only have a partial slice', async () => {
    // First fetch: narrow [25, 40].
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 30, 450)]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [25, 40]);
    expect(getApiCallCount()).toBe(1);

    // Second call: no DTE filter (wants everything). Must not be satisfied
    // by the partial cached entry.
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 30, 450)]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02');
    expect(getApiCallCount()).toBe(2);

    // After the second fetch, the interval list has both the narrow row
    // AND a NULL/NULL row (recording the full fetch). The fetch_log row
    // preserves the NULL/NULL stamp (doesn't narrow back to [25, 40]).
    const db = new Database(dbPath, { readonly: true });
    const intervals = db.prepare(
      'SELECT dte_min, dte_max FROM fetch_log_intervals WHERE ticker=? AND trade_date=? ORDER BY dte_min IS NULL DESC, dte_min',
    ).all('SPY', '2024-01-02') as { dte_min: number | null; dte_max: number | null }[];
    const flRow = db.prepare('SELECT dte_min, dte_max FROM fetch_log WHERE ticker=? AND trade_date=?')
      .get('SPY', '2024-01-02') as { dte_min: number | null; dte_max: number | null };
    db.close();
    expect(intervals).toContainEqual({ dte_min: null, dte_max: null });
    expect(intervals).toContainEqual({ dte_min: 25, dte_max: 40 });
    expect(flRow.dte_min).toBeNull();
    expect(flRow.dte_max).toBeNull();
  });

  it('backfills fetch_log_intervals from existing fetch_log on first upgrade (Codex r15 F1)', async () => {
    // Simulate a pre-Phase-1.h DB state: fetch_log has a 1.g envelope row,
    // no fetch_log_intervals table. Easiest way is to close our current DB,
    // craft one by hand, then re-open through initDB so the migration runs.
    closeDB();
    fs.rmSync(dbPath, { force: true });

    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE fetch_log (
        ticker TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        rows_fetched INTEGER,
        dte_min INTEGER,
        dte_max INTEGER,
        fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ticker, trade_date)
      );
    `);
    raw.prepare('INSERT INTO fetch_log (ticker, trade_date, rows_fetched, dte_min, dte_max) VALUES (?,?,?,?,?)')
      .run('SPY', '2024-01-02', 50, 25, 40);
    raw.prepare('INSERT INTO fetch_log (ticker, trade_date, rows_fetched, dte_min, dte_max) VALUES (?,?,?,?,?)')
      .run('SPY', '2024-01-03', 200, null, null);  // legacy full-coverage
    raw.close();

    // Re-open via initDB — this runs the Phase 1.h migration.
    initDB(dbPath);

    const ro = new Database(dbPath, { readonly: true });
    const intervals = ro.prepare(
      'SELECT ticker, trade_date, dte_min, dte_max FROM fetch_log_intervals ORDER BY trade_date, dte_min IS NULL DESC',
    ).all() as { ticker: string; trade_date: string; dte_min: number | null; dte_max: number | null }[];
    ro.close();
    expect(intervals).toEqual([
      { ticker: 'SPY', trade_date: '2024-01-02', dte_min: 25, dte_max: 40 },
      { ticker: 'SPY', trade_date: '2024-01-03', dte_min: null, dte_max: null },
    ]);

    // Coverage check: 1.g envelope entry still hits for its range.
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [25, 40]);
    expect(getApiCallCount()).toBe(0);

    // Legacy NULL/NULL entry still hits for anything.
    await fetchHistoricalChain('tok', 'SPY', '2024-01-03', undefined, [2, 7]);
    expect(getApiCallCount()).toBe(0);
  });

  it('re-runs backfill on upgrade from broken early-1.h (empty interval table) (Codex r16 F1)', async () => {
    // Simulate the state left behind by the broken early Phase 1.h build:
    // fetch_log_intervals exists but is EMPTY, while fetch_log has the 1.g
    // envelope. The first 1.i build's `hadIntervalsBeforeCreate` guard
    // would skip backfill for these users. The fix: always INSERT OR IGNORE,
    // which is idempotent on already-migrated DBs and a no-op on already-
    // backfilled ones.
    closeDB();
    fs.rmSync(dbPath, { force: true });

    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE fetch_log (
        ticker TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        rows_fetched INTEGER,
        dte_min INTEGER,
        dte_max INTEGER,
        fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ticker, trade_date)
      );
      CREATE TABLE fetch_log_intervals (
        ticker TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        dte_min INTEGER,
        dte_max INTEGER,
        fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (ticker, trade_date, dte_min, dte_max)
      );
    `);
    raw.prepare('INSERT INTO fetch_log (ticker, trade_date, rows_fetched, dte_min, dte_max) VALUES (?,?,?,?,?)')
      .run('SPY', '2024-01-02', 50, 25, 40);
    raw.close();

    initDB(dbPath);

    // Backfill should have populated the previously-empty interval table.
    const ro = new Database(dbPath, { readonly: true });
    const intervals = ro.prepare(
      'SELECT dte_min, dte_max FROM fetch_log_intervals WHERE ticker=? AND trade_date=?',
    ).all('SPY', '2024-01-02') as { dte_min: number; dte_max: number }[];
    ro.close();
    expect(intervals).toEqual([{ dte_min: 25, dte_max: 40 }]);

    // Coverage check confirms no re-fetch happens for the backfilled range.
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [25, 40]);
    expect(getApiCallCount()).toBe(0);
  });

  it('clearFetchLogEntries wipes both tables so recovery retries re-fetch (Codex r15 F2)', async () => {
    // Populate cache with a zero-row fetch (simulating a truncated response).
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [60, 330]);
    expect(getApiCallCount()).toBe(1);

    // Second call on the same range HITS the cached empty interval.
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [60, 330]);
    expect(getApiCallCount()).toBe(1);

    // Repair flow: clear both tables; next call re-fetches.
    clearFetchLogEntries('SPY', '2024-01-02');
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 90, 450)]),
    } as unknown as Response);
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [60, 330]);
    expect(getApiCallCount()).toBe(2);

    // Verify cleared BOTH tables by inspecting the DB.
    const db = new Database(dbPath, { readonly: true });
    const flCount = db.prepare(
      'SELECT COUNT(*) AS n FROM fetch_log WHERE ticker=? AND trade_date=?',
    ).get('SPY', '2024-01-02') as { n: number };
    // fetch_log now has the new successful fetch.
    expect(flCount.n).toBe(1);
    // fetch_log_intervals should have exactly ONE row — the new [60, 330]
    // entry. The stale empty-range interval from before the clear was
    // removed.
    const intervalCount = db.prepare(
      'SELECT COUNT(*) AS n FROM fetch_log_intervals WHERE ticker=? AND trade_date=?',
    ).get('SPY', '2024-01-02') as { n: number };
    db.close();
    expect(intervalCount.n).toBe(1);
  });

  it('migration backfill stays idempotent across many initDB/closeDB cycles (Codex r17 F1)', async () => {
    // SQLite UNIQUE treats NULLs as distinct, so a naive INSERT OR IGNORE
    // would append a fresh (NULL, NULL) row every open. Seed a legacy
    // full-coverage row AND a narrow-range row, reopen the DB 5 times,
    // and confirm neither table grows.
    closeDB();
    fs.rmSync(dbPath, { force: true });

    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE fetch_log (
        ticker TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        rows_fetched INTEGER,
        dte_min INTEGER,
        dte_max INTEGER,
        fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ticker, trade_date)
      );
    `);
    raw.prepare('INSERT INTO fetch_log (ticker, trade_date, rows_fetched, dte_min, dte_max) VALUES (?,?,?,?,?)')
      .run('SPY', '2024-01-02', 200, null, null);
    raw.prepare('INSERT INTO fetch_log (ticker, trade_date, rows_fetched, dte_min, dte_max) VALUES (?,?,?,?,?)')
      .run('SPY', '2024-01-03', 50, 25, 40);
    raw.close();

    // Reopen five times — backfill runs each time.
    for (let i = 0; i < 5; i++) {
      initDB(dbPath);
      closeDB();
    }

    const ro = new Database(dbPath, { readonly: true });
    const nullRows = ro.prepare(
      'SELECT COUNT(*) AS n FROM fetch_log_intervals WHERE ticker=? AND trade_date=? AND dte_min IS NULL AND dte_max IS NULL',
    ).get('SPY', '2024-01-02') as { n: number };
    const rangeRows = ro.prepare(
      'SELECT COUNT(*) AS n FROM fetch_log_intervals WHERE ticker=? AND trade_date=? AND dte_min=? AND dte_max=?',
    ).get('SPY', '2024-01-03', 25, 40) as { n: number };
    ro.close();
    expect(nullRows.n).toBe(1);
    expect(rangeRows.n).toBe(1);
  });

  it('upsertFetchLog is idempotent for full-range fetches (Codex r17 F1)', async () => {
    // A full-range fetch (no dteRange) writes dte_min=NULL, dte_max=NULL to
    // fetch_log_intervals. Repeated fetches must not append duplicate
    // NULL/NULL rows.
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => makeOratsResponse([makeOratsRow('SPY', '2024-01-02', 30, 450)]),
    } as unknown as Response);

    // Three fetches with no dteRange → three full fetches. But the cached
    // full-coverage row should cover them all; only the first hits ORATS.
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02');
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02');
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02');
    expect(getApiCallCount()).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    const nullCount = db.prepare(
      'SELECT COUNT(*) AS n FROM fetch_log_intervals WHERE ticker=? AND trade_date=? AND dte_min IS NULL AND dte_max IS NULL',
    ).get('SPY', '2024-01-02') as { n: number };
    db.close();
    expect(nullCount.n).toBe(1);
  });

  it('treats legacy NULL/NULL entries as full-coverage hits for backward compat', async () => {
    // Simulate an entry inserted by a pre-Phase-1.g cache: rows in
    // option_chains but fetch_log has NULL dte_min/dte_max.
    const db = new Database(dbPath);
    db.prepare(`
      INSERT INTO option_chains (ticker, trade_date, expir_date, dte, strike, stock_price,
        call_bid, call_mid, call_ask, call_iv, call_volume, call_oi,
        put_bid, put_mid, put_ask, put_iv, put_volume, put_oi,
        delta, gamma, theta, vega)
      VALUES ('SPY','2024-01-02','2024-02-16',30,450,450, 5,5.1,5.2,0.2,100,200, 4,4.1,4.2,0.2,100,200, 0.5,0.01,-0.1,0.05)
    `).run();
    db.prepare('INSERT INTO fetch_log (ticker, trade_date, rows_fetched, dte_min, dte_max) VALUES (?, ?, 1, NULL, NULL)')
      .run('SPY', '2024-01-02');
    db.close();

    // Even though fetch_log lacks a range, the legacy entry should satisfy
    // any request — simulates existing production caches.
    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [2, 7]);
    expect(getApiCallCount()).toBe(0); // no API call — legacy coverage

    await fetchHistoricalChain('tok', 'SPY', '2024-01-02', undefined, [60, 330]);
    expect(getApiCallCount()).toBe(0);

    await fetchHistoricalChain('tok', 'SPY', '2024-01-02'); // no range
    expect(getApiCallCount()).toBe(0);
  });
});
