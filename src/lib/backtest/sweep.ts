/**
 * Signal Quality Backtester — Parameter Sweep, GA Optimizer & Walk-Forward
 *
 * Anti-overfitting refactor: GA optimizes only 5 weight genes (4 free params),
 * TP/SL swept separately in stage 2. Period genes removed (fixed at defaults).
 * Walk-Forward: rolling/anchored IS→OOS validation.
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
  OptimizeParams,
  WalkForwardConfig,
  WalkForwardResult,
  WalkForwardWindow,
} from './types';
import { DEFAULT_CONFIG, DEFAULT_OPTIMIZE_PARAMS } from './types';
import { precomputeSignals, runBacktestFull, type IVDataRow } from './engine';
import { computeAnalytics, monteCarloPermutation } from './analytics';
import type { TechScoreOptions } from '../tech-analysis';

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
                optionsPricing: sweep.optionsPricing,
                slippage: sweep.slippage,
                regimeGates: sweep.regimeGates,
              });
            }
          }
        }
      }
    }
  }
  return configs;
}

// ── Sweep Runner (trade params only) ─────────────────────

export function runSweep(
  candles: BacktestCandle[],
  sweepConfig: SweepConfig,
  onProgress?: (completed: number, total: number) => void,
  ivData?: IVDataRow[],
): SweepResult {
  const t0 = performance.now();

  const total = sweepConfig.tpAtrRange.length *
    sweepConfig.slAtrRange.length * sweepConfig.minScoreRange.length *
    sweepConfig.minConfidenceRange.length * sweepConfig.setupGroups.length *
    sweepConfig.thetaDecayRange.length;

  const { signals, simCandles } = precomputeSignals(candles, '1D', {}, ivData);
  const tradeConfigs = generateTradeConfigs(sweepConfig, {});
  const results: BacktestResult[] = [];
  let completed = 0;

  for (const cfg of tradeConfigs) {
    results.push(runBacktestFull(signals, simCandles, cfg));
    completed++;
    if (onProgress) onProgress(completed, total);
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

/** Gene definition: name, min, max, default, step size */
interface GeneDef {
  key: string;
  min: number;
  max: number;
  def: number;
  step: number;
  isWeight: boolean;
  group: keyof OptimizeParams;  // which toggle enables this gene
}

// All possible gene definitions, grouped by OptimizeParams toggle
const ALL_GENE_DEFS: GeneDef[] = [
  // Weights (sum to 100) — step=2, min≥2 so no factor ever reaches 0
  { key: 'w_mb',  min: 10, max: 40, def: 30, step: 2, isWeight: true,  group: 'weights' },
  { key: 'w_bxs', min: 10, max: 40, def: 26, step: 2, isWeight: true,  group: 'weights' },
  { key: 'w_bxl', min: 4,  max: 34, def: 20, step: 2, isWeight: true,  group: 'weights' },
  { key: 'w_ema', min: 4,  max: 30, def: 14, step: 2, isWeight: true,  group: 'weights' },
  { key: 'w_mom', min: 2,  max: 24, def: 10, step: 2, isWeight: true,  group: 'weights' },
  // Periods
  { key: 'sc_mb_len',  min: 50,  max: 200, def: 100, step: 10, isWeight: false, group: 'periods' },
  { key: 'sc_osc_len', min: 3,   max: 14,  def: 7,   step: 1,  isWeight: false, group: 'periods' },
  { key: 'sc_bx_s1',   min: 3,   max: 10,  def: 5,   step: 1,  isWeight: false, group: 'periods' },
  { key: 'sc_bx_s2',   min: 10,  max: 30,  def: 20,  step: 5,  isWeight: false, group: 'periods' },
  { key: 'sc_bx_l1',   min: 10,  max: 40,  def: 20,  step: 5,  isWeight: false, group: 'periods' },
  { key: 'sc_bx_l2',   min: 10,  max: 30,  def: 15,  step: 5,  isWeight: false, group: 'periods' },
  // Trade params
  { key: 'tpAtr',          min: 1.0, max: 4.0, def: 2.5,  step: 0.5, isWeight: false, group: 'tpSl' },
  { key: 'slAtr',          min: 0.5, max: 3.0, def: 1.5,  step: 0.5, isWeight: false, group: 'tpSl' },
  { key: 'minScore',       min: 55,  max: 90,  def: 70,   step: 5,   isWeight: false, group: 'minScore' },
  { key: 'thetaDecayRate', min: 0.01,max: 0.08,def: 0.03, step: 0.01,isWeight: false, group: 'decay' },
];

