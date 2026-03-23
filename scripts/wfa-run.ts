/**
 * Walk-Forward Analysis Runner (Swing)
 *
 * @deprecated Use `scripts/wfa-run-unified.ts --profile swing` instead.
 *
 * Runs the full WFA engine on cached option chain data with
 * configurable sweep dimensions. Uses sync cache-only evaluator
 * (no ORATS API calls — requires pre-populated chain cache).
 *
 * Usage:
 *   npx tsx scripts/wfa-run.ts
 *   npx tsx scripts/wfa-run.ts --mode anchored
 *   npx tsx scripts/wfa-run.ts --ticker SPY
 *   npx tsx scripts/wfa-run.ts --train 504 --step 126 --purge 65
 *   npx tsx scripts/wfa-run.ts --fill bidask     # realistic fills (default: mid)
 *   npx tsx scripts/wfa-run.ts --workers 8       # train-eval worker threads
 *   npx tsx scripts/wfa-run.ts --regime-study    # runs baseline vs regime-gated arms
 *   npx tsx scripts/wfa-run.ts --regime-study --regime-arm baseline
 *   npx tsx scripts/wfa-run.ts --regime-study --regime-out wfa-regime-study.json
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Worker } from 'node:worker_threads';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env ────────────────────────────────────────────

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
import { SIGNAL_PRESETS, DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import type { TechScoreOptions } from '../src/lib/tech-analysis';
import { precomputeSignals } from '../src/lib/backtest/engine';
import {
  initDB, closeDB, getCacheStats,
  getCachedChain, findSpreadStrikes, findContractDirect,
} from '../src/lib/backtest/chain-cache';
import type { SpreadMatch } from '../src/lib/backtest/chain-cache';
import {
  DEFAULT_CREDIT_CONFIG,
  computeOptionAnalytics,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionExitType,
  type SignalPresetKey,
} from '../src/lib/backtest/option-sim';
import type { FillMode } from '../src/lib/backtest/types';
import { applyFill, applySpreadFill } from '../src/lib/backtest/slippage';
import {
  buildConfiguredSignalsForWindow,
  buildWFAWindows,
  computePortfolioDailyMetrics,
  evaluateConfiguredSignalsWithConstraints,
  runWFAOptions,
  selectConfigsForOOS,
  type PortfolioExecutionConfig,
  type TradeEvaluator, type WFAResult, type WFAWindow, type WFAOptionsConfig,
} from '../src/lib/backtest/wfa-options';

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const DATA_START = '2017-01-01';   // candle warmup (1yr for tech indicators)
const WFA_START  = '2018-01-01';   // WFA date range start
const WFA_END    = '2026-02-28';   // WFA date range end
const DATA_END   = '2026-02-28';

const ALL_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
  'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
  'META', 'NFLX', 'GOOGL', 'GS',
  // COST removed: only net-losing ticker (-$26,619 over 432 trades, 79.6% WR across full sample)
];

// CLI args
const args = process.argv.slice(2);
function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const SINGLE_TICKER = getArg('--ticker');
const WFA_MODE = (getArg('--mode') || 'rolling') as 'rolling' | 'anchored';
const TRAIN_DAYS = parseInt(getArg('--train') || '504');
const STEP_DAYS = parseInt(getArg('--step') || '126');
const PURGE_DAYS = parseInt(getArg('--purge') || '65');
const MAX_POSITIONS = parseInt(getArg('--max-pos') || '50');
const MAX_PER_TICKER = parseInt(getArg('--max-ticker') || '5');
const STARTING_CAPITAL = parseInt(getArg('--capital') || '100000');
const FILL_MODE = (getArg('--fill') || 'mid') as FillMode;
const NUM_WORKERS = Math.max(1, Math.min(
  parseInt(getArg('--workers') || String(Math.max(1, os.cpus().length - 2))),
  Math.max(1, os.cpus().length),
));
const REGIME_STUDY = args.includes('--regime-study');
const REGIME_OUT = getArg('--regime-out') || 'wfa-regime-study.json';
const REGIME_ARM = getArg('--regime-arm');

const tickers = SINGLE_TICKER ? [SINGLE_TICKER.toUpperCase()] : ALL_TICKERS;

// ── Supabase ────────────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── IV Rank ─────────────────────────────────────────────

function computeIVRank(ivSeries: (number | null)[]): (number | null)[] {
  const WINDOW = 252;
  return ivSeries.map((v, i) => {
    if (i < WINDOW || v == null) return null;
    const w = ivSeries.slice(i - WINDOW, i + 1).filter(x => x != null) as number[];
    if (w.length < 100) return null;
    const min = Math.min(...w), max = Math.max(...w), range = max - min;
    return range > 0 ? ((v - min) / range) * 100 : 50;
  });
}

// ── Candle + Signal Data ────────────────────────────────

interface TickerData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
  regimeByDate: Map<string, {
    vrp?: number;
    contango?: number;
    slope?: number;
    vrpPct?: number;
    contangoPct?: number;
  }>;
}

const candleCache = new Map<string, TickerData>();

async function fetchTickerData(ticker: string): Promise<TickerData> {
  if (candleCache.has(ticker)) return candleCache.get(ticker)!;

  const candles: BacktestCandle[] = (await supabaseGet('stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`
  )).map(r => ({
    date: r.date, timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume,
  }));

  const ivData = await supabaseGet('orats_iv_cache',
    `select=date,iv30d,iv60d,hv30d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`);
  let coresData: { trade_date: string; slope: number | null }[] = [];
  try {
    coresData = await supabaseGet('orats_cores_cache',
      `select=trade_date,slope&ticker=eq.${ticker}&trade_date=gte.${DATA_START}&trade_date=lte.${DATA_END}&order=trade_date.asc&limit=5000`);
  } catch {
    // Optional data source; keep slope undefined when not available.
  }

  const ivByDate = new Map(ivData.map((r: any) => [r.date, Number(r.iv30d)]));
  const regimeByDate = new Map<string, {
    vrp?: number;
    contango?: number;
    slope?: number;
    vrpPct?: number;
    contangoPct?: number;
  }>();
  const slopeByDate = new Map<string, number>();
  const contangoByDate = new Map<string, number>();
  const vrpByDate = new Map<string, number>();
  for (const row of coresData) {
    if (row?.slope != null && Number.isFinite(row.slope)) slopeByDate.set(row.trade_date, Number(row.slope));
  }
  for (const r of ivData as any[]) {
    const iv30 = Number(r.iv30d);
    const iv60 = Number(r.iv60d);
    const hv30 = Number(r.hv30d);
    const contango = Number.isFinite(iv30) && iv30 > 0 && Number.isFinite(iv60)
      ? (iv60 / iv30) - 1
      : undefined;
    const vrp = Number.isFinite(iv30) && Number.isFinite(hv30)
      ? (iv30 * iv30) - (hv30 * hv30)
      : undefined;
    if (contango != null) contangoByDate.set(r.date, contango);
    if (vrp != null) vrpByDate.set(r.date, vrp);
  }
  const orderedDates = candles.map(c => c.date);
  const contangoSeries = orderedDates.map(d => contangoByDate.get(d));
  const vrpSeries = orderedDates.map(d => vrpByDate.get(d));
  const contangoPctSeries = computeRollingPercentile(contangoSeries);
  const vrpPctSeries = computeRollingPercentile(vrpSeries);
  const contangoPctByDate = new Map<string, number>();
  const vrpPctByDate = new Map<string, number>();
  for (let i = 0; i < orderedDates.length; i++) {
    const cPct = contangoPctSeries[i];
    const vPct = vrpPctSeries[i];
    if (cPct != null) contangoPctByDate.set(orderedDates[i], cPct);
    if (vPct != null) vrpPctByDate.set(orderedDates[i], vPct);
  }
  for (const r of ivData as any[]) {
    regimeByDate.set(r.date, {
      vrp: vrpByDate.get(r.date),
      contango: contangoByDate.get(r.date),
      slope: slopeByDate.get(r.date),
      vrpPct: vrpPctByDate.get(r.date),
      contangoPct: contangoPctByDate.get(r.date),
    });
  }
  const ivSeries = candles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRank(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  const data = { ticker, candles, ivRanks, dateToIdx, regimeByDate };
  candleCache.set(ticker, data);
  return data;
}

function generateSignalsForPreset(
  td: TickerData,
  presetKey: SignalPresetKey,
  periodStart: string,
  periodEnd: string,
): EntrySignal[] {
  const techOptions = SIGNAL_PRESETS[presetKey];
  const { signals } = precomputeSignals(td.candles, '1D', techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    if (sig.date < periodStart || sig.date > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 70) continue;
    
    // Phase 6 improvement: ADX >= 10 (relaxed from 15) to capture setups in ranging markets
    if (sig.adx === undefined || sig.adx < 10) continue;

    const idx = td.dateToIdx.get(sig.date);
    const regime = td.regimeByDate.get(sig.date);
    entries.push({
      ticker: td.ticker,
      date: sig.date,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
      vrp: regime?.vrp,
      contango: regime?.contango,
      vrpPct: regime?.vrpPct,
      contangoPct: regime?.contangoPct,
      slope: regime?.slope,
    });
  }

  return entries;
}

// ── Bounded LRU Chain Cache ──────────────────────────────

/**
 * LRU cache for getCachedChain — keeps only the most recent MAX_CACHE entries
 * to prevent OOM while still avoiding repeated SQLite reads for monitoring loops.
 */
