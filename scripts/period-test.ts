/**
 * Quick test: do different indicator periods change the correlation structure?
 * If periods matter, we'd see lower inter-signal correlation with different settings.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

import type { BacktestCandle } from '../src/lib/backtest/types';
import { precomputeSignals } from '../src/lib/backtest/engine';
import type { TechScoreOptions } from '../src/lib/tech-analysis';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';

async function fetchCandles(ticker: string): Promise<BacktestCandle[]> {
  const params = new URLSearchParams({
    select: 'date,open,high,low,close,volume', ticker: `eq.${ticker}`,
    timeframe: 'eq.1D', order: 'date.asc', limit: '5000',
  });
  params.set('date', 'gte.2019-01-01');
  params.append('date', 'lte.2025-12-31');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/stock_candles?${params}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  const rows: any[] = await res.json();
  return rows.map(r => ({
    date: r.date, timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: Number(r.open), high: Number(r.high), low: Number(r.low),
    close: Number(r.close), volume: Number(r.volume),
  }));
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const mA = a.reduce((s,v) => s+v, 0) / n;
  const mB = b.reduce((s,v) => s+v, 0) / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB;
    num += da * db; dA += da * da; dB += db * db;
  }
  return Math.sqrt(dA * dB) > 0 ? num / Math.sqrt(dA * dB) : 0;
}

async function testPeriods(label: string, opts: TechScoreOptions) {
  const tickers = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'TSLA', 'AMD'];
  const scores: Record<string, number[]> = { sc_mb: [], sc_bxs: [], sc_bxl: [], sc_ema: [], sc_mom: [] };

  for (const ticker of tickers) {
    const candles = await fetchCandles(ticker);
    if (candles.length < 300) continue;
    const { signals } = precomputeSignals(candles, '1D', opts);
    for (const s of signals) {
      if (!s.subScores) continue;
      scores.sc_mb.push(s.subScores.sc_mb);
      scores.sc_bxs.push(s.subScores.sc_bxs);
      scores.sc_bxl.push(s.subScores.sc_bxl);
      scores.sc_ema.push(s.subScores.sc_ema);
      scores.sc_mom.push(s.subScores.sc_mom);
    }
  }

  const keys = ['sc_mb', 'sc_bxs', 'sc_bxl', 'sc_ema', 'sc_mom'];
  const labels = ['MB', 'BXS', 'BXL', 'EMA', 'MOM'];

  console.log(`\n  ${label} (${scores.sc_mb.length} bars):`);
  console.log('         ' + labels.map(l => l.padStart(7)).join(''));
  for (let i = 0; i < keys.length; i++) {
    const row = keys.map((_, j) => (i === j ? '  1.00' : pearson(scores[keys[i]], scores[keys[j]]).toFixed(2)).padStart(7)).join('');
    console.log(`  ${labels[i].padEnd(5)}  ${row}`);
  }

  // Average inter-signal correlation
  let sum = 0, count = 0;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      sum += Math.abs(pearson(scores[keys[i]], scores[keys[j]]));
      count++;
    }
  }
  console.log(`  → Avg inter-signal |r|: ${(sum / count).toFixed(3)}`);
}

async function main() {
  console.log('═'.repeat(60));
  console.log('  PERIOD SENSITIVITY: Does changing periods reduce correlation?');
  console.log('═'.repeat(60));

  // Default periods
  await testPeriods('A) Default periods (mb=20, bxs=5/20, bxl=20/15)', {});

  // Short periods (more responsive, like day-trading)
  await testPeriods('B) Short periods (mb=10, bxs=3/10, bxl=10/7)', {
    sc_mb_len: 10, sc_bx_s1: 3, sc_bx_s2: 10, sc_bx_l1: 10, sc_bx_l2: 7,
  });

  // Long periods (more smoothed, like swing trading)
  await testPeriods('C) Long periods (mb=40, bxs=10/40, bxl=40/30)', {
    sc_mb_len: 40, sc_bx_s1: 10, sc_bx_s2: 40, sc_bx_l1: 40, sc_bx_l2: 30,
  });

  // Mixed: make signals as different as possible
  await testPeriods('D) Mixed (mb=10, bxs=3/30, bxl=40/7)', {
    sc_mb_len: 10, sc_bx_s1: 3, sc_bx_s2: 30, sc_bx_l1: 40, sc_bx_l2: 7,
  });

  console.log('\n' + '═'.repeat(60));
  console.log('  CONCLUSION');
  console.log('═'.repeat(60));
  console.log('  If avg |r| stays above 0.60 regardless of periods,');
  console.log('  the signals are structurally correlated (all measure trend).');
  console.log('  Periods cannot fix this — need fundamentally different signals.');
}

main().catch(console.error);
