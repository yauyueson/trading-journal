/**
 * 2025 Regime Investigation for d65-tp40
 *
 * Goal: understand why 2025+ performance collapsed (45-loss streak starting
 * 2025-01-23, 0% win rate YTD 2026) vs 2024's +$658K year.
 *
 * Outputs 5 tables:
 *   1. Monthly P&L 2024-01 → 2026-02
 *   2. 45-loss streak details (tickers, exits)
 *   3. Per-ticker 2024 vs 2025+ split
 *   4. Macro regime at entry dates by period
 *   5. Exit-type mix shift by period
 *
 * Run: npx tsx scripts/autoresearch/diagnose-2025-regime.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
dotenvConfig({ path: path.resolve(__dirname, '../../.env.local'), override: true });

import { initDB, getCachedChain, findStrikeByDelta, findContractDirect } from '../../src/lib/backtest/chain-cache';
import type { OptionTrade, EntrySignal, SimConfig } from '../../src/lib/backtest/option-sim';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

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

const spyCache = cache.tickers['SPY'];
const spyCloses = spyCache.candles.map(c => c.close);
const spyEma200 = computeEMASeries(spyCloses, 200);
const spyByDate = new Map<string, { close: number; ema200: number }>();
for (let i = 0; i < spyCache.candles.length; i++) {
  spyByDate.set(spyCache.candles[i].date, { close: spyCloses[i], ema200: spyEma200[i] });
}

// Per-ticker regime tracking (keep contangoPct + IV30 for later analysis)
type TickerRegime = { contangoPct: (number | undefined)[]; iv30: (number | null)[]; dateToIdx: Map<string, number> };
const tickerRegime = new Map<string, TickerRegime>();

// Signal generation — d65-tp40 architecture
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
  const iv30Series = candles.map(c => ivByDate.get(c.date)?.iv30 ?? null);
  const contangoSeries = candles.map(c => {
    const iv = ivByDate.get(c.date);
    if (iv?.iv30 != null && Number.isFinite(iv.iv30) && iv.iv30 > 0 && iv?.iv60 != null && Number.isFinite(iv.iv60)) {
      return (iv.iv60 / iv.iv30) - 1;
    }
    return undefined;
  });
  const contangoPct = computeRollingPercentile(contangoSeries);

  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));
  tickerRegime.set(ticker, { contangoPct, iv30: iv30Series, dateToIdx });

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

// LEAP simulator (exact match to diagnose-d65-tp40.ts)
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
  // No exit triggered — treat as open (skip from analysis)
  return null;
}

// Period classification helper
function periodOf(date: string): string {
  const y = date.slice(0, 4);
  const m = parseInt(date.slice(5, 7), 10);
  if (y < '2024') return 'pre-2024';
  if (y === '2024') return '2024';
  if (y === '2025') {
    if (m <= 3) return '2025-Q1';
    if (m <= 6) return '2025-Q2';
    if (m <= 9) return '2025-Q3';
    return '2025-Q4';
  }
  return '2026';
}

async function main() {
  console.log('=== 2025 Regime Investigation (d65-tp40) ===\n');
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

  const allSignals: EntrySignal[] = [];
  for (const t of TICKERS) allSignals.push(...generateSignals(t));
  allSignals.sort((a, b) => (a.date === b.date ? a.ticker.localeCompare(b.ticker) : a.date.localeCompare(b.date)));
  console.log(`Total signals: ${allSignals.length}`);

  const allDates = [...new Set(spyCache.candles.map(c => c.date))].sort();
  const maxDate = allDates[allDates.length - 1];

  const trades: OptionTrade[] = [];
  for (const s of allSignals) {
    const t = simulateLeapTrade(s, config, allDates, maxDate);
    if (t) trades.push(t);
  }
  trades.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  console.log(`Unconstrained trades: ${trades.length}\n`);

  // ── Table 1: Monthly P&L 2024-01 → 2026-02 ──
  console.log('=== Table 1: Monthly P&L 2024-01 → 2026-02 ===');
  const byMonth: Record<string, { trades: number; wins: number; losses: number; pnl: number }> = {};
  for (const t of trades) {
    const m = t.entryDate.slice(0, 7);
    if (m < '2024-01') continue;
    byMonth[m] ??= { trades: 0, wins: 0, losses: 0, pnl: 0 };
    byMonth[m].trades++;
    byMonth[m].pnl += t.pnl;
    if (t.pnl > 0) byMonth[m].wins++;
    else byMonth[m].losses++;
  }
  console.log('month     trades  wins  losses  winRate    pnl      cumPnl');
  let cumPnl = 0;
  for (const m of Object.keys(byMonth).sort()) {
    const b = byMonth[m];
    const wr = b.trades > 0 ? `${(100 * b.wins / b.trades).toFixed(0)}%` : '-';
    cumPnl += b.pnl;
    console.log(`${m}   ${String(b.trades).padStart(4)}  ${String(b.wins).padStart(4)}  ${String(b.losses).padStart(6)}  ${wr.padStart(6)}   ${b.pnl.toFixed(0).padStart(7)}  ${cumPnl.toFixed(0).padStart(9)}`);
  }
  console.log();

  // ── Table 2: 45-loss streak details ──
  console.log('=== Table 2: Loss Streak 2025-01-23 → ? ===');
  let streakStart = '';
  let curStart = '';
  let curLen = 0;
  let maxLen = 0;
  let maxStartIdx = -1;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (t.pnl < 0) {
      if (curLen === 0) curStart = t.entryDate;
      curLen++;
      if (curLen > maxLen) { maxLen = curLen; maxStartIdx = i - curLen + 1; streakStart = curStart; }
    } else {
      curLen = 0;
    }
  }
  const streakTrades = trades.slice(maxStartIdx, maxStartIdx + maxLen);
  const streakEnd = streakTrades[streakTrades.length - 1]?.entryDate ?? '?';
  const streakPnl = streakTrades.reduce((s, t) => s + t.pnl, 0);
  const streakExits: Record<string, number> = {};
  const streakTickers: Record<string, number> = {};
  for (const t of streakTrades) {
    streakExits[t.exitType] = (streakExits[t.exitType] ?? 0) + 1;
    streakTickers[t.ticker] = (streakTickers[t.ticker] ?? 0) + 1;
  }
  console.log(`streak start:   ${streakStart}`);
  console.log(`streak end:     ${streakEnd} (last consecutive loss)`);
  console.log(`trades in streak: ${maxLen}`);
  console.log(`total P&L:       $${streakPnl.toFixed(0)}`);
  console.log(`exit mix:        ${Object.entries(streakExits).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`tickers hit:`);
  for (const [t, n] of Object.entries(streakTickers).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${t.padEnd(6)} ${n} trades`);
  }
  console.log();

  // ── Table 3: Per-ticker 2024 vs 2025+ split ──
  console.log('=== Table 3: Per-Ticker 2024 vs 2025+ Comparison ===');
  type TStats = { pnl: number; count: number; wins: number };
  const byTickerPeriod: Record<string, { '2024': TStats; '2025+': TStats }> = {};
  for (const t of TICKERS) {
    byTickerPeriod[t] = { '2024': { pnl: 0, count: 0, wins: 0 }, '2025+': { pnl: 0, count: 0, wins: 0 } };
  }
  for (const t of trades) {
    const y = t.entryDate.slice(0, 4);
    if (y === '2024') {
      byTickerPeriod[t.ticker]['2024'].count++;
      byTickerPeriod[t.ticker]['2024'].pnl += t.pnl;
      if (t.pnl > 0) byTickerPeriod[t.ticker]['2024'].wins++;
    } else if (y >= '2025') {
      byTickerPeriod[t.ticker]['2025+'].count++;
      byTickerPeriod[t.ticker]['2025+'].pnl += t.pnl;
      if (t.pnl > 0) byTickerPeriod[t.ticker]['2025+'].wins++;
    }
  }
  console.log('ticker   2024_pnl  2024_trades  2024_wr  |  2025+_pnl  2025+_trades  2025+_wr  |  Δ_wr');
  for (const t of TICKERS) {
    const a = byTickerPeriod[t]['2024'];
    const b = byTickerPeriod[t]['2025+'];
    const wrA = a.count > 0 ? (100 * a.wins / a.count) : 0;
    const wrB = b.count > 0 ? (100 * b.wins / b.count) : 0;
    const dwr = b.count > 0 && a.count > 0 ? wrB - wrA : 0;
    console.log(`${t.padEnd(6)}  ${a.pnl.toFixed(0).padStart(8)}  ${String(a.count).padStart(11)}   ${wrA.toFixed(0).padStart(5)}%  |  ${b.pnl.toFixed(0).padStart(9)}  ${String(b.count).padStart(12)}    ${wrB.toFixed(0).padStart(5)}%  |  ${(dwr >= 0 ? '+' : '') + dwr.toFixed(0)}pp`);
  }
  console.log();

  // ── Table 4: Macro regime at entry dates by period ──
  console.log('=== Table 4: Macro Regime at Entry Dates ===');
  const periods = ['pre-2024', '2024', '2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4', '2026'];
  type RegimeStats = { trades: number; spyAbove: number; contangoSum: number; contangoCount: number; iv30Sum: number; iv30Count: number };
  const byPeriod: Record<string, RegimeStats> = {};
  for (const p of periods) byPeriod[p] = { trades: 0, spyAbove: 0, contangoSum: 0, contangoCount: 0, iv30Sum: 0, iv30Count: 0 };
  for (const t of trades) {
    const p = periodOf(t.entryDate);
    const stats = byPeriod[p];
    if (!stats) continue;
    stats.trades++;
    const spy = spyByDate.get(t.entryDate);
    if (spy && spy.close > spy.ema200) stats.spyAbove++;
    const reg = tickerRegime.get(t.ticker);
    if (reg) {
      const idx = reg.dateToIdx.get(t.entryDate);
      if (idx !== undefined) {
        const cp = reg.contangoPct[idx];
        if (cp !== undefined) { stats.contangoSum += cp; stats.contangoCount++; }
        const iv = reg.iv30[idx];
        if (iv != null) { stats.iv30Sum += iv; stats.iv30Count++; }
      }
    }
  }
  console.log('period     trades  SPY>EMA200%  avg_contangoPct  avg_IV30');
  for (const p of periods) {
    const s = byPeriod[p];
    if (s.trades === 0) continue;
    const spyPct = (100 * s.spyAbove / s.trades).toFixed(0) + '%';
    const avgCont = s.contangoCount > 0 ? (s.contangoSum / s.contangoCount).toFixed(1) : '-';
    const avgIV = s.iv30Count > 0 ? (s.iv30Sum / s.iv30Count).toFixed(3) : '-';
    console.log(`${p.padEnd(10)} ${String(s.trades).padStart(5)}   ${spyPct.padStart(9)}      ${avgCont.padStart(5)}           ${avgIV}`);
  }
  console.log();

  // ── Table 5: Exit-type mix shift ──
  console.log('=== Table 5: Exit Type Shift ===');
  type ExitStats = { total: number; TP: number; SL: number; TIME: number };
  const exitByPeriod: Record<string, ExitStats> = {};
  for (const p of periods) exitByPeriod[p] = { total: 0, TP: 0, SL: 0, TIME: 0 };
  for (const t of trades) {
    const p = periodOf(t.entryDate);
    const s = exitByPeriod[p];
    if (!s) continue;
    s.total++;
    if (t.exitType === 'PROFIT_TARGET') s.TP++;
    else if (t.exitType === 'STOP_LOSS') s.SL++;
    else if (t.exitType === 'TIME_STOP') s.TIME++;
  }
  console.log('period      trades    TP%     SL%     TIME%');
  for (const p of periods) {
    const s = exitByPeriod[p];
    if (s.total === 0) continue;
    const tp = (100 * s.TP / s.total).toFixed(0);
    const sl = (100 * s.SL / s.total).toFixed(0);
    const ts = (100 * s.TIME / s.total).toFixed(0);
    console.log(`${p.padEnd(10)}  ${String(s.total).padStart(5)}   ${tp.padStart(4)}%   ${sl.padStart(4)}%   ${ts.padStart(4)}%`);
  }

  // ── Table 6 (bonus): Signal count by period (is the filter firing differently?) ──
  console.log('\n=== Table 6: Signal vs Trade Count by Period ===');
  const sigByPeriod: Record<string, number> = {};
  for (const p of periods) sigByPeriod[p] = 0;
  for (const s of allSignals) {
    const p = periodOf(s.date);
    if (sigByPeriod[p] !== undefined) sigByPeriod[p]++;
  }
  console.log('period      signals  trades  trades/signal');
  for (const p of periods) {
    const sigs = sigByPeriod[p];
    const tr = exitByPeriod[p]?.total ?? 0;
    if (sigs === 0) continue;
    const ratio = sigs > 0 ? (100 * tr / sigs).toFixed(0) : '-';
    console.log(`${p.padEnd(10)}   ${String(sigs).padStart(5)}   ${String(tr).padStart(5)}   ${ratio.padStart(4)}%`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
