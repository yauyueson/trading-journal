/**
 * Dedicated Walk-Forward Test — Single Config, All Windows
 *
 * Runs specific configs through every WFA window unconditionally.
 * No training selection, no top-K filter — pure OOS evaluation.
 * This eliminates selection bias from the stability analysis.
 *
 * Usage:
 *   npx tsx scripts/wfa-dedicated-test.ts
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

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

import { SIGNAL_PRESETS, DIR_CONF_THRESHOLDS } from '../src/lib/backtest/types';
import type { FillMode, SignalPresetKey } from '../src/lib/backtest/types';
import {
  initDB, closeDB, getCachedChain, findSpreadStrikes, findContractDirect,
} from '../src/lib/backtest/chain-cache';
import {
  initIntradayDB, get4HCandles, get130MRawCandles, get130MCandles, aggregateToDaily,
  type IntradayCandle,
} from '../src/lib/backtest/intraday-cache';
import {
  precomputeSignals4H, type IVDataRow,
} from '../src/lib/backtest/intraday-signals';
import {
  DEFAULT_SHORT_CREDIT_CONFIG, computeOptionAnalytics,
  type EntrySignal, type OptionTrade, type SimConfig,
} from '../src/lib/backtest/option-sim';
import { evaluateCreditSpread4H } from '../src/lib/backtest/intraday-monitor';
import { applyFill } from '../src/lib/backtest/slippage';
import { buildWFAWindows, computePortfolioDailyMetrics } from '../src/lib/backtest/wfa-options';

// ── Config ───────────────────────────────────────────────

const ALL_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA',
  'AMZN', 'MSFT', 'META', 'NFLX', 'GOOGL', 'GS', 'COST',
];

const WFA = {
  dataStart: '2023-01-01',
  startDate: '2024-03-01',
  endDate: '2026-02-28',
  trainWindowDays: 189,
  forwardStepDays: 42,
  purgeGapDays: 14,
  mode: 'rolling' as const,
  maxPositions: 10,
  maxPerTicker: 5,
  startingCapital: 100_000,
  fillMode: 'mid' as FillMode,
};

// Configs to test — the top stable configs from the comprehensive comparison
interface TestConfig {
  label: string;
  timeframe: '4H' | '130M';
  preset: SignalPresetKey;
  periodMultiplier: number;
  simConfig: SimConfig;
}

const TEST_CONFIGS: TestConfig[] = [
  {
    label: '130M #1: mf|tp30|w10|iv0|dsoff|pm2.25',
    timeframe: '130M',
    preset: 'mf',
    periodMultiplier: 2.25,
    simConfig: {
      ...DEFAULT_SHORT_CREDIT_CONFIG,
      creditDTERange: [7, 21] as [number, number],
      creditSpreadWidth: 10,
      creditProfitTarget: 0.30,
      creditStopLossMultiple: 100,
      creditTimeStopDTE: 1,
      creditDeltaStop: 0,
      minIVRank: 0,
      signalWeightPreset: 'mf',
      fillMode: 'mid',
      maxPerTicker: 5,
      maxPositions: 10,
      indicatorPeriodMultiplier: 2.25,
      bsmKappa: 4.0,
      bsmRiskFreeRate: 0.04,
      dailyCalibration: true,
      ivThetaSource: 'hv60',
    } as SimConfig,
  },
  {
    label: '130M #2: mom|tp30|w10|iv0|dsoff|pm2.25',
    timeframe: '130M',
    preset: 'mom',
    periodMultiplier: 2.25,
    simConfig: {
      ...DEFAULT_SHORT_CREDIT_CONFIG,
      creditDTERange: [7, 21] as [number, number],
      creditSpreadWidth: 10,
      creditProfitTarget: 0.30,
      creditStopLossMultiple: 100,
      creditTimeStopDTE: 1,
      creditDeltaStop: 0,
      minIVRank: 0,
      signalWeightPreset: 'mom',
      fillMode: 'mid',
      maxPerTicker: 5,
      maxPositions: 10,
      indicatorPeriodMultiplier: 2.25,
      bsmKappa: 4.0,
      bsmRiskFreeRate: 0.04,
      dailyCalibration: true,
      ivThetaSource: 'hv60',
    } as SimConfig,
  },
  {
    label: '130M #3: em|tp50|w10|iv20|dsoff|pm2.25',
    timeframe: '130M',
    preset: 'em',
    periodMultiplier: 2.25,
    simConfig: {
      ...DEFAULT_SHORT_CREDIT_CONFIG,
      creditDTERange: [7, 21] as [number, number],
      creditSpreadWidth: 10,
      creditProfitTarget: 0.50,
      creditStopLossMultiple: 100,
      creditTimeStopDTE: 1,
      creditDeltaStop: 0,
      minIVRank: 20,
      signalWeightPreset: 'em',
      fillMode: 'mid',
      maxPerTicker: 5,
      maxPositions: 10,
      indicatorPeriodMultiplier: 2.25,
      bsmKappa: 4.0,
      bsmRiskFreeRate: 0.04,
      dailyCalibration: true,
      ivThetaSource: 'hv60',
    } as SimConfig,
  },
  {
    label: '4H #1: em|tp50|w10|iv0|dsoff|pm1.5',
    timeframe: '4H',
    preset: 'em',
    periodMultiplier: 1.5,
    simConfig: {
      ...DEFAULT_SHORT_CREDIT_CONFIG,
      creditDTERange: [7, 21] as [number, number],
      creditSpreadWidth: 10,
      creditProfitTarget: 0.50,
      creditStopLossMultiple: 100,
      creditTimeStopDTE: 1,
      creditDeltaStop: 0,
      minIVRank: 0,
      signalWeightPreset: 'em',
      fillMode: 'mid',
      maxPerTicker: 5,
      maxPositions: 10,
      indicatorPeriodMultiplier: 1.5,
      bsmKappa: 4.0,
      bsmRiskFreeRate: 0.04,
      dailyCalibration: true,
      ivThetaSource: 'hv60',
    } as SimConfig,
  },
];

// ── Helpers ──────────────────────────────────────────────

const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

async function supabaseGet(table: string, query: string): Promise<any[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${query}`, {
        headers: { apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}` },
      });
      if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
      return res.json();
    } catch (err: any) {
      if (attempt < 2 && (err.cause?.code === 'EPIPE' || err.cause?.code === 'ECONNRESET' || err.message?.includes('fetch failed'))) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  return [];
}

function get130MHybrid(db: any, ticker: string, startDate: string, endDate: string): IntradayCandle[] {
  let rawCandles = get130MRawCandles(db, ticker, startDate, endDate);
  if (rawCandles.length === 0 && ticker === 'GOOGL') {
    rawCandles = get130MRawCandles(db, 'GOOG', startDate, endDate);
  }
  const rawMaxDate = rawCandles.length > 0 ? rawCandles[rawCandles.length - 1].date : startDate;
  if (rawMaxDate >= endDate) return rawCandles;

  let viewCandles = get130MCandles(db, ticker, rawMaxDate, endDate);
  if (viewCandles.length === 0 && ticker === 'GOOGL') {
    viewCandles = get130MCandles(db, 'GOOG', rawMaxDate, endDate);
  }
  const seen = new Set(rawCandles.map(c => c.timestamp));
  const merged = [...rawCandles];
  for (const c of viewCandles) {
    if (!seen.has(c.timestamp)) { merged.push(c); seen.add(c.timestamp); }
  }
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}

interface TickerData {
  ticker: string;
  candles: IntradayCandle[];
  dailyCandles: IntradayCandle[];
  ivData: IVDataRow[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

function computeIVRank(ivSeries: (number | null)[]): (number | null)[] {
  const window = 252;
  return ivSeries.map((v, i) => {
    if (i < window || v == null) return null;
    const sample = ivSeries.slice(i - window, i + 1).filter((x): x is number => x != null);
    if (sample.length < 100) return null;
    const min = Math.min(...sample);
    const max = Math.max(...sample);
    const range = max - min;
    return range > 0 ? ((v - min) / range) * 100 : 50;
  });
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(80));
  console.log('  DEDICATED WALK-FORWARD TEST — SINGLE CONFIG, ALL WINDOWS');
  console.log('  No training selection. No top-K filter. Pure OOS evaluation.');
  console.log(`  Tickers: ${ALL_TICKERS.length} | Period: ${WFA.startDate} → ${WFA.endDate}`);
  console.log('═'.repeat(80));

  // Ensure views
  const dbPath = path.resolve(process.cwd(), 'data', 'intraday-candles.sqlite');
  const rwDb = new Database(dbPath);
  rwDb.exec(`DROP VIEW IF EXISTS candles_4h`);
  rwDb.exec(`
    CREATE VIEW IF NOT EXISTS candles_4h AS
    SELECT ticker, MIN(timestamp) AS timestamp, MIN(datetime) AS datetime, date,
      CASE WHEN CAST(SUBSTR(datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END AS block,
      (SELECT c2.open FROM candles_1h c2 WHERE c2.ticker = c1.ticker AND c2.date = c1.date
         AND CAST(SUBSTR(c2.datetime, 12, 2) AS INTEGER) BETWEEN 13 AND 20
         AND (CASE WHEN CAST(SUBSTR(c2.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END) =
             (CASE WHEN CAST(SUBSTR(c1.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END)
       ORDER BY c2.timestamp ASC LIMIT 1) AS open,
      MAX(high) AS high, MIN(low) AS low,
      (SELECT c3.close FROM candles_1h c3 WHERE c3.ticker = c1.ticker AND c3.date = c1.date
         AND CAST(SUBSTR(c3.datetime, 12, 2) AS INTEGER) BETWEEN 13 AND 20
         AND (CASE WHEN CAST(SUBSTR(c3.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END) =
             (CASE WHEN CAST(SUBSTR(c1.datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END)
       ORDER BY c3.timestamp DESC LIMIT 1) AS close,
      SUM(volume) AS volume
    FROM candles_1h c1
    WHERE CAST(SUBSTR(datetime, 12, 2) AS INTEGER) BETWEEN 13 AND 20
    GROUP BY ticker, date, CASE WHEN CAST(SUBSTR(datetime, 12, 2) AS INTEGER) < 17 THEN 0 ELSE 1 END;
  `);
  rwDb.close();

  initDB(); closeDB();
  const intradayDb = initIntradayDB();

  try {
    // Load data for both timeframes
    console.log('\n  Loading data...');

    const data4H = new Map<string, TickerData>();
    const data130M = new Map<string, TickerData>();

    for (const ticker of ALL_TICKERS) {
      // 4H
      let candles4H = get4HCandles(intradayDb, ticker, WFA.dataStart, WFA.endDate);
      if (candles4H.length === 0 && ticker === 'GOOGL') candles4H = get4HCandles(intradayDb, 'GOOG', WFA.dataStart, WFA.endDate);
      const daily4H = aggregateToDaily(candles4H);

      // 130M hybrid
      const candles130M = get130MHybrid(intradayDb, ticker, WFA.dataStart, WFA.endDate);
      const daily130M = aggregateToDaily(candles130M);

      // IV data (shared)
      const ivDbRows = await supabaseGet(
        'orats_iv_cache',
        `select=date,iv30d,iv60d,hv20d,hv30d,hv60d&ticker=eq.${ticker}&date=gte.${WFA.dataStart}&date=lte.${WFA.endDate}&order=date.asc&limit=5000`,
      );
      const ivData: IVDataRow[] = ivDbRows.map((r: any) => ({
        date: r.date, iv30d: r.iv30d, iv60d: r.iv60d, hv20d: r.hv20d, hv30d: r.hv30d, hv60d: r.hv60d,
      }));

      // IV ranks from 4H daily (longer series)
      const ivByDate = new Map(ivData.map(r => [r.date, r.iv30d]));

      const ivSeries4H = daily4H.map(c => ivByDate.get(c.date) ?? null);
      const ivRanks4H = computeIVRank(ivSeries4H);
      data4H.set(ticker, {
        ticker, candles: candles4H, dailyCandles: daily4H, ivData, ivRanks: ivRanks4H,
        dateToIdx: new Map(daily4H.map((c, i) => [c.date, i])),
      });

      const ivSeries130M = daily130M.map(c => ivByDate.get(c.date) ?? null);
      const ivRanks130M = computeIVRank(ivSeries130M);
      data130M.set(ticker, {
        ticker, candles: candles130M, dailyCandles: daily130M, ivData, ivRanks: ivRanks130M,
        dateToIdx: new Map(daily130M.map((c, i) => [c.date, i])),
      });

      process.stdout.write(`  ${ticker} `);
    }
    console.log('  Done.\n');

    // Build trading dates and WFA windows for each timeframe
    function buildDatesAndWindows(dataMap: Map<string, TickerData>) {
      const allDatesSet = new Set<string>();
      for (const td of dataMap.values()) {
        for (const c of td.dailyCandles) {
          if (c.date >= WFA.startDate && c.date <= WFA.endDate) allDatesSet.add(c.date);
        }
      }
      const allTradingDates = [...allDatesSet].sort();
      const windowDefs = buildWFAWindows(allTradingDates, {
        trainWindowDays: WFA.trainWindowDays,
        forwardStepDays: WFA.forwardStepDays,
        purgeGapDays: WFA.purgeGapDays,
        mode: WFA.mode,
        startDate: WFA.startDate,
        endDate: WFA.endDate,
      });
      return { allTradingDates, windowDefs };
    }

    const wfa4H = buildDatesAndWindows(data4H);
    const wfa130M = buildDatesAndWindows(data130M);

    // Signal generation
    function generateSignals(
      dataMap: Map<string, TickerData>,
      presetKey: SignalPresetKey,
      periodMultiplier: number,
      periodStart: string,
      periodEnd: string,
    ): EntrySignal[] {
      const techOptions = SIGNAL_PRESETS[presetKey];
      const entries: EntrySignal[] = [];

      for (const td of dataMap.values()) {
        const signals = precomputeSignals4H(td.candles, td.ivData, periodMultiplier, techOptions);
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
            hv60: sig.ivEstimate60,
            oratsIV60: sig.oratsIV60,
            indicatorPeriodMultiplier: periodMultiplier,
            dirConfidence: sig.subScores
              ? Math.round(Object.values(sig.subScores).filter(v => v > 50).length / Object.values(sig.subScores).length * 100)
              : undefined,
          });
        }
      }

      // Dedupe
      const deduped = new Map<string, EntrySignal>();
      for (const entry of entries) {
        const key = `${entry.ticker}|${entry.date}|${entry.direction}`;
        if (!deduped.has(key) || entry.score > deduped.get(key)!.score) {
          deduped.set(key, entry);
        }
      }
      return [...deduped.values()].sort((a, b) => a.date.localeCompare(b.date));
    }

    // Evaluator
    function makeEvaluator(dataMap: Map<string, TickerData>) {
      return (signal: EntrySignal, config: SimConfig, tradingDates: string[], maxDate: string) => {
        const td = dataMap.get(signal.ticker);
        if (!td) return null;
        return evaluateCreditSpread4H(signal, config, td.candles, tradingDates, maxDate, {
          getChain: (ticker, date) => getCachedChain(ticker, date),
          findSpread: (chain, shortDelta, width, type, dteRange) =>
            findSpreadStrikes(chain, shortDelta, width, type as 'Call' | 'Put', dteRange),
          findContract: (ticker, date, strike, expiry, type) =>
            findContractDirect(ticker, date, strike, expiry, type as 'Call' | 'Put'),
          applyFillFn: (mid, bid, ask, side, cfg, oi, dte) =>
            applyFill(WFA.fillMode, mid, bid, ask, side, cfg, oi, dte),
        });
      };
    }

    // ── Run each config through ALL windows ──────────────

    for (const tc of TEST_CONFIGS) {
      const is130M = tc.timeframe === '130M';
      const dataMap = is130M ? data130M : data4H;
      const { allTradingDates, windowDefs } = is130M ? wfa130M : wfa4H;

      console.log('─'.repeat(80));
      console.log(`  ${tc.label}`);
      console.log(`  Timeframe: ${tc.timeframe} | Windows: ${windowDefs.length} | Preset: ${tc.preset} | PM: ${tc.periodMultiplier}`);
      console.log('─'.repeat(80));

      // Generate signals once for the full period
      const signals = generateSignals(dataMap, tc.preset, tc.periodMultiplier, WFA.startDate, WFA.endDate);
      console.log(`  Total signals: ${signals.length}`);

      const evaluator = makeEvaluator(dataMap);
      const allOOSTrades: OptionTrade[] = [];

      interface WindowResult {
        trainStart: string; trainEnd: string;
        oosStart: string; oosEnd: string;
        trainSharpe: number; trainTrades: number; trainWR: number;
        oosSharpe: number; oosTrades: number; oosWR: number; oosPnl: number;
        degradation: number;
      }

      const windowResults: WindowResult[] = [];

      for (let wi = 0; wi < windowDefs.length; wi++) {
        const w = windowDefs[wi];

        // Train phase — compute IS metrics (informational, not used for selection)
        const trainSignals = signals.filter(s => s.date >= w.trainStart && s.date <= w.trainEnd);
        const trainTrades: OptionTrade[] = [];
        for (const signal of trainSignals) {
          const trade = evaluator(signal, tc.simConfig, allTradingDates, w.trainEnd);
          if (trade) trainTrades.push(trade);
        }
        const trainAnalytics = computeOptionAnalytics(trainTrades);
        const trainSharpe = trainAnalytics.dailyPortfolioSharpe ?? trainAnalytics.tradeSharpeLegacy;

        // OOS phase — the real test
        const oosSignals = signals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
        const oosTrades: OptionTrade[] = [];
        const openPositions: OptionTrade[] = [];

        for (const signal of oosSignals) {
          for (let j = openPositions.length - 1; j >= 0; j--) {
            if (openPositions[j].exitDate <= signal.date) openPositions.splice(j, 1);
          }
          if (openPositions.length >= WFA.maxPositions) continue;
          if (openPositions.filter(t => t.ticker === signal.ticker).length >= WFA.maxPerTicker) continue;

          const trade = evaluator(signal, tc.simConfig, allTradingDates, WFA.endDate);
          if (trade) { oosTrades.push(trade); openPositions.push(trade); }
        }

        const oosAnalytics = computeOptionAnalytics(oosTrades);
        const oosSharpe = oosAnalytics.dailyPortfolioSharpe ?? oosAnalytics.tradeSharpeLegacy;
        const oosPnl = oosTrades.reduce((s, t) => s + t.pnl, 0);

        windowResults.push({
          trainStart: w.trainStart, trainEnd: w.trainEnd,
          oosStart: w.oosStart, oosEnd: w.oosEnd,
          trainSharpe, trainTrades: trainTrades.length, trainWR: trainAnalytics.winRate,
          oosSharpe, oosTrades: oosTrades.length, oosWR: oosAnalytics.winRate, oosPnl,
          degradation: trainSharpe > 0.1 ? oosSharpe / trainSharpe : 0,
        });
        allOOSTrades.push(...oosTrades);
      }

      // Print per-window results
      console.log('\n  #   Train Period          OOS Period            IS Shrp  IS WR%  IS Trd | OOS Shrp  OOS WR%  OOS Trd  OOS P&L   Degrad');
      console.log('  ' + '·'.repeat(115));

      for (let i = 0; i < windowResults.length; i++) {
        const r = windowResults[i];
        const pnlStr = (r.oosPnl >= 0 ? '+$' : '-$') + Math.abs(r.oosPnl).toFixed(0);
        console.log(
          `  ${String(i + 1).padStart(2)}  ${r.trainStart} → ${r.trainEnd}  ${r.oosStart} → ${r.oosEnd}` +
          `  ${r.trainSharpe.toFixed(2).padStart(7)}  ${r.trainWR.toFixed(1).padStart(5)}%  ${String(r.trainTrades).padStart(5)}` +
          ` | ${r.oosSharpe.toFixed(2).padStart(8)}  ${r.oosWR.toFixed(1).padStart(5)}%  ${String(r.oosTrades).padStart(6)}  ${pnlStr.padStart(8)}  ${r.degradation.toFixed(2).padStart(7)}`
        );
      }

      // Aggregate
      const portfolioMetrics = computePortfolioDailyMetrics(
        allOOSTrades, allTradingDates, WFA.startDate, WFA.endDate, WFA.startingCapital,
      );
      const aggAnalytics = computeOptionAnalytics(allOOSTrades);
      const oosResults = windowResults.filter(r => r.oosTrades > 0);
      const avgOOS = oosResults.length > 0 ? oosResults.reduce((s, r) => s + r.oosSharpe, 0) / oosResults.length : 0;
      const pctPositive = oosResults.length > 0 ? oosResults.filter(r => r.oosSharpe > 0).length / oosResults.length * 100 : 0;
      const oosStdDev = oosResults.length > 1
        ? Math.sqrt(oosResults.reduce((s, r) => s + (r.oosSharpe - avgOOS) ** 2, 0) / oosResults.length)
        : 0;
      const degradations = oosResults.map(r => r.degradation).sort((a, b) => a - b);
      const medianDeg = degradations.length > 0 ? degradations[Math.floor(degradations.length / 2)] : 0;

      console.log('\n  ── AGGREGATE ──');
      console.log(`  Portfolio Sharpe:    ${portfolioMetrics.sharpe.toFixed(2)}`);
      console.log(`  Win Rate:            ${aggAnalytics.winRate.toFixed(1)}%`);
      console.log(`  Max DD:              ${portfolioMetrics.maxDrawdownPct.toFixed(1)}%`);
      console.log(`  Total P&L:           $${allOOSTrades.reduce((s, t) => s + t.pnl, 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
      console.log(`  Total OOS Trades:    ${allOOSTrades.length}`);
      console.log(`  Avg OOS Sharpe:      ${avgOOS.toFixed(2)}`);
      console.log(`  OOS Sharpe StdDev:   ${oosStdDev.toFixed(3)}`);
      console.log(`  Median Degradation:  ${medianDeg.toFixed(2)}`);
      console.log(`  Positive OOS:        ${pctPositive.toFixed(0)}% (${oosResults.filter(r => r.oosSharpe > 0).length}/${oosResults.length} windows)`);

      // Overfitting verdict
      console.log('\n  ── OVERFITTING VERDICT ──');
      const checks = [
        { name: 'IS→OOS retention (>40%)', pass: medianDeg >= 0.4, detail: `${(medianDeg * 100).toFixed(0)}%` },
        { name: 'OOS consistency (StdDev<1.0)', pass: oosStdDev < 1.0, detail: oosStdDev.toFixed(3) },
        { name: 'All windows positive', pass: pctPositive === 100, detail: `${pctPositive.toFixed(0)}%` },
        { name: 'Sufficient trades (>100)', pass: allOOSTrades.length >= 100, detail: String(allOOSTrades.length) },
        { name: 'No extreme IS (avg IS<5)', pass: windowResults.reduce((s, r) => s + r.trainSharpe, 0) / windowResults.length < 5, detail: (windowResults.reduce((s, r) => s + r.trainSharpe, 0) / windowResults.length).toFixed(2) },
        { name: 'Portfolio Sharpe>0.5', pass: portfolioMetrics.sharpe > 0.5, detail: portfolioMetrics.sharpe.toFixed(2) },
      ];

      let passCount = 0;
      for (const c of checks) {
        console.log(`  ${c.pass ? '[PASS]' : '[FAIL]'} ${c.name}: ${c.detail}`);
        if (c.pass) passCount++;
      }

      const grade = passCount === 6 ? 'A — Likely generalizable'
        : passCount === 5 ? 'B — Low overfitting risk'
        : passCount === 4 ? 'C — Moderate risk'
        : passCount === 3 ? 'D — High risk'
        : 'F — Likely overfit';
      console.log(`\n  GRADE: ${grade} (${passCount}/6 checks passed)\n`);
    }

  } finally {
    intradayDb.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