/** Build active gene definitions from OptimizeParams toggles */
function buildGeneDefs(params: OptimizeParams): GeneDef[] {
  return ALL_GENE_DEFS.filter(g => params[g.group]);
}

type Individual = number[];

/** Normalize weight genes to sum to 100, cap each at 40 */
function normalizeWeights(genes: Individual, defs: GeneDef[]): Individual {
  const out = [...genes];
  const weightIndices = defs.map((g, i) => g.isWeight ? i : -1).filter(i => i >= 0);
  if (weightIndices.length === 0) return out;

  // Cap each weight at 40 to prevent concentration
  const MAX_WEIGHT = 40;
  for (const i of weightIndices) {
    if (out[i] > MAX_WEIGHT) out[i] = MAX_WEIGHT;
  }

  // Normalize to sum to 100
  let sum = 0;
  for (const i of weightIndices) sum += out[i];
  if (sum <= 0) sum = 1;
  for (const i of weightIndices) {
    out[i] = Math.round((out[i] / sum) * 100);
  }
  // Re-cap after rounding (edge case)
  for (const i of weightIndices) {
    if (out[i] > MAX_WEIGHT) out[i] = MAX_WEIGHT;
  }
  // Fix rounding remainder
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
    if (d.step > 0) {
      v = Math.round(v / d.step) * d.step;
    }
    let val = Math.max(d.min, Math.min(d.max, v));
    val = Math.round(val);
    if (d.step > 0) {
      val = Math.round(val / d.step) * d.step;
      val = Math.max(d.min, Math.min(d.max, val));
    }
    return val;
  });
}

const TRADE_PARAM_KEYS = new Set(['tpAtr', 'slAtr', 'minScore', 'thetaDecayRate']);

/** Convert genes array to indicator options + trade param overrides */
function genesToParams(genes: Individual, defs: GeneDef[]): {
  indicatorOpts: TechScoreOptions;
  tradeOverrides: Partial<BacktestConfig>;
} {
  const indicatorOpts: TechScoreOptions = {};
  const tradeOverrides: Partial<BacktestConfig> = {};
  for (let i = 0; i < defs.length; i++) {
    const key = defs[i].key;
    if (TRADE_PARAM_KEYS.has(key)) {
      (tradeOverrides as Record<string, number>)[key] = genes[i];
    } else {
      (indicatorOpts as Record<string, number>)[key] = genes[i];
    }
  }
  return { indicatorOpts, tradeOverrides };
}

