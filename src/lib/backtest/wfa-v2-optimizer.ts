/**
 * WFA v2 Optimizer — TPE Bayesian Optimization + Grid Search
 *
 * TPE (Tree-structured Parzen Estimator) for efficient hyperparameter
 * optimization in high-dimensional spaces. Pure TypeScript, no dependencies.
 *
 * References:
 * - Bergstra et al. "Algorithms for Hyper-Parameter Optimization" (2011)
 * - Bergstra et al. "Making a Science of Model Search" (2013)
 */

import type {
  TPEConfig, TPETrial, TPEResult,
  ParameterSpace,
  GridConfig, SignalPresetKey,
  DTEProfile,
} from './wfa-v2-types';
import { DEFAULT_TPE_CONFIG, PROFILE_BOUNDS } from './wfa-v2-types';
import type { SimConfig } from './option-sim';
import type { DirConfTier } from './types';

// ── Seeded PRNG ─────────────────────────────────────────

function createRng(seed: number): () => number {
  let s0 = seed | 0 || 1;
  let s1 = (seed * 2654435761) | 0 || 2;
  let s2 = (seed * 2246822519) | 0 || 3;
  let s3 = (seed * 3266489917) | 0 || 4;

  return () => {
    const result = ((s1 * 5) << 7 | (s1 * 5) >>> 25) * 9;
    const t = s1 << 9;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11) | (s3 >>> 21);
    return (result >>> 0) / 4294967296;
  };
}

// ── 1D Kernel Density Estimation ────────────────────────

