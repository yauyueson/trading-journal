/**
 * prefetch-chains.ts — Bulk ORATS chain prefetcher (batch-per-date).
 *
 * ORATS `/hist/strikes` accepts comma-separated tickers, returning one
 * response for all of them. We walk the union of trading dates across
 * the target tickers and, for each date, make ONE API call for only the
 * tickers not already cached. This reduces API calls from O(tickers × dates)
 * to O(dates), typically 20-30× fewer calls.
 *
 * Trading-date union comes from Supabase `stock_candles` (each ticker's
 * actual listing dates).
 *
 * Usage:
 *   npx tsx scripts/prefetch-chains.ts \
 *     --tickers CRM,ORCL,CRWD,SHOP,PANW,ANET,VRT,ARM,NOW,AVGO,BA,COIN,HOOD,LULU,MSTR,PLTR,UBER \
 *     --from 2017-01-01 --to 2026-02-28 --dte-range 60,330
 *
 * Flags:
 *   --tickers       comma-separated list of tickers (default: 17 expansion tickers)
 *   --from          start date (default 2017-01-01; WFA will ignore pre-2018 data)
 *   --to            end date (default 2026-02-28)
 *   --dte-range     ORATS dte= filter (default 60,330 — narrows to LEAP-range strikes)
 *   --max-calls     hard abort if API call count reaches this (defaults to no cap)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { fetchHistoricalChainsBatch, initDB, closeDB, getApiCallCount, resetApiCallCount } from '../src/lib/backtest/chain-cache';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';

// Rate limit: ORATS allows 1000 req/min. Stay at ~600 RPM to leave headroom
// for concurrent autoresearch runs that might share the token.
const RATE_LIMIT_RPM = 600;
const MIN_INTERVAL_MS = Math.ceil(60_000 / RATE_LIMIT_RPM);
const REPORT_EVERY = 25;

const DEFAULT_TICKERS = [
  // 9 new
  'CRM', 'ORCL', 'CRWD', 'SHOP', 'PANW', 'ANET', 'VRT', 'ARM', 'NOW',
  // 8 thin (existing cache has only 2020-2022 data)
  'AVGO', 'BA', 'COIN', 'HOOD', 'LULU', 'MSTR', 'PLTR', 'UBER',
];

function getArg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function fetchTradingDates(ticker: string, from: string, to: string): Promise<string[]> {
  const params = new URLSearchParams({
    select: 'date',
    ticker: `eq.${ticker}`,
    timeframe: 'eq.1D',
    date: `gte.${from}`,
    order: 'date.asc',
    limit: '10000',
  });
  const url = `${SUPABASE_URL}/rest/v1/stock_candles?${params.toString()}&date=lte.${to}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase candles fetch failed for ${ticker}: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as Array<{ date: string }>;
  return rows.map(r => r.date);
}

async function main() {
  if (!ORATS_TOKEN) { console.error('ERROR: ORATS_API_TOKEN not set'); process.exit(1); }
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('ERROR: Supabase credentials not set'); process.exit(1); }

  const tickersArg = getArg('--tickers');
  const tickers = tickersArg
    ? tickersArg.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_TICKERS;
  const from = getArg('--from') ?? '2017-01-01';
  const to = getArg('--to') ?? '2026-02-28';
  const dteRangeArg = getArg('--dte-range');
  const dteRange: [number, number] | undefined = dteRangeArg
    ? (() => { const [lo, hi] = dteRangeArg.split(',').map(s => Number(s.trim())); return [lo, hi] as [number, number]; })()
    : [60, 330];
  const maxCallsArg = getArg('--max-calls');
  const maxCalls = maxCallsArg ? Number(maxCallsArg) : Number.POSITIVE_INFINITY;

  console.log(`ORATS chain prefetch (batch-per-date) — ${tickers.length} tickers, ${from} → ${to}`);
  console.log(`Tickers: ${tickers.join(', ')}`);
  console.log(`DTE filter: [${dteRange[0]}, ${dteRange[1]}]`);
  console.log(`Rate limit: ~${RATE_LIMIT_RPM} RPM (${MIN_INTERVAL_MS}ms between calls)`);
  if (isFinite(maxCalls)) console.log(`Max API calls: ${maxCalls} (hard abort)`);
  console.log('');

  // Build union of trading dates across tickers (each ticker has its own
  // listing range — e.g. ARM only started Sep 2023).
  console.log('Building trading-date union...');
  const dateSet = new Set<string>();
  for (const t of tickers) {
    const ds = await fetchTradingDates(t, from, to);
    ds.forEach(d => dateSet.add(d));
    console.log(`  ${t}: ${ds.length} dates (${ds[0] ?? '—'} → ${ds[ds.length - 1] ?? '—'})`);
  }
  const allDates = [...dateSet].sort();
  console.log(`\nUnion: ${allDates.length} unique dates\n`);

  initDB();
  resetApiCallCount();

  const start = Date.now();
  let apiCalls = 0;
  let cacheHitDates = 0;  // dates where every ticker was already cached
  let errors = 0;

  for (let i = 0; i < allDates.length; i++) {
    const date = allDates[i];
    // Only include tickers that actually traded on/before this date
    // (skip ARM for 2018 etc. — no data available). Tickers with no
    // Supabase candle for this date get excluded from the batch.
    const activeTickers: string[] = [];
    for (const t of tickers) {
      // Use isCached check inside batch function — it'll skip cached.
      // For tickers that never traded on this date, ORATS returns 0 rows
      // and the fetch_log records the empty fetch so we don't retry.
      activeTickers.push(t);
    }

    if (apiCalls >= maxCalls) {
      process.stdout.write('\n');
      console.warn(`\n⚠ Hard cap of ${maxCalls} API calls reached — aborting at date ${date} (${i}/${allDates.length}).`);
      break;
    }
    const apiBefore = getApiCallCount();
    try {
      await fetchHistoricalChainsBatch(ORATS_TOKEN, activeTickers, date, undefined, dteRange);
      if (getApiCallCount() > apiBefore) {
        apiCalls += getApiCallCount() - apiBefore;
        // Rate-limit only when we actually hit the API
        const elapsed = Date.now() - start;
        const minElapsed = apiCalls * MIN_INTERVAL_MS;
        if (elapsed < minElapsed) {
          await new Promise(r => setTimeout(r, minElapsed - elapsed));
        }
      } else {
        cacheHitDates++;
      }
    } catch (err: unknown) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ${date}: ${msg}`);
      await new Promise(r => setTimeout(r, 1000));  // back off on error
    }

    if ((i + 1) % REPORT_EVERY === 0 || i === allDates.length - 1) {
      const pct = (((i + 1) / allDates.length) * 100).toFixed(1);
      const rate = apiCalls > 0 ? (apiCalls / ((Date.now() - start) / 1000)).toFixed(1) : '—';
      const etaSec = apiCalls > 0 ? (((allDates.length - (i + 1)) / (apiCalls / ((Date.now() - start) / 1000)))).toFixed(0) : '—';
      process.stdout.write(`\r  ${i + 1}/${allDates.length} (${pct}%) — ${apiCalls} API, ${cacheHitDates} fully-cached, ${errors} err, ${rate} RPS, ETA ${etaSec}s      `);
    }
  }

  process.stdout.write('\n');
  const totalSecs = ((Date.now() - start) / 1000).toFixed(1);
  console.log('─────────────────────────────────────────────────');
  console.log(`Done. ${apiCalls} API calls, ${cacheHitDates} fully-cached dates, ${errors} errors — ${totalSecs}s`);

  closeDB();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
