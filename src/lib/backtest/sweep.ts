/**
 * Signal Quality Backtester — Parameter Sweep & GA Optimizer
 *
 * Sweep: vary TP/SL and trade params with fixed indicators
 * Optimize: genetic algorithm to find best indicator weights/periods
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

/** Gene definition: name, min, max, default, isWeight */
interface GeneDef {
  key: keyof TechScoreOptions;
  min: number;
  max: number;
  def: number;
  isWeight: boolean;
  isInteger: boolean;
}

const GENE_DEFS: GeneDef[] = [
  // Weights (must sum to 100)
  { key: 'w_mb',      min: 10, max: 50,  def: 30, isWeight: true,  isInteger: true },
  { key: 'w_bxs',     min: 10, max: 40,  def: 25, isWeight: true,  isInteger: true },
  { key: 'w_bxl',     min: 5,  max: 35,  def: 20, isWeight: true,  isInteger: true },
  { key: 'w_ema',     min: 5,  max: 30,  def: 15, isWeight: true,  isInteger: true },
  { key: 'w_mom',     min: 0,  max: 25,  def: 10, isWeight: true,  isInteger: true },
  // Periods
  { key: 'sc_mb_len', min: 40, max: 160, def: 100, isWeight: false, isInteger: true },
  { key: 'sc_osc_len',min: 3,  max: 14,  def: 7,   isWeight: false, isInteger: true },
  { key: 'sc_bx_s1',  min: 2,  max: 12,  def: 5,   isWeight: false, isInteger: true },
  { key: 'sc_bx_s2',  min: 10, max: 35,  def: 20,  isWeight: false, isInteger: true },
  { key: 'sc_bx_l1',  min: 10, max: 35,  def: 20,  isWeight: false, isInteger: true },
  { key: 'sc_bx_l2',  min: 5,  max: 30,  def: 15,  isWeight: false, isInteger: true },
];

type Individual = number[]; // genes indexed parallel to GENE_DEFS

/** Normalize weight genes (indices 0-4) to sum to 100 */
function normalizeWeights(genes: Individual): Individual {
  const out = [...genes];
  const weightIndices = GENE_DEFS.map((g, i) => g.isWeight ? i : -1).filter(i => i >= 0);
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

/** Clamp gene values to valid ranges */
function clampGenes(genes: Individual): Individual {
  return genes.map((v, i) => {
    const d = GENE_DEFS[i];
    let val = Math.max(d.min, Math.min(d.max, v));
    if (d.isInteger) val = Math.round(val);
    return val;
  });
}

/** Convert genes array to TechScoreOptions */
function genesToOptions(genes: Individual): TechScoreOptions {
  const opts: TechScoreOptions = {};
  for (let i = 0; i < GENE_DEFS.length; i++) {
    (opts as Record<string, number>)[GENE_DEFS[i].key] = genes[i];
  }
  return opts;
}

/** Create a random individual */
function randomIndividual(): Individual {
  const genes = GENE_DEFS.map(d =>
    d.isInteger
      ? Math.floor(Math.random() * (d.max - d.min + 1)) + d.min
      : Math.random() * (d.max - d.min) + d.min
  );
  return normalizeWeights(clampGenes(genes));
}

/** Create the default individual (seed) */
function defaultIndividual(): Individual {
  return GENE_DEFS.map(d => d.def);
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

/** Gaussian mutation: 20% per gene, sigma = range/6 */
function mutate(genes: Individual): Individual {
  return genes.map((v, i) => {
    if (Math.random() > 0.20) return v;
    const d = GENE_DEFS[i];
    const sigma = (d.max - d.min) / 6;
    // Box-Muller for gaussian
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return v + z * sigma;
  });
}

/** Fitness: composite score matching pickBest (Sharpe 35%, WR 25%, PF 25%, DD 15%) */
function computeFitness(r: BacktestResult): number {
  if (r.analytics.totalTrades < 3) return 0;
  const a = r.analytics;
  // Use raw values — normalization happens at ranking time
  // For GA fitness we use a simple additive composite
  const sharpeContrib = Math.max(0, a.sharpe) * 0.35;
  const wrContrib = (a.winRateTheta / 100) * 0.25;
  const pfContrib = Math.min(a.profitFactor, 10) / 10 * 0.25;
  const ddContrib = Math.max(0, 1 - a.maxDrawdown) * 0.15;
  return sharpeContrib + wrContrib + pfContrib + ddContrib;
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

  // Helper: evaluate an individual
  const evaluate = (genes: Individual): BacktestResult => {
    const opts = genesToOptions(genes);
    const { signals, simCandles } = precomputeSignals(candles, '1D', opts);
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
      indicatorOptions: opts,
    };
    return runBacktestFull(signals, simCandles, backtestConfig);
  };

  // Initialize population: default seed + random
  const population: Individual[] = [defaultIndividual()];
  while (population.length < POP_SIZE) {
    population.push(randomIndividual());
  }

  // Evaluate initial population
  let results: BacktestResult[] = population.map(ind => evaluate(ind));
  let fitnesses = results.map(computeFitness);

  // Track all unique results (dedup by indicator options key)
  const allResultsMap = new Map<string, BacktestResult>();
  const keyOf = (r: BacktestResult) => JSON.stringify(r.config.indicatorOptions);
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
      child = mutate(child);
      child = clampGenes(child);
      child = normalizeWeights(child);

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
  const meaningful = allResults.filter(r => r.analytics.totalTrades >= 3);
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
