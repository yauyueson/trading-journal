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
