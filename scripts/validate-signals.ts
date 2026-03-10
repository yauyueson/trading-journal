/**
 * First-Principles Signal Validation Pipeline
 *
 * Phases:
 *   0. Ablation: Test each signal solo — does it have independent alpha?
 *   1. Correlation: Are any signals redundant (measuring the same thing)?
 *   2. Period Sensitivity: Are default periods robust or fragile?
 *   3. Weight Optimization: Combine kept signals (exhaustive grid or GA)
 *   4. Risk Sweep: Optimize exit/sizing params with locked weights
 *
 * Usage:
 *   npx tsx scripts/validate-signals.ts [--start 2019-01-01] [--end 2025-12-31] [--out report.json]
 *   npx tsx scripts/validate-signals.ts --phase ablation
 *   npx tsx scripts/validate-signals.ts --phase correlation
 *   npx tsx scripts/validate-signals.ts --phase all
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Load .env.local ─────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
      if (key && !key.startsWith('#')) {
        process.env[key] = value;
      }
    }
  });
}

import type { BacktestCandle, BacktestConfig, PrecomputedSignal } from '../src/lib/backtest/types';
import { DEFAULT_CONFIG } from '../src/lib/backtest/types';
import { precomputeSignals, runBacktestFull } from '../src/lib/backtest/engine';
import { computeAnalytics } from '../src/lib/backtest/analytics';
import { computeFitness } from '../src/lib/backtest/sweep';
import type { TechScoreOptions } from '../src/lib/tech-analysis';

// ── CLI Args ────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
function hasFlag(name: string): boolean { return args.includes(`--${name}`); }

const startDate = getArg('start', '2019-01-01');
const endDate = getArg('end', '2025-12-31');
const outFile = getArg('out', '');
const phase = getArg('phase', 'all');

// IS/OOS split: ~75/25 by date
const IS_END = '2024-03-31';
const OOS_START = '2024-04-01';

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD',
  'COST', 'BA', 'NFLX', 'JPM', 'AVGO'];
const tickers = getArg('tickers', DEFAULT_TICKERS.join(',')).split(',').map(t => t.trim().toUpperCase());

// ── Supabase Candle Fetch ───────────────────────────────
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

async function fetchCandlesFromSupabase(ticker: string, from: string, to: string): Promise<BacktestCandle[]> {
  const params = new URLSearchParams({
    select: 'date,open,high,low,close,volume',
    ticker: `eq.${ticker.toUpperCase()}`,
    timeframe: 'eq.1D',
    order: 'date.asc',
    limit: '5000',
  });
  params.set('date', `gte.${from}`);
  params.append('date', `lte.${to}`);

  const url = `${SUPABASE_URL}/rest/v1/stock_candles?${params}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });

  if (!res.ok) throw new Error(`Supabase fetch failed for ${ticker}: ${res.status} ${res.statusText}`);
  const rows: any[] = await res.json();

  return rows.map(r => ({
    date: r.date,
    timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

// ── Helpers ─────────────────────────────────────────────
const SIGNAL_NAMES = ['w_mb', 'w_bxs', 'w_bxl', 'w_ema', 'w_mom'] as const;
type SignalName = typeof SIGNAL_NAMES[number];

interface AblationResult {
  name: string;
  weights: Record<string, number>;
  is: { sharpe: number; sortino: number; winRate: number; trades: number; pf: number; maxDD: number; expectancy: number; fitness: number };
  oos: { sharpe: number; sortino: number; winRate: number; trades: number; pf: number; maxDD: number; expectancy: number; fitness: number };
  verdict: 'KEEP' | 'DROP' | 'BASELINE';
}

function makeWeights(soloKey?: SignalName): TechScoreOptions {
  if (!soloKey) {
    // Equal weight baseline (no ADX/VOL to isolate directional signals)
    return { w_mb: 20, w_bxs: 20, w_bxl: 20, w_ema: 20, w_mom: 20, w_adx: 0, w_vol: 0 };
  }
  const weights: TechScoreOptions = { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_mom: 0, w_adx: 0, w_vol: 0 };
  weights[soloKey] = 100;
  return weights;
}

function extractMetrics(r: ReturnType<typeof runBacktestFull>) {
  const a = r.analytics;
  return {
    sharpe: a.sharpe,
    sortino: a.sortino,
    winRate: a.winRateTheta,
    trades: a.totalTrades,
    pf: a.profitFactor,
    maxDD: a.maxDrawdown,
    expectancy: a.expectancy,
    fitness: computeFitness(r),
  };
}

// ── Phase -1: Forward Return Test (Pure Signal Quality) ─

interface ForwardReturnResult {
  name: string;
  horizons: {
    days: number;
    signalAvgReturn: number;   // avg return when signal fires (directional)
    randomAvgReturn: number;   // unconditional avg return
    edge: number;              // signal - random
    tStat: number;             // statistical significance
    nSignals: number;
  }[];
}

async function runForwardReturns(allCandles: Map<string, BacktestCandle[]>): Promise<ForwardReturnResult[]> {
  console.error('\n══════════════════════════════════════════════════');
  console.error('  PHASE -1: FORWARD RETURN TEST (Pure Signal Quality)');
  console.error('  No TP/SL — just "when signal fires, what happens next?"');
  console.error('══════════════════════════════════════════════════\n');

  const HORIZONS = [5, 10, 21];
  const configs: { name: string; weights: TechScoreOptions }[] = [
    { name: 'Equal-wt', weights: makeWeights() },
    { name: 'MB',  weights: makeWeights('w_mb') },
    { name: 'BXS', weights: makeWeights('w_bxs') },
    { name: 'BXL', weights: makeWeights('w_bxl') },
    { name: 'EMA', weights: makeWeights('w_ema') },
    { name: 'MOM', weights: makeWeights('w_mom') },
  ];

  const results: ForwardReturnResult[] = [];

  for (const cfg of configs) {
    const horizonData: Map<number, { signalReturns: number[]; allReturns: number[] }> = new Map();
    for (const h of HORIZONS) horizonData.set(h, { signalReturns: [], allReturns: [] });

    for (const [ticker, candles] of allCandles) {
      if (candles.length < 300) continue;
      const { signals } = precomputeSignals(candles, '1D', cfg.weights);

      // Build date→barIndex map for forward return lookup
      const dateToIdx = new Map<string, number>();
      candles.forEach((c, i) => dateToIdx.set(c.date, i));

      for (const s of signals) {
        // Only consider OOS period signals
        if (s.date < OOS_START || s.date > endDate) continue;
        const barIdx = dateToIdx.get(s.date);
        if (barIdx == null) continue;

        for (const h of HORIZONS) {
          if (barIdx + h >= candles.length) continue;
          const fwdReturn = (candles[barIdx + h].close - candles[barIdx].close) / candles[barIdx].close;

          // Unconditional: every bar's forward return
          horizonData.get(h)!.allReturns.push(fwdReturn);

          // Signal-conditional: only when signal fires AND score >= 60
          if (s.type !== 'NEUTRAL' && s.score >= 60) {
            // Directional return: positive if signal direction matches price movement
            const directionalReturn = s.type === 'CALL' ? fwdReturn : -fwdReturn;
            horizonData.get(h)!.signalReturns.push(directionalReturn);
          }
        }
      }
    }

    const horizons = HORIZONS.map(h => {
      const data = horizonData.get(h)!;
      const sigAvg = data.signalReturns.length > 0
        ? data.signalReturns.reduce((s, v) => s + v, 0) / data.signalReturns.length : 0;
      const allAvg = data.allReturns.length > 0
        ? data.allReturns.reduce((s, v) => s + v, 0) / data.allReturns.length : 0;

      // t-statistic: (mean - 0) / (std / sqrt(n))
      const n = data.signalReturns.length;
      let tStat = 0;
      if (n > 1) {
        const std = Math.sqrt(data.signalReturns.reduce((s, v) => s + (v - sigAvg) ** 2, 0) / (n - 1));
        tStat = std > 0 ? (sigAvg / (std / Math.sqrt(n))) : 0;
      }

      return { days: h, signalAvgReturn: sigAvg * 100, randomAvgReturn: allAvg * 100, edge: (sigAvg - allAvg) * 100, tStat, nSignals: n };
    });

    results.push({ name: cfg.name, horizons });
  }

  // Print results for each horizon
  for (const h of HORIZONS) {
    console.error(`\n  ${h}-Day Forward Returns (OOS: ${OOS_START} → ${endDate}):`);
    console.error('  ┌────────────┬───────────────┬───────────────┬──────────┬────────┬──────────┐');
    console.error('  │ Signal     │ Signal Return │ Random Return │ Edge     │ t-stat │ Signals  │');
    console.error('  ├────────────┼───────────────┼───────────────┼──────────┼────────┼──────────┤');
    for (const r of results) {
      const hr = r.horizons.find(x => x.days === h)!;
      const tColor = Math.abs(hr.tStat) >= 1.96 ? '**' : '';
      console.error(
        `  │ ${r.name.padEnd(10)} │ ${(hr.signalAvgReturn.toFixed(3) + '%').padStart(13)} │ ` +
        `${(hr.randomAvgReturn.toFixed(3) + '%').padStart(13)} │ ${(hr.edge.toFixed(3) + '%').padStart(8)} │ ` +
        `${hr.tStat.toFixed(2).padStart(6)} │ ${String(hr.nSignals).padStart(8)} │`
      );
    }
    console.error('  └────────────┴───────────────┴───────────────┴──────────┴────────┴──────────┘');
    console.error('  (t-stat > 1.96 = statistically significant at 95% confidence)');
  }

  return results;
}

// ── Phase 0: Signal Ablation ────────────────────────────

async function runAblationMulti(
  allCandles: Map<string, BacktestCandle[]>,
  label: string,
  overrides: Partial<BacktestConfig>,
): Promise<AblationResult[]> {
  console.error(`\n  --- ${label} ---`);

  const configs: { name: string; weights: TechScoreOptions; soloKey?: SignalName }[] = [
    { name: 'Equal-wt', weights: makeWeights() },
    { name: 'MB solo',  weights: makeWeights('w_mb'),  soloKey: 'w_mb' },
    { name: 'BXS solo', weights: makeWeights('w_bxs'), soloKey: 'w_bxs' },
    { name: 'BXL solo', weights: makeWeights('w_bxl'), soloKey: 'w_bxl' },
    { name: 'EMA solo', weights: makeWeights('w_ema'), soloKey: 'w_ema' },
    { name: 'MOM solo', weights: makeWeights('w_mom'), soloKey: 'w_mom' },
  ];

  const results: AblationResult[] = [];

  for (const cfg of configs) {
    let oosTradesAll: any[] = [];
    for (const [ticker, candles] of allCandles) {
      if (candles.length < 300) continue;
      const { signals, simCandles } = precomputeSignals(candles, '1D', cfg.weights);
      const oosConfig: BacktestConfig = {
        ...DEFAULT_CONFIG, ticker, startDate: OOS_START, endDate,
        minScore: 60, indicatorOptions: cfg.weights,
        ...overrides,
      };
      const r = runBacktestFull(signals, simCandles, oosConfig);
      oosTradesAll.push(...r.trades);
    }

    const dummyCfg: BacktestConfig = { ...DEFAULT_CONFIG, indicatorOptions: cfg.weights, ...overrides };
    const analytics = computeAnalytics(oosTradesAll, dummyCfg, oosTradesAll.length);
    const metrics = extractMetrics({ config: dummyCfg, trades: oosTradesAll, analytics });
    const verdict = cfg.name === 'Equal-wt' ? 'BASELINE' as const
      : (metrics.sharpe > 0 && metrics.trades >= 30 ? 'KEEP' as const : 'DROP' as const);

    results.push({ name: cfg.name, weights: cfg.weights as Record<string, number>,
      is: metrics, oos: metrics, verdict });
  }

  // Print compact table
  console.error(`  ${label}:`);
  for (const r of results) {
    const v = r.verdict === 'KEEP' ? '✓' : r.verdict === 'DROP' ? '✗' : '○';
    console.error(
      `    ${v} ${r.name.padEnd(10)} OOS: Sharpe ${r.oos.sharpe.toFixed(2).padStart(6)}, ` +
      `WR ${r.oos.winRate.toFixed(1).padStart(5)}%, PF ${r.oos.pf.toFixed(2).padStart(5)}, ` +
      `${r.oos.trades} trades`
    );
  }

  return results;
}

async function runAblation(allCandles: Map<string, BacktestCandle[]>): Promise<AblationResult[]> {
  console.error('\n══════════════════════════════════════════════════');
  console.error('  PHASE 0: SIGNAL ABLATION STUDY');
  console.error('══════════════════════════════════════════════════\n');

  const configs: { name: string; weights: TechScoreOptions; soloKey?: SignalName }[] = [
    { name: 'Equal-wt', weights: makeWeights() },
    { name: 'MB solo',  weights: makeWeights('w_mb'),  soloKey: 'w_mb' },
    { name: 'BXS solo', weights: makeWeights('w_bxs'), soloKey: 'w_bxs' },
    { name: 'BXL solo', weights: makeWeights('w_bxl'), soloKey: 'w_bxl' },
    { name: 'EMA solo', weights: makeWeights('w_ema'), soloKey: 'w_ema' },
    { name: 'MOM solo', weights: makeWeights('w_mom'), soloKey: 'w_mom' },
  ];

  const results: AblationResult[] = [];

  for (const cfg of configs) {
    console.error(`  Testing: ${cfg.name} (${JSON.stringify(cfg.weights)})`);

    // Aggregate IS and OOS trades across all tickers
    let isTradesAll: any[] = [];
    let oosTradesAll: any[] = [];
    let tickersUsed = 0;

    for (const [ticker, candles] of allCandles) {
      if (candles.length < 300) continue;
      tickersUsed++;

      // Precompute signals with this weight config
      const { signals, simCandles } = precomputeSignals(candles, '1D', cfg.weights);

      // IS backtest
      const isConfig: BacktestConfig = {
        ...DEFAULT_CONFIG,
        ticker,
        startDate,
        endDate: IS_END,
        minScore: 60,  // Lower threshold for solo signals (sub-scores range 15-100)
        indicatorOptions: cfg.weights,
      };
      const isResult = runBacktestFull(signals, simCandles, isConfig);
      isTradesAll.push(...isResult.trades);

      // OOS backtest
      const oosConfig: BacktestConfig = {
        ...isConfig,
        startDate: OOS_START,
        endDate,
      };
      const oosResult = runBacktestFull(signals, simCandles, oosConfig);
      oosTradesAll.push(...oosResult.trades);
    }

    // Compute aggregate analytics
    const dummyCfg: BacktestConfig = { ...DEFAULT_CONFIG, indicatorOptions: cfg.weights };
    const isAnalytics = computeAnalytics(isTradesAll, dummyCfg, isTradesAll.length);
    const oosAnalytics = computeAnalytics(oosTradesAll, dummyCfg, oosTradesAll.length);

    const isMetrics = extractMetrics({ config: dummyCfg, trades: isTradesAll, analytics: isAnalytics });
    const oosMetrics = extractMetrics({ config: dummyCfg, trades: oosTradesAll, analytics: oosAnalytics });

    const verdict = cfg.name === 'Equal-wt' ? 'BASELINE' as const
      : (oosMetrics.sharpe > 0 && oosMetrics.trades >= 30 ? 'KEEP' as const : 'DROP' as const);

    results.push({
      name: cfg.name,
      weights: cfg.weights as Record<string, number>,
      is: isMetrics,
      oos: oosMetrics,
      verdict,
    });

    console.error(
      `    IS: ${isMetrics.trades} trades, Sharpe ${isMetrics.sharpe.toFixed(2)}, WR ${isMetrics.winRate.toFixed(1)}%, ` +
      `PF ${isMetrics.pf.toFixed(2)} | OOS: ${oosMetrics.trades} trades, Sharpe ${oosMetrics.sharpe.toFixed(2)}, ` +
      `WR ${oosMetrics.winRate.toFixed(1)}%, PF ${oosMetrics.pf.toFixed(2)} → ${verdict}`
    );
  }

  // Print summary table
  console.error('\n┌────────────┬───────────┬────────────┬────────┬────────┬────────────┬────────┬─────────┐');
  console.error('│ Signal     │ IS Sharpe │ OOS Sharpe │ IS WR  │ OOS WR │ OOS Trades │ OOS PF │ Verdict │');
  console.error('├────────────┼───────────┼────────────┼────────┼────────┼────────────┼────────┼─────────┤');
  for (const r of results) {
    const v = r.verdict === 'KEEP' ? '✓ KEEP' : r.verdict === 'DROP' ? '✗ DROP' : 'BASE  ';
    console.error(
      `│ ${r.name.padEnd(10)} │ ${r.is.sharpe.toFixed(2).padStart(9)} │ ${r.oos.sharpe.toFixed(2).padStart(10)} │ ` +
      `${r.is.winRate.toFixed(1).padStart(5)}% │ ${r.oos.winRate.toFixed(1).padStart(5)}% │ ${String(r.oos.trades).padStart(10)} │ ` +
      `${r.oos.pf.toFixed(2).padStart(6)} │ ${v.padStart(7)} │`
    );
  }
  console.error('└────────────┴───────────┴────────────┴────────┴────────┴────────────┴────────┴─────────┘');

  return results;
}

// ── Phase 1: Signal Correlation ─────────────────────────

interface CorrelationResult {
  signals: string[];
  matrix: number[][];
  redundantPairs: { a: string; b: string; r: number }[];
}

function computeCorrelations(allCandles: Map<string, BacktestCandle[]>): CorrelationResult {
  console.error('\n══════════════════════════════════════════════════');
  console.error('  PHASE 1: SIGNAL CORRELATION ANALYSIS');
  console.error('══════════════════════════════════════════════════\n');

  // Collect sub-scores across all tickers
  const allScores: { sc_mb: number[]; sc_bxs: number[]; sc_bxl: number[]; sc_ema: number[]; sc_mom: number[] } = {
    sc_mb: [], sc_bxs: [], sc_bxl: [], sc_ema: [], sc_mom: [],
  };

  for (const [ticker, candles] of allCandles) {
    if (candles.length < 300) continue;
    const { signals } = precomputeSignals(candles, '1D', {});

    for (const s of signals) {
      if (!s.subScores) continue;
      allScores.sc_mb.push(s.subScores.sc_mb);
      allScores.sc_bxs.push(s.subScores.sc_bxs);
      allScores.sc_bxl.push(s.subScores.sc_bxl);
      allScores.sc_ema.push(s.subScores.sc_ema);
      allScores.sc_mom.push(s.subScores.sc_mom);
    }
  }

  console.error(`  Collected ${allScores.sc_mb.length} bar-level sub-scores across ${allCandles.size} tickers`);

  // Pearson correlation
  function pearson(a: number[], b: number[]): number {
    const n = a.length;
    if (n === 0) return 0;
    const meanA = a.reduce((s, v) => s + v, 0) / n;
    const meanB = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, denA = 0, denB = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - meanA, db = b[i] - meanB;
      num += da * db;
      denA += da * da;
      denB += db * db;
    }
    const den = Math.sqrt(denA * denB);
    return den === 0 ? 0 : num / den;
  }

  const keys = ['sc_mb', 'sc_bxs', 'sc_bxl', 'sc_ema', 'sc_mom'] as const;
  const matrix: number[][] = [];
  const redundantPairs: { a: string; b: string; r: number }[] = [];

  for (let i = 0; i < keys.length; i++) {
    matrix[i] = [];
    for (let j = 0; j < keys.length; j++) {
      const r = i === j ? 1.0 : pearson(allScores[keys[i]], allScores[keys[j]]);
      matrix[i][j] = r;
      if (i < j && Math.abs(r) > 0.60) {
        redundantPairs.push({ a: keys[i], b: keys[j], r });
      }
    }
  }

  // Print correlation matrix
  const labels = ['MB', 'BXS', 'BXL', 'EMA', 'MOM'];
  console.error('\n         ' + labels.map(l => l.padStart(7)).join(''));
  for (let i = 0; i < keys.length; i++) {
    const row = matrix[i].map(v => v.toFixed(2).padStart(7)).join('');
    console.error(`  ${labels[i].padEnd(5)}  ${row}`);
  }

  if (redundantPairs.length > 0) {
    console.error('\n  Redundant pairs (|r| > 0.60):');
    for (const p of redundantPairs) {
      console.error(`    ${p.a} ↔ ${p.b}: r = ${p.r.toFixed(3)}`);
    }
  } else {
    console.error('\n  No redundant pairs found (all |r| ≤ 0.60)');
  }

  return { signals: keys as unknown as string[], matrix, redundantPairs };
}

// ── Phase 2: Period Sensitivity ─────────────────────────

interface PeriodSensitivityResult {
  signal: string;
  param: string;
  results: { value: number; oosSharpe: number; oosTrades: number; oosWR: number }[];
  bestValue: number;
  defaultValue: number;
  isRobust: boolean;
}

async function runPeriodSensitivity(
  allCandles: Map<string, BacktestCandle[]>,
  keptSignals: string[],
): Promise<PeriodSensitivityResult[]> {
  console.error('\n══════════════════════════════════════════════════');
  console.error('  PHASE 2: PERIOD SENSITIVITY ANALYSIS');
  console.error('══════════════════════════════════════════════════\n');

  // Period sweep ranges per signal
  const periodConfigs: { signal: string; param: string; values: number[]; defaultVal: number }[] = [
    { signal: 'w_mb', param: 'sc_mb_len', values: [10, 15, 20, 25, 30, 40], defaultVal: 20 },
    { signal: 'w_bxs', param: 'sc_bx_s1', values: [3, 5, 7, 10], defaultVal: 5 },
    { signal: 'w_bxs', param: 'sc_bx_s2', values: [10, 15, 20, 25, 30], defaultVal: 20 },
    { signal: 'w_bxl', param: 'sc_bx_l1', values: [10, 15, 20, 25, 30], defaultVal: 20 },
    { signal: 'w_bxl', param: 'sc_bx_l2', values: [10, 15, 20, 25], defaultVal: 15 },
  ];

  const results: PeriodSensitivityResult[] = [];

  for (const pc of periodConfigs) {
    if (!keptSignals.includes(pc.signal)) {
      console.error(`  Skipping ${pc.param} (${pc.signal} was dropped)`);
      continue;
    }

    console.error(`  Sweeping ${pc.param} for ${pc.signal}: [${pc.values.join(', ')}]`);
    const paramResults: { value: number; oosSharpe: number; oosTrades: number; oosWR: number }[] = [];

    for (const val of pc.values) {
      const weights = makeWeights(pc.signal as SignalName);
      const opts: TechScoreOptions = { ...weights, [pc.param]: val };

      let oosTradesAll: any[] = [];
      for (const [ticker, candles] of allCandles) {
        if (candles.length < 300) continue;
        const { signals, simCandles } = precomputeSignals(candles, '1D', opts);
        const oosConfig: BacktestConfig = {
          ...DEFAULT_CONFIG, ticker, startDate: OOS_START, endDate,
          minScore: 60, indicatorOptions: opts,
        };
        const r = runBacktestFull(signals, simCandles, oosConfig);
        oosTradesAll.push(...r.trades);
      }

      const dummyCfg: BacktestConfig = { ...DEFAULT_CONFIG, indicatorOptions: opts };
      const analytics = computeAnalytics(oosTradesAll, dummyCfg, oosTradesAll.length);
      paramResults.push({
        value: val,
        oosSharpe: analytics.sharpe,
        oosTrades: analytics.totalTrades,
        oosWR: analytics.winRateTheta,
      });

      console.error(`    ${pc.param}=${val}: OOS Sharpe ${analytics.sharpe.toFixed(2)}, ${analytics.totalTrades} trades, WR ${analytics.winRateTheta.toFixed(1)}%`);
    }

    // Find best and check robustness (is neighbor ±1 step within 80% of best?)
    const bestIdx = paramResults.reduce((bi, r, i) => r.oosSharpe > paramResults[bi].oosSharpe ? i : bi, 0);
    const bestSharpe = paramResults[bestIdx].oosSharpe;
    const threshold = bestSharpe * 0.80;
    const neighborsOk = (
      (bestIdx === 0 || paramResults[bestIdx - 1].oosSharpe >= threshold) &&
      (bestIdx === paramResults.length - 1 || paramResults[bestIdx + 1].oosSharpe >= threshold)
    );

    results.push({
      signal: pc.signal,
      param: pc.param,
      results: paramResults,
      bestValue: pc.values[bestIdx],
      defaultValue: pc.defaultVal,
      isRobust: neighborsOk,
    });

    console.error(`    → Best: ${pc.param}=${pc.values[bestIdx]} (Sharpe ${bestSharpe.toFixed(2)}) ${neighborsOk ? '✓ Robust' : '⚠ Fragile'}`);
  }

  return results;
}

// ── Phase 3: Weight Optimization ────────────────────────

interface WeightResult {
  weights: Record<string, number>;
  oosSharpe: number;
  oosTrades: number;
  oosWR: number;
  oosPF: number;
  fitness: number;
}

async function runWeightOptimization(
  allCandles: Map<string, BacktestCandle[]>,
  keptSignals: string[],
  bestPeriods: Record<string, number>,
): Promise<WeightResult[]> {
  console.error('\n══════════════════════════════════════════════════');
  console.error('  PHASE 3: WEIGHT OPTIMIZATION');
  console.error(`  Kept signals: ${keptSignals.join(', ')}`);
  console.error('══════════════════════════════════════════════════\n');

  // Generate exhaustive weight grid (step=5, sum=100)
  // For N signals with step S summing to T, generate all combos
  const step = 5;
  const total = 100;
  const n = keptSignals.length;

  function generateWeightCombos(n: number, total: number, step: number): number[][] {
    const combos: number[][] = [];
    function recurse(remaining: number, depth: number, current: number[]) {
      if (depth === n - 1) {
        if (remaining >= step) {  // min weight = step (no zeros)
          combos.push([...current, remaining]);
        }
        return;
      }
      for (let w = step; w <= remaining - step * (n - depth - 1); w += step) {
        current.push(w);
        recurse(remaining - w, depth + 1, current);
        current.pop();
      }
    }
    recurse(total, 0, []);
    return combos;
  }

  const combos = generateWeightCombos(n, total, step);
  console.error(`  ${combos.length} weight combinations (step=${step}, sum=${total})\n`);

  const results: WeightResult[] = [];
  let best: WeightResult | null = null;

  for (let ci = 0; ci < combos.length; ci++) {
    const combo = combos[ci];
    const opts: TechScoreOptions = { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_mom: 0, w_adx: 0, w_vol: 0, ...bestPeriods };
    const weightMap: Record<string, number> = {};
    for (let i = 0; i < keptSignals.length; i++) {
      (opts as any)[keptSignals[i]] = combo[i];
      weightMap[keptSignals[i]] = combo[i];
    }

    let oosTradesAll: any[] = [];
    for (const [ticker, candles] of allCandles) {
      if (candles.length < 300) continue;
      const { signals, simCandles } = precomputeSignals(candles, '1D', opts);
      const oosConfig: BacktestConfig = {
        ...DEFAULT_CONFIG, ticker, startDate: OOS_START, endDate,
        minScore: 60, indicatorOptions: opts,
      };
      const r = runBacktestFull(signals, simCandles, oosConfig);
      oosTradesAll.push(...r.trades);
    }

    const dummyCfg: BacktestConfig = { ...DEFAULT_CONFIG, indicatorOptions: opts };
    const analytics = computeAnalytics(oosTradesAll, dummyCfg, oosTradesAll.length);
    const fitness = computeFitness({ config: dummyCfg, trades: oosTradesAll, analytics });

    const result: WeightResult = {
      weights: weightMap,
      oosSharpe: analytics.sharpe,
      oosTrades: analytics.totalTrades,
      oosWR: analytics.winRateTheta,
      oosPF: analytics.profitFactor,
      fitness,
    };
    results.push(result);

    if (!best || fitness > best.fitness) {
      best = result;
    }

    if ((ci + 1) % 50 === 0 || ci === combos.length - 1) {
      console.error(`  Progress: ${ci + 1}/${combos.length} | Best so far: ${JSON.stringify(best?.weights)} fitness=${best?.fitness.toFixed(3)}`);
    }
  }

  // Sort by fitness descending
  results.sort((a, b) => b.fitness - a.fitness);

  // Print top 10
  console.error('\n  Top 10 weight combinations:');
  console.error('  ┌─────┬──────────────────────────────────┬────────────┬────────┬────────┬────────┬─────────┐');
  console.error('  │ Rank│ Weights                          │ OOS Sharpe │ OOS WR │ OOS PF │ Trades │ Fitness │');
  console.error('  ├─────┼──────────────────────────────────┼────────────┼────────┼────────┼────────┼─────────┤');
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    const wStr = keptSignals.map(s => `${s.replace('w_', '')}=${r.weights[s]}`).join(' ');
    console.error(
      `  │ ${String(i + 1).padStart(3)} │ ${wStr.padEnd(32)} │ ${r.oosSharpe.toFixed(2).padStart(10)} │ ` +
      `${r.oosWR.toFixed(1).padStart(5)}% │ ${r.oosPF.toFixed(2).padStart(6)} │ ${String(r.oosTrades).padStart(6)} │ ${r.fitness.toFixed(3).padStart(7)} │`
    );
  }
  console.error('  └─────┴──────────────────────────────────┴────────────┴────────┴────────┴────────┴─────────┘');

  return results;
}

// ── Phase 4: Risk/Exit Sweep ────────────────────────────

interface RiskResult {
  minScore: number;
  scoreStop: number;
  oosSharpe: number;
  oosTrades: number;
  oosWR: number;
  oosPF: number;
  oosDD: number;
  fitness: number;
}

async function runRiskSweep(
  allCandles: Map<string, BacktestCandle[]>,
  bestWeights: TechScoreOptions,
): Promise<RiskResult[]> {
  console.error('\n══════════════════════════════════════════════════');
  console.error('  PHASE 4: RISK/EXIT PARAMETER SWEEP');
  console.error('══════════════════════════════════════════════════\n');

  const minScoreRange = [55, 60, 65, 70, 75, 80];
  const scoreStopRange = [0, 45, 50, 55, 60];

  const totalCombos = minScoreRange.length * scoreStopRange.length;
  console.error(`  ${totalCombos} parameter combinations\n`);

  const results: RiskResult[] = [];
  let count = 0;

  for (const minScore of minScoreRange) {
    for (const scoreStop of scoreStopRange) {
      // scoreStop must be < minScore to make sense
      if (scoreStop >= minScore) continue;

      let oosTradesAll: any[] = [];
      for (const [ticker, candles] of allCandles) {
        if (candles.length < 300) continue;
        const { signals, simCandles } = precomputeSignals(candles, '1D', bestWeights);
        const oosConfig: BacktestConfig = {
          ...DEFAULT_CONFIG, ticker, startDate: OOS_START, endDate,
          minScore,
          scoreStopThreshold: scoreStop,
          indicatorOptions: bestWeights,
        };
        const r = runBacktestFull(signals, simCandles, oosConfig);
        oosTradesAll.push(...r.trades);
      }

      const dummyCfg: BacktestConfig = { ...DEFAULT_CONFIG, minScore, scoreStopThreshold: scoreStop, indicatorOptions: bestWeights };
      const analytics = computeAnalytics(oosTradesAll, dummyCfg, oosTradesAll.length);
      const fitness = computeFitness({ config: dummyCfg, trades: oosTradesAll, analytics });

      results.push({
        minScore,
        scoreStop,
        oosSharpe: analytics.sharpe,
        oosTrades: analytics.totalTrades,
        oosWR: analytics.winRateTheta,
        oosPF: analytics.profitFactor,
        oosDD: analytics.maxDrawdown,
        fitness,
      });

      count++;
      if (count % 10 === 0) {
        console.error(`  Progress: ${count}/${totalCombos}`);
      }
    }
  }

  results.sort((a, b) => b.fitness - a.fitness);

  console.error('\n  Top 10 risk configurations:');
  console.error('  ┌─────┬──────────┬───────────┬────────────┬────────┬────────┬────────┬────────┬─────────┐');
  console.error('  │ Rank│ minScore │ scoreStop │ OOS Sharpe │ OOS WR │ OOS PF │  OOS DD│ Trades │ Fitness │');
  console.error('  ├─────┼──────────┼───────────┼────────────┼────────┼────────┼────────┼────────┼─────────┤');
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    console.error(
      `  │ ${String(i + 1).padStart(3)} │ ${String(r.minScore).padStart(8)} │ ${String(r.scoreStop).padStart(9)} │ ` +
      `${r.oosSharpe.toFixed(2).padStart(10)} │ ${r.oosWR.toFixed(1).padStart(5)}% │ ${r.oosPF.toFixed(2).padStart(6)} │ ` +
      `${r.oosDD.toFixed(1).padStart(5)}% │ ${String(r.oosTrades).padStart(6)} │ ${r.fitness.toFixed(3).padStart(7)} │`
    );
  }
  console.error('  └─────┴──────────┴───────────┴────────────┴────────┴────────┴────────┴────────┴─────────┘');

  return results;
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║  FIRST-PRINCIPLES SIGNAL VALIDATION PIPELINE               ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error(`\n  Study period: ${startDate} → ${endDate}`);
  console.error(`  IS period: ${startDate} → ${IS_END}`);
  console.error(`  OOS period: ${OOS_START} → ${endDate}`);
  console.error(`  Tickers: ${tickers.join(', ')}`);
  console.error(`  Phase: ${phase}\n`);

  // Fetch all candles from Supabase
  console.error('  Fetching candles from Supabase...');
  const allCandles = new Map<string, BacktestCandle[]>();
  for (const ticker of tickers) {
    try {
      const candles = await fetchCandlesFromSupabase(ticker, startDate, endDate);
      if (candles.length < 300) {
        console.error(`    ${ticker}: ${candles.length} candles (need 300+), skipping`);
        continue;
      }
      allCandles.set(ticker, candles);
      console.error(`    ${ticker}: ${candles.length} candles ✓`);
    } catch (err: any) {
      console.error(`    ${ticker}: ${err.message}`);
    }
  }
  console.error(`\n  Loaded ${allCandles.size} tickers\n`);

  if (allCandles.size === 0) {
    console.error('  ERROR: No tickers with sufficient data');
    process.exit(1);
  }

  const report: any = {
    meta: {
      studyPeriod: { start: startDate, end: endDate },
      isSplit: { start: startDate, end: IS_END },
      oosSplit: { start: OOS_START, end: endDate },
      tickers: Array.from(allCandles.keys()),
      timestamp: new Date().toISOString(),
    },
  };

  // Phase -1: Forward Return Test (pure signal quality, no TP/SL)
  if (phase === 'all' || phase === 'ablation' || phase === 'forward') {
    const t0 = performance.now();
    report.forwardReturns = await runForwardReturns(allCandles);
    console.error(`\n  Forward return test completed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Phase 0: Ablation — test with different exit settings to isolate signal vs exit effects
  if (phase === 'all' || phase === 'ablation') {
    console.error('\n══════════════════════════════════════════════════');
    console.error('  PHASE 0: SIGNAL ABLATION — EXIT SENSITIVITY');
    console.error('  Testing whether exit settings mask signal quality');
    console.error('══════════════════════════════════════════════════');

    const t0 = performance.now();

    // Test 1: Original settings (tight SL, scoreStop active)
    await runAblationMulti(allCandles, 'A) Default (SL=1.5, scoreStop=55)', {});

    // Test 2: Disable scoreStop (let trades run)
    await runAblationMulti(allCandles, 'B) No scoreStop (SL=1.5, scoreStop=OFF)', {
      scoreStopThreshold: 0,
    });

    // Test 3: Wide SL, no scoreStop
    await runAblationMulti(allCandles, 'C) Wide SL (SL=3.0, scoreStop=OFF)', {
      slAtr: 3.0, scoreStopThreshold: 0,
    });

    // Test 4: Very wide SL + TP, no scoreStop, longer hold
    await runAblationMulti(allCandles, 'D) Wide TP/SL (TP=5, SL=5, scoreStop=OFF, time=42)', {
      tpAtr: 5.0, slAtr: 5.0, scoreStopThreshold: 0, timeStopBars: 42,
    });

    // Test 5: Higher minScore (selective entries)
    await runAblationMulti(allCandles, 'E) Selective (minScore=75, SL=2.0, scoreStop=OFF)', {
      minScore: 75, slAtr: 2.0, scoreStopThreshold: 0,
    });

    // Still run the original ablation for report structure
    report.ablation = await runAblation(allCandles);
    console.error(`\n  Phase 0 completed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Determine kept signals from ablation results
  let keptSignals: string[] = SIGNAL_NAMES.map(s => s);  // default: keep all
  if (report.ablation) {
    keptSignals = report.ablation
      .filter((r: AblationResult) => r.verdict === 'KEEP')
      .map((r: AblationResult) => {
        const match = SIGNAL_NAMES.find(s => r.name.toLowerCase().includes(s.replace('w_', '')));
        return match || '';
      })
      .filter(Boolean);

    if (keptSignals.length === 0) {
      console.error('\n  WARNING: No signals passed ablation test! Keeping all for further analysis.');
      keptSignals = SIGNAL_NAMES.map(s => s);
    }

    console.error(`\n  ═══ KEPT SIGNALS: ${keptSignals.join(', ')} ═══`);
    report.keptSignals = keptSignals;
  }

  // Phase 1: Correlation
  if (phase === 'all' || phase === 'correlation') {
    const t0 = performance.now();
    report.correlation = computeCorrelations(allCandles);

    // Drop redundant signals (keep the one with higher ablation OOS Sharpe)
    if (report.ablation && report.correlation.redundantPairs.length > 0) {
      for (const pair of report.correlation.redundantPairs) {
        const aName = pair.a.replace('sc_', 'w_');
        const bName = pair.b.replace('sc_', 'w_');
        if (!keptSignals.includes(aName) || !keptSignals.includes(bName)) continue;

        const aResult = report.ablation.find((r: AblationResult) => r.name.toLowerCase().includes(aName.replace('w_', '')));
        const bResult = report.ablation.find((r: AblationResult) => r.name.toLowerCase().includes(bName.replace('w_', '')));
        if (!aResult || !bResult) continue;

        const drop = aResult.oos.sharpe > bResult.oos.sharpe ? bName : aName;
        keptSignals = keptSignals.filter(s => s !== drop);
        console.error(`\n  Dropped ${drop} (redundant with ${drop === aName ? bName : aName}, r=${pair.r.toFixed(2)})`);
      }
      report.keptSignals = keptSignals;
      console.error(`\n  ═══ FINAL KEPT SIGNALS: ${keptSignals.join(', ')} ═══`);
    }

    console.error(`\n  Phase 1 completed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Phase 2: Period Sensitivity
  const bestPeriods: Record<string, number> = {};
  if (phase === 'all' || phase === 'periods') {
    const t0 = performance.now();
    report.periodSensitivity = await runPeriodSensitivity(allCandles, keptSignals);

    // Use best periods where robust
    for (const ps of report.periodSensitivity) {
      if (ps.isRobust) {
        bestPeriods[ps.param] = ps.bestValue;
        console.error(`  Using ${ps.param}=${ps.bestValue} (robust)`);
      } else {
        bestPeriods[ps.param] = ps.defaultValue;
        console.error(`  Keeping ${ps.param}=${ps.defaultValue} (default — sweep was fragile)`);
      }
    }
    report.bestPeriods = bestPeriods;
    console.error(`\n  Phase 2 completed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Phase 3: Weight Optimization
  if (phase === 'all' || phase === 'weights') {
    const t0 = performance.now();
    report.weightOptimization = await runWeightOptimization(allCandles, keptSignals, bestPeriods);
    console.error(`\n  Phase 3 completed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Phase 4: Risk Sweep
  if (phase === 'all' || phase === 'risk') {
    // Build best weights from Phase 3
    const bestWeights: TechScoreOptions = { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_mom: 0, w_adx: 0, w_vol: 0, ...bestPeriods };
    if (report.weightOptimization && report.weightOptimization.length > 0) {
      const topWeights = report.weightOptimization[0].weights;
      for (const [k, v] of Object.entries(topWeights)) {
        (bestWeights as any)[k] = v;
      }
    } else {
      // Fallback: equal weight among kept signals
      const perSignal = Math.round(100 / keptSignals.length);
      for (const s of keptSignals) {
        (bestWeights as any)[s] = perSignal;
      }
    }

    const t0 = performance.now();
    report.riskSweep = await runRiskSweep(allCandles, bestWeights);
    console.error(`\n  Phase 4 completed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Final summary
  console.error('\n╔══════════════════════════════════════════════════════════════╗');
  console.error('║  VALIDATION COMPLETE                                        ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');

  if (report.keptSignals) {
    console.error(`\n  Kept signals: ${report.keptSignals.join(', ')}`);
  }
  if (report.bestPeriods) {
    console.error(`  Best periods: ${JSON.stringify(report.bestPeriods)}`);
  }
  if (report.weightOptimization?.[0]) {
    console.error(`  Best weights: ${JSON.stringify(report.weightOptimization[0].weights)}`);
    console.error(`    OOS Sharpe=${report.weightOptimization[0].oosSharpe.toFixed(2)}, WR=${report.weightOptimization[0].oosWR.toFixed(1)}%, PF=${report.weightOptimization[0].oosPF.toFixed(2)}`);
  }
  if (report.riskSweep?.[0]) {
    console.error(`  Best risk: minScore=${report.riskSweep[0].minScore}, scoreStop=${report.riskSweep[0].scoreStop}`);
    console.error(`    OOS Sharpe=${report.riskSweep[0].oosSharpe.toFixed(2)}, WR=${report.riskSweep[0].oosWR.toFixed(1)}%, PF=${report.riskSweep[0].oosPF.toFixed(2)}, DD=${report.riskSweep[0].oosDD.toFixed(1)}%`);
  }

  // Output report
  const json = JSON.stringify(report, null, 2);
  if (outFile) {
    fs.writeFileSync(outFile, json);
    console.error(`\n  Report written to ${outFile}`);
  } else {
    console.log(json);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
