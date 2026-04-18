#!/usr/bin/env node
// scripts/backfill-iv-new-tickers.js
// One-shot ORATS historical IV cores backfill for newly-added tickers.
// Reuses the same logic as api/cron-iv.js runBackfill but invokable from CLI.
//
// Usage:
//   node scripts/backfill-iv-new-tickers.js CRM ORCL CRWD SHOP PANW ANET VRT ARM NOW
//   node scripts/backfill-iv-new-tickers.js  # defaults to the 9 expansion tickers

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { getHistoricalCores } from '../lib/orats-client.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const DELAY_MS = 300;
const BATCH_SIZE = 500;
const YEARS_BACK = 10;

const DEFAULT_NEW_TICKERS = ['CRM', 'ORCL', 'CRWD', 'SHOP', 'PANW', 'ANET', 'VRT', 'ARM', 'NOW'];

async function upsertBatch(rows) {
  if (!SUPABASE_URL || !SUPABASE_KEY || rows.length === 0) return 0;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/orats_iv_cache`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows.slice(i, i + BATCH_SIZE)),
    });
    if (res.ok) upserted += Math.min(BATCH_SIZE, rows.length - i);
    else console.warn(`  Upsert batch failed: ${res.status} ${await res.text()}`);
  }
  return upserted;
}

async function backfillTicker(ticker, cutoff) {
  try {
    const cores = await getHistoricalCores(ticker);
    if (!cores || cores.length === 0) return { ticker, status: 'no-data', rows: 0 };
    const rows = cores
      .filter(c => { const d = c.tradeDate || c.date; return d && d >= cutoff; })
      .map(c => ({
        ticker: ticker.toUpperCase(),
        date: c.tradeDate || c.date,
        iv30d: c.iv30d != null ? Number(c.iv30d) : null,
        iv60d: c.iv60d != null ? Number(c.iv60d) : null,
        hv20d: c.clsHv20d != null ? Number(c.clsHv20d) : null,
        hv30d: c.clsHv30d != null ? Number(c.clsHv30d) : null,
        hv60d: c.clsHv60d != null ? Number(c.clsHv60d) : null,
      }));
    const upserted = await upsertBatch(rows);
    return { ticker, status: 'ok', rows: upserted };
  } catch (err) {
    return { ticker, status: 'error', error: err.message };
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ERROR: Supabase credentials not set');
    process.exit(1);
  }
  if (!process.env.ORATS_API_TOKEN) {
    console.error('ERROR: ORATS_API_TOKEN not set');
    process.exit(1);
  }

  const tickers = process.argv.slice(2).length > 0 ? process.argv.slice(2).map(t => t.toUpperCase()) : DEFAULT_NEW_TICKERS;
  const cutoffDate = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - YEARS_BACK);
  const cutoff = cutoffDate.toISOString().split('T')[0];

  console.log(`ORATS IV backfill — ${tickers.length} tickers, cutoff ${cutoff}`);
  console.log(`Tickers: ${tickers.join(', ')}\n`);

  let totalRows = 0;
  for (let i = 0; i < tickers.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, DELAY_MS));
    const result = await backfillTicker(tickers[i], cutoff);
    if (result.status === 'ok') {
      totalRows += result.rows;
      console.log(`  ${result.ticker}: ${result.rows} rows cached`);
    } else {
      console.log(`  ${result.ticker}: ${result.status}${result.error ? ` (${result.error})` : ''}`);
    }
  }
  console.log(`\nTotal rows upserted: ${totalRows}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
