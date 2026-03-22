#!/usr/bin/env node
// scripts/download-candles.js
// Bulk-download daily candles from Tiingo and store in Supabase stock_candles table.
// Usage: node scripts/download-candles.js
//   Options:
//     --from YYYY-MM-DD   Start date (default: 2019-01-01)
//     --to   YYYY-MM-DD   End date   (default: today)
//     --ticker AAPL        Download a single ticker only
//     --dry-run            Fetch but don't write to DB

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { createClient } from '@supabase/supabase-js';

// ── Config ──────────────────────────────────────────────────────────────────────

const DEFAULT_TICKERS = [
    'SPY', 'QQQ', 'GOOGL', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
    'AAPL', 'NVDA', 'AMD', 'COST', 'IREN', 'BA', 'AMZN', 'HOOD',
    'CRWV', 'COIN', 'MSTR', 'PLTR', 'AVGO', 'LULU', 'UBER', 'GS',
    'UNH', 'IWM', 'GLD',
];

const args = process.argv.slice(2);
function getArg(flag) {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}
const dryRun = args.includes('--dry-run');
const singleTicker = getArg('--ticker');
const fromDate = getArg('--from') || '2019-01-01';
const toDate = getArg('--to') || new Date().toISOString().split('T')[0];
const tickers = singleTicker ? [singleTicker.toUpperCase()] : DEFAULT_TICKERS;

// ── Tiingo fetch ────────────────────────────────────────────────────────────────

const TIINGO_TOKEN = process.env.TIINGO_API_TOKEN;
if (!TIINGO_TOKEN) {
    console.error('ERROR: TIINGO_API_TOKEN not set in .env.local');
    process.exit(1);
}

async function fetchTiingoCandles(ticker, from, to) {
    const url = `https://api.tiingo.com/tiingo/daily/${ticker.toLowerCase()}/prices?startDate=${from}&endDate=${to}&format=json`;
    const res = await fetch(url, {
        headers: {
            'Authorization': `Token ${TIINGO_TOKEN}`,
            'Content-Type': 'application/json',
        },
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Tiingo ${res.status}: ${text}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.map(c => ({
        ticker: ticker.toUpperCase(),
        date: c.date.split('T')[0],
        open: Number(c.adjOpen ?? c.open ?? 0),
        high: Number(c.adjHigh ?? c.high ?? 0),
        low: Number(c.adjLow ?? c.low ?? 0),
        close: Number(c.adjClose ?? c.close ?? 0),
        volume: Math.round(Number(c.adjVolume ?? c.volume ?? 0)),
        timeframe: '1D',
    }));
}

// ── Supabase ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function upsertCandles(candles) {
    // Supabase upsert in batches of 500
    const BATCH = 500;
    let inserted = 0;

    for (let i = 0; i < candles.length; i += BATCH) {
        const batch = candles.slice(i, i + BATCH);
        const { error } = await supabase
            .from('stock_candles')
            .upsert(batch, { onConflict: 'ticker,date,timeframe' });

        if (error) {
            throw new Error(`Supabase upsert error: ${error.message}`);
        }
        inserted += batch.length;
    }
    return inserted;
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n📥 Bulk Candle Download`);
    console.log(`   Tickers: ${tickers.length} (${tickers.join(', ')})`);
    console.log(`   Range:   ${fromDate} → ${toDate}`);
    console.log(`   Mode:    ${dryRun ? 'DRY RUN (no DB writes)' : 'LIVE (writing to Supabase)'}\n`);

    const results = [];
    let totalCandles = 0;

    for (let i = 0; i < tickers.length; i++) {
        const ticker = tickers[i];
        const progress = `[${i + 1}/${tickers.length}]`;

        try {
            console.log(`${progress} Fetching ${ticker}...`);
            const candles = await fetchTiingoCandles(ticker, fromDate, toDate);

            if (candles.length === 0) {
                console.log(`${progress} ${ticker}: no data returned (may not exist on Tiingo)`);
                results.push({ ticker, status: 'empty', count: 0 });
                continue;
            }

            const firstDate = candles[0].date;
            const lastDate = candles[candles.length - 1].date;

            if (dryRun) {
                console.log(`${progress} ${ticker}: ${candles.length} candles (${firstDate} → ${lastDate}) [dry run]`);
            } else {
                const count = await upsertCandles(candles);
                console.log(`${progress} ${ticker}: ${count} candles upserted (${firstDate} → ${lastDate})`);
            }

            totalCandles += candles.length;
            results.push({ ticker, status: 'ok', count: candles.length, from: firstDate, to: lastDate });

            // Respect Tiingo rate limit: 50 req/hr → 1 req per 1.2s minimum
            // Wait 1.5s between tickers to be safe
            if (i < tickers.length - 1) {
                await new Promise(r => setTimeout(r, 1500));
            }
        } catch (err) {
            console.error(`${progress} ${ticker}: FAILED — ${err.message}`);
            results.push({ ticker, status: 'error', error: err.message });
        }
    }

    // Summary
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Download complete: ${totalCandles.toLocaleString()} candles across ${results.filter(r => r.status === 'ok').length}/${tickers.length} tickers`);

    const failed = results.filter(r => r.status === 'error');
    if (failed.length > 0) {
        console.log(`\nFailed tickers:`);
        failed.forEach(f => console.log(`  ${f.ticker}: ${f.error}`));
    }

    const empty = results.filter(r => r.status === 'empty');
    if (empty.length > 0) {
        console.log(`\nEmpty (no data):`);
        empty.forEach(f => console.log(`  ${f.ticker}`));
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
