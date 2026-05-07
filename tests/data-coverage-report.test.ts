import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDataCoverageReport,
  formatDataCoverageReport,
  writeDataCoverageArtifact,
} from '../scripts/data-coverage-report';

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
  interval.run('QQQ', '2026-02-24', 30, 60);
  interval.run('QQQ', '2026-02-25', 30, 60);
  interval.run('QQQ', '2026-02-25', 240, 300);
  interval.run('QQQ', '2026-02-26', 30, 45);

  const chain = db.prepare(`
    INSERT INTO option_chains (
      ticker, trade_date, expir_date, dte, strike, stock_price,
      call_bid, call_mid, call_ask, call_iv, call_volume, call_oi,
      put_bid, put_mid, put_ask, put_iv, put_volume, put_oi,
      delta, gamma, theta, vega
    ) VALUES (?, ?, ?, ?, ?, 450, 1, 1.1, 1.2, 0.2, 100, 200, 1, 1.1, 1.2, 0.2, 100, 200, 0.5, 0.01, -0.1, 0.05)
  `);
  chain.run('QQQ', '2026-02-24', '2026-04-10', 45, 450);
  chain.run('QQQ', '2026-02-25', '2026-04-11', 45, 451);
  chain.run('QQQ', '2026-02-25', '2026-12-01', 280, 452);
  chain.run('QQQ', '2026-02-26', '2026-04-05', 38, 453);
  db.close();
}

describe('cache-only data coverage report', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-report-'));
    dbPath = path.join(tmpDir, 'option-chains.sqlite');
    createChainDb(dbPath);
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('data coverage report must not fetch vendor data');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds active strategy DTE-band coverage from local cache without fetching', () => {
    const report = buildDataCoverageReport({
      repoRoot: path.resolve(__dirname, '..'),
      chainDbPath: dbPath,
      generatedAt: '2026-05-06T00:00:00.000Z',
    });

    expect(report.mode).toBe('cache-only');
    expect(fetch).not.toHaveBeenCalled();
    expect(report.manifest.dataEndDate).toBe('2026-02-28');
    expect(report.strategyBands.map(b => b.strategy).sort()).toEqual(['bcd', 'pmcc', 'pmcc']);
    expect(report.strategyBands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: 'bcd',
          bandName: 'debit-spread',
          ticker: 'QQQ',
          dteMin: 30,
          dteMax: 60,
          intervalCoveredDates: 2,
          chainRowDates: 3,
        }),
        expect.objectContaining({
          strategy: 'pmcc',
          bandName: 'long-leg',
          dteMin: 240,
          dteMax: 300,
          intervalCoveredDates: 1,
          chainRowDates: 1,
        }),
      ]),
    );
  });

  it('formats a human-readable cache-only report', () => {
    const output = formatDataCoverageReport(buildDataCoverageReport({
      repoRoot: path.resolve(__dirname, '..'),
      chainDbPath: dbPath,
      generatedAt: '2026-05-06T00:00:00.000Z',
    }));

    expect(output).toContain('Data Coverage Report');
    expect(output).toContain('Mode: cache-only');
    expect(output).toContain('Vendor API calls: disabled');
    expect(output).toContain('BCD QQQ wide');
    expect(output).toContain('PMCC QQQ pt60');
  });

  it('writes a deterministic JSON artifact that can be cited by WFA runs', () => {
    const outDir = path.join(tmpDir, 'docs/data-coverage');
    const report = buildDataCoverageReport({
      repoRoot: path.resolve(__dirname, '..'),
      chainDbPath: dbPath,
      generatedAt: '2026-05-06T00:00:00.000Z',
    });

    const artifact = writeDataCoverageArtifact(report, { outputDir: outDir });

    expect(artifact.path).toBe(path.join(outDir, '2026-05-06-cache-only-coverage.json'));
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);

    const parsed = JSON.parse(fs.readFileSync(artifact.path, 'utf-8'));
    expect(parsed.artifact).toMatchObject({
      schemaVersion: 1,
      generatedBy: 'scripts/data-coverage-report.ts',
      mode: 'cache-only',
      vendorApiCalls: 'disabled',
    });
    expect(parsed.report.strategyBands).toHaveLength(3);
  });
});
