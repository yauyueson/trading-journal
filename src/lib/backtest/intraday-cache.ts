/**
 * Intraday Cache — Read-only SQLite interface to 1H/4H candles
 *
 * Reads from data/intraday-candles.sqlite (populated by scripts/cache-intraday.mjs).
 * 4H candles come from the `candles_4h` view (aggregated from 1H at query time).
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';

// ── Types ────────────────────────────────────────────────

export interface IntradayCandle {
  ticker: string;
  timestamp: number;     // Unix ms (bar open time)
  datetime: string;      // 'YYYY-MM-DD HH:MM:SS' UTC (or 'YYYY-MM-DD HH:MM' for 4H)
  date: string;          // 'YYYY-MM-DD'
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  block?: number;        // 4H block index (0 or 1 within a day)
}

// ── Database Init ────────────────────────────────────────

/**
 * Open the intraday candles SQLite database (read-only).
 */
export function initIntradayDB(dbPath?: string): DatabaseType {
  const resolved = dbPath ?? path.resolve(process.cwd(), 'data', 'intraday-candles.sqlite');
  const db = new Database(resolved, { readonly: true });
  db.pragma('journal_mode = WAL');
  db.pragma('mmap_size = 536870912');   // 512MB mmap
  db.pragma('cache_size = -32000');     // 32MB page cache
  return db;
}

// ── Queries ──────────────────────────────────────────────

/**
 * Get 4H candles for a ticker in a date range (inclusive).
 * Uses the `candles_4h` view which aggregates 1H bars into ~2 bars/day.
 */
export function get4HCandles(
  db: DatabaseType,
  ticker: string,
  startDate: string,
  endDate: string,
): IntradayCandle[] {
  const stmt = db.prepare(
    `SELECT ticker, timestamp, datetime, date, block, open, high, low, close, volume
     FROM candles_4h
     WHERE ticker = ? AND date >= ? AND date <= ?
     ORDER BY timestamp ASC`,
  );
  return stmt.all(ticker, startDate, endDate) as IntradayCandle[];
}

/**
 * Get 1H candles for a ticker in a date range (inclusive).
 */
export function get1HCandles(
  db: DatabaseType,
  ticker: string,
  startDate: string,
  endDate: string,
): IntradayCandle[] {
  const stmt = db.prepare(
    `SELECT ticker, timestamp, datetime, date, open, high, low, close, volume
     FROM candles_1h
     WHERE ticker = ? AND date >= ? AND date <= ?
     ORDER BY timestamp ASC`,
  );
  return stmt.all(ticker, startDate, endDate) as IntradayCandle[];
}

/**
 * Aggregate intraday candles (1H or 4H) to daily OHLCV.
 * Groups by date, returns one candle per trading day.
 */
export function aggregateToDaily(candles: IntradayCandle[]): IntradayCandle[] {
  const byDate = new Map<string, IntradayCandle[]>();
  for (const c of candles) {
    const arr = byDate.get(c.date);
    if (arr) arr.push(c);
    else byDate.set(c.date, [c]);
  }

  const daily: IntradayCandle[] = [];
  for (const [date, bars] of byDate) {
    if (bars.length === 0) continue;
    bars.sort((a, b) => a.timestamp - b.timestamp);
    daily.push({
      ticker: bars[0].ticker,
      timestamp: bars[0].timestamp,
      datetime: `${date} 00:00:00`,
      date,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }

  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Get the date range available for a ticker in the intraday DB.
 */
export function getDateRange(
  db: DatabaseType,
  ticker: string,
): { minDate: string; maxDate: string; count: number } | null {
  const stmt = db.prepare(
    `SELECT MIN(date) AS minDate, MAX(date) AS maxDate, COUNT(*) AS count
     FROM candles_1h WHERE ticker = ?`,
  );
  const row = stmt.get(ticker) as { minDate: string | null; maxDate: string | null; count: number };
  if (!row || !row.minDate) return null;
  return { minDate: row.minDate, maxDate: row.maxDate!, count: row.count };
}

/**
 * Get all tickers available in the intraday DB.
 */
export function getAvailableTickers(db: DatabaseType): string[] {
  const stmt = db.prepare('SELECT DISTINCT ticker FROM candles_1h ORDER BY ticker');
  return (stmt.all() as { ticker: string }[]).map(r => r.ticker);
}
