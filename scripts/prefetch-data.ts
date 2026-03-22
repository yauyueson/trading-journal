/**
 * Unified Data Prefetch — Candles + IV + Option Chains
 *
 * Orchestrates all data sources needed for the comprehensive evaluation:
 *   Phase 1: Stock candles from Tiingo → Supabase stock_candles
 *   Phase 2: Historical IV from ORATS → Supabase orats_iv_cache
 *   Phase 3: Option chains from ORATS → SQLite chain-cache
 *   Phase 4: Verification — check all 15 tickers × dates have data
 *
 * Usage:
 *   npx tsx scripts/prefetch-data.ts --from 2017-01-01
 *   npx tsx scripts/prefetch-data.ts --verify          # verify only, no fetching
 *   npx tsx scripts/prefetch-data.ts --phase candles   # run single phase
 *   npx tsx scripts/prefetch-data.ts --phase iv
 *   npx tsx scripts/prefetch-data.ts --phase chains
 *
 * Ticker notes:
 *   - META was "FB" on Tiingo before Oct 2022. Tiingo handles this under META.
 *   - GOOGL: Standardized to GOOGL (Alphabet Class A) across all data sources.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env ────────────────────────────────────────────

const envPath = path.resolve(__dirname, '../.env.local');
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

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const TIINGO_TOKEN = process.env.TIINGO_API_TOKEN || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';

const ALL_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
  'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
  'META', 'NFLX', 'GOOGL', 'GS', 'COST',
];

// No mapping needed — all tickers already use ORATS-compatible symbols
const ORATS_TICKER_MAP: Record<string, string> = {};
function oratsTickerFor(ticker: string): string {
  return ORATS_TICKER_MAP[ticker] || ticker;
}

// CLI args
const args = process.argv.slice(2);
function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}
const FROM_DATE = getArg('--from') || '2017-01-01';
const TO_DATE = getArg('--to') || new Date().toISOString().split('T')[0];
const SINGLE_TICKER = getArg('--ticker');
const PHASE_ONLY = getArg('--phase'); // 'candles' | 'iv' | 'chains' | null
const VERIFY_ONLY = args.includes('--verify');

const tickers = SINGLE_TICKER ? [SINGLE_TICKER.toUpperCase()] : ALL_TICKERS;

// ── Supabase helpers ────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function supabaseUpsert(table: string, rows: any[], onConflict: string): Promise<number> {
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${table} upsert ${res.status}: ${text}`);
    }
    inserted += batch.length;
  }
  return inserted;
}

// ── Phase 1: Stock Candles (Tiingo → Supabase) ─────────

async function fetchTiingoCandles(ticker: string, from: string, to: string) {
  const url = `https://api.tiingo.com/tiingo/daily/${ticker.toLowerCase()}/prices?startDate=${from}&endDate=${to}&format=json`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Token ${TIINGO_TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Tiingo ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((c: any) => ({
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

async function phaseCandles() {
  console.log('\n  PHASE 1: Stock Candles (Tiingo → Supabase)');
  console.log('  ' + '─'.repeat(55));

  if (!TIINGO_TOKEN) {
    console.log('    SKIP: TIINGO_API_TOKEN not set');
    return;
  }

  let totalCandles = 0;
  let totalNew = 0;

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const progress = `[${i + 1}/${tickers.length}]`;

    try {
      // Check existing data range
      const existing = await supabaseGet('stock_candles',
        `select=date&ticker=eq.${ticker}&timeframe=eq.1D&order=date.asc&limit=1`);
      const existingEnd = await supabaseGet('stock_candles',
        `select=date&ticker=eq.${ticker}&timeframe=eq.1D&order=date.desc&limit=1`);

      const existingFrom = existing[0]?.date || 'none';
      const existingTo = existingEnd[0]?.date || 'none';

      // Only fetch if we need earlier data or more recent data
      const needEarlier = existingFrom === 'none' || existingFrom > FROM_DATE;
      const needLater = existingTo === 'none' || existingTo < TO_DATE;

      if (!needEarlier && !needLater) {
        console.log(`  ${progress} ${ticker}: already cached (${existingFrom} → ${existingTo})`);
        continue;
      }

      const candles = await fetchTiingoCandles(ticker, FROM_DATE, TO_DATE);
      if (candles.length === 0) {
        console.log(`  ${progress} ${ticker}: no data from Tiingo`);
        continue;
      }

      const count = await supabaseUpsert('stock_candles', candles, 'ticker,date,timeframe');
      totalCandles += count;
      totalNew += needEarlier ? count : 0;
      console.log(`  ${progress} ${ticker}: ${count} candles (${candles[0].date} → ${candles[candles.length - 1].date})`);

      // Tiingo rate limit: 50 req/hr → wait 1.5s
      if (i < tickers.length - 1) await new Promise(r => setTimeout(r, 1500));
    } catch (err: any) {
      console.error(`  ${progress} ${ticker}: FAILED — ${err.message}`);
    }
  }

  console.log(`    Total: ${totalCandles.toLocaleString()} candles upserted\n`);
}

// ── Phase 2: IV History (ORATS → Supabase) ──────────────

async function phaseIV() {
  console.log('\n  PHASE 2: IV History (ORATS → Supabase orats_iv_cache)');
  console.log('  ' + '─'.repeat(55));

  if (!ORATS_TOKEN) {
    console.log('    SKIP: ORATS_API_TOKEN not set');
    return;
  }

  // Dynamic import of orats-client (ESM)
  const { getHistoricalCores } = await import('../lib/orats-client.js');

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const oratsTicker = oratsTickerFor(ticker);
    const progress = `[${i + 1}/${tickers.length}]`;

    try {
      // Check cached count
      const cached = await supabaseGet('orats_iv_cache',
        `select=date&ticker=eq.${ticker}&date=gte.${FROM_DATE}&date=lte.${TO_DATE}&order=date.asc&limit=1`);
      const cachedEnd = await supabaseGet('orats_iv_cache',
        `select=date&ticker=eq.${ticker}&date=gte.${FROM_DATE}&date=lte.${TO_DATE}&order=date.desc&limit=1`);

      const cachedFrom = cached[0]?.date;
      const cachedTo = cachedEnd[0]?.date;

      // If cache covers our range, skip
      if (cachedFrom && cachedTo && cachedFrom <= FROM_DATE && cachedTo >= TO_DATE) {
        console.log(`  ${progress} ${ticker}: IV already cached (${cachedFrom} → ${cachedTo})`);
        continue;
      }

      // Fetch full history from ORATS
      console.log(`  ${progress} ${ticker}: fetching ORATS cores (${oratsTicker})...`);
      const cores = await getHistoricalCores(oratsTicker);

      if (!cores || cores.length === 0) {
        console.log(`  ${progress} ${ticker}: no ORATS data returned`);
        continue;
      }

      const rows = cores
        .filter((c: any) => {
          const d = c.tradeDate || c.date;
          return d && d >= FROM_DATE && d <= TO_DATE;
        })
        .map((c: any) => ({
          ticker: ticker.toUpperCase(), // store under canonical ticker
          date: c.tradeDate || c.date,
          iv30d: c.iv30d != null ? Number(c.iv30d) : null,
          iv60d: c.iv60d != null ? Number(c.iv60d) : null,
          hv20d: c.clsHv20d != null ? Number(c.clsHv20d) : null,
          hv30d: c.clsHv30d != null ? Number(c.clsHv30d) : null,
          hv60d: c.clsHv60d != null ? Number(c.clsHv60d) : null,
        }));

      if (rows.length === 0) {
        console.log(`  ${progress} ${ticker}: no rows in date range`);
        continue;
      }

      const count = await supabaseUpsert('orats_iv_cache', rows, 'ticker,date');
      console.log(`  ${progress} ${ticker}: ${count} IV rows cached (${rows[0].date} → ${rows[rows.length - 1].date})`);

      // Brief pause between ORATS calls
      if (i < tickers.length - 1) await new Promise(r => setTimeout(r, 500));
    } catch (err: any) {
      console.error(`  ${progress} ${ticker}: FAILED — ${err.message}`);
    }
  }

  console.log('');
}

// ── Phase 3: Option Chains (ORATS → SQLite) ─────────────

async function phaseChains() {
  console.log('\n  PHASE 3: Option Chains (ORATS → SQLite chain-cache)');
  console.log('  ' + '─'.repeat(55));

  if (!ORATS_TOKEN) {
    console.log('    SKIP: ORATS_API_TOKEN not set');
    return;
  }

  const { initDB, closeDB, getCacheStats, prefetchAll } = await import('../src/lib/backtest/chain-cache');

  initDB();
  const statsBefore = getCacheStats();
  console.log(`    Cache before: ${statsBefore.totalRows.toLocaleString()} rows, ${statsBefore.totalDates.toLocaleString()} ticker-dates`);
  console.log(`    Cached tickers: ${statsBefore.tickers.join(', ')}`);

  // Build list of trading dates from candle data
  // Use SPY as reference for trading calendar
  const spyCandles = await supabaseGet('stock_candles',
    `select=date&ticker=eq.SPY&timeframe=eq.1D&date=gte.${FROM_DATE}&date=lte.${TO_DATE}&order=date.asc&limit=5000`);

  const tradingDates = spyCandles.map((r: any) => r.date);
  console.log(`    Trading days (SPY calendar): ${tradingDates.length} (${tradingDates[0]} → ${tradingDates[tradingDates.length - 1]})`);

  // Map tickers to ORATS symbols
  const oratsTickers = tickers.map(t => oratsTickerFor(t));
  console.log(`    Tickers for ORATS: ${oratsTickers.join(', ')}`);

  const startTime = Date.now();
  let lastPrint = 0;

  const apiCalls = await prefetchAll(
    ORATS_TOKEN,
    oratsTickers,
    tradingDates,
    undefined,
    (done: number, total: number, calls: number) => {
      const now = Date.now();
      if (now - lastPrint > 2000 || done === total) {
        const pct = Math.round(done / total * 100);
        const elapsed = ((now - startTime) / 1000).toFixed(0);
        process.stdout.write(`\r    Progress: ${done}/${total} dates (${pct}%) | ${calls} API calls | ${elapsed}s    `);
        lastPrint = now;
      }
    },
  );
  console.log('');

  const statsAfter = getCacheStats();
  console.log(`    Cache after: ${statsAfter.totalRows.toLocaleString()} rows, ${statsAfter.totalDates.toLocaleString()} ticker-dates`);
  console.log(`    API calls used: ${apiCalls}`);
  console.log(`    Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

  closeDB();
}

// ── Phase 4: Verification ───────────────────────────────

async function phaseVerify() {
  console.log('\n  PHASE 4: Data Verification');
  console.log('  ' + '─'.repeat(55));

  let allGood = true;

  // 4a: Check candles
  console.log('\n    Candles (stock_candles):');
  for (const ticker of tickers) {
    const countRes = await supabaseGet('stock_candles',
      `select=date&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${FROM_DATE}&date=lte.${TO_DATE}&order=date.asc&limit=1`);
    const endRes = await supabaseGet('stock_candles',
      `select=date&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${FROM_DATE}&date=lte.${TO_DATE}&order=date.desc&limit=1`);
    const totalRes = await supabaseGet('stock_candles',
      `select=date&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${FROM_DATE}&date=lte.${TO_DATE}&limit=5000`);

    const from = countRes[0]?.date || '???';
    const to = endRes[0]?.date || '???';
    const count = totalRes.length;
    const ok = count >= 1500; // ~7 years × 252 days
    if (!ok) allGood = false;
    console.log(`      ${ok ? 'OK' : 'XX'} ${ticker.padEnd(6)} ${String(count).padStart(5)} rows  (${from} → ${to})`);
  }

  // 4b: Check IV cache
  console.log('\n    IV Cache (orats_iv_cache):');
  for (const ticker of tickers) {
    const countRes = await supabaseGet('orats_iv_cache',
      `select=date&ticker=eq.${ticker}&date=gte.${FROM_DATE}&date=lte.${TO_DATE}&limit=5000`);
    const firstRes = await supabaseGet('orats_iv_cache',
      `select=date&ticker=eq.${ticker}&date=gte.${FROM_DATE}&order=date.asc&limit=1`);
    const lastRes = await supabaseGet('orats_iv_cache',
      `select=date&ticker=eq.${ticker}&order=date.desc&limit=1`);

    const from = firstRes[0]?.date || '???';
    const to = lastRes[0]?.date || '???';
    const count = countRes.length;
    const ok = count >= 1500;
    if (!ok) allGood = false;
    console.log(`      ${ok ? 'OK' : 'XX'} ${ticker.padEnd(6)} ${String(count).padStart(5)} rows  (${from} → ${to})`);
  }

  // 4c: Check chain cache
  console.log('\n    Chain Cache (SQLite):');
  try {
    const { initDB, closeDB, getCacheStats } = await import('../src/lib/backtest/chain-cache');
    initDB();
    const stats = getCacheStats();
    console.log(`      Total rows: ${stats.totalRows.toLocaleString()}`);
    console.log(`      Total ticker-dates: ${stats.totalDates.toLocaleString()}`);
    console.log(`      Tickers: ${stats.tickers.join(', ')}`);

    // Check each ticker has coverage
    const oratsTickers = tickers.map(t => oratsTickerFor(t));
    const missing = oratsTickers.filter(t => !stats.tickers.includes(t));
    if (missing.length > 0) {
      allGood = false;
      console.log(`      MISSING from cache: ${missing.join(', ')}`);
    } else {
      console.log(`      All tickers present in cache`);
    }
    closeDB();
  } catch (err: any) {
    allGood = false;
    console.log(`      ERROR: ${err.message}`);
  }

  console.log(`\n    Overall: ${allGood ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}\n`);
  return allGood;
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  Unified Data Prefetch');
  console.log('  ' + '='.repeat(55));
  console.log(`    Tickers: ${tickers.join(', ')}`);
  console.log(`    Range:   ${FROM_DATE} → ${TO_DATE}`);

  if (VERIFY_ONLY) {
    await phaseVerify();
    return;
  }

  const startTime = Date.now();

  if (!PHASE_ONLY || PHASE_ONLY === 'candles') await phaseCandles();
  if (!PHASE_ONLY || PHASE_ONLY === 'iv')      await phaseIV();
  if (!PHASE_ONLY || PHASE_ONLY === 'chains')   await phaseChains();

  // Always verify at end
  await phaseVerify();

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`  Total time: ${elapsed} minutes`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
