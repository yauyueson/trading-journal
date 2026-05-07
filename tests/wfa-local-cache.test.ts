import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLocalSwingTickerData,
  loadIVDataFromOptionChainCache,
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
