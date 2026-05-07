import path from 'path';
import Database from 'better-sqlite3';

import type { BacktestCandle } from '../src/lib/backtest/types';
import type { IVDataRow } from '../src/lib/backtest/intraday-signals';
import { computeIVRankMinMax } from '../src/lib/backtest/iv-rank';

export type LocalSwingTickerData = {
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
};

type DailyClose = {
  date: string;
  close: number;
};

type LocalCachePaths = {
  intradayDbPath?: string;
  chainDbPath?: string;
};

function defaultIntradayDbPath(): string {
  return path.resolve(process.cwd(), 'data/intraday-candles.sqlite');
}

function defaultChainDbPath(): string {
  return path.resolve(process.cwd(), 'data/option-chains.sqlite');
}

function requireRows<T>(rows: T[], label: string): T[] {
  if (rows.length === 0) {
    throw new Error(`Local WFA cache missing required rows: ${label}`);
  }
  return rows;
}

function round(value: number, digits = 10): number {
  return Number(value.toFixed(digits));
}

export function loadDailyCandlesFromIntradayCache(options: {
  ticker: string;
  startDate: string;
  endDate: string;
  intradayDbPath?: string;
}): BacktestCandle[] {
  const db = new Database(options.intradayDbPath ?? defaultIntradayDbPath(), { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT
        ticker,
        date,
        MIN(timestamp) AS timestamp,
        (
          SELECT open FROM candles_1h first_bar
          WHERE first_bar.ticker = candles_1h.ticker AND first_bar.date = candles_1h.date
          ORDER BY timestamp ASC LIMIT 1
        ) AS open,
        MAX(high) AS high,
        MIN(low) AS low,
        (
          SELECT close FROM candles_1h last_bar
          WHERE last_bar.ticker = candles_1h.ticker AND last_bar.date = candles_1h.date
          ORDER BY timestamp DESC LIMIT 1
        ) AS close,
        SUM(volume) AS volume
      FROM candles_1h
      WHERE ticker = ?
        AND date >= ?
        AND date <= ?
      GROUP BY ticker, date
      ORDER BY date ASC
    `).all(options.ticker, options.startDate, options.endDate) as Array<{
      ticker: string;
      date: string;
      timestamp: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;

    return requireRows(rows, `${options.ticker} daily candles`)
      .map(row => ({
        date: row.date,
        timestamp: Number(row.timestamp),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      }));
  } finally {
    db.close();
  }
}

function annualizedHistoricalVol(
  closes: DailyClose[],
  idx: number,
  lookback: number,
): number | null {
  const start = Math.max(1, idx - lookback + 1);
  const returns: number[] = [];
  for (let i = start; i <= idx; i++) {
    const prev = closes[i - 1]?.close;
    const cur = closes[i]?.close;
    if (prev && cur && prev > 0 && cur > 0) returns.push(Math.log(cur / prev));
  }
  if (returns.length === 0) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

function percentileRank(history: number[], value: number): number | undefined {
  if (history.length === 0 || !Number.isFinite(value)) return undefined;
  return (history.filter(item => item <= value).length / history.length) * 100;
}

export function loadIVDataFromOptionChainCache(options: {
  ticker: string;
  startDate: string;
  endDate: string;
  chainDbPath?: string;
  dailyCandles: DailyClose[];
}): IVDataRow[] {
  const db = new Database(options.chainDbPath ?? defaultChainDbPath(), { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT
        trade_date AS date,
        dte,
        AVG((COALESCE(call_iv, put_iv) + COALESCE(put_iv, call_iv)) / 2.0) AS iv
      FROM option_chains
      WHERE ticker = ?
        AND trade_date >= ?
        AND trade_date <= ?
        AND dte BETWEEN 20 AND 70
        AND (call_iv IS NOT NULL OR put_iv IS NOT NULL)
      GROUP BY trade_date, dte
      ORDER BY trade_date ASC, dte ASC
    `).all(options.ticker, options.startDate, options.endDate) as Array<{
      date: string;
      dte: number;
      iv: number | null;
    }>;

    const byDate = new Map<string, Array<{ dte: number; iv: number }>>();
    for (const row of rows) {
      if (row.iv == null || !Number.isFinite(Number(row.iv))) continue;
      const bucket = byDate.get(row.date) ?? [];
      bucket.push({ dte: Number(row.dte), iv: Number(row.iv) });
      byDate.set(row.date, bucket);
    }
    const daily = requireRows(options.dailyCandles, `${options.ticker} daily candles for realized volatility`);
    const output: IVDataRow[] = [];

    for (let i = 0; i < daily.length; i++) {
      const chain = byDate.get(daily[i].date) ?? [];
      const iv30d = nearestIV(chain, 30, 10);
      const iv60d = nearestIV(chain, 60, 10);
      if (iv30d == null || iv60d == null) continue;
      output.push({
        date: daily[i].date,
        iv30d: round(iv30d),
        iv60d: round(iv60d),
        hv20d: annualizedHistoricalVol(daily, i, 20),
        hv30d: annualizedHistoricalVol(daily, i, 30),
        hv60d: annualizedHistoricalVol(daily, i, 60),
      });
    }

    return requireRows(output, `${options.ticker} option-chain IV proxy`);
  } finally {
    db.close();
  }
}

