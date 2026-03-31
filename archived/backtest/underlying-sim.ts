import type { EntrySignal, SignalPresetKey } from './option-sim';
import type { BacktestCandle } from './types';
import {
  buildUnderlyingHistory,
  indexUnderlyingHistories,
  shouldExitUnderlyingTrend,
  type IndexedUnderlyingHistory,
} from './underlying-stop';

export type UnderlyingExitType = 'PROFIT_TARGET' | 'UNDERLYING_EXIT' | 'TIME_STOP' | 'END_OF_WINDOW';

export interface UnderlyingDailyMark {
  date: string;
  close: number;
  unrealizedPnl: number;
}

export interface UnderlyingTrade {
  ticker: string;
  direction: 'CALL' | 'PUT';
  entryDate: string;
  entrySignalScore: number;
  entrySignalPreset?: SignalPresetKey;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  exitType: UnderlyingExitType;
  pnlDollar: number;
  pnlPct: number;
  holdDays: number;
  notional: number;
  shares: number;
  dailyMtM: UnderlyingDailyMark[];
  signalWeightPreset?: SignalPresetKey;
  windowIndex?: number;
}

export interface UnderlyingSimConfig {
  signalWeightPreset?: SignalPresetKey;
  signalSourcePresets?: SignalPresetKey[];
  signalSourceLabel?: string;
  pb21RouterMode?: string;
  underlyingExitEMA: number;
  underlyingExitConfirmDays: number;
  underlyingExitRequireSlope: boolean;
  maxHoldDays: number;
  profitTargetPct?: number;
  minDirConfidence?: number;
  maxEntryD8?: number;
  maxRecentGapPct?: number;
  minEntryVrpPct?: number;
  maxEntryContangoPct?: number;
  pb21RankingBonus?: number;
  maxPositions?: number;
}

export interface UnderlyingPortfolioDailyMetrics {
  sharpe: number;
  maxDrawdownPct: number;
  equityCurve: { date: string; equity: number }[];
  dailyReturns: number[];
}

export interface UnderlyingSimAnalytics {
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  totalPnl: number;
  avgPnlPct: number;
  avgHoldDays: number;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

export function buildIndexedUnderlyingHistory(
  candles: BacktestCandle[],
  emaPeriods: number[],
): IndexedUnderlyingHistory {
  return indexUnderlyingHistories({
    history: buildUnderlyingHistory(candles, emaPeriods),
  }).history;
}

export function simulateUnderlyingTrade(
  signal: EntrySignal,
  candles: BacktestCandle[],
  indexedHistory: IndexedUnderlyingHistory,
  config: UnderlyingSimConfig,
  maxDate: string,
  notional = 10_000,
): UnderlyingTrade | null {
  const entryIdx = indexedHistory.dateToIndex.get(signal.date);
  if (entryIdx == null) return null;

  const entryCandle = candles[entryIdx];
  if (!entryCandle || entryCandle.date > maxDate || entryCandle.close <= 0) return null;

  const entryPrice = entryCandle.close;
  const shares = notional / entryPrice;
  const dailyMtM: UnderlyingDailyMark[] = [];

  for (let index = entryIdx + 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.date > maxDate) break;

    const unrealizedPnl = signal.direction === 'CALL'
      ? (candle.close - entryPrice) * shares
      : (entryPrice - candle.close) * shares;
    dailyMtM.push({
      date: candle.date,
      close: candle.close,
      unrealizedPnl,
    });

    const heldTradingDays = index - entryIdx;
    let exitType: UnderlyingExitType | null = null;
    if (
      config.profitTargetPct != null &&
      unrealizedPnl >= notional * config.profitTargetPct
    ) {
      exitType = 'PROFIT_TARGET';
    } else if (shouldExitUnderlyingTrend(
      signal.ticker,
      candle.date,
      signal.direction,
      {
        underlyingExitEMA: config.underlyingExitEMA,
        underlyingExitConfirmDays: config.underlyingExitConfirmDays,
        underlyingExitRequireSlope: config.underlyingExitRequireSlope,
      },
      { [signal.ticker]: indexedHistory },
    )) {
      exitType = 'UNDERLYING_EXIT';
    } else if (heldTradingDays >= config.maxHoldDays) {
      exitType = 'TIME_STOP';
    }

    if (exitType) {
      return buildUnderlyingTrade(signal, entryPrice, candle.date, candle.close, exitType, shares, notional, dailyMtM);
    }
  }

