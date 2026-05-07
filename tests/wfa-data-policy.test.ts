import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDataCoverageReport } from '../scripts/data-coverage-report';
import { buildMetadata } from '../scripts/wfa-metadata';
import {
  createWFARunDataPolicy,
  validateCacheOnlyCoverage,
} from '../scripts/wfa-data-policy';

function createCompleteChainDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE option_chains (
      ticker TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      expir_date TEXT NOT NULL,
      dte INTEGER NOT NULL,
      strike REAL NOT NULL,
      stock_price REAL NOT NULL,
      call_bid REAL,
      call_mid REAL,
      call_ask REAL,
      call_iv REAL,
      call_volume INTEGER,
      call_oi INTEGER,
      put_bid REAL,
      put_mid REAL,
      put_ask REAL,
      put_iv REAL,
      put_volume INTEGER,
      put_oi INTEGER,
      delta REAL,
      gamma REAL,
      theta REAL,
      vega REAL
    );
    CREATE TABLE fetch_log_intervals (
      ticker TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      dte_min INTEGER,
      dte_max INTEGER,
      fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const interval = db.prepare('INSERT INTO fetch_log_intervals (ticker, trade_date, dte_min, dte_max) VALUES (?, ?, ?, ?)');
  const chain = db.prepare(`
    INSERT INTO option_chains (
      ticker, trade_date, expir_date, dte, strike, stock_price,
      call_bid, call_mid, call_ask, call_iv, call_volume, call_oi,
      put_bid, put_mid, put_ask, put_iv, put_volume, put_oi,
      delta, gamma, theta, vega
    ) VALUES ('QQQ', ?, ?, ?, 450, 450, 1, 1.1, 1.2, 0.2, 100, 200, 1, 1.1, 1.2, 0.2, 100, 200, 0.5, 0.01, -0.1, 0.05)
  `);

  for (const [date, dteMin, dteMax, dte] of [
    ['2026-02-24', 30, 60, 45],
    ['2026-02-25', 240, 300, 280],
    ['2026-02-26', 30, 45, 38],
  ] as const) {
    interval.run('QQQ', date, dteMin, dteMax);
    chain.run(date, '2026-12-01', dte);
  }
  for (const date of ['2026-02-24', '2026-02-25', '2026-02-26']) {
    chain.run(date, '2026-03-27', 30);
    chain.run(date, '2026-04-24', 60);
  }
  db.close();
}

function createPolicyIntradayDb(dbPath: string): void {
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
  for (const [idx, date] of ['2026-02-24', '2026-02-25', '2026-02-26'].entries()) {
    insert.run(idx + 1, `${date} 14:30:00`, date);
  }
  db.close();
}

describe('WFA cache-only data policy', () => {
  let tmpDir: string;
  let dbPath: string;
  let intradayDbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-data-policy-'));
    dbPath = path.join(tmpDir, 'option-chains.sqlite');
    intradayDbPath = path.join(tmpDir, 'intraday-candles.sqlite');
    createCompleteChainDb(dbPath);
    createPolicyIntradayDb(intradayDbPath);
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('WFA data policy must not fetch vendor data');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a cache-first policy with a citeable coverage artifact', () => {
    const outDir = path.join(tmpDir, 'docs/data-coverage');
    const policy = createWFARunDataPolicy({
      repoRoot: path.resolve(__dirname, '..'),
      chainDbPath: dbPath,
      intradayDbPath,
      qualityOutputDir: path.join(tmpDir, 'docs/data-quality'),
      qualityRequest: {
        profile: 'swing',
        tickers: ['QQQ'],
        dataStart: '2026-02-24',
        endDate: '2026-02-26',
      },
      generatedAt: '2026-05-06T00:00:00.000Z',
      outputDir: outDir,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(policy).toMatchObject({
      mode: 'cache-first',
      vendorApiCalls: 'disabled-during-wfa',
      coverageGeneratedAt: '2026-05-06T00:00:00.000Z',
    });
    expect(policy.coverageArtifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(outDir, '2026-05-06-cache-only-coverage.json'))).toBe(true);
    expect(policy.inputCaches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'option-chain', path: expect.any(String), bytes: expect.any(Number) }),
      ]),
    );
    expect(policy.requiredBands).toHaveLength(3);
    expect(policy.qualityGate).toMatchObject({
      decision: 'pass',
      artifactPath: expect.any(String),
      artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('blocks WFA when required cached option coverage is missing', () => {
    const report = buildDataCoverageReport({
      repoRoot: path.resolve(__dirname, '..'),
      chainDbPath: path.join(tmpDir, 'missing.sqlite'),
      generatedAt: '2026-05-06T00:00:00.000Z',
    });

    expect(() => validateCacheOnlyCoverage(report)).toThrow(/requires a local chain cache/);
  });

  it('blocks WFA data policy when local input quality fails', () => {
    expect(() => createWFARunDataPolicy({
      repoRoot: path.resolve(__dirname, '..'),
      chainDbPath: dbPath,
      intradayDbPath,
      qualityOutputDir: path.join(tmpDir, 'docs/data-quality'),
      qualityRequest: {
        profile: 'swing',
        tickers: ['QQQ'],
        dataStart: '2026-02-24',
        endDate: '2026-03-02',
      },
      generatedAt: '2026-05-06T00:00:00.000Z',
      outputDir: path.join(tmpDir, 'docs/data-coverage'),
    })).toThrow(/cache quality gate failed/);
  });

  it('embeds the data policy in WFA metadata', () => {
    const policy = createWFARunDataPolicy({
      repoRoot: path.resolve(__dirname, '..'),
      chainDbPath: dbPath,
      intradayDbPath,
      qualityOutputDir: path.join(tmpDir, 'docs/data-quality'),
      qualityRequest: {
        profile: 'swing',
        tickers: ['QQQ'],
        dataStart: '2026-02-24',
        endDate: '2026-02-26',
      },
      generatedAt: '2026-05-06T00:00:00.000Z',
      outputDir: path.join(tmpDir, 'docs/data-coverage'),
    });

    const metadata = buildMetadata({
      profile: 'swing',
      cliArgs: ['--profile', 'swing', '--smoke'],
      seed: 42,
      config: { tickers: ['QQQ'] },
      elapsedMs: 12,
      dataPolicy: policy,
    });

    expect(metadata.dataPolicy?.mode).toBe('cache-first');
    expect(metadata.dataPolicy?.coverageArtifactSha256).toBe(policy.coverageArtifactSha256);
  });
});
