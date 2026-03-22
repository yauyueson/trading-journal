/**
 * Swing WFA Pipeline — Extracted reusable core from wfa-run.ts.
 *
 * Exports `runSwingPipeline()` which runs the full WFA engine
 * for swing credit spread strategies (45-65 DTE).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Worker } from 'node:worker_threads';
import { execSync } from 'child_process';

import type { BacktestCandle } from '../src/lib/backtest/types';
import { SIGNAL_PRESETS, DEFAULT_DYNAMIC_SLIPPAGE, DIR_CONF_THRESHOLDS } from '../src/lib/backtest/types';
import type { DirConfTier } from '../src/lib/backtest/types';
import { precomputeSignals } from '../src/lib/backtest/engine';
import {
  initDB, closeDB,
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

const __dirname_pipeline = path.dirname(fileURLToPath(import.meta.url));

// ── Pipeline Config ─────────────────────────────────────

export interface SwingPipelineConfig {
  tickers: string[];
  startDate: string;
  endDate: string;
  dataStart: string;
  trainWindowDays: number;
  forwardStepDays: number;
  purgeGapDays: number;
  mode: 'rolling' | 'anchored';
  maxPositions: number;
  maxPerTicker: number;
  startingCapital: number;
  fillMode: FillMode;
  numWorkers: number;
  presets: SignalPresetKey[];
  /** Override sweep grid dimensions */
  sweepOverrides?: Partial<SwingSweepDimensions>;
}

export interface SwingSweepDimensions {
  presets?: SignalPresetKey[];
  profitTargets: number[];
  spreadWidths: number[];
  ivRankMins: number[];
  deltaStops: number[];
  timeStopDTEs: number[];
  dirConfTiers?: DirConfTier[];
  creditShortDeltas?: number[];
}

export const SWING_DEFAULTS = {
  tickers: [
    'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
    'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
    'META', 'NFLX', 'GOOGL', 'GS',
  ],
  dataStart: '2017-01-01',
  startDate: '2018-01-01',
  endDate: '2026-02-28',
  trainWindowDays: 504,
  forwardStepDays: 126,
  purgeGapDays: 65,
  mode: 'rolling' as const,
  maxPositions: 50,
  maxPerTicker: 5,
  startingCapital: 100_000,
  fillMode: 'mid' as FillMode,
  presets: ['ema', 'mom', 'em', 'mf', 'vol'] as SignalPresetKey[],
};

export const SWING_SWEEP_DEFAULTS: SwingSweepDimensions = {
  profitTargets: [0.30, 0.50],
  spreadWidths: [5, 15],
  ivRankMins: [0, 30],
  deltaStops: [0.75, 0.80, Infinity],
  timeStopDTEs: [7, 14],
};

// ── Supabase Helper ────────────────────────────────────

const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY(), 'Authorization': `Bearer ${SUPABASE_KEY()}` },
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

// ── Ticker Data ─────────────────────────────────────────

export interface TickerData {
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

export async function fetchTickerData(ticker: string, dataStart: string, dataEnd: string): Promise<TickerData> {
  const cacheKey = `${ticker}|${dataStart}|${dataEnd}`;
  if (candleCache.has(cacheKey)) return candleCache.get(cacheKey)!;

  const candles: BacktestCandle[] = (await supabaseGet('stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${dataStart}&date=lte.${dataEnd}&order=date.asc&limit=5000`
  )).map(r => ({
    date: r.date, timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume,
  }));

  const ivData = await supabaseGet('orats_iv_cache',
    `select=date,iv30d,iv60d,hv30d&ticker=eq.${ticker}&date=gte.${dataStart}&date=lte.${dataEnd}&order=date.asc&limit=5000`);
  let coresData: { trade_date: string; slope: number | null }[] = [];
  try {
    coresData = await supabaseGet('orats_cores_cache',
      `select=trade_date,slope&ticker=eq.${ticker}&trade_date=gte.${dataStart}&trade_date=lte.${dataEnd}&order=trade_date.asc&limit=5000`);
  } catch { /* optional */ }

  const ivByDate = new Map(ivData.map((r: any) => [r.date, Number(r.iv30d)]));
  const regimeByDate = new Map<string, {
    vrp?: number; contango?: number; slope?: number; vrpPct?: number; contangoPct?: number;
  }>();
  const slopeByDate = new Map<string, number>();
  const contangoByDate = new Map<string, number>();
  const vrpByDate = new Map<string, number>();

  for (const row of coresData) {
    if (row?.slope != null && Number.isFinite(row.slope)) slopeByDate.set(row.trade_date, Number(row.slope));
  }
  for (const r of ivData as any[]) {
    const iv30 = Number(r.iv30d), iv60 = Number(r.iv60d), hv30 = Number(r.hv30d);
    const contango = Number.isFinite(iv30) && iv30 > 0 && Number.isFinite(iv60) ? (iv60 / iv30) - 1 : undefined;
    const vrp = Number.isFinite(iv30) && Number.isFinite(hv30) ? (iv30 * iv30) - (hv30 * hv30) : undefined;
    if (contango != null) contangoByDate.set(r.date, contango);
    if (vrp != null) vrpByDate.set(r.date, vrp);
  }

  const orderedDates = candles.map(c => c.date);
  const contangoPctSeries = computeRollingPercentile(orderedDates.map(d => contangoByDate.get(d)));
  const vrpPctSeries = computeRollingPercentile(orderedDates.map(d => vrpByDate.get(d)));
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
      vrp: vrpByDate.get(r.date), contango: contangoByDate.get(r.date),
      slope: slopeByDate.get(r.date), vrpPct: vrpPctByDate.get(r.date),
      contangoPct: contangoPctByDate.get(r.date),
    });
  }

  const ivSeries = candles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRank(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));
  const data = { ticker, candles, ivRanks, dateToIdx, regimeByDate };
  candleCache.set(cacheKey, data);
  return data;
}