const MAX_CACHE = 200;
const _chainMemo = new Map<string, ReturnType<typeof getCachedChain>>();
let _chainHits = 0;
let _chainMisses = 0;

function getCachedChainMemo(ticker: string, date: string): ReturnType<typeof getCachedChain> {
  const key = `${ticker}|${date}`;
  const cached = _chainMemo.get(key);
  if (cached !== undefined) {
    _chainHits++;
    // Move to end (most recently used)
    _chainMemo.delete(key);
    _chainMemo.set(key, cached);
    return cached;
  }
  _chainMisses++;
  const rows = getCachedChain(ticker, date);
  // Evict oldest if full
  if (_chainMemo.size >= MAX_CACHE) {
    const oldest = _chainMemo.keys().next().value;
    if (oldest) _chainMemo.delete(oldest);
  }
  _chainMemo.set(key, rows);
  return rows;
}

// ── Trading Date Index (O(1) lookups) ───────────────────

let _dateIndex: Map<string, number> | null = null;

function buildDateIndex(allDates: string[]) {
  _dateIndex = new Map(allDates.map((d, i) => [d, i]));
}

// ── Sync Credit Spread Evaluator (cache-only) ───────────

function advanceTradingDays(allDates: string[], fromDate: string, n: number): string | null {
  const idx = _dateIndex?.get(fromDate) ?? -1;
  if (idx < 0) {
    // Fallback: find next available date
    for (let i = 0; i < allDates.length; i++) {
      if (allDates[i] > fromDate) {
        return allDates[Math.min(i + n - 1, allDates.length - 1)] ?? null;
      }
    }
    return null;
  }
  const targetIdx = idx + n;
  return targetIdx < allDates.length ? allDates[targetIdx] : null;
}

function getMonitoringDates(
  allDates: string[], entryDate: string, intervalDays: number, maxDate: string,
): string[] {
  const dates: string[] = [];
  let current = entryDate;
  while (true) {
    const next = advanceTradingDays(allDates, current, intervalDays);
    if (!next || next > maxDate) break;
    dates.push(next);
    current = next;
  }
  return dates;
}

function resolveContangoSizeMultiplier(signal: EntrySignal, config: SimConfig): number {
  const low = config.contangoSizeLow;
  const mid = config.contangoSizeMid;
  const high = config.contangoSizeHigh;
  const midTh = config.contangoSizeMidThreshold;
  const highTh = config.contangoSizeHighThreshold;
  const sizingEnabled = [low, mid, high, midTh, highTh].every(v => v != null && Number.isFinite(v));
  if (!sizingEnabled) return 1;

  const lowV = Number(low);
  const midV = Number(mid);
  const highV = Number(high);
  const midThV = Number(midTh);
  const highThV = Number(highTh);
  if (highThV < midThV) return 1;

  const c = signal.contango;
  if (c == null || !Number.isFinite(c)) return midV;
  if (c >= highThV) return highV;
  if (c >= midThV) return midV;
  return lowV;
}

function scaleTradeByMultiplier(trade: OptionTrade, multiplier: number): OptionTrade | null {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
  if (Math.abs(multiplier - 1) < 1e-9) {
    return { ...trade, positionSize: trade.positionSize ?? 1 };
  }
  return {
    ...trade,
    pnl: trade.pnl * multiplier,
    maxProfit: trade.maxProfit != null ? trade.maxProfit * multiplier : trade.maxProfit,
    maxLoss: trade.maxLoss != null ? trade.maxLoss * multiplier : trade.maxLoss,
    entrySlippage: trade.entrySlippage != null ? trade.entrySlippage * multiplier : trade.entrySlippage,
    exitSlippage: trade.exitSlippage != null ? trade.exitSlippage * multiplier : trade.exitSlippage,
    dailyMtM: trade.dailyMtM?.map(m => ({
      ...m,
      unrealizedPnl: m.unrealizedPnl * multiplier,
    })),
    positionSize: (trade.positionSize ?? 1) * multiplier,
  };
}

/**
 * Sync credit spread evaluator using cached chain data only.
 * Mirrors simulateCreditSpread logic but uses getCachedChain (sync SQLite reads).
 */
