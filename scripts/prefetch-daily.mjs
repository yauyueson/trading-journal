#!/usr/bin/env node
/**
 * Pre-populate Supabase stock_candles cache with daily (1D) bars from Tiingo.
 * Fetches historical daily candles from 2016-01-01 onward for key tickers,
 * ensuring enough stock price history for backtesting starting at 2017-01-03.
 *
 * Usage:
 *   node scripts/prefetch-daily.mjs                          # all target tickers
 *   node scripts/prefetch-daily.mjs --tickers SPY,QQQ,IWM    # specific tickers
 *   node scripts/prefetch-daily.mjs --from 2015-01-01        # custom start date
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { getCandles } from '../lib/tiingo-client.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const TARGET_TICKERS = [
    'QQQ', 'SPY', 'IWM', 'META', 'GOOGL', 'TSLA', 'MSFT', 'NFLX',
];

// ── Parse args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const tickers = (getArg('--tickers') || '').split(',').filter(Boolean);
const targetTickers = tickers.length > 0 ? tickers.map(t => t.toUpperCase()) : TARGET_TICKERS;
const fromDate = getArg('--from') || '2016-01-01';
const toDate = getArg('--to') || new Date().toISOString().split('T')[0];

// ── Supabase upsert ─────────────────────────────────────────────────────────
async function upsertCandles(ticker, candles) {
    if (!SUPABASE_URL || !SUPABASE_KEY || candles.length === 0) return 0;
    const BATCH = 500;
    let total = 0;
    for (let i = 0; i < candles.length; i += BATCH) {
        const batch = candles.slice(i, i + BATCH).map(c => ({
            ticker: ticker.toUpperCase(),
            date: c.date,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: Math.round(c.volume),
            timeframe: '1D',
        }));
        try {
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
                console.warn(`  [${ticker}] Upsert batch ${i}-${i + batch.length} failed: HTTP ${r.status}`);
            } else {
                total += batch.length;
            }
        } catch (err) {
            console.warn(`  [${ticker}] Upsert error:`, err.message);
        }
    }
    return total;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Prefetch Daily Candles — Tiingo → Supabase stock_candles  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`  Tickers: ${targetTickers.join(', ')}`);
    console.log(`  Range:   ${fromDate} → ${toDate}`);
    console.log(`  Target:  Supabase stock_candles (1D timeframe)\n`);

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('ERROR: Missing SUPABASE_URL or SUPABASE_KEY. Check .env.local');
        process.exit(1);
    }

    for (const ticker of targetTickers) {
        process.stdout.write(`  ${ticker.padEnd(6)} fetching...`);
        try {
            const candles = await getCandles(ticker, fromDate, toDate, 'day', 1);
            if (candles.length === 0) {
                console.log(` no data`);
                continue;
            }
            process.stdout.write(` ${candles.length} candles (${candles[0].date} → ${candles[candles.length - 1].date}) → `);
            const upserted = await upsertCandles(ticker, candles);
            console.log(`${upserted} upserted`);
        } catch (err) {
            console.log(` FAILED: ${err.message}`);
        }
    }

    console.log('\nDone.');
}

main().catch(console.error);
