/**
 * IV-Rank Entry Test: Does entering on high IV rank produce edge?
 *
 * Tests: "Sell premium when IV elevated + trend aligned" vs
 *        "Direction-only entry" vs "Buy and hold"
 *
 * Uses orats_iv_cache + stock_candles from Supabase.
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

import type { BacktestCandle, BacktestConfig } from '../src/lib/backtest/types';
import { DEFAULT_CONFIG } from '../src/lib/backtest/types';
import { precomputeSignals, runBacktestFull } from '../src/lib/backtest/engine';
import { computeAnalytics } from '../src/lib/backtest/analytics';
import { computeFitness } from '../src/lib/backtest/sweep';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

async function fetchCandles(ticker: string, from: string, to: string): Promise<BacktestCandle[]> {
  const params = `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${from}&date=lte.${to}&order=date.asc&limit=5000`;
  const rows = await supabaseGet('stock_candles', params);
  return rows.map(r => ({
    date: r.date, timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: Number(r.open), high: Number(r.high), low: Number(r.low),
    close: Number(r.close), volume: Number(r.volume),
  }));
}

interface IVRow { date: string; iv30d: number | null; hv30d: number | null }

async function fetchIV(ticker: string, from: string, to: string): Promise<IVRow[]> {
  const params = `select=date,iv30d,hv30d&ticker=eq.${ticker}&date=gte.${from}&date=lte.${to}&order=date.asc&limit=5000`;
  return supabaseGet('orats_iv_cache', params);
}

// Compute rolling IV rank: (current - min252) / (max252 - min252)
function computeIVRank(ivSeries: (number | null)[]): (number | null)[] {
  const WINDOW = 252;
  const result: (number | null)[] = [];
  for (let i = 0; i < ivSeries.length; i++) {
    if (i < WINDOW || ivSeries[i] == null) {
      result.push(null);
      continue;
    }
    const window = ivSeries.slice(i - WINDOW, i + 1).filter(v => v != null) as number[];
    if (window.length < 100) { result.push(null); continue; }
    const min = Math.min(...window);
    const max = Math.max(...window);
    const range = max - min;
    result.push(range > 0 ? ((ivSeries[i]! - min) / range) * 100 : 50);
  }
  return result;
}

// Simple EMA
function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// EMA stack: bullish (8>21>34), bearish (8<21<34), neutral
function emaStackDirection(closes: number[], idx: number, ema8: number[], ema21: number[], ema34: number[]): 'CALL' | 'PUT' | 'NEUTRAL' {
  if (idx < 34) return 'NEUTRAL';
  if (ema8[idx] > ema21[idx] && ema21[idx] > ema34[idx]) return 'CALL';
  if (ema8[idx] < ema21[idx] && ema21[idx] < ema34[idx]) return 'PUT';
  return 'NEUTRAL';
}

const OOS_START = '2024-04-01';
const OOS_END = '2025-12-31';
const tickers = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'TSLA', 'AMD',
  'COST', 'BA', 'NFLX', 'JPM', 'AVGO'];

interface StrategyResult {
  name: string;
  trades: number;
  winRate: number;
  sharpe: number;
  pf: number;
  avgReturn: number;
  maxDD: number;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  IV RANK ENTRY TEST: Does volatility-based entry add edge? ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  OOS: ${OOS_START} → ${OOS_END}`);
  console.log(`  Tickers: ${tickers.join(', ')}\n`);

  // First check how much IV data we have
  let ivDataCount = 0;
  let tickersWithIV = 0;

  // Strategy buckets: collect trades across all tickers
  const strategies: Record<string, any[]> = {
    'A) Direction only (score≥75, no IV filter)': [],
    'B) IV Rank > 30 + direction (score≥75)': [],
    'C) IV Rank > 50 + direction (score≥75)': [],
    'D) IV Rank > 70 + direction (score≥75)': [],
    'E) IV/RV ratio > 1.0 + direction (score≥75)': [],
    'F) IV Rank > 50 + IV/RV > 1.0 + direction': [],
  };

  for (const ticker of tickers) {
    console.log(`  Processing ${ticker}...`);

    // Fetch data
    const candles = await fetchCandles(ticker, '2019-01-01', OOS_END);
    if (candles.length < 300) { console.log(`    Skipping (${candles.length} candles)`); continue; }

    const ivData = await fetchIV(ticker, '2019-01-01', OOS_END);
    if (ivData.length < 252) {
      console.log(`    No IV data (${ivData.length} rows), using direction-only`);
    } else {
      tickersWithIV++;
      ivDataCount += ivData.length;
    }

    // Build date→IV lookup
    const ivByDate = new Map<string, { iv30d: number | null; hv30d: number | null }>();
    for (const row of ivData) {
      ivByDate.set(row.date, { iv30d: row.iv30d, hv30d: row.hv30d });
    }

    // Compute IV rank series (aligned to candle dates)
    const ivSeries = candles.map(c => ivByDate.get(c.date)?.iv30d ?? null);
    const hvSeries = candles.map(c => ivByDate.get(c.date)?.hv30d ?? null);
    const ivRanks = computeIVRank(ivSeries);

    // Compute EMA stack for direction
    const closes = candles.map(c => c.close);
    const ema8 = ema(closes, 8);
    const ema21 = ema(closes, 21);
    const ema34 = ema(closes, 34);

    // Precompute signals (using default weights — we only use score≥75 as quality filter)
    const { signals, simCandles } = precomputeSignals(candles, '1D', {});

    // Build date→signal map for OOS period
    const dateToSignal = new Map(signals.map(s => [s.date, s]));
    const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

    // For each strategy, filter signals and run backtest
    for (const [stratName, tradeList] of Object.entries(strategies)) {
      // Clone signals but filter by strategy criteria
      const filteredSignals = signals.map((s, si) => {
        const idx = dateToIdx.get(s.date);
        if (idx == null || s.date < OOS_START || s.date > OOS_END) return s;
        if (s.type === 'NEUTRAL' || s.score < 75) return s;

        const ivRank = ivRanks[idx];
        const iv = ivSeries[idx];
        const hv = hvSeries[idx];
        const ivRvRatio = (iv != null && hv != null && hv > 0) ? iv / hv : null;

        let passFilter = true;
        if (stratName.includes('IV Rank > 30') && (ivRank == null || ivRank < 30)) passFilter = false;
        if (stratName.includes('IV Rank > 50') && (ivRank == null || ivRank < 50)) passFilter = false;
        if (stratName.includes('IV Rank > 70') && (ivRank == null || ivRank < 70)) passFilter = false;
        if (stratName.includes('IV/RV ratio > 1.0') && (ivRvRatio == null || ivRvRatio < 1.0)) passFilter = false;
        if (stratName.includes('IV/RV > 1.0') && (ivRvRatio == null || ivRvRatio < 1.0)) passFilter = false;

        if (!passFilter) {
          // Block this signal by setting score to 0
          return { ...s, score: 0 };
        }
        return s;
      });

      const cfg: BacktestConfig = {
        ...DEFAULT_CONFIG,
        ticker,
        startDate: OOS_START,
        endDate: OOS_END,
        minScore: 75,
        slAtr: 2.0,
        scoreStopThreshold: 0,
      };

      const result = runBacktestFull(filteredSignals, simCandles, cfg);
      tradeList.push(...result.trades);
    }

    if (ivData.length >= 252) {
      const lastIdx = candles.length - 1;
      const lastIVRank = ivRanks[lastIdx];
      const lastIV = ivSeries[lastIdx];
      const lastHV = hvSeries[lastIdx];
      console.log(`    ${candles.length} candles, ${ivData.length} IV rows, last IV rank: ${lastIVRank?.toFixed(0) ?? 'N/A'}, IV30: ${lastIV?.toFixed(3) ?? 'N/A'}, HV30: ${lastHV?.toFixed(3) ?? 'N/A'}`);
    }
  }

  console.log(`\n  Tickers with IV data: ${tickersWithIV}/${tickers.length} (${ivDataCount} total IV rows)`);

  // Compute and display results
  console.log('\n' + '═'.repeat(100));
  console.log('  RESULTS: Does IV-based filtering improve signal quality?');
  console.log('═'.repeat(100));
  console.log('  ┌─────────────────────────────────────────────┬────────┬────────┬────────┬────────┬────────┬────────┐');
  console.log('  │ Strategy                                    │ Trades │  WR %  │ Sharpe │   PF   │ AvgRet │ MaxDD  │');
  console.log('  ├─────────────────────────────────────────────┼────────┼────────┼────────┼────────┼────────┼────────┤');

  const results: StrategyResult[] = [];
  for (const [name, trades] of Object.entries(strategies)) {
    const cfg: BacktestConfig = { ...DEFAULT_CONFIG, minScore: 75, slAtr: 2.0, scoreStopThreshold: 0 };
    const analytics = computeAnalytics(trades, cfg, trades.length);

    const r: StrategyResult = {
      name,
      trades: analytics.totalTrades,
      winRate: analytics.winRateTheta,
      sharpe: analytics.sharpe,
      pf: analytics.profitFactor,
      avgReturn: analytics.avgReturn,
      maxDD: analytics.maxDrawdown,
    };
    results.push(r);

    console.log(
      `  │ ${name.padEnd(43)} │ ${String(r.trades).padStart(6)} │ ${r.winRate.toFixed(1).padStart(5)}% │ ` +
      `${r.sharpe.toFixed(2).padStart(6)} │ ${r.pf.toFixed(2).padStart(6)} │ ${r.avgReturn.toFixed(2).padStart(5)}% │ ` +
      `${r.maxDD.toFixed(1).padStart(5)}% │`
    );
  }
  console.log('  └─────────────────────────────────────────────┴────────┴────────┴────────┴────────┴────────┴────────┘');

  // Comparison
  const baseline = results[0];
  console.log('\n  Comparison vs direction-only baseline:');
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    const sharpeDiff = r.sharpe - baseline.sharpe;
    const arrow = sharpeDiff > 0 ? '↑' : sharpeDiff < 0 ? '↓' : '→';
    console.log(
      `    ${arrow} ${r.name.padEnd(45)} Sharpe ${sharpeDiff > 0 ? '+' : ''}${sharpeDiff.toFixed(2)}, ` +
      `Trades ${r.trades} (${Math.round(r.trades / baseline.trades * 100)}%)`
    );
  }

  console.log('\n  Buy-and-hold (EW 14 tickers) benchmark: Sharpe ~1.25');
  console.log('  If IV-filtered strategies beat direction-only AND approach buy-and-hold,');
  console.log('  then IV rank adds genuine edge over pure direction prediction.\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