function nearestIV(rows: Array<{ dte: number; iv: number }>, targetDTE: number, toleranceDTE: number): number | null {
  let best: { distance: number; iv: number } | null = null;
  for (const row of rows) {
    const distance = Math.abs(row.dte - targetDTE);
    if (distance > toleranceDTE) continue;
    if (!best || distance < best.distance) best = { distance, iv: row.iv };
  }
  return best?.iv ?? null;
}

function rollingPercentile(values: (number | undefined)[], lookback = 252): (number | undefined)[] {
  const history: number[] = [];
  return values.map(value => {
    const rank = value != null ? percentileRank(history.slice(-lookback), value) : undefined;
    if (value != null && Number.isFinite(value)) history.push(value);
    return rank;
  });
}

export function buildLocalSwingTickerData(options: {
  ticker: string;
  dataStart: string;
  dataEnd: string;
} & LocalCachePaths): LocalSwingTickerData {
  const candles = loadDailyCandlesFromIntradayCache({
    ticker: options.ticker,
    startDate: options.dataStart,
    endDate: options.dataEnd,
    intradayDbPath: options.intradayDbPath,
  });
  const ivData = loadIVDataFromOptionChainCache({
    ticker: options.ticker,
    startDate: options.dataStart,
    endDate: options.dataEnd,
    chainDbPath: options.chainDbPath,
    dailyCandles: candles,
  });

  const ivByDate = new Map(ivData.map(row => [row.date, row.iv30d]));
  const regimeByDate = new Map<string, {
    vrp?: number;
    contango?: number;
    vrpPct?: number;
    contangoPct?: number;
  }>();
  const vrpValues = candles.map(candle => {
    const row = ivData.find(item => item.date === candle.date);
    if (!row || row.iv30d == null || row.hv30d == null) return undefined;
    return (row.iv30d * row.iv30d) - (row.hv30d * row.hv30d);
  });
  const contangoValues = candles.map(candle => {
    const row = ivData.find(item => item.date === candle.date);
    if (!row || row.iv30d == null || row.iv60d == null || row.iv30d <= 0) return undefined;
    return (row.iv60d / row.iv30d) - 1;
  });
  const vrpPct = rollingPercentile(vrpValues);
  const contangoPct = rollingPercentile(contangoValues);

  for (let i = 0; i < candles.length; i++) {
    const vrp = vrpValues[i];
    const contango = contangoValues[i];
    if (vrp == null && contango == null) continue;
    regimeByDate.set(candles[i].date, {
      vrp,
      contango,
      vrpPct: vrpPct[i],
      contangoPct: contangoPct[i],
    });
  }

  const ivSeries = candles.map(candle => ivByDate.get(candle.date) ?? null);
  return {
    ticker: options.ticker,
    candles,
    ivRanks: computeIVRankMinMax(ivSeries),
    dateToIdx: new Map(candles.map((candle, index) => [candle.date, index])),
    regimeByDate,
  };
}
