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

  // 4H candles: aggregate 1H bars into 2 blocks per trading day.
  // 1H datetimes are stored in UTC. Regular trading hours in UTC:
  //   EDT (Mar–Nov): 13:30–20:00 → bars at hours 13–19
  //   EST (Nov–Mar): 14:30–21:00 → bars at hours 14–20
  // Filter to UTC hours 13–20 to cover both DST regimes.
  // Block 0: hours 13–16 (first ~4 bars), Block 1: hours 17–20 (last ~3-4 bars).
  db.exec(`DROP VIEW IF EXISTS candles_4h`);
  db.exec(`
    CREATE VIEW IF NOT EXISTS candles_4h AS
    SELECT
      ticker,
      MIN(timestamp) AS timestamp,
      MIN(datetime)  AS datetime,
      date,
      CASE WHEN CAST(SUBSTR(datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END AS block,
      (SELECT c2.open FROM candles_1h c2
       WHERE c2.ticker = c1.ticker AND c2.date = c1.date
         AND CAST(SUBSTR(c2.datetime, 12, 2) AS INTEGER) BETWEEN 13 AND 20
         AND (CASE WHEN CAST(SUBSTR(c2.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END) =
             (CASE WHEN CAST(SUBSTR(c1.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END)
       ORDER BY c2.timestamp ASC LIMIT 1) AS open,
      MAX(high) AS high,
      MIN(low)  AS low,
      (SELECT c3.close FROM candles_1h c3
       WHERE c3.ticker = c1.ticker AND c3.date = c1.date
         AND CAST(SUBSTR(c3.datetime, 12, 2) AS INTEGER) BETWEEN 13 AND 20
         AND (CASE WHEN CAST(SUBSTR(c3.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END) =
             (CASE WHEN CAST(SUBSTR(c1.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END)
       ORDER BY c3.timestamp DESC LIMIT 1) AS close,
      SUM(volume) AS volume
    FROM candles_1h c1
    WHERE CAST(SUBSTR(datetime, 12, 2) AS INTEGER) BETWEEN 13 AND 20
    GROUP BY ticker, date, CASE WHEN CAST(SUBSTR(datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END;
  `);

  // 130M candles: native Polygon 130-minute bars (3 per trading day).
  // Fetched directly from Polygon getAggregates(ticker, 130, 'minute').
  db.exec(`
    CREATE TABLE IF NOT EXISTS candles_130m_raw (
      ticker    TEXT    NOT NULL,
      timestamp INTEGER NOT NULL,
      datetime  TEXT    NOT NULL,
      date      TEXT    NOT NULL,
      block     INTEGER NOT NULL,  -- 0, 1, or 2 within a day
      open      REAL    NOT NULL,
      high      REAL    NOT NULL,
      low       REAL    NOT NULL,
      close     REAL    NOT NULL,
      volume    REAL    NOT NULL,
      PRIMARY KEY (ticker, timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_130m_ticker_date ON candles_130m_raw(ticker, date);
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

  // ── 130M native candles from Polygon ─────────────────────────────────────────
  console.log(`\n=== Fetching 130M candles ===\n`);

  const insert130mStmt = db.prepare(`
    INSERT OR IGNORE INTO candles_130m_raw (ticker, timestamp, datetime, date, block, open, high, low, close, volume)
    VALUES (@ticker, @timestamp, @datetime, @date, @block, @open, @high, @low, @close, @volume)
  `);

  const count130mStmt = db.prepare('SELECT COUNT(*) AS cnt FROM candles_130m_raw WHERE ticker = ?');
  const insert130mMany = db.transaction((rows) => {
    for (const row of rows) insert130mStmt.run(row);
  });

  let total130mInserted = 0;

  for (const ticker of opts.tickers) {
    const before = count130mStmt.get(ticker).cnt;

    console.log(`[${ticker}] Fetching 130M candles ${opts.from} → ${opts.to} ...`);
    try {
      const candles = await getAggregates(ticker, 130, 'minute', opts.from, opts.to);

      if (candles.length === 0) {
        console.log(`[${ticker}] No 130M data returned`);
        continue;
      }

      // Convert UTC timestamps to ET and assign block (0, 1, 2) per day
      const rows = [];
      const dayBlocks = new Map(); // date → counter for block assignment
      for (const c of candles) {
        const dt = new Date(c.timestamp);
        // Convert to ET
        const etStr = dt.toLocaleString('en-US', { timeZone: 'America/New_York' });
        const etDate = new Date(etStr);
        const hour = etDate.getHours();
        const minute = etDate.getMinutes();
        const minutesSince930 = (hour * 60 + minute) - 570;

        // Skip pre/post market bars (regular hours: 9:30–16:00 ET)
        if (minutesSince930 < 0 || minutesSince930 >= 390) continue;

        const y = etDate.getFullYear();
        const m = String(etDate.getMonth() + 1).padStart(2, '0');
        const d = String(etDate.getDate()).padStart(2, '0');
        const dateStr = `${y}-${m}-${d}`;
        const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

        // Assign block based on minutes since 9:30
        const block = Math.min(2, Math.max(0, Math.floor(minutesSince930 / 130)));

        rows.push({
          ticker,
          timestamp: c.timestamp,
          datetime: `${dateStr} ${timeStr}`,
          date: dateStr,
          block,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        });
      }

      if (rows.length > 0) {
        insert130mMany(rows);
        const after = count130mStmt.get(ticker).cnt;
        const inserted = after - before;
        total130mInserted += inserted;
        console.log(`[${ticker}] ${candles.length} bars fetched → ${rows.length} trading hours, ${inserted} new`);
        console.log(`  Date range: ${rows[0].date} → ${rows[rows.length - 1].date}`);
      }
    } catch (err) {
      console.error(`[${ticker}] 130M ERROR: ${err.message}`);
    }
  }

  // Summary
  const totalRows = db.prepare('SELECT COUNT(*) AS cnt FROM candles_1h').get().cnt;
  const tickerCount = db.prepare('SELECT COUNT(DISTINCT ticker) AS cnt FROM candles_1h').get().cnt;
  const dateRange = db.prepare('SELECT MIN(date) AS minD, MAX(date) AS maxD FROM candles_1h').get();

  const total130mRows = db.prepare('SELECT COUNT(*) AS cnt FROM candles_130m_raw').get().cnt;
  const ticker130mCount = db.prepare('SELECT COUNT(DISTINCT ticker) AS cnt FROM candles_130m_raw').get().cnt;
  const dateRange130m = db.prepare('SELECT MIN(date) AS minD, MAX(date) AS maxD FROM candles_130m_raw').get();

  console.log(`\n=== Done ===`);
  console.log(`1H new rows:     ${totalInserted}`);
  console.log(`1H total rows:   ${totalRows} (${tickerCount} tickers, ${dateRange.minD} → ${dateRange.maxD})`);

  const sample4h = db.prepare('SELECT COUNT(*) AS cnt FROM candles_4h').get().cnt;
  console.log(`4H bars:         ${sample4h} (aggregated via view)`);

  console.log(`130M new rows:   ${total130mInserted}`);
  console.log(`130M total rows: ${total130mRows} (${ticker130mCount} tickers, ${dateRange130m.minD || 'N/A'} → ${dateRange130m.maxD || 'N/A'})`);

  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
