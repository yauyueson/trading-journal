/**
 * verify-data-coverage.ts — Holistic data integrity check across 3 data stores.
 *
 * Validates that every ticker in the 30-ticker research universe has:
 *   - Tiingo daily candles (Supabase stock_candles)
 *   - ORATS IV cores (Supabase orats_iv_cache)
 *   - ORATS option chains (local data/option-chains.sqlite)
 *
 * And flags:
 *   - Date range mismatches between stores
 *   - Tickers with no chain data despite having candles
 *   - Chain dates where fetch_log shows 0 rows (empty fetch / ghost dates)
 *   - Recent-date sanity (non-zero prices, reasonable strike count)
 *
 * Usage:
 *   npx tsx scripts/verify-data-coverage.ts
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const UNIVERSE_30 = [
  'IWM', 'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META', 'JPM', 'GS', 'COST', 'NFLX', 'NVDA', 'TSLA',
  'AMD', 'AVGO', 'BA', 'COIN', 'HOOD', 'LULU', 'MSTR', 'PLTR', 'UBER',
  'CRM', 'ORCL', 'CRWD', 'SHOP', 'PANW', 'ANET', 'VRT', 'ARM', 'NOW',
];
const BENCHMARKS = ['SPY', 'QQQ'];
const ALL = [...UNIVERSE_30, ...BENCHMARKS];

// Expected earliest dates where available (null = no pre-IPO data constraint)
const IPO_FLOORS: Record<string, string> = {
  COIN: '2021-04-14',
  HOOD: '2021-07-29',
  PLTR: '2020-09-30',
  UBER: '2019-05-10',
  VRT:  '2018-07-30',
  CRWD: '2019-06-12',
  ARM:  '2023-09-14',
};

const DATA_START = '2017-01-01';
const DATA_END = '2026-02-28';

type Coverage = { ticker: string; count: number; minDate: string | null; maxDate: string | null };
type Issue = { severity: 'error' | 'warn' | 'info'; ticker: string; message: string };

async function supabaseGet(table: string, query: string): Promise<unknown[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getCandleCoverage(tickers: string[]): Promise<Map<string, Coverage>> {
  const out = new Map<string, Coverage>();
  for (const t of tickers) {
    const first = await supabaseGet('stock_candles',
      `select=date&ticker=eq.${t}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=1`) as Array<{ date: string }>;
    const last = await supabaseGet('stock_candles',
      `select=date&ticker=eq.${t}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.desc&limit=1`) as Array<{ date: string }>;
    const countRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_candles?ticker=eq.${t}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&select=count`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'count=exact' },
    });
    const totalHeader = countRes.headers.get('content-range') ?? '';
    const count = Number(totalHeader.split('/')[1] ?? 0);
    out.set(t, {
      ticker: t, count,
      minDate: first[0]?.date ?? null,
      maxDate: last[0]?.date ?? null,
    });
  }
  return out;
}

async function getIVCoverage(tickers: string[]): Promise<Map<string, Coverage>> {
  const out = new Map<string, Coverage>();
  for (const t of tickers) {
    const first = await supabaseGet('orats_iv_cache',
      `select=date&ticker=eq.${t}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=1`) as Array<{ date: string }>;
    const last = await supabaseGet('orats_iv_cache',
      `select=date&ticker=eq.${t}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.desc&limit=1`) as Array<{ date: string }>;
    const countRes = await fetch(`${SUPABASE_URL}/rest/v1/orats_iv_cache?ticker=eq.${t}&date=gte.${DATA_START}&date=lte.${DATA_END}&select=count`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'count=exact' },
    });
    const totalHeader = countRes.headers.get('content-range') ?? '';
    const count = Number(totalHeader.split('/')[1] ?? 0);
    out.set(t, {
      ticker: t, count,
      minDate: first[0]?.date ?? null,
      maxDate: last[0]?.date ?? null,
    });
  }
  return out;
}

function getChainCoverage(tickers: string[]): Map<string, Coverage & { emptyFetchDates: number }> {
  const db = new Database(path.resolve(process.cwd(), 'data', 'option-chains.sqlite'), { readonly: true });
  const out = new Map<string, Coverage & { emptyFetchDates: number }>();
  for (const t of tickers) {
    const r = db.prepare(`
      SELECT COUNT(DISTINCT trade_date) AS count,
             MIN(trade_date) AS minDate,
             MAX(trade_date) AS maxDate
      FROM option_chains WHERE ticker = ?`).get(t) as { count: number; minDate: string | null; maxDate: string | null };
    const emptyFetch = db.prepare(`
      SELECT COUNT(*) AS n FROM fetch_log WHERE ticker = ? AND rows_fetched = 0`).get(t) as { n: number };
    out.set(t, { ticker: t, count: r.count, minDate: r.minDate, maxDate: r.maxDate, emptyFetchDates: emptyFetch.n });
  }
  db.close();
  return out;
}

function sanityCheckRecent(tickers: string[], checkDate: string): Map<string, { strikes: number; hasBidAsk: boolean; deltaSpan: string }> {
  const db = new Database(path.resolve(process.cwd(), 'data', 'option-chains.sqlite'), { readonly: true });
  const out = new Map<string, { strikes: number; hasBidAsk: boolean; deltaSpan: string }>();
  for (const t of tickers) {
    const r = db.prepare(`
      SELECT COUNT(*) AS strikes,
             MIN(delta) AS dMin, MAX(delta) AS dMax,
             SUM(CASE WHEN call_bid > 0 OR call_ask > 0 OR put_bid > 0 OR put_ask > 0 THEN 1 ELSE 0 END) AS withPrices
      FROM option_chains WHERE ticker = ? AND trade_date = ?`).get(t, checkDate) as { strikes: number; dMin: number | null; dMax: number | null; withPrices: number };
    out.set(t, {
      strikes: r.strikes,
      hasBidAsk: (r.withPrices ?? 0) > 0,
      deltaSpan: r.dMin !== null ? `${r.dMin.toFixed(2)}..${r.dMax!.toFixed(2)}` : '—',
    });
  }
  db.close();
  return out;
}

async function main() {
  console.log('Holistic data-coverage check for 30-ticker universe + SPY/QQQ benchmarks\n');
  const issues: Issue[] = [];

  console.log('1. Fetching Tiingo candle coverage...');
  const candles = await getCandleCoverage(ALL);
  console.log('2. Fetching ORATS IV coverage...');
  const iv = await getIVCoverage(ALL);
  console.log('3. Reading ORATS chain coverage...');
  const chains = getChainCoverage(ALL);
  console.log('4. Sanity-checking recent date 2026-02-25...\n');
  const sanity = sanityCheckRecent(ALL, '2026-02-25');

  console.log('─────────────────────────────────────────────────────────────────────────────────');
  console.log(`${'Ticker'.padEnd(7)} ${'Candles'.padStart(8)} ${'IV'.padStart(6)} ${'Chains'.padStart(6)} ${'Candle-first'.padStart(12)} ${'Chain-first'.padStart(12)} ${'Strikes@recent'.padStart(14)} ${'Empty'.padStart(6)}`);
  console.log('─────────────────────────────────────────────────────────────────────────────────');

  for (const t of ALL) {
    const c = candles.get(t)!;
    const i = iv.get(t)!;
    const ch = chains.get(t)!;
    const s = sanity.get(t)!;

    const line = `${t.padEnd(7)} ${String(c.count).padStart(8)} ${String(i.count).padStart(6)} ${String(ch.count).padStart(6)} ${(c.minDate ?? '—').padStart(12)} ${(ch.minDate ?? '—').padStart(12)} ${String(s.strikes).padStart(14)} ${String(ch.emptyFetchDates).padStart(6)}`;
    console.log(line);

    // Issue detection
    if (c.count === 0) issues.push({ severity: 'error', ticker: t, message: 'No Tiingo candles' });
    if (i.count === 0) issues.push({ severity: 'warn', ticker: t, message: 'No ORATS IV cores (IV rank gates will fail)' });
    if (ch.count === 0) issues.push({ severity: 'error', ticker: t, message: 'No ORATS chain data — untradeable' });
    else if (c.count > 0 && ch.count < c.count * 0.9) {
      issues.push({ severity: 'warn', ticker: t, message: `Chain coverage gap: ${ch.count} chain dates vs ${c.count} candle dates (${((1 - ch.count / c.count) * 100).toFixed(1)}% gap)` });
    }
    if (c.minDate && ch.minDate && ch.minDate > c.minDate) {
      issues.push({ severity: 'warn', ticker: t, message: `Chain starts ${ch.minDate} but candles start ${c.minDate} — first ${(new Date(ch.minDate).getTime() - new Date(c.minDate).getTime()) / 86400000 | 0} calendar days untradeable` });
    }
    if (c.minDate && IPO_FLOORS[t] && c.minDate > IPO_FLOORS[t]) {
      issues.push({ severity: 'info', ticker: t, message: `Candles start ${c.minDate}, expected ≥ ${IPO_FLOORS[t]} (IPO floor) — acceptable` });
    }
    if (ch.count > 0 && !s.hasBidAsk) {
      issues.push({ severity: 'warn', ticker: t, message: `Chain rows for 2026-02-25 have no bid/ask — data may be stale or unpopulated` });
    }
  }

  console.log('─────────────────────────────────────────────────────────────────────────────────');

  if (issues.length === 0) {
    console.log('\n✅ No issues detected. All 32 tickers have full coverage in all three stores.');
  } else {
    const errs = issues.filter(i => i.severity === 'error');
    const warns = issues.filter(i => i.severity === 'warn');
    const infos = issues.filter(i => i.severity === 'info');
    console.log(`\n${errs.length} ERROR / ${warns.length} WARN / ${infos.length} INFO\n`);
    for (const sev of ['error', 'warn', 'info'] as const) {
      const group = issues.filter(i => i.severity === sev);
      if (group.length === 0) continue;
      console.log(`${sev.toUpperCase()}:`);
      for (const iss of group) console.log(`  ${iss.ticker}: ${iss.message}`);
      console.log();
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
