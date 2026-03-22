#!/usr/bin/env node
/**
 * cache-intraday.mjs — Bulk download 1H candles from Polygon.io → SQLite cache.
 *
 * Usage:
 *   node scripts/cache-intraday.mjs                   # all 15 WFA tickers, 2 years
 *   node scripts/cache-intraday.mjs --tickers SPY,QQQ # specific tickers
 *   node scripts/cache-intraday.mjs --from 2023-01-01  # custom start date
 *
 * Stores 1H candles in data/intraday-candles.sqlite.
 * 4H candles are aggregated from 1H at query time via the `candles_4h` view.
 *
 * Polygon free tier: 5 calls/min, 2 years max history.
 * Each ticker needs 1 API call (1H bars over 2 years ≈ 3,500 rows < 50K limit).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getAggregates } from '../lib/polygon-client.js';

// ── Config ──────────────────────────────────────────────────────────────────────

const WFA_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA',
  'AMZN', 'MSFT', 'META', 'NFLX', 'GOOGL', 'GS', 'COST',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    tickers: WFA_TICKERS,
    from: null, // auto-calculated: 2 years ago
    to: null,   // auto-calculated: yesterday
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tickers' && args[i + 1]) {
      opts.tickers = args[++i].split(',').map(t => t.trim().toUpperCase());
    } else if (args[i] === '--from' && args[i + 1]) {
      opts.from = args[++i];
    } else if (args[i] === '--to' && args[i + 1]) {
      opts.to = args[++i];
    }
  }

  if (!opts.from) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 2);
    opts.from = d.toISOString().split('T')[0];
  }
  if (!opts.to) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    opts.to = d.toISOString().split('T')[0];
  }

  return opts;
}

// ── SQLite Setup ────────────────────────────────────────────────────────────────

function initDB() {
  const dbPath = path.resolve(process.cwd(), 'data', 'intraday-candles.sqlite');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS candles_1h (
      ticker    TEXT    NOT NULL,
      timestamp INTEGER NOT NULL,  -- Unix ms (bar open time)
      datetime  TEXT    NOT NULL,  -- 'YYYY-MM-DD HH:MM:SS' UTC
      date      TEXT    NOT NULL,  -- 'YYYY-MM-DD'
      open      REAL    NOT NULL,
      high      REAL    NOT NULL,
      low       REAL    NOT NULL,
      close     REAL    NOT NULL,
      volume    REAL    NOT NULL,
      vwap      REAL,
      transactions INTEGER,
      PRIMARY KEY (ticker, timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_1h_ticker_date ON candles_1h(ticker, date);
  `);

  // 4H candles: aggregate 1H bars into 4H sessions.
  // Regular trading hours: 09:30–16:00 ET → two 4H blocks:
  //   Block 1: 09:30–13:30 (bars at 09:00, 10:00, 11:00, 12:00 in UTC-adjusted)
  //   Block 2: 13:30–16:00 (bars at 13:00, 14:00, 15:00)
  // We group by (ticker, date, hour/4) for simplicity — each day gets ~2 blocks.
  db.exec(`
    CREATE VIEW IF NOT EXISTS candles_4h AS
    SELECT
      ticker,
      MIN(timestamp) AS timestamp,
      MIN(datetime)  AS datetime,
      date,
      CAST(SUBSTR(datetime, 12, 2) AS INTEGER) / 4 AS block,
      (SELECT c2.open FROM candles_1h c2
       WHERE c2.ticker = c1.ticker AND c2.date = c1.date
         AND CAST(SUBSTR(c2.datetime, 12, 2) AS INTEGER) / 4 = CAST(SUBSTR(c1.datetime, 12, 2) AS INTEGER) / 4
       ORDER BY c2.timestamp ASC LIMIT 1) AS open,
      MAX(high) AS high,
      MIN(low)  AS low,
      (SELECT c3.close FROM candles_1h c3
       WHERE c3.ticker = c1.ticker AND c3.date = c1.date
         AND CAST(SUBSTR(c3.datetime, 12, 2) AS INTEGER) / 4 = CAST(SUBSTR(c1.datetime, 12, 2) AS INTEGER) / 4
       ORDER BY c3.timestamp DESC LIMIT 1) AS close,
      SUM(volume) AS volume
    FROM candles_1h c1
    GROUP BY ticker, date, CAST(SUBSTR(datetime, 12, 2) AS INTEGER) / 4;
  `);

  return db;
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log(`\n=== Intraday Cache Builder ===`);
  console.log(`Tickers: ${opts.tickers.join(', ')}`);
  console.log(`Range:   ${opts.from} → ${opts.to}`);
  console.log(`DB:      data/intraday-candles.sqlite\n`);

  const db = initDB();

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO candles_1h (ticker, timestamp, datetime, date, open, high, low, close, volume, vwap, transactions)
    VALUES (@ticker, @timestamp, @datetime, @date, @open, @high, @low, @close, @volume, @vwap, @transactions)
  `);

  const countStmt = db.prepare('SELECT COUNT(*) AS cnt FROM candles_1h WHERE ticker = ?');
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insertStmt.run(row);
  });

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const ticker of opts.tickers) {
    const before = countStmt.get(ticker).cnt;

    console.log(`[${ticker}] Fetching 1H candles ${opts.from} → ${opts.to} ...`);
    try {
      const candles = await getAggregates(ticker, 1, 'hour', opts.from, opts.to);

      if (candles.length === 0) {
        console.log(`[${ticker}] No data returned`);
        continue;
      }

      // Tag each row with ticker
      const rows = candles.map(c => ({ ticker, ...c }));
      insertMany(rows);

      const after = countStmt.get(ticker).cnt;
      const inserted = after - before;
      totalInserted += inserted;
      totalSkipped += candles.length - inserted;

      console.log(`[${ticker}] ${candles.length} bars fetched, ${inserted} new, ${candles.length - inserted} already cached`);
      console.log(`  Date range: ${candles[0].date} → ${candles[candles.length - 1].date}`);
    } catch (err) {
      console.error(`[${ticker}] ERROR: ${err.message}`);
    }
  }

  // Summary
  const totalRows = db.prepare('SELECT COUNT(*) AS cnt FROM candles_1h').get().cnt;
  const tickerCount = db.prepare('SELECT COUNT(DISTINCT ticker) AS cnt FROM candles_1h').get().cnt;
  const dateRange = db.prepare('SELECT MIN(date) AS minD, MAX(date) AS maxD FROM candles_1h').get();

  console.log(`\n=== Done ===`);
  console.log(`New rows:    ${totalInserted}`);
  console.log(`Duplicates:  ${totalSkipped}`);
  console.log(`Total rows:  ${totalRows} (${tickerCount} tickers)`);
  console.log(`Date range:  ${dateRange.minD} → ${dateRange.maxD}`);

  // Check 4H view
  const sample4h = db.prepare('SELECT COUNT(*) AS cnt FROM candles_4h').get().cnt;
  console.log(`4H bars:     ${sample4h} (aggregated via view)`);

  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
