/**
 * Per-trade sanity check for d65-tp40 (the first valid bidask-fills strategy).
 *
 * Checks: ticker concentration, year distribution, PnL concentration (home-run
 * trades), exit breakdown, and consecutive loss streaks.
 *
 * Run: npx tsx scripts/autoresearch/diagnose-d65-tp40.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../../.env.local'), override: true });

import type { BacktestCandle } from '../../src/lib/backtest/types';
import { computeIVRankMinMax } from '../../src/lib/backtest/iv-rank';
import { initDB, getCachedChain, findStrikeByDelta, findContractDirect } from '../../src/lib/backtest/chain-cache';
import type { OptionTrade, EntrySignal, SimConfig } from '../../src/lib/backtest/option-sim';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

// ── Data loading (matches runner's pipeline) ──────────────
interface LocalCache {
  tickers: Record<string, {
    candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    iv: Array<{ date: string; iv30: number | null; iv60: number | null; hv20: number | null }>;
  }>;
}

function computeEMASeries(closes: number[], period: number): number[] {
  const ema = new Array(closes.length).fill(0);
  if (closes.length < period) return ema;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  return ema;
}

function computeRollingPercentile(values: (number | undefined)[], window = 252): (number | undefined)[] {
  return values.map((v, i) => {
    if (v == null || !Number.isFinite(v)) return undefined;
    const start = Math.max(0, i - window);
    const w = values.slice(start, i + 1).filter((x): x is number => x != null && Number.isFinite(x));
    if (w.length < 60) return undefined;
    return (w.filter(x => x <= v).length / w.length) * 100;
  });
}

const TICKERS = ['GLD', 'IWM', 'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META', 'JPM', 'GS', 'COST', 'UNH', 'NFLX', 'NVDA', 'TSLA'];

const cache: LocalCache = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'data-cache.json'), 'utf-8'));

// Build SPY market context
const spyCache = cache.tickers['SPY'];
const spyCloses = spyCache.candles.map(c => c.close);
const spyEma200 = computeEMASeries(spyCloses, 200);
const spyByDate = new Map<string, { close: number; ema200: number }>();
for (let i = 0; i < spyCache.candles.length; i++) {
  spyByDate.set(spyCache.candles[i].date, { close: spyCloses[i], ema200: spyEma200[i] });
}

// ── Signal generation (d65-tp40 architecture) ──
function generateSignals(ticker: string): EntrySignal[] {
  const td = cache.tickers[ticker];
  if (!td) return [];
  const candles = td.candles;
  const closes = candles.map(c => c.close);
  const ema8 = computeEMASeries(closes, 8);
  const ema13 = computeEMASeries(closes, 13);
  const ema34 = computeEMASeries(closes, 34);
  const ema55 = computeEMASeries(closes, 55);
  const ema200 = computeEMASeries(closes, 200);

  const ivByDate = new Map<string, { iv30: number | null; iv60: number | null }>();
  for (const r of td.iv) ivByDate.set(r.date, { iv30: r.iv30, iv60: r.iv60 });
  const contangoSeries = candles.map(c => {
    const iv = ivByDate.get(c.date);
    if (iv?.iv30 != null && Number.isFinite(iv.iv30) && iv.iv30 > 0 && iv?.iv60 != null && Number.isFinite(iv.iv60)) {
      return (iv.iv60 / iv.iv30) - 1;
    }
    return undefined;
  });
  const contangoPct = computeRollingPercentile(contangoSeries);

  const signals: EntrySignal[] = [];
  for (let i = 60; i < candles.length; i++) {
    const c = candles[i];
    if (ema8[i] <= 0 || ema13[i] <= 0 || ema34[i] <= 0 || ema34[i - 5] <= 0 || ema55[i] <= 0) continue;
    if (ema200[i] <= 0) continue;
    if (c.close <= ema55[i]) continue;
    const spy = spyByDate.get(c.date);
    if (!spy || !spy.ema200 || spy.ema200 <= 0 || spy.close <= spy.ema200) continue;
    if (!(ema8[i] > ema13[i] && ema34[i] > ema34[i - 5])) continue;
    const pct = (c.close - ema34[i]) / ema34[i];
    if (!(pct >= 0 && pct < 0.05)) continue;
    const cp = contangoPct[i];
    if (cp !== undefined && cp >= 48) continue;
    signals.push({ ticker, date: c.date, direction: 'CALL', score: 55 });
  }
  return signals;
}

// ── LEAP simulator (matches worker.ts makeLeapEvaluator) ──
function simulateLeapTrade(signal: EntrySignal, config: SimConfig, allDates: string[], maxDate: string): OptionTrade | null {
  const entryChain = getCachedChain(signal.ticker, signal.date);
  if (entryChain.length === 0) return null;

  const optionType: 'Call' | 'Put' = 'Call';
  const targetDelta = (config.leapDeltaRange[0] + config.leapDeltaRange[1]) / 2;
  const entry = findStrikeByDelta(entryChain, targetDelta, optionType, config.leapDTERange);
  if (!entry || entry.mid <= 0) return null;

  const halfSpread = (entry.ask > 0 && entry.bid > 0) ? (entry.ask - entry.bid) / 2 : entry.mid * 0.01;
  const entryPrice = entry.mid + halfSpread;
  const tpPrice = entryPrice * (1 + config.leapProfitTarget);
  const slPrice = entryPrice * (1 - config.leapStopLoss);

  const monitorEnd = entry.row.expir_date < maxDate ? entry.row.expir_date : maxDate;
  const startIdx = allDates.indexOf(signal.date);
  if (startIdx < 0) return null;

  const monitorDates: string[] = [];
  for (let i = startIdx + 1; i < allDates.length; i++) {
    if (allDates[i] > monitorEnd) break;
    monitorDates.push(allDates[i]);
  }

  for (const checkDate of monitorDates) {
    const current = findContractDirect(signal.ticker, checkDate, entry.row.strike, entry.row.expir_date, optionType);
    if (!current || current.mid <= 0) continue;
    const exitHalfSpread = (current.ask > 0 && current.bid > 0) ? (current.ask - current.bid) / 2 : current.mid * 0.01;
    const currentExitPrice = current.mid - exitHalfSpread;

    let exitType: 'PROFIT_TARGET' | 'STOP_LOSS' | 'TIME_STOP' | null = null;
    if (currentExitPrice >= tpPrice) exitType = 'PROFIT_TARGET';
    else if (currentExitPrice <= slPrice) exitType = 'STOP_LOSS';
    else if (current.row.dte <= config.leapTimeStopDTE) exitType = 'TIME_STOP';

    if (exitType) {
      const pnl = (currentExitPrice - entryPrice) * 100;
      return {
        ticker: signal.ticker, mode: 'LEAP', direction: 'CALL',
        entryDate: signal.date, entrySignalScore: signal.score,
        strike: entry.row.strike, expiry: entry.row.expir_date,
        entryDTE: entry.row.dte, entryPrice, entryDelta: entry.delta ?? 0,
        entryStockPrice: entry.row.stock_price,
        exitDate: checkDate, exitPrice: currentExitPrice, exitDTE: current.row.dte,
        exitStockPrice: current.row.stock_price, exitType,
        pnl, pnlPct: pnl / (entryPrice * 100),
        dailyMtM: [],
      } as unknown as OptionTrade;
    }
  }
  return null;
}

// ── Main ──
async function main() {
  console.log('=== d65-tp40 Per-Trade Sanity Check ===\n');
  initDB();

  const config: SimConfig = {
    ...DEFAULT_LEAP_CONFIG,
    mode: 'LEAP',
    leapDeltaRange: [0.65, 0.80] as [number, number],
    leapDTERange: [180, 270] as [number, number],
    leapProfitTarget: 0.40,
    leapStopLoss: 0.30,
    leapTimeStopDTE: 105,
    monitoringIntervalDays: 1,
  };

  // Generate signals across all tickers
  const allSignals: EntrySignal[] = [];
  for (const t of TICKERS) allSignals.push(...generateSignals(t));
  allSignals.sort((a, b) => (a.date === b.date ? a.ticker.localeCompare(b.ticker) : a.date.localeCompare(b.date)));
  console.log(`Total signals: ${allSignals.length}`);

  const allDates = [...new Set(spyCache.candles.map(c => c.date))].sort();
  const maxDate = allDates[allDates.length - 1];

  // Simulate each signal (no portfolio constraints — pure per-signal backtest)
  const trades: OptionTrade[] = [];
  for (const s of allSignals) {
    const t = simulateLeapTrade(s, config, allDates, maxDate);
    if (t) trades.push(t);
  }
  console.log(`Unconstrained trades: ${trades.length} (${(100 * trades.length / allSignals.length).toFixed(1)}% of signals)\n`);

  // Per-ticker analysis
  console.log('=== Per-Ticker Distribution ===');
  const byTicker: Record<string, { count: number; pnl: number; wins: number; losses: number }> = {};
  for (const t of trades) {
    byTicker[t.ticker] ??= { count: 0, pnl: 0, wins: 0, losses: 0 };
    byTicker[t.ticker].count++;
    byTicker[t.ticker].pnl += t.pnl;
    if (t.pnl > 0) byTicker[t.ticker].wins++;
    else byTicker[t.ticker].losses++;
  }
  console.log('ticker   count   pnl($)     win%    avg/trade');
  const sortedT = Object.keys(byTicker).sort((a, b) => byTicker[b].pnl - byTicker[a].pnl);
  for (const t of sortedT) {
    const b = byTicker[t];
    const wr = b.count > 0 ? (100 * b.wins / b.count).toFixed(0) : '-';
    const avg = b.count > 0 ? (b.pnl / b.count).toFixed(0) : '-';
    console.log(`${t.padEnd(8)} ${b.count.toString().padStart(5)}   ${b.pnl.toFixed(0).padStart(8)}  ${wr.padStart(4)}%  ${avg.padStart(8)}`);
  }
  console.log();

  // Per-year analysis
  console.log('=== Per-Year Distribution ===');
  const byYear: Record<string, { count: number; pnl: number; wins: number }> = {};
  for (const t of trades) {
    const y = t.entryDate.slice(0, 4);
    byYear[y] ??= { count: 0, pnl: 0, wins: 0 };
    byYear[y].count++;
    byYear[y].pnl += t.pnl;
    if (t.pnl > 0) byYear[y].wins++;
  }
  console.log('year   count   pnl($)     win%');
  for (const y of Object.keys(byYear).sort()) {
    const b = byYear[y];
    const wr = b.count > 0 ? (100 * b.wins / b.count).toFixed(0) : '-';
    console.log(`${y}   ${b.count.toString().padStart(3)}    ${b.pnl.toFixed(0).padStart(8)}  ${wr.padStart(4)}%`);
  }
  console.log();

  // PnL concentration (top 5 winners and top 5 losers)
  console.log('=== Top 5 Winners ===');
  const sortedByPnl = [...trades].sort((a, b) => b.pnl - a.pnl);
  for (const t of sortedByPnl.slice(0, 5)) {
    console.log(`  ${t.ticker.padEnd(6)} ${t.entryDate} → ${t.exitDate}  pnl=$${t.pnl.toFixed(0).padStart(6)}  pct=${((t as any).pnlPct * 100).toFixed(1)}%  (${t.exitType})`);
  }
  console.log('\n=== Top 5 Losers ===');
  for (const t of sortedByPnl.slice(-5).reverse()) {
    console.log(`  ${t.ticker.padEnd(6)} ${t.entryDate} → ${t.exitDate}  pnl=$${t.pnl.toFixed(0).padStart(6)}  pct=${((t as any).pnlPct * 100).toFixed(1)}%  (${t.exitType})`);
  }

  // PnL concentration ratio
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const top5Pnl = sortedByPnl.slice(0, 5).reduce((s, t) => s + t.pnl, 0);
  const top10Pnl = sortedByPnl.slice(0, 10).reduce((s, t) => s + t.pnl, 0);
  console.log(`\nTotal PnL: $${totalPnl.toFixed(0)}`);
  console.log(`Top 5 winners contribute: $${top5Pnl.toFixed(0)} (${(100 * top5Pnl / totalPnl).toFixed(0)}% of total)`);
  console.log(`Top 10 winners contribute: $${top10Pnl.toFixed(0)} (${(100 * top10Pnl / totalPnl).toFixed(0)}% of total)`);

  // Exit type breakdown
  console.log('\n=== Exit Type Breakdown ===');
  const byExit: Record<string, { count: number; pnl: number }> = {};
  for (const t of trades) {
    byExit[t.exitType] ??= { count: 0, pnl: 0 };
    byExit[t.exitType].count++;
    byExit[t.exitType].pnl += t.pnl;
  }
  for (const [e, b] of Object.entries(byExit)) {
    console.log(`  ${e.padEnd(15)} ${b.count.toString().padStart(4)} trades  pnl=$${b.pnl.toFixed(0)}`);
  }

  // Consecutive loss streak (chronological)
  console.log('\n=== Loss Streak Analysis (chronological) ===');
  const chronological = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  let maxStreak = 0, curStreak = 0, maxStreakStart = '', streakStart = '';
  for (const t of chronological) {
    if (t.pnl < 0) {
      if (curStreak === 0) streakStart = t.entryDate;
      curStreak++;
      if (curStreak > maxStreak) { maxStreak = curStreak; maxStreakStart = streakStart; }
    } else {
      curStreak = 0;
    }
  }
  console.log(`Max consecutive losses: ${maxStreak} (starting ${maxStreakStart})`);
}

main().catch(err => { console.error(err); process.exit(1); });