  const lastCandle = candles
    .slice(entryIdx + 1)
    .filter(candle => candle.date <= maxDate)
    .slice(-1)[0];
  if (!lastCandle) return null;
  return buildUnderlyingTrade(
    signal,
    entryPrice,
    lastCandle.date,
    lastCandle.close,
    'END_OF_WINDOW',
    shares,
    notional,
    dailyMtM,
  );
}

function buildUnderlyingTrade(
  signal: EntrySignal,
  entryPrice: number,
  exitDate: string,
  exitPrice: number,
  exitType: UnderlyingExitType,
  shares: number,
  notional: number,
  dailyMtM: UnderlyingDailyMark[],
): UnderlyingTrade {
  const pnlDollar = signal.direction === 'CALL'
    ? (exitPrice - entryPrice) * shares
    : (entryPrice - exitPrice) * shares;
  const holdDays = Math.round(
    (new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000,
  );
  return {
    ticker: signal.ticker,
    direction: signal.direction,
    entryDate: signal.date,
    entrySignalScore: signal.score,
    entrySignalPreset: signal.sourcePreset,
    entryPrice,
    exitDate,
    exitPrice,
    exitType,
    pnlDollar,
    pnlPct: pnlDollar / notional,
    holdDays,
    notional,
    shares,
    dailyMtM,
  };
}

export function computeUnderlyingAnalytics(trades: UnderlyingTrade[]): UnderlyingSimAnalytics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winners: 0,
      losers: 0,
      winRate: 0,
      totalPnl: 0,
      avgPnlPct: 0,
      avgHoldDays: 0,
    };
  }

  const winners = trades.filter(trade => trade.pnlDollar > 0).length;
  const losers = trades.length - winners;
  return {
    totalTrades: trades.length,
    winners,
    losers,
    winRate: winners / trades.length,
    totalPnl: trades.reduce((sum, trade) => sum + trade.pnlDollar, 0),
    avgPnlPct: trades.reduce((sum, trade) => sum + trade.pnlPct, 0) / trades.length,
    avgHoldDays: trades.reduce((sum, trade) => sum + trade.holdDays, 0) / trades.length,
  };
}

export function computeUnderlyingPortfolioDailyMetrics(
  trades: UnderlyingTrade[],
  allTradingDates: string[],
  startDate: string,
  endDate: string,
  startingCapital: number,
): UnderlyingPortfolioDailyMetrics {
  const dates = allTradingDates.filter(date => date >= startDate && date <= endDate);
  if (dates.length === 0) {
    return { sharpe: 0, maxDrawdownPct: 0, equityCurve: [], dailyReturns: [] };
  }

  const dateIdx = new Map(dates.map((date, index) => [date, index]));
  const dailyPnl = new Array<number>(dates.length).fill(0);

  for (const trade of trades) {
    let contributed = 0;
    let prevUnrealized = 0;
    for (const mtm of trade.dailyMtM) {
      const idx = dateIdx.get(mtm.date);
      const change = mtm.unrealizedPnl - prevUnrealized;
      if (idx !== undefined) {
        dailyPnl[idx] += change;
        contributed += change;
      }
      prevUnrealized = mtm.unrealizedPnl;
    }

    const residual = trade.pnlDollar - contributed;
    const exitIdx = dateIdx.get(trade.exitDate);
    if (exitIdx !== undefined) dailyPnl[exitIdx] += residual;
  }

  const dailyReturns: number[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  let equity = startingCapital;
  let peak = startingCapital;
  let maxDrawdown = 0;

  for (let index = 0; index < dates.length; index += 1) {
    const prevEquity = equity;
    equity += dailyPnl[index];
    dailyReturns.push(prevEquity > 0 ? dailyPnl[index] / prevEquity : 0);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    equityCurve.push({ date: dates[index], equity });
  }

  const avgReturn = dailyReturns.length > 0
    ? dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
    : 0;
  const stdReturn = std(dailyReturns);
  const sharpe = stdReturn > 1e-10 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  return {
    sharpe,
    maxDrawdownPct: maxDrawdown * 100,
    equityCurve,
    dailyReturns,
  };
}
