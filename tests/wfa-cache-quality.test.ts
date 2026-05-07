import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildWFACacheQualityReport,
  validateWFACacheQuality,
  writeWFACacheQualityArtifact,
} from '../scripts/wfa-cache-quality';

function createIntradayDb(dbPath: string, dates: string[]): void {
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
  `);
  const insert = db.prepare(`
    INSERT INTO candles_1h (ticker, timestamp, datetime, date, open, high, low, close, volume)
    VALUES ('QQQ', ?, ?, ?, 400, 405, 399, 404, 1000)
  `);
  dates.forEach((date, index) => {
    insert.run(index + 1, `${date} 14:30:00`, date);
  });
  db.close();
}

function createChainDb(dbPath: string, dates: string[]): void {
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
    VALUES ('QQQ', ?, ?, ?, 400, 404, 0.20, 0.22)
  `);
  for (const date of dates) {
    insert.run(date, '2026-02-06', 30);
    insert.run(date, '2026-03-06', 60);
  }
  db.close();
}

describe('WFA local cache quality gates', () => {
  let tmpDir: string;
  let intradayDbPath: string;
  let chainDbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-cache-quality-'));
    intradayDbPath = path.join(tmpDir, 'intraday.sqlite');
    chainDbPath = path.join(tmpDir, 'chains.sqlite');
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('cache quality gate must not fetch');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes when candles and IV proxy cover every cached trading date through the WFA end', () => {
    const dates = ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07'];
    createIntradayDb(intradayDbPath, dates);
    createChainDb(chainDbPath, dates);

    const report = buildWFACacheQualityReport({
      profile: 'swing',
      tickers: ['QQQ'],
      dataStart: '2026-01-02',
      endDate: '2026-01-07',
      intradayDbPath,
      chainDbPath,
      generatedAt: '2026-05-06T00:00:00.000Z',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(report.decision).toBe('pass');
    expect(report.tickers[0]).toMatchObject({
      ticker: 'QQQ',
      candleDates: 4,
      ivProxyDates: 4,
      ivProxyCoveragePct: 100,
      stale: false,
    });
    expect(() => validateWFACacheQuality(report)).not.toThrow();
  });

  it('does not mark cache stale for a one-day calendar gap at the end boundary', () => {
    const dates = ['2026-01-02', '2026-01-05', '2026-01-06'];
    createIntradayDb(intradayDbPath, dates);
    createChainDb(chainDbPath, dates);

    const report = buildWFACacheQualityReport({
      profile: 'swing',
      tickers: ['QQQ'],
      dataStart: '2026-01-02',
      endDate: '2026-01-07',
      intradayDbPath,
      chainDbPath,
      generatedAt: '2026-05-06T00:00:00.000Z',
    });

    expect(report.decision).toBe('pass');
    expect(report.tickers[0].stale).toBe(false);
  });

  it('blocks when the local cache is stale or IV proxy coverage is too sparse', () => {
    createIntradayDb(intradayDbPath, ['2026-01-02', '2026-01-05', '2026-01-06']);
    createChainDb(chainDbPath, ['2026-01-02']);

    const report = buildWFACacheQualityReport({
      profile: 'swing',
      tickers: ['QQQ'],
      dataStart: '2026-01-02',
      endDate: '2026-01-15',
      intradayDbPath,
      chainDbPath,
      generatedAt: '2026-05-06T00:00:00.000Z',
      minIVProxyCoveragePct: 80,
    });

    expect(report.decision).toBe('blocked');
    expect(report.tickers[0].stale).toBe(true);
    expect(report.tickers[0].ivProxyCoveragePct).toBeLessThan(80);
    expect(report.failures.join(' ')).toMatch(/stale/);
    expect(() => validateWFACacheQuality(report)).toThrow(/cache quality gate failed/);
  });

  it('counts nearest cached DTE rows toward IV proxy coverage', () => {
    const dates = ['2026-01-02', '2026-01-05', '2026-01-06'];
    createIntradayDb(intradayDbPath, dates);
    createChainDb(chainDbPath, dates);
    const db = new Database(chainDbPath);
    db.prepare('DELETE FROM option_chains WHERE dte = 60').run();
    const insert = db.prepare(`
      INSERT INTO option_chains (ticker, trade_date, expir_date, dte, strike, stock_price, call_iv, put_iv)
      VALUES ('QQQ', ?, '2026-02-21', 50, 400, 404, 0.23, 0.25)
    `);
    for (const date of dates) insert.run(date);
    db.close();

    const report = buildWFACacheQualityReport({
      profile: 'swing',
      tickers: ['QQQ'],
      dataStart: '2026-01-02',
      endDate: '2026-01-06',
      intradayDbPath,
      chainDbPath,
      generatedAt: '2026-05-06T00:00:00.000Z',
    });

    expect(report.decision).toBe('pass');
    expect(report.tickers[0].ivProxyCoveragePct).toBe(100);
  });

  it('writes a citeable data-quality artifact', () => {
    const dates = ['2026-01-02', '2026-01-05'];
    createIntradayDb(intradayDbPath, dates);
    createChainDb(chainDbPath, dates);
    const outDir = path.join(tmpDir, 'docs/data-quality');
    const report = buildWFACacheQualityReport({
      profile: 'swing',
      tickers: ['QQQ'],
      dataStart: '2026-01-02',
      endDate: '2026-01-05',
      intradayDbPath,
      chainDbPath,
      generatedAt: '2026-05-06T00:00:00.000Z',
    });

    const artifact = writeWFACacheQualityArtifact(report, { outputDir: outDir });

    expect(artifact.path).toBe(path.join(outDir, '2026-05-06-wfa-cache-quality.json'));
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(fs.readFileSync(artifact.path, 'utf-8')).artifact).toMatchObject({
      schemaVersion: 1,
      generatedBy: 'scripts/wfa-cache-quality.ts',
      decision: 'pass',
    });
  });
});
