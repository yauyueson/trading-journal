/**
 * Signal Quality Backtester — Parameter Sweep, GA Optimizer & Walk-Forward
 *
 * Sweep: vary TP/SL and trade params with fixed indicators
 * Optimize: genetic algorithm to find best indicator weights/periods
 *   — supports joint optimization of trade + indicator params
 * Walk-Forward: rolling/anchored IS→OOS validation to prevent overfitting
 */

import type {
  BacktestCandle,
  BacktestConfig,
  BacktestTrade,
  BacktestResult,
  SweepConfig,
  SweepResult,
  OptimizeConfig,
  OptimizeResult,
  IndicatorSweepParams,
  WalkForwardConfig,
  WalkForwardResult,
  WalkForwardWindow,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { precomputeSignals, runBacktestFull } from './engine';
import { computeAnalytics, monteCarloPermutation } from './analytics';
import type { TechScoreOptions } from '../tech-analysis';

// ── Indicator Param Combos (used by Sweep mode) ─────────

export function generateIndicatorCombos(params?: IndicatorSweepParams): TechScoreOptions[] {
  if (!params) return [{}]; // Single combo: all defaults

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

// ══════════════════════════════════════════════════════════
// ── Genetic Algorithm Optimizer ──────────────────────────
// ══════════════════════════════════════════════════════════

/** Gene definition: name, min, max, default, step size, weight flag */
interface GeneDef {
  key: string;
  min: number;
  max: number;
  def: number;
  step: number;         // Minimum granularity (snap to this)
  isWeight: boolean;
  isInteger: boolean;
  isTrade: boolean;     // true = trade param (tpAtr, slAtr, etc.)
}

/** Indicator-only gene definitions */
const INDICATOR_GENE_DEFS: GeneDef[] = [
  // Weights (must sum to 100) — step=5 to avoid over-granular combos
  { key: 'w_mb',       min: 10, max: 50,  def: 30,  step: 5,  isWeight: true,  isInteger: true,  isTrade: false },
  { key: 'w_bxs',      min: 10, max: 40,  def: 25,  step: 5,  isWeight: true,  isInteger: true,  isTrade: false },
  { key: 'w_bxl',      min: 5,  max: 35,  def: 20,  step: 5,  isWeight: true,  isInteger: true,  isTrade: false },
  { key: 'w_ema',      min: 5,  max: 30,  def: 15,  step: 5,  isWeight: true,  isInteger: true,  isTrade: false },
  { key: 'w_mom',      min: 0,  max: 25,  def: 10,  step: 5,  isWeight: true,  isInteger: true,  isTrade: false },
  // Periods — step=5 for MB length (big range), step=5 for BX periods
  { key: 'sc_mb_len',  min: 40, max: 160, def: 100, step: 10, isWeight: false, isInteger: true,  isTrade: false },
  { key: 'sc_osc_len', min: 3,  max: 14,  def: 7,   step: 2,  isWeight: false, isInteger: true,  isTrade: false },
  { key: 'sc_bx_s1',   min: 2,  max: 12,  def: 5,   step: 2,  isWeight: false, isInteger: true,  isTrade: false },
  { key: 'sc_bx_s2',   min: 10, max: 35,  def: 20,  step: 5,  isWeight: false, isInteger: true,  isTrade: false },
  { key: 'sc_bx_l1',   min: 10, max: 35,  def: 20,  step: 5,  isWeight: false, isInteger: true,  isTrade: false },
  { key: 'sc_bx_l2',   min: 5,  max: 30,  def: 15,  step: 5,  isWeight: false, isInteger: true,  isTrade: false },
];

/** Trade-param gene definitions (for joint optimization) */
const TRADE_GENE_DEFS: GeneDef[] = [
  { key: 'tpAtr',          min: 1.0, max: 4.0,  def: 2.5,  step: 0.25, isWeight: false, isInteger: false, isTrade: true },
  { key: 'slAtr',          min: 0.5, max: 3.0,  def: 1.5,  step: 0.25, isWeight: false, isInteger: false, isTrade: true },
  { key: 'minScore',       min: 55,  max: 85,   def: 70,   step: 5,    isWeight: false, isInteger: true,  isTrade: true },
  { key: 'thetaDecayRate', min: 0.01,max: 0.08, def: 0.03, step: 0.01, isWeight: false, isInteger: false, isTrade: true },
];

type Individual = number[]; // genes indexed parallel to active GENE_DEFS

/** Get active gene defs based on joint mode */
function getGeneDefs(joint: boolean): GeneDef[] {
  return joint ? [...INDICATOR_GENE_DEFS, ...TRADE_GENE_DEFS] : INDICATOR_GENE_DEFS;
}

/** Normalize weight genes to sum to 100 */
function normalizeWeights(genes: Individual, defs: GeneDef[]): Individual {
  const out = [...genes];
  const weightIndices = defs.map((g, i) => g.isWeight ? i : -1).filter(i => i >= 0);
  let sum = 0;
  for (const i of weightIndices) sum += out[i];
  if (sum <= 0) sum = 1;
  for (const i of weightIndices) {
    out[i] = Math.round((out[i] / sum) * 100);
  }
  // Fix rounding error: adjust largest weight
  const wSum = weightIndices.reduce((s, i) => s + out[i], 0);
  if (wSum !== 100) {
    const maxIdx = weightIndices.reduce((a, b) => out[a] >= out[b] ? a : b);
    out[maxIdx] += 100 - wSum;
  }
  return out;
}

/** Clamp gene values to valid ranges and snap to step */
function clampGenes(genes: Individual, defs: GeneDef[]): Individual {
  return genes.map((v, i) => {
    const d = defs[i];
    // Snap to step size
    if (d.step > 0) {
      v = Math.round(v / d.step) * d.step;
    }
    let val = Math.max(d.min, Math.min(d.max, v));
    if (d.isInteger) val = Math.round(val);
    // Re-snap after clamping (edge case: min/max not aligned to step)
    if (d.step > 0) {
      val = Math.round(val / d.step) * d.step;
      val = Math.max(d.min, Math.min(d.max, val));
    }
    return val;
  });
}

/** Convert genes array to TechScoreOptions (indicator genes only) */
function genesToIndicatorOptions(genes: Individual, defs: GeneDef[]): TechScoreOptions {
  const opts: TechScoreOptions = {};
  for (let i = 0; i < defs.length; i++) {
    if (!defs[i].isTrade) {
      (opts as Record<string, number>)[defs[i].key] = genes[i];
    }
  }
  return opts;
}

/** Extract trade params from genes (joint mode) */
function genesToTradeParams(genes: Individual, defs: GeneDef[]): Partial<BacktestConfig> {
  const params: Record<string, number> = {};
  for (let i = 0; i < defs.length; i++) {
    if (defs[i].isTrade) {
      params[defs[i].key] = genes[i];
    }
  }
  return params as unknown as Partial<BacktestConfig>;
}

/** Create a random individual */
function randomIndividual(defs: GeneDef[]): Individual {
  const genes = defs.map(d => {
    if (d.step > 0) {
      // Generate random value snapped to step
      const steps = Math.round((d.max - d.min) / d.step);
      const randomStep = Math.floor(Math.random() * (steps + 1));
      return d.min + randomStep * d.step;
    }
    return d.isInteger
      ? Math.floor(Math.random() * (d.max - d.min + 1)) + d.min
      : Math.random() * (d.max - d.min) + d.min;
  });
  return normalizeWeights(clampGenes(genes, defs), defs);
}

/** Create the default individual (seed) */
function defaultIndividual(defs: GeneDef[]): Individual {
  return defs.map(d => d.def);
}

/** Tournament selection: pick `k` random, return the best */
function tournamentSelect(pop: Individual[], fitnesses: number[], k: number): Individual {
  let bestIdx = Math.floor(Math.random() * pop.length);
  for (let i = 1; i < k; i++) {
    const idx = Math.floor(Math.random() * pop.length);
    if (fitnesses[idx] > fitnesses[bestIdx]) bestIdx = idx;
  }
  return [...pop[bestIdx]];
}

/** Uniform crossover: 50% chance per gene from each parent */
function crossover(a: Individual, b: Individual): Individual {
  return a.map((v, i) => Math.random() < 0.5 ? v : b[i]);
}

/** Gaussian mutation: 20% per gene, sigma = range/(6/step) */
function mutate(genes: Individual, defs: GeneDef[]): Individual {
  return genes.map((v, i) => {
    if (Math.random() > 0.20) return v;
    const d = defs[i];
    // Sigma scaled to produce meaningful jumps (at least 1 step)
    const sigma = Math.max(d.step, (d.max - d.min) / 6);
    // Box-Muller for gaussian
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return v + z * sigma;
  });
}

/**
 * Fitness: composite score
 * - Sortino 30% (rewards upside, penalizes downside vol)
 * - Profit Factor 20% (capped at 5)
 * - Win Rate (theta) 15%
 * - Max Drawdown 15% (lower is better)
 * - Expectancy 10%
 * - Trade Count 10% (scales up to 50 trades)
 */
export function computeFitness(r: BacktestResult): number {
  const a = r.analytics;
  if (a.totalTrades < 10) return 0;

  const sortinoContrib = 0.30 * Math.max(0, Math.min(a.sortino, 3)) / 3;
  const pfContrib      = 0.20 * Math.max(0, Math.min(a.profitFactor, 5)) / 5;
  const wrContrib      = 0.15 * (a.winRateTheta / 100);
  const ddContrib      = 0.15 * Math.max(0, 1 - a.maxDrawdown / 100);
  const expContrib     = 0.10 * Math.max(0, Math.min(a.expectancy, 5)) / 5;
  const countContrib   = 0.10 * Math.min(1, a.totalTrades / 50);

  return sortinoContrib + pfContrib + wrContrib + ddContrib + expContrib + countContrib;
}

/** GA-based signal parameter optimizer */
export function runGeneticOptimize(
  candles: BacktestCandle[],
  config: OptimizeConfig,
  onProgress?: (gen: number, totalGens: number, bestFitness: number) => void
): OptimizeResult {
  const t0 = performance.now();
  const POP_SIZE = config.populationSize ?? 40;
  const GENERATIONS = config.generations ?? 30;
  const ELITE_COUNT = 4;
  const TOURNAMENT_K = 3;
  const joint = config.jointOptimize ?? false;
  const defs = getGeneDefs(joint);

  // Helper: evaluate an individual
  const evaluate = (genes: Individual): BacktestResult => {
    const opts = genesToIndicatorOptions(genes, defs);
    const { signals, simCandles } = precomputeSignals(candles, '1D', opts);

    const tradeOverrides = joint ? genesToTradeParams(genes, defs) : {};
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
      ...tradeOverrides,
      indicatorOptions: opts,
    };
    return runBacktestFull(signals, simCandles, backtestConfig);
  };

  // Initialize population: default seed + random
  const population: Individual[] = [defaultIndividual(defs)];
  while (population.length < POP_SIZE) {
    population.push(randomIndividual(defs));
  }

  // Evaluate initial population
  let results: BacktestResult[] = population.map(ind => evaluate(ind));
  let fitnesses = results.map(computeFitness);

  // Track all unique results (dedup by indicator options key)
  const allResultsMap = new Map<string, BacktestResult>();
  const keyOf = (r: BacktestResult) => JSON.stringify({
    ind: r.config.indicatorOptions,
    tp: r.config.tpAtr,
    sl: r.config.slAtr,
    sc: r.config.minScore,
    td: r.config.thetaDecayRate,
  });
  for (const r of results) allResultsMap.set(keyOf(r), r);

  const generationHistory: { gen: number; bestFitness: number; avgFitness: number }[] = [];
  let totalEvals = POP_SIZE;

  // Record gen 0
  const bestFit0 = Math.max(...fitnesses);
  const avgFit0 = fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length;
  generationHistory.push({ gen: 0, bestFitness: bestFit0, avgFitness: avgFit0 });
  if (onProgress) onProgress(0, GENERATIONS, bestFit0);

  // Evolution loop
  for (let gen = 1; gen <= GENERATIONS; gen++) {
    // Sort by fitness descending
    const indices = fitnesses.map((_, i) => i).sort((a, b) => fitnesses[b] - fitnesses[a]);

    // Elitism: keep top ELITE_COUNT
    const nextPop: Individual[] = [];
    const nextResults: BacktestResult[] = [];
    const nextFitnesses: number[] = [];
    for (let i = 0; i < ELITE_COUNT && i < indices.length; i++) {
      nextPop.push([...population[indices[i]]]);
      nextResults.push(results[indices[i]]);
      nextFitnesses.push(fitnesses[indices[i]]);
    }

    // Fill remaining with offspring
    while (nextPop.length < POP_SIZE) {
      const parentA = tournamentSelect(population, fitnesses, TOURNAMENT_K);
      const parentB = tournamentSelect(population, fitnesses, TOURNAMENT_K);
      let child = crossover(parentA, parentB);
      child = mutate(child, defs);
      child = clampGenes(child, defs);
      child = normalizeWeights(child, defs);

      const result = evaluate(child);
      const fit = computeFitness(result);
      allResultsMap.set(keyOf(result), result);
      totalEvals++;

      nextPop.push(child);
      nextResults.push(result);
      nextFitnesses.push(fit);
    }

    // Replace population
    population.length = 0;
    population.push(...nextPop);
    results = nextResults;
    fitnesses = nextFitnesses;

    const bestFit = Math.max(...fitnesses);
    const avgFit = fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length;
    generationHistory.push({ gen, bestFitness: bestFit, avgFitness: avgFit });
    if (onProgress) onProgress(gen, GENERATIONS, bestFit);
  }

  // Collect all evaluated results, rank them
  const allResults = Array.from(allResultsMap.values());
  const meaningful = allResults.filter(r => r.analytics.totalTrades >= 10);
  const rankedBySharpe = [...meaningful].sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
  const rankedByWinRate = [...meaningful].sort((a, b) => b.analytics.winRateTheta - a.analytics.winRateTheta);
  const bestOverall = pickBest(meaningful);

  return {
    results: allResults,
    rankedBySharpe,
    rankedByWinRate,
    bestOverall,
    totalCombos: totalEvals,
    elapsedMs: performance.now() - t0,
    generationHistory,
  };
}

// ══════════════════════════════════════════════════════════
// ── Walk-Forward Optimization ────────────────────────────
// ══════════════════════════════════════════════════════════

/**
 * Split candles into date-based windows.
 * Returns array of { isCandles, oosCandles, isStart, isEnd, oosStart, oosEnd }
 */
function buildWalkForwardWindows(
  candles: BacktestCandle[],
  config: WalkForwardConfig
): { isCandles: BacktestCandle[]; oosCandles: BacktestCandle[]; isStart: string; isEnd: string; oosStart: string; oosEnd: string }[] {
  const windows: { isCandles: BacktestCandle[]; oosCandles: BacktestCandle[]; isStart: string; isEnd: string; oosStart: string; oosEnd: string }[] = [];

  // We need at least LOOKBACK_DAILY (320) bars before our first IS window starts
  const LOOKBACK = 320;
  if (candles.length < LOOKBACK + config.isWindowDays + config.oosWindowDays) return windows;

  // Start IS after lookback period
  let isStartIdx = LOOKBACK;

  while (true) {
    const isEndIdx = config.mode === 'anchored'
      ? LOOKBACK + config.isWindowDays + (windows.length * config.oosWindowDays)
      : isStartIdx + config.isWindowDays;

    const oosStartIdx = isEndIdx;
    const oosEndIdx = oosStartIdx + config.oosWindowDays;

    if (oosEndIdx > candles.length) break;

    // For IS: include lookback bars before the IS window for indicator warmup
    const isLookbackStart = config.mode === 'anchored' ? 0 : Math.max(0, isStartIdx - LOOKBACK);
    const isCandles = candles.slice(isLookbackStart, isEndIdx);
    const oosCandles = candles.slice(Math.max(0, oosStartIdx - LOOKBACK), oosEndIdx);

    windows.push({
      isCandles,
      oosCandles,
      isStart: candles[isStartIdx]?.date ?? '',
      isEnd: candles[isEndIdx - 1]?.date ?? '',
      oosStart: candles[oosStartIdx]?.date ?? '',
      oosEnd: candles[oosEndIdx - 1]?.date ?? '',
    });

    if (config.mode === 'anchored') {
      // IS always starts from beginning, just extend
      // Next OOS window slides forward
    } else {
      isStartIdx += config.oosWindowDays; // Roll forward by OOS window size
    }
  }

  return windows;
}

/**
 * Run Walk-Forward Optimization.
 *
 * For each window:
 *   1. Optimize on IS data (GA or sweep)
 *   2. Evaluate best IS config on OOS data
 *   3. Collect OOS results
 *
 * Final result = aggregated OOS-only performance (no in-sample leakage).
 */
export function runWalkForward(
  candles: BacktestCandle[],
  config: WalkForwardConfig,
  onProgress?: (windowIdx: number, totalWindows: number, phase: 'IS' | 'OOS') => void
): WalkForwardResult {
  const t0 = performance.now();
  const wfWindows = buildWalkForwardWindows(candles, config);

  if (wfWindows.length === 0) {
    const emptyConfig: BacktestConfig = { ...DEFAULT_CONFIG, ticker: config.ticker };
    return {
      config,
      windows: [],
      oosAnalytics: computeAnalytics([], emptyConfig, 0),
      oosTrades: [],
      wfEfficiency: 0,
      totalEvals: 0,
      elapsedMs: 0,
    };
  }

  const windowResults: WalkForwardWindow[] = [];
  let totalEvals = 0;
  let isFitnessSum = 0;

  for (let wi = 0; wi < wfWindows.length; wi++) {
    const w = wfWindows[wi];
    if (onProgress) onProgress(wi, wfWindows.length, 'IS');

    let bestISConfig: BacktestConfig;
    let bestISFitness: number;

    if (config.optimizer === 'ga') {
      // Run GA on IS data
      const gaConfig: OptimizeConfig = {
        ticker: config.ticker,
        startDate: w.isStart,
        endDate: w.isEnd,
        tpAtr: DEFAULT_CONFIG.tpAtr,
        slAtr: DEFAULT_CONFIG.slAtr,
        minScore: DEFAULT_CONFIG.minScore,
        minConfidence: DEFAULT_CONFIG.minConfidence,
        thetaDecayRate: DEFAULT_CONFIG.thetaDecayRate,
        populationSize: config.populationSize ?? 40,
        generations: config.generations ?? 20,
        jointOptimize: config.jointOptimize ?? false,
      };
      const gaResult = runGeneticOptimize(w.isCandles, gaConfig);
      totalEvals += gaResult.totalCombos;

      if (gaResult.bestOverall) {
        bestISConfig = gaResult.bestOverall.config;
        bestISFitness = computeFitness(gaResult.bestOverall);
      } else {
        bestISConfig = { ...DEFAULT_CONFIG, ticker: config.ticker, startDate: w.isStart, endDate: w.isEnd };
        bestISFitness = 0;
      }
    } else {
      // Run sweep on IS data
      const sweepRanges = config.sweepRanges ?? DEFAULT_SWEEP;
      const sweepConfig: SweepConfig = {
        ...sweepRanges,
        ticker: config.ticker,
        startDate: w.isStart,
        endDate: w.isEnd,
        timeframe: config.timeframe,
      };
      const sweepResult = runSweep(w.isCandles, sweepConfig);
      totalEvals += sweepResult.totalCombos;

      if (sweepResult.bestOverall) {
        bestISConfig = sweepResult.bestOverall.config;
        bestISFitness = computeFitness(sweepResult.bestOverall);
      } else {
        bestISConfig = { ...DEFAULT_CONFIG, ticker: config.ticker, startDate: w.isStart, endDate: w.isEnd };
        bestISFitness = 0;
      }
    }

    isFitnessSum += bestISFitness;

    // Evaluate on OOS data using best IS config
    if (onProgress) onProgress(wi, wfWindows.length, 'OOS');
    const oosConfig: BacktestConfig = {
      ...bestISConfig,
      startDate: w.oosStart,
      endDate: w.oosEnd,
    };
    const { signals: oosSig, simCandles: oosSim } = precomputeSignals(w.oosCandles, config.timeframe, oosConfig.indicatorOptions);
    const oosResult = runBacktestFull(oosSig, oosSim, oosConfig);
    totalEvals++;

    windowResults.push({
      windowIndex: wi,
      isStart: w.isStart,
      isEnd: w.isEnd,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      isBestConfig: bestISConfig,
      isBestFitness: bestISFitness,
      oosResult,
    });
  }

  // Concatenate all OOS trades for aggregate analytics
  const allOOSTrades: BacktestTrade[] = [];
  for (const wr of windowResults) {
    allOOSTrades.push(...wr.oosResult.trades);
  }

  // Compute aggregate OOS analytics
  const aggConfig: BacktestConfig = { ...DEFAULT_CONFIG, ticker: config.ticker };
  const oosAnalytics = computeAnalytics(allOOSTrades, aggConfig, allOOSTrades.length);

  // Walk-forward efficiency = OOS fitness / IS fitness
  const oosFitness = computeFitness({ config: aggConfig, trades: allOOSTrades, analytics: oosAnalytics });
  const avgISFitness = isFitnessSum / wfWindows.length;
  const wfEfficiency = avgISFitness > 0 ? oosFitness / avgISFitness : 0;

  // Monte Carlo on OOS trades
  const mc = allOOSTrades.length >= 10 ? monteCarloPermutation(allOOSTrades, 500) : undefined;

  return {
    config,
    windows: windowResults,
    oosAnalytics,
    oosTrades: allOOSTrades,
    wfEfficiency,
    monteCarlo: mc,
    totalEvals,
    elapsedMs: performance.now() - t0,
  };
}

// ── Best Pick (weighted composite) ──────────────────────

function pickBest(results: BacktestResult[]): BacktestResult | null {
  if (results.length === 0) return null;

  let best: BacktestResult | null = null;
  let bestScore = -Infinity;

  for (const r of results) {
    const score = computeFitness(r);
    if (score > bestScore) {
      bestScore = score;
      best = r;
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
