/**
 * repair-truncated-chains.ts — Single-ticker backfill for dates where
 * the multi-ticker batch prefetch silently truncated at ORATS's 2050-row
 * response cap, leaving fetch_log entries with rows_fetched=0.
 *
 * Strategy:
 *   1. For each affected ticker, query SQLite for dates where fetch_log
 *      says 0 rows.
 *   2. Confirm the ticker had a Tiingo candle on that date (meaning it
 *      actually traded) — otherwise the 0-row is legitimate.
 *   3. Delete the 0-row fetch_log entry.
 *   4. Call fetchHistoricalChain() single-ticker; it'll hit ORATS fresh.
 *   5. Rate-limit to stay under 600 RPM.
 *
 * Usage:
 *   npx tsx scripts/repair-truncated-chains.ts
 *   npx tsx scripts/repair-truncated-chains.ts --tickers VRT,CRWD,COIN,HOOD,LULU,MSTR,PLTR,UBER,ARM
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import Database from 'better-sqlite3';
import { fetchHistoricalChain, initDB, closeDB, getApiCallCount, resetApiCallCount, clearFetchLogEntries } from '../src/lib/backtest/chain-cache';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';

const RATE_LIMIT_RPM = 600;
const MIN_INTERVAL_MS = Math.ceil(60_000 / RATE_LIMIT_RPM);
const REPORT_EVERY = 50;

const DEFAULT_TICKERS = ['VRT', 'CRWD', 'COIN', 'HOOD', 'LULU', 'MSTR', 'PLTR', 'UBER', 'ARM'];

function getArg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function fetchTradingDates(ticker: string): Promise<Set<string>> {
  const params = new URLSearchParams({
    select: 'date',
    ticker: `eq.${ticker}`,
    timeframe: 'eq.1D',
    order: 'date.asc',
    limit: '10000',
  });
  const url = `${SUPABASE_URL}/rest/v1/stock_candles?${params.toString()}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase candles fetch failed for ${ticker}: ${res.status}`);
  const rows = (await res.json()) as Array<{ date: string }>;
  return new Set(rows.map(r => r.date));
}

async function main() {
  if (!ORATS_TOKEN) { console.error('ERROR: ORATS_API_TOKEN not set'); process.exit(1); }
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('ERROR: Supabase credentials not set'); process.exit(1); }

  const tickersArg = getArg('--tickers');
  const tickers = tickersArg
    ? tickersArg.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_TICKERS;

  console.log(`Truncation repair — ${tickers.length} tickers: ${tickers.join(', ')}\n`);

  // Initialize chain-cache DB via public API (so helpers share the same handle)
  initDB();
  resetApiCallCount();

  // We also need a direct handle to read fetch_log + delete 0-row entries.
  const dbPath = path.resolve(process.cwd(), 'data', 'option-chains.sqlite');
  const db = new Database(dbPath);

  let totalFetched = 0;
  let totalSkipped = 0;
  let totalFixed = 0;
  let totalErrors = 0;
  const start = Date.now();

  for (const ticker of tickers) {
    // Actual trading dates per Tiingo
    const tradingDates = await fetchTradingDates(ticker);
    // Dates where fetch_log says rows=0 (the truncation evidence)
    const zeroRowDates = db.prepare(`
      SELECT trade_date FROM fetch_log WHERE ticker = ? AND rows_fetched = 0 ORDER BY trade_date
    `).all(ticker) as Array<{ trade_date: string }>;

    // Only retry dates where the ticker actually traded
    const needsRetry = zeroRowDates.filter(r => tradingDates.has(r.trade_date)).map(r => r.trade_date);
    console.log(`${ticker}: ${zeroRowDates.length} zero-row log entries, ${needsRetry.length} correspond to actual trading days — retrying`);

    if (needsRetry.length === 0) continue;

    // Clear BOTH fetch_log AND fetch_log_intervals so isCovered returns
    // false on the retry. Phase 1.h moved coverage authority to the
    // interval list — deleting fetch_log alone is no longer enough.
    for (const d of needsRetry) {
      clearFetchLogEntries(ticker, d);
    }

    let fetched = 0;
    let emptyAgain = 0;
    let errors = 0;
    const tickerStart = Date.now();

    for (let i = 0; i < needsRetry.length; i++) {
      const date = needsRetry[i];
      const apiBefore = getApiCallCount();
      try {
        const rows = await fetchHistoricalChain(ORATS_TOKEN, ticker, date, undefined, [60, 330]);
        if (rows.length > 0) fetched++;
        else emptyAgain++;
        // Rate limit
        if (getApiCallCount() > apiBefore) {
          const elapsed = Date.now() - tickerStart;
          const calls = fetched + emptyAgain;
          const minElapsed = calls * MIN_INTERVAL_MS;
          if (elapsed < minElapsed) await new Promise(r => setTimeout(r, minElapsed - elapsed));
        }
      } catch (err: unknown) {
        errors++;
        await new Promise(r => setTimeout(r, 500));
      }

      if ((i + 1) % REPORT_EVERY === 0 || i === needsRetry.length - 1) {
        const pct = (((i + 1) / needsRetry.length) * 100).toFixed(1);
        process.stdout.write(`\r  ${ticker} ${i + 1}/${needsRetry.length} (${pct}%) — ${fetched} fixed, ${emptyAgain} still-empty, ${errors} err      `);
      }
    }
    process.stdout.write('\n');
    totalFetched += fetched;
    totalSkipped += emptyAgain;
    totalFixed += fetched;
    totalErrors += errors;
  }

  const totalSecs = ((Date.now() - start) / 1000).toFixed(1);
  console.log('─────────────────────────────────────────────────');
  console.log(`Done. ${totalFixed} dates fixed, ${totalSkipped} still empty (legitimate no-data), ${totalErrors} errors — ${totalSecs}s`);

  db.close();
  closeDB();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