// ── Signal Generation ────────────────────────────────────

export function generateSignalsForPreset(
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
      dirConfidence: sig.dirConfidence,
    });
  }
  return entries;
}

// ── Chain Cache (LRU) ────────────────────────────────────

const MAX_CACHE = 200;
const _chainMemo = new Map<string, ReturnType<typeof getCachedChain>>();
let _chainHits = 0;
let _chainMisses = 0;

function getCachedChainMemo(ticker: string, date: string): ReturnType<typeof getCachedChain> {
  const key = `${ticker}|${date}`;
  const cached = _chainMemo.get(key);
  if (cached !== undefined) {
    _chainHits++;
    _chainMemo.delete(key);
    _chainMemo.set(key, cached);
    return cached;
  }
  _chainMisses++;
  const rows = getCachedChain(ticker, date);
  if (_chainMemo.size >= MAX_CACHE) {
    const oldest = _chainMemo.keys().next().value;
    if (oldest) _chainMemo.delete(oldest);
  }
  _chainMemo.set(key, rows);
  return rows;
}

export function getChainCacheStats() {
  return { hits: _chainHits, misses: _chainMisses };
}

// ── Date Index ───────────────────────────────────────────

let _dateIndex: Map<string, number> | null = null;

function buildDateIndex(allDates: string[]) {
  _dateIndex = new Map(allDates.map((d, i) => [d, i]));
}

