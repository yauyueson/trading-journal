#!/usr/bin/env node
/**
 * Batched 130M fetcher with 30-second delays between tickers.
 * Only fetches tickers whose 130M data is older than target end date.
 * Uses INSERT OR IGNORE so re-runs are safe.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Load env
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
      if (key && !key.startsWith('#')) process.env[key] = value;
    }
  });
}

const { getAggregates } = await import('../lib/polygon-client.js');

const ALL_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA',
  'AMZN', 'MSFT', 'META', 'NFLX', 'GOOGL', 'GS', 'COST',
];

// Parse --tickers flag
const args = process.argv.slice(2);
const tickerIdx = args.indexOf('--tickers');
const requestedTickers = tickerIdx >= 0 && args[tickerIdx + 1]
  ? args[tickerIdx + 1].split(',').map(t => t.trim().toUpperCase())
  : null;

const from = '2024-03-22';
const to = '2026-03-21';
const TARGET_END = '2026-02-28';  // Must have data at least to here
const DELAY_MS = 30000;  // 30 seconds between requests

const dbPath = path.resolve(process.cwd(), 'data', 'intraday-candles.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS candles_130m_raw (
    ticker TEXT NOT NULL, timestamp INTEGER NOT NULL, datetime TEXT NOT NULL,
    date TEXT NOT NULL, block INTEGER NOT NULL, open REAL NOT NULL,
    high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    volume REAL NOT NULL, PRIMARY KEY (ticker, timestamp)
  );
  CREATE INDEX IF NOT EXISTS idx_130m_ticker_date ON candles_130m_raw(ticker, date);
`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO candles_130m_raw (ticker, timestamp, datetime, date, block, open, high, low, close, volume)
  VALUES (@ticker, @timestamp, @datetime, @date, @block, @open, @high, @low, @close, @volume)
`);
const countStmt = db.prepare('SELECT COUNT(*) AS cnt FROM candles_130m_raw WHERE ticker = ?');
const maxDateStmt = db.prepare('SELECT MAX(date) AS maxD FROM candles_130m_raw WHERE ticker = ?');
const insertMany = db.transaction((rows) => { for (const row of rows) insertStmt.run(row); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Determine which tickers need updating
const tickersToFetch = [];
const tickers = requestedTickers || ALL_TICKERS;
for (const t of tickers) {
  const { maxD } = maxDateStmt.get(t);
  if (!maxD || maxD < TARGET_END) {
    tickersToFetch.push(t);
  }
}

console.log(`=== Batched 130M Fetcher ===`);
console.log(`Target: data through ${TARGET_END}`);
console.log(`Need update: ${tickersToFetch.length}/${tickers.length} tickers`);
if (tickersToFetch.length === 0) {
  console.log('All tickers up to date!');
  db.close();
  process.exit(0);
}
console.log(`Queue: ${tickersToFetch.join(', ')}`);
console.log(`Delay: ${DELAY_MS / 1000}s between tickers\n`);

let succeeded = 0;
let failed = 0;

for (let i = 0; i < tickersToFetch.length; i++) {
  const ticker = tickersToFetch[i];
  if (i > 0) {
    console.log(`  (waiting ${DELAY_MS / 1000}s...)`);
    await sleep(DELAY_MS);
  }

  const before = countStmt.get(ticker).cnt;
  console.log(`[${i + 1}/${tickersToFetch.length}] ${ticker}: Fetching 130M ${from} → ${to} ...`);

  try {
    const candles = await getAggregates(ticker, 130, 'minute', from, to);
    if (candles.length === 0) {
      console.log(`  No data returned`);
      failed++;
      continue;
    }

    const rows = [];
    for (const c of candles) {
      const dt = new Date(c.timestamp);
      const etStr = dt.toLocaleString('en-US', { timeZone: 'America/New_York' });
      const etDate = new Date(etStr);
      const hour = etDate.getHours();
      const minute = etDate.getMinutes();
      const minutesSince930 = (hour * 60 + minute) - 570;
      if (minutesSince930 < 0 || minutesSince930 >= 390) continue;

      const y = etDate.getFullYear();
      const m = String(etDate.getMonth() + 1).padStart(2, '0');
      const d = String(etDate.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;
      const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const block = Math.min(2, Math.max(0, Math.floor(minutesSince930 / 130)));

      rows.push({
        ticker, timestamp: c.timestamp, datetime: `${dateStr} ${timeStr}`,
        date: dateStr, block, open: c.open, high: c.high, low: c.low,
        close: c.close, volume: c.volume,
      });
    }

    if (rows.length > 0) {
      insertMany(rows);
      const after = countStmt.get(ticker).cnt;
      const inserted = after - before;
      console.log(`  ${candles.length} raw → ${rows.length} regular-hours, ${inserted} new (total: ${after})`);
      console.log(`  Range: ${rows[0].date} → ${rows[rows.length - 1].date}`);
      succeeded++;
    }
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    failed++;
  }
}

// Summary
const total = db.prepare('SELECT COUNT(*) AS cnt FROM candles_130m_raw').get().cnt;
const tickerCount = db.prepare('SELECT COUNT(DISTINCT ticker) AS cnt FROM candles_130m_raw').get().cnt;
const range = db.prepare('SELECT MIN(date) AS minD, MAX(date) AS maxD FROM candles_130m_raw').get();
console.log(`\n=== Done: ${succeeded} succeeded, ${failed} failed ===`);
console.log(`Total: ${total} rows, ${tickerCount} tickers, ${range.minD} → ${range.maxD}`);

// Show remaining gaps
const still = [];
for (const t of tickers) {
  const { maxD } = maxDateStmt.get(t);
  if (!maxD || maxD < TARGET_END) still.push(`${t}(→${maxD || 'N/A'})`);
}
if (still.length > 0) {
  console.log(`Still need update: ${still.join(', ')}`);
  console.log(`Re-run this script to fetch remaining tickers.`);
}

db.close();
