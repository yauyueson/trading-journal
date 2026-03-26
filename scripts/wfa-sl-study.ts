/**
 * WFA Stop-Loss Study — Comprehensive evaluation of 4 SL mechanisms
 * for credit spread strategies (Swing 45-65 DTE + Short-Term 130M 7-21 DTE).
 *
 * Tests: Credit multiple, Delta stop, % of Max Loss, Trailing Profit Lock
 * Methodology: IS/OOS on selection windows + holdout validation + overfitting grading
 *
 * Usage:
 *   npx tsx scripts/wfa-sl-study.ts [--tickers SPY,QQQ] [--strategy swing|short|both] [--phase 1|2]
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { Worker } from 'node:worker_threads';
import { execSync } from 'child_process';

// Load .env and .env.local
const __dirname_early = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname_early, '../.env') });
dotenvConfig({ path: path.resolve(__dirname_early, '../.env.local'), override: true });

import type { BacktestCandle } from '../src/lib/backtest/types';
import { SIGNAL_PRESETS, DEFAULT_DYNAMIC_SLIPPAGE, DIR_CONF_THRESHOLDS } from '../src/lib/backtest/types';
import type { DirConfTier } from '../src/lib/backtest/types';
import { precomputeSignals } from '../src/lib/backtest/engine';
import {
  precomputeSignals4H,
  type IVDataRow,
  type PeriodMultiplier,
} from '../src/lib/backtest/intraday-signals';
import {
  initDB, closeDB,
  getCachedChain, findSpreadStrikes, findContractDirect,
} from '../src/lib/backtest/chain-cache';
import type { SpreadMatch } from '../src/lib/backtest/chain-cache';
import {
  DEFAULT_CREDIT_CONFIG,
  DEFAULT_SHORT_CREDIT_CONFIG,
  computeOptionAnalytics,
  projectTradesToGrossPnlView,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionExitType,
  type SignalPresetKey,
} from '../src/lib/backtest/option-sim';
import {
  clampSpreadCloseCost,
  computeCreditSpreadThresholds,
  computeIntrinsicSpreadCloseCost,
  createMissingChainState,
  resolveActualSpreadWidth,
  resolveTriggeredCreditExitCost,
  shouldExitNoChain,
  updateMissingChainState,
} from '../src/lib/backtest/credit-spread-exit';
import { computeIVRankMinMax, IV_RANK_METHOD_MIN_MAX_252D } from '../src/lib/backtest/iv-rank';
import type { FillMode } from '../src/lib/backtest/types';
import { applyFill, applySpreadFill } from '../src/lib/backtest/slippage';
import {
  buildWFAWindows,
  evaluateConfiguredSignalsWithConstraints,
  computePortfolioDailyMetrics,
  type PortfolioExecutionConfig,
  type TradeEvaluator,
  type ConfiguredSignal,
} from '../src/lib/backtest/wfa-options';
import { evaluateCreditSpread4H } from '../src/lib/backtest/intraday-monitor';
import { initIntradayDB, get130MCandles, aggregateToDaily, type IntradayCandle } from '../src/lib/backtest/intraday-cache';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHORT_COMMISSION_PER_LEG = 0.65;
const SWING_EXECUTION_LABEL = 'mid_no_explicit_costs';
const SHORT_EXECUTION_LABEL = 'bidask_combo_plus_commission';

// ── Types ────────────────────────────────────────────────

interface SLStudyResult {
  strategy: 'swing' | 'short';
  mechanism: 'baseline' | 'credit_multiple' | 'delta_stop' | 'max_loss_pct' | 'trailing_lock' | 'combo';
  configLabel: string;
  params: Record<string, number>;
  isSharpe: number;
  rankingMetric: 'net_oos_sharpe';
  executionModel: string;
  ivRankMethod: string;
  oosSharpe: number;
  oosNetSharpe: number;
  oosGrossSharpe: number;
  holdoutSharpe: number;
  holdoutNetSharpe: number;
  holdoutGrossSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  oosNetTotalPnl: number;
  oosGrossTotalPnl: number;
  holdoutTotalPnl: number;
  holdoutNetTotalPnl: number;
  holdoutGrossTotalPnl: number;
  wfEfficiency: number;
  grade: string;
  tradeCount: number;
  exitTypeBreakdown: Record<string, number>;
  windowDetails: Array<{
    windowIdx: number;
    trainSharpe: number;
    oosSharpe: number;
    oosWR: number;
    oosMaxDD: number;
    oosTradeCount: number;
  }>;
}

// ── Config Constants ─────────────────────────────────────

const DEFAULT_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
  'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
  'META', 'NFLX', 'GOOG', 'GS',
];

const SWING_PARAMS = {
  dataStart: '2017-01-01',
  startDate: '2018-01-01',
  endDate: '2026-02-28',
  trainWindowDays: 504,
  forwardStepDays: 126,
  purgeGapDays: 65,
  mode: 'rolling' as const,
  maxPositions: 5,
  maxPerTicker: 3,
  startingCapital: 100_000,
  holdoutCount: 2,
  preset: 'vol' as SignalPresetKey,
};

const SHORT_PARAMS = {
  dataStart: '2017-01-01',
  startDate: '2018-01-01',
  endDate: '2026-02-28',
  trainWindowDays: 189,
  forwardStepDays: 42,
  purgeGapDays: 14,
  mode: 'rolling' as const,
  maxPositions: 10,
  maxPerTicker: 5,
  startingCapital: 100_000,
  holdoutCount: 2,
  preset: 'em' as SignalPresetKey,
  periodMultiplier: 2.25,
};

// ── SL Config Definitions ────────────────────────────────

interface SLConfigDef {
  label: string;
  mechanism: SLStudyResult['mechanism'];
  params: Record<string, number>;
  apply: (base: SimConfig) => SimConfig;
}

function buildSLConfigs(): SLConfigDef[] {
  const configs: SLConfigDef[] = [];

  // Baseline (no SL)
  configs.push({
    label: 'baseline',
    mechanism: 'baseline',
    params: {},
    apply: (base) => ({ ...base, creditStopLossMultiple: 100 }),
  });

  // Credit Multiple: 2×-15×
  for (const mult of [2, 3, 4, 5, 7, 10, 15]) {
    configs.push({
      label: `sl${mult}x`,
      mechanism: 'credit_multiple',
      params: { creditStopLossMultiple: mult },
      apply: (base) => ({ ...base, creditStopLossMultiple: mult }),
    });
  }

  // Delta Stop: 0.50-0.80
  for (const ds of [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]) {
    configs.push({
      label: `ds${(ds * 100).toFixed(0)}`,
      mechanism: 'delta_stop',
      params: { creditDeltaStop: ds },
      apply: (base) => ({ ...base, creditStopLossMultiple: 100, creditDeltaStop: ds }),
    });
  }

  // Max Loss %: 25%-90%
  for (const pct of [0.25, 0.50, 0.75, 0.90]) {
    configs.push({
      label: `ml${(pct * 100).toFixed(0)}`,
      mechanism: 'max_loss_pct',
      params: { creditMaxLossStopPct: pct },
      apply: (base) => ({ ...base, creditStopLossMultiple: 100, creditMaxLossStopPct: pct }),
    });
  }

  // Trailing Lock: (activate%, floor%)
  for (const [act, floor] of [[0.50, 0.25], [0.50, 0.50], [0.75, 0.25], [0.75, 0.50]] as [number, number][]) {
    configs.push({
      label: `tl${(act * 100).toFixed(0)}-${(floor * 100).toFixed(0)}`,
      mechanism: 'trailing_lock',
      params: { trailingActivatePct: act, trailingFloorPct: floor },
      apply: (base) => ({
        ...base,
        creditStopLossMultiple: 100,
        trailingActivatePct: act,
        trailingFloorPct: floor,
      }),
    });
  }

  return configs;
}

// ── Supabase Helper ──────────────────────────────────────

const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── Swing Data ───────────────────────────────────────────

interface SwingTickerData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

async function fetchSwingTickerData(ticker: string, dataStart: string, dataEnd: string): Promise<SwingTickerData> {
  // Fetch daily candles from Supabase
  const rows = await supabaseGet(
    'stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${dataStart}&date=lte.${dataEnd}&order=date.asc&limit=10000`,
  );
  const candles: BacktestCandle[] = rows.map((r: any) => ({
    date: r.date,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume ?? 0,
  }));

  // Fetch IV data for IV Rank
  const ivRows = await supabaseGet(
    'orats_iv_cache',
    `select=date,iv30d&ticker=eq.${ticker}&date=gte.${dataStart}&date=lte.${dataEnd}&order=date.asc&limit=5000`,
  );
  const ivByDate = new Map(ivRows.map((r: any) => [r.date, r.iv30d as number | null]));
  const ivSeries = candles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  return { ticker, candles, ivRanks, dateToIdx };
}

function generateSwingSignals(
  td: SwingTickerData,
  preset: SignalPresetKey,
  periodStart: string,
  periodEnd: string,
): EntrySignal[] {
  const techOptions = SIGNAL_PRESETS[preset];
  const { signals } = precomputeSignals(td.candles, '1D', techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    if (sig.date < periodStart || sig.date > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 70) continue;
    if (sig.adx === undefined || sig.adx < 10) continue;

    const idx = td.dateToIdx.get(sig.date);
    entries.push({
      ticker: td.ticker,
      date: sig.date,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
      dirConfidence: sig.dirConfidence,
    });
  }
  return entries;
}

// ── Short-Term Data ──────────────────────────────────────

interface ShortTickerData {
  ticker: string;
  candles130m: IntradayCandle[];
  dailyCandles: IntradayCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
  ivData: IVDataRow[];
}

async function fetchShortTickerData(ticker: string, dataStart: string, dataEnd: string, intradayDb: any): Promise<ShortTickerData> {
  const candles130m = get130MCandles(intradayDb, ticker, dataStart, dataEnd);
  const dailyCandles = aggregateToDaily(candles130m);

  const ivDbRows = await supabaseGet(
    'orats_iv_cache',
    `select=date,iv30d,iv60d,hv20d,hv30d,hv60d&ticker=eq.${ticker}&date=gte.${dataStart}&date=lte.${dataEnd}&order=date.asc&limit=5000`,
  );
  const ivData = ivDbRows.map((r: any) => ({
    date: r.date as string,
    iv30d: r.iv30d as number | null,
    iv60d: r.iv60d as number | null,
    hv20d: r.hv20d as number | null,
    hv30d: r.hv30d as number | null,
    hv60d: r.hv60d as number | null,
  }));

  const ivByDate = new Map(ivData.map(r => [r.date, r.iv30d]));
  const ivSeries = dailyCandles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);
  const dateToIdx = new Map(dailyCandles.map((c, i) => [c.date, i]));

  return { ticker, candles130m, dailyCandles, ivRanks, dateToIdx, ivData };
}

function generateShortSignals(
  td: ShortTickerData,
  preset: SignalPresetKey,
  periodMultiplier: number,
  periodStart: string,
  periodEnd: string,
): EntrySignal[] {
  const techOptions = SIGNAL_PRESETS[preset];
  const signals = precomputeSignals4H(td.candles130m, td.ivData, periodMultiplier, techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    const barDate = sig.date.split('T')[0].split(' ')[0];
    if (barDate < periodStart || barDate > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 65) continue;
    if (sig.adx !== undefined && sig.adx < 8) continue;

    const idx = td.dateToIdx.get(barDate);
    entries.push({
      ticker: td.ticker,
      date: barDate,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
      hv60: td.ivData.find(r => r.date === barDate)?.hv60d ?? undefined,
    });
  }

  // Deduplicate
  const deduped = new Map<string, EntrySignal>();
  for (const entry of entries) {
    const key = `${entry.ticker}|${entry.date}|${entry.direction}`;
    if (!deduped.has(key) || entry.score > deduped.get(key)!.score) {
      deduped.set(key, entry);
    }
  }
  return [...deduped.values()];
}

// ── Swing Evaluator ──────────────────────────────────────

function buildSwingTrade(
  signal: EntrySignal,
  spread: SpreadMatch,
  entryCredit: number,
  exitDate: string,
  exitSpreadCost: number,
  exitDTE: number,
  exitStockPrice: number,
  exitType: OptionExitType,
  dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[],
): OptionTrade {
  const actualWidth = resolveActualSpreadWidth(spread);
  const boundedEntryCredit = clampSpreadCloseCost(entryCredit, actualWidth);
  const boundedExitCost = clampSpreadCloseCost(exitSpreadCost, actualWidth);
  const maxLoss = Math.max(0, actualWidth - boundedEntryCredit);
  const pnl = Math.max(
    -maxLoss * 100,
    Math.min((boundedEntryCredit - boundedExitCost) * 100, boundedEntryCredit * 100),
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
    spreadWidth: actualWidth,
    maxProfit: boundedEntryCredit,
    maxLoss,
    exitDate,
    exitPrice: boundedExitCost,
    exitDTE,
    exitStockPrice,
    exitType,
    pnl,
    pnlPct: maxLoss > 0 ? pnl / (maxLoss * 100) : 0,
    holdDays: Math.round(
      (new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000,
    ),
    ivRank: signal.ivRank,
    dailyMtM,
  };
}

function makeSwingEvaluator(fillMode: FillMode): TradeEvaluator {
  return (signal, config, allTradingDates, maxDate) => {
    const entryChain = getCachedChain(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';
    const spread = findSpreadStrikes(
      entryChain, config.creditShortDelta, config.creditSpreadWidth,
      optionType, config.creditDTERange,
    );
    if (!spread || spread.netCredit <= 0) return null;

    // IV Rank gate
    if (config.minIVRank > 0 && signal.ivRank != null && signal.ivRank < config.minIVRank) return null;

    let entryCredit = spread.netCredit;
    const thresholds = computeCreditSpreadThresholds(config, spread, entryCredit);

    // Trailing profit lock state
    let trailingFloorActive = false;
    let trailingFloorCost = Infinity;
    let missingChainState = createMissingChainState();
    let lastValidSpreadCost: number | null = null;

    const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;

    // Build monitoring dates
    const startIdx = allTradingDates.indexOf(signal.date);
    if (startIdx < 0) return null;
    const monitorDates: string[] = [];
    for (let i = startIdx + 1; i < allTradingDates.length; i++) {
      if (allTradingDates[i] > monitorEnd) break;
      monitorDates.push(allTradingDates[i]);
    }

    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

    for (const checkDate of monitorDates) {
      const shortLeg = findContractDirect(signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      const longLeg = findContractDirect(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
      const fallbackChain = (!shortLeg || !longLeg) ? getCachedChain(signal.ticker, checkDate) : [];
      const monitoringStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price;
      const hasValidLegs = Boolean(shortLeg && longLeg);
      missingChainState = updateMissingChainState(missingChainState, hasValidLegs);
      if (!hasValidLegs) {
        if (shouldExitNoChain(config, missingChainState)) {
          const intrinsicCost = monitoringStockPrice != null
            ? computeIntrinsicSpreadCloseCost(
                optionType,
                spread.short.row.strike,
                spread.long.row.strike,
                monitoringStockPrice,
                thresholds.actualWidth,
              )
            : null;
          const exitCost = resolveTriggeredCreditExitCost(
            'NO_CHAIN',
            Math.max(
              lastValidSpreadCost ?? thresholds.boundedEntryCredit,
              intrinsicCost ?? thresholds.boundedEntryCredit,
            ),
            thresholds,
          );
          return buildSwingTrade(
            signal,
            spread,
            entryCredit,
            checkDate,
            exitCost,
            shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
            monitoringStockPrice ?? spread.short.row.stock_price,
            'NO_CHAIN',
            dailyMtM,
          );
        }
        continue;
      }

      const currentSpreadCost = clampSpreadCloseCost(
        shortLeg.mid - longLeg.mid,
        thresholds.actualWidth,
      );
      const currentDTE = shortLeg.row.dte;
      lastValidSpreadCost = currentSpreadCost;

      dailyMtM.push({
        date: checkDate,
        spreadMid: currentSpreadCost,
        unrealizedPnl: (entryCredit - currentSpreadCost) * 100,
      });

      // Update trailing lock state
      if (config.trailingActivatePct != null && config.trailingFloorPct != null) {
        const unrealizedProfit = entryCredit - currentSpreadCost;
        const activationProfit = config.trailingActivatePct * thresholds.tpProfit;
        if (!trailingFloorActive && unrealizedProfit >= activationProfit) {
          trailingFloorActive = true;
          trailingFloorCost = clampSpreadCloseCost(
            thresholds.boundedEntryCredit - (config.trailingFloorPct * thresholds.tpProfit),
            thresholds.actualWidth,
          );
        }
      }

      let exitType: OptionExitType | null = null;
      if (currentSpreadCost <= thresholds.tpCost) exitType = 'PROFIT_TARGET';
      else if (currentSpreadCost >= thresholds.slCost) exitType = 'STOP_LOSS';
      else if (currentSpreadCost >= thresholds.maxLossStopCost) exitType = 'MAX_LOSS_STOP';
      else if (config.creditDeltaStop != null && isFinite(config.creditDeltaStop) &&
               config.creditDeltaStop > 0 && Math.abs(shortLeg.delta) >= config.creditDeltaStop) exitType = 'DELTA_STOP';
      else if (trailingFloorActive && currentSpreadCost > trailingFloorCost) exitType = 'TRAILING_LOCK';
      else if (currentDTE <= config.creditTimeStopDTE) exitType = 'TIME_STOP';

      if (exitType) {
        const exitCost = resolveTriggeredCreditExitCost(exitType, currentSpreadCost, thresholds, {
          trailingFloorCost,
        });
        return buildSwingTrade(
          signal,
          spread,
          entryCredit,
          checkDate,
          exitCost,
          currentDTE,
          shortLeg.row.stock_price,
          exitType,
          dailyMtM,
        );
      }
    }

    // Expiration
    const lastDate = monitorDates[monitorDates.length - 1];
    if (!lastDate) return null;
    const shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    const fallbackChain = (!shortLeg || !longLeg) ? getCachedChain(signal.ticker, lastDate) : [];
    let finalCost: number;
    if (shortLeg && longLeg) {
      finalCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, thresholds.actualWidth);
    } else {
      const stockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price;
      finalCost = computeIntrinsicSpreadCloseCost(
        optionType,
        spread.short.row.strike,
        spread.long.row.strike,
        stockPrice,
        thresholds.actualWidth,
      );
    }
    return buildSwingTrade(
      signal,
      spread,
      entryCredit,
      lastDate,
      finalCost,
      shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
      shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? spread.short.row.stock_price,
      'EXPIRATION',
      dailyMtM,
    );
  };
}

// ── Short-Term Evaluator ─────────────────────────────────

function makeShortEvaluator(
  tickerDataMap: Map<string, ShortTickerData>,
): TradeEvaluator {
  return (signal, config, tradingDates, maxDate) => {
    const td = tickerDataMap.get(signal.ticker);
    if (!td) return null;

    // IV Rank gate
    if (config.minIVRank > 0 && signal.ivRank != null && signal.ivRank < config.minIVRank) return null;

    return evaluateCreditSpread4H(
      signal, config, td.candles130m, tradingDates, maxDate,
      {
        getChain: (ticker, date) => getCachedChain(ticker, date),
        findSpread: (chain, shortDelta, width, type, dteRange) =>
          findSpreadStrikes(chain, shortDelta, width, type as 'Call' | 'Put', dteRange),
        findContract: (ticker, date, strike, expiry, type) =>
          findContractDirect(ticker, date, strike, expiry, type as 'Call' | 'Put'),
        applyFillFn: (mid, bid, ask, side, cfg, oi, dte) =>
          applyFill((config.fillMode ?? 'mid') as FillMode, mid, bid, ask, side, cfg, oi, dte),
      },
    );
  };
}

// ── Evaluation Per Config ────────────────────────────────

interface WindowEvalResult {
  windowIdx: number;
  trainSharpe: number;
  oosSharpe: number;
  oosWR: number;
  oosMaxDD: number;
  oosTradeCount: number;
  oosTrades: OptionTrade[];
}

function evaluateConfigOnWindows(
  slConfig: SimConfig,
  signals: EntrySignal[],
  allTradingDates: string[],
  windows: Array<{ trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }>,
  evaluator: TradeEvaluator,
  executionConfig: PortfolioExecutionConfig,
  startingCapital: number,
): WindowEvalResult[] {
  const results: WindowEvalResult[] = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];

    // Evaluate on train period
    const trainSignals = signals.filter(s => s.date >= w.trainStart && s.date <= w.trainEnd);
    const trainConfiguredSignals: ConfiguredSignal[] = trainSignals.map(s => ({
      signal: s,
      config: slConfig,
    }));
    const trainTrades = evaluateConfiguredSignalsWithConstraints(
      trainConfiguredSignals, executionConfig, allTradingDates, w.trainEnd, evaluator,
    );
    const trainMetrics = computePortfolioDailyMetrics(
      trainTrades, allTradingDates, w.trainStart, w.trainEnd, startingCapital,
    );

    // Evaluate on OOS period
    const oosSignals = signals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const oosConfiguredSignals: ConfiguredSignal[] = oosSignals.map(s => ({
      signal: s,
      config: slConfig,
    }));
    const oosTrades = evaluateConfiguredSignalsWithConstraints(
      oosConfiguredSignals, executionConfig, allTradingDates, w.oosEnd, evaluator,
    );
    const oosMetrics = computePortfolioDailyMetrics(
      oosTrades, allTradingDates, w.oosStart, w.oosEnd, startingCapital,
    );
    const oosAnalytics = computeOptionAnalytics(oosTrades);

    results.push({
      windowIdx: i,
      trainSharpe: trainMetrics.sharpe,
      oosSharpe: oosMetrics.sharpe,
      oosWR: oosAnalytics.winRate,
      oosMaxDD: oosMetrics.maxDrawdownPct,
      oosTradeCount: oosTrades.length,
      oosTrades,
    });
  }

  return results;
}

// ── Overfitting Grade ────────────────────────────────────

function computeGrade(
  windowResults: WindowEvalResult[],
  minTrades: number,
  aggregateOOSSharpe: number,
): { grade: string; passCount: number; checks: boolean[] } {
  if (windowResults.length === 0) {
    return { grade: 'F', passCount: 0, checks: [false, false, false, false, false, false] };
  }
  const avgISS = windowResults.reduce((s, w) => s + w.trainSharpe, 0) / windowResults.length;
  const avgOOSS = windowResults.reduce((s, w) => s + w.oosSharpe, 0) / windowResults.length;
  const oosStdDev = Math.sqrt(
    windowResults.reduce((s, w) => s + (w.oosSharpe - avgOOSS) ** 2, 0) / windowResults.length,
  );
  const totalTrades = windowResults.reduce((s, w) => s + w.oosTradeCount, 0);
  const allPositive = windowResults.every(w => w.oosTradeCount > 0 && w.oosSharpe > 0);

  const checks = [
    avgISS > 0 && avgOOSS / avgISS >= 0.40,  // 1. IS→OOS retention >= 40%
    oosStdDev < 1.0,                           // 2. OOS Sharpe StdDev < 1.0
    allPositive,                               // 3. All windows positive OOS
    totalTrades >= minTrades,                   // 4. Sufficient trades
    avgISS < 5,                                // 5. No extreme IS
    aggregateOOSSharpe > 0.5,                  // 6. OOS Sharpe > 0.5
  ];

  const passCount = checks.filter(Boolean).length;
  const grade = passCount === 6 ? 'A' : passCount === 5 ? 'B' : passCount === 4 ? 'C' : passCount >= 3 ? 'D' : 'F';

  return { grade, passCount, checks };
}

// ── Run Strategy Arm ─────────────────────────────────────

async function runStrategyArm(
  strategy: 'swing' | 'short',
  tickers: string[],
  slConfigs: SLConfigDef[],
  shortTickerDataMap?: Map<string, ShortTickerData>,
): Promise<SLStudyResult[]> {
  const isSwing = strategy === 'swing';
  const params = isSwing ? SWING_PARAMS : SHORT_PARAMS;

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  ${strategy.toUpperCase()} ARM — ${slConfigs.length} SL configs × ${tickers.length} tickers`);
  console.log(`${'═'.repeat(80)}`);

  // Build trading dates
  const allDatesSet = new Set<string>();

  let swingDataMap: Map<string, SwingTickerData> | undefined;
  let signals: EntrySignal[] = [];
  let evaluator: TradeEvaluator;

  if (isSwing) {
    swingDataMap = new Map();
    console.log(`\nFetching candle data...`);
    for (const ticker of tickers) {
      const td = await fetchSwingTickerData(ticker, params.dataStart, params.endDate);
      swingDataMap.set(ticker, td);
      for (const c of td.candles) {
        if (c.date >= params.startDate && c.date <= params.endDate) allDatesSet.add(c.date);
      }
      process.stdout.write(` ${ticker}(${td.candles.length})`);
    }
    console.log(' done.');

    // Generate signals
    console.log(`Generating ${SWING_PARAMS.preset} signals...`);
    for (const [, td] of swingDataMap) {
      signals.push(...generateSwingSignals(td, SWING_PARAMS.preset, params.startDate, params.endDate));
    }
    signals.sort((a, b) => a.date.localeCompare(b.date));
    console.log(`  ${signals.length} signals`);

    evaluator = makeSwingEvaluator('mid' as FillMode);
  } else {
    // Short-Term
    if (!shortTickerDataMap) throw new Error('shortTickerDataMap required for short arm');

    for (const [, td] of shortTickerDataMap) {
      for (const c of td.dailyCandles) {
        if (c.date >= params.startDate && c.date <= params.endDate) allDatesSet.add(c.date);
      }
    }

    console.log(`Generating ${SHORT_PARAMS.preset} signals (PM ${SHORT_PARAMS.periodMultiplier})...`);
    for (const [, td] of shortTickerDataMap) {
      signals.push(...generateShortSignals(td, SHORT_PARAMS.preset, SHORT_PARAMS.periodMultiplier, params.startDate, params.endDate));
    }
    signals.sort((a, b) => a.date.localeCompare(b.date));
    console.log(`  ${signals.length} signals`);

    evaluator = makeShortEvaluator(shortTickerDataMap);
  }

  const allTradingDates = [...allDatesSet].sort();
  console.log(`Trading dates: ${allTradingDates.length}`);

  // Build WFA windows
  const allWindows = buildWFAWindows(allTradingDates, {
    trainWindowDays: params.trainWindowDays,
    forwardStepDays: params.forwardStepDays,
    purgeGapDays: params.purgeGapDays,
    mode: params.mode,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  const holdoutCount = params.holdoutCount;
  const selectionWindows = allWindows.slice(0, -holdoutCount);
  const holdoutWindows = allWindows.slice(-holdoutCount);

  console.log(`\nWFA windows: ${allWindows.length} total (${selectionWindows.length} selection + ${holdoutWindows.length} holdout)`);
  for (const w of allWindows) {
    console.log(`  Train ${w.trainStart}→${w.trainEnd} | OOS ${w.oosStart}→${w.oosEnd}`);
  }

  const executionConfig: PortfolioExecutionConfig = {
    maxPositions: params.maxPositions,
    maxPerTicker: params.maxPerTicker,
    startingCapital: params.startingCapital,
  };

  const minTrades = isSwing ? 100 : 50;

  // Build worker pool
  const numWorkers = Math.max(1, os.cpus().length - 2);
  console.log(`\nSpawning ${numWorkers} workers...`);

  const workerSrc = path.resolve(__dirname, 'wfa-sl-worker.ts');
  const workerBundle = path.resolve(__dirname, '.wfa-sl-worker.mjs');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );

  // Prepare worker data (short-term needs candle data passed)
  const workerInitData: Record<string, any> = {
    signals,
    allTradingDates,
    strategy,
    executionConfig,
    startingCapital: params.startingCapital,
    startDate: params.startDate,
    endDate: params.endDate,
  };
  if (!isSwing && shortTickerDataMap) {
    const tickerCandles130m: Record<string, IntradayCandle[]> = {};
    const tickerIvData: Record<string, any[]> = {};
    for (const [ticker, td] of shortTickerDataMap) {
      tickerCandles130m[ticker] = td.candles130m;
      tickerIvData[ticker] = td.ivData;
    }
    workerInitData.tickerCandles130m = tickerCandles130m;
    workerInitData.tickerIvData = tickerIvData;
  }

  const workers = await Promise.all(
    Array.from({ length: numWorkers }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(workerBundle, { workerData: workerInitData });
        w.once('message', (msg) => {
          if (msg?.type === 'ready') resolve(w);
          else reject(new Error('Worker failed to initialize'));
        });
        w.once('error', reject);
      }),
    ),
  );
  console.log(`${numWorkers} workers ready.`);

  // Build base config — must match strategy-config.json validated params
  const baseConfig: SimConfig = isSwing
    ? {
        ...DEFAULT_CREDIT_CONFIG,
        creditShortDelta: 0.35,
        creditProfitTarget: 0.40,
        creditSpreadWidth: 20,
        creditStopLossMultiple: 100,
        creditTimeStopDTE: 3,
        creditDTERange: [45, 65] as [number, number],
        minIVRank: 0,
        signalWeightPreset: SWING_PARAMS.preset,
        dirConfTier: 'high' as DirConfTier,
        fillMode: 'mid' as FillMode,
        slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
      }
    : {
        ...DEFAULT_SHORT_CREDIT_CONFIG,
        creditDTERange: [7, 21] as [number, number],
        creditSpreadWidth: 10,
        creditProfitTarget: 0.50,
        creditStopLossMultiple: 100,
        creditTimeStopDTE: 1,
        minIVRank: 20,
        signalWeightPreset: SHORT_PARAMS.preset,
        indicatorPeriodMultiplier: SHORT_PARAMS.periodMultiplier,
        bsmKappa: 4.0,
        bsmRiskFreeRate: 0.04,
        dailyCalibration: true,
        ivThetaSource: 'hv60' as const,
        fillMode: 'bidask' as FillMode,
        slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true, executionStyle: 'combo' },
        commissionPerLeg: SHORT_COMMISSION_PER_LEG,
      };

  // Dispatch all configs to workers in parallel
  interface WorkerResult {
    id: number;
    configLabel: string;
    selectionResults: Array<{
      windowIdx: number; trainSharpe: number; oosSharpe: number;
      oosWR: number; oosMaxDD: number; oosTradeCount: number;
    }>;
    allOOSTrades: OptionTrade[];
    holdoutTrades: OptionTrade[];
    error?: string;
  }

  const workItems = slConfigs.map((slDef, idx) => ({
    type: 'eval' as const,
    id: idx,
    configLabel: slDef.label,
    slConfig: slDef.apply(baseConfig),
    selectionWindows,
    holdoutWindows,
  }));

  const workerResults: WorkerResult[] = new Array(workItems.length);
  let nextIdx = 0;
  let completed = 0;

  await new Promise<void>((resolve, reject) => {
    const onMessage = (worker: Worker) => (msg: any) => {
      if (!msg || msg.type !== 'result') return;
      workerResults[msg.id] = msg;
      completed++;
      process.stdout.write(`\r  Evaluating: ${completed}/${workItems.length} configs (${numWorkers} workers)...`);

      if (completed === workItems.length) {
        process.stdout.write('\n');
        resolve();
        return;
      }
      const next = workItems[nextIdx++];
      if (next) worker.postMessage(next);
    };

    for (const worker of workers) {
      worker.on('message', onMessage(worker));
      worker.on('error', reject);
    }

    // Seed initial work
    for (const worker of workers) {
      const next = workItems[nextIdx++];
      if (!next) break;
      worker.postMessage(next);
    }
  });

  // Terminate workers
  for (const w of workers) w.postMessage({ type: 'exit' });
  await new Promise(r => setTimeout(r, 100));
  await Promise.all(workers.map(w => w.terminate()));
  console.log('Workers terminated.');

  // Process results
  const results: SLStudyResult[] = [];
  const selectionStart = selectionWindows[0]?.oosStart ?? params.startDate;
  const selectionEnd = selectionWindows[selectionWindows.length - 1]?.oosEnd ?? params.endDate;
  const holdoutStart = holdoutWindows[0]?.oosStart ?? params.startDate;
  const holdoutEnd = holdoutWindows[holdoutWindows.length - 1]?.oosEnd ?? params.endDate;
  for (let ci = 0; ci < slConfigs.length; ci++) {
    const slDef = slConfigs[ci];
    const wr = workerResults[ci];
    if (!wr || wr.error) {
      console.error(`  ERROR: ${slDef.label}: ${wr?.error ?? 'no result'}`);
      continue;
    }

    const allOOSTrades = wr.allOOSTrades;
    const allOOSMetrics = computePortfolioDailyMetrics(
      allOOSTrades, allTradingDates, selectionStart, selectionEnd, params.startingCapital,
    );
    const grossOOSTrades = projectTradesToGrossPnlView(allOOSTrades);
    const grossOOSMetrics = computePortfolioDailyMetrics(
      grossOOSTrades, allTradingDates, selectionStart, selectionEnd, params.startingCapital,
    );
    const allOOSAnalytics = computeOptionAnalytics(allOOSTrades);
    const avgTrainSharpe = wr.selectionResults.length > 0
      ? wr.selectionResults.reduce((s, w) => s + w.trainSharpe, 0) / wr.selectionResults.length : 0;
    const wfEfficiency = avgTrainSharpe >= 0.1 ? allOOSMetrics.sharpe / avgTrainSharpe : 0;

    const holdoutMetrics = computePortfolioDailyMetrics(
      wr.holdoutTrades, allTradingDates, holdoutStart, holdoutEnd, params.startingCapital,
    );
    const grossHoldoutTrades = projectTradesToGrossPnlView(wr.holdoutTrades);
    const grossHoldoutMetrics = computePortfolioDailyMetrics(
      grossHoldoutTrades, allTradingDates, holdoutStart, holdoutEnd, params.startingCapital,
    );

    const { grade } = computeGrade(
      wr.selectionResults.map(w => ({ ...w, oosTrades: [] as OptionTrade[] })),
      minTrades,
      allOOSMetrics.sharpe,
    );

    const exitTypeBreakdown: Record<string, number> = {};
    for (const t of allOOSTrades) {
      exitTypeBreakdown[t.exitType] = (exitTypeBreakdown[t.exitType] ?? 0) + 1;
    }

    results.push({
      strategy,
      mechanism: slDef.mechanism,
      configLabel: slDef.label,
      params: slDef.params,
      isSharpe: avgTrainSharpe,
      rankingMetric: 'net_oos_sharpe',
      executionModel: isSwing ? SWING_EXECUTION_LABEL : SHORT_EXECUTION_LABEL,
      ivRankMethod: IV_RANK_METHOD_MIN_MAX_252D,
      oosSharpe: allOOSMetrics.sharpe,
      oosNetSharpe: allOOSMetrics.sharpe,
      oosGrossSharpe: grossOOSMetrics.sharpe,
      holdoutSharpe: holdoutMetrics.sharpe,
      holdoutNetSharpe: holdoutMetrics.sharpe,
      holdoutGrossSharpe: grossHoldoutMetrics.sharpe,
      oosWinRate: allOOSAnalytics.winRate,
      oosMaxDD: allOOSMetrics.maxDrawdownPct,
      oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
      oosNetTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
      oosGrossTotalPnl: grossOOSTrades.reduce((s, t) => s + t.pnl, 0),
      holdoutTotalPnl: wr.holdoutTrades.reduce((s, t) => s + t.pnl, 0),
      holdoutNetTotalPnl: wr.holdoutTrades.reduce((s, t) => s + t.pnl, 0),
      holdoutGrossTotalPnl: grossHoldoutTrades.reduce((s, t) => s + t.pnl, 0),
      wfEfficiency,
      grade,
      tradeCount: allOOSTrades.length,
      exitTypeBreakdown,
      windowDetails: wr.selectionResults.map(w => ({
        windowIdx: w.windowIdx,
        trainSharpe: w.trainSharpe,
        oosSharpe: w.oosSharpe,
        oosWR: w.oosWR,
        oosMaxDD: w.oosMaxDD,
        oosTradeCount: w.oosTradeCount,
      })),
    });
  }

  console.log(`  ${results.length} configs evaluated successfully.`);
  return results;
}

// ── Report Generation ────────────────────────────────────

function formatPct(v: number, decimals = 1): string {
  return v.toFixed(decimals) + '%';
}

function printResults(results: SLStudyResult[], strategy: string) {
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`  ${strategy.toUpperCase()} STOP-LOSS STUDY RESULTS`);
  console.log(`${'═'.repeat(120)}`);

  console.log('\n  ' + 'Label'.padEnd(14) + 'Mechanism'.padEnd(18) +
    'IS'.padStart(8) + 'OOS Net'.padStart(10) + 'OOS Gross'.padStart(11) + 'Hold Net'.padStart(10) +
    'WR%'.padStart(8) + 'MaxDD'.padStart(8) + 'Trades'.padStart(8) + 'WFE'.padStart(8) + 'Grade'.padStart(7));
  console.log('  ' + '─'.repeat(118));

  // Sort by OOS Sharpe descending
  const sorted = [...results].sort((a, b) => b.oosSharpe - a.oosSharpe);
  for (const r of sorted) {
    const isBaseline = r.mechanism === 'baseline';
    const marker = isBaseline ? ' ◄' : '';
    console.log(
      '  ' + r.configLabel.padEnd(14) +
      r.mechanism.padEnd(18) +
      r.isSharpe.toFixed(2).padStart(8) +
      r.oosNetSharpe.toFixed(2).padStart(10) +
      r.oosGrossSharpe.toFixed(2).padStart(11) +
      r.holdoutNetSharpe.toFixed(2).padStart(10) +
      formatPct(r.oosWinRate).padStart(8) +
      formatPct(r.oosMaxDD).padStart(8) +
      String(r.tradeCount).padStart(8) +
      r.wfEfficiency.toFixed(2).padStart(8) +
      ('  ' + r.grade).padStart(7) +
      marker,
    );
  }

  // Per-mechanism summary
  const mechanisms = ['baseline', 'credit_multiple', 'delta_stop', 'max_loss_pct', 'trailing_lock'] as const;
  console.log(`\n${'─'.repeat(120)}`);
  console.log('  PER-MECHANISM BEST');
  console.log(`${'─'.repeat(120)}`);
  for (const mech of mechanisms) {
    const mechResults = results.filter(r => r.mechanism === mech);
    if (mechResults.length === 0) continue;
    const best = mechResults.reduce((a, b) => a.oosSharpe > b.oosSharpe ? a : b);
    console.log(
      `  ${mech.padEnd(18)} Best: ${best.configLabel.padEnd(12)} ` +
      `OOS Net ${best.oosNetSharpe.toFixed(2)} / Gross ${best.oosGrossSharpe.toFixed(2)} | Holdout Net ${best.holdoutNetSharpe.toFixed(2)} | ` +
      `WR ${formatPct(best.oosWinRate)} | Grade ${best.grade}`,
    );
  }

  // Exit type breakdown for baseline vs best non-baseline
  const baseline = results.find(r => r.mechanism === 'baseline');
  const bestNonBaseline = sorted.find(r => r.mechanism !== 'baseline');
  if (baseline && bestNonBaseline) {
    console.log(`\n${'─'.repeat(120)}`);
    console.log('  EXIT TYPE COMPARISON');
    console.log(`${'─'.repeat(120)}`);
    console.log(`  Baseline (${baseline.configLabel}):`);
    for (const [et, count] of Object.entries(baseline.exitTypeBreakdown).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${et.padEnd(20)} ${count} (${formatPct(count / baseline.tradeCount * 100)})`);
    }
    console.log(`  Best SL (${bestNonBaseline.configLabel}):`);
    for (const [et, count] of Object.entries(bestNonBaseline.exitTypeBreakdown).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${et.padEnd(20)} ${count} (${formatPct(count / bestNonBaseline.tradeCount * 100)})`);
    }
  }
}

function generateReport(swingResults: SLStudyResult[], shortResults: SLStudyResult[]): string {
  const lines: string[] = [];
  lines.push('# Stop-Loss WFA Study — Credit Spread Strategies');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  // Executive summary
  lines.push('## Executive Summary');
  lines.push('');
  lines.push('This study evaluates 4 stop-loss mechanisms across Swing (45-65 DTE) and Short-Term (7-21 DTE 130M) credit spread strategies.');
  lines.push('Methodology: Rolling WFA with IS/OOS selection windows + holdout validation.');
  lines.push(`Short-term outputs are ranked on net OOS Sharpe using ${SHORT_EXECUTION_LABEL} with $${SHORT_COMMISSION_PER_LEG.toFixed(2)} per leg per side.`);
  lines.push(`Swing outputs remain ${SWING_EXECUTION_LABEL}; gross and net are identical there until explicit costs are modeled.`);
  lines.push('');

  const allResults = [...swingResults, ...shortResults];
  const baselines = allResults.filter(r => r.mechanism === 'baseline');
  const nonBaselines = allResults.filter(r => r.mechanism !== 'baseline');
  const bestOverall = nonBaselines.length > 0
    ? nonBaselines.reduce((a, b) => a.oosSharpe > b.oosSharpe ? a : b)
    : null;

  if (baselines.length > 0) {
    lines.push('### Baseline (No SL)');
    for (const b of baselines) {
      lines.push(`- **${b.strategy}**: OOS Net ${b.oosNetSharpe.toFixed(2)} / Gross ${b.oosGrossSharpe.toFixed(2)}, Holdout Net ${b.holdoutNetSharpe.toFixed(2)} / Gross ${b.holdoutGrossSharpe.toFixed(2)}, WR ${formatPct(b.oosWinRate)}, Grade ${b.grade}`);
    }
    lines.push('');
  }

  if (bestOverall) {
    lines.push(`### Best SL Config: \`${bestOverall.configLabel}\` (${bestOverall.strategy})`);
    lines.push(`- Mechanism: ${bestOverall.mechanism}`);
    lines.push(`- OOS Net/Gross Sharpe: ${bestOverall.oosNetSharpe.toFixed(2)} / ${bestOverall.oosGrossSharpe.toFixed(2)}`);
    lines.push(`- Holdout Net/Gross Sharpe: ${bestOverall.holdoutNetSharpe.toFixed(2)} / ${bestOverall.holdoutGrossSharpe.toFixed(2)}`);
    lines.push(`- WR: ${formatPct(bestOverall.oosWinRate)}, MaxDD: ${formatPct(bestOverall.oosMaxDD)}`);
    lines.push(`- Grade: ${bestOverall.grade}`);
    lines.push('');
  }

  // Results tables
  for (const strategy of ['swing', 'short'] as const) {
    const results = strategy === 'swing' ? swingResults : shortResults;
    if (results.length === 0) continue;

    lines.push(`## ${strategy === 'swing' ? 'Swing' : 'Short-Term'} Results`);
    lines.push('');
    const executionLabel = strategy === 'swing' ? SWING_EXECUTION_LABEL : SHORT_EXECUTION_LABEL;
    lines.push(`- Execution model: ${executionLabel}`);
    lines.push(`- IV Rank method: ${IV_RANK_METHOD_MIN_MAX_252D}`);
    lines.push('');
    lines.push('| Label | Mechanism | IS Sharpe | OOS Net | OOS Gross | Holdout Net | Holdout Gross | WR% | MaxDD | Trades | WFE | Grade |');
    lines.push('|-------|-----------|-----------|---------|-----------|-------------|---------------|-----|-------|--------|-----|-------|');

    const sorted = [...results].sort((a, b) => b.oosSharpe - a.oosSharpe);
    for (const r of sorted) {
      lines.push(
        `| ${r.configLabel} | ${r.mechanism} | ${r.isSharpe.toFixed(2)} | ${r.oosNetSharpe.toFixed(2)} | ${r.oosGrossSharpe.toFixed(2)} | ${r.holdoutNetSharpe.toFixed(2)} | ${r.holdoutGrossSharpe.toFixed(2)} | ${formatPct(r.oosWinRate)} | ${formatPct(r.oosMaxDD)} | ${r.tradeCount} | ${r.wfEfficiency.toFixed(2)} | ${r.grade} |`,
      );
    }
    lines.push('');
  }

  // Methodology
  lines.push('## Methodology');
  lines.push('');
  lines.push('### SL Mechanisms Tested');
  lines.push('1. **Credit Multiple** (2×-15×): Close when spread cost reaches N× entry credit');
  lines.push('2. **Delta Stop** (0.50-0.80): Close when |short delta| exceeds threshold');
  lines.push('3. **Max Loss %** (25%-90%): Close when unrealized loss reaches X% of max possible loss');
  lines.push('4. **Trailing Lock**: Once profit hits activation %, set floor; close on retrace below floor');
  lines.push('');
  lines.push('### Execution and Reporting');
  lines.push(`- Swing arm: ${SWING_EXECUTION_LABEL}`);
  lines.push(`- Short arm: ${SHORT_EXECUTION_LABEL} with $${SHORT_COMMISSION_PER_LEG.toFixed(2)} per leg per side`);
  lines.push(`- IV Rank method: ${IV_RANK_METHOD_MIN_MAX_252D}`);
  lines.push('- Ranking metric: Net OOS Sharpe');
  lines.push('- Reports include both gross and net Sharpe / PnL fields');
  lines.push('');
  lines.push('### Overfitting Grade Rubric');
  lines.push('| Grade | Criteria |');
  lines.push('|-------|----------|');
  lines.push('| A | 6/6 checks pass |');
  lines.push('| B | 5/6 |');
  lines.push('| C | 4/6 |');
  lines.push('| D | 3/6 |');
  lines.push('| F | <3/6 |');
  lines.push('');
  lines.push('Checks: IS→OOS retention ≥40%, OOS Sharpe StdDev <1.0, all windows positive, sufficient trades, no extreme IS, OOS Sharpe >0.5');
  lines.push('');

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────

function parseArg(args: string[], name: string): string | undefined {
  // Support --name=value and --name value
  const eqMatch = args.find(a => a.startsWith(`--${name}=`));
  if (eqMatch) return eqMatch.split('=')[1];
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const tickerArg = parseArg(args, 'tickers');
  const tickers = tickerArg ? tickerArg.split(',') : DEFAULT_TICKERS;

  const strategyArg = parseArg(args, 'strategy') ?? 'both';

  console.log('WFA Stop-Loss Study');
  console.log('═'.repeat(60));
  console.log(`Tickers: ${tickers.join(', ')}`);
  console.log(`Strategy: ${strategyArg}`);
  console.log(`CPUs: ${os.cpus().length}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const slConfigs = buildSLConfigs();
  console.log(`SL configs: ${slConfigs.length}`);

  // Init chain cache
  initDB();

  const swingResults: SLStudyResult[] = [];
  const shortResults: SLStudyResult[] = [];

  try {
    // Run Swing arm
    if (strategyArg === 'swing' || strategyArg === 'both') {
      const results = await runStrategyArm('swing', tickers, slConfigs);
      swingResults.push(...results);
      printResults(results, 'swing');
    }

    // Run Short-Term arm
    if (strategyArg === 'short' || strategyArg === 'both') {
      // Fetch 130M data
      console.log('\nFetching 130M candle data...');
      const intradayDb = initIntradayDB();
      const shortTickerDataMap = new Map<string, ShortTickerData>();
      for (const ticker of tickers) {
        const td = await fetchShortTickerData(ticker, SHORT_PARAMS.dataStart, SHORT_PARAMS.endDate, intradayDb);
        shortTickerDataMap.set(ticker, td);
        process.stdout.write(` ${ticker}(${td.candles130m.length})`);
      }
      console.log(' done.');

      const results = await runStrategyArm('short', tickers, slConfigs, shortTickerDataMap);
      shortResults.push(...results);
      printResults(results, 'short-term');
    }

    // Save results
    const outDir = path.resolve(__dirname, '../backtesting history/credit-spread/reports/sl-study');
    fs.mkdirSync(outDir, { recursive: true });

    if (swingResults.length > 0) {
      fs.writeFileSync(path.join(outDir, 'swing-results.json'), JSON.stringify(swingResults, null, 2));
    }
    if (shortResults.length > 0) {
      fs.writeFileSync(path.join(outDir, 'short-results.json'), JSON.stringify(shortResults, null, 2));
    }

    // Summary
    const summary = {
      date: new Date().toISOString(),
      tickers,
      swingBest: swingResults.length > 0
        ? [...swingResults].sort((a, b) => b.oosSharpe - a.oosSharpe).slice(0, 5).map(r => ({
            label: r.configLabel,
            mechanism: r.mechanism,
            oosNetSharpe: r.oosNetSharpe,
            oosGrossSharpe: r.oosGrossSharpe,
            holdoutNetSharpe: r.holdoutNetSharpe,
            holdoutGrossSharpe: r.holdoutGrossSharpe,
            grade: r.grade,
            executionModel: r.executionModel,
            ivRankMethod: r.ivRankMethod,
          }))
        : [],
      shortBest: shortResults.length > 0
        ? [...shortResults].sort((a, b) => b.oosSharpe - a.oosSharpe).slice(0, 5).map(r => ({
            label: r.configLabel,
            mechanism: r.mechanism,
            oosNetSharpe: r.oosNetSharpe,
            oosGrossSharpe: r.oosGrossSharpe,
            holdoutNetSharpe: r.holdoutNetSharpe,
            holdoutGrossSharpe: r.holdoutGrossSharpe,
            grade: r.grade,
            executionModel: r.executionModel,
            ivRankMethod: r.ivRankMethod,
          }))
        : [],
    };
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

    // Report
    const report = generateReport(swingResults, shortResults);
    fs.writeFileSync(path.join(outDir, 'README.md'), report);

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Results saved to: ${outDir}`);
    console.log(`${'═'.repeat(60)}`);
  } finally {
    closeDB();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
