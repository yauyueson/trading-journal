#!/usr/bin/env node
/**
 * Pre-populate Supabase stock_candles cache with precise 5-min → 130M bars.
 * Runs locally (no Vercel timeout). After this, the signal board gets instant cache hits.
 *
 * Usage:
 *   node scripts/prefetch-130m.mjs                    # all watchlist tickers, 120-day lookback
 *   node scripts/prefetch-130m.mjs --tickers SPY,QQQ  # specific tickers
 *   node scripts/prefetch-130m.mjs --days 200         # custom lookback
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { getIntradayNMinCandles } from '../lib/tiingo-client.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const WATCHLIST = [
  'SPY', 'QQQ', 'GOOGL', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
  'AAPL', 'NVDA', 'AMD', 'COST', 'IREN', 'BA', 'AMZN', 'HOOD',
  'CRWV', 'COIN', 'MSTR', 'PLTR', 'AVGO', 'LULU', 'UBER', 'GS',
  'UNH', 'IWM', 'GLD',
];

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const tickers = (getArg('--tickers') || '').split(',').filter(Boolean);
const targetTickers = tickers.length > 0 ? tickers.map(t => t.toUpperCase()) : WATCHLIST;
const lookbackDays = parseInt(getArg('--days') || '120', 10);
const delayBetweenTickers = parseInt(getArg('--delay') || '15', 10); // seconds between tickers

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 5-min → 130M aggregation ────────────────────────────────────────────────

function aggregate5MinTo130M(bars5min) {
  if (!bars5min || bars5min.length === 0) return [];
  const groups = new Map();
  for (const c of bars5min) {
    const minutesSince930 = (c.hour * 60 + c.minute) - 570;
    if (minutesSince930 < 0) continue;
    const block = Math.min(Math.floor(minutesSince930 / 130), 2);
    const key = `${c.date}|${block}`;
    if (!groups.has(key)) groups.set(key, { date: c.date, block, candles: [] });
    groups.get(key).candles.push(c);
  }
  const bars = [];
  for (const [, group] of groups) {
    const sorted = group.candles.sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length === 0) continue;
    bars.push({
      timestamp: sorted[0].timestamp,
      date: group.date,
      block: group.block,
      open: sorted[0].open,
      high: Math.max(...sorted.map(c => c.high)),
      low: Math.min(...sorted.map(c => c.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return bars.sort((a, b) => a.timestamp - b.timestamp);
}

// ── Paginated 10-min fetch (60-day chunks, under Tiingo 2000-tick limit) ─────
// 10-min: 39 bars/day, perfect 130M alignment (13 bars per 130M block)
// 60-day chunk ≈ 42 trading days × 39 = ~1,638 bars per chunk (under 2000)

async function fetchPaginated10Min(ticker, startDate, endDate) {
  const CHUNK_DAYS = 60;
  const allBars = [];
  let cs = new Date(startDate + 'T12:00:00Z');
  const end = new Date(endDate + 'T12:00:00Z');
  let chunkNum = 0;
  while (cs <= end) {
    chunkNum++;
    const ce = new Date(Math.min(cs.getTime() + (CHUNK_DAYS - 1) * 86400000, end.getTime()));
    const from = cs.toISOString().slice(0, 10);
    const to = ce.toISOString().slice(0, 10);
    const bars = await getIntradayNMinCandles(ticker, from, to, 10);
    allBars.push(...bars);
    process.stdout.write(`  chunk ${chunkNum} (${from}→${to}): ${bars.length} bars\n`);
    cs = new Date(ce.getTime() + 86400000);
  }
  return allBars;
}

// ── Supabase upsert ─────────────────────────────────────────────────────────

async function upsertBars(ticker, bars) {
  if (!SUPABASE_URL || !SUPABASE_KEY || bars.length === 0) return 0;
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < bars.length; i += BATCH) {
    const batch = bars.slice(i, i + BATCH).map(b => ({
      ticker: ticker.toUpperCase(),
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: Math.round(b.volume),
      timeframe: `130M_${b.block}`,
    }));
    const r = await fetch(`${SUPABASE_URL}/rest/v1/stock_candles`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(batch),
    });
    if (!r.ok) {
      console.error(`  Supabase upsert failed: HTTP ${r.status} — ${await r.text()}`);
    } else {
      total += batch.length;
    }
  }
  return total;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);

  console.log(`\n=== Prefetch 130M Cache ===`);
  console.log(`Tickers: ${targetTickers.join(', ')}`);
  console.log(`Range: ${startDate} → ${endDate} (${lookbackDays} days)`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Delay: ${delayBetweenTickers}s between tickers (Tiingo free: 50 req/hr)\n`);

  const results = [];

  for (let i = 0; i < targetTickers.length; i++) {
    const ticker = targetTickers[i];
    console.log(`[${i + 1}/${targetTickers.length}] ${ticker}:`);

    try {
      // Fetch 10-min bars (paginated, 2 chunks for 120 days)
      const bars10m = await fetchPaginated10Min(ticker, startDate, endDate);
      if (bars10m.length === 0) {
        console.log(`  SKIP — no 10-min data from Tiingo IEX\n`);
        results.push({ ticker, status: 'no-data', bars: 0 });
        continue;
      }

      // Aggregate to 130M (13 ten-min bars per 130M block — perfect alignment)
      const bars130m = aggregate5MinTo130M(bars10m); // works for any minute-level bars
      console.log(`  ${bars10m.length} 10min bars → ${bars130m.length} 130M bars`);

      // Upsert to Supabase
      const upserted = await upsertBars(ticker, bars130m);
      console.log(`  Cached ${upserted} rows to Supabase\n`);
      results.push({ ticker, status: 'ok', bars: bars130m.length });
    } catch (err) {
      console.error(`  ERROR: ${err.message}\n`);
      results.push({ ticker, status: 'error', bars: 0, error: err.message });
    }

    // Pace requests to stay within Tiingo 50 req/hr limit
    if (i < targetTickers.length - 1) {
      console.log(`  Waiting ${delayBetweenTickers}s before next ticker...\n`);
      await sleep(delayBetweenTickers * 1000);
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  const ok = results.filter(r => r.status === 'ok');
  const noData = results.filter(r => r.status === 'no-data');
  const errors = results.filter(r => r.status === 'error');
  console.log(`OK: ${ok.length} tickers (${ok.reduce((s, r) => s + r.bars, 0)} total bars)`);
  if (noData.length > 0) console.log(`No data: ${noData.map(r => r.ticker).join(', ')}`);
  if (errors.length > 0) console.log(`Errors: ${errors.map(r => `${r.ticker} (${r.error})`).join(', ')}`);
  console.log('');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
