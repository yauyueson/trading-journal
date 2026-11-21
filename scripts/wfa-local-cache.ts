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

// ── NYSE calendar (rule-based, plus special closures) ───────────────────────
// Needed because the intraday vendor rows before 2024-03 carry full
// regular-session bars on exchange holidays, so a session-hours filter alone
// cannot drop them.

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return ymd(year, month, 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7);
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return ymd(year, month, lastDay - ((lastDow - weekday + 7) % 7));
}

function easterSunday(year: number): string {
  // Anonymous Gregorian algorithm.
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return ymd(year, month, ((h + l - 7 * m + 114) % 31) + 1);
}

/** Saturday holidays are observed Friday, Sunday holidays Monday. */
function observed(date: string): string {
  const dow = weekdayOf(date);
  if (dow === 6) return shiftDate(date, -1);
  if (dow === 0) return shiftDate(date, 1);
  return date;
}

const NYSE_SPECIAL_CLOSURES = new Set([
  '2018-12-05', // National day of mourning, President G.H.W. Bush
  '2025-01-09', // National day of mourning, President Carter
]);

const holidayCache = new Map<number, Set<string>>();

function nyseHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const days = new Set<string>();
  // New Year's Day: Sunday → Monday; Saturday is NOT observed on Dec 31.
  const newYear = ymd(year, 1, 1);
  if (weekdayOf(newYear) !== 6) days.add(observed(newYear));
  days.add(nthWeekdayOfMonth(year, 1, 1, 3));      // MLK Day
  days.add(nthWeekdayOfMonth(year, 2, 1, 3));      // Presidents' Day
  days.add(shiftDate(easterSunday(year), -2));     // Good Friday
  days.add(lastWeekdayOfMonth(year, 5, 1));        // Memorial Day
  if (year >= 2022) days.add(observed(ymd(year, 6, 19))); // Juneteenth
  days.add(observed(ymd(year, 7, 4)));             // Independence Day
  days.add(nthWeekdayOfMonth(year, 9, 1, 1));      // Labor Day
  days.add(nthWeekdayOfMonth(year, 11, 4, 4));     // Thanksgiving
  days.add(observed(ymd(year, 12, 25)));           // Christmas
  holidayCache.set(year, days);
  return days;
}

export function isNyseHoliday(date: string): boolean {
  return NYSE_SPECIAL_CLOSURES.has(date) || nyseHolidays(Number(date.slice(0, 4))).has(date);
}

/** Session close hour (ET) — 13 on early-close days, else 16. */
export function nyseSessionCloseHourET(date: string): number {
  const year = Number(date.slice(0, 4));
  const isOpenWeekday = (d: string) => weekdayOf(d) % 6 !== 0 && !isNyseHoliday(d);
  const dayAfterThanksgiving = shiftDate(nthWeekdayOfMonth(year, 11, 4, 4), 1);
  if (date === dayAfterThanksgiving) return 13;
  if ((date === ymd(year, 7, 3) || date === ymd(year, 12, 24)) && isOpenWeekday(date)) return 13;
  return 16;
}

const EASTERN_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

function toEastern(utcDatetime: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    EASTERN_PARTS.formatToParts(new Date(`${utcDatetime.replace(' ', 'T')}Z`)).map(p => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/**
 * Aggregate 1h bars into daily candles keyed by US/Eastern trading date.
 * Only bars whose open time falls in [09:00, session close) ET are used, so
 * after-hours bars never set the close and weekends / NYSE holidays are
 * dropped even if the vendor stored bars for them. Caveat: from ~2024-03 the
 * vendor's 09:00 ET bar spans 09:00-10:00 including 30 min of pre-market, so
 * open/high/low/volume can include pre-market prints after that date (close
 * is unaffected). Calendar rules are verified for 2017-2026 only.
 * Bucketing reads the `datetime` column ('YYYY-MM-DD HH:MM:SS' UTC bar-open).
 */
export function loadDailyCandlesFromIntradayCache(options: {
  ticker: string;
  startDate: string;
  endDate: string;
  intradayDbPath?: string;
}): BacktestCandle[] {
  const db = new Database(options.intradayDbPath ?? defaultIntradayDbPath(), { readonly: true });
  try {
    // Session bars never cross UTC midnight; the +1 day only keeps the
    // filter safe if that ever changes (non-session bars are dropped below).
    const bars = db.prepare(`
      SELECT timestamp, datetime, open, high, low, close, volume
      FROM candles_1h
      WHERE ticker = ? AND date >= ? AND date <= ?
      ORDER BY timestamp ASC
    `).all(options.ticker, options.startDate, shiftDate(options.endDate, 1)) as Array<{
      timestamp: number;
      datetime: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;

    const byDate = new Map<string, BacktestCandle>();
    for (const bar of bars) {
      const et = toEastern(bar.datetime);
      if (et.date < options.startDate || et.date > options.endDate) continue;
      if (weekdayOf(et.date) % 6 === 0 || isNyseHoliday(et.date)) continue;
      if (et.hour < 9 || et.hour >= nyseSessionCloseHourET(et.date)) continue;
      const day = byDate.get(et.date);
      if (!day) {
        byDate.set(et.date, {
          date: et.date,
          timestamp: Number(bar.timestamp),
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: Number(bar.volume),
        });
      } else {
        day.high = Math.max(day.high, Number(bar.high));
        day.low = Math.min(day.low, Number(bar.low));
        day.close = Number(bar.close);
        day.volume += Number(bar.volume);
      }
    }

    return requireRows([...byDate.values()], `${options.ticker} daily candles`);
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
