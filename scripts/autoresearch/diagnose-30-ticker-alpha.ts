/**
 * diagnose-30-ticker-alpha.ts — Per-ticker diagnostic for 30-ticker universe.
 *
 * Answers:
 *   Q1. How many signals fire per ticker, and what's their score distribution?
 *   Q2. What's each ticker's contribution to aggregate P&L, Sharpe, trade count, win rate?
 *   Q3. Is the 30-ticker delta-gate failure due to specific weak tickers or universal dilution?
 *
 * NOT a campaign. Outputs breakdowns only — no leaderboard update, no
 * global attempt increment, no holdout evaluation.
 *
 * Usage:
 *   npx tsx scripts/autoresearch/diagnose-30-ticker-alpha.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { strategy } from './strategy-30-smoke';
import type { TickerDataBundle, MarketContext } from './types';
import { initDB, closeDB } from '../../src/lib/backtest/chain-cache';
import { simulateLeap, type OptionTrade, type EntrySignal, type SimConfig } from '../../src/lib/backtest/option-sim';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../../.env.local'), override: true });

const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';
const CACHE_PATH = path.resolve(__dirname, 'data-cache.json');

// EMA calculation matches runner's.
function computeEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let ema = values[0];
  for (let i = 0; i < values.length; i++) {
    ema = i === 0 ? values[i] : values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

interface CacheEntry {
  ticker: string;
  candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
  iv?: Array<{ date: string; iv30: number | null; iv60: number | null; hv20: number | null }>;
}

function loadCache(): { perTicker: Map<string, CacheEntry>; spyByDate: Map<string, { close: number; ema200: number }> } {
  const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as {
    tickers: Record<string, { candles: CacheEntry['candles']; iv: CacheEntry['iv'] }>;
  };
  const perTicker = new Map<string, CacheEntry>();
  for (const [ticker, entry] of Object.entries(raw.tickers)) {
    perTicker.set(ticker, { ticker, candles: entry.candles, iv: entry.iv });
  }
  const spy = perTicker.get('SPY')!;
  const spyCloses = spy.candles.map(c => c.close);
  const spyEma200 = computeEMA(spyCloses, 200);
  const spyByDate = new Map<string, { close: number; ema200: number }>();
  spy.candles.forEach((c, i) => spyByDate.set(c.date, { close: c.close, ema200: spyEma200[i] }));
  return { perTicker, spyByDate };
}

function buildBundle(entry: CacheEntry): TickerDataBundle {
  const closes = entry.candles.map(c => c.close);
  const emas = new Map<number, number[]>();
  for (const p of [8, 13, 34, 55, 200]) emas.set(p, computeEMA(closes, p));
  const dateToIdx = new Map<string, number>();
  entry.candles.forEach((c, i) => dateToIdx.set(c.date, i));
  const ivRanks: (number | null)[] = entry.candles.map(() => null);  // not used for LEAP
  return {
    ticker: entry.ticker,
    candles: entry.candles,
    ivRanks,
    dateToIdx,
    emas,
    regimeByDate: new Map(),  // diagnostic doesn't need regime data
  };
}

async function main() {
  console.log('Diagnostic: 30-ticker alpha attribution\n');
  const { perTicker, spyByDate } = loadCache();
  const market: MarketContext = { spyByDate };

  const OOS_START = '2019-01-17';
  const OOS_END = '2024-01-19';  // Campaign E-Clean selection window

  // ─── Q1: Per-ticker signal counts ───
  console.log(`Q1. Signal counts per ticker (selection window ${OOS_START} → ${OOS_END}):\n`);
  const perTickerSignals = new Map<string, EntrySignal[]>();
  for (const ticker of strategy.tickers) {
    const entry = perTicker.get(ticker);
    if (!entry) { console.warn(`  [missing] ${ticker}`); continue; }
    const bundle = buildBundle(entry);
    const all = strategy.generateSignals(bundle, market);
    const inWindow = all.filter(s => s.date >= OOS_START && s.date <= OOS_END);
    perTickerSignals.set(ticker, inWindow);
  }
  console.log(`${'Ticker'.padEnd(7)} ${'Signals'.padStart(8)} ${'Score min'.padStart(10)} ${'Score med'.padStart(10)} ${'Score max'.padStart(10)}`);
  console.log('─────────────────────────────────────────────────');
  let totalSignals = 0;
  for (const ticker of strategy.tickers) {
    const sigs = perTickerSignals.get(ticker) ?? [];
    totalSignals += sigs.length;
    if (sigs.length === 0) {
      console.log(`${ticker.padEnd(7)} ${String(0).padStart(8)}`);
      continue;
    }
    const scores = sigs.map(s => s.score ?? 0).sort((a, b) => a - b);
    const med = scores[Math.floor(scores.length / 2)];
    console.log(`${ticker.padEnd(7)} ${String(sigs.length).padStart(8)} ${String(scores[0]).padStart(10)} ${String(med).padStart(10)} ${String(scores[scores.length - 1]).padStart(10)}`);
  }
  console.log('─────────────────────────────────────────────────');
  console.log(`Total signals across 30 tickers: ${totalSignals}\n`);

  // ─── Q2: Per-ticker trade contribution (simulate each signal to a trade) ───
  console.log('Q2. Per-ticker trade contribution (simulating all signals)...\n');
  initDB();  // read-write (simulateLeap may cache new ORATS fetches)

  const simCfg: SimConfig = strategy.buildConfig('AAPL', 'CALL');
  const allTradingDates = [...new Set(
    Array.from(perTicker.values()).flatMap(e => e.candles.map(c => c.date))
  )].sort();

  // Keep {score, pnl} pairs so we can do score-threshold analysis (H3) post-hoc
  // without re-simulating. Null trades (signal→no-fill) are dropped from the
  // list so trades.length may be < sigs.length.
  const perTickerTrades = new Map<string, OptionTrade[]>();
  const scoredTrades: Array<{ ticker: string; score: number; pnl: number }> = [];
  for (const ticker of strategy.tickers) {
    const sigs = perTickerSignals.get(ticker) ?? [];
    const trades: OptionTrade[] = [];
    for (const sig of sigs) {
      const trade = await simulateLeap(ORATS_TOKEN, sig, simCfg, allTradingDates, OOS_END);
      if (trade) {
        trades.push(trade);
        scoredTrades.push({ ticker, score: sig.score ?? 0, pnl: trade.pnl });
      }
    }
    perTickerTrades.set(ticker, trades);
    process.stdout.write(`  ${ticker}: ${sigs.length} signals → ${trades.length} trades\n`);
  }

  console.log('\nQ2 summary (sorted by Sharpe contribution):\n');
  console.log(`${'Ticker'.padEnd(7)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'Avg $'.padStart(8)} ${'Tot $'.padStart(8)} ${'Std $'.padStart(8)} ${'Sharpe'.padStart(8)}`);
  console.log('─────────────────────────────────────────────────────────────');

  type Agg = { ticker: string; n: number; wr: number; avg: number; tot: number; std: number; sharpe: number };
  const aggs: Agg[] = [];
  for (const ticker of strategy.tickers) {
    const trades = perTickerTrades.get(ticker) ?? [];
    if (trades.length === 0) { aggs.push({ ticker, n: 0, wr: 0, avg: 0, tot: 0, std: 0, sharpe: 0 }); continue; }
    const pnls = trades.map(t => t.pnl);
    const n = pnls.length;
    const tot = pnls.reduce((a, b) => a + b, 0);
    const avg = tot / n;
    const variance = pnls.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, n - 1);
    const std = Math.sqrt(variance);
    const wr = 100 * pnls.filter(p => p > 0).length / n;
    const sharpe = std > 0 ? avg / std * Math.sqrt(252 / 100) : 0;  // per-trade sharpe rough scaling
    aggs.push({ ticker, n, wr, avg, tot, std, sharpe });
  }
  aggs.sort((a, b) => b.sharpe - a.sharpe);
  let grandTotal = 0;
  for (const a of aggs) {
    grandTotal += a.tot;
    console.log(`${a.ticker.padEnd(7)} ${String(a.n).padStart(7)} ${a.wr.toFixed(1).padStart(6)} ${a.avg.toFixed(0).padStart(8)} ${a.tot.toFixed(0).padStart(8)} ${a.std.toFixed(0).padStart(8)} ${a.sharpe.toFixed(3).padStart(8)}`);
  }
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`Grand total P&L: $${grandTotal.toFixed(0)} across ${aggs.reduce((s, a) => s + a.n, 0)} trades\n`);

  // ─── Q3: Compare 14-ticker subset vs 30 ───
  console.log('Q3. 14-ticker subset vs 30-ticker universe:\n');
  const tickers14 = ['IWM', 'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META', 'JPM', 'GS', 'COST', 'NFLX', 'NVDA', 'TSLA', 'GLD', 'UNH'];
  const tickers30 = strategy.tickers;
  const t14Set = new Set(tickers14);

  const aggSubset = (set: Set<string>) => {
    const all = aggs.filter(a => set.has(a.ticker));
    const pnls = all.flatMap(a => perTickerTrades.get(a.ticker)!.map(t => t.pnl));
    const n = pnls.length;
    if (n === 0) return { n: 0, wr: 0, tot: 0, sharpe: 0 };
    const tot = pnls.reduce((a, b) => a + b, 0);
    const avg = tot / n;
    const std = Math.sqrt(pnls.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, n - 1));
    const wr = 100 * pnls.filter(p => p > 0).length / n;
    const sharpe = std > 0 ? avg / std * Math.sqrt(252 / 100) : 0;
    return { n, wr, tot, sharpe };
  };

  const s14 = aggSubset(t14Set);
  const s30 = aggSubset(new Set(tickers30));
  const s16 = aggSubset(new Set(tickers30.filter(t => !t14Set.has(t))));  // the 16 NEW tickers only

  console.log(`${'Subset'.padEnd(22)} ${'Trades'.padStart(8)} ${'WR%'.padStart(6)} ${'Total $'.padStart(10)} ${'Per-trade Sharpe'.padStart(18)}`);
  console.log(`${'Original 14 (Campaign)'.padEnd(22)} ${String(s14.n).padStart(8)} ${s14.wr.toFixed(1).padStart(6)} ${s14.tot.toFixed(0).padStart(10)} ${s14.sharpe.toFixed(3).padStart(18)}`);
  console.log(`${'New 16 tickers only'.padEnd(22)} ${String(s16.n).padStart(8)} ${s16.wr.toFixed(1).padStart(6)} ${s16.tot.toFixed(0).padStart(10)} ${s16.sharpe.toFixed(3).padStart(18)}`);
  console.log(`${'All 30 combined'.padEnd(22)} ${String(s30.n).padStart(8)} ${s30.wr.toFixed(1).padStart(6)} ${s30.tot.toFixed(0).padStart(10)} ${s30.sharpe.toFixed(3).padStart(18)}`);

  // ─── H3: Score-threshold sensitivity ───
  console.log('\n\nH3. Score-threshold sensitivity (all 30 tickers):\n');
  console.log('Signal score is higher when price is closer to EMA34 (max 100 = exact touch, 50 = 5% above).');
  console.log(`${'Threshold'.padEnd(12)} ${'Trades'.padStart(8)} ${'WR%'.padStart(6)} ${'Avg $'.padStart(8)} ${'Tot $'.padStart(10)} ${'Sharpe'.padStart(8)} ${'Δ vs T50'.padStart(10)}`);
  console.log('─────────────────────────────────────────────────────────────────────────');
  const baselineAt50 = scoredTrades.filter(t => t.score >= 50);
  const computeStats = (pnls: number[]) => {
    if (pnls.length === 0) return { n: 0, wr: 0, avg: 0, tot: 0, sharpe: 0 };
    const n = pnls.length;
    const tot = pnls.reduce((a, b) => a + b, 0);
    const avg = tot / n;
    const std = Math.sqrt(pnls.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, n - 1));
    const wr = 100 * pnls.filter(p => p > 0).length / n;
    const sharpe = std > 0 ? avg / std * Math.sqrt(252 / 100) : 0;
    return { n, wr, avg, tot, sharpe };
  };
  const baseStats = computeStats(baselineAt50.map(t => t.pnl));
  for (const thresh of [50, 55, 60, 65, 70, 75, 80, 85, 90]) {
    const filtered = scoredTrades.filter(t => t.score >= thresh);
    const s = computeStats(filtered.map(t => t.pnl));
    const pct = thresh === 50 ? 100 : (100 * s.n / baseStats.n);
    const dsharpe = s.sharpe - baseStats.sharpe;
    console.log(`${('≥' + thresh).padEnd(12)} ${String(s.n).padStart(8)} ${s.wr.toFixed(1).padStart(6)} ${s.avg.toFixed(0).padStart(8)} ${s.tot.toFixed(0).padStart(10)} ${s.sharpe.toFixed(3).padStart(8)} ${(thresh === 50 ? '—' : dsharpe >= 0 ? `+${dsharpe.toFixed(3)}` : dsharpe.toFixed(3)).padStart(10)} (${pct.toFixed(0)}% of base)`);
  }

  // Also check the inverse — what if we KEEP only low-score (far-from-EMA) signals?
  console.log('\nInverse: what if we select LOW-score signals instead (price extended from EMA34)?');
  for (const thresh of [50, 55, 60, 65, 70, 75, 80]) {
    const filtered = scoredTrades.filter(t => t.score <= thresh);
    const s = computeStats(filtered.map(t => t.pnl));
    console.log(`${('≤' + thresh).padEnd(12)} ${String(s.n).padStart(8)} ${s.wr.toFixed(1).padStart(6)} ${s.avg.toFixed(0).padStart(8)} ${s.tot.toFixed(0).padStart(10)} ${s.sharpe.toFixed(3).padStart(8)}`);
  }

  closeDB();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