/** Create a random individual */
function randomIndividual(defs: GeneDef[]): Individual {
  const genes = defs.map(d => {
    const steps = Math.round((d.max - d.min) / d.step);
    const randomStep = Math.floor(Math.random() * (steps + 1));
    return d.min + randomStep * d.step;
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

/** Gaussian mutation: `rate` per gene (default 0.20, boosted to 0.40 when stagnating) */
function mutate(genes: Individual, defs: GeneDef[], rate = 0.20): Individual {
  return genes.map((v, i) => {
    if (Math.random() > rate) return v;
    const d = defs[i];
    const sigma = Math.max(d.step, (d.max - d.min) / 6);
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return v + z * sigma;
  });
}

/**
 * Fitness: composite score
 * - Sortino 30%, Profit Factor 20%, Win Rate 15%,
 * - Max Drawdown 15%, Expectancy 10%, Trade Count 10%
 */
export function computeFitness(r: BacktestResult): number {
  const a = r.analytics;
  if (a.totalTrades < 10) return 0;

  // Use option-return metrics when BSM repricing was active
  const sortino = a.optionMode ? (a.optionSortino ?? a.sortino) : a.sortino;
  const pf = a.optionMode ? (a.optionProfitFactor ?? a.profitFactor) : a.profitFactor;
  const wr = a.optionMode ? (a.optionWinRate ?? a.winRateTheta) : a.winRateTheta;
  const dd = a.optionMode ? (a.optionMaxDrawdown ?? a.maxDrawdown) : a.maxDrawdown;
  const exp = a.optionMode ? (a.optionExpectancy ?? a.expectancy) : a.expectancy;

  const sortinoContrib = 0.30 * Math.max(0, Math.min(sortino, 3)) / 3;
  const pfContrib      = 0.25 * Math.max(0, Math.min(pf, 5)) / 5;
  const wrContrib      = 0.20 * (wr / 100);
  const ddContrib      = 0.15 * Math.max(0, 1 - dd / 100);
  const expContrib     = 0.10 * Math.max(0, Math.min(exp, 5)) / 5;

  let fitness = sortinoContrib + pfContrib + wrContrib + ddContrib + expContrib;

  // Correlation penalty: penalize highly correlated sub-scores (discourages weight concentration)
  if (a.avgSubScoreCorrelation != null && a.avgSubScoreCorrelation > 0.3) {
    fitness *= (1 - (a.avgSubScoreCorrelation - 0.3) * 0.15);
  }

  return fitness;
}

/** GA-based optimizer with dynamic gene selection.
 *  Accepts single-ticker candles or multi-ticker Map for cross-ticker fitness averaging. */
/** Yield control back to the browser event loop (keeps UI responsive during heavy computation). */
function yieldToUI(): Promise<void> {
  // Use scheduler.yield() if available (Chrome 115+), otherwise setTimeout
  if (typeof (globalThis as any).scheduler?.yield === 'function') {
    return (globalThis as any).scheduler.yield();
  }
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

export async function runGeneticOptimize(
  candles: BacktestCandle[] | Map<string, BacktestCandle[]>,
  config: OptimizeConfig,
  onProgress?: (gen: number, totalGens: number, bestFitness: number, cacheHits?: number, avgFitness?: number) => void,
  ivData?: IVDataRow[] | Map<string, IVDataRow[]>,
): Promise<OptimizeResult> {
  const t0 = performance.now();
  const POP_SIZE = config.populationSize ?? 30;
  const GENERATIONS = config.generations ?? 20;
  const ELITE_COUNT = 4;
  const TOURNAMENT_K = 3;
  const params = config.optimizeParams ?? DEFAULT_OPTIMIZE_PARAMS;
  const defs = buildGeneDefs(params);

  if (defs.length === 0) {
    // Nothing to optimize — run single eval with current config
    const singleCandles = candles instanceof Map
      ? candles.get(config.ticker) ?? Array.from(candles.values())[0]
      : candles;
    const singleIV = ivData instanceof Map
      ? ivData.get(config.ticker) ?? Array.from(ivData.values())[0]
      : ivData;
    const { signals, simCandles } = precomputeSignals(singleCandles, '1D', {}, singleIV);
    const cfg: BacktestConfig = {
      ...DEFAULT_CONFIG,
      ticker: config.ticker, startDate: config.startDate, endDate: config.endDate,
      tpAtr: config.tpAtr, slAtr: config.slAtr, minScore: config.minScore,
      minConfidence: config.minConfidence, thetaDecayRate: config.thetaDecayRate,
      scoreStopThreshold: config.scoreStopThreshold ?? 55,
    };
    const r = runBacktestFull(signals, simCandles, cfg);
    return { results: [r], rankedBySharpe: [r], rankedByWinRate: [r], bestOverall: r, totalCombos: 1, elapsedMs: performance.now() - t0 };
  }

  // Build ticker list: Map = multi-ticker, array = single ticker
  const isMultiTicker = candles instanceof Map;
  const tickerCandles: Map<string, BacktestCandle[]> = isMultiTicker
    ? candles
    : new Map([[config.ticker, candles]]);
  const tickerIVData: Map<string, IVDataRow[]> | undefined = ivData
    ? (ivData instanceof Map ? ivData : new Map([[config.ticker, ivData]]))
    : undefined;
  const primaryTicker = config.ticker;

  // ── Fitness cache: skip re-evaluating gene combos that normalise to the same values ──
  // Very common in later generations when population converges. Saves 20-40% of backtests.
  const fitnessCache = new Map<string, { result: BacktestResult; fitness: number }>();

  // Temporal robustness lambda: penalty per unit of fitness variance across IS time halves.
  // At 0.5: a config that scores 0.30 early and 0.10 late → robust = 0.20 - 0.5*0.20 = 0.10
  // (same as the worst half). A config that scores 0.28 both halves → robust = 0.28.
  // Raise toward 1.0 for stricter consistency requirement; lower toward 0 to disable.
  const TEMPORAL_LAMBDA = 0.25;
  const MIN_TRADES_FOR_SPLIT = 20;

  const evaluate = (genes: Individual): { result: BacktestResult; fitness: number } => {
    const cacheKey = genes.join('|');
    const cached = fitnessCache.get(cacheKey);
    if (cached) return cached;
    const { indicatorOpts, tradeOverrides } = genesToParams(genes, defs);
    let baseFitnessSum = 0;
    let temporalPenaltySum = 0;
    let fitnessCount = 0;
    const allTrades: BacktestTrade[] = [];
    let totalSignals = 0;
    let lastConfig: BacktestConfig | null = null;

    for (const [ticker, tCandles] of tickerCandles) {
      const { signals, simCandles } = precomputeSignals(tCandles, '1D', indicatorOpts, tickerIVData?.get(ticker));
      const backtestConfig: BacktestConfig = {
        ...DEFAULT_CONFIG,
        ticker,
        startDate: config.startDate,
        endDate: config.endDate,
        timeframe: '1D',
        tpAtr: config.tpAtr,
        slAtr: config.slAtr,
        minScore: config.minScore,
        minConfidence: config.minConfidence,
        thetaDecayRate: config.thetaDecayRate,
        scoreStopThreshold: config.scoreStopThreshold ?? 55,
        ...tradeOverrides,
        indicatorOptions: indicatorOpts,
        optionsPricing: config.optionsPricing,
        slippage: config.slippage,
        regimeGates: config.regimeGates,
      };
      const r = runBacktestFull(signals, simCandles, backtestConfig);
      baseFitnessSum += computeFitness(r);

      // Temporal robustness: split this ticker's IS trades into early/late halves.
      // Penalize configs whose fitness differs significantly between the two halves —
      // they are fitting to a sub-regime rather than a durable edge.
      if (r.trades.length >= MIN_TRADES_FOR_SPLIT) {
        const sorted = [...r.trades].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
        const mid = Math.floor(sorted.length / 2);
        const earlyTrades = sorted.slice(0, mid);
        const lateTrades = sorted.slice(mid);
        const earlyFit = computeFitness({
          config: backtestConfig,
          trades: earlyTrades,
          analytics: computeAnalytics(earlyTrades, backtestConfig, earlyTrades.length),
        });
        const lateFit = computeFitness({
          config: backtestConfig,
          trades: lateTrades,
          analytics: computeAnalytics(lateTrades, backtestConfig, lateTrades.length),
        });
        temporalPenaltySum += Math.abs(earlyFit - lateFit);
      }

      fitnessCount++;
      lastConfig = backtestConfig;

      // Tag trades with ticker and collect
      if (isMultiTicker) {
        for (const t of r.trades) allTrades.push({ ...t, ticker });
      } else {
        allTrades.push(...r.trades);
      }
      totalSignals += r.analytics.totalSignals;
    }

    // Build combined result with merged trades
    const combinedConfig: BacktestConfig = { ...lastConfig!, ticker: isMultiTicker ? primaryTicker : lastConfig!.ticker };
    const combinedAnalytics = computeAnalytics(allTrades, combinedConfig, totalSignals);
    const combinedResult: BacktestResult = { config: combinedConfig, trades: allTrades, analytics: combinedAnalytics };

    const baseFitness = fitnessCount > 0 ? baseFitnessSum / fitnessCount : 0;
    const avgTemporalPenalty = fitnessCount > 0 ? temporalPenaltySum / fitnessCount : 0;
    const robustFitness = Math.max(0, baseFitness - TEMPORAL_LAMBDA * avgTemporalPenalty);

    const entry = { result: combinedResult, fitness: robustFitness };
    fitnessCache.set(cacheKey, entry);
    return entry;
  };

  // Initialize population: default seed + random
  const population: Individual[] = [defaultIndividual(defs)];
  while (population.length < POP_SIZE) {
    population.push(randomIndividual(defs));
  }

  // Evaluate initial population
  const evals0 = population.map(ind => evaluate(ind));
  let results: BacktestResult[] = evals0.map(e => e.result);
  let fitnesses = evals0.map(e => e.fitness);

  // Track all unique results
  const allResultsMap = new Map<string, BacktestResult>();
  const keyOf = (r: BacktestResult) => JSON.stringify({
    opts: r.config.indicatorOptions, tp: r.config.tpAtr, sl: r.config.slAtr,
    sc: r.config.minScore, decay: r.config.thetaDecayRate,
  });
  for (const r of results) allResultsMap.set(keyOf(r), r);

  const generationHistory: { gen: number; bestFitness: number; avgFitness: number }[] = [];
  let totalEvals = POP_SIZE;
  // Early stop: halt after PATIENCE gens with no improvement AND low diversity.
  // MIN_GENS guarantees we don't stop before diversity injections have had a chance.
  const PATIENCE = 5;
  const MIN_GENS = Math.min(10, GENERATIONS);
  // Diversity restart: when population homogenizes (avg/best > threshold),
  // replace bottom RESTART_FRACTION with fresh randoms and boost mutation.
  const DIVERSITY_TRIGGER = 0.95; // avg/best ratio above which we inject
  const RESTART_FRACTION = 0.40;
  const MAX_RESTARTS = 2;
  let restartCount = 0;
  let mutationRate = 0.20;
  let noImproveSince = 0;

  const bestFit0 = Math.max(...fitnesses);
  const avgFit0 = fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length;
  generationHistory.push({ gen: 0, bestFitness: bestFit0, avgFitness: avgFit0 });
  if (onProgress) onProgress(0, GENERATIONS, bestFit0);
  let prevBestFit = bestFit0;

  // Evolution loop
  for (let gen = 1; gen <= GENERATIONS; gen++) {
    const indices = fitnesses.map((_, i) => i).sort((a, b) => fitnesses[b] - fitnesses[a]);

    // ── Diversity injection ─────────────────────────────────
    // When population has homogenized around one solution, kick in fresh blood
    // instead of giving up. Limit to MAX_RESTARTS to avoid thrashing.
    const bestFitPre = fitnesses[indices[0]];
    const avgFitPre = fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length;
    const homogenized = bestFitPre > 0 && (avgFitPre / bestFitPre) > DIVERSITY_TRIGGER;
    if (homogenized && restartCount < MAX_RESTARTS && noImproveSince >= 2) {
      const toReplace = Math.floor(POP_SIZE * RESTART_FRACTION);
      for (let ri = 0; ri < toReplace; ri++) {
        const replaceIdx = indices[POP_SIZE - 1 - ri]; // replace the worst individuals
        const fresh = randomIndividual(defs);
        const { result: freshResult, fitness: freshFit } = evaluate(fresh);
        allResultsMap.set(keyOf(freshResult), freshResult);
        totalEvals++;
        population[replaceIdx] = fresh;
        results[replaceIdx] = freshResult;
        fitnesses[replaceIdx] = freshFit;
      }
      restartCount++;
      noImproveSince = 0;   // give the fresh population a chance
      mutationRate = 0.40;  // boost mutation to help escape local optimum
    }

    // Decay mutation rate back toward baseline after a restart
    if (mutationRate > 0.20) mutationRate = Math.max(0.20, mutationRate - 0.05);

    const nextPop: Individual[] = [];
    const nextResults: BacktestResult[] = [];
    const nextFitnesses: number[] = [];
    for (let i = 0; i < ELITE_COUNT && i < indices.length; i++) {
      nextPop.push([...population[indices[i]]]);
      nextResults.push(results[indices[i]]);
      nextFitnesses.push(fitnesses[indices[i]]);
    }

    while (nextPop.length < POP_SIZE) {
      const parentA = tournamentSelect(population, fitnesses, TOURNAMENT_K);
      const parentB = tournamentSelect(population, fitnesses, TOURNAMENT_K);
      let child = crossover(parentA, parentB);
      child = mutate(child, defs, mutationRate);
      child = clampGenes(child, defs);
      child = normalizeWeights(child, defs);

      const { result: childResult, fitness: childFit } = evaluate(child);
      allResultsMap.set(keyOf(childResult), childResult);
      totalEvals++;

      nextPop.push(child);
      nextResults.push(childResult);
      nextFitnesses.push(childFit);
    }

    population.length = 0;
    population.push(...nextPop);
    results = nextResults;
    fitnesses = nextFitnesses;

    const bestFit = Math.max(...fitnesses);
    const avgFit = fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length;
    generationHistory.push({ gen, bestFitness: bestFit, avgFitness: avgFit });
    if (onProgress) onProgress(gen, GENERATIONS, bestFit, fitnessCache.size, avgFit);

    // Early stopping: halt if no improvement for PATIENCE gens,
    // but only after MIN_GENS so diversity injections have had time to work.
    if (bestFit > prevBestFit + 1e-6) {
      prevBestFit = bestFit;
      noImproveSince = 0;
    } else {
      noImproveSince++;
      if (gen >= MIN_GENS && noImproveSince >= PATIENCE) break;
    }

    // Yield to browser between generations to keep UI responsive
    await yieldToUI();
  }

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
// ── Two-Stage Optimizer ──────────────────────────────────
// ══════════════════════════════════════════════════════════

/**
 * Stage 1: GA optimizes whichever params are enabled in config.optimizeParams.
 * Stage 2: If TP/SL is NOT in the GA genes, grid sweep 12 TP/SL combos using GA's best result.
 *          If TP/SL IS in the GA genes, skip stage 2 (already optimized).
 * Accepts single-ticker candles or multi-ticker Map.
 */
export interface OptimizeProgressDetail {
  gen?: number;
  totalGens?: number;
  bestFitness?: number;
  avgFitness?: number;
  cacheHits?: number;
  totalEvals?: number;
  tpslDone?: number;
  tpslTotal?: number;
}

export async function runTwoStageOptimize(
  candles: BacktestCandle[] | Map<string, BacktestCandle[]>,
  config: OptimizeConfig,
  onProgress?: (phase: 'ga' | 'tpsl', pct: number, detail?: OptimizeProgressDetail) => void,
  ivData?: IVDataRow[] | Map<string, IVDataRow[]>,
): Promise<OptimizeResult> {
  const t0 = performance.now();
  const params = config.optimizeParams ?? DEFAULT_OPTIMIZE_PARAMS;

  // Stage 1: GA
  const gaResult = await runGeneticOptimize(candles, config, (gen, totalGens, bestFitness, cacheHits, avgFitness) => {
    if (onProgress) onProgress('ga', Math.round((gen / totalGens) * 100), { gen, totalGens, bestFitness, avgFitness, cacheHits });
  }, ivData);

  if (!gaResult.bestOverall) {
    return gaResult;
  }

  // If TP/SL is already in the GA, no need for stage 2
  if (params.tpSl) {
    if (onProgress) onProgress('tpsl', 100);
    return { ...gaResult, elapsedMs: performance.now() - t0 };
  }

  // Stage 2: TP/SL grid using GA's best indicator options
  const bestOpts = gaResult.bestOverall.config.indicatorOptions;
  const isMulti = candles instanceof Map;
  const tickerCandlesMap: Map<string, BacktestCandle[]> = isMulti
    ? candles
    : new Map([[config.ticker, candles]]);

  // Pre-compute signals for all tickers
  const tickerIVMap = ivData instanceof Map ? ivData : ivData ? new Map([[config.ticker, ivData]]) : undefined;
  const precomputed = new Map<string, { signals: ReturnType<typeof precomputeSignals>['signals']; simCandles: BacktestCandle[] }>();
  for (const [ticker, tCandles] of tickerCandlesMap) {
    precomputed.set(ticker, precomputeSignals(tCandles, '1D', bestOpts, tickerIVMap?.get(ticker)));
  }

  const tpRange = [1.5, 2.0, 2.5, 3.0];
  const slRange = [1.5, 2.0, 2.5];
  const tpslResults: BacktestResult[] = [];
  const total = tpRange.length * slRange.length;
  let done = 0;

  // Use GA's best values for minScore/decay (they may have been optimized in stage 1)
  const bestCfg = gaResult.bestOverall.config;

  for (const tp of tpRange) {
    for (const sl of slRange) {
      const allTrades: BacktestTrade[] = [];
      let totalSignals = 0;

      for (const [ticker, { signals, simCandles }] of precomputed) {
        const cfg: BacktestConfig = {
          ...DEFAULT_CONFIG,
          ticker,
          startDate: config.startDate,
          endDate: config.endDate,
          tpAtr: tp,
          slAtr: sl,
          minScore: bestCfg.minScore,
          minConfidence: config.minConfidence,
          thetaDecayRate: bestCfg.thetaDecayRate,
          scoreStopThreshold: config.scoreStopThreshold ?? 55,
          indicatorOptions: bestOpts,
          optionsPricing: config.optionsPricing,
          slippage: config.slippage,
          regimeGates: config.regimeGates,
        };
        const r = runBacktestFull(signals, simCandles, cfg);
        if (isMulti) {
          for (const t of r.trades) allTrades.push({ ...t, ticker });
        } else {
          allTrades.push(...r.trades);
        }
        totalSignals += r.analytics.totalSignals;
      }

      const combinedConfig: BacktestConfig = {
        ...DEFAULT_CONFIG,
        ticker: config.ticker,
        startDate: config.startDate,
        endDate: config.endDate,
        tpAtr: tp,
        slAtr: sl,
        minScore: bestCfg.minScore,
        minConfidence: config.minConfidence,
        thetaDecayRate: bestCfg.thetaDecayRate,
        scoreStopThreshold: config.scoreStopThreshold ?? 55,
        indicatorOptions: bestOpts,
        optionsPricing: config.optionsPricing,
        slippage: config.slippage,
        regimeGates: config.regimeGates,
      };
      const combinedAnalytics = computeAnalytics(allTrades, combinedConfig, totalSignals);
      tpslResults.push({ config: combinedConfig, trades: allTrades, analytics: combinedAnalytics });
      done++;
      if (onProgress) onProgress('tpsl', Math.round((done / total) * 100), { tpslDone: done, tpslTotal: total });
    }
  }

  const allResults = [...gaResult.results, ...tpslResults];
  const meaningful = allResults.filter(r => r.analytics.totalTrades >= 10);
  const rankedBySharpe = [...meaningful].sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
  const rankedByWinRate = [...meaningful].sort((a, b) => b.analytics.winRateTheta - a.analytics.winRateTheta);
  const bestOverall = pickBest(meaningful);

  return {
    results: allResults,
    rankedBySharpe,
    rankedByWinRate,
    bestOverall,
    totalCombos: gaResult.totalCombos + total,
    elapsedMs: performance.now() - t0,
    generationHistory: gaResult.generationHistory,
  };
}

// ══════════════════════════════════════════════════════════
// ── Walk-Forward Optimization ────────────────────────────
// ══════════════════════════════════════════════════════════

function buildWalkForwardWindows(
  candles: BacktestCandle[],
  config: WalkForwardConfig
): { isCandles: BacktestCandle[]; oosCandles: BacktestCandle[]; isStart: string; isEnd: string; oosStart: string; oosEnd: string }[] {
  const windows: { isCandles: BacktestCandle[]; oosCandles: BacktestCandle[]; isStart: string; isEnd: string; oosStart: string; oosEnd: string }[] = [];

  const LOOKBACK = 320;
  const purgeGap = config.purgeGapDays ?? 5;
  if (candles.length < LOOKBACK + config.isWindowDays + purgeGap + config.oosWindowDays) return windows;

  let isStartIdx = LOOKBACK;

  while (true) {
    const isEndIdx = config.mode === 'anchored'
      ? LOOKBACK + config.isWindowDays + (windows.length * config.oosWindowDays)
      : isStartIdx + config.isWindowDays;

    const oosStartIdx = isEndIdx + purgeGap;
    const oosEndIdx = oosStartIdx + config.oosWindowDays;

    if (oosEndIdx > candles.length) break;

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

    if (config.mode !== 'anchored') {
      isStartIdx += config.oosWindowDays;
    }
  }

  return windows;
}

export async function runWalkForward(
  candles: BacktestCandle[],
  config: WalkForwardConfig,
  onProgress?: (windowIdx: number, totalWindows: number, phase: 'IS' | 'OOS') => void,
  ivData?: IVDataRow[],
): Promise<WalkForwardResult> {
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
      const gaConfig: OptimizeConfig = {
        ticker: config.ticker,
        startDate: w.isStart,
        endDate: w.isEnd,
        tpAtr: DEFAULT_CONFIG.tpAtr,
        slAtr: DEFAULT_CONFIG.slAtr,
        minScore: DEFAULT_CONFIG.minScore,
        minConfidence: DEFAULT_CONFIG.minConfidence,
        thetaDecayRate: DEFAULT_CONFIG.thetaDecayRate,
        scoreStopThreshold: DEFAULT_CONFIG.scoreStopThreshold,
        populationSize: config.populationSize ?? 30,
        generations: config.generations ?? 20,
      };
      const gaResult = await runGeneticOptimize(w.isCandles, gaConfig, undefined, ivData);
      totalEvals += gaResult.totalCombos;

      if (gaResult.bestOverall) {
        bestISConfig = gaResult.bestOverall.config;
        bestISFitness = computeFitness(gaResult.bestOverall);
      } else {
        bestISConfig = { ...DEFAULT_CONFIG, ticker: config.ticker, startDate: w.isStart, endDate: w.isEnd };
        bestISFitness = 0;
      }
    } else {
      const sweepRanges = config.sweepRanges ?? DEFAULT_SWEEP;
      const sweepConfig: SweepConfig = {
        ...sweepRanges,
        ticker: config.ticker,
        startDate: w.isStart,
        endDate: w.isEnd,
        timeframe: config.timeframe,
      };
      const sweepResult = await runSweep(w.isCandles, sweepConfig, undefined, ivData);
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

    if (onProgress) onProgress(wi, wfWindows.length, 'OOS');
    const oosConfig: BacktestConfig = {
      ...bestISConfig,
      startDate: w.oosStart,
      endDate: w.oosEnd,
    };
    const { signals: oosSig, simCandles: oosSim } = precomputeSignals(w.oosCandles, config.timeframe, oosConfig.indicatorOptions, ivData);
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

  const allOOSTrades: BacktestTrade[] = [];
  for (const wr of windowResults) {
    allOOSTrades.push(...wr.oosResult.trades);
  }

  const aggConfig: BacktestConfig = { ...DEFAULT_CONFIG, ticker: config.ticker };
  const oosAnalytics = computeAnalytics(allOOSTrades, aggConfig, allOOSTrades.length);

  const oosFitness = computeFitness({ config: aggConfig, trades: allOOSTrades, analytics: oosAnalytics });
  const avgISFitness = isFitnessSum / wfWindows.length;
  const wfEfficiency = avgISFitness > 0 ? oosFitness / avgISFitness : 0;

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
