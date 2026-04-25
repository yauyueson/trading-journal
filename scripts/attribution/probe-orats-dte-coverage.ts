/**
 * One-shot ORATS diagnostic: does ORATS return DTE 30-59 data for the
 * "infrastructure-limited" tickers, or is it actually a market-data gap?
 *
 * Spends exactly 1 API call (ticker=ORCL, recent date, no filter).
 *
 * If the response contains DTE < 60 rows → cache state is stale (NULL/NULL
 * fetch_log entries blocking re-fetch), can be fixed with a fetch_log purge.
 *
 * If the response only has DTE 60+ → ORATS genuinely doesn't have short-DTE
 * data for ORCL pre-2024-or-whenever, and BCD expansion to these tickers
 * isn't feasible from ORATS data.
 *
 * Run: npx tsx scripts/attribution/probe-orats-dte-coverage.ts
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../../.env.local'), override: true });

const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';
if (!ORATS_TOKEN) { console.error('ERROR: ORATS_API_TOKEN not set'); process.exit(1); }

const TICKER = 'ORCL';
const TRADE_DATE = '2024-01-02';

const ORATS_FIELDS = [
  'ticker', 'tradeDate', 'expirDate', 'dte', 'strike', 'stockPrice',
  'callBidPrice', 'callValue', 'callAskPrice',
  'putBidPrice', 'putValue', 'putAskPrice',
  'callMidIv', 'putMidIv', 'callSmvVol', 'putSmvVol',
  'callVolume', 'putVolume', 'callOpenInterest', 'putOpenInterest',
  'delta', 'gamma', 'theta', 'vega',
].join(',');

async function main() {
  const params = new URLSearchParams({
    token: ORATS_TOKEN,
    ticker: TICKER,
    tradeDate: TRADE_DATE,
    fields: ORATS_FIELDS,
  });
  // DELIBERATELY no DTE filter, no delta filter — ask ORATS for everything.

  const url = `https://api.orats.io/datav2/hist/strikes?${params}`;
  console.log(`Probing: ticker=${TICKER}  tradeDate=${TRADE_DATE}  no filter`);
  console.log('');

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const json = await res.json() as { data?: Array<{ dte: number; expirDate: string; strike: number; delta: number }> };
  const rows = json.data ?? [];
  console.log(`Total rows returned: ${rows.length}`);
  if (rows.length === 0) { console.log('No data available for this (ticker, date).'); return; }

  // DTE distribution
  const dteBuckets = new Map<string, number>();
  const buckets: Array<[string, (d: number) => boolean]> = [
    ['DTE 1-29',   d => d >= 1 && d <= 29],
    ['DTE 30-59',  d => d >= 30 && d <= 59],
    ['DTE 60-90',  d => d >= 60 && d <= 90],
    ['DTE 91-180', d => d >= 91 && d <= 180],
    ['DTE 181-365',d => d >= 181 && d <= 365],
    ['DTE 366+',   d => d >= 366],
  ];
  for (const [name] of buckets) dteBuckets.set(name, 0);
  for (const r of rows) {
    for (const [name, fn] of buckets) {
      if (fn(r.dte)) { dteBuckets.set(name, (dteBuckets.get(name) ?? 0) + 1); break; }
    }
  }
  console.log('\nDTE distribution:');
  for (const [name, fn] of buckets) {
    void fn; // unused alias
    const n = dteBuckets.get(name) ?? 0;
    const pct = ((n / rows.length) * 100).toFixed(1);
    console.log(`  ${name.padEnd(13)}  ${n.toString().padStart(5)}  (${pct}%)`);
  }

  // Distinct expirations sorted
  const expirByDte = new Map<number, string>();
  for (const r of rows) {
    if (!expirByDte.has(r.dte)) expirByDte.set(r.dte, r.expirDate);
  }
  const distinctExpirs = [...expirByDte.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`\nDistinct expirations (DTE → date): ${distinctExpirs.length}`);
  for (const [dte, date] of distinctExpirs.slice(0, 25)) {
    console.log(`  DTE ${dte.toString().padStart(4)}  →  ${date}`);
  }
  if (distinctExpirs.length > 25) console.log(`  ... +${distinctExpirs.length - 25} more`);

  // Bottom-line verdict
  const shortDteCount = (dteBuckets.get('DTE 1-29') ?? 0) + (dteBuckets.get('DTE 30-59') ?? 0);
  console.log('\n─────────────────────────────────────────────────');
  if (shortDteCount > 0) {
    console.log(`✓ ORATS has DTE < 60 data for ${TICKER} on ${TRADE_DATE} (${shortDteCount} rows).`);
    console.log('  → Cache state is stale. Backfill is possible via fetch_log purge + re-prefetch.');
  } else {
    console.log(`✗ ORATS returns NO DTE < 60 data for ${TICKER} on ${TRADE_DATE}.`);
    console.log('  → BCD expansion to this ticker is data-limited (not infrastructure-limited).');
    console.log('  → Same likely applies to ANET / NOW / PANW / SHOP / CRWD / VRT / ARM (all show min DTE = 60 in cache).');
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
