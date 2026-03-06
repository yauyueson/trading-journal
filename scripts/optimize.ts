/**
 * Multi-Ticker Parameter Optimizer
 *
 * Usage: npx tsx scripts/optimize.ts [--tickers SPY,QQQ,...] [--timeframe 1D] [--out results.json]
 *        npx tsx scripts/optimize.ts --walk-forward [--is-days 252] [--oos-days 63] [--mode anchored|rolling]
 *        npx tsx scripts/optimize.ts --ga-joint [--pop 60] [--gens 50]
 *
 * Modes:
 *   (default)       Grid sweep across multiple tickers, aggregate, rank
 *   --walk-forward  Walk-forward optimization with IS/OOS split (anti-overfit)
 *   --ga-joint      Joint GA optimization of indicator + trade params
 *
 * Outputs a ranked JSON report to stdout (or --out file).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env.local for Polygon API key
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim();
      if (key && !key.startsWith('#')) {
        process.env[key] = value;
      }
    }
  });
}

// @ts-ignore — JS module, no types
import { getCandles } from '../lib/polygon-client.js';

import type { BacktestCandle, SweepConfig, SweepResult, BacktestResult, Timeframe, WalkForwardConfig, WalkForwardResult } from '../src/lib/backtest/types';
import { runSweep, runGeneticOptimize, runTwoStageOptimize, runWalkForward, DEFAULT_SWEEP } from '../src/lib/backtest/sweep';
import { monteCarloPermutation } from '../src/lib/backtest/analytics';
import type { OptimizeConfig } from '../src/lib/backtest/types';

// ── CLI Args ────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD'];
const tickers = getArg('tickers', DEFAULT_TICKERS.join(',')).split(',').map(t => t.trim().toUpperCase());
const timeframe = getArg('timeframe', '1D') as Timeframe;
const outFile = getArg('out', '');
const startDate = getArg('start', '2024-01-01');
const endDate = getArg('end', new Date().toISOString().split('T')[0]);

// Mode flags
const useWalkForward = hasFlag('walk-forward');
const useGAJoint = hasFlag('ga-joint');
const isWindowDays = parseInt(getArg('is-days', '252'), 10);
const oosWindowDays = parseInt(getArg('oos-days', '63'), 10);
const wfMode = getArg('mode', 'anchored') as 'rolling' | 'anchored';
const gaPop = parseInt(getArg('pop', '60'), 10);
const gaGens = parseInt(getArg('gens', '50'), 10);

// ── Candle Fetching ─────────────────────────────────────

function addTradingDaysBack(dateStr: string, tradingDays: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - Math.ceil(tradingDays * 1.45));
  return d.toISOString().split('T')[0];
}

async function fetchCandles(ticker: string): Promise<BacktestCandle[]> {
  const lookbackDays = timeframe === '4H' ? 500 : 450;
  const fetchFrom = addTradingDaysBack(startDate, lookbackDays);
  const timespan = timeframe === '4H' ? 'hour' : 'day';
  const multiplier = timeframe === '4H' ? 4 : 1;

  console.error(`  Fetching ${ticker} candles (${fetchFrom} -> ${endDate}, ${timeframe})...`);
  const raw = await getCandles(ticker, fetchFrom, endDate, timespan, multiplier);

  const candles: BacktestCandle[] = raw.map((c: any) => {
    const ts = c.timestamp || c.t;
    const dateStr = timeframe === '4H'
      ? new Date(ts).toISOString().replace(/:\d{2}\.\d{3}Z$/, '')
      : (c.date || new Date(ts).toISOString().split('T')[0]);
    return {
      date: dateStr,
      timestamp: ts || new Date(c.date).getTime(),
      open: c.open ?? c.o,
      high: c.high ?? c.h,
      low: c.low ?? c.l,
      close: c.close ?? c.c,
      volume: c.volume ?? c.v ?? 0,
    };
  });

  console.error(`  -> ${candles.length} candles`);
  return candles;
}

// ── Config Key ──────────────────────────────────────────

function configKey(cfg: BacktestResult['config']): string {
  return `TP${cfg.tpAtr}_SL${cfg.slAtr}_SC${cfg.minScore}_CF${cfg.minConfidence}_D${cfg.thetaDecayRate}`;
}

// ── Aggregation ─────────────────────────────────────────

interface AggregatedConfig {
  key: string;
  tpAtr: number;
  slAtr: number;
  minScore: number;
  minConfidence: number;
  thetaDecayRate: number;
  tickers: {
    ticker: string;
    trades: number;
    winRate: number;
    winRateTheta: number;
    sharpe: number;
    sortino: number;
    profitFactor: number;
    maxDrawdown: number;
    avgHoldDays: number;
    avgReturn: number;
    avgReturnTheta: number;
    expectancy: number;
  }[];
  avgWinRate: number;
  avgWinRateTheta: number;
  avgSharpe: number;
  avgSortino: number;
  avgProfitFactor: number;
  avgMaxDrawdown: number;
  avgExpectancy: number;
  totalTrades: number;
  tickersWithTrades: number;
  compositeScore: number;
}

function aggregateResults(
  allResults: Map<string, { ticker: string; result: BacktestResult }[]>
): AggregatedConfig[] {
  const aggregated: AggregatedConfig[] = [];

  for (const [key, tickerResults] of allResults) {
    const meaningful = tickerResults.filter(tr => tr.result.analytics.totalTrades >= 3);
    if (meaningful.length < 2) continue;

    const sample = meaningful[0].result.config;
    const tickerStats = meaningful.map(tr => ({
      ticker: tr.ticker,
      trades: tr.result.analytics.totalTrades,
      winRate: tr.result.analytics.winRate,
      winRateTheta: tr.result.analytics.winRateTheta,
      sharpe: tr.result.analytics.sharpe,
      sortino: tr.result.analytics.sortino,
      profitFactor: tr.result.analytics.profitFactor,
      maxDrawdown: tr.result.analytics.maxDrawdown,
      avgHoldDays: tr.result.analytics.avgHoldDays,
      avgReturn: tr.result.analytics.avgReturn,
      avgReturnTheta: tr.result.analytics.avgReturnTheta,
      expectancy: tr.result.analytics.expectancy,
    }));

    const avgWinRate = tickerStats.reduce((s, t) => s + t.winRate, 0) / tickerStats.length;
    const avgWinRateTheta = tickerStats.reduce((s, t) => s + t.winRateTheta, 0) / tickerStats.length;
    const avgSharpe = tickerStats.reduce((s, t) => s + t.sharpe, 0) / tickerStats.length;
    const avgSortino = tickerStats.reduce((s, t) => s + t.sortino, 0) / tickerStats.length;
    const avgProfitFactor = tickerStats.reduce((s, t) => s + t.profitFactor, 0) / tickerStats.length;
    const avgMaxDrawdown = tickerStats.reduce((s, t) => s + t.maxDrawdown, 0) / tickerStats.length;
    const avgExpectancy = tickerStats.reduce((s, t) => s + t.expectancy, 0) / tickerStats.length;
    const totalTrades = tickerStats.reduce((s, t) => s + t.trades, 0);

    // Coverage + consistency
    const coveragePenalty = meaningful.length / tickerResults.length;
    const sharpeStdDev = Math.sqrt(
      tickerStats.reduce((s, t) => s + (t.sharpe - avgSharpe) ** 2, 0) / tickerStats.length
    );
    const consistencyBonus = avgSharpe > 0 ? 1 / (1 + sharpeStdDev) : 0;

    // Updated composite: uses Sortino + expectancy
    const compositeScore =
      0.25 * Math.max(0, Math.min(avgSortino, 3)) / 3 +
      0.20 * (avgWinRateTheta / 100) +
      0.15 * Math.min(avgProfitFactor, 5) / 5 +
      0.15 * Math.max(0, 1 - avgMaxDrawdown / 100) +
      0.10 * Math.max(0, Math.min(avgExpectancy, 5)) / 5 +
      0.10 * coveragePenalty +
      0.05 * consistencyBonus;

    aggregated.push({
      key,
      tpAtr: sample.tpAtr,
      slAtr: sample.slAtr,
      minScore: sample.minScore,
      minConfidence: sample.minConfidence,
      thetaDecayRate: sample.thetaDecayRate,
      tickers: tickerStats,
      avgWinRate,
      avgWinRateTheta,
      avgSharpe,
      avgSortino,
      avgProfitFactor,
      avgMaxDrawdown,
      avgExpectancy,
      totalTrades,
      tickersWithTrades: meaningful.length,
      compositeScore,
    });
  }

  return aggregated.sort((a, b) => b.compositeScore - a.compositeScore);
}

// ── Walk-Forward Mode ───────────────────────────────────

async function runWalkForwardMode() {
  console.error(`\n=== Walk-Forward Optimization ===`);
  console.error(`Mode: ${wfMode} | IS: ${isWindowDays}d | OOS: ${oosWindowDays}d`);
  console.error(`Tickers: ${tickers.join(', ')}`);
  console.error(`Period: ${startDate} -> ${endDate}\n`);

  const wfResults: { ticker: string; result: WalkForwardResult }[] = [];

  for (let ti = 0; ti < tickers.length; ti++) {
    const ticker = tickers[ti];
    if (ti > 0) {
      const waitSec = 13;
      console.error(`  Waiting ${waitSec}s for rate limit...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }

    try {
      const candles = await fetchCandles(ticker);
      if (candles.length < 450) {
        console.error(`  ${ticker}: Only ${candles.length} candles (need 450+), skipping`);
        continue;
      }

      const wfConfig: WalkForwardConfig = {
        ticker,
        startDate,
        endDate,
        timeframe,
        isWindowDays,
        oosWindowDays,
        mode: wfMode,
        optimizer: useGAJoint ? 'ga' : 'sweep',
        populationSize: gaPop,
        generations: gaGens,
        jointOptimize: useGAJoint,
      };

      console.error(`  Running WFO on ${ticker}...`);
      const result = runWalkForward(candles, wfConfig, (wi, total, phase) => {
        console.error(`    Window ${wi + 1}/${total} [${phase}]`);
      });

      wfResults.push({ ticker, result });

      const a = result.oosAnalytics;
      console.error(
        `  ${ticker}: ${result.windows.length} windows | ` +
        `OOS: ${a.totalTrades} trades, WR ${a.winRateTheta.toFixed(1)}%, ` +
        `Sortino ${a.sortino.toFixed(2)}, PF ${a.profitFactor.toFixed(2)}, ` +
        `DD ${a.maxDrawdown.toFixed(1)}% | ` +
        `WF Efficiency: ${(result.wfEfficiency * 100).toFixed(0)}% | ` +
        `${Math.round(result.elapsedMs)}ms`
      );
      if (result.monteCarlo) {
        const mc = result.monteCarlo;
        console.error(
          `    Monte Carlo (${mc.iterations}x): Sharpe p5=${mc.sharpe.p5.toFixed(2)} p50=${mc.sharpe.p50.toFixed(2)} | ` +
          `DD p95=${mc.maxDrawdown.p95.toFixed(1)}% | Significant: ${mc.isSignificant ? 'YES' : 'NO'}`
        );
      }
    } catch (err: any) {
      console.error(`  ${ticker}: ${err.message}`);
    }
  }

  const report = {
    meta: {
      mode: 'walk-forward',
      wfMode,
      isWindowDays,
      oosWindowDays,
      optimizer: useGAJoint ? 'ga-joint' : 'sweep',
      tickers,
      timeframe,
      period: { start: startDate, end: endDate },
      timestamp: new Date().toISOString(),
    },
    results: wfResults.map(r => ({
      ticker: r.ticker,
      windows: r.result.windows.length,
      oosAnalytics: {
        trades: r.result.oosAnalytics.totalTrades,
        winRate: r.result.oosAnalytics.winRate,
        winRateTheta: r.result.oosAnalytics.winRateTheta,
        sharpe: r.result.oosAnalytics.sharpe,
        sortino: r.result.oosAnalytics.sortino,
        calmar: r.result.oosAnalytics.calmar,
        profitFactor: r.result.oosAnalytics.profitFactor,
        maxDrawdown: r.result.oosAnalytics.maxDrawdown,
        expectancy: r.result.oosAnalytics.expectancy,
        maxConsecutiveLosses: r.result.oosAnalytics.maxConsecutiveLosses,
        avgHoldDays: r.result.oosAnalytics.avgHoldDays,
      },
      wfEfficiency: r.result.wfEfficiency,
      monteCarlo: r.result.monteCarlo,
      windowDetails: r.result.windows.map(w => ({
        isStart: w.isStart,
        isEnd: w.isEnd,
        oosStart: w.oosStart,
        oosEnd: w.oosEnd,
        isFitness: w.isBestFitness,
        oosTrades: w.oosResult.analytics.totalTrades,
        oosWinRate: w.oosResult.analytics.winRateTheta,
        oosSharpe: w.oosResult.analytics.sharpe,
        oosPF: w.oosResult.analytics.profitFactor,
        bestConfig: {
          tpAtr: w.isBestConfig.tpAtr,
          slAtr: w.isBestConfig.slAtr,
          minScore: w.isBestConfig.minScore,
          thetaDecayRate: w.isBestConfig.thetaDecayRate,
          indicatorOptions: w.isBestConfig.indicatorOptions,
        },
      })),
    })),
  };

  return report;
}

// ── GA Joint Mode ───────────────────────────────────────

async function runGAJointMode() {
  console.error(`\n=== Joint GA Optimization (Indicators + Trade Params) ===`);
  console.error(`Pop: ${gaPop} | Gens: ${gaGens}`);
  console.error(`Tickers: ${tickers.join(', ')}`);
  console.error(`Period: ${startDate} -> ${endDate}\n`);

  const gaResults: { ticker: string; best: BacktestResult | null; elapsed: number }[] = [];

  for (let ti = 0; ti < tickers.length; ti++) {
    const ticker = tickers[ti];
    if (ti > 0) {
      const waitSec = 13;
      console.error(`  Waiting ${waitSec}s for rate limit...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }

    try {
      const candles = await fetchCandles(ticker);
      if (candles.length < 350) {
        console.error(`  ${ticker}: Only ${candles.length} candles (need 350+), skipping`);
        continue;
      }

      const gaConfig: OptimizeConfig = {
        ticker,
        startDate,
        endDate,
        tpAtr: 2.5,
        slAtr: 1.5,
        minScore: 70,
        minConfidence: 0,
        thetaDecayRate: 0.03,
        populationSize: gaPop,
        generations: gaGens,
        jointOptimize: true,
      };

      console.error(`  Running joint GA on ${ticker}...`);
      const t0 = performance.now();
      const result = runGeneticOptimize(candles, gaConfig, (gen, total, bestFit) => {
        if (gen % 10 === 0) console.error(`    Gen ${gen}/${total} best=${bestFit.toFixed(4)}`);
      });
      const elapsed = performance.now() - t0;

      gaResults.push({ ticker, best: result.bestOverall, elapsed });

      if (result.bestOverall) {
        const a = result.bestOverall.analytics;
        const c = result.bestOverall.config;
        console.error(
          `  ${ticker}: TP=${c.tpAtr} SL=${c.slAtr} SC=${c.minScore} | ` +
          `${a.totalTrades} trades, WR ${a.winRateTheta.toFixed(1)}%, ` +
          `Sortino ${a.sortino.toFixed(2)}, PF ${a.profitFactor.toFixed(2)}, ` +
          `DD ${a.maxDrawdown.toFixed(1)}%, Expect ${a.expectancy.toFixed(2)}% | ` +
          `${Math.round(elapsed)}ms`
        );
      }
    } catch (err: any) {
      console.error(`  ${ticker}: ${err.message}`);
    }
  }

  return {
    meta: {
      mode: 'ga-joint',
      populationSize: gaPop,
      generations: gaGens,
      tickers,
      timeframe,
      period: { start: startDate, end: endDate },
      timestamp: new Date().toISOString(),
    },
    results: gaResults.map(r => ({
      ticker: r.ticker,
      elapsed: Math.round(r.elapsed),
      best: r.best ? {
        config: {
          tpAtr: r.best.config.tpAtr,
          slAtr: r.best.config.slAtr,
          minScore: r.best.config.minScore,
          thetaDecayRate: r.best.config.thetaDecayRate,
          indicatorOptions: r.best.config.indicatorOptions,
        },
        analytics: {
          trades: r.best.analytics.totalTrades,
          winRate: r.best.analytics.winRate,
          winRateTheta: r.best.analytics.winRateTheta,
          sharpe: r.best.analytics.sharpe,
          sortino: r.best.analytics.sortino,
          calmar: r.best.analytics.calmar,
          profitFactor: r.best.analytics.profitFactor,
          maxDrawdown: r.best.analytics.maxDrawdown,
          expectancy: r.best.analytics.expectancy,
          maxConsecutiveLosses: r.best.analytics.maxConsecutiveLosses,
          avgHoldDays: r.best.analytics.avgHoldDays,
        },
      } : null,
    })),
  };
}

// ── Default Sweep Mode ──────────────────────────────────

async function runSweepMode() {
  console.error(`\n=== Multi-Ticker Parameter Sweep ===`);
  console.error(`Tickers: ${tickers.join(', ')}`);
  console.error(`Timeframe: ${timeframe}`);
  console.error(`Period: ${startDate} -> ${endDate}`);

  const sweepBase: Omit<SweepConfig, 'ticker' | 'startDate' | 'endDate' | 'timeframe'> = {
    ...DEFAULT_SWEEP,
    tpAtrRange: [1.5, 2.0, 2.5, 3.0],
    slAtrRange: [0.8, 1.0, 1.5, 2.0],
    minScoreRange: [60, 65, 70, 75, 80],
    minConfidenceRange: [1, 2],
    setupGroups: [['All']],
    thetaDecayRange: [0.02, 0.03, 0.05],
  };

  const totalCombos = sweepBase.tpAtrRange.length *
    sweepBase.slAtrRange.length * sweepBase.minScoreRange.length *
    sweepBase.minConfidenceRange.length * sweepBase.setupGroups.length *
    sweepBase.thetaDecayRange.length;
  console.error(`Sweep: ${totalCombos} parameter combos x ${tickers.length} tickers = ${totalCombos * tickers.length} total runs\n`);

  const allResults = new Map<string, { ticker: string; result: BacktestResult }[]>();
  const tickerSummaries: { ticker: string; candles: number; trades: number; elapsed: number }[] = [];

  for (let ti = 0; ti < tickers.length; ti++) {
    const ticker = tickers[ti];
    if (ti > 0) {
      const waitSec = 13;
      console.error(`  Waiting ${waitSec}s for rate limit...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
    try {
      const candles = await fetchCandles(ticker);
      const minBars = timeframe === '4H' ? 700 : 350;
      if (candles.length < minBars) {
        console.error(`  ${ticker}: Only ${candles.length} candles (need ${minBars}+), skipping`);
        continue;
      }

      const sweepConfig: SweepConfig = {
        ...sweepBase,
        ticker,
        startDate,
        endDate,
        timeframe,
      };

      console.error(`  Running sweep on ${ticker}...`);
      const t0 = performance.now();
      const sweepResult: SweepResult = runSweep(candles, sweepConfig);
      const elapsed = performance.now() - t0;

      let totalTrades = 0;
      for (const result of sweepResult.results) {
        const key = configKey(result.config);
        if (!allResults.has(key)) allResults.set(key, []);
        allResults.get(key)!.push({ ticker, result });
        totalTrades += result.analytics.totalTrades;
      }

      tickerSummaries.push({ ticker, candles: candles.length, trades: totalTrades, elapsed: Math.round(elapsed) });
      console.error(`  ${ticker}: ${sweepResult.results.length} configs, ${Math.round(elapsed)}ms`);
    } catch (err: any) {
      console.error(`  ${ticker}: ${err.message}`);
    }
  }

  console.error(`\nAggregating ${allResults.size} unique configs across ${tickerSummaries.length} tickers...`);
  const ranked = aggregateResults(allResults);

  const report = {
    meta: {
      mode: 'sweep',
      tickers,
      tickersProcessed: tickerSummaries.map(t => t.ticker),
      timeframe,
      period: { start: startDate, end: endDate },
      totalCombosPerTicker: totalCombos,
      totalRuns: totalCombos * tickerSummaries.length,
      timestamp: new Date().toISOString(),
    },
    tickerSummaries,
    top20: ranked.slice(0, 20),
    best: ranked[0] || null,
  };

  // Print summary
  console.error(`\n=== Top 5 Universal Configs ===`);
  for (const cfg of ranked.slice(0, 5)) {
    console.error(
      `  ${cfg.key.padEnd(30)} | Score: ${cfg.compositeScore.toFixed(3)} | ` +
      `WR: ${cfg.avgWinRateTheta.toFixed(1)}% | Sortino: ${cfg.avgSortino.toFixed(2)} | ` +
      `PF: ${cfg.avgProfitFactor.toFixed(2)} | DD: ${cfg.avgMaxDrawdown.toFixed(1)}% | ` +
      `Expect: ${cfg.avgExpectancy.toFixed(2)}% | ` +
      `Trades: ${cfg.totalTrades} across ${cfg.tickersWithTrades} tickers`
    );
  }

  if (ranked[0]) {
    console.error(`\n=== Best Config ===`);
    const b = ranked[0];
    console.error(`  TP ATR: ${b.tpAtr}`);
    console.error(`  SL ATR: ${b.slAtr}`);
    console.error(`  Min Score: ${b.minScore}`);
    console.error(`  Min Confidence: ${b.minConfidence}`);
    console.error(`  Theta Decay: ${b.thetaDecayRate}`);
    console.error(`\n  Per-ticker breakdown:`);
    for (const t of b.tickers) {
      console.error(
        `    ${t.ticker.padEnd(6)} | WR: ${t.winRateTheta.toFixed(1)}% | ` +
        `Sortino: ${t.sortino.toFixed(2)} | PF: ${t.profitFactor.toFixed(2)} | ` +
        `DD: ${t.maxDrawdown.toFixed(1)}% | Expect: ${t.expectancy.toFixed(2)}% | ` +
        `${t.trades} trades | Avg Hold: ${t.avgHoldDays.toFixed(1)}d`
      );
    }
  }

  return report;
}

// ── Main ────────────────────────────────────────────────

async function main() {
  let report: any;

  if (useWalkForward) {
    report = await runWalkForwardMode();
  } else if (useGAJoint && !useWalkForward) {
    report = await runGAJointMode();
  } else {
    report = await runSweepMode();
  }

  const json = JSON.stringify(report, null, 2);
  if (outFile) {
    fs.writeFileSync(outFile, json);
    console.error(`\nResults written to ${outFile}`);
  } else {
    console.log(json);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
