// api/setup-iv-rank.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCandles } from './polygon-client.js';

// ---- Environment Loading ----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');

if (fs.existsSync(envPath)) {
    console.log('Loading .env.local...');
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            let value = parts.slice(1).join('=').trim();
            // Remove surrounding quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key && !key.startsWith('#')) {
                process.env[key] = value;
            }
        }
    });
} else {
    console.warn('Warning: .env.local not found.');
}

// Re-implement logic from backfill-iv-history.js since we can't easily import the handler
// (The handler assumes Express req/res objects)

const ROLLING_DAYS = 30;

function getSupabase() {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    return { url, key };
}

async function fetchAllHistorical(ticker) {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - 400);

    const fromStr = fromDate.toISOString().split('T')[0];
    const toStr = toDate.toISOString().split('T')[0];

    const candles = await getCandles(ticker, fromStr, toStr, 'day');
    return candles.sort((a, b) => a.date.localeCompare(b.date));
}

function computeRollingRV(sortedPoints) {
    const results = [];
    if (!sortedPoints || sortedPoints.length < ROLLING_DAYS + 1) return results;

    for (let i = ROLLING_DAYS; i < sortedPoints.length; i++) {
        const window = sortedPoints.slice(i - ROLLING_DAYS, i + 1);
        const prices = window.map((p) => p.close);
        const returns = [];
        for (let j = 1; j < prices.length; j++) {
            returns.push(Math.log(prices[j] / prices[j - 1]));
        }

        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
        const std = Math.sqrt(variance);
        const annualized = std * Math.sqrt(252);

        results.push({
            date: window[window.length - 1].date,
            rv30: annualized
        });
    }
    return results;
}

async function upsertSnapshots(supabaseUrl, supabaseKey, ticker, snapshots) {
    const tickerUpper = ticker.toUpperCase();
    // Safety first: process one by one to ensure no data loss on conflict
    const BATCH_SIZE = 1;
    let saved = 0;

    for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
        const chunk = snapshots.slice(i, i + BATCH_SIZE);
        const rows = chunk.map(s => ({
            ticker: tickerUpper,
            recorded_date: s.date,
            iv30: s.rv30,
            iv90: null,
        }));

        try {
            const res = await fetch(`${supabaseUrl}/rest/v1/ticker_iv_snapshots`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates,on_conflict=ticker,recorded_date',
                },
                body: JSON.stringify(rows),
            });

            if (res.ok) {
                saved += rows.length;
                if (saved % 20 === 0) process.stdout.write('.'); // Progress dot
            } else {
                // Determine if it is a conflict or other error
                // console.error(`Failed: ${res.statusText}`); 
            }

        } catch (e) {
            // console.warn('Row failed:', e.message);
        }
    }
    console.log(''); // New line after dots
    return saved;
}

async function run() {
    const tickers = ['AMZN', 'LULU', 'HOOD', 'OKLO', 'CRWV', 'COIN', 'BMNR', 'MSTR', 'PLTR', 'NFLX', 'NVDA', 'GOOG', 'AVGO'];
    console.log(`Starting IV Rank backfill for: ${tickers.join(', ')}`);

    const { url, key } = getSupabase();
    if (!url || !key) {
        console.error('Missing Supabase credentials.');
        process.exit(1);
    }

    for (const t of tickers) {
        // Rate limit guard: Wait 15s between requests
        if (t !== tickers[0]) {
            console.log('Waiting 15s to avoid API rate limits...');
            await new Promise(r => setTimeout(r, 15000));
        }

        process.stdout.write(`Processing ${t}... `);
        try {
            console.log(`\n  - Fetching history for ${t}...`);
            const points = await fetchAllHistorical(t);
            console.log(`  - Got ${points.length} daily candles.`);

            if (points.length < ROLLING_DAYS + 1) {
                console.log(`  - Skipped (not enough data: ${points.length} days)`);
                continue;
            }

            console.log(`  - Computing RV30...`);
            const snapshots = computeRollingRV(points);

            console.log(`  - Upserting ${snapshots.length} snapshots to Supabase...`);
            const saved = await upsertSnapshots(url, key, t, snapshots);
            console.log(`  -> Done. Saved ${saved} snapshots for ${t}.`);
        } catch (e) {
            console.log(`  -> Error processing ${t}: ${e.message}`);
        }
    }
    console.log('\nAll done! IV Rank data is now populated.');
}

run();