function makeCachedEvaluator(fillMode: FillMode): TradeEvaluator {
  return (signal, config, allTradingDates, maxDate) => {
    // IV rank filter
    if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) {
      return null;
    }
    if (config.vrpFilter && config.vrpFilter > 0 && (signal.vrp == null || signal.vrp < config.vrpFilter)) {
      return null;
    }
    if (config.contangoFilter && config.contangoFilter > 0 && (signal.contango == null || signal.contango < config.contangoFilter)) {
      return null;
    }
    if (config.vrpPctFilter && config.vrpPctFilter > 0 && (signal.vrpPct == null || signal.vrpPct < config.vrpPctFilter)) {
      return null;
    }
    if (config.contangoPctFilter && config.contangoPctFilter > 0 && (signal.contangoPct == null || signal.contangoPct < config.contangoPctFilter)) {
      return null;
    }
    if (config.slopeFilter && config.slopeFilter > 0 && (signal.slope == null || signal.slope < config.slopeFilter)) {
      return null;
    }
    const sizeMultiplier = resolveContangoSizeMultiplier(signal, config);
    if (sizeMultiplier <= 0) return null;

    // Get cached chain (sync)
    const entryChain = getCachedChainMemo(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    // Credit spread: sell puts in uptrend (CALL signal), sell calls in downtrend (PUT signal)
    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';

    const spread = findSpreadStrikes(
      entryChain, config.creditShortDelta, config.creditSpreadWidth,
      optionType, config.creditDTERange,
    );
    if (!spread || spread.netCredit <= 0) return null;

    // ORATS liquidity & Greeks filters
    if (config.maxBidAskSpreadPct != null && config.maxBidAskSpreadPct !== Infinity) {
      const shortSpreadPct = spread.short.mid > 0.10
        ? (spread.short.ask - spread.short.bid) / spread.short.mid : 0;
      if (shortSpreadPct > config.maxBidAskSpreadPct) return null;
    }
    if (config.minShortOI != null && config.minShortOI! > 0) {
      if (spread.short.oi < config.minShortOI!) return null;
    }
    if (config.maxGammaThetaRatio != null && config.maxGammaThetaRatio !== Infinity) {
      const theta = Math.abs(spread.short.row.theta);
      if (theta > 0.001) {
        if (spread.short.row.gamma / theta > config.maxGammaThetaRatio) return null;
      }
    }
    if (config.maxIVSkew != null && config.maxIVSkew !== Infinity) {
      if (Math.abs(spread.short.iv - spread.long.iv) > config.maxIVSkew) return null;
    }

    // Apply fill model to entry
    let entryCredit: number;
    let entrySlippage = 0;

    if (fillMode === 'bidask' && config.slippage.enabled) {
      const shortFill = applyFill('bidask', spread.short.mid, spread.short.bid,
        spread.short.ask, 'sell', config.slippage, spread.short.oi, spread.short.row.dte);
      const longFill = applyFill('bidask', spread.long.mid, spread.long.bid,
        spread.long.ask, 'buy', config.slippage, spread.long.oi, spread.long.row.dte);
      if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
        const spreadFill = applySpreadFill('bidask', spread.short, spread.long, 'open', config.slippage);
        entryCredit = spreadFill.fillPrice;
        entrySlippage = spreadFill.slippage;
      } else {
        entryCredit = shortFill.fillPrice - longFill.fillPrice;
        entrySlippage = shortFill.slippage + longFill.slippage;
      }
      if (entryCredit <= 0) return null;
    } else {
      entryCredit = spread.netCredit;
    }

    const tpCost = entryCredit * (1 - config.creditProfitTarget);
    const slCost = entryCredit * config.creditStopLossMultiple;

    // Cap monitoring at option expiry or maxDate
    const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;
    const monitorDates = getMonitoringDates(allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd);

    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

    for (const checkDate of monitorDates) {
      const shortLeg = findContractDirect(signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      const longLeg = findContractDirect(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
      if (!shortLeg || !longLeg) continue;

      // Exit pricing
      let currentSpreadCost: number;
      let exitSlippageAmount = 0;
      if (fillMode === 'bidask' && config.slippage.enabled) {
        if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
          const spreadFill = applySpreadFill('bidask', shortLeg, longLeg, 'close', config.slippage);
          currentSpreadCost = spreadFill.fillPrice;
          exitSlippageAmount = spreadFill.slippage;
        } else {
          const shortClose = applyFill('bidask', shortLeg.mid, shortLeg.bid,
            shortLeg.ask, 'buy', config.slippage, shortLeg.oi, shortLeg.row.dte);
          const longClose = applyFill('bidask', longLeg.mid, longLeg.bid,
            longLeg.ask, 'sell', config.slippage, longLeg.oi, longLeg.row.dte);
          currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
          exitSlippageAmount = shortClose.slippage + longClose.slippage;
        }
      } else {
        currentSpreadCost = shortLeg.mid - longLeg.mid;
      }
      const currentDTE = shortLeg.row.dte;

      dailyMtM.push({
        date: checkDate,
        spreadMid: currentSpreadCost,
        unrealizedPnl: (entryCredit - currentSpreadCost) * 100,
      });

      let exitType: OptionExitType | null = null;
      if (currentSpreadCost <= tpCost) exitType = 'PROFIT_TARGET';
      else if (currentSpreadCost >= slCost) exitType = 'STOP_LOSS';
      else if (config.creditDeltaStop != null && isFinite(config.creditDeltaStop) &&
               Math.abs(shortLeg.delta) >= config.creditDeltaStop) exitType = 'DELTA_STOP';
      else if (currentDTE <= config.creditTimeStopDTE) exitType = 'TIME_STOP';

      if (exitType) {
        const trade = buildResult(signal, spread, entryCredit, checkDate, currentSpreadCost,
          currentDTE, shortLeg.row.stock_price, exitType, dailyMtM,
          entrySlippage, exitSlippageAmount, fillMode);
        return scaleTradeByMultiplier(trade, sizeMultiplier);
      }
    }

    // Close at last monitoring date or expiry
    const lastDate = monitorDates[monitorDates.length - 1];
    if (lastDate) {
      const shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      const longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);

      let currentSpreadCost: number;
      if (shortLeg && longLeg) {
        currentSpreadCost = shortLeg.mid - longLeg.mid;
      } else {
        const stockPrice = (shortLeg || longLeg)?.row.stock_price ?? spread.short.row.stock_price;
        const shortIntrinsic = optionType === 'Put'
          ? Math.max(0, spread.short.row.strike - stockPrice)
          : Math.max(0, stockPrice - spread.short.row.strike);
        const longIntrinsic = optionType === 'Put'
          ? Math.max(0, spread.long.row.strike - stockPrice)
          : Math.max(0, stockPrice - spread.long.row.strike);
        currentSpreadCost = shortIntrinsic - longIntrinsic;
      }

      const trade = buildResult(signal, spread, entryCredit, lastDate, currentSpreadCost,
        shortLeg?.row.dte ?? 0, shortLeg?.row.stock_price ?? spread.short.row.stock_price,
        'EXPIRATION', dailyMtM, entrySlippage, 0, fillMode);
      return scaleTradeByMultiplier(trade, sizeMultiplier);
    }

    return null;
  };
}