/** Gaussian KDE with Scott's bandwidth */
function gaussianKDE(samples: number[], bandwidth?: number): (x: number) => number {
  const n = samples.length;
  if (n === 0) return () => 0;
  if (n === 1) return (x) => Math.exp(-0.5 * ((x - samples[0]) / 0.1) ** 2) / (0.1 * Math.sqrt(2 * Math.PI));

  const mean = samples.reduce((s, v) => s + v, 0) / n;
  const std = Math.sqrt(samples.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  const h = bandwidth ?? 1.06 * (std || 1) * Math.pow(n, -0.2); // Scott's rule

  return (x: number): number => {
    let density = 0;
    for (const s of samples) {
      const u = (x - s) / h;
      density += Math.exp(-0.5 * u * u);
    }
    return density / (n * h * Math.sqrt(2 * Math.PI));
  };
}

// ── Parameter Space Builder ─────────────────────────────

/**
 * Build the parameter space for a given DTE profile.
 */
export function buildParameterSpace(profile: DTEProfile): ParameterSpace {
  const bounds = PROFILE_BOUNDS[profile];

  return {
    continuous: [
      { name: 'creditShortDelta', low: bounds.creditShortDelta[0], high: bounds.creditShortDelta[1] },
      { name: 'creditSpreadWidth', low: bounds.creditSpreadWidth[0], high: bounds.creditSpreadWidth[1] },
      { name: 'creditProfitTarget', low: bounds.creditProfitTarget[0], high: bounds.creditProfitTarget[1] },
      // SL locked to no-stop range: Phase 1 proved SL 2x destroys returns (Sharpe 0.04)
      { name: 'creditStopLossMultiple', low: 50, high: 100 },
      // Delta stop disabled by default (0 = off); narrow range to avoid jittery exits
      { name: 'creditDeltaStop', low: 0, high: 0.05 },
      { name: 'minIVRank', low: 0, high: 50 },
      { name: 'vrpFilter', low: -0.05, high: 0.30 },
      { name: 'contangoFilter', low: -0.10, high: 0.20 },
      { name: 'maxIVSkew', low: 0.01, high: 0.20 },
      { name: 'slopeFilter', low: -5.0, high: 5.0 },
    ],
    integer: [
      { name: 'creditTimeStopDTE', low: bounds.creditTimeStopDTE[0], high: bounds.creditTimeStopDTE[1] },
      { name: 'monitoringIntervalDays', low: bounds.monitoringIntervalDays[0], high: bounds.monitoringIntervalDays[1] },
      { name: 'maxPerTicker', low: 1, high: 10 },
      { name: 'maxPositions', low: 3, high: 15 },
    ],
    categorical: [
      { name: 'signalWeightPreset', choices: ['ema', 'mom', 'em', 'mf', 'full', 'mb', 'adx', 'vol'] },
      { name: 'useSmvVol', choices: [true, false] },
      { name: 'dirConfTier', choices: ['any', 'medium+', 'high'] },
    ],
  };
}

// ── Random Sampling ─────────────────────────────────────

function sampleRandom(space: ParameterSpace, rng: () => number): Record<string, number | string | boolean> {
  const params: Record<string, number | string | boolean> = {};

  for (const p of space.continuous) {
    if (p.log) {
      const logLow = Math.log(Math.max(p.low, 1e-10));
      const logHigh = Math.log(Math.max(p.high, 1e-10));
      params[p.name] = Math.exp(logLow + rng() * (logHigh - logLow));
    } else {
      params[p.name] = p.low + rng() * (p.high - p.low);
    }
  }

  for (const p of space.integer) {
    params[p.name] = Math.round(p.low + rng() * (p.high - p.low));
  }

  for (const p of space.categorical) {
    params[p.name] = p.choices[Math.floor(rng() * p.choices.length)];
  }

  return params;
}

// ── TPE Core ────────────────────────────────────────────

/**
 * Run TPE optimization.
 *
 * @param space - Parameter space definition
 * @param objectiveFn - Function that evaluates params and returns objective (higher = better)
 * @param config - TPE configuration
 * @param onProgress - Optional callback per trial
 * @returns Best trial and full history
 */
export function runTPE(
  space: ParameterSpace,
  objectiveFn: (params: Record<string, number | string | boolean>) => number,
  config: TPEConfig = DEFAULT_TPE_CONFIG,
  onProgress?: (trial: number, total: number, best: number) => void,
): TPEResult {
  const t0 = Date.now();
  const rng = createRng(config.seed);
  const trials: TPETrial[] = [];

  // Phase 1: Random startup
  for (let i = 0; i < config.nStartup; i++) {
    const params = sampleRandom(space, rng);
    const objective = objectiveFn(params);
    trials.push({ trialId: i, params, objective });
    onProgress?.(i + 1, config.nTotal, Math.max(...trials.map(t => t.objective)));
  }

  // Phase 2: TPE-guided search
  for (let i = config.nStartup; i < config.nTotal; i++) {
    // Split into good (top gamma%) and bad
    const sorted = [...trials].sort((a, b) => b.objective - a.objective);
    const splitIdx = Math.max(1, Math.ceil(trials.length * config.gamma));
    const good = sorted.slice(0, splitIdx);
    const bad = sorted.slice(splitIdx);

    // Generate candidates and pick the one with best l(x)/g(x) ratio
    let bestCandidate: Record<string, number | string | boolean> | null = null;
    let bestRatio = -Infinity;

    for (let c = 0; c < config.nCandidates; c++) {
      const candidate = sampleFromGood(space, good, bad, rng);
      const lx = evaluateDensity(candidate, good, space);
      const gx = evaluateDensity(candidate, bad, space);
      const ratio = gx > 0 ? lx / gx : lx > 0 ? Infinity : 0;

      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestCandidate = candidate;
      }
    }

    const params = bestCandidate ?? sampleRandom(space, rng);
    const objective = objectiveFn(params);
    trials.push({ trialId: i, params, objective });
    onProgress?.(i + 1, config.nTotal, Math.max(...trials.map(t => t.objective)));
  }

  const bestTrial = trials.reduce((best, t) => t.objective > best.objective ? t : best, trials[0]);

  return {
    bestTrial,
    allTrials: trials,
    bestParams: bestTrial.params,
    bestObjective: bestTrial.objective,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Sample a candidate from the "good" distribution (l(x)).
 * For continuous/integer: sample from KDE fitted to good observations.
 * For categorical: sample proportional to frequency in good group.
 */
function sampleFromGood(
  space: ParameterSpace,
  good: TPETrial[],
  _bad: TPETrial[],
  rng: () => number,
): Record<string, number | string | boolean> {
  const params: Record<string, number | string | boolean> = {};

  // Continuous parameters: sample from good KDE
  for (const p of space.continuous) {
    const goodValues = good.map(t => t.params[p.name] as number);
    if (goodValues.length === 0) {
      params[p.name] = p.low + rng() * (p.high - p.low);
      continue;
    }

    // Sample one of the good values, then add Gaussian noise
    const base = goodValues[Math.floor(rng() * goodValues.length)];
    const std = Math.max((p.high - p.low) * 0.1, 1e-6);
    let value = base + (rng() - 0.5) * 2 * std;

    // Clip to bounds
    value = Math.max(p.low, Math.min(p.high, value));
    if (p.log) {
      value = Math.max(p.low, value);
    }
    params[p.name] = value;
  }

  // Integer parameters: same approach, rounded
  for (const p of space.integer) {
    const goodValues = good.map(t => t.params[p.name] as number);
    if (goodValues.length === 0) {
      params[p.name] = Math.round(p.low + rng() * (p.high - p.low));
      continue;
    }
    const base = goodValues[Math.floor(rng() * goodValues.length)];
    const range = p.high - p.low;
    let value = base + Math.round((rng() - 0.5) * range * 0.3);
    value = Math.max(p.low, Math.min(p.high, Math.round(value)));
    params[p.name] = value;
  }

  // Categorical parameters: proportional to frequency in good group
  for (const p of space.categorical) {
    const counts = new Map<string | boolean, number>();
    for (const choice of p.choices) counts.set(choice, 1); // Laplace smoothing
    for (const t of good) {
      const v = t.params[p.name] as string | boolean;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((s, c) => s + c, 0);
    let r = rng() * total;
    for (const [choice, count] of counts) {
      r -= count;
      if (r <= 0) { params[p.name] = choice; break; }
    }
    if (!(p.name in params)) params[p.name] = p.choices[0];
  }

  return params;
}

/**
 * Evaluate the density of a candidate under a group's distribution.
 */
function evaluateDensity(
  candidate: Record<string, number | string | boolean>,
  group: TPETrial[],
  space: ParameterSpace,
): number {
  if (group.length === 0) return 1e-10;

  let logDensity = 0;

  // Continuous + integer: Gaussian KDE
  for (const p of [...space.continuous, ...space.integer]) {
    const values = group.map(t => t.params[p.name] as number);
    const kde = gaussianKDE(values);
    const d = kde(candidate[p.name] as number);
    logDensity += Math.log(Math.max(d, 1e-10));
  }

  // Categorical: frequency-based
  for (const p of space.categorical) {
    const counts = new Map<string | boolean, number>();
    for (const choice of p.choices) counts.set(choice, 1); // Laplace smoothing
    for (const t of group) {
      const v = t.params[p.name] as string | boolean;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((s, c) => s + c, 0);
    const freq = (counts.get(candidate[p.name] as string | boolean) ?? 1) / total;
    logDensity += Math.log(Math.max(freq, 1e-10));
  }

  return Math.exp(logDensity);
}

// ── Grid Search ─────────────────────────────────────────

/**
 * Generate all combinations from a grid config for focused factorial sweeps.
 */
export function generateGrid(
  gridConfig: GridConfig,
  _profile: DTEProfile,
): Record<string, number | string | boolean>[] {
  const dimensions: { name: string; values: (number | string | boolean)[] }[] = [];

  // Add each non-empty grid dimension
  if (gridConfig.creditShortDelta?.length) dimensions.push({ name: 'creditShortDelta', values: gridConfig.creditShortDelta });
  if (gridConfig.creditSpreadWidth?.length) dimensions.push({ name: 'creditSpreadWidth', values: gridConfig.creditSpreadWidth });
  if (gridConfig.creditProfitTarget?.length) dimensions.push({ name: 'creditProfitTarget', values: gridConfig.creditProfitTarget });
  if (gridConfig.creditStopLossMultiple?.length) dimensions.push({ name: 'creditStopLossMultiple', values: gridConfig.creditStopLossMultiple });
  if (gridConfig.creditTimeStopDTE?.length) dimensions.push({ name: 'creditTimeStopDTE', values: gridConfig.creditTimeStopDTE });
  if (gridConfig.creditDeltaStop?.length) dimensions.push({ name: 'creditDeltaStop', values: gridConfig.creditDeltaStop });
  if (gridConfig.minIVRank?.length) dimensions.push({ name: 'minIVRank', values: gridConfig.minIVRank });
  if (gridConfig.vrpFilter?.length) dimensions.push({ name: 'vrpFilter', values: gridConfig.vrpFilter });
  if (gridConfig.contangoFilter?.length) dimensions.push({ name: 'contangoFilter', values: gridConfig.contangoFilter });
  if (gridConfig.slopeFilter?.length) dimensions.push({ name: 'slopeFilter', values: gridConfig.slopeFilter });
  if (gridConfig.maxIVSkew?.length) dimensions.push({ name: 'maxIVSkew', values: gridConfig.maxIVSkew });
  if (gridConfig.maxPerTicker?.length) dimensions.push({ name: 'maxPerTicker', values: gridConfig.maxPerTicker });
  if (gridConfig.maxPositions?.length) dimensions.push({ name: 'maxPositions', values: gridConfig.maxPositions });
  if (gridConfig.signalWeightPreset?.length) dimensions.push({ name: 'signalWeightPreset', values: gridConfig.signalWeightPreset });
  if (gridConfig.useSmvVol?.length) dimensions.push({ name: 'useSmvVol', values: gridConfig.useSmvVol });
  if (gridConfig.dirConfTier?.length) dimensions.push({ name: 'dirConfTier', values: gridConfig.dirConfTier });

  // Default values for dimensions not in the grid
  const defaults: Record<string, number | string | boolean> = {
    creditShortDelta: 0.35,
    creditSpreadWidth: 15,
    creditProfitTarget: 0.30,
    creditStopLossMultiple: 100,
    creditTimeStopDTE: 7,
    creditDeltaStop: 0,
    minIVRank: 30,
    vrpFilter: 0,
    contangoFilter: 0,
    slopeFilter: 0,
    maxIVSkew: Infinity,
    maxPerTicker: 5,
    maxPositions: 10,
    signalWeightPreset: 'ema',
    useSmvVol: false,
    dirConfTier: 'any',
    monitoringIntervalDays: 1,
  };

  // Factorial cross-product
  if (dimensions.length === 0) return [defaults];

  const combos: Record<string, number | string | boolean>[] = [{}];
  for (const dim of dimensions) {
    const newCombos: Record<string, number | string | boolean>[] = [];
    for (const combo of combos) {
      for (const val of dim.values) {
        newCombos.push({ ...combo, [dim.name]: val });
      }
    }
    combos.length = 0;
    combos.push(...newCombos);
  }

  // Fill in defaults for missing dimensions
  return combos.map(combo => ({ ...defaults, ...combo }));
}

/**
 * Convert raw params dict to a SimConfig for the option simulator.
 */
export function paramsToSimConfig(
  params: Record<string, number | string | boolean>,
  profile: DTEProfile,
): SimConfig {
  const bounds = PROFILE_BOUNDS[profile];

  return {
    mode: 'CREDIT_SPREAD',
    // LEAP defaults (unused for credit spreads)
    leapDeltaRange: [0.65, 0.80],
    leapDTERange: [180, 365],
    leapProfitTarget: 0.50,
    leapStopLoss: 0.30,
    leapTimeStopDTE: 90,
    // Credit spread params from optimization
    creditShortDelta: params.creditShortDelta as number,
    creditSpreadWidth: params.creditSpreadWidth as number,
    creditDTERange: bounds.creditDTERange,
    creditProfitTarget: params.creditProfitTarget as number,
    creditStopLossMultiple: params.creditStopLossMultiple as number,
    creditTimeStopDTE: params.creditTimeStopDTE as number,
    creditDeltaStop: (params.creditDeltaStop as number) || undefined,
    monitoringIntervalDays: params.monitoringIntervalDays as number ?? 1,
    minIVRank: params.minIVRank as number,
    fillMode: 'bidask',
    slippage: {
      enabled: true,
      fillMode: 'bidask',
      baseImpactBps: 2,
      oiHalfLife: 500,
      dteAccelDays: 7,
      dteAccelMultiplier: 3.0,
    },
    maxBidAskSpreadPct: undefined,
    minShortOI: undefined,
    maxGammaThetaRatio: undefined,
    maxIVSkew: (params.maxIVSkew as number) < 1 ? (params.maxIVSkew as number) : undefined,
    signalWeightPreset: params.signalWeightPreset as SignalPresetKey,
    // v2 extensions
    vrpFilter: (params.vrpFilter as number) || undefined,
    contangoFilter: (params.contangoFilter as number) || undefined,
    slopeFilter: (params.slopeFilter as number) || undefined,
    useSmvVol: params.useSmvVol as boolean,
    dirConfTier: (params.dirConfTier as DirConfTier) || 'any',
    useDirectLookup: true,
  };
}
