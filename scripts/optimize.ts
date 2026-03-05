/**
 * Multi-Ticker Parameter Optimizer
 *
 * Usage: npx tsx scripts/optimize.ts [--tickers SPY,QQQ,...] [--timeframe 4H|1D] [--out results.json]
 *
 * Runs a full parameter sweep across multiple tickers, aggregates results,
 * and finds the parameter set that performs best universally.
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

import type { BacktestCandle, SweepConfig, SweepResult, BacktestResult, Timeframe } from '../src/lib/backtest/types';
import { runSweep, DEFAULT_SWEEP } from '../src/lib/backtest/sweep';

// ── CLI Args ────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD'];
const tickers = getArg('tickers', DEFAULT_TICKERS.join(',')).split(',').map(t => t.trim().toUpperCase());
const timeframe = getArg('timeframe', '1D') as Timeframe;
const outFile = getArg('out', '');
const startDate = getArg('start', '2024-01-01');
const endDate = getArg('end', new Date().toISOString().split('T')[0]);

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

  console.error(`  Fetching ${ticker} candles (${fetchFrom} → ${endDate}, ${timeframe})...`);
  const raw = await getCandles(ticker, fetchFrom, endDate, timespan, multiplier);

  const candles: BacktestCandle[] = raw.map((c: any) => {
    const ts = c.timestamp || c.t;
    // For 4H bars, include time in date string so aggregate4HToDaily can group by day
    const dateStr = timeframe === '4H'
      ? new Date(ts).toISOString().replace(/:\d{2}\.\d{3}Z$/, '') // YYYY-MM-DDTHH:mm
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

  console.error(`  → ${candles.length} candles`);
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
  // Per-ticker results
  tickers: {
    ticker: string;
    trades: number;
    winRate: number;
    winRateTheta: number;
    sharpe: number;
    profitFactor: number;
    maxDrawdown: number;
    avgHoldDays: number;
    avgReturn: number;
    avgReturnTheta: number;
  }[];
  // Aggregated across tickers
  avgWinRate: number;
  avgWinRateTheta: number;
  avgSharpe: number;
  avgProfitFactor: number;
  avgMaxDrawdown: number;
  totalTrades: number;
  tickersWithTrades: number;
  // Composite score for ranking
  compositeScore: number;
}

function aggregateResults(
  allResults: Map<string, { ticker: string; result: BacktestResult }[]>
): AggregatedConfig[] {
  const aggregated: AggregatedConfig[] = [];

  for (const [key, tickerResults] of allResults) {
    const meaningful = tickerResults.filter(tr => tr.result.analytics.totalTrades >= 3);
    if (meaningful.length < 2) continue; // Need at least 2 tickers with trades

    const sample = meaningful[0].result.config;
    const tickerStats = meaningful.map(tr => ({
      ticker: tr.ticker,
      trades: tr.result.analytics.totalTrades,
      winRate: tr.result.analytics.winRate,
      winRateTheta: tr.result.analytics.winRateTheta,
      sharpe: tr.result.analytics.sharpe,
      profitFactor: tr.result.analytics.profitFactor,
      maxDrawdown: tr.result.analytics.maxDrawdown,
      avgHoldDays: tr.result.analytics.avgHoldDays,
      avgReturn: tr.result.analytics.avgReturn,
      avgReturnTheta: tr.result.analytics.avgReturnTheta,
    }));

    const avgWinRate = tickerStats.reduce((s, t) => s + t.winRate, 0) / tickerStats.length;
    const avgWinRateTheta = tickerStats.reduce((s, t) => s + t.winRateTheta, 0) / tickerStats.length;
    const avgSharpe = tickerStats.reduce((s, t) => s + t.sharpe, 0) / tickerStats.length;
    const avgProfitFactor = tickerStats.reduce((s, t) => s + t.profitFactor, 0) / tickerStats.length;
    const avgMaxDrawdown = tickerStats.reduce((s, t) => s + t.maxDrawdown, 0) / tickerStats.length;
    const totalTrades = tickerStats.reduce((s, t) => s + t.trades, 0);

    // Composite: weighted average favoring consistency across tickers
    // Penalize configs that only work on 1-2 tickers
    const coveragePenalty = meaningful.length / tickerResults.length; // 1.0 = works on all tickers
    const sharpeStdDev = Math.sqrt(
      tickerStats.reduce((s, t) => s + (t.sharpe - avgSharpe) ** 2, 0) / tickerStats.length
    );
    const consistencyBonus = avgSharpe > 0 ? 1 / (1 + sharpeStdDev) : 0;

    const compositeScore =
      0.30 * Math.max(0, avgSharpe) +
      0.20 * (avgWinRateTheta / 100) +
      0.20 * Math.min(avgProfitFactor, 5) / 5 +
      0.15 * Math.max(0, 1 - avgMaxDrawdown / 100) +
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
      avgProfitFactor,
      avgMaxDrawdown,
      totalTrades,
      tickersWithTrades: meaningful.length,
      compositeScore,
    });
  }

  return aggregated.sort((a, b) => b.compositeScore - a.compositeScore);
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.error(`\n=== Multi-Ticker Parameter Optimizer ===`);
  console.error(`Tickers: ${tickers.join(', ')}`);
  console.error(`Timeframe: ${timeframe}`);
  console.error(`Period: ${startDate} → ${endDate}`);

  const sweepBase: Omit<SweepConfig, 'ticker' | 'startDate' | 'endDate' | 'timeframe'> = {
    ...DEFAULT_SWEEP,
    // Wider sweep for optimization
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
  console.error(`Sweep: ${totalCombos} parameter combos × ${tickers.length} tickers = ${totalCombos * tickers.length} total runs\n`);

  // Collect all results keyed by config
  const allResults = new Map<string, { ticker: string; result: BacktestResult }[]>();
  const tickerSummaries: { ticker: string; candles: number; trades: number; elapsed: number }[] = [];

  for (let ti = 0; ti < tickers.length; ti++) {
    const ticker = tickers[ti];
    // Rate limit: wait between fetches to respect Polygon's 5 RPM limit
    if (ti > 0) {
      const waitSec = 13; // 60s/5RPM + buffer
      console.error(`  ⏳ Waiting ${waitSec}s for rate limit...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
    try {
      const candles = await fetchCandles(ticker);
      const minBars = timeframe === '4H' ? 700 : 350;
      if (candles.length < minBars) {
        console.error(`  ⚠ ${ticker}: Only ${candles.length} candles (need ${minBars}+), skipping`);
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

      tickerSummaries.push({
        ticker,
        candles: candles.length,
        trades: totalTrades,
        elapsed: Math.round(elapsed),
      });

      console.error(`  ✓ ${ticker}: ${sweepResult.results.length} configs, ${Math.round(elapsed)}ms`);
    } catch (err: any) {
      console.error(`  ✗ ${ticker}: ${err.message}`);
    }
  }

  // Aggregate and rank
  console.error(`\nAggregating ${allResults.size} unique configs across ${tickerSummaries.length} tickers...`);
  const ranked = aggregateResults(allResults);

  const report = {
    meta: {
      tickers: tickers,
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

  const json = JSON.stringify(report, null, 2);

  if (outFile) {
    fs.writeFileSync(outFile, json);
    console.error(`\nResults written to ${outFile}`);
  } else {
    console.log(json);
  }

  // Print summary to stderr
  console.error(`\n=== Top 5 Universal Configs ===`);
  for (const cfg of ranked.slice(0, 5)) {
    console.error(
      `  ${cfg.key.padEnd(30)} | Score: ${cfg.compositeScore.toFixed(3)} | ` +
      `WR: ${cfg.avgWinRateTheta.toFixed(1)}% | Sharpe: ${cfg.avgSharpe.toFixed(2)} | ` +
      `PF: ${cfg.avgProfitFactor.toFixed(2)} | DD: ${cfg.avgMaxDrawdown.toFixed(1)}% | ` +
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
        `Sharpe: ${t.sharpe.toFixed(2)} | PF: ${t.profitFactor.toFixed(2)} | ` +
        `DD: ${t.maxDrawdown.toFixed(1)}% | ${t.trades} trades | ` +
        `Avg Hold: ${t.avgHoldDays.toFixed(1)}d`
      );
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