function buildResult(
  signal: EntrySignal, spread: SpreadMatch, entryCredit: number,
  exitDate: string, exitSpreadCost: number, exitDTE: number,
  exitStockPrice: number, exitType: OptionExitType,
  dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[],
  entrySlippage: number, exitSlippage: number, fillMode: FillMode,
): OptionTrade {
  const pnl = (entryCredit - exitSpreadCost) * 100;
  const pnlPct = spread.maxLoss > 0 ? pnl / (spread.maxLoss * 100) : 0;
  const holdDays = Math.round(
    (new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000,
  );

  return {
    ticker: signal.ticker,
    mode: 'CREDIT_SPREAD',
    direction: signal.direction,
    entryDate: signal.date,
    entrySignalScore: signal.score,
    strike: spread.short.row.strike,
    expiry: spread.short.row.expir_date,
    entryDTE: spread.short.row.dte,
    entryPrice: entryCredit,
    entryDelta: spread.short.delta,
    entryIV: spread.short.iv,
    entryStockPrice: spread.short.row.stock_price,
    longStrike: spread.long.row.strike,
    longEntryPrice: spread.long.mid,
    requestedSpreadWidth: spread.requestedSpreadWidth,
    spreadWidth: spread.spreadWidth,
    maxProfit: entryCredit,
    maxLoss: spread.maxLoss,
    exitDate,
    exitPrice: exitSpreadCost,
    exitDTE,
    exitStockPrice,
    exitType,
    pnl,
    pnlPct,
    holdDays,
    ivRank: signal.ivRank,
    entrySlippage: entrySlippage > 0 ? entrySlippage : undefined,
    exitSlippage: exitSlippage > 0 ? exitSlippage : undefined,
    fillMode,
    dailyMtM,
    positionSize: 1,
  };
}

// ── Sweep Grid ──────────────────────────────────────────

interface RegimeOverrides {
  vrpFilter?: number;
  contangoFilter?: number;
  vrpPctFilter?: number;
  contangoPctFilter?: number;
  slopeFilter?: number;
  contangoSizeLow?: number;
  contangoSizeMid?: number;
  contangoSizeHigh?: number;
  contangoSizeMidThreshold?: number;
  contangoSizeHighThreshold?: number;
}

function buildSweepCandidates(regimeOverrides: RegimeOverrides = {}): SimConfig[] {
  const candidates: SimConfig[] = [];

  const presets: SignalPresetKey[] = ['ema', 'mom', 'em', 'mf', 'vol'];
  const profitTargets = [0.30, 0.50];          // 0.40 validated in prev run (extreme IV only); keep ends
  const spreadWidths = [5, 15];               // 10 never selected; 5 wins low-IV, 15 wins otherwise
  const ivRankMins = [0, 30];                  // 0 = high-IV regime, 30 = structural filter
  const deltaStops = [0.75, 0.80, Infinity];   // 0.65 rejected; test higher thresholds + off
  const timeStopDTEs = [7, 14];               // 7 = current; 14 = earlier exit, smaller avg loss

  for (const preset of presets) {
    for (const tp of profitTargets) {
      for (const width of spreadWidths) {
        for (const ivMin of ivRankMins) {
          for (const dStop of deltaStops) {
            for (const tsdte of timeStopDTEs) {
              candidates.push({
                ...DEFAULT_CREDIT_CONFIG,
                creditProfitTarget: tp,
                creditSpreadWidth: width,
                minIVRank: ivMin,
                creditDeltaStop: isFinite(dStop) ? dStop : undefined,
                creditTimeStopDTE: tsdte,
                creditStopLossMultiple: 100, // no SL (defined risk)
                fillMode: FILL_MODE,
                slippage: FILL_MODE === 'bidask'
                  ? { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true }
                  : { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
                signalWeightPreset: preset,
                vrpFilter: regimeOverrides.vrpFilter,
                contangoFilter: regimeOverrides.contangoFilter,
                vrpPctFilter: regimeOverrides.vrpPctFilter,
                contangoPctFilter: regimeOverrides.contangoPctFilter,
                slopeFilter: regimeOverrides.slopeFilter,
                contangoSizeLow: regimeOverrides.contangoSizeLow,
                contangoSizeMid: regimeOverrides.contangoSizeMid,
                contangoSizeHigh: regimeOverrides.contangoSizeHigh,
                contangoSizeMidThreshold: regimeOverrides.contangoSizeMidThreshold,
                contangoSizeHighThreshold: regimeOverrides.contangoSizeHighThreshold,
              });
            }
          }
        }
      }
    }
  }

  return candidates;
}

// ── Reporting ───────────────────────────────────────────

function formatPct(v: number, decimals = 1): string {
  return v.toFixed(decimals) + '%';
}

function printReport(result: WFAResult) {
  console.log('\n' + '═'.repeat(80));
  console.log('  WALK-FORWARD ANALYSIS RESULTS');
  console.log('═'.repeat(80));

  console.log(`\n  Mode: ${result.config.mode.toUpperCase()}`);
  console.log(`  Period: ${result.config.startDate} → ${result.config.endDate}`);
  console.log(`  Train: ${result.config.trainWindowDays}d | Step: ${result.config.forwardStepDays}d | Purge: ${result.config.purgeGapDays}d`);
  console.log(`  Tickers: ${result.config.tickers.join(', ')}`);
  console.log(`  Capital: $${result.config.startingCapital.toLocaleString()}`);
  console.log(`  Fill mode: ${FILL_MODE}`);
  console.log(`  Elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s`);

  console.log('\n' + '─'.repeat(80));
  console.log('  AGGREGATE OOS METRICS');
  console.log('─'.repeat(80));
  console.log(`  Sharpe:       ${result.oosSharpe.toFixed(2)}`);
  console.log(`  Win Rate:     ${formatPct(result.oosWinRate)}`);
  console.log(`  Max DD:       ${formatPct(result.oosMaxDD)}`);
  console.log(`  Total P&L:    $${result.oosTotalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`  ROC:          ${formatPct(result.oosTotalPnl / result.config.startingCapital * 100)}`);
  console.log(`  WF Efficiency: ${result.wfEfficiency.toFixed(2)}`);
  console.log(`  OOS Trades:   ${result.allOOSTrades.length}`);

  if (result.stressMetrics) {
    const s = result.stressMetrics;
    console.log('\n' + '─'.repeat(80));
    console.log('  CORRELATION STRESS');
    console.log('─'.repeat(80));
    console.log(`  Peak Correlated DD:    ${formatPct(s.peakCorrelatedDD)} (${s.peakCorrelatedDDDate})`);
    console.log(`  Worst Day Loss:        $${s.worstDayLoss.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${s.worstDayLossDate})`);
    console.log(`  Tickers in DD (worst): ${s.tickersInDDOnWorstDay}`);
    console.log(`  Avg Pairwise Corr:     ${s.avgPairwiseCorrelation.toFixed(3)}`);
    console.log(`  Correlation Penalty:   ${s.correlationPenalty.toFixed(4)}`);
  }

  console.log('\n' + '─'.repeat(80));
  console.log('  PER-WINDOW BREAKDOWN');
  console.log('─'.repeat(80));
  console.log(
    '  #  Train Period          OOS Period            Train    OOS     OOS    OOS   Best Config',
  );
  console.log(
    '     Start    → End        Start    → End        Sharpe   Sharpe  WR%    Trd   (preset/tp/w/iv)',
  );
  console.log('  ' + '·'.repeat(78));

  for (const w of result.windows) {
    const cfg = w.bestConfig;
    const dStopStr = cfg.creditDeltaStop != null ? `/d${cfg.creditDeltaStop}` : '';
    const tsStr = cfg.creditTimeStopDTE !== 7 ? `/ts${cfg.creditTimeStopDTE}` : '';
    const configStr = `${cfg.signalWeightPreset ?? 'ema'}/tp${(cfg.creditProfitTarget * 100).toFixed(0)}/w${cfg.creditSpreadWidth}/iv${cfg.minIVRank}${dStopStr}${tsStr}`;
    console.log(
      `  ${String(w.windowIndex).padStart(2)}  ${w.trainStart} → ${w.trainEnd}  ${w.oosStart} → ${w.oosEnd}` +
      `  ${w.bestTrainSharpe.toFixed(2).padStart(6)}  ${w.oosSharpe.toFixed(2).padStart(6)}` +
      `  ${formatPct(w.oosWinRate).padStart(5)}  ${String(w.oosTrades.length).padStart(4)}   ${configStr}`,
    );
  }

  // Exit type breakdown
  const byExit: Record<string, number> = {};
  for (const t of result.allOOSTrades) {
    byExit[t.exitType] = (byExit[t.exitType] ?? 0) + 1;
  }
  console.log('\n' + '─'.repeat(80));
  console.log('  EXIT TYPE BREAKDOWN');
  console.log('─'.repeat(80));
  for (const [type, count] of Object.entries(byExit).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(20)} ${count} (${formatPct(count / result.allOOSTrades.length * 100)})`);
  }

  // Equity curve summary
  if (result.oosEquityCurve.length > 0) {
    const first = result.oosEquityCurve[0];
    const last = result.oosEquityCurve[result.oosEquityCurve.length - 1];
    console.log('\n' + '─'.repeat(80));
    console.log('  EQUITY CURVE');
    console.log('─'.repeat(80));
    console.log(`  Start: $${result.config.startingCapital.toLocaleString()} (${first.date})`);
    console.log(`  End:   $${last.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${last.date})`);
  }

  console.log('\n' + '═'.repeat(80) + '\n');
}

interface RegimeStudyArm {
  name: string;
  label: string;
  overrides: RegimeOverrides;
}

interface RegimeStudySummary {
  arm: string;
  label: string;
  overrides: RegimeOverrides;
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  wfEfficiency: number;
  trades: number;
  elapsedMs: number;
}

function buildRegimeStudyArms(): RegimeStudyArm[] {
  return [
    { name: 'baseline', label: 'Baseline (no regime gate)', overrides: {} },
    { name: 'contango_3', label: 'Contango >= 3%', overrides: { contangoFilter: 0.03 } },
    { name: 'contango_6', label: 'Contango >= 6%', overrides: { contangoFilter: 0.06 } },
    {
      name: 'contango_pct60',
      label: 'Contango Percentile >= 60',
      overrides: { contangoPctFilter: 60 },
    },
    {
      name: 'contango_pct75',
      label: 'Contango Percentile >= 75',
      overrides: { contangoPctFilter: 75 },
    },
    { name: 'vrp_005', label: 'VRP >= 0.005', overrides: { vrpFilter: 0.005 } },
    { name: 'vrp_010', label: 'VRP >= 0.010', overrides: { vrpFilter: 0.01 } },
    { name: 'vrp_pct60', label: 'VRP Percentile >= 60', overrides: { vrpPctFilter: 60 } },
    { name: 'vrp_pct50', label: 'VRP Percentile >= 50', overrides: { vrpPctFilter: 50 } },
    { name: 'vrp_pct40', label: 'VRP Percentile >= 40', overrides: { vrpPctFilter: 40 } },
    {
      name: 'hybrid_c3_v005',
      label: 'Contango >= 3% + VRP >= 0.005',
      overrides: { contangoFilter: 0.03, vrpFilter: 0.005 },
    },
    {
      name: 'hybrid_c6_v010',
      label: 'Contango >= 6% + VRP >= 0.010',
      overrides: { contangoFilter: 0.06, vrpFilter: 0.01 },
    },
    {
      name: 'size_c3_c6_balanced',
      label: 'Sizing: 0.5/1.0/1.25 by contango (<3%, 3-6%, >=6%)',
      overrides: {
        contangoSizeLow: 0.5,
        contangoSizeMid: 1.0,
        contangoSizeHigh: 1.25,
        contangoSizeMidThreshold: 0.03,
        contangoSizeHighThreshold: 0.06,
      },
    },
    {
      name: 'size_c3_c6_conservative',
      label: 'Sizing: 0.35/0.8/1.1 by contango (<3%, 3-6%, >=6%)',
      overrides: {
        contangoSizeLow: 0.35,
        contangoSizeMid: 0.8,
        contangoSizeHigh: 1.1,
        contangoSizeMidThreshold: 0.03,
        contangoSizeHighThreshold: 0.06,
      },
    },
    {
      name: 'size_c3_c6_derisk',
      label: 'Sizing: 0.2/0.5/0.9 by contango (<3%, 3-6%, >=6%)',
      overrides: {
        contangoSizeLow: 0.2,
        contangoSizeMid: 0.5,
        contangoSizeHigh: 0.9,
        contangoSizeMidThreshold: 0.03,
        contangoSizeHighThreshold: 0.06,
      },
    },
  ];
}

function summarizeRegimeResult(arm: RegimeStudyArm, result: WFAResult): RegimeStudySummary {
  return {
    arm: arm.name,
    label: arm.label,
    overrides: arm.overrides,
    oosSharpe: result.oosSharpe,
    oosWinRate: result.oosWinRate,
    oosMaxDD: result.oosMaxDD,
    oosTotalPnl: result.oosTotalPnl,
    wfEfficiency: result.wfEfficiency,
    trades: result.allOOSTrades.length,
    elapsedMs: result.elapsedMs,
  };
}

function printRegimeStudyTable(rows: RegimeStudySummary[]) {
  if (rows.length === 0) return;
  const baseline = rows.find(r => r.arm === 'baseline') ?? rows[0];
  const ranked = [...rows].sort((a, b) => b.oosSharpe - a.oosSharpe);

  console.log('\n' + '═'.repeat(96));
  console.log('  REGIME STUDY — OOS SUMMARY');
  console.log('═'.repeat(96));
  console.log('  Arm                      Sharpe   ΔSharpe    WFE   MaxDD   Trades      PnL');
  console.log('  ' + '·'.repeat(94));
  for (const r of ranked) {
    const dSharpe = r.oosSharpe - baseline.oosSharpe;
    const dSharpeStr = `${dSharpe >= 0 ? '+' : ''}${dSharpe.toFixed(2)}`;
    const pnlStr = `$${r.oosTotalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    console.log(
      `  ${r.arm.padEnd(22)} ${r.oosSharpe.toFixed(2).padStart(7)} ${dSharpeStr.padStart(9)} ` +
      `${r.wfEfficiency.toFixed(2).padStart(6)} ${formatPct(r.oosMaxDD).padStart(7)} ` +
      `${String(r.trades).padStart(7)} ${pnlStr.padStart(9)}`,
    );
  }
  console.log('═'.repeat(96) + '\n');
}

// ── Parallel Train Eval (worker_threads) ───────────────

interface TrainWorkItem {
  id: number;
  configIdx: number;
  config: SimConfig;
  trainStart: string;
  trainEnd: string;
  nTrials: number;
}

interface TrainWorkResult {
  type: 'result';
  id: number;
  configIdx: number;
  sharpe: number;
  trades: number;
  dsr: number;
  robustScore: number;
  error?: string;
}

async function createTrainWorkerPool(
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  allTradingDates: string[],
  executionConfig: PortfolioExecutionConfig,
): Promise<Worker[]> {
  const workerSrc = path.resolve(__dirname, 'wfa-train-worker.ts');
  const workerBundle = path.resolve(__dirname, '.wfa-train-worker.mjs');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );

  const payload: Record<string, EntrySignal[]> = {};
  for (const [k, v] of signalsByPreset) payload[k] = v;

  const workers = await Promise.all(
    Array.from({ length: NUM_WORKERS }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(workerBundle, {
          workerData: {
            signalsByPreset: payload,
            allTradingDates,
            fillMode: FILL_MODE,
            executionConfig,
          },
        });
        w.once('message', (msg) => {
          if (msg?.type === 'ready') resolve(w);
          else reject(new Error('Worker failed to initialize'));
        });
        w.once('error', reject);
      }),
    ),
  );
  return workers;
}

async function terminateTrainWorkerPool(workers: Worker[]) {
  for (const w of workers) w.postMessage({ type: 'exit' });
  await new Promise(r => setTimeout(r, 100));
  await Promise.all(workers.map(w => w.terminate()));
}

async function runParallelTrainWork(
  workers: Worker[],
  workItems: TrainWorkItem[],
  label: string,
): Promise<TrainWorkResult[]> {
  const results: TrainWorkResult[] = new Array(workItems.length);
  let nextIdx = 0;
  let completed = 0;
  let lastPrinted = 0;
  const printStep = Math.max(1, Math.floor(workItems.length / 20));

  return new Promise((resolve, reject) => {
    const handlers = new Map<Worker, (msg: TrainWorkResult) => void>();
    const errorHandlers = new Map<Worker, (err: Error) => void>();

    const onMessage = (worker: Worker) => (msg: TrainWorkResult) => {
      if (!msg || msg.type !== 'result') return;
      results[msg.id] = msg;
      completed++;
      if (completed === workItems.length || completed - lastPrinted >= printStep) {
        process.stdout.write(`\r  ${label}: ${completed}/${workItems.length} configs...`);
        lastPrinted = completed;
      }
      if (completed === workItems.length) {
        process.stdout.write('\n');
        for (const w of workers) {
          const h = handlers.get(w);
          const eh = errorHandlers.get(w);
          if (h) w.off('message', h);
          if (eh) w.off('error', eh);
        }
        resolve(results);
        return;
      }
      const next = workItems[nextIdx++];
      if (next) worker.postMessage(next);
    };

    const onError = (err: Error) => {
      for (const w of workers) {
        const h = handlers.get(w);
        const eh = errorHandlers.get(w);
        if (h) w.off('message', h);
        if (eh) w.off('error', eh);
      }
      reject(err);
    };

    for (const worker of workers) {
      const h = onMessage(worker);
      const eh = (err: Error) => onError(err);
      handlers.set(worker, h);
      errorHandlers.set(worker, eh);
      worker.on('message', h);
      worker.on('error', eh);
    }

    for (const worker of workers) {
      const next = workItems[nextIdx++];
      if (!next) break;
      worker.postMessage(next);
    }
  });
}

function computeRollingPercentile(values: (number | undefined)[], window = 252): (number | undefined)[] {
  return values.map((v, i) => {
    if (v == null || !Number.isFinite(v)) return undefined;
    const start = Math.max(0, i - window);
    const w = values.slice(start, i + 1).filter((x): x is number => x != null && Number.isFinite(x));
    if (w.length < 60) return undefined;
    const le = w.filter(x => x <= v).length;
    return (le / w.length) * 100;
  });
}

async function runWFAOptionsParallelTrain(
  config: WFAOptionsConfig,
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  allTradingDates: string[],
  sweepCandidates: SimConfig[],
  evaluator: TradeEvaluator,
  workers: Worker[],
  onProgress?: (windowIdx: number, totalWindows: number) => void,
): Promise<WFAResult> {
  const t0 = Date.now();
  const windowMetricsMode = config.windowMetricsMode ?? 'strict';
  const selectionMode = config.selectionMode ?? 'ensemble_top_k';
  const ensembleSize = Math.max(1, config.ensembleSize ?? 3);
  const ensembleMinVotes = Math.max(1, config.ensembleMinVotes ?? 2);
  const windows = buildWFAWindows(allTradingDates, {
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    startDate: config.startDate,
    endDate: config.endDate,
  });

  const executionConfig: PortfolioExecutionConfig = {
    maxPositions: config.maxPositions,
    maxPerTicker: config.maxPerTicker,
    startingCapital: config.startingCapital,
  };

  const allOOSTrades: OptionTrade[] = [];
  const wfaWindows: WFAWindow[] = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    onProgress?.(i, windows.length);

    const trainItems: TrainWorkItem[] = sweepCandidates.map((candidate, idx) => ({
      id: idx,
      configIdx: idx,
      config: candidate,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      nTrials: sweepCandidates.length,
    }));

    const trainResults = await runParallelTrainWork(
      workers,
      trainItems,
      `${i + 1}/${windows.length}`,
    );
    const rankedTrainResults = trainResults
      .filter(r => Number.isFinite(r.sharpe))
      .map(r => ({
        config: sweepCandidates[r.configIdx] ?? sweepCandidates[0],
        sharpe: r.sharpe,
        trades: r.trades,
        dsr: r.dsr,
        robustScore: r.robustScore,
      }))
      .sort((a, b) => b.sharpe - a.sharpe);

    const selectedResults = selectConfigsForOOS(
      rankedTrainResults,
      config.selectionGuard,
      selectionMode,
      ensembleSize,
    );
    const configuredSignals = buildConfiguredSignalsForWindow(
      selectedResults,
      signalsByPreset,
      w.oosStart,
      w.oosEnd,
      selectionMode === 'single' ? 1 : ensembleMinVotes,
    );
    const oosTrades = evaluateConfiguredSignalsWithConstraints(
      configuredSignals,
      executionConfig,
      allTradingDates,
      config.endDate,
      evaluator,
    );
    const oosAnalytics = computeOptionAnalytics(oosTrades);
    const windowMetricsEnd = windowMetricsMode === 'strict' ? w.oosEnd : config.endDate;
    const windowMetrics = computePortfolioDailyMetrics(
      oosTrades,
      allTradingDates,
      w.oosStart,
      windowMetricsEnd,
      config.startingCapital,
    );

    wfaWindows.push({
      windowIndex: i,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      bestConfig: selectedResults[0]?.config ?? rankedTrainResults[0]?.config ?? sweepCandidates[0],
      selectedConfigs: selectedResults.map(r => r.config),
      bestTrainSharpe: selectedResults[0]?.sharpe ?? rankedTrainResults[0]?.sharpe ?? 0,
      oosTrades,
      oosSharpe: windowMetrics.sharpe,
      oosWinRate: oosAnalytics.winRate,
      oosMaxDD: windowMetrics.maxDrawdownPct,
    });
    allOOSTrades.push(...oosTrades);
  }

  const allPortfolioMetrics = computePortfolioDailyMetrics(
    allOOSTrades,
    allTradingDates,
    config.startDate,
    config.endDate,
    config.startingCapital,
  );
  const oosAllAnalytics = computeOptionAnalytics(allOOSTrades);
  const avgTrainSharpe = wfaWindows.length > 0
    ? wfaWindows.reduce((s, w) => s + w.bestTrainSharpe, 0) / wfaWindows.length
    : 0;

  return {
    config,
    windows: wfaWindows,
    allOOSTrades,
    oosEquityCurve: allPortfolioMetrics.equityCurve,
    oosSharpe: allPortfolioMetrics.sharpe,
    oosWinRate: oosAllAnalytics.winRate,
    oosMaxDD: allPortfolioMetrics.maxDrawdownPct,
    oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
    wfEfficiency: avgTrainSharpe >= 0.1 ? allPortfolioMetrics.sharpe / avgTrainSharpe : 0,
    elapsedMs: Date.now() - t0,
  };
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log('WFA Engine — Walk-Forward Analysis for Credit Spreads');
  console.log('─'.repeat(60));

  // 1. Initialize chain cache (workers will open their own connections)
  // Skipped getCacheStats because it takes too long on large tables
  initDB();
  closeDB();
  // 2. Fetch candle data for all tickers
  console.log(`\nFetching candle data for ${tickers.length} tickers...`);
  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of tickers) {
    const td = await fetchTickerData(ticker);
    tickerDataMap.set(ticker, td);
    process.stdout.write(` ${ticker}(${td.candles.length})`);
  }
  console.log(' done.');

  // 3. Build all trading dates (union across tickers)
  const allDatesSet = new Set<string>();
  for (const td of tickerDataMap.values()) {
    for (const c of td.candles) {
      if (c.date >= WFA_START && c.date <= WFA_END) allDatesSet.add(c.date);
    }
  }
  const allTradingDates = [...allDatesSet].sort();
  buildDateIndex(allTradingDates);
  console.log(`Trading dates: ${allTradingDates.length} (${allTradingDates[0]} → ${allTradingDates[allTradingDates.length - 1]})`);

  // 4. Pre-compute signals for each preset across all tickers
  console.log('\nGenerating signals per preset...');
  const signalsByPreset = new Map<SignalPresetKey, EntrySignal[]>();
  const presetKeys: SignalPresetKey[] = ['ema', 'mom', 'em', 'mf', 'vol'];

  for (const preset of presetKeys) {
    const allSignals: EntrySignal[] = [];
    for (const [ticker, td] of tickerDataMap) {
      const entries = generateSignalsForPreset(td, preset, WFA_START, WFA_END);
      allSignals.push(...entries);
    }
    allSignals.sort((a, b) => a.date.localeCompare(b.date));
    signalsByPreset.set(preset, allSignals);
    console.log(`  ${preset}: ${allSignals.length} signals`);
  }

  // 5. Preview windows
  const windowDefs = buildWFAWindows(allTradingDates, {
    trainWindowDays: TRAIN_DAYS,
    forwardStepDays: STEP_DAYS,
    purgeGapDays: PURGE_DAYS,
    mode: WFA_MODE,
    startDate: WFA_START,
    endDate: WFA_END,
  });
  console.log(`\nWFA windows: ${windowDefs.length} (${WFA_MODE})`);
  for (const w of windowDefs) {
    console.log(`  Train ${w.trainStart}→${w.trainEnd} | OOS ${w.oosStart}→${w.oosEnd}`);
  }

  const evaluator = makeCachedEvaluator(FILL_MODE);
  const outDir = path.resolve(__dirname, '../data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const executionConfig: PortfolioExecutionConfig = {
    maxPositions: MAX_POSITIONS,
    maxPerTicker: MAX_PER_TICKER,
    startingCapital: STARTING_CAPITAL,
  };

  let trainWorkers: Worker[] = [];
  if (NUM_WORKERS > 1) {
    console.log(`\nInitializing ${NUM_WORKERS} train workers (${os.cpus().length} CPU cores)...`);
    trainWorkers = await createTrainWorkerPool(signalsByPreset, allTradingDates, executionConfig);
    console.log('Train workers ready.');
  } else {
    console.log('\nTrain workers disabled (`--workers 1`), using single-thread optimizer.');
  }

  try {
    if (REGIME_STUDY) {
      const allArms = buildRegimeStudyArms();
      const arms = REGIME_ARM
        ? allArms.filter(a => a.name === REGIME_ARM)
        : allArms;
      if (REGIME_ARM && arms.length === 0) {
        throw new Error(`Unknown --regime-arm "${REGIME_ARM}". Valid: ${allArms.map(a => a.name).join(', ')}`);
      }
      console.log(`\nRegime study mode: ${arms.length} arms`);
      const summaries: RegimeStudySummary[] = [];
      const armResults: Record<string, {
        summary: RegimeStudySummary;
        windows: {
          windowIndex: number;
          trainStart: string;
          trainEnd: string;
          oosStart: string;
          oosEnd: string;
          bestTrainSharpe: number;
          oosSharpe: number;
          oosWinRate: number;
          oosMaxDD: number;
          tradeCount: number;
          bestConfig: {
            signalWeightPreset?: string;
            creditProfitTarget: number;
            creditSpreadWidth: number;
            minIVRank: number;
            contangoFilter?: number;
            vrpFilter?: number;
            contangoPctFilter?: number;
            vrpPctFilter?: number;
            slopeFilter?: number;
            contangoSizeLow?: number;
            contangoSizeMid?: number;
            contangoSizeHigh?: number;
            contangoSizeMidThreshold?: number;
            contangoSizeHighThreshold?: number;
          };
        }[];
      }> = {};

      for (const arm of arms) {
        const candidates = buildSweepCandidates(arm.overrides);
        console.log(`\nRunning arm: ${arm.label}`);
        console.log(`  configs: ${candidates.length} × windows: ${windowDefs.length}`);
        const runConfig: WFAOptionsConfig = {
          tickers,
          startDate: WFA_START,
          endDate: WFA_END,
          trainWindowDays: TRAIN_DAYS,
          forwardStepDays: STEP_DAYS,
          purgeGapDays: PURGE_DAYS,
          mode: WFA_MODE,
          maxPositions: MAX_POSITIONS,
          maxPerTicker: MAX_PER_TICKER,
          startingCapital: STARTING_CAPITAL,
        };

        const result = trainWorkers.length > 0
          ? await runWFAOptionsParallelTrain(
            runConfig,
            signalsByPreset,
            allTradingDates,
            candidates,
            evaluator,
            trainWorkers,
            (windowIdx, totalWindows) => {
              process.stdout.write(`\r  ${arm.name}: window ${windowIdx + 1}/${totalWindows}...`);
            },
          )
          : runWFAOptions(
            runConfig,
            signalsByPreset,
            allTradingDates,
            candidates,
            evaluator,
            (windowIdx, totalWindows) => {
              process.stdout.write(`\r  ${arm.name}: window ${windowIdx + 1}/${totalWindows}...`);
            },
          );

        console.log(`\r  ${arm.name}: ${result.windows.length} windows complete. (${(result.elapsedMs / 1000).toFixed(1)}s)`);
        const summary = summarizeRegimeResult(arm, result);
        summaries.push(summary);
        armResults[arm.name] = {
          summary,
          windows: result.windows.map(w => ({
            windowIndex: w.windowIndex,
            trainStart: w.trainStart,
            trainEnd: w.trainEnd,
            oosStart: w.oosStart,
            oosEnd: w.oosEnd,
            bestTrainSharpe: w.bestTrainSharpe,
            oosSharpe: w.oosSharpe,
            oosWinRate: w.oosWinRate,
            oosMaxDD: w.oosMaxDD,
            tradeCount: w.oosTrades.length,
            bestConfig: {
              signalWeightPreset: w.bestConfig.signalWeightPreset,
              creditProfitTarget: w.bestConfig.creditProfitTarget,
              creditSpreadWidth: w.bestConfig.creditSpreadWidth,
              minIVRank: w.bestConfig.minIVRank,
              contangoFilter: w.bestConfig.contangoFilter,
              vrpFilter: w.bestConfig.vrpFilter,
              contangoPctFilter: w.bestConfig.contangoPctFilter,
              vrpPctFilter: w.bestConfig.vrpPctFilter,
              slopeFilter: w.bestConfig.slopeFilter,
              contangoSizeLow: w.bestConfig.contangoSizeLow,
              contangoSizeMid: w.bestConfig.contangoSizeMid,
              contangoSizeHigh: w.bestConfig.contangoSizeHigh,
              contangoSizeMidThreshold: w.bestConfig.contangoSizeMidThreshold,
              contangoSizeHighThreshold: w.bestConfig.contangoSizeHighThreshold,
            },
          })),
        };
      }

      printRegimeStudyTable(summaries);
      const outPath = path.resolve(outDir, REGIME_OUT);
      fs.writeFileSync(outPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        mode: WFA_MODE,
        period: { start: WFA_START, end: WFA_END },
        params: {
          trainDays: TRAIN_DAYS,
          stepDays: STEP_DAYS,
          purgeDays: PURGE_DAYS,
          maxPositions: MAX_POSITIONS,
          maxPerTicker: MAX_PER_TICKER,
          startingCapital: STARTING_CAPITAL,
          fillMode: FILL_MODE,
          workers: trainWorkers.length > 0 ? NUM_WORKERS : 1,
        },
        summaries,
        armResults,
      }, null, 2));
      console.log(`Regime study results saved to ${outPath}`);
    } else {
      const candidates = buildSweepCandidates();
      console.log(`\nSweep candidates: ${candidates.length} configs`);
      console.log(`  Presets: ${presetKeys.join(', ')}`);
      console.log(`  TP: 30%, 50%`);
      console.log(`  Spread widths: $5, $15`);
      console.log(`  IV rank min: 0, 30`);
      console.log(`  Delta stop: 0.75, 0.80, off`);
      console.log(`  Time stop DTE: 7, 14`);

      console.log(`\nRunning WFA (${candidates.length} configs × ${windowDefs.length} windows)...`);
      const runConfig: WFAOptionsConfig = {
        tickers,
        startDate: WFA_START,
        endDate: WFA_END,
        trainWindowDays: TRAIN_DAYS,
        forwardStepDays: STEP_DAYS,
        purgeGapDays: PURGE_DAYS,
        mode: WFA_MODE,
        maxPositions: MAX_POSITIONS,
        maxPerTicker: MAX_PER_TICKER,
        startingCapital: STARTING_CAPITAL,
      };
      const result = trainWorkers.length > 0
        ? await runWFAOptionsParallelTrain(
          runConfig,
          signalsByPreset,
          allTradingDates,
          candidates,
          evaluator,
          trainWorkers,
          (windowIdx, totalWindows) => {
            process.stdout.write(`\r  Window ${windowIdx + 1}/${totalWindows}...`);
          },
        )
        : runWFAOptions(
          runConfig,
          signalsByPreset,
          allTradingDates,
          candidates,
          evaluator,
          (windowIdx, totalWindows) => {
            process.stdout.write(`\r  Window ${windowIdx + 1}/${totalWindows}...`);
          },
        );

      console.log(`\r  ${result.windows.length} windows complete. (${(result.elapsedMs / 1000).toFixed(1)}s)`);
      printReport(result);

      const exportResult = {
        ...result,
        windows: result.windows.map(w => ({
          ...w,
          oosTrades: w.oosTrades.map(t => ({
            ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
            pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
            exitType: t.exitType, direction: t.direction,
            entryDelta: t.entryDelta, entryDTE: t.entryDTE,
            strike: t.strike, spreadWidth: t.spreadWidth,
          })),
        })),
        allOOSTrades: result.allOOSTrades.map(t => ({
          ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
          pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
          exitType: t.exitType, direction: t.direction,
          entryDelta: t.entryDelta, entryDTE: t.entryDTE,
          strike: t.strike, spreadWidth: t.spreadWidth,
        })),
      };

      const outPath = path.resolve(outDir, 'wfa-results.json');
      fs.writeFileSync(outPath, JSON.stringify(exportResult, null, 2));
      console.log(`Results saved to ${outPath}`);
    }
  } finally {
    if (trainWorkers.length > 0) {
      await terminateTrainWorkerPool(trainWorkers);
      console.log('Train workers closed.');
    }
  }

  const hitRate = (_chainHits + _chainMisses) > 0 ? (_chainHits / (_chainHits + _chainMisses) * 100).toFixed(1) : '0';
  console.log(`  Chain LRU: ${_chainHits.toLocaleString()} hits, ${_chainMisses.toLocaleString()} misses (${hitRate}% hit rate)`);

  closeDB();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
