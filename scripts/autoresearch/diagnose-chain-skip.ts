/**
 * Chain-Skip Diagnostic for h4-ts105
 *
 * Purpose: determine WHY ~95% of h4-ts105 signals don't become trades. Breaks
 * down the skip reasons (no entry chain, no strike at target delta, bad mid,
 * etc.) by ticker and year, so we can tell whether the selection is systematic
 * (e.g., always missing on earnings days) or statistical (missing at random).
 *
 * Run: npx tsx scripts/autoresearch/diagnose-chain-skip.ts
 *
 * Reads the current scripts/autoresearch/strategy.ts and the local data cache.
 * Does NOT modify leaderboard or any state.
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
} from '../../src/lib/backtest/chain-cache';
import type {
  StrategyDefinition, TickerDataBundle, RegimeData, EntrySignal, MarketContext,
} from './types';

// ── Reuse data loading logic from runner.ts (simplified to local cache only) ──

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
  if (!fs.existsSync(cachePath)) {
    throw new Error(`Local cache missing: ${cachePath}. Run: npx tsx scripts/autoresearch/prefetch-data.ts`);
  }
  return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as LocalCache;
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
  const vrpSeries: (number | undefined)[] = [];
  for (const c of candles) {
    const iv = ivByDate.get(c.date);
    if (iv && iv.iv30 != null && Number.isFinite(iv.iv30) && iv.iv30 > 0) {
      contangoSeries.push(iv.iv60 != null && Number.isFinite(iv.iv60) ? (iv.iv60 / iv.iv30) - 1 : undefined);
      vrpSeries.push(iv.hv20 != null && Number.isFinite(iv.hv20) ? (iv.iv30 * iv.iv30) - (iv.hv20 * iv.hv20) : undefined);
    } else {
      contangoSeries.push(undefined);
      vrpSeries.push(undefined);
    }
  }
  const contangoPctSeries = computeRollingPercentile(contangoSeries);
  const vrpPctSeries = computeRollingPercentile(vrpSeries);
  const regimeByDate = new Map<string, RegimeData>();
  for (let i = 0; i < candles.length; i++) {
    regimeByDate.set(candles[i].date, {
      contango: contangoSeries[i],
      vrp: vrpSeries[i],
      contangoPct: contangoPctSeries[i],
      vrpPct: vrpPctSeries[i],
    });
  }
  return { ticker, candles, ivRanks, dateToIdx, emas, regimeByDate };
}

function buildMarketContext(cache: LocalCache): MarketContext {
  if (!cache.tickers['SPY']) throw new Error('SPY missing from data cache');
  const spyCandles = cache.tickers['SPY'].candles;
  const closes = spyCandles.map(c => c.close);
  const ema200 = computeEMASeries(closes, 200);
  const spyByDate = new Map<string, { close: number; ema200: number }>();
  for (let i = 0; i < spyCandles.length; i++) {
    spyByDate.set(spyCandles[i].date, { close: closes[i], ema200: ema200[i] });
  }
  return { spyByDate };
}

// ── Strategy import (tsx handles .ts directly — no bundle needed) ──

async function loadStrategy(): Promise<StrategyDefinition> {
  const mod = await import('./strategy');
  return (mod as any).strategy || (mod as any).default;
}

// ── Main diagnostic ──

async function main() {
  console.log('=== h4-ts105 Chain-Skip Diagnostic ===\n');

  const cache = loadLocalCache();
  const strategy = await loadStrategy();
  console.log(`Strategy: ${strategy.name}`);
  console.log(`Tickers: ${strategy.tickers.join(', ')}\n`);

  initDB();

  const market = buildMarketContext(cache);
  const tickerData = new Map<string, TickerDataBundle>();
  for (const t of strategy.tickers) tickerData.set(t, loadTickerData(t, cache));

  // Generate signals (same path as production)
  const allSignals: EntrySignal[] = [];
  for (const [, data] of tickerData) {
    allSignals.push(...strategy.generateSignals(data, market));
  }
  console.log(`Total signals generated: ${allSignals.length}\n`);

  // Use base config (champion delta / DTE range)
  const baseConfig = strategy.buildConfig(strategy.tickers[0], 'CALL');
  const [deltaLow, deltaHigh] = baseConfig.leapDeltaRange;
  const targetDelta = (deltaLow + deltaHigh) / 2;
  const dteRange = baseConfig.leapDTERange;
  console.log(`Config: mode=${baseConfig.mode}, deltaRange=[${deltaLow},${deltaHigh}] (target=${targetDelta}), DTE=[${dteRange[0]},${dteRange[1]}]\n`);

  // Categorize each signal by entry fate
  type SkipReason = 'OK_ENTERED' | 'NO_ENTRY_CHAIN' | 'NO_STRIKE_AT_DELTA' | 'STRIKE_BAD_MID';
  const reasons: Record<SkipReason, number> = {
    OK_ENTERED: 0, NO_ENTRY_CHAIN: 0, NO_STRIKE_AT_DELTA: 0, STRIKE_BAD_MID: 0,
  };
  const byTicker: Record<string, Record<SkipReason, number>> = {};
  const byYear: Record<string, Record<SkipReason, number>> = {};
  const skipDatesSample: Array<{ ticker: string; date: string; reason: SkipReason }> = [];

  for (const signal of allSignals) {
    const chain = getCachedChain(signal.ticker, signal.date);
    let reason: SkipReason;
    if (chain.length === 0) {
      reason = 'NO_ENTRY_CHAIN';
    } else {
      const optionType = signal.direction === 'CALL' ? 'Call' : 'Put';
      const strike = findStrikeByDelta(chain, targetDelta, optionType, dteRange);
      if (!strike) {
        reason = 'NO_STRIKE_AT_DELTA';
      } else if (strike.mid <= 0) {
        reason = 'STRIKE_BAD_MID';
      } else {
        reason = 'OK_ENTERED';
      }
    }
    reasons[reason]++;
    byTicker[signal.ticker] ??= { OK_ENTERED: 0, NO_ENTRY_CHAIN: 0, NO_STRIKE_AT_DELTA: 0, STRIKE_BAD_MID: 0 };
    byTicker[signal.ticker][reason]++;
    const year = signal.date.slice(0, 4);
    byYear[year] ??= { OK_ENTERED: 0, NO_ENTRY_CHAIN: 0, NO_STRIKE_AT_DELTA: 0, STRIKE_BAD_MID: 0 };
    byYear[year][reason]++;
    if (reason !== 'OK_ENTERED' && skipDatesSample.length < 20) {
      skipDatesSample.push({ ticker: signal.ticker, date: signal.date, reason });
    }
  }

  const total = allSignals.length;
  const pct = (n: number) => (total > 0 ? (100 * n / total).toFixed(1) + '%' : 'n/a');

  console.log('=== Overall Skip Breakdown ===');
  console.log(`OK_ENTERED          : ${reasons.OK_ENTERED.toString().padStart(5)} (${pct(reasons.OK_ENTERED)})`);
  console.log(`NO_ENTRY_CHAIN      : ${reasons.NO_ENTRY_CHAIN.toString().padStart(5)} (${pct(reasons.NO_ENTRY_CHAIN)})`);
  console.log(`NO_STRIKE_AT_DELTA  : ${reasons.NO_STRIKE_AT_DELTA.toString().padStart(5)} (${pct(reasons.NO_STRIKE_AT_DELTA)})`);
  console.log(`STRIKE_BAD_MID      : ${reasons.STRIKE_BAD_MID.toString().padStart(5)} (${pct(reasons.STRIKE_BAD_MID)})`);
  console.log();

  console.log('=== By Ticker ===');
  console.log('ticker   total    OK    NoChain  NoStrike  BadMid  OK%');
  const sortedTickers = Object.keys(byTicker).sort();
  for (const t of sortedTickers) {
    const b = byTicker[t];
    const tot = b.OK_ENTERED + b.NO_ENTRY_CHAIN + b.NO_STRIKE_AT_DELTA + b.STRIKE_BAD_MID;
    const okPct = tot > 0 ? (100 * b.OK_ENTERED / tot).toFixed(0) + '%' : '-';
    console.log(
      `${t.padEnd(8)} ${tot.toString().padStart(5)}  ${b.OK_ENTERED.toString().padStart(4)}  ${b.NO_ENTRY_CHAIN.toString().padStart(7)}   ${b.NO_STRIKE_AT_DELTA.toString().padStart(7)}  ${b.STRIKE_BAD_MID.toString().padStart(5)}  ${okPct.padStart(4)}`,
    );
  }
  console.log();

  console.log('=== By Year ===');
  console.log('year   total    OK    NoChain  NoStrike  BadMid  OK%');
  const sortedYears = Object.keys(byYear).sort();
  for (const y of sortedYears) {
    const b = byYear[y];
    const tot = b.OK_ENTERED + b.NO_ENTRY_CHAIN + b.NO_STRIKE_AT_DELTA + b.STRIKE_BAD_MID;
    const okPct = tot > 0 ? (100 * b.OK_ENTERED / tot).toFixed(0) + '%' : '-';
    console.log(
      `${y.padEnd(6)} ${tot.toString().padStart(5)}  ${b.OK_ENTERED.toString().padStart(4)}  ${b.NO_ENTRY_CHAIN.toString().padStart(7)}   ${b.NO_STRIKE_AT_DELTA.toString().padStart(7)}  ${b.STRIKE_BAD_MID.toString().padStart(5)}  ${okPct.padStart(4)}`,
    );
  }
  console.log();

  console.log('=== Sample Skipped Signals (first 20) ===');
  for (const s of skipDatesSample) {
    console.log(`  ${s.ticker.padEnd(6)} ${s.date}  ${s.reason}`);
  }
  console.log();

  // Output JSON for further analysis
  const outPath = path.resolve(__dirname, 'chain-skip-diagnostic.json');
  fs.writeFileSync(outPath, JSON.stringify({
    strategyName: strategy.name,
    totalSignals: total,
    reasons,
    byTicker,
    byYear,
    config: { targetDelta, dteRange, deltaRange: [deltaLow, deltaHigh] },
    generatedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`Detailed JSON written to: ${outPath}`);
}

main().catch(err => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
