/**
 * WFA Short-DTE Worker — runs config evaluations in parallel
 *
 * Each worker opens its own SQLite connection and evaluates
 * SimConfigs on training signals. Returns sharpe + trade count
 * for each (window, config) combination.
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  initDB, closeDB, getCachedChain, findSpreadStrikes, findContract, findContractDirect,
} from '../src/lib/backtest/chain-cache.ts';
import {
  computeOptionAnalytics,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionExitType,
  type SignalPresetKey,
} from '../src/lib/backtest/option-sim.ts';
import type { FillMode } from '../src/lib/backtest/types.ts';
import { applyFill, applySpreadFill } from '../src/lib/backtest/slippage.ts';

// ── Types ────────────────────────────────────────────────

interface WorkerInit {
  signalsByPreset: Record<string, EntrySignal[]>;
  allTradingDates: string[];
  fillMode: FillMode;
}

interface WorkItem {
  id: number;
  configIdx: number;
  config: SimConfig;
  trainStart: string;
  trainEnd: string;
  maxDate: string;  // for OOS: allows positions to close after window
}

interface WorkResult {
  type: 'result';
  id: number;
  configIdx: number;
  sharpe: number;
  trades: number;
  winRate: number;
  totalPnl: number;
  maxDD: number;
  tradeData?: TradeExport[];  // only populated for OOS runs
}

interface TradeExport {
  ticker: string;
  entryDate: string;
  exitDate: string;
  pnl: number;
  pnlPct: number;
  holdDays: number;
  exitType: string;
  direction: string;
  entryDelta: number;
  entryDTE: number;
  strike: number;
  requestedSpreadWidth?: number;
  spreadWidth?: number;
  ivRank?: number;
}

// ── Initialization ──────────────────────────────────────

const { signalsByPreset, allTradingDates, fillMode } = workerData as WorkerInit;

// Build date index for O(1) lookups
const _dateIndex = new Map(allTradingDates.map((d, i) => [d, i]));

// Bounded LRU chain cache per worker
// Entry chain LRU — small (entry chains are ~1MB each)
const MAX_CHAIN_CACHE = 100;
const _chainMemo = new Map<string, ReturnType<typeof getCachedChain>>();

function getCachedChainMemo(ticker: string, date: string): ReturnType<typeof getCachedChain> {
  const key = `${ticker}|${date}`;
  const cached = _chainMemo.get(key);
  if (cached !== undefined) {
    _chainMemo.delete(key);
    _chainMemo.set(key, cached);
    return cached;
  }
  const rows = getCachedChain(ticker, date);
  if (_chainMemo.size >= MAX_CHAIN_CACHE) {
    const oldest = _chainMemo.keys().next().value;
    if (oldest) _chainMemo.delete(oldest);
  }
  _chainMemo.set(key, rows);
  return rows;
}

// Contract-level LRU — lightweight (single rows, ~200 bytes each)
const MAX_CONTRACT_CACHE = 50000;
const _contractMemo = new Map<string, ReturnType<typeof findContractDirect> | 'miss'>();

function findContractCached(
  ticker: string, date: string, strike: number, expiry: string, type: 'Call' | 'Put',
): ReturnType<typeof findContractDirect> {
  const key = `${ticker}|${date}|${strike}|${expiry}|${type}`;
  const cached = _contractMemo.get(key);
  if (cached !== undefined) {
    return cached === 'miss' ? null : cached;
  }
  const result = findContractDirect(ticker, date, strike, expiry, type);
  if (_contractMemo.size >= MAX_CONTRACT_CACHE) {
    const oldest = _contractMemo.keys().next().value;
    if (oldest) _contractMemo.delete(oldest);
  }
  _contractMemo.set(key, result ?? 'miss');
  return result;
}

// ── Trading Day Helpers ─────────────────────────────────

function advanceTradingDays(fromDate: string, n: number): string | null {
  const idx = _dateIndex.get(fromDate) ?? -1;
  if (idx < 0) {
    for (let i = 0; i < allTradingDates.length; i++) {
      if (allTradingDates[i] > fromDate) {
        return allTradingDates[Math.min(i + n - 1, allTradingDates.length - 1)] ?? null;
      }
    }
    return null;
  }
  const targetIdx = idx + n;
  return targetIdx < allTradingDates.length ? allTradingDates[targetIdx] : null;
}

function getMonitoringDates(entryDate: string, intervalDays: number, maxDate: string): string[] {
  const dates: string[] = [];
  let current = entryDate;
  while (true) {
    const next = advanceTradingDays(current, intervalDays);
    if (!next || next > maxDate) break;
    dates.push(next);
    current = next;
  }
  return dates;
}

// ── Sync Credit Spread Evaluator ────────────────────────

function evaluateSignal(
  signal: EntrySignal,
  config: SimConfig,
  maxDate: string,
): OptionTrade | null {
  if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) {
    return null;
  }

  const entryChain = getCachedChainMemo(signal.ticker, signal.date);
  if (entryChain.length === 0) return null;

  const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';

  const spread = findSpreadStrikes(
    entryChain, config.creditShortDelta, config.creditSpreadWidth,
    optionType, config.creditDTERange,
  );
  if (!spread || spread.netCredit <= 0) return null;

  // Liquidity filters
  if (config.maxBidAskSpreadPct != null && config.maxBidAskSpreadPct !== Infinity) {
    const shortSpreadPct = spread.short.mid > 0.10
      ? (spread.short.ask - spread.short.bid) / spread.short.mid : 0;
    if (shortSpreadPct > config.maxBidAskSpreadPct) return null;
  }
  if (config.minShortOI != null && config.minShortOI > 0) {
    if (spread.short.oi < config.minShortOI) return null;
  }

  // Fill model
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
  const monitorDates = getMonitoringDates(signal.date, config.monitoringIntervalDays, monitorEnd);
  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

  for (const checkDate of monitorDates) {
    const shortLeg = findContractCached(signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContractCached(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    if (!shortLeg || !longLeg) continue;

    let currentSpreadCost: number;
    if (fillMode === 'bidask' && config.slippage.enabled) {
      if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
        const spreadFill = applySpreadFill('bidask', shortLeg, longLeg, 'close', config.slippage);
        currentSpreadCost = spreadFill.fillPrice;
      } else {
        const shortClose = applyFill('bidask', shortLeg.mid, shortLeg.bid,
          shortLeg.ask, 'buy', config.slippage, shortLeg.oi, shortLeg.row.dte);
        const longClose = applyFill('bidask', longLeg.mid, longLeg.bid,
          longLeg.ask, 'sell', config.slippage, longLeg.oi, longLeg.row.dte);
        currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
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
      return buildTrade(signal, spread, entryCredit, checkDate, currentSpreadCost,
        currentDTE, shortLeg.row.stock_price, exitType, entrySlippage, dailyMtM);
    }
  }

  // Close at last monitoring date
  const lastDate = monitorDates[monitorDates.length - 1];
  if (lastDate) {
    const shortLeg = findContractCached(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContractCached(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);

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

    return buildTrade(signal, spread, entryCredit, lastDate, currentSpreadCost,
      shortLeg?.row.dte ?? 0, shortLeg?.row.stock_price ?? spread.short.row.stock_price,
      'EXPIRATION', entrySlippage, dailyMtM);
  }

  return null;
}

function buildTrade(
  signal: EntrySignal, spread: any, entryCredit: number,
  exitDate: string, exitSpreadCost: number, exitDTE: number,
  exitStockPrice: number, exitType: OptionExitType, entrySlippage: number,
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[],
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
    fillMode,
    dailyMtM,
  };
}

// ── Main Loop ───────────────────────────────────────────

initDB();
parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', (msg: WorkItem | { type: 'exit' }) => {
  if ('type' in msg && msg.type === 'exit') {
    closeDB();
    process.exit(0);
  }

  const item = msg as WorkItem;
  const presetKey = item.config.signalWeightPreset ?? 'ema';
  const allSignals = signalsByPreset[presetKey] ?? [];
  const trainSignals = allSignals.filter(
    s => s.date >= item.trainStart && s.date <= item.trainEnd,
  );

  const trades: OptionTrade[] = [];
  for (const signal of trainSignals) {
    const trade = evaluateSignal(signal, item.config, item.maxDate);
    if (trade) trades.push(trade);
  }

  const analytics = computeOptionAnalytics(trades);
  const result: WorkResult = {
    type: 'result',
    id: item.id,
    configIdx: item.configIdx,
    sharpe: analytics.dailyPortfolioSharpe ?? analytics.tradeSharpeLegacy,
    trades: analytics.totalTrades,
    winRate: analytics.winRate,
    totalPnl: analytics.totalPnl,
    maxDD: analytics.dailyMtMDrawdownPct ?? analytics.realizedExitDrawdownPct,
    tradeData: item.maxDate > item.trainEnd ? trades.map(t => ({
      ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
      pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
      exitType: t.exitType, direction: t.direction,
      entryDelta: t.entryDelta, entryDTE: t.entryDTE,
      strike: t.strike, requestedSpreadWidth: t.requestedSpreadWidth, spreadWidth: t.spreadWidth,
      ivRank: t.ivRank,
    })) : undefined,
  };
  parentPort!.postMessage(result);
});
