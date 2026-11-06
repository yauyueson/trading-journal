import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLocalSwingTickerData,
  isNyseHoliday,
  loadDailyCandlesFromIntradayCache,
  loadIVDataFromOptionChainCache,
  nyseSessionCloseHourET,
} from '../scripts/wfa-local-cache';
import { fetchTickerData as fetchSwingTickerData } from '../scripts/wfa-pipeline-swing';
import { fetchTickerData as fetchShortTickerData } from '../scripts/wfa-pipeline-short';
import { initIntradayDB } from '../src/lib/backtest/intraday-cache';

function createIntradayDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE candles_1h (
      ticker TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      datetime TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL
    );
    CREATE VIEW candles_130m AS
      SELECT ticker, timestamp, datetime, date, 0 AS block, open, high, low, close, volume
      FROM candles_1h;
  `);
  const insert = db.prepare(`
    INSERT INTO candles_1h (ticker, timestamp, datetime, date, open, high, low, close, volume)
    VALUES ('QQQ', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(1000, '2026-01-02 14:30:00', '2026-01-02', 400, 405, 399, 404, 1000);
  insert.run(2000, '2026-01-02 15:30:00', '2026-01-02', 404, 406, 403, 405, 1100);
  insert.run(3000, '2026-01-05 14:30:00', '2026-01-05', 405, 408, 404, 407, 1200);
  insert.run(4000, '2026-01-06 14:30:00', '2026-01-06', 407, 409, 406, 408, 1300);
  db.close();
}

function createChainDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE option_chains (
      ticker TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      expir_date TEXT NOT NULL,
      dte INTEGER NOT NULL,
      strike REAL NOT NULL,
      stock_price REAL NOT NULL,
      call_iv REAL,
      put_iv REAL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO option_chains (ticker, trade_date, expir_date, dte, strike, stock_price, call_iv, put_iv)
    VALUES ('QQQ', ?, ?, ?, ?, 405, ?, ?)
  `);
  for (const date of ['2026-01-02', '2026-01-05', '2026-01-06']) {
    insert.run(date, '2026-02-06', 30, 405, 0.20, 0.22);
    insert.run(date, '2026-03-06', 60, 405, 0.24, 0.26);
  }
  db.close();
}

describe('WFA local cache inputs', () => {
  let tmpDir: string;
  let intradayDbPath: string;
  let chainDbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-local-cache-'));
    intradayDbPath = path.join(tmpDir, 'intraday-candles.sqlite');
    chainDbPath = path.join(tmpDir, 'option-chains.sqlite');
    createIntradayDb(intradayDbPath);
    createChainDb(chainDbPath);
    process.env.WFA_INTRADAY_DB_PATH = intradayDbPath;
    process.env.WFA_CHAIN_DB_PATH = chainDbPath;
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('WFA local cache loader must not fetch');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WFA_INTRADAY_DB_PATH;
    delete process.env.WFA_CHAIN_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds swing ticker data from local SQLite caches without fetching', () => {
    const td = buildLocalSwingTickerData({
      ticker: 'QQQ',
      dataStart: '2026-01-02',
      dataEnd: '2026-01-06',
      intradayDbPath,
      chainDbPath,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(td.candles).toHaveLength(3);
    expect(td.candles[0]).toMatchObject({
      date: '2026-01-02',
      open: 400,
      high: 406,
      low: 399,
      close: 405,
      volume: 2100,
    });
    expect(td.dateToIdx.get('2026-01-06')).toBe(2);
    expect(td.regimeByDate.get('2026-01-02')).toMatchObject({
      contango: expect.any(Number),
    });
  });

  it('loads IV rows from option-chain cache with 30D/60D and realized-vol fields', () => {
    const rows = loadIVDataFromOptionChainCache({
      ticker: 'QQQ',
      startDate: '2026-01-02',
      endDate: '2026-01-06',
      chainDbPath,
      dailyCandles: [
        { date: '2026-01-02', close: 405 },
        { date: '2026-01-05', close: 407 },
        { date: '2026-01-06', close: 408 },
      ],
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      date: '2026-01-02',
      iv30d: 0.21,
      iv60d: 0.25,
    });
    expect(rows[2].hv20d).toBeGreaterThan(0);
    expect(rows[2].hv30d).toBeGreaterThan(0);
  });

  it('uses nearest cached DTE rows for IV60 instead of requiring an exact 55-65 DTE bucket', () => {
    const db = new Database(chainDbPath);
    db.prepare('DELETE FROM option_chains WHERE dte = 60').run();
    const insert = db.prepare(`
      INSERT INTO option_chains (ticker, trade_date, expir_date, dte, strike, stock_price, call_iv, put_iv)
      VALUES ('QQQ', ?, ?, 50, 405, 405, 0.23, 0.25)
    `);
    for (const date of ['2026-01-02', '2026-01-05', '2026-01-06']) {
      insert.run(date, '2026-02-21');
    }
    db.close();

    const rows = loadIVDataFromOptionChainCache({
      ticker: 'QQQ',
      startDate: '2026-01-02',
      endDate: '2026-01-06',
      chainDbPath,
      dailyCandles: [
        { date: '2026-01-02', close: 405 },
        { date: '2026-01-05', close: 407 },
        { date: '2026-01-06', close: 408 },
      ],
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(rows).toHaveLength(3);
    expect(rows[0].iv60d).toBe(0.24);
  });

  it('swing pipeline fetchTickerData uses local cache paths instead of Supabase fetch', async () => {
    const td = await fetchSwingTickerData('QQQ', '2026-01-02', '2026-01-06');

    expect(fetch).not.toHaveBeenCalled();
    expect(td.candles).toHaveLength(3);
    expect(td.regimeByDate.get('2026-01-05')?.contango).toBeGreaterThan(0);
  });

  it('short pipeline fetchTickerData uses local IV cache instead of Supabase fetch', async () => {
    const intradayDb = initIntradayDB(intradayDbPath);
    try {
      const td = await fetchShortTickerData('QQQ', '2026-01-02', '2026-01-06', intradayDb);

      expect(fetch).not.toHaveBeenCalled();
      expect(td.candles130m).toHaveLength(4);
      expect(td.ivData).toHaveLength(3);
    } finally {
      intradayDb.close();
    }
  });
});

// Regression for the 2026-11-06 repro audit: the old loader grouped 1h bars by
// the UTC `date` column with no session filter, so (a) a Friday 19:00 ET
// after-hours bar (00:00 UTC Saturday) became a phantom Saturday candle,
// (b) extended-hours bars set the daily open/close/high/low, and (c) pre-2024
// vendor rows that carry full regular-session bars on NYSE holidays became
// fake trading days.
describe('loadDailyCandlesFromIntradayCache session handling', () => {
  let tmpDir: string;
  let dbPath: string;

  function utcBar(utc: string, open: number, high: number, low: number, close: number, volume: number) {
    return { datetime: utc, open, high, low, close, volume };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-session-'));
    dbPath = path.join(tmpDir, 'intraday-candles.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE candles_1h (
        ticker TEXT NOT NULL, timestamp INTEGER NOT NULL, datetime TEXT NOT NULL, date TEXT NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL
      );
    `);
    const bars = [
      // Thu 2025-03-06 19:00 ET after-hours bar, stored under UTC date 2025-03-07.
      utcBar('2025-03-07 00:00:00', 900, 900, 900, 900, 1),
      // Fri 2025-03-07 (EST, UTC-5): pre-market 04:00 ET, then regular 09:00..15:00 ET.
      utcBar('2025-03-07 09:00:00', 800, 800, 800, 800, 1),
      utcBar('2025-03-07 14:00:00', 100, 105, 99, 104, 10),
      utcBar('2025-03-07 15:00:00', 104, 106, 103, 105, 10),
      utcBar('2025-03-07 16:00:00', 105, 107, 104, 106, 10),
      utcBar('2025-03-07 17:00:00', 106, 108, 105, 107, 10),
      utcBar('2025-03-07 18:00:00', 107, 109, 106, 108, 10),
      utcBar('2025-03-07 19:00:00', 108, 110, 107, 109, 10),
      utcBar('2025-03-07 20:00:00', 109, 111, 108, 110, 10),
      // Fri after-hours 16:00 and 19:00 ET (the latter is UTC Saturday).
      utcBar('2025-03-07 21:00:00', 500, 500, 500, 500, 1),
      utcBar('2025-03-08 00:00:00', 600, 600, 600, 600, 1),
      // Mon 2025-03-10 (EDT, UTC-4): regular 09:00 ET bar is 13:00 UTC.
      utcBar('2025-03-10 08:00:00', 700, 700, 700, 700, 1),
      utcBar('2025-03-10 13:00:00', 110, 112, 109, 111, 20),
      utcBar('2025-03-10 19:00:00', 111, 113, 110, 112, 20),
      utcBar('2025-03-10 20:00:00', 400, 400, 400, 400, 1),
      // MLK day 2024-01-15: legacy vendor rows carry regular-hours bars on holidays.
      utcBar('2024-01-15 14:00:00', 300, 300, 300, 300, 5),
      utcBar('2024-01-15 20:00:00', 300, 300, 300, 300, 5),
      // Day after Thanksgiving 2025-11-28 closes 13:00 ET; the 13:00 ET bar is post-close.
      utcBar('2025-11-28 14:00:00', 120, 121, 119, 120, 30),
      utcBar('2025-11-28 17:00:00', 120, 122, 118, 121, 30),
      utcBar('2025-11-28 18:00:00', 999, 999, 1, 999, 1),
    ];
    const insert = db.prepare(`
      INSERT INTO candles_1h (ticker, timestamp, datetime, date, open, high, low, close, volume)
      VALUES ('QQQ', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const b of bars) {
      insert.run(Date.parse(b.datetime.replace(' ', 'T') + 'Z'), b.datetime, b.datetime.slice(0, 10),
        b.open, b.high, b.low, b.close, b.volume);
    }
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('buckets by US/Eastern date, keeps regular session only, drops weekends and holidays', () => {
    const candles = loadDailyCandlesFromIntradayCache({
      ticker: 'QQQ', startDate: '2024-01-01', endDate: '2025-12-31', intradayDbPath: dbPath,
    });

    expect(candles.map(c => c.date)).toEqual(['2025-03-07', '2025-03-10', '2025-11-28']);
    expect(candles[0]).toMatchObject({ open: 100, high: 111, low: 99, close: 110, volume: 70 });
    expect(candles[1]).toMatchObject({ open: 110, high: 113, low: 109, close: 112, volume: 40 });
    expect(candles[2]).toMatchObject({ open: 120, high: 122, low: 118, close: 121, volume: 60 });
  });

  it('applies the requested date range to Eastern dates', () => {
    const candles = loadDailyCandlesFromIntradayCache({
      ticker: 'QQQ', startDate: '2025-03-08', endDate: '2025-03-10', intradayDbPath: dbPath,
    });
    expect(candles.map(c => c.date)).toEqual(['2025-03-10']);
  });
});

describe('NYSE calendar helpers', () => {
  it('flags full-day closures including observed and special closures', () => {
    for (const d of [
      '2017-01-02', '2017-12-25', '2018-12-05', '2019-04-19', '2020-07-03',
      '2021-12-24', '2022-06-20', '2022-12-26', '2023-01-02', '2025-01-09', '2026-07-03',
    ]) expect(isNyseHoliday(d), d).toBe(true);
    for (const d of ['2017-01-03', '2021-12-31', '2022-01-03', '2021-06-18', '2025-03-07'])
      expect(isNyseHoliday(d), d).toBe(false);
  });

  it('returns 13:00 ET close on early-close days and 16:00 otherwise', () => {
    for (const d of ['2017-07-03', '2018-12-24', '2020-11-27', '2024-07-03', '2025-12-24'])
      expect(nyseSessionCloseHourET(d), d).toBe(13);
    for (const d of ['2021-07-02', '2022-07-01', '2025-03-07'])
      expect(nyseSessionCloseHourET(d), d).toBe(16);
  });
});
