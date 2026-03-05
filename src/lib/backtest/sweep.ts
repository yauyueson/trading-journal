/**
 * Signal Quality Backtester — Parameter Sweep & Optimizer
 *
 * Sweep: vary TP/SL and trade params with fixed indicators
 * Optimize: vary indicator params (weights, periods) with fixed TP/SL
 *
 * Signals are cached per unique indicator param set, so sweeping
 * 96 trade combos × 4 indicator combos = 384 runs but only 4 signal computations.
 */

import type {
  BacktestCandle,
  BacktestConfig,
  BacktestResult,
  SweepConfig,
  SweepResult,
  OptimizeConfig,
  OptimizeResult,
  IndicatorSweepParams,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { precomputeSignals, runBacktestFull } from './engine';
import type { TechScoreOptions } from '../tech-analysis';

// ── Indicator Param Combos ──────────────────────────────

export function generateIndicatorCombos(params?: IndicatorSweepParams): TechScoreOptions[] {
  if (!params) return [{}]; // Single combo: all defaults

  // Collect all fields that have ranges
  const fields: { key: keyof TechScoreOptions; values: number[] }[] = [];
  const keys: (keyof IndicatorSweepParams)[] = [
    'w_mb', 'w_bxs', 'w_bxl', 'w_ema', 'w_mom',
    'sc_mb_len', 'sc_osc_len', 'sc_bx_s1', 'sc_bx_s2', 'sc_bx_l1', 'sc_bx_l2',
  ];
  for (const k of keys) {
    const vals = params[k];
    if (vals && vals.length > 0) {
      fields.push({ key: k as keyof TechScoreOptions, values: vals });
    }
  }

  if (fields.length === 0) return [{}];

  // Cartesian product of indicator params
  let combos: TechScoreOptions[] = [{}];
  for (const field of fields) {
    const next: TechScoreOptions[] = [];
    for (const combo of combos) {
      for (const val of field.values) {
        next.push({ ...combo, [field.key]: val });
      }
    }
    combos = next;
  }

  return combos;
}

// ── Trade Param Grid ────────────────────────────────────

function generateTradeConfigs(sweep: SweepConfig, indicatorOpts: TechScoreOptions): BacktestConfig[] {
  const configs: BacktestConfig[] = [];
  for (const tpAtr of sweep.tpAtrRange) {
    for (const slAtr of sweep.slAtrRange) {
      for (const minScore of sweep.minScoreRange) {
        for (const minConfidence of sweep.minConfidenceRange) {
          for (const setups of sweep.setupGroups) {
            for (const decay of sweep.thetaDecayRange) {
              configs.push({
                ...DEFAULT_CONFIG,
                ticker: sweep.ticker,
                startDate: sweep.startDate,
                endDate: sweep.endDate,
                timeframe: sweep.timeframe,
                tpAtr,
                slAtr,
                minScore,
                minConfidence,
                allowedSetups: setups,
                thetaDecayRate: decay,
                indicatorOptions: indicatorOpts,
              });
            }
          }
        }
      }
    }
  }
  return configs;
}

// ── Sweep Runner (trade params) ─────────────────────────

export function runSweep(
  candles: BacktestCandle[],
  sweepConfig: SweepConfig,
  onProgress?: (completed: number, total: number) => void
): SweepResult {
  const t0 = performance.now();

  const indicatorCombos = generateIndicatorCombos(sweepConfig.indicatorSweep);

  const tradeConfigsPerIndicator = sweepConfig.tpAtrRange.length *
    sweepConfig.slAtrRange.length * sweepConfig.minScoreRange.length *
    sweepConfig.minConfidenceRange.length * sweepConfig.setupGroups.length *
    sweepConfig.thetaDecayRange.length;
  const total = indicatorCombos.length * tradeConfigsPerIndicator;

  const results: BacktestResult[] = [];
  let completed = 0;

  for (const indOpts of indicatorCombos) {
    const { signals, simCandles } = precomputeSignals(candles, '1D', indOpts);
    const tradeConfigs = generateTradeConfigs(sweepConfig, indOpts);
    for (const cfg of tradeConfigs) {
      results.push(runBacktestFull(signals, simCandles, cfg));
      completed++;
      if (onProgress) onProgress(completed, total);
    }
  }

  const meaningful = results.filter(r => r.analytics.totalTrades >= 5);
  const rankedBySharpe = [...meaningful].sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
  const rankedByWinRate = [...meaningful].sort((a, b) => b.analytics.winRateTheta - a.analytics.winRateTheta);
  const rankedByProfitFactor = [...meaningful].sort((a, b) => b.analytics.profitFactor - a.analytics.profitFactor);
  const bestOverall = pickBest(meaningful);

  return {
    results, rankedBySharpe, rankedByWinRate, rankedByProfitFactor,
    bestOverall, totalCombos: total, elapsedMs: performance.now() - t0,
  };
}

// ── Optimize Runner (indicator params) ──────────────────

export function runOptimize(
  candles: BacktestCandle[],
  config: OptimizeConfig,
  onProgress?: (completed: number, total: number) => void
): OptimizeResult {
  const t0 = performance.now();

  const indicatorCombos = generateIndicatorCombos(config.indicatorSweep);
  const total = indicatorCombos.length;

  const results: BacktestResult[] = [];

  for (let i = 0; i < indicatorCombos.length; i++) {
    const indOpts = indicatorCombos[i];

    // Each indicator combo = one expensive signal recomputation
    const { signals, simCandles } = precomputeSignals(candles, '1D', indOpts);

    // One backtest with fixed trade params
    const backtestConfig: BacktestConfig = {
      ...DEFAULT_CONFIG,
      ticker: config.ticker,
      startDate: config.startDate,
      endDate: config.endDate,
      timeframe: '1D',
      tpAtr: config.tpAtr,
      slAtr: config.slAtr,
      minScore: config.minScore,
      minConfidence: config.minConfidence,
      thetaDecayRate: config.thetaDecayRate,
      indicatorOptions: indOpts,
    };

    results.push(runBacktestFull(signals, simCandles, backtestConfig));
    if (onProgress) onProgress(i + 1, total);
  }

  const meaningful = results.filter(r => r.analytics.totalTrades >= 3);
  const rankedBySharpe = [...meaningful].sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
  const rankedByWinRate = [...meaningful].sort((a, b) => b.analytics.winRateTheta - a.analytics.winRateTheta);
  const bestOverall = pickBest(meaningful);

  return {
    results, rankedBySharpe, rankedByWinRate,
    bestOverall, totalCombos: total, elapsedMs: performance.now() - t0,
  };
}

// ── Best Pick (weighted composite) ──────────────────────

function pickBest(results: BacktestResult[]): BacktestResult | null {
  if (results.length === 0) return null;

  const metrics = results.map(r => ({
    result: r,
    sharpe: r.analytics.sharpe,
    winRate: r.analytics.winRateTheta,
    pf: r.analytics.profitFactor,
    dd: r.analytics.maxDrawdown,
  }));

  const maxSharpe = Math.max(...metrics.map(m => m.sharpe), 0.01);
  const maxWR = Math.max(...metrics.map(m => m.winRate), 1);
  const maxPF = Math.max(...metrics.map(m => m.pf), 0.01);
  const maxDD = Math.max(...metrics.map(m => m.dd), 0.01);

  let best: BacktestResult | null = null;
  let bestScore = -Infinity;

  for (const m of metrics) {
    const score =
      0.35 * (m.sharpe / maxSharpe) +
      0.25 * (m.winRate / maxWR) +
      0.25 * (m.pf / Math.min(maxPF, 10)) +
      0.15 * (1 - m.dd / maxDD);

    if (score > bestScore) {
      bestScore = score;
      best = m.result;
    }
  }

  return best;
}

// ── Default Sweep Ranges ────────────────────────────────

export const DEFAULT_SWEEP: Omit<SweepConfig, 'ticker' | 'startDate' | 'endDate' | 'timeframe'> = {
  tpAtrRange: [1.5, 2.0, 2.5, 3.0],
  slAtrRange: [1.0, 1.5, 2.0],
  minScoreRange: [65, 70, 75, 80],
  minConfidenceRange: [1, 2],
  setupGroups: [['All']],
  thetaDecayRange: [0.03],
};

/** Default indicator param ranges for optimization */
export const DEFAULT_INDICATOR_SWEEP: IndicatorSweepParams = {
  w_mb: [20, 25, 30, 35, 40],
  w_bxs: [15, 20, 25, 30],
  w_bxl: [10, 15, 20, 25],
  w_ema: [10, 15, 20],
  w_mom: [5, 10, 15],
  sc_mb_len: [60, 80, 100, 120],
  sc_osc_len: [5, 7, 10],
  sc_bx_s1: [3, 5, 8],
  sc_bx_s2: [15, 20, 25],
  sc_bx_l1: [15, 20, 25],
  sc_bx_l2: [10, 15, 20],
};