function advanceTradingDays(allDates: string[], fromDate: string, n: number): string | null {
  const idx = _dateIndex?.get(fromDate) ?? -1;
  if (idx < 0) {
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

// ── Position Sizing ──────────────────────────────────────

function resolveContangoSizeMultiplier(signal: EntrySignal, config: SimConfig): number {
  const low = config.contangoSizeLow;
  const mid = config.contangoSizeMid;
  const high = config.contangoSizeHigh;
  const midTh = config.contangoSizeMidThreshold;
  const highTh = config.contangoSizeHighThreshold;
  const sizingEnabled = [low, mid, high, midTh, highTh].every(v => v != null && Number.isFinite(v));
  if (!sizingEnabled) return 1;

  const lowV = Number(low), midV = Number(mid), highV = Number(high);
  const midThV = Number(midTh), highThV = Number(highTh);
  if (highThV < midThV) return 1;

  const c = signal.contango;
  if (c == null || !Number.isFinite(c)) return midV;
  if (c >= highThV) return highV;
  if (c >= midThV) return midV;
  return lowV;
}

function scaleTradeByMultiplier(trade: OptionTrade, multiplier: number): OptionTrade | null {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
  if (Math.abs(multiplier - 1) < 1e-9) return { ...trade, positionSize: trade.positionSize ?? 1 };
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

// ── Credit Spread Evaluator ──────────────────────────────

function buildTradeResult(
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

export function makeCachedEvaluator(fillMode: FillMode): TradeEvaluator {
  return (signal, config, allTradingDates, maxDate) => {
    if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) return null;
    if (config.vrpFilter && config.vrpFilter > 0 && (signal.vrp == null || signal.vrp < config.vrpFilter)) return null;
    if (config.contangoFilter && config.contangoFilter > 0 && (signal.contango == null || signal.contango < config.contangoFilter)) return null;
    if (config.vrpPctFilter && config.vrpPctFilter > 0 && (signal.vrpPct == null || signal.vrpPct < config.vrpPctFilter)) return null;
    if (config.contangoPctFilter && config.contangoPctFilter > 0 && (signal.contangoPct == null || signal.contangoPct < config.contangoPctFilter)) return null;
    if (config.slopeFilter && config.slopeFilter > 0 && (signal.slope == null || signal.slope < config.slopeFilter)) return null;
    if (config.dirConfTier && config.dirConfTier !== 'any' && signal.dirConfidence != null) {
      if (signal.dirConfidence < DIR_CONF_THRESHOLDS[config.dirConfTier]) return null;
    }
    const sizeMultiplier = resolveContangoSizeMultiplier(signal, config);
    if (sizeMultiplier <= 0) return null;

    const entryChain = getCachedChainMemo(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

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
      if (theta > 0.001 && spread.short.row.gamma / theta > config.maxGammaThetaRatio) return null;
    }
    if (config.maxIVSkew != null && config.maxIVSkew !== Infinity) {
      if (Math.abs(spread.short.iv - spread.long.iv) > config.maxIVSkew) return null;
    }

    // Apply fill model
    let entryCredit: number;
    let entrySlippage = 0;

    if (fillMode === 'bidask' && config.slippage.enabled) {
      if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
        const spreadFill = applySpreadFill('bidask', spread.short, spread.long, 'open', config.slippage);
        entryCredit = spreadFill.fillPrice;
        entrySlippage = spreadFill.slippage;
      } else {
        const shortFill = applyFill('bidask', spread.short.mid, spread.short.bid,
          spread.short.ask, 'sell', config.slippage, spread.short.oi, spread.short.row.dte);
        const longFill = applyFill('bidask', spread.long.mid, spread.long.bid,
          spread.long.ask, 'buy', config.slippage, spread.long.oi, spread.long.row.dte);
        entryCredit = shortFill.fillPrice - longFill.fillPrice;
        entrySlippage = shortFill.slippage + longFill.slippage;
      }
      if (entryCredit <= 0) return null;
    } else {
      entryCredit = spread.netCredit;
    }

    const tpCost = entryCredit * (1 - config.creditProfitTarget);
    const slCost = entryCredit * config.creditStopLossMultiple;
    const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;
    const monitorDates = getMonitoringDates(allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd);
    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

    for (const checkDate of monitorDates) {
      const shortLeg = findContractDirect(signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      const longLeg = findContractDirect(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
      if (!shortLeg || !longLeg) continue;

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
        const trade = buildTradeResult(signal, spread, entryCredit, checkDate, currentSpreadCost,
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
      const trade = buildTradeResult(signal, spread, entryCredit, lastDate, currentSpreadCost,
        shortLeg?.row.dte ?? 0, shortLeg?.row.stock_price ?? spread.short.row.stock_price,
        'EXPIRATION', dailyMtM, entrySlippage, 0, fillMode);
      return scaleTradeByMultiplier(trade, sizeMultiplier);
    }
    return null;
  };
}

// ── Sweep Grid ───────────────────────────────────────────

export function buildSweepCandidates(
  fillMode: FillMode,
  dims: SwingSweepDimensions = SWING_SWEEP_DEFAULTS,
): SimConfig[] {
  const candidates: SimConfig[] = [];
  const presets: SignalPresetKey[] = dims.presets ?? ['ema', 'mom', 'em', 'mf', 'vol'];
  const dirConfTiers: (DirConfTier | undefined)[] = dims.dirConfTiers ?? [undefined];
  const shortDeltas: (number | undefined)[] = dims.creditShortDeltas ?? [undefined];

  for (const preset of presets) {
    for (const tp of dims.profitTargets) {
      for (const width of dims.spreadWidths) {
        for (const ivMin of dims.ivRankMins) {
          for (const dStop of dims.deltaStops) {
            for (const tsdte of dims.timeStopDTEs) {
              for (const dct of dirConfTiers) {
                for (const delta of shortDeltas) {
                  candidates.push({
                    ...DEFAULT_CREDIT_CONFIG,
                    creditProfitTarget: tp,
                    creditSpreadWidth: width,
                    minIVRank: ivMin,
                    creditDeltaStop: isFinite(dStop) ? dStop : undefined,
                    creditTimeStopDTE: tsdte,
                    creditStopLossMultiple: 100,
                    fillMode,
                    slippage: fillMode === 'bidask'
                      ? { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true }
                      : { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
                    signalWeightPreset: preset,
                    dirConfTier: dct,
                    ...(delta != null ? { creditShortDelta: delta } : {}),
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return candidates;
}

// ── Worker Pool ──────────────────────────────────────────

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

export async function createTrainWorkerPool(
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  allTradingDates: string[],
  executionConfig: PortfolioExecutionConfig,
  fillMode: FillMode,
  numWorkers: number,
): Promise<Worker[]> {
  const workerSrc = path.resolve(__dirname_pipeline, 'wfa-train-worker.ts');
  const workerBundle = path.resolve(__dirname_pipeline, '.wfa-train-worker.mjs');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname_pipeline, '..'), stdio: 'pipe' },
  );

  const payload: Record<string, EntrySignal[]> = {};
  for (const [k, v] of signalsByPreset) payload[k] = v;

  const workers = await Promise.all(
    Array.from({ length: numWorkers }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(workerBundle, {
          workerData: {
            signalsByPreset: payload,
            allTradingDates,
            fillMode,
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

export async function terminateTrainWorkerPool(workers: Worker[]) {
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

// ── Parallel WFA Loop ────────────────────────────────────

export async function runWFAOptionsParallelTrain(
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

    const trainResults = await runParallelTrainWork(workers, trainItems, `${i + 1}/${windows.length}`);
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
      rankedTrainResults, config.selectionGuard, selectionMode, ensembleSize,
    );
    const configuredSignals = buildConfiguredSignalsForWindow(
      selectedResults, signalsByPreset, w.oosStart, w.oosEnd,
      selectionMode === 'single' ? 1 : ensembleMinVotes,
    );
    const oosTrades = evaluateConfiguredSignalsWithConstraints(
      configuredSignals, executionConfig, allTradingDates, config.endDate, evaluator,
    );

    const oosAnalytics = computeOptionAnalytics(oosTrades);
    const windowMetricsEnd = windowMetricsMode === 'strict' ? w.oosEnd : config.endDate;
    const windowMetrics = computePortfolioDailyMetrics(
      oosTrades, allTradingDates, w.oosStart, windowMetricsEnd, config.startingCapital,
    );

    wfaWindows.push({
      windowIndex: i,
      trainStart: w.trainStart, trainEnd: w.trainEnd,
      oosStart: w.oosStart, oosEnd: w.oosEnd,
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
    allOOSTrades, allTradingDates, config.startDate, config.endDate, config.startingCapital,
  );
  const oosAllAnalytics = computeOptionAnalytics(allOOSTrades);
  const avgTrainSharpe = wfaWindows.length > 0
    ? wfaWindows.reduce((s, w) => s + w.bestTrainSharpe, 0) / wfaWindows.length : 0;

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

// ── Report ───────────────────────────────────────────────

function formatPct(v: number, decimals = 1): string {
  return v.toFixed(decimals) + '%';
}

export function printSwingReport(result: WFAResult, fillMode: FillMode) {
  console.log('\n' + '═'.repeat(80));
  console.log('  WALK-FORWARD ANALYSIS RESULTS');
  console.log('═'.repeat(80));

  console.log(`\n  Mode: ${result.config.mode.toUpperCase()}`);
  console.log(`  Period: ${result.config.startDate} → ${result.config.endDate}`);
  console.log(`  Train: ${result.config.trainWindowDays}d | Step: ${result.config.forwardStepDays}d | Purge: ${result.config.purgeGapDays}d`);
  console.log(`  Tickers: ${result.config.tickers.join(', ')}`);
  console.log(`  Capital: $${result.config.startingCapital.toLocaleString()}`);
  console.log(`  Fill mode: ${fillMode}`);
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

// ── Main Pipeline ────────────────────────────────────────

export interface SwingPipelineResult {
  wfa: WFAResult;
  chainCacheStats: { hits: number; misses: number };
  /** Exposed for benchmark use — only valid before closeDB() */
  evaluator: TradeEvaluator;
  allTradingDates: string[];
}

export async function runSwingPipeline(config: SwingPipelineConfig): Promise<SwingPipelineResult> {
  console.log('WFA Unified — Swing Credit Spread Pipeline');
  console.log('─'.repeat(60));

  // 1. Init chain cache
  initDB();
  closeDB();

  // 2. Fetch candle data
  console.log(`\nFetching candle data for ${config.tickers.length} tickers...`);
  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of config.tickers) {
    const td = await fetchTickerData(ticker, config.dataStart, config.endDate);
    tickerDataMap.set(ticker, td);
    process.stdout.write(` ${ticker}(${td.candles.length})`);
  }
  console.log(' done.');

  // 3. Build trading dates
  const allDatesSet = new Set<string>();
  for (const td of tickerDataMap.values()) {
    for (const c of td.candles) {
      if (c.date >= config.startDate && c.date <= config.endDate) allDatesSet.add(c.date);
    }
  }
  const allTradingDates = [...allDatesSet].sort();
  buildDateIndex(allTradingDates);
  console.log(`Trading dates: ${allTradingDates.length} (${allTradingDates[0]} → ${allTradingDates[allTradingDates.length - 1]})`);

  // 4. Generate signals per preset
  console.log('\nGenerating signals per preset...');
  const signalsByPreset = new Map<SignalPresetKey, EntrySignal[]>();
  for (const preset of config.presets) {
    const allSignals: EntrySignal[] = [];
    for (const [, td] of tickerDataMap) {
      allSignals.push(...generateSignalsForPreset(td, preset, config.startDate, config.endDate));
    }
    allSignals.sort((a, b) => a.date.localeCompare(b.date));
    signalsByPreset.set(preset, allSignals);
    console.log(`  ${preset}: ${allSignals.length} signals`);
  }

  // 5. Preview windows
  const windowDefs = buildWFAWindows(allTradingDates, {
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    startDate: config.startDate,
    endDate: config.endDate,
  });
  console.log(`\nWFA windows: ${windowDefs.length} (${config.mode})`);
  for (const w of windowDefs) {
    console.log(`  Train ${w.trainStart}→${w.trainEnd} | OOS ${w.oosStart}→${w.oosEnd}`);
  }

  // 6. Build sweep candidates
  const sweepDims: SwingSweepDimensions = {
    ...SWING_SWEEP_DEFAULTS,
    ...config.sweepOverrides,
  };
  const candidates = buildSweepCandidates(config.fillMode, sweepDims);
  console.log(`\nSweep candidates: ${candidates.length} configs`);

  // 7. Create evaluator and workers
  const evaluator = makeCachedEvaluator(config.fillMode);
  const executionConfig: PortfolioExecutionConfig = {
    maxPositions: config.maxPositions,
    maxPerTicker: config.maxPerTicker,
    startingCapital: config.startingCapital,
  };

  let trainWorkers: Worker[] = [];
  if (config.numWorkers > 1) {
    console.log(`\nInitializing ${config.numWorkers} train workers (${os.cpus().length} CPU cores)...`);
    trainWorkers = await createTrainWorkerPool(signalsByPreset, allTradingDates, executionConfig, config.fillMode, config.numWorkers);
    console.log('Train workers ready.');
  }

  // 8. Run WFA
  const runConfig: WFAOptionsConfig = {
    tickers: config.tickers,
    startDate: config.startDate,
    endDate: config.endDate,
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    maxPositions: config.maxPositions,
    maxPerTicker: config.maxPerTicker,
    startingCapital: config.startingCapital,
  };

  try {
    console.log(`\nRunning WFA (${candidates.length} configs × ${windowDefs.length} windows)...`);
    const result = trainWorkers.length > 0
      ? await runWFAOptionsParallelTrain(
          runConfig, signalsByPreset, allTradingDates, candidates,
          evaluator, trainWorkers,
          (windowIdx, totalWindows) => {
            process.stdout.write(`\r  Window ${windowIdx + 1}/${totalWindows}...`);
          },
        )
      : runWFAOptions(
          runConfig, signalsByPreset, allTradingDates, candidates,
          evaluator,
          (windowIdx, totalWindows) => {
            process.stdout.write(`\r  Window ${windowIdx + 1}/${totalWindows}...`);
          },
        );

    console.log(`\r  ${result.windows.length} windows complete. (${(result.elapsedMs / 1000).toFixed(1)}s)`);
    printSwingReport(result, config.fillMode);

    return {
      wfa: result,
      chainCacheStats: getChainCacheStats(),
      evaluator,
      allTradingDates,
    };
  } finally {
    if (trainWorkers.length > 0) {
      await terminateTrainWorkerPool(trainWorkers);
      console.log('Train workers closed.');
    }
    const stats = getChainCacheStats();
    const hitRate = (stats.hits + stats.misses) > 0 ? (stats.hits / (stats.hits + stats.misses) * 100).toFixed(1) : '0';
    console.log(`  Chain LRU: ${stats.hits.toLocaleString()} hits, ${stats.misses.toLocaleString()} misses (${hitRate}% hit rate)`);
    // Note: DB is NOT closed here — caller must call closePipelineDB() after benchmarks
  }
}

/** Close the chain cache DB. Call after all evaluations (including benchmarks) are done. */
export { closeDB as closePipelineDB } from '../src/lib/backtest/chain-cache';
