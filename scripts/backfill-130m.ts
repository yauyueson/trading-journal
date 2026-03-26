#!/usr/bin/env npx tsx
/**
 * backfill-130m.ts — Backfill Tiingo IEX 10-min bars → 1H bars into local SQLite.
 * The candles_130m VIEW aggregates 1H → 130M automatically.
 *
 * Usage:
 *   npx tsx scripts/backfill-130m.ts                          # all 14 tickers, 2017-01-03 → 2024-03-17
 *   npx tsx scripts/backfill-130m.ts --tickers SPY,QQQ        # specific tickers
 *   npx tsx scripts/backfill-130m.ts --from 2020-01-01        # custom start date
 *   npx tsx scripts/backfill-130m.ts --to 2024-03-17          # custom end date
 *   npx tsx scripts/backfill-130m.ts --resume                 # resume from last checkpoint
 *
 * Prerequisites:
 *   - TIINGO_API_TOKEN in .env or .env.local
 *   - Set TIINGO_RATE_LIMIT_RPM=500 for $30 Power tier (default 50 for free)
 *
 * Data flow: Tiingo IEX 10-min → aggregate to 1H → INSERT OR IGNORE into candles_1h
 * The candles_130m SQLite VIEW handles 1H → 130M aggregation at query time.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

// @ts-ignore — ESM .js import
import { getIntradayNMinCandles } from '../lib/tiingo-client.js';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ── Config ──────────────────────────────────────────────────────────────────────

const SL_STUDY_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA',
  'AMZN', 'MSFT', 'META', 'NFLX', 'GOOG', 'GS',
];

const CHUNK_DAYS = 60; // ~1,638 10-min bars per chunk, under Tiingo 2000-tick limit
const DB_PATH = path.resolve('data/intraday-candles.sqlite');
const CHECKPOINT_PATH = path.resolve('data/.backfill-checkpoint.json');
const RPM = parseInt(process.env.TIINGO_RATE_LIMIT_RPM || '50', 10);
const DELAY_MS = Math.ceil(60_000 / RPM) + 100; // ms between requests to stay under RPM

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Parse args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('--')
    ? args[idx + 1] : null;
}

const tickerArg = getArg('--tickers');
const tickers = tickerArg ? tickerArg.split(',').map(t => t.toUpperCase()) : SL_STUDY_TICKERS;
const fromDate = getArg('--from') || '2017-01-03';
const toDate = getArg('--to') || '2024-03-17';
const resumeMode = args.includes('--resume');

// ── Checkpoint (resume-on-failure) ──────────────────────────────────────────────

interface Checkpoint {
  completedChunks: Record<string, string[]>; // ticker → array of "from|to" chunk keys
}

function loadCheckpoint(): Checkpoint {
  if (resumeMode && fs.existsSync(CHECKPOINT_PATH)) {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'));
  }
  return { completedChunks: {} };
}

function saveCheckpoint(cp: Checkpoint) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

// ── Date helpers ────────────────────────────────────────────────────────────────

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function dateChunks(from: string, to: string, chunkDays: number): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  let cursor = from;
  while (cursor <= to) {
    const chunkEnd = addDays(cursor, chunkDays - 1);
    chunks.push([cursor, chunkEnd < to ? chunkEnd : to]);
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}

// ── Aggregate 10-min bars → 1H bars ────────────────────────────────────────────

interface TiingoBar {
  timestamp: number;
  datetime: string;
  date: string;
  hour: number;
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface HourlyBar {
  ticker: string;
  timestamp: number;
  datetime: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function aggregate10MinToHourly(bars: TiingoBar[], ticker: string): HourlyBar[] {
  if (!bars || bars.length === 0) return [];

  // Group by UTC hour
  const groups = new Map<number, TiingoBar[]>();
  for (const bar of bars) {
    const hourTs = Math.floor(bar.timestamp / 3_600_000) * 3_600_000;
    if (!groups.has(hourTs)) groups.set(hourTs, []);
    groups.get(hourTs)!.push(bar);
  }

  const hourlyBars: HourlyBar[] = [];
  for (const [hourTs, group] of groups) {
    const sorted = group.sort((a, b) => a.timestamp - b.timestamp);
    const dt = new Date(hourTs);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    const h = String(dt.getUTCHours()).padStart(2, '0');
    const utcDate = `${y}-${m}-${d}`;
    const utcDatetime = `${utcDate} ${h}:00:00`;

    hourlyBars.push({
      ticker,
      timestamp: hourTs,
      datetime: utcDatetime,
      date: utcDate,
      open: sorted[0].open,
      high: Math.max(...sorted.map(b => b.high)),
      low: Math.min(...sorted.map(b => b.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((sum, b) => sum + b.volume, 0),
    });
  }

  return hourlyBars.sort((a, b) => a.timestamp - b.timestamp);
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60));
  console.log('  130M Backfill: Tiingo IEX 10-min → 1H → SQLite');
  console.log('═'.repeat(60));
  console.log(`Tickers:  ${tickers.join(', ')}`);
  console.log(`Range:    ${fromDate} → ${toDate}`);
  console.log(`DB:       ${DB_PATH}`);
  console.log(`RPM:      ${process.env.TIINGO_RATE_LIMIT_RPM || '50'}`);
  console.log(`Resume:   ${resumeMode}`);
  console.log();

  if (!process.env.TIINGO_API_TOKEN) {
    console.error('ERROR: TIINGO_API_TOKEN not set');
    process.exit(1);
  }

  // Open DB
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO candles_1h (ticker, timestamp, datetime, date, open, high, low, close, volume)
    VALUES (@ticker, @timestamp, @datetime, @date, @open, @high, @low, @close, @volume)
  `);

  const insertMany = db.transaction((rows: HourlyBar[]) => {
    let inserted = 0;
    for (const row of rows) {
      const result = insertStmt.run(row);
      inserted += result.changes;
    }
    return inserted;
  });

  const checkpoint = loadCheckpoint();
  const chunks = dateChunks(fromDate, toDate, CHUNK_DAYS);
  const totalChunks = tickers.length * chunks.length;
  let completedCount = 0;
  let totalInserted = 0;
  let skippedCount = 0;
  const startTime = Date.now();

  for (const ticker of tickers) {
    if (!checkpoint.completedChunks[ticker]) {
      checkpoint.completedChunks[ticker] = [];
    }

    console.log(`\n── ${ticker} (${chunks.length} chunks) ──`);
    let tickerInserted = 0;

    for (const [chunkFrom, chunkTo] of chunks) {
      const chunkKey = `${chunkFrom}|${chunkTo}`;
      completedCount++;

      // Skip if already completed
      if (checkpoint.completedChunks[ticker].includes(chunkKey)) {
        skippedCount++;
        continue;
      }

      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      process.stdout.write(
        `  ${chunkFrom} → ${chunkTo} [${completedCount}/${totalChunks}] (${elapsed}m)... `
      );

      try {
        // Throttle to stay under RPM limit
        await sleep(DELAY_MS);

        const bars10min: TiingoBar[] = await getIntradayNMinCandles(ticker, chunkFrom, chunkTo, 10);

        if (bars10min.length === 0) {
          console.log('no data (may be rate-limited or no IEX data for this period)');
        } else {
          const hourlyBars = aggregate10MinToHourly(bars10min, ticker);
          const inserted = insertMany(hourlyBars);
          tickerInserted += inserted;
          totalInserted += inserted;
          console.log(`${bars10min.length} 10m → ${hourlyBars.length} 1H (${inserted} new)`);
        }

        // Mark chunk as completed
        checkpoint.completedChunks[ticker].push(chunkKey);
        saveCheckpoint(checkpoint);
      } catch (err: any) {
        console.log(`ERROR: ${err.message}`);
        console.log(`  → Run with --resume to continue from here`);
        saveCheckpoint(checkpoint);
        db.close();
        process.exit(1);
      }
    }

    console.log(`  ${ticker}: ${tickerInserted} new 1H bars inserted`);
  }

  db.close();

  // Clean up checkpoint on success
  if (fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH);
  }

  const totalMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log('\n' + '═'.repeat(60));
  console.log(`  Done in ${totalMinutes} minutes`);
  console.log(`  ${totalInserted} new 1H bars inserted (${skippedCount} chunks skipped)`);
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
