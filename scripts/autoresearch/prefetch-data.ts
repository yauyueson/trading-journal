/**
 * prefetch-data.ts — One-time Supabase → local data cache
 *
 * Fetches daily candle + IV data for all 25 tickers + SPY benchmark
 * from Supabase and writes to scripts/autoresearch/data-cache.json.
 *
 * The runner loads from this cache on every iteration, eliminating
 * 25+ Supabase round-trips per run (~10-30s savings).
 *
 * Historical data is immutable (DATA_END = 2026-02-28), so the cache
 * only needs to be refreshed when expanding the date range.
 *
 * Usage:
 *   npx tsx scripts/autoresearch/prefetch-data.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../../.env.local'), override: true });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const DATA_START = '2017-01-01';
const DATA_END = '2026-02-28';

// All tickers the agent can use + SPY for benchmark
const ALL_TICKERS = [
  'AAPL', 'AMD', 'AMZN', 'AVGO', 'BA', 'COIN', 'COST',
  'GLD', 'GOOG', 'GS', 'HOOD', 'IWM', 'JPM', 'LULU',
  'META', 'MSFT', 'MSTR', 'NFLX', 'NVDA', 'PLTR',
  'QQQ', 'SPY', 'TSLA', 'UBER', 'UNH',
];

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchTicker(ticker: string) {
  const [candleRows, ivRows] = await Promise.all([
    supabaseGet('stock_candles',
      `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=10000`),
    supabaseGet('orats_iv_cache',
      `select=date,iv30d,iv60d,hv20d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`),
  ]);

  const candles = candleRows.map((r: any) => ({
    date: r.date,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume ?? 0,
  }));

  const iv = ivRows.map((r: any) => ({
    date: r.date,
    iv30: r.iv30d ?? null,
    iv60: r.iv60d ?? null,
    hv20: r.hv20d ?? null,
  }));

  return { candles, iv };
}

async function computeSpyReturns(candleRows: any[]): Promise<{ dates: string[]; dailyReturns: number[] }> {
  const dates: string[] = [];
  const dailyReturns: number[] = [];
  for (let i = 1; i < candleRows.length; i++) {
    const prev = candleRows[i - 1].close;
    const cur = candleRows[i].close;
    if (prev > 0 && cur > 0) {
      dates.push(candleRows[i].date);
      dailyReturns.push((cur - prev) / prev);
    }
  }
  return { dates, dailyReturns };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env');
    process.exit(1);
  }

  console.log(`Fetching data for ${ALL_TICKERS.length} tickers from Supabase...`);
  console.log(`Range: ${DATA_START} → ${DATA_END}\n`);

  // Fetch all tickers in parallel (batched to avoid rate limits)
  const BATCH_SIZE = 8;
  const tickerData: Record<string, { candles: any[]; iv: any[] }> = {};

  for (let i = 0; i < ALL_TICKERS.length; i += BATCH_SIZE) {
    const batch = ALL_TICKERS.slice(i, i + BATCH_SIZE);
    process.stdout.write(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: [${batch.join(', ')}]...`);
    const results = await Promise.all(batch.map(t => fetchTicker(t)));
    for (let j = 0; j < batch.length; j++) {
      tickerData[batch[j]] = results[j];
      process.stdout.write(` ${batch[j]}:${results[j].candles.length}`);
    }
    process.stdout.write('\n');
  }

  // Compute SPY returns for benchmark
  const spyCandles = tickerData['SPY']?.candles ?? [];
  const spy = await computeSpyReturns(spyCandles);
  console.log(`\nSPY benchmark: ${spy.dates.length} daily return entries`);

  const cache = {
    generated: new Date().toISOString(),
    dataStart: DATA_START,
    dataEnd: DATA_END,
    tickers: tickerData,
    spy,
  };

  const outPath = path.resolve(__dirname, 'data-cache.json');
  fs.writeFileSync(outPath, JSON.stringify(cache));
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`\nCache written to: ${outPath} (${sizeMB} MB)`);
  console.log('Runner will now load from local cache on every iteration.');
}

main().catch(err => { console.error(err); process.exit(1); });
