/**
 * h4-ts105 Per-Ticker Contribution Diagnostic
 *
 * Question: of the champion's 141 OOS trades, how many come from each ticker?
 * Specifically: does GLD (listed as decorrelator) actually trade, or does the
 * 89% chain-miss rate + slot competition squeeze it out?
 *
 * Approach: hardcode the h4-ts105 signal generator (single MA-touch + SPY>EMA200
 * + EMA55 gate + contango<50, delta [0.53,0.65]). For each generated signal,
 * simulate the LEAP evaluator (entry + daily monitoring for TP/SL/time-stop/
 * expiration). Report trades-by-ticker (upper bound, ignoring portfolio slot
 * competition — which can only REDUCE per-ticker counts).
 *
 * Run: npx tsx scripts/autoresearch/diagnose-h4-ts105-contribution.ts
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
import {
  initDB,
  getCachedChain,
  findStrikeByDelta,
  findContractDirect,
} from '../../src/lib/backtest/chain-cache';
import type {
  TickerDataBundle, RegimeData, EntrySignal, MarketContext,
} from './types';

// ── h4-ts105 CHAMPION CONFIG (from leaderboard attempt #266) ──
const H4_TS105_TICKERS = [
  'GLD', 'IWM',
  'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META',
  'JPM', 'GS',
  'COST', 'UNH',
  'NFLX', 'NVDA', 'TSLA',
];
const H4_TS105_CONFIG = {
  leapDeltaRange: [0.53, 0.65] as [number, number],
  leapDTERange: [180, 270] as [number, number],
  leapProfitTarget: 0.25,
  leapStopLoss: 0.30,
  leapTimeStopDTE: 105,
};

// ── Data loading (same as diagnose-chain-skip.ts — simplified to cache only) ──

interface LocalCache {
  generated: string;
  dataStart: string;
  dataEnd: string;
  spy: { dates: string[]; dailyReturns: number[] };
  tickers: Record<string, {
    candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    iv: Array<{ date: string; iv30: number | null; iv60: number | null; hv20: number | null }>;
  }>;
}

function loadLocalCache(): LocalCache {
  const cachePath = path.resolve(__dirname, 'data-cache.json');
  if (!fs.existsSync(cachePath)) throw new Error(`Missing ${cachePath}`);
  return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
}

function computeEMASeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(0);
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function computeRollingPercentile(series: (number | undefined)[], lookback = 252): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v == null) { out.push(undefined); continue; }
    const start = Math.max(0, i - lookback + 1);
    const window = series.slice(start, i + 1).filter((x): x is number => x != null);
    if (window.length < 30) { out.push(undefined); continue; }
    const rank = window.filter(x => x <= v).length / window.length;
    out.push(rank * 100);
  }
  return out;
}

function loadTickerData(ticker: string, cache: LocalCache): TickerDataBundle {
  const cached = cache.tickers[ticker];
  if (!cached) throw new Error(`No cache for ${ticker}`);
  const candles: BacktestCandle[] = cached.candles.map((r) => ({
    date: r.date, timestamp: new Date(r.date).getTime(),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
  const ivByDate = new Map<string, { iv30: number | null; iv60: number | null; hv20: number | null }>();
  for (const r of cached.iv) ivByDate.set(r.date, { iv30: r.iv30, iv60: r.iv60, hv20: r.hv20 });
  const ivSeries = candles.map(c => ivByDate.get(c.date)?.iv30 ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));
  const closes = candles.map(c => c.close);
  const emas = new Map<number, number[]>();
  for (const p of [8, 13, 21, 34, 55, 200]) emas.set(p, computeEMASeries(closes, p));
  const contangoSeries: (number | undefined)[] = [];
  for (const c of candles) {
    const iv = ivByDate.get(c.date);
    if (iv && iv.iv30 != null && Number.isFinite(iv.iv30) && iv.iv30 > 0) {
      contangoSeries.push(iv.iv60 != null && Number.isFinite(iv.iv60) ? (iv.iv60 / iv.iv30) - 1 : undefined);
    } else {
      contangoSeries.push(undefined);
    }
  }
  const contangoPctSeries = computeRollingPercentile(contangoSeries);
  const regimeByDate = new Map<string, RegimeData>();
  for (let i = 0; i < candles.length; i++) {
    regimeByDate.set(candles[i].date, {
      contango: contangoSeries[i],
      vrp: undefined,
      contangoPct: contangoPctSeries[i],
      vrpPct: undefined,
    });
  }
  return { ticker, candles, ivRanks, dateToIdx, emas, regimeByDate };
}

function buildMarketContext(cache: LocalCache): MarketContext {
  const spyCandles = cache.tickers['SPY'].candles;
  const closes = spyCandles.map(c => c.close);
  const ema200 = computeEMASeries(closes, 200);
  const spyByDate = new Map<string, { close: number; ema200: number }>();
  for (let i = 0; i < spyCandles.length; i++) {
    spyByDate.set(spyCandles[i].date, { close: closes[i], ema200: ema200[i] });
  }
  return { spyByDate };
}

// ── h4-ts105 signal generator (hardcoded reconstruction) ──

function generateH4Ts105Signals(data: TickerDataBundle, market: MarketContext): EntrySignal[] {
  const signals: EntrySignal[] = [];
  const ema8  = data.emas.get(8)!;
  const ema13 = data.emas.get(13)!;
  const ema34 = data.emas.get(34)!;
  const ema55 = data.emas.get(55)!;

  for (let i = 60; i < data.candles.length; i++) {
    const c = data.candles[i];
    if (ema8[i] <= 0 || ema13[i] <= 0 || ema34[i] <= 0 || ema34[i - 5] <= 0 || ema55[i] <= 0) continue;
    if (c.close <= ema55[i]) continue;
    const spy = market.spyByDate.get(c.date);
    if (!spy || !spy.ema200 || spy.ema200 <= 0 || spy.close <= spy.ema200) continue;
    const maRising = ema34[i] > ema34[i - 5];
    if (ema8[i] > ema13[i] && maRising) {
      const pctAboveMA = (c.close - ema34[i]) / ema34[i];
      if (pctAboveMA >= 0 && pctAboveMA < 0.05) {
        const regime = data.regimeByDate.get(c.date);
        if (!regime || regime.contangoPct === undefined || regime.contangoPct < 50) {
          signals.push({ ticker: data.ticker, date: c.date, direction: 'CALL', score: 55 });
        }
      }
    }
  }
  return signals;
}

// ── Simplified LEAP evaluator (mirrors worker.ts:277 logic for trade outcome) ──

type SimExitType = 'PROFIT_TARGET' | 'STOP_LOSS' | 'TIME_STOP' | 'EXPIRATION' | 'NO_ENTRY' | 'NO_CHAIN_FORCE';

interface SimTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  exitType: SimExitType;
  entryPrice: number;
  exitPrice: number;
  holdDays: number;
}

function simulateLeapTrade(
  signal: EntrySignal,
  allDates: string[],
  allTradingDateSet: Set<string>,
): SimTrade | null {
  const chain = getCachedChain(signal.ticker, signal.date);
  if (chain.length === 0) return { ticker: signal.ticker, entryDate: signal.date, exitDate: signal.date, exitType: 'NO_ENTRY', entryPrice: 0, exitPrice: 0, holdDays: 0 };
  const optionType = signal.direction === 'CALL' ? 'Call' : 'Put';
  const targetDelta = (H4_TS105_CONFIG.leapDeltaRange[0] + H4_TS105_CONFIG.leapDeltaRange[1]) / 2;
  const entry = findStrikeByDelta(chain, targetDelta, optionType, H4_TS105_CONFIG.leapDTERange);
  if (!entry || entry.mid <= 0) return { ticker: signal.ticker, entryDate: signal.date, exitDate: signal.date, exitType: 'NO_ENTRY', entryPrice: 0, exitPrice: 0, holdDays: 0 };

  const halfSpread = (entry.ask > 0 && entry.bid > 0) ? (entry.ask - entry.bid) / 2 : entry.mid * 0.01;
  const entryPrice = entry.mid + halfSpread;
  const tpPrice = entryPrice * (1 + H4_TS105_CONFIG.leapProfitTarget);
  const slPrice = entryPrice * (1 - H4_TS105_CONFIG.leapStopLoss);

  // Monitor daily until TP/SL/time-stop/expiration
  const startIdx = allDates.indexOf(signal.date);
  if (startIdx < 0) return null;

  let missingStreak = 0;
  for (let i = startIdx + 1; i < allDates.length; i++) {
    const checkDate = allDates[i];
    if (checkDate > entry.row.expir_date) break;  // expired

    const current = findContractDirect(signal.ticker, checkDate, entry.row.strike, entry.row.expir_date, optionType);
    if (!current || current.mid <= 0) {
      missingStreak++;
      if (missingStreak >= 3) {
        return { ticker: signal.ticker, entryDate: signal.date, exitDate: checkDate, exitType: 'NO_CHAIN_FORCE', entryPrice, exitPrice: entryPrice, holdDays: i - startIdx };
      }
      continue;
    }
    missingStreak = 0;

    const currentDTE = current.row.dte;
    const halfSpreadExit = (current.ask > 0 && current.bid > 0) ? (current.ask - current.bid) / 2 : current.mid * 0.01;
    const exitMid = current.mid - halfSpreadExit;

    if (exitMid >= tpPrice) {
      return { ticker: signal.ticker, entryDate: signal.date, exitDate: checkDate, exitType: 'PROFIT_TARGET', entryPrice, exitPrice: exitMid, holdDays: i - startIdx };
    }
    if (exitMid <= slPrice) {
      return { ticker: signal.ticker, entryDate: signal.date, exitDate: checkDate, exitType: 'STOP_LOSS', entryPrice, exitPrice: exitMid, holdDays: i - startIdx };
    }
    if (currentDTE <= H4_TS105_CONFIG.leapTimeStopDTE) {
      return { ticker: signal.ticker, entryDate: signal.date, exitDate: checkDate, exitType: 'TIME_STOP', entryPrice, exitPrice: exitMid, holdDays: i - startIdx };
    }
  }

  // Expiration: intrinsic
  const finalChain = getCachedChain(signal.ticker, allDates[Math.min(allDates.length - 1, allDates.indexOf(entry.row.expir_date))]);
  return {
    ticker: signal.ticker,
    entryDate: signal.date,
    exitDate: entry.row.expir_date,
    exitType: 'EXPIRATION',
    entryPrice,
    exitPrice: 0,
    holdDays: allDates.indexOf(entry.row.expir_date) - startIdx,
  };
}

// ── Main ──

async function main() {
  console.log('=== h4-ts105 Per-Ticker Contribution Diagnostic ===\n');

  const cache = loadLocalCache();
  initDB();
  const market = buildMarketContext(cache);
  const tickerData = new Map<string, TickerDataBundle>();
  for (const t of H4_TS105_TICKERS) tickerData.set(t, loadTickerData(t, cache));

  // Union of trading dates
  const allDatesSet = new Set<string>();
  for (const data of tickerData.values()) for (const c of data.candles) allDatesSet.add(c.date);
  const allDates = [...allDatesSet].sort();

  // Generate h4-ts105 signals
  const allSignals: EntrySignal[] = [];
  for (const [, data] of tickerData) allSignals.push(...generateH4Ts105Signals(data, market));
  console.log(`Total h4-ts105 signals generated: ${allSignals.length}`);
  console.log(`(Expected: ~3,587 per leaderboard entry for h4-ts105)\n`);

  // Simulate every signal as a trade (upper-bound — ignores portfolio slot competition)
  const trades: SimTrade[] = [];
  for (const signal of allSignals) {
    const trade = simulateLeapTrade(signal, allDates, allDatesSet);
    if (trade) trades.push(trade);
  }

  // Per-ticker breakdown
  type TickerStats = {
    signals: number;
    noEntry: number;
    noChainForce: number;
    tp: number;
    sl: number;
    timeStop: number;
    expiration: number;
    actualTrades: number;  // anything except NO_ENTRY (= upper bound on trade contribution)
    netPnl: number;
  };
  const byTicker: Record<string, TickerStats> = {};
  for (const t of H4_TS105_TICKERS) byTicker[t] = {
    signals: 0, noEntry: 0, noChainForce: 0, tp: 0, sl: 0, timeStop: 0, expiration: 0, actualTrades: 0, netPnl: 0,
  };
  for (const signal of allSignals) byTicker[signal.ticker].signals++;
  for (const trade of trades) {
    const s = byTicker[trade.ticker];
    if (trade.exitType === 'NO_ENTRY') { s.noEntry++; continue; }
    s.actualTrades++;
    const pnl = (trade.exitPrice - trade.entryPrice) * 100;  // per-contract $
    s.netPnl += pnl;
    if (trade.exitType === 'NO_CHAIN_FORCE') s.noChainForce++;
    else if (trade.exitType === 'PROFIT_TARGET') s.tp++;
    else if (trade.exitType === 'STOP_LOSS') s.sl++;
    else if (trade.exitType === 'TIME_STOP') s.timeStop++;
    else if (trade.exitType === 'EXPIRATION') s.expiration++;
  }

  console.log('=== Per-Ticker Contribution (upper bound — no slot competition) ===');
  console.log('ticker   sigs  noEntry  trades   TP    SL    TS   EXP  NoChain  netPnl$');
  const sorted = H4_TS105_TICKERS.sort((a, b) => byTicker[b].actualTrades - byTicker[a].actualTrades);
  let totalTrades = 0, totalSignals = 0, totalPnl = 0;
  for (const t of sorted) {
    const s = byTicker[t];
    totalTrades += s.actualTrades;
    totalSignals += s.signals;
    totalPnl += s.netPnl;
    console.log(
      `${t.padEnd(7)} ${s.signals.toString().padStart(4)}  ${s.noEntry.toString().padStart(6)}  ${s.actualTrades.toString().padStart(6)}  ${s.tp.toString().padStart(3)}  ${s.sl.toString().padStart(3)}  ${s.timeStop.toString().padStart(3)}  ${s.expiration.toString().padStart(3)}  ${s.noChainForce.toString().padStart(6)}  ${s.netPnl.toFixed(0).padStart(8)}`,
    );
  }
  console.log(`${'TOTAL'.padEnd(7)} ${totalSignals.toString().padStart(4)}  ${''.padStart(6)}  ${totalTrades.toString().padStart(6)}`);
  console.log();

  // Decorrelation implication
  console.log('=== Implication for "GLD diversifier" claim ===');
  const gld = byTicker['GLD'];
  const gldShare = totalTrades > 0 ? (gld.actualTrades / totalTrades * 100).toFixed(1) : 'n/a';
  console.log(`GLD signals: ${gld.signals}, no-entry: ${gld.noEntry}, actual trades: ${gld.actualTrades} (${gldShare}% of all)`);
  console.log(`  → Champion claims corr=0.179 with DTE5. If GLD trades are <5% of total, decorrelation isn't from GLD.`);
  console.log();

  // Concentration
  console.log('=== Trade concentration (top 3 tickers) ===');
  const topSorted = [...sorted].sort((a, b) => byTicker[b].actualTrades - byTicker[a].actualTrades);
  const top3 = topSorted.slice(0, 3);
  const top3Trades = top3.reduce((s, t) => s + byTicker[t].actualTrades, 0);
  console.log(`Top 3: ${top3.join(', ')} → ${top3Trades} trades (${(100 * top3Trades / totalTrades).toFixed(1)}% of total)`);
  console.log();

  // Write JSON
  const outPath = path.resolve(__dirname, 'h4-ts105-contribution.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalSignals, totalTrades, totalPnl,
    byTicker,
  }, null, 2));
  console.log(`Detailed JSON: ${outPath}`);
}

main().catch(err => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
