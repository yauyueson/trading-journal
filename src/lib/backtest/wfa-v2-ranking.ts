/**
 * WFA v2 Multi-Objective Ranking
 *
 * Composite score: weighted combination of Sharpe, MaxDD, WFE, Stability, DSR.
 * Pareto frontier identification for visualization.
 */

import type {
  CompositeWeights, RankedConfig,
} from './wfa-v2-types';
import { DEFAULT_COMPOSITE_WEIGHTS } from './wfa-v2-types';

// ── Evaluation Result (input to ranking) ────────────────

export interface EvalResult {
  configId: string;
  params: Record<string, number | string | boolean>;
  sharpe: number;
  maxDD: number;       // percentage (e.g. 4.5 = 4.5%)
  wfe: number;         // WF efficiency: OOS Sharpe / Avg IS Sharpe
  stability: number;   // 1 - avg CV of params across windows (higher = more stable)
  dsr: number;         // DSR value (0-1)
  winRate: number;
  totalPnl: number;
  tradeCount: number;
}

// ── Min-Max Normalization ───────────────────────────────

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return values.map(() => 0.5);
  return values.map(v => (v - min) / range);
}

// ── Composite Score ─────────────────────────────────────

/**
 * Compute composite ranking across all evaluation results.
 *
 * Score = w1 × norm(Sharpe) + w2 × norm(-MaxDD) + w3 × norm(WFE)
 *       + w4 × norm(Stability) + w5 × norm(DSR)
 */
export function computeCompositeRanking(
  results: EvalResult[],
  weights: CompositeWeights = DEFAULT_COMPOSITE_WEIGHTS,
): RankedConfig[] {
  if (results.length === 0) return [];

  // Extract raw values
  const sharpes = results.map(r => r.sharpe);
  const negDDs = results.map(r => -r.maxDD);  // negate: lower DD is better
  const wfes = results.map(r => r.wfe);
  const stabilities = results.map(r => r.stability);
  const dsrs = results.map(r => r.dsr);

  // Normalize to [0,1]
  const nSharpe = normalize(sharpes);
  const nDD = normalize(negDDs);
  const nWFE = normalize(wfes);
  const nStab = normalize(stabilities);
  const nDSR = normalize(dsrs);

  // Compute composite scores
  const scored: RankedConfig[] = results.map((r, i) => ({
    configId: r.configId,
    params: r.params,
    compositeScore:
      weights.sharpe * nSharpe[i] +
      weights.maxDD * nDD[i] +
      weights.wfe * nWFE[i] +
      weights.stability * nStab[i] +
      weights.dsr * nDSR[i],
    sharpe: r.sharpe,
    maxDD: r.maxDD,
    wfe: r.wfe,
    stability: r.stability,
    dsr: r.dsr,
    winRate: r.winRate,
    totalPnl: r.totalPnl,
    tradeCount: r.tradeCount,
    isParetoOptimal: false, // set below
  }));

  // Sort by composite score descending
  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  // Identify Pareto frontier across (Sharpe, -MaxDD, WFE)
  const paretoSet = identifyParetoFrontier(scored);
  for (const idx of paretoSet) {
    scored[idx].isParetoOptimal = true;
  }

  return scored;
}

// ── Pareto Frontier ─────────────────────────────────────

/**
 * Identify non-dominated configs across multiple objectives.
 * A config is Pareto-optimal if no other config is better on ALL objectives.
 */
function identifyParetoFrontier(configs: RankedConfig[]): Set<number> {
  const paretoSet = new Set<number>();

  for (let i = 0; i < configs.length; i++) {
    let isDominated = false;

    for (let j = 0; j < configs.length; j++) {
      if (i === j) continue;

      // Config j dominates config i if:
      // j is >= on all objectives AND strictly > on at least one
      const jBetterSharpe = configs[j].sharpe >= configs[i].sharpe;
      const jBetterDD = configs[j].maxDD <= configs[i].maxDD;
      const jBetterWFE = configs[j].wfe >= configs[i].wfe;

      const jStrictlyBetter =
        configs[j].sharpe > configs[i].sharpe ||
        configs[j].maxDD < configs[i].maxDD ||
        configs[j].wfe > configs[i].wfe;

      if (jBetterSharpe && jBetterDD && jBetterWFE && jStrictlyBetter) {
        isDominated = true;
        break;
      }
    }

    if (!isDominated) {
      paretoSet.add(i);
    }
  }

  return paretoSet;
}
