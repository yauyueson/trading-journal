import type { BacktestCandle } from './types';
import type { SimConfig } from './option-sim';
import { calcATR, emaFullSeries } from '../indicators';

export type UnderlyingStopDangerMode = 'breach' | 'atr';

export interface SerializedUnderlyingHistory {
  dates: string[];
  closes: number[];
  atr14: number[];
  emaByPeriod: Record<string, number[]>;
}

export interface IndexedUnderlyingHistory extends SerializedUnderlyingHistory {
  dateToIndex: Map<string, number>;
}

type UnderlyingStopConfigLike = Pick<
  SimConfig,
  | 'underlyingStopEMA'
  | 'underlyingStopConfirmDays'
  | 'underlyingStopDangerMode'
  | 'underlyingStopRequireSlope'
  | 'underlyingStopAtrMultiple'
>;

type UnderlyingTrendExitConfigLike = Pick<
  SimConfig,
  | 'underlyingExitEMA'
  | 'underlyingExitConfirmDays'
  | 'underlyingExitRequireSlope'
>;

export function buildUnderlyingHistory(
  candles: BacktestCandle[],
  emaPeriods: number[],
): SerializedUnderlyingHistory {
  const closes = candles.map(candle => candle.close);
  const highs = candles.map(candle => candle.high);
  const lows = candles.map(candle => candle.low);
  const uniquePeriods = [...new Set(emaPeriods.filter(period => Number.isFinite(period) && period > 0))];
  const emaByPeriod: Record<string, number[]> = {};
  for (const period of uniquePeriods) {
    emaByPeriod[String(period)] = emaFullSeries(closes, period);
  }
  return {
    dates: candles.map(candle => candle.date),
    closes,
    atr14: calcATR(highs, lows, closes, 14),
    emaByPeriod,
  };
}

export function indexUnderlyingHistories(
  raw: Record<string, SerializedUnderlyingHistory>,
): Record<string, IndexedUnderlyingHistory> {
  const indexed: Record<string, IndexedUnderlyingHistory> = {};
  for (const [ticker, history] of Object.entries(raw)) {
    indexed[ticker] = {
      ...history,
      dateToIndex: new Map(history.dates.map((date, index) => [date, index])),
    };
  }
  return indexed;
}

export function hasUnderlyingStop(config: UnderlyingStopConfigLike): boolean {
  return Number.isFinite(config.underlyingStopEMA) &&
    (config.underlyingStopDangerMode === 'breach' || config.underlyingStopDangerMode === 'atr');
}

export function hasUnderlyingTrendExit(config: UnderlyingTrendExitConfigLike): boolean {
  return Number.isFinite(config.underlyingExitEMA);
}

export function shouldExitUnderlyingTrend(
  ticker: string,
  date: string,
  direction: 'CALL' | 'PUT',
  config: UnderlyingTrendExitConfigLike,
  histories: Record<string, IndexedUnderlyingHistory> | undefined,
): boolean {
  if (!histories || !hasUnderlyingTrendExit(config)) return false;
  const history = histories[ticker];
  if (!history) return false;
  const idx = history.dateToIndex.get(date);
  if (idx == null) return false;

  const emaPeriod = Number(config.underlyingExitEMA);
  const emaSeries = history.emaByPeriod[String(emaPeriod)];
  if (!emaSeries) return false;

  const confirmDays = Math.max(1, config.underlyingExitConfirmDays ?? 1);
  if (idx - confirmDays + 1 < 0) return false;

  for (let cursor = idx - confirmDays + 1; cursor <= idx; cursor += 1) {
    const close = history.closes[cursor];
    const ema = emaSeries[cursor];
    if (!Number.isFinite(close) || !Number.isFinite(ema)) return false;
    const badTrend = direction === 'CALL'
      ? close < ema
      : close > ema;
    if (!badTrend) return false;
  }

  if (config.underlyingExitRequireSlope ?? false) {
    if (idx < 1) return false;
    const currentEMA = emaSeries[idx];
    const prevEMA = emaSeries[idx - 1];
    if (!Number.isFinite(currentEMA) || !Number.isFinite(prevEMA)) return false;
    const badSlope = direction === 'CALL'
      ? currentEMA <= prevEMA
      : currentEMA >= prevEMA;
    if (!badSlope) return false;
  }

  return true;
}

export function shouldExitUnderlyingStop(
  ticker: string,
  date: string,
  direction: 'CALL' | 'PUT',
  shortStrike: number,
  config: UnderlyingStopConfigLike,
  histories: Record<string, IndexedUnderlyingHistory> | undefined,
): boolean {
  if (!histories || !hasUnderlyingStop(config)) return false;
  const history = histories[ticker];
  if (!history) return false;
  const idx = history.dateToIndex.get(date);
  if (idx == null) return false;

  const trendExit = shouldExitUnderlyingTrend(
    ticker,
    date,
    direction,
    {
      underlyingExitEMA: config.underlyingStopEMA,
      underlyingExitConfirmDays: config.underlyingStopConfirmDays,
      underlyingExitRequireSlope: config.underlyingStopRequireSlope,
    },
    histories,
  );
  if (!trendExit) return false;

  const close = history.closes[idx];
  if (!Number.isFinite(close)) return false;
  if (config.underlyingStopDangerMode === 'breach') {
    return direction === 'CALL'
      ? close <= shortStrike
      : close >= shortStrike;
  }

  const atr = history.atr14[idx];
  if (!Number.isFinite(atr) || atr <= 0) return false;
  const atrMultiple = config.underlyingStopAtrMultiple ?? 1;
  return direction === 'CALL'
    ? close <= shortStrike + (atr * atrMultiple)
    : close >= shortStrike - (atr * atrMultiple);
}
