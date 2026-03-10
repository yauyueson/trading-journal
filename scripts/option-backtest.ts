/**
 * Option Backtest Runner — Real P&L Simulation
 *
 * Pipeline:
 *   1. Signal Pass: identify entry signals from stock_candles (free, Supabase)
 *   2. IV Enrichment: fetch IV rank from orats_iv_cache (free, Supabase)
 *   3. Chain Download: fetch historical option chains from ORATS (API, cached in SQLite)
 *   4. Simulate: LEAP + Credit Spread modes with real prices
 *   5. Output: comparison table + JSON report
 *
 * Usage:
 *   npx tsx scripts/option-backtest.ts
 *   npx tsx scripts/option-backtest.ts --dry-run    # show plan without API calls
 *   npx tsx scripts/option-backtest.ts --ticker SPY  # single ticker test
 *   npx tsx scripts/option-backtest.ts --iv-debug   # IV rank diagnostic: why IV>50 underperforms
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
import { DEFAULT_CONFIG } from '../src/lib/backtest/types';
import { precomputeSignals } from '../src/lib/backtest/engine';
import {
  initDB, closeDB, getApiCallCount, resetApiCallCount,
  prefetchAll, getCacheStats,
} from '../src/lib/backtest/chain-cache';
import {
  simulateLeap, simulateCreditSpread,
  computeOptionAnalytics,
  DEFAULT_LEAP_CONFIG, DEFAULT_CREDIT_CONFIG,
  type EntrySignal, type OptionTrade, type OptionSimAnalytics,
} from '../src/lib/backtest/option-sim';

// ── Config ───────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';

const OOS_START = '2024-04-01';
const OOS_END = '2025-12-31';
const DATA_START = '2019-01-01'; // need history for signal warmup

const ALL_TICKERS = ['SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT'];
const CHAIN_START = '2019-01-01'; // option chain cache start (for train/val split)

// ── CLI Args ─────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SWEEP_MODE = args.includes('--sweep');
const PREFETCH_MODE = args.includes('--prefetch');
const IV_DEBUG_MODE = args.includes('--iv-debug');
const SINGLE_TICKER = args.find((a, i) => args[i - 1] === '--ticker') || null;
const tickers = SINGLE_TICKER ? [SINGLE_TICKER.toUpperCase()] : ALL_TICKERS;

// ── Supabase Fetch ───────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

async function fetchCandles(ticker: string): Promise<BacktestCandle[]> {
  const params = `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${OOS_END}&order=date.asc&limit=5000`;
  const rows = await supabaseGet('stock_candles', params);
  return rows.map(r => ({
    date: r.date,
    timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: Number(r.open), high: Number(r.high), low: Number(r.low),
    close: Number(r.close), volume: Number(r.volume),
  }));
}

async function fetchIVData(ticker: string): Promise<{ date: string; iv30d: number | null }[]> {
  const params = `select=date,iv30d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${OOS_END}&order=date.asc&limit=5000`;
  return supabaseGet('orats_iv_cache', params);
}

// ── IV Rank Computation ──────────────────────────────────

function computeIVRank(ivSeries: (number | null)[]): (number | null)[] {
  const WINDOW = 252;
  const result: (number | null)[] = [];
  for (let i = 0; i < ivSeries.length; i++) {
    if (i < WINDOW || ivSeries[i] == null) { result.push(null); continue; }
    const window = ivSeries.slice(i - WINDOW, i + 1).filter(v => v != null) as number[];
    if (window.length < 100) { result.push(null); continue; }
    const min = Math.min(...window);
    const max = Math.max(...window);
    const range = max - min;
    result.push(range > 0 ? ((ivSeries[i]! - min) / range) * 100 : 50);
  }
  return result;
}

// ── Signal Generation ────────────────────────────────────

interface TickerSignals {
  ticker: string;
  entries: EntrySignal[];
  allTradingDates: string[];
}

async function generateSignals(ticker: string): Promise<TickerSignals> {
  const candles = await fetchCandles(ticker);
  const ivData = await fetchIVData(ticker);

  // Build IV rank series aligned to candle dates
  const ivByDate = new Map(ivData.map(r => [r.date, r.iv30d]));
  const ivSeries = candles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRank(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  // Run signal engine
  const { signals, simCandles } = precomputeSignals(candles, '1D', {});

  // Filter to OOS period, high-quality signals only
  const entries: EntrySignal[] = [];
  for (const sig of signals) {
    if (sig.date < OOS_START || sig.date > OOS_END) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 75) continue;

    const idx = dateToIdx.get(sig.date);
    const ivRank = idx != null ? ivRanks[idx] : undefined;

    entries.push({
      ticker,
      date: sig.date,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: ivRank ?? undefined,
    });
  }

  // All trading dates in OOS period (for monitoring schedule)
  const allTradingDates = candles
    .filter(c => c.date >= OOS_START && c.date <= OOS_END)
    .map(c => c.date);

  return { ticker, entries, allTradingDates };
}

// ── Prefetch Mode ────────────────────────────────────────

async function runPrefetch() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   OPTION CHAIN PREFETCH — Download & Cache All Data            ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`  Period: ${CHAIN_START} → ${OOS_END}`);
  console.log(`  Tickers: ${tickers.join(', ')} (${tickers.length} total)\n`);

  if (!ORATS_TOKEN) {
    console.error('  ERROR: ORATS_API_TOKEN not set'); process.exit(1);
  }

  initDB();

  // Show current cache state
  const stats = getCacheStats();
  console.log(`  Cache: ${stats.totalRows.toLocaleString()} rows, ${stats.totalDates.toLocaleString()} ticker-dates cached`);
  console.log(`  Cached tickers: ${stats.tickers.join(', ') || 'none'}\n`);

  // Get all trading dates from Supabase (SPY has the full range)
  console.log('  Fetching trading dates from Supabase...');
  const params = `select=date&ticker=eq.SPY&timeframe=eq.1D&date=gte.${CHAIN_START}&date=lte.${OOS_END}&order=date.asc&limit=5000`;
  const dateRows = await supabaseGet('stock_candles', params);
  const allDates = dateRows.map((r: any) => r.date);
  console.log(`  ${allDates.length} trading days (${CHAIN_START} → ${OOS_END})`);

  const trainDates = allDates.filter(d => d < OOS_START).length;
  const valDates = allDates.filter(d => d >= OOS_START).length;
  console.log(`  Training: ${trainDates} days (${CHAIN_START} → ${OOS_START})`);
  console.log(`  Validation: ${valDates} days (${OOS_START} → ${OOS_END})`);
  console.log(`  Split: ${Math.round(trainDates / allDates.length * 100)}/${Math.round(valDates / allDates.length * 100)}\n`);

  // ORATS batches max 5 tickers per API call
  // Split tickers into batches of 5
  const tickerBatches: string[][] = [];
  for (let i = 0; i < tickers.length; i += 5) {
    tickerBatches.push(tickers.slice(i, i + 5));
  }
  const estimatedCalls = allDates.length * tickerBatches.length;
  console.log(`  Ticker batches: ${tickerBatches.map(b => b.join(',')).join(' | ')}`);
  console.log(`  Max API calls: ${estimatedCalls} (${allDates.length} dates × ${tickerBatches.length} batches)`);
  console.log(`  Already-cached dates will be skipped (0 cost)\n`);

  // Prefetch each batch of tickers
  const startTime = Date.now();
  resetApiCallCount();
  let totalDone = 0;
  const totalWork = allDates.length * tickerBatches.length;

  for (let batchIdx = 0; batchIdx < tickerBatches.length; batchIdx++) {
    const batch = tickerBatches[batchIdx];
    console.log(`  Batch ${batchIdx + 1}/${tickerBatches.length}: ${batch.join(', ')}`);

    await prefetchAll(
      ORATS_TOKEN,
      batch,
      allDates,
      [0.01, 0.99],
      (done, total, calls) => {
        const overallDone = totalDone + done;
        const pct = Math.round(overallDone / totalWork * 100);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const totalCalls = getApiCallCount();
        const rate = totalCalls > 0 ? (totalCalls / (Date.now() - startTime) * 60000).toFixed(0) : '0';
        process.stdout.write(`\r  Progress: ${overallDone}/${totalWork} (${pct}%) | ${totalCalls} API calls | ${elapsed}s | ${rate} RPM   `);
      },
      5,
    );
    totalDone += allDates.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalCalls = getApiCallCount();
  console.log(`\n\n  Done! ${totalCalls} API calls in ${elapsed}s`);
  console.log(`  Budget used: ${(totalCalls / 20000 * 100).toFixed(1)}% of 20,000 monthly limit`);

  const finalStats = getCacheStats();
  console.log(`  Cache now: ${finalStats.totalRows.toLocaleString()} rows, ${finalStats.totalDates.toLocaleString()} ticker-dates`);
  console.log(`  Tickers: ${finalStats.tickers.join(', ')}`);

  const dbPath = path.resolve(process.cwd(), 'data', 'option-chains.sqlite');
  if (fs.existsSync(dbPath)) {
    const sizeMB = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1);
    console.log(`  Database size: ${sizeMB} MB`);
  }

  closeDB();
}

// ── Sweep Mode ───────────────────────────────────────────

async function runSweep() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   OPTION BACKTEST — Parameter Sensitivity Sweep                ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`  OOS: ${OOS_START} → ${OOS_END}`);
  console.log(`  Tickers: ${tickers.join(', ')}\n`);

  initDB();
  resetApiCallCount();

  // Generate signals once (shared across all configs)
  console.log('  Generating signals...');
  const allSignals: TickerSignals[] = [];
  for (const ticker of tickers) {
    allSignals.push(await generateSignals(ticker));
  }
  const totalEntries = allSignals.reduce((s, ts) => s + ts.entries.length, 0);
  console.log(`    ${totalEntries} total signals across ${tickers.length} tickers\n`);

  // ═══════════════════════════════════════════════════════
  //  LEAP SWEEP: TP × SL combinations
  // ═══════════════════════════════════════════════════════
  const leapTPs = [0.30, 0.50, 0.75, 1.00];
  const leapSLs = [0.20, 0.30, 0.50, 1.00]; // 1.00 = effectively no SL (100% loss)

  console.log('  ══════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  LEAP SENSITIVITY: TP% × SL% (deep ITM, 6-12mo expiry)');
  console.log('  ══════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  ┌──────┬──────┬────────┬────────┬────────┬────────┬────────┬────────────┬────────┬──────────┐');
  console.log('  │ TP%  │ SL%  │ Trades │  WR %  │ Sharpe │   PF   │ Avg%   │  Total P&L │ ROC %  │ AvgCap$  │');
  console.log('  ├──────┼──────┼────────┼────────┼────────┼────────┼────────┼────────────┼────────┼──────────┤');

  for (const tp of leapTPs) {
    for (const sl of leapSLs) {
      const config = {
        ...DEFAULT_LEAP_CONFIG,
        leapProfitTarget: tp,
        leapStopLoss: sl,
      };

      const trades: OptionTrade[] = [];
      for (const ts of allSignals) {
        let exitDate: string | null = null;
        for (const signal of ts.entries) {
          if (exitDate && signal.date < exitDate) continue;
          exitDate = null;
          const trade = await simulateLeap(ORATS_TOKEN, signal, config, ts.allTradingDates, OOS_END);
          if (trade) { trades.push(trade); exitDate = trade.exitDate; }
        }
      }

      const a = computeOptionAnalytics(trades);
      const pnlStr = a.totalPnl >= 0 ? `$${(a.totalPnl/1000).toFixed(1)}k` : `-$${(Math.abs(a.totalPnl)/1000).toFixed(1)}k`;
      const capStr = `$${(a.avgCapitalPerTrade/1000).toFixed(1)}k`;
      console.log(
        `  │ ${(tp*100).toFixed(0).padStart(3)}% │ ${(sl*100).toFixed(0).padStart(3)}% │ ` +
        `${String(a.totalTrades).padStart(6)} │ ${a.winRate.toFixed(1).padStart(5)}% │ ` +
        `${a.sharpe.toFixed(2).padStart(6)} │ ${a.profitFactor.toFixed(2).padStart(6)} │ ` +
        `${a.avgPnlPct.toFixed(1).padStart(5)}% │ ${pnlStr.padStart(10)} │ ${a.returnOnCapital.toFixed(1).padStart(5)}% │ ${capStr.padStart(8)} │`
      );
    }
  }
  console.log('  └──────┴──────┴────────┴────────┴────────┴────────┴────────┴────────────┴────────┴──────────┘');

  // ═══════════════════════════════════════════════════════
  //  CREDIT SPREAD SWEEP: IV Rank × TP% × SL multiple
  // ═══════════════════════════════════════════════════════
  const ivRanks = [0, 30, 50, 70];
  const creditTPs = [0.30, 0.50, 0.75];
  const creditSLs = [1.5, 2.0, 3.0, 100]; // 100 = effectively no SL

  console.log('\n  ══════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  CREDIT SPREAD SENSITIVITY: IV Rank × TP% × SL multiple');
  console.log('  ══════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  ┌─────────┬──────┬──────┬────────┬────────┬────────┬────────┬────────┬────────────┬────────┬──────────┐');
  console.log('  │ IV Rank │ TP%  │ SL×  │ Trades │  WR %  │ Sharpe │   PF   │ Avg%   │  Total P&L │ ROC %  │ AvgCap$  │');
  console.log('  ├─────────┼──────┼──────┼────────┼────────┼────────┼────────┼────────┼────────────┼────────┼──────────┤');

  for (const ivMin of ivRanks) {
    for (const tp of creditTPs) {
      for (const sl of creditSLs) {
        const config = {
          ...DEFAULT_CREDIT_CONFIG,
          minIVRank: ivMin,
          creditProfitTarget: tp,
          creditStopLossMultiple: sl,
        };

        const trades: OptionTrade[] = [];
        for (const ts of allSignals) {
          let exitDate: string | null = null;
          for (const signal of ts.entries) {
            if (exitDate && signal.date < exitDate) continue;
            exitDate = null;
            const trade = await simulateCreditSpread(ORATS_TOKEN, signal, config, ts.allTradingDates, OOS_END);
            if (trade) { trades.push(trade); exitDate = trade.exitDate; }
          }
        }

        const a = computeOptionAnalytics(trades);
        const slLabel = sl >= 100 ? 'None' : `${sl.toFixed(1)}×`;
        const pnlStr = a.totalPnl >= 0 ? `$${(a.totalPnl/1000).toFixed(1)}k` : `-$${(Math.abs(a.totalPnl)/1000).toFixed(1)}k`;
        const capStr = a.avgCapitalPerTrade > 0 ? `$${(a.avgCapitalPerTrade/1000).toFixed(1)}k` : '     N/A';
        console.log(
          `  │  >${String(ivMin).padStart(3)}  │ ${(tp*100).toFixed(0).padStart(3)}% │ ${slLabel.padStart(4)} │ ` +
          `${String(a.totalTrades).padStart(6)} │ ${a.winRate.toFixed(1).padStart(5)}% │ ` +
          `${a.sharpe.toFixed(2).padStart(6)} │ ${a.profitFactor.toFixed(2).padStart(6)} │ ` +
          `${a.avgPnlPct.toFixed(1).padStart(5)}% │ ${pnlStr.padStart(10)} │ ${a.returnOnCapital.toFixed(1).padStart(5)}% │ ${capStr.padStart(8)} │`
        );
      }
    }
    if (ivMin < ivRanks[ivRanks.length - 1]) {
      console.log('  ├─────────┼──────┼──────┼────────┼────────┼────────┼────────┼────────┼────────────┼────────┼──────────┤');
    }
  }
  console.log('  └─────────┴──────┴──────┴────────┴────────┴────────┴────────┴────────┴────────────┴────────┴──────────┘');

  console.log(`\n  Total ORATS API calls: ${getApiCallCount()}`);
  closeDB();
}

// ── IV Debug Mode ────────────────────────────────────────

interface TradeRow {
  ticker: string;
  entryDate: string;
  ivRank: number | null;
  entryCredit: number;
  exitType: string;
  pnl: number;
  pnlPct: number;
  holdDays: number;
  direction: string;
  entryStockPrice: number;
  exitStockPrice: number;
  maxLoss: number;
  entryDelta: number;
  entryIV: number;
}

function ivBucket(ivRank: number): string {
  if (ivRank < 20) return '0-20';
  if (ivRank < 40) return '20-40';
  if (ivRank < 60) return '40-60';
  if (ivRank < 80) return '60-80';
  return '80-100';
}

function monthKey(date: string): string {
  return date.slice(0, 7); // YYYY-MM
}

async function runIVDebug() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   IV RANK DEBUG — Why do IV>50 credit spreads underperform?     ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`  OOS: ${OOS_START} → ${OOS_END}`);
  console.log(`  Tickers: ${tickers.join(', ')}`);
  console.log(`  Config: TP=30%, No SL (best credit spread config from sweep)\n`);

  initDB();
  resetApiCallCount();

  // ═══════════════════════════════════════════════════════
  //  Phase 1: Generate signals (shared across both runs)
  // ═══════════════════════════════════════════════════════
  console.log('  Phase 1: Generating signals...');
  const allSignals: TickerSignals[] = [];
  for (const ticker of tickers) {
    const ts = await generateSignals(ticker);
    allSignals.push(ts);
    const withIV = ts.entries.filter(e => e.ivRank != null).length;
    const highIV = ts.entries.filter(e => e.ivRank != null && e.ivRank > 50).length;
    console.log(`    ${ticker}: ${ts.entries.length} signals (${withIV} w/ IV rank, ${highIV} IV>50)`);
  }

  // ═══════════════════════════════════════════════════════
  //  Phase 2: Run BOTH configs and collect trade-level data
  // ═══════════════════════════════════════════════════════
  const configs: { label: string; minIVRank: number }[] = [
    { label: 'IV>0 (all trades)', minIVRank: 0 },
    { label: 'IV>50 (high IV only)', minIVRank: 50 },
  ];

  const resultsByConfig: Map<string, { trades: OptionTrade[]; rows: TradeRow[] }> = new Map();

  for (const cfg of configs) {
    console.log(`\n  Phase 2: Simulating ${cfg.label}...`);
    const simConfig = {
      ...DEFAULT_CREDIT_CONFIG,
      minIVRank: cfg.minIVRank,
      creditProfitTarget: 0.30,
      creditStopLossMultiple: 100,  // effectively no SL
    };

    const trades: OptionTrade[] = [];
    for (const ts of allSignals) {
      let exitDate: string | null = null;
      for (const signal of ts.entries) {
        if (exitDate && signal.date < exitDate) continue;
        exitDate = null;
        const trade = await simulateCreditSpread(
          ORATS_TOKEN, signal, simConfig, ts.allTradingDates, OOS_END,
        );
        if (trade) {
          trades.push(trade);
          exitDate = trade.exitDate;
        }
      }
    }

    const rows: TradeRow[] = trades.map(t => ({
      ticker: t.ticker,
      entryDate: t.entryDate,
      ivRank: t.ivRank ?? null,
      entryCredit: t.entryPrice,
      exitType: t.exitType,
      pnl: t.pnl,
      pnlPct: t.pnlPct,
      holdDays: t.holdDays,
      direction: t.direction,
      entryStockPrice: t.entryStockPrice,
      exitStockPrice: t.exitStockPrice,
      maxLoss: t.maxLoss ?? 0,
      entryDelta: t.entryDelta,
      entryIV: t.entryIV,
    }));

    resultsByConfig.set(cfg.label, { trades, rows });
    console.log(`    ${trades.length} trades simulated`);
  }

  // ═══════════════════════════════════════════════════════
  //  Phase 3: Detailed Diagnostics
  // ═══════════════════════════════════════════════════════

  for (const [label, { trades, rows }] of resultsByConfig) {
    console.log('\n' + '═'.repeat(100));
    console.log(`  DIAGNOSTICS: ${label}`);
    console.log('═'.repeat(100));

    const a = computeOptionAnalytics(trades);
    console.log(`\n  Summary: ${a.totalTrades} trades, WR ${a.winRate.toFixed(1)}%, Sharpe ${a.sharpe.toFixed(2)}, PF ${a.profitFactor.toFixed(2)}`);
    const pnlStr = a.totalPnl >= 0 ? `+$${a.totalPnl.toFixed(0)}` : `-$${Math.abs(a.totalPnl).toFixed(0)}`;
    console.log(`           Total P&L: ${pnlStr}, Avg P&L: ${a.avgPnlPct.toFixed(2)}%, ROC ${a.returnOnCapital.toFixed(1)}%`);

    // ─── 1. Per-trade log ───
    console.log('\n  ┌────────┬────────────┬───────┬─────────┬──────────────────┬──────────┬────────┬──────┐');
    console.log('  │ Ticker │   Entry    │IV Rnk │ Credit$ │    Exit Type     │   P&L $  │  P&L%  │ Days │');
    console.log('  ├────────┼────────────┼───────┼─────────┼──────────────────┼──────────┼────────┼──────┤');
    for (const r of rows) {
      const ivStr = r.ivRank != null ? r.ivRank.toFixed(0).padStart(5) : '  N/A';
      const creditStr = `$${r.entryCredit.toFixed(2)}`.padStart(7);
      const pnl$ = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}`.padStart(8) : `-$${Math.abs(r.pnl).toFixed(0)}`.padStart(8);
      const pnlPct = `${(r.pnlPct * 100).toFixed(1)}%`.padStart(6);
      console.log(
        `  │ ${r.ticker.padEnd(6)} │ ${r.entryDate} │${ivStr}  │ ${creditStr} │ ${r.exitType.padEnd(16)} │ ${pnl$} │ ${pnlPct} │ ${String(r.holdDays).padStart(4)} │`
      );
    }
    console.log('  └────────┴────────────┴───────┴─────────┴──────────────────┴──────────┴────────┴──────┘');

    // ─── 2. IV Rank bucket distribution ───
    const validIV = rows.filter(r => r.ivRank != null);
    const buckets = ['0-20', '20-40', '40-60', '60-80', '80-100'];
    const bucketData: Map<string, { count: number; pnls: number[]; credits: number[]; losses: number[] }> = new Map();
    for (const b of buckets) {
      bucketData.set(b, { count: 0, pnls: [], credits: [], losses: [] });
    }
    for (const r of validIV) {
      const b = ivBucket(r.ivRank!);
      const bd = bucketData.get(b)!;
      bd.count++;
      bd.pnls.push(r.pnl);
      bd.credits.push(r.entryCredit);
      if (r.pnl < 0) bd.losses.push(r.pnl);
    }

    console.log('\n  IV RANK BUCKET ANALYSIS');
    console.log('  ┌──────────┬───────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('  │  Bucket  │ Count │  WR %    │ Avg P&L$ │ Med P&L$ │ AvgCred$ │ AvgLoss$ │ Total$   │');
    console.log('  ├──────────┼───────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');
    for (const b of buckets) {
      const bd = bucketData.get(b)!;
      if (bd.count === 0) {
        console.log(`  │ ${b.padEnd(8)} │ ${String(0).padStart(5)} │      N/A │      N/A │      N/A │      N/A │      N/A │      N/A │`);
        continue;
      }
      const wr = (bd.pnls.filter(p => p > 0).length / bd.count * 100).toFixed(1);
      const avgPnl = (bd.pnls.reduce((s, p) => s + p, 0) / bd.count).toFixed(0);
      const sorted = [...bd.pnls].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)].toFixed(0);
      const avgCredit = (bd.credits.reduce((s, c) => s + c, 0) / bd.count).toFixed(2);
      const avgLoss = bd.losses.length > 0
        ? (bd.losses.reduce((s, l) => s + l, 0) / bd.losses.length).toFixed(0)
        : 'N/A';
      const total = bd.pnls.reduce((s, p) => s + p, 0).toFixed(0);
      console.log(
        `  │ ${b.padEnd(8)} │ ${String(bd.count).padStart(5)} │ ${wr.padStart(6)}% │ ${('$' + avgPnl).padStart(8)} │ ${('$' + median).padStart(8)} │ ${('$' + avgCredit).padStart(8)} │ ${(avgLoss === 'N/A' ? avgLoss : '$' + avgLoss).padStart(8)} │ ${('$' + total).padStart(8)} │`
      );
    }
    console.log('  └──────────┴───────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

    // ─── 3. Ticker concentration ───
    const byTicker: Map<string, { count: number; pnls: number[]; ivRanks: number[] }> = new Map();
    for (const r of rows) {
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, { count: 0, pnls: [], ivRanks: [] });
      const td = byTicker.get(r.ticker)!;
      td.count++;
      td.pnls.push(r.pnl);
      if (r.ivRank != null) td.ivRanks.push(r.ivRank);
    }

    console.log('\n  TICKER CONCENTRATION');
    console.log('  ┌────────┬───────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('  │ Ticker │ Count │   WR %   │ Avg P&L$ │ Total$   │  Avg IV  │ Max IV   │');
    console.log('  ├────────┼───────┼──────────┼──────────┼──────────┼──────────┼──────────┤');
    for (const [ticker, td] of [...byTicker.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const wr = (td.pnls.filter(p => p > 0).length / td.count * 100).toFixed(1);
      const avgPnl = (td.pnls.reduce((s, p) => s + p, 0) / td.count).toFixed(0);
      const total = td.pnls.reduce((s, p) => s + p, 0).toFixed(0);
      const avgIV = td.ivRanks.length > 0 ? (td.ivRanks.reduce((s, iv) => s + iv, 0) / td.ivRanks.length).toFixed(1) : 'N/A';
      const maxIV = td.ivRanks.length > 0 ? Math.max(...td.ivRanks).toFixed(1) : 'N/A';
      console.log(
        `  │ ${ticker.padEnd(6)} │ ${String(td.count).padStart(5)} │ ${wr.padStart(6)}% │ ${('$' + avgPnl).padStart(8)} │ ${('$' + total).padStart(8)} │ ${String(avgIV).padStart(8)} │ ${String(maxIV).padStart(8)} │`
      );
    }
    console.log('  └────────┴───────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

    // ─── 4. Time clustering: monthly heatmap ───
    const byMonth: Map<string, { count: number; pnls: number[] }> = new Map();
    for (const r of rows) {
      const m = monthKey(r.entryDate);
      if (!byMonth.has(m)) byMonth.set(m, { count: 0, pnls: [] });
      const md = byMonth.get(m)!;
      md.count++;
      md.pnls.push(r.pnl);
    }

    console.log('\n  MONTHLY ENTRY CLUSTERING');
    console.log('  ┌─────────┬───────┬──────────┬──────────┬──────────────────────────────────────────────┐');
    console.log('  │  Month  │ Count │ Avg P&L$ │ Total$   │ Histogram                                    │');
    console.log('  ├─────────┼───────┼──────────┼──────────┼──────────────────────────────────────────────┤');
    const sortedMonths = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const maxMonthCount = Math.max(...sortedMonths.map(([, md]) => md.count), 1);
    for (const [month, md] of sortedMonths) {
      const avgPnl = (md.pnls.reduce((s, p) => s + p, 0) / md.count).toFixed(0);
      const total = md.pnls.reduce((s, p) => s + p, 0).toFixed(0);
      const barLen = Math.round((md.count / maxMonthCount) * 40);
      const bar = '#'.repeat(barLen);
      console.log(
        `  │ ${month} │ ${String(md.count).padStart(5)} │ ${('$' + avgPnl).padStart(8)} │ ${('$' + total).padStart(8)} │ ${bar.padEnd(44)} │`
      );
    }
    console.log('  └─────────┴───────┴──────────┴──────────┴──────────────────────────────────────────────┘');

    // ─── 5. Entry credit: IV>50 vs IV<=50 comparison ───
    if (validIV.length > 0) {
      const highIV = validIV.filter(r => r.ivRank! > 50);
      const lowIV = validIV.filter(r => r.ivRank! <= 50);

      console.log('\n  CREDIT RECEIVED: HIGH IV vs LOW IV');
      console.log('  ┌──────────────┬───────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
      console.log('  │    Group     │ Count │ AvgCred$ │ AvgLoss$ │  WR %    │ Avg P&L$ │ Total$   │');
      console.log('  ├──────────────┼───────┼──────────┼──────────┼──────────┼──────────┼──────────┤');
      for (const [groupLabel, group] of [['IV <= 50', lowIV], ['IV > 50', highIV]] as const) {
        if (group.length === 0) {
          console.log(`  │ ${groupLabel.padEnd(12)} │ ${String(0).padStart(5)} │      N/A │      N/A │      N/A │      N/A │      N/A │`);
          continue;
        }
        const avgCredit = (group.reduce((s, r) => s + r.entryCredit, 0) / group.length).toFixed(2);
        const losses = group.filter(r => r.pnl < 0);
        const avgLoss = losses.length > 0
          ? (losses.reduce((s, r) => s + r.pnl, 0) / losses.length).toFixed(0)
          : 'N/A';
        const wr = (group.filter(r => r.pnl > 0).length / group.length * 100).toFixed(1);
        const avgPnl = (group.reduce((s, r) => s + r.pnl, 0) / group.length).toFixed(0);
        const total = group.reduce((s, r) => s + r.pnl, 0).toFixed(0);
        console.log(
          `  │ ${groupLabel.padEnd(12)} │ ${String(group.length).padStart(5)} │ ${('$' + avgCredit).padStart(8)} │ ${(avgLoss === 'N/A' ? avgLoss : '$' + avgLoss).padStart(8)} │ ${wr.padStart(6)}% │ ${('$' + avgPnl).padStart(8)} │ ${('$' + total).padStart(8)} │`
        );
      }
      console.log('  └──────────────┴───────┴──────────┴──────────┴──────────┴──────────┴──────────┘');
    }

    // ─── 6. Loss analysis: biggest losers ───
    const losers = [...rows].filter(r => r.pnl < 0).sort((a, b) => a.pnl - b.pnl);
    if (losers.length > 0) {
      console.log('\n  TOP 10 BIGGEST LOSSES');
      console.log('  ┌────────┬────────────┬───────┬─────────┬──────────┬──────────────────┬──────┬─────────────────────────────┐');
      console.log('  │ Ticker │   Entry    │IV Rnk │ Credit$ │   P&L $  │    Exit Type     │ Days │ Stock Move (entry→exit)     │');
      console.log('  ├────────┼────────────┼───────┼─────────┼──────────┼──────────────────┼──────┼─────────────────────────────┤');
      for (const r of losers.slice(0, 10)) {
        const ivStr = r.ivRank != null ? r.ivRank.toFixed(0).padStart(5) : '  N/A';
        const creditStr = `$${r.entryCredit.toFixed(2)}`.padStart(7);
        const pnl$ = `-$${Math.abs(r.pnl).toFixed(0)}`.padStart(8);
        const stockMove = ((r.exitStockPrice - r.entryStockPrice) / r.entryStockPrice * 100).toFixed(1);
        const moveStr = `$${r.entryStockPrice.toFixed(0)} → $${r.exitStockPrice.toFixed(0)} (${stockMove}%)`;
        console.log(
          `  │ ${r.ticker.padEnd(6)} │ ${r.entryDate} │${ivStr}  │ ${creditStr} │ ${pnl$} │ ${r.exitType.padEnd(16)} │ ${String(r.holdDays).padStart(4)} │ ${moveStr.padEnd(27)} │`
        );
      }
      console.log('  └────────┴────────────┴───────┴─────────┴──────────┴──────────────────┴──────┴─────────────────────────────┘');
    }

    // ─── 7. Wins vs Losses: magnitude comparison ───
    const winTrades = rows.filter(r => r.pnl > 0);
    const lossTrades = rows.filter(r => r.pnl < 0);
    if (winTrades.length > 0 || lossTrades.length > 0) {
      const avgWin = winTrades.length > 0 ? winTrades.reduce((s, r) => s + r.pnl, 0) / winTrades.length : 0;
      const avgLoss = lossTrades.length > 0 ? lossTrades.reduce((s, r) => s + r.pnl, 0) / lossTrades.length : 0;
      const maxWin = winTrades.length > 0 ? Math.max(...winTrades.map(r => r.pnl)) : 0;
      const maxLoss = lossTrades.length > 0 ? Math.min(...lossTrades.map(r => r.pnl)) : 0;

      console.log('\n  WIN/LOSS MAGNITUDE');
      console.log(`    Avg Win:  $${avgWin.toFixed(0)} (${winTrades.length} trades)`);
      console.log(`    Avg Loss: $${avgLoss.toFixed(0)} (${lossTrades.length} trades)`);
      console.log(`    Max Win:  $${maxWin.toFixed(0)}`);
      console.log(`    Max Loss: $${maxLoss.toFixed(0)}`);
      console.log(`    Win/Loss ratio: ${avgLoss !== 0 ? (Math.abs(avgWin / avgLoss)).toFixed(2) : 'N/A'}x`);
    }

    // ─── 8. Direction analysis ───
    const callDirTrades = rows.filter(r => r.direction === 'CALL');
    const putDirTrades = rows.filter(r => r.direction === 'PUT');
    console.log('\n  DIRECTION BREAKDOWN');
    console.log(`    CALL signals (→ sell puts): ${callDirTrades.length} trades, ` +
      `WR ${callDirTrades.length > 0 ? (callDirTrades.filter(r => r.pnl > 0).length / callDirTrades.length * 100).toFixed(1) : 'N/A'}%, ` +
      `Avg P&L $${callDirTrades.length > 0 ? (callDirTrades.reduce((s, r) => s + r.pnl, 0) / callDirTrades.length).toFixed(0) : 'N/A'}`);
    console.log(`    PUT signals  (→ sell calls): ${putDirTrades.length} trades, ` +
      `WR ${putDirTrades.length > 0 ? (putDirTrades.filter(r => r.pnl > 0).length / putDirTrades.length * 100).toFixed(1) : 'N/A'}%, ` +
      `Avg P&L $${putDirTrades.length > 0 ? (putDirTrades.reduce((s, r) => s + r.pnl, 0) / putDirTrades.length).toFixed(0) : 'N/A'}`);

    // ─── 9. Exit type vs IV rank cross-tab ───
    const exitTypes = [...new Set(rows.map(r => r.exitType))];
    console.log('\n  EXIT TYPE × IV RANK CROSS-TAB');
    const exitHeader = exitTypes.map(e => e.padStart(16)).join(' │');
    console.log(`  ┌──────────┬${exitTypes.map(() => '─'.repeat(16)).join('─┬')}─┐`);
    console.log(`  │  Bucket  │${exitHeader} │`);
    console.log(`  ├──────────┼${exitTypes.map(() => '─'.repeat(16)).join('─┼')}─┤`);
    for (const b of buckets) {
      const bucketRows = validIV.filter(r => ivBucket(r.ivRank!) === b);
      const cells = exitTypes.map(et => {
        const matching = bucketRows.filter(r => r.exitType === et);
        return String(matching.length).padStart(16);
      }).join(' │');
      console.log(`  │ ${b.padEnd(8)} │${cells} │`);
    }
    console.log(`  └──────────┴${exitTypes.map(() => '─'.repeat(16)).join('─┴')}─┘`);
  }

  // ═══════════════════════════════════════════════════════
  //  Phase 4: Head-to-head comparison
  // ═══════════════════════════════════════════════════════
  const ivAllResult = resultsByConfig.get('IV>0 (all trades)');
  const iv50Result = resultsByConfig.get('IV>50 (high IV only)');

  if (ivAllResult && iv50Result) {
    console.log('\n' + '═'.repeat(100));
    console.log('  HEAD-TO-HEAD: IV>0 vs IV>50');
    console.log('═'.repeat(100));

    const aAll = computeOptionAnalytics(ivAllResult.trades);
    const a50 = computeOptionAnalytics(iv50Result.trades);

    console.log('\n  ┌─────────────────────┬──────────────────┬──────────────────┬──────────────────┐');
    console.log('  │       Metric        │   IV>0 (all)     │   IV>50 only     │   Difference     │');
    console.log('  ├─────────────────────┼──────────────────┼──────────────────┼──────────────────┤');

    const metrics: { name: string; val0: number; val50: number; fmt: (n: number) => string }[] = [
      { name: 'Trades', val0: aAll.totalTrades, val50: a50.totalTrades, fmt: n => String(n) },
      { name: 'Win Rate %', val0: aAll.winRate, val50: a50.winRate, fmt: n => n.toFixed(1) + '%' },
      { name: 'Sharpe', val0: aAll.sharpe, val50: a50.sharpe, fmt: n => n.toFixed(2) },
      { name: 'Profit Factor', val0: aAll.profitFactor, val50: a50.profitFactor, fmt: n => n.toFixed(2) },
      { name: 'Avg P&L %', val0: aAll.avgPnlPct, val50: a50.avgPnlPct, fmt: n => n.toFixed(2) + '%' },
      { name: 'Total P&L $', val0: aAll.totalPnl, val50: a50.totalPnl, fmt: n => '$' + n.toFixed(0) },
      { name: 'ROC %', val0: aAll.returnOnCapital, val50: a50.returnOnCapital, fmt: n => n.toFixed(1) + '%' },
      { name: 'Max Drawdown %', val0: aAll.maxDrawdown, val50: a50.maxDrawdown, fmt: n => n.toFixed(1) + '%' },
      { name: 'Avg Hold Days', val0: aAll.avgHoldDays, val50: a50.avgHoldDays, fmt: n => n.toFixed(0) },
      { name: 'Avg Entry Delta', val0: aAll.avgEntryDelta, val50: a50.avgEntryDelta, fmt: n => n.toFixed(3) },
      { name: 'Avg Entry DTE', val0: aAll.avgEntryDTE, val50: a50.avgEntryDTE, fmt: n => n.toFixed(0) },
      { name: 'Avg Capital/Trade', val0: aAll.avgCapitalPerTrade, val50: a50.avgCapitalPerTrade, fmt: n => '$' + n.toFixed(0) },
    ];

    for (const m of metrics) {
      const diff = m.val50 - m.val0;
      const diffStr = (diff >= 0 ? '+' : '') + m.fmt(diff);
      console.log(
        `  │ ${m.name.padEnd(19)} │ ${m.fmt(m.val0).padStart(16)} │ ${m.fmt(m.val50).padStart(16)} │ ${diffStr.padStart(16)} │`
      );
    }
    console.log('  └─────────────────────┴──────────────────┴──────────────────┴──────────────────┘');

    // ─── Overlap analysis: trades present in IV>0 that have IV>50 ───
    const iv0Rows = ivAllResult.rows;
    const highIVSubset = iv0Rows.filter(r => r.ivRank != null && r.ivRank > 50);
    const lowIVSubset = iv0Rows.filter(r => r.ivRank != null && r.ivRank <= 50);

    if (highIVSubset.length > 0 && lowIVSubset.length > 0) {
      console.log('\n  WITHIN IV>0 POOL: Splitting trades by IV rank');
      console.log('  (This isolates whether high-IV trades are genuinely worse,');
      console.log('   or if the IV>50 run is different due to position sequencing)\n');

      const hiAvgPnl = highIVSubset.reduce((s, r) => s + r.pnl, 0) / highIVSubset.length;
      const loAvgPnl = lowIVSubset.reduce((s, r) => s + r.pnl, 0) / lowIVSubset.length;
      const hiWR = highIVSubset.filter(r => r.pnl > 0).length / highIVSubset.length * 100;
      const loWR = lowIVSubset.filter(r => r.pnl > 0).length / lowIVSubset.length * 100;
      const hiAvgCredit = highIVSubset.reduce((s, r) => s + r.entryCredit, 0) / highIVSubset.length;
      const loAvgCredit = lowIVSubset.reduce((s, r) => s + r.entryCredit, 0) / lowIVSubset.length;
      const hiLosses = highIVSubset.filter(r => r.pnl < 0);
      const loLosses = lowIVSubset.filter(r => r.pnl < 0);
      const hiAvgLoss = hiLosses.length > 0 ? hiLosses.reduce((s, r) => s + r.pnl, 0) / hiLosses.length : 0;
      const loAvgLoss = loLosses.length > 0 ? loLosses.reduce((s, r) => s + r.pnl, 0) / loLosses.length : 0;

      console.log('  ┌──────────────┬───────┬──────────┬──────────┬──────────┬──────────┐');
      console.log('  │    Group     │ Count │  WR %    │ AvgP&L$  │ AvgCred$ │ AvgLoss$ │');
      console.log('  ├──────────────┼───────┼──────────┼──────────┼──────────┼──────────┤');
      console.log(
        `  │ IV <= 50     │ ${String(lowIVSubset.length).padStart(5)} │ ${loWR.toFixed(1).padStart(6)}% │ ${('$' + loAvgPnl.toFixed(0)).padStart(8)} │ ${('$' + loAvgCredit.toFixed(2)).padStart(8)} │ ${('$' + loAvgLoss.toFixed(0)).padStart(8)} │`
      );
      console.log(
        `  │ IV > 50      │ ${String(highIVSubset.length).padStart(5)} │ ${hiWR.toFixed(1).padStart(6)}% │ ${('$' + hiAvgPnl.toFixed(0)).padStart(8)} │ ${('$' + hiAvgCredit.toFixed(2)).padStart(8)} │ ${('$' + hiAvgLoss.toFixed(0)).padStart(8)} │`
      );
      console.log('  └──────────────┴───────┴──────────┴──────────┴──────────┴──────────┘');

      // ─── Key question: are losses bigger when IV is high? ───
      console.log('\n  KEY HYPOTHESIS: Higher IV = bigger realized moves = bigger losses?');
      if (hiLosses.length > 0 && loLosses.length > 0) {
        const hiMaxLoss = Math.min(...hiLosses.map(r => r.pnl));
        const loMaxLoss = Math.min(...loLosses.map(r => r.pnl));
        const hiStockMoves = hiLosses.map(r => Math.abs((r.exitStockPrice - r.entryStockPrice) / r.entryStockPrice * 100));
        const loStockMoves = loLosses.map(r => Math.abs((r.exitStockPrice - r.entryStockPrice) / r.entryStockPrice * 100));
        const hiAvgMove = hiStockMoves.reduce((s, m) => s + m, 0) / hiStockMoves.length;
        const loAvgMove = loStockMoves.reduce((s, m) => s + m, 0) / loStockMoves.length;

        console.log(`    Low-IV losers:  avg loss $${loAvgLoss.toFixed(0)}, max loss $${loMaxLoss.toFixed(0)}, avg stock move ${loAvgMove.toFixed(1)}%`);
        console.log(`    High-IV losers: avg loss $${hiAvgLoss.toFixed(0)}, max loss $${hiMaxLoss.toFixed(0)}, avg stock move ${hiAvgMove.toFixed(1)}%`);
        console.log(`    >>> ${Math.abs(hiAvgLoss) > Math.abs(loAvgLoss) ? 'YES' : 'NO'}: high-IV losses are ${Math.abs(hiAvgLoss) > Math.abs(loAvgLoss) ? 'LARGER' : 'NOT larger'} ($${Math.abs(hiAvgLoss).toFixed(0)} vs $${Math.abs(loAvgLoss).toFixed(0)})`);
        console.log(`    >>> Stock moves on losses: ${hiAvgMove > loAvgMove ? 'LARGER' : 'NOT larger'} for high IV (${hiAvgMove.toFixed(1)}% vs ${loAvgMove.toFixed(1)}%)`);
      }
    }

    // ─── Trade date overlap: same dates or different? ───
    const iv0Dates = new Set(ivAllResult.rows.map(r => r.entryDate));
    const iv50Dates = new Set(iv50Result.rows.map(r => r.entryDate));
    const overlap = [...iv50Dates].filter(d => iv0Dates.has(d)).length;
    const onlyIn50 = [...iv50Dates].filter(d => !iv0Dates.has(d)).length;
    const onlyIn0 = [...iv0Dates].filter(d => !iv50Dates.has(d)).length;

    console.log('\n  TRADE DATE OVERLAP');
    console.log(`    IV>0 unique entry dates:  ${iv0Dates.size}`);
    console.log(`    IV>50 unique entry dates: ${iv50Dates.size}`);
    console.log(`    Overlapping dates:        ${overlap}`);
    console.log(`    Only in IV>0 (low IV):    ${onlyIn0}`);
    console.log(`    Only in IV>50:            ${onlyIn50}`);
    console.log(`    NOTE: Different trade counts can arise from position sequencing`);
    console.log(`    (when a trade is skipped by IV filter, the next slot opens earlier,`);
    console.log(`     allowing a different trade that IV>50 mode would have missed)\n`);
  }

  console.log(`\n  Total ORATS API calls: ${getApiCallCount()}`);

  // Save diagnostic JSON
  const diagReport = {
    timestamp: new Date().toISOString(),
    config: { oosStart: OOS_START, oosEnd: OOS_END, tickers },
    results: Object.fromEntries(
      [...resultsByConfig.entries()].map(([label, { trades }]) => [
        label,
        { analytics: computeOptionAnalytics(trades), trades },
      ])
    ),
  };
  const diagPath = path.resolve(__dirname, '../data/iv-debug-results.json');
  fs.mkdirSync(path.dirname(diagPath), { recursive: true });
  fs.writeFileSync(diagPath, JSON.stringify(diagReport, null, 2));
  console.log(`  Diagnostic report saved to: ${diagPath}`);

  closeDB();
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   OPTION BACKTEST — Real P&L with Historical Chains            ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`  OOS: ${OOS_START} → ${OOS_END}`);
  console.log(`  Tickers: ${tickers.join(', ')}`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no API calls)' : 'LIVE'}`);
  console.log('');

  if (!ORATS_TOKEN && !DRY_RUN) {
    console.error('  ERROR: ORATS_API_TOKEN not set in .env.local');
    process.exit(1);
  }

  // Initialize SQLite cache
  initDB();
  resetApiCallCount();

  // ── Phase 1: Signal Generation ──
  console.log('  Phase 1: Generating directional signals...');
  const allSignals: TickerSignals[] = [];
  let totalEntries = 0;

  for (const ticker of tickers) {
    const ts = await generateSignals(ticker);
    allSignals.push(ts);
    totalEntries += ts.entries.length;
    const withIV = ts.entries.filter(e => e.ivRank != null).length;
    const highIV = ts.entries.filter(e => e.ivRank != null && e.ivRank > 30).length;
    console.log(`    ${ticker}: ${ts.entries.length} signals (${withIV} with IV rank, ${highIV} IV>30)`);
  }
  console.log(`    Total: ${totalEntries} entry signals\n`);

  if (DRY_RUN) {
    // Estimate API calls
    const leapCalls = totalEntries * 8;  // entry + ~7 monitoring
    const creditEntries = allSignals.reduce((s, ts) =>
      s + ts.entries.filter(e => e.ivRank != null && e.ivRank > 30).length, 0);
    const creditCalls = creditEntries * 5; // entry + ~4 monitoring
    console.log('  DRY RUN — Estimated API calls:');
    console.log(`    LEAP mode: ~${leapCalls} calls (${totalEntries} entries × ~8 chain fetches each)`);
    console.log(`    Credit mode: ~${creditCalls} calls (${creditEntries} IV>30 entries × ~5 chain fetches each)`);
    console.log(`    Total: ~${leapCalls + creditCalls} calls (budget: 20,000/month)`);
    console.log(`    Note: Cached chains are not re-fetched\n`);
    closeDB();
    return;
  }

  // ── Phase 2: LEAP Simulation (1 position per ticker at a time) ──
  console.log('  Phase 2: Simulating LEAP trades (1 open per ticker)...');
  const leapTrades: OptionTrade[] = [];
  const leapConfig = { ...DEFAULT_LEAP_CONFIG };

  for (const ts of allSignals) {
    let count = 0;
    let currentExitDate: string | null = null; // track when current position closes

    for (const signal of ts.entries) {
      // Skip if we still have an open position
      if (currentExitDate && signal.date < currentExitDate) continue;
      currentExitDate = null;

      const trade = await simulateLeap(
        ORATS_TOKEN, signal, leapConfig, ts.allTradingDates, OOS_END,
      );
      if (trade) {
        leapTrades.push(trade);
        currentExitDate = trade.exitDate;
        count++;
      }
    }
    console.log(`    ${ts.ticker}: ${count} LEAP trades (${getApiCallCount()} API calls so far)`);
  }

  // ── Phase 3: Credit Spread Simulation (1 position per ticker at a time) ──
  console.log('\n  Phase 3: Simulating credit spread trades (1 open per ticker)...');
  const creditTrades: OptionTrade[] = [];
  const creditConfig = { ...DEFAULT_CREDIT_CONFIG };

  for (const ts of allSignals) {
    let count = 0;
    let currentExitDate: string | null = null;

    for (const signal of ts.entries) {
      if (currentExitDate && signal.date < currentExitDate) continue;
      currentExitDate = null;

      const trade = await simulateCreditSpread(
        ORATS_TOKEN, signal, creditConfig, ts.allTradingDates, OOS_END,
      );
      if (trade) {
        creditTrades.push(trade);
        currentExitDate = trade.exitDate;
        count++;
      }
    }
    console.log(`    ${ts.ticker}: ${count} credit trades (${getApiCallCount()} API calls so far)`);
  }

  // ── Phase 4: Results ──
  console.log('\n' + '═'.repeat(100));
  console.log('  RESULTS');
  console.log('═'.repeat(100));

  const leapAnalytics = computeOptionAnalytics(leapTrades);
  const creditAnalytics = computeOptionAnalytics(creditTrades);

  printAnalytics('LEAP (Buy Deep ITM)', leapAnalytics);
  printAnalytics('CREDIT SPREAD (Sell OTM)', creditAnalytics);

  // Buy-and-hold comparison
  console.log('\n  COMPARISON');
  console.log('  ─'.repeat(50));
  console.log('  Buy-and-hold (EW 5 tickers): Sharpe ~1.25 (benchmark from previous analysis)');
  console.log(`  LEAP mode:                   Sharpe ${leapAnalytics.sharpe.toFixed(2)}, WR ${leapAnalytics.winRate.toFixed(1)}%, ${leapAnalytics.totalTrades} trades`);
  console.log(`  Credit Spread mode:          Sharpe ${creditAnalytics.sharpe.toFixed(2)}, WR ${creditAnalytics.winRate.toFixed(1)}%, ${creditAnalytics.totalTrades} trades`);
  console.log(`\n  Total ORATS API calls: ${getApiCallCount()}`);

  // Save results
  const report = {
    config: { oosStart: OOS_START, oosEnd: OOS_END, tickers },
    leap: { analytics: leapAnalytics, trades: leapTrades },
    credit: { analytics: creditAnalytics, trades: creditTrades },
    apiCalls: getApiCallCount(),
    timestamp: new Date().toISOString(),
  };

  const reportPath = path.resolve(__dirname, '../data/option-backtest-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report saved to: ${reportPath}`);

  closeDB();
}

function printAnalytics(label: string, a: OptionSimAnalytics) {
  const pnlStr = a.totalPnl >= 0 ? `+$${a.totalPnl.toFixed(0)}` : `-$${Math.abs(a.totalPnl).toFixed(0)}`;
  console.log(`\n  ${label}:`);
  console.log(`    Trades:      ${a.totalTrades} (${a.winners}W / ${a.losers}L)`);
  console.log(`    Win Rate:    ${a.winRate.toFixed(1)}%`);
  console.log(`    Avg P&L:     ${a.avgPnlPct.toFixed(2)}%`);
  console.log(`    Total P&L:   ${pnlStr} (per 1 contract per trade)`);
  console.log(`    Capital:     $${a.totalCapitalDeployed.toFixed(0)} deployed, $${a.avgCapitalPerTrade.toFixed(0)} avg/trade`);
  console.log(`    ROC:         ${a.returnOnCapital.toFixed(1)}% return on capital`);
  console.log(`    Sharpe:      ${a.sharpe.toFixed(2)}`);
  console.log(`    PF:          ${a.profitFactor.toFixed(2)}`);
  console.log(`    Max DD:      ${a.maxDrawdown.toFixed(1)}%`);
  console.log(`    Avg Hold:    ${a.avgHoldDays.toFixed(0)} days`);
  console.log(`    Avg Delta:   ${a.avgEntryDelta.toFixed(2)}`);
  console.log(`    Avg DTE:     ${a.avgEntryDTE.toFixed(0)}`);
  console.log(`    Exits:       ${Object.entries(a.byExit).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

const entry = PREFETCH_MODE ? runPrefetch : SWEEP_MODE ? runSweep : IV_DEBUG_MODE ? runIVDebug : main;
entry().catch(err => { console.error('Fatal:', err); process.exit(1); });
