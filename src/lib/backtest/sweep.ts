/**
 * Signal Quality Backtester — Parameter Sweep
 *
 * Generates a Cartesian product of parameter combos and runs each through
 * the backtest engine. Signals are pre-computed once and shared across all runs.
 */

import type {
  BacktestCandle,
  BacktestConfig,
  BacktestResult,
  SweepConfig,
  SweepResult,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { precomputeSignals, runBacktestFromSignals } from './engine';

// ── Grid Generator ──────────────────────────────────────

export function generateConfigs(sweep: SweepConfig): BacktestConfig[] {
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
                tpAtr,
                slAtr,
                minScore,
                minConfidence,
                allowedSetups: setups,
                thetaDecayRate: decay,
              });
            }
          }
        }
      }
    }
  }
  return configs;
}

// ── Sweep Runner ────────────────────────────────────────

export function runSweep(
  candles: BacktestCandle[],
  sweepConfig: SweepConfig,
  onProgress?: (completed: number, total: number) => void
): SweepResult {
  const t0 = performance.now();

  // Pre-compute signals ONCE (expensive)
  const signals = precomputeSignals(candles);

  // Generate all configs
  const configs = generateConfigs(sweepConfig);
  const total = configs.length;

  // Run each (cheap — just TP/SL loop)
  const results: BacktestResult[] = [];
  for (let i = 0; i < configs.length; i++) {
    results.push(runBacktestFromSignals(signals, candles, configs[i]));
    if (onProgress) onProgress(i + 1, total);
  }

  // Filter out results with too few trades for meaningful stats
  const meaningful = results.filter(r => r.analytics.totalTrades >= 5);

  // Rank by metrics
  const rankedBySharpe = [...meaningful].sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
  const rankedByWinRate = [...meaningful].sort((a, b) => b.analytics.winRateTheta - a.analytics.winRateTheta);
  const rankedByProfitFactor = [...meaningful].sort((a, b) => b.analytics.profitFactor - a.analytics.profitFactor);

  // Best overall: weighted composite score
  const bestOverall = pickBest(meaningful);

  return {
    results,
    rankedBySharpe,
    rankedByWinRate,
    rankedByProfitFactor,
    bestOverall,
    totalCombos: total,
    elapsedMs: performance.now() - t0,
  };
}

// ── Best Pick (weighted composite) ──────────────────────

function pickBest(results: BacktestResult[]): BacktestResult | null {
  if (results.length === 0) return null;

  // Normalize each metric to 0-1 range, then weight
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
      0.25 * (m.pf / Math.min(maxPF, 10)) + // Cap PF normalization
      0.15 * (1 - m.dd / maxDD);             // Lower DD is better

    if (score > bestScore) {
      bestScore = score;
      best = m.result;
    }
  }

  return best;
}

// ── Default Sweep Ranges ────────────────────────────────

export const DEFAULT_SWEEP: Omit<SweepConfig, 'ticker' | 'startDate' | 'endDate'> = {
  tpAtrRange: [1.5, 2.0, 2.5, 3.0],
  slAtrRange: [1.0, 1.5, 2.0],
  minScoreRange: [65, 70, 75, 80],
  minConfidenceRange: [1, 2],
  setupGroups: [['All']],
  thetaDecayRange: [0.03],
};
