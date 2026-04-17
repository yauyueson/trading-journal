/**
 * WFA v2 Statistical Validation
 *
 * - Deflated Sharpe Ratio (DSR) — Bailey & López de Prado 2014
 * - Probability of Backtest Overfitting (PBO) via CSCV
 * - Block Bootstrap confidence intervals
 * - Trade-order permutation test
 * - Benjamini-Hochberg multiple testing correction
 * - Parameter stability analysis
 */

import type {
  DSRResult, PBOResult, BootstrapResult, BootstrapCI,
  PermutationTestResult, BHCorrectedResult, ParameterStability,
  OptionTrade, WFAv2Window,
} from './wfa-v2-types';

// ── Normal Distribution Helpers ─────────────────────────

/** Standard normal CDF (Abramowitz & Stegun approximation) */
function normCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1.0 + sign * y);
}

/** Inverse normal CDF (rational approximation, Beasley-Springer-Moro) */
function normInvCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // Rational approx for central region
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02,
    -2.759285104469687e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02,
    -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01,
    -2.400758277161838e+00, -2.549732539343734e+00,
    4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01,
    2.445134137142996e+00, 3.754408661907416e+00,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

// ── Seeded PRNG (xoshiro128**) ──────────────────────────

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

// ── Return Statistics ───────────────────────────────────

function computeReturnStats(returns: number[]): { mean: number; std: number; skew: number; kurt: number } {
  const n = returns.length;
  if (n < 3) return { mean: 0, std: 0, skew: 0, kurt: 3 };

  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const diffs = returns.map(r => r - mean);
  const m2 = diffs.reduce((s, d) => s + d * d, 0) / n;
  const std = Math.sqrt(m2);

  if (std === 0) return { mean, std: 0, skew: 0, kurt: 3 };

  const m3 = diffs.reduce((s, d) => s + d * d * d, 0) / n;
  const m4 = diffs.reduce((s, d) => s + d * d * d * d, 0) / n;
  const skew = m3 / (std * std * std);
  const kurt = m4 / (std * std * std * std);

  return { mean, std, skew, kurt };
}

function computeSharpe(returns: number[], tradesPerYear: number): number {
  const { mean, std } = computeReturnStats(returns);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(tradesPerYear);
}

function computeMaxDD(trades: OptionTrade[], startingCapital: number): number {
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  let equity = startingCapital;
  let peak = equity;
  let maxDD = 0;
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
  }
  return maxDD;
}

// ── 1. Deflated Sharpe Ratio ────────────────────────────

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado 2014)
 *
 * Tests whether observed SR exceeds the expected maximum SR from N
 * independent trials of random strategies.
 *
 * DSR = P(SR > 0) adjusted for multiple testing, skewness, kurtosis.
 */
export function computeDSR(
  observedSR: number,
  nTrials: number,
  returns: number[],
): DSRResult {
  const { skew, kurt } = computeReturnStats(returns);
  const n = returns.length;

  if (n < 5 || nTrials < 2) {
    return { observedSR, expectedMaxSR: 0, dsr: 0.5, nTrials, skewness: skew, kurtosis: kurt };
  }

  // Expected maximum SR from N i.i.d. trials (Bailey & López de Prado 2014)
  // E[max(Z_1,...,Z_N)] ≈ (1-γ)Φ^{-1}(1-1/N) + γΦ^{-1}(1-1/(Ne))
  // where γ = Euler-Mascheroni constant
  const eulerGamma = 0.5772156649;
  const expectedMaxSR = (1 - eulerGamma) * normInvCDF(1 - 1 / nTrials) +
    eulerGamma * normInvCDF(1 - 1 / (nTrials * Math.E));

  // Variance of SR estimator (Lo 2002, with skew/kurt correction)
  const varSR = (1 - skew * observedSR + ((kurt - 1) / 4) * observedSR * observedSR) / (n - 1);

  // Test statistic: is observed SR significantly above expected max?
  const testStat = (observedSR - expectedMaxSR) / Math.sqrt(Math.max(varSR, 1e-10));
  const dsr = normCDF(testStat);

  return {
    observedSR,
    expectedMaxSR,
    dsr,
    nTrials,
    skewness: skew,
    kurtosis: kurt,
  };
}

// ── 2. PBO via CSCV ────────────────────────────────────

/**
 * Probability of Backtest Overfitting via Combinatorial Symmetric Cross-Validation
 *
 * Splits trade returns into S blocks, tests all C(S, S/2) combinations.
 * For each split: optimize on half A, check if IS-best underperforms
 * OOS median on half B.
 */
export function computePBO(
  tradeReturns: number[][],  // [window][trade_returns] — per-window returns
  nBlocks: number = 16,
  maxCombinations: number = 5000,
  seed: number = 42,
  avgHoldDays: number = 13,  // average trade hold days for annualization
): PBOResult {
  const tradesPerYear = 252 / Math.max(1, avgHoldDays);
  // Flatten all returns into one sequence, then split into nBlocks
  const allReturns = tradeReturns.flat();
  const n = allReturns.length;

  if (n < nBlocks * 2) {
    return { pbo: 0.5, logitPBO: 0, rankCorrelation: 0, nCombinations: 0 };
  }

  const blockSize = Math.floor(n / nBlocks);
  const blocks: number[][] = [];
  for (let i = 0; i < nBlocks; i++) {
    blocks.push(allReturns.slice(i * blockSize, (i + 1) * blockSize));
  }

  const halfSize = Math.floor(nBlocks / 2);
  const rng = createRng(seed);

  // Generate random combinations (or all if small enough)
  const totalCombinations = binomial(nBlocks, halfSize);
  const useSample = totalCombinations > maxCombinations;
  const combinations: number[][] = useSample
    ? sampleCombinations(nBlocks, halfSize, maxCombinations, rng)
    : allCombinations(nBlocks, halfSize);

  let overfitCount = 0;
  let rankSumIS = 0;
  let rankSumOOS = 0;
  let nCombs = 0;

  for (const combo of combinations) {
    const complementSet = new Set(Array.from({ length: nBlocks }, (_, i) => i));
    for (const idx of combo) complementSet.delete(idx);
    const complement = [...complementSet];

    // Half A (IS): returns from combo blocks
    const isReturns = combo.flatMap(i => blocks[i]);
    // Half B (OOS): returns from complement blocks
    const oosReturns = complement.flatMap(i => blocks[i]);

    const isSharpe = computeSharpe(isReturns, tradesPerYear);
    const oosSharpe = computeSharpe(oosReturns, tradesPerYear);

    // Check if IS-optimal underperforms OOS median (simplified: OOS Sharpe < 0)
    if (isSharpe > 0 && oosSharpe < 0) {
      overfitCount++;
    }

    rankSumIS += isSharpe;
    rankSumOOS += oosSharpe;
    nCombs++;
  }

  const pbo = nCombs > 0 ? overfitCount / nCombs : 0.5;
  const logitPBO = pbo > 0 && pbo < 1 ? Math.log(pbo / (1 - pbo)) : 0;

  // Rank correlation (simplified: correlation of IS vs OOS Sharpe across combos)
  const rankCorrelation = nCombs > 0 && rankSumIS !== 0
    ? rankSumOOS / Math.abs(rankSumIS) : 0;

  return {
    pbo,
    logitPBO,
    rankCorrelation: Math.max(-1, Math.min(1, rankCorrelation)),
    nCombinations: nCombs,
  };
}

function binomial(n: number, k: number): number {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = result * (n - i) / (i + 1);
  }
  return Math.round(result);
}

function allCombinations(n: number, k: number): number[][] {
  const result: number[][] = [];
  const combo: number[] = [];

  function recurse(start: number): void {
    if (combo.length === k) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i < n; i++) {
      combo.push(i);
      recurse(i + 1);
      combo.pop();
    }
  }
  recurse(0);
  return result;
}

function sampleCombinations(n: number, k: number, count: number, rng: () => number): number[][] {
  const seen = new Set<string>();
  const result: number[][] = [];

  while (result.length < count) {
    const combo: number[] = [];
    const pool = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < k; i++) {
      const idx = Math.floor(rng() * pool.length);
      combo.push(pool[idx]);
      pool.splice(idx, 1);
    }
    combo.sort((a, b) => a - b);
    const key = combo.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(combo);
    }
  }
  return result;
}

// ── 3. Block Bootstrap ──────────────────────────────────

export interface BlockBootstrapOpts {
  /**
   * Daily portfolio returns. When provided, the Sharpe CI is computed by
   * block-bootstrapping THESE values — which is the statistically correct
   * thing to do, because real autocorrelation lives in daily returns, not
   * in trade-level pnlPct sorted by exit date.
   *
   * Without this, Sharpe CI falls back to trade-level resampling, which
   * understates uncertainty (autocorrelation between consecutive trades is
   * not preserved correctly when blocks are exit-sorted). The other CIs
   * (maxDD, totalReturn, winRate) are correctly computed at trade level
   * regardless.
   *
   * See Codex finding T3-2 in .prompts/codex-trust-followups.md.
   */
  dailyReturns?: number[];
}

/**
 * Block bootstrap CI on Sharpe of a daily-return series. Preserves temporal
 * autocorrelation by resampling contiguous blocks (block size ~ sqrt(n) by
 * default). This is the statistically correct way to bootstrap Sharpe.
 */
export function blockBootstrapSharpeCI(
  dailyReturns: number[],
  nResamples: number = 10_000,
  blockSize?: number,
  seed: number = 42,
): BootstrapCI {
  const n = dailyReturns.length;
  const block = Math.max(2, blockSize ?? Math.round(Math.sqrt(Math.max(1, n))));

  if (n < block * 2) {
    const sharpe = annualizedSharpeFromDailyReturns(dailyReturns);
    return { ci5: sharpe, ci50: sharpe, ci95: sharpe };
  }

  const rng = createRng(seed);
  const nBlocks = Math.ceil(n / block);
  const sharpes: number[] = [];

  for (let r = 0; r < nResamples; r++) {
    const resampled: number[] = [];
    for (let b = 0; b < nBlocks; b++) {
      const startIdx = Math.floor(rng() * (n - block + 1));
      for (let j = 0; j < block && startIdx + j < n; j++) {
        resampled.push(dailyReturns[startIdx + j]);
      }
    }
    sharpes.push(annualizedSharpeFromDailyReturns(resampled));
  }

  return percentiles(sharpes);
}

function annualizedSharpeFromDailyReturns(returns: number[]): number {
  if (returns.length < 2) return 0;
  const avg = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(1, returns.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 1e-12 ? (avg / sd) * Math.sqrt(252) : 0;
}

/**
 * Block bootstrap with resampling for confidence intervals.
 * Preserves temporal autocorrelation within blocks (when `opts.dailyReturns`
 * is supplied — see `BlockBootstrapOpts.dailyReturns`).
 */
export function blockBootstrap(
  trades: OptionTrade[],
  nResamples: number = 10_000,
  blockSize: number = 5,
  startingCapital: number = 100_000,
  seed: number = 42,
  opts: BlockBootstrapOpts = {},
): BootstrapResult {
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  const n = sorted.length;

  if (n < blockSize * 2) {
    const analytics = quickAnalytics(sorted, startingCapital);
    const sharpeCI = opts.dailyReturns && opts.dailyReturns.length >= 4
      ? blockBootstrapSharpeCI(opts.dailyReturns, nResamples, undefined, seed)
      : { ci5: analytics.sharpe, ci50: analytics.sharpe, ci95: analytics.sharpe };
    return {
      sharpe: sharpeCI,
      maxDD: { ci5: analytics.maxDD, ci50: analytics.maxDD, ci95: analytics.maxDD },
      totalReturn: { ci5: analytics.totalReturn, ci50: analytics.totalReturn, ci95: analytics.totalReturn },
      winRate: { ci5: analytics.winRate, ci50: analytics.winRate, ci95: analytics.winRate },
      nResamples: opts.dailyReturns ? nResamples : 0,
      blockSize,
    };
  }

  const rng = createRng(seed);
  const nBlocks = Math.ceil(n / blockSize);

  const sharpes: number[] = [];
  const maxDDs: number[] = [];
  const totalReturns: number[] = [];
  const winRates: number[] = [];

  for (let r = 0; r < nResamples; r++) {
    // Resample blocks with replacement
    const resampledTrades: OptionTrade[] = [];
    for (let b = 0; b < nBlocks; b++) {
      const startIdx = Math.floor(rng() * (n - blockSize + 1));
      for (let j = 0; j < blockSize && startIdx + j < n; j++) {
        resampledTrades.push(sorted[startIdx + j]);
      }
    }

    const analytics = quickAnalytics(resampledTrades, startingCapital);
    sharpes.push(analytics.sharpe);
    maxDDs.push(analytics.maxDD);
    totalReturns.push(analytics.totalReturn);
    winRates.push(analytics.winRate);
  }

  // Sharpe CI: prefer daily-return block bootstrap when available (autocorrelation
  // in trade-level Sharpe is not preserved correctly by exit-sorted resampling).
  const sharpeCI = opts.dailyReturns && opts.dailyReturns.length >= blockSize * 2
    ? blockBootstrapSharpeCI(opts.dailyReturns, nResamples, undefined, seed)
    : percentiles(sharpes);

  return {
    sharpe: sharpeCI,
    maxDD: percentiles(maxDDs),
    totalReturn: percentiles(totalReturns),
    winRate: percentiles(winRates),
    nResamples,
    blockSize,
  };
}

function quickAnalytics(trades: OptionTrade[], startingCapital: number): {
  sharpe: number; maxDD: number; totalReturn: number; winRate: number;
} {
  if (trades.length === 0) return { sharpe: 0, maxDD: 0, totalReturn: 0, winRate: 0 };

  const returns = trades.map(t => t.pnlPct);
  const avgHoldDays = trades.reduce((s, t) => s + t.holdDays, 0) / trades.length;
  const tradesPerYear = 252 / Math.max(1, avgHoldDays);
  const sharpe = computeSharpe(returns, tradesPerYear);
  const maxDD = computeMaxDD(trades, startingCapital) * 100;
  const totalReturn = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = trades.filter(t => t.pnl > 0).length / trades.length * 100;

  return { sharpe, maxDD, totalReturn, winRate };
}

function percentiles(values: number[]): BootstrapCI {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    ci5: sorted[Math.floor(n * 0.05)] ?? 0,
    ci50: sorted[Math.floor(n * 0.50)] ?? 0,
    ci95: sorted[Math.floor(n * 0.95)] ?? 0,
  };
}

// ── 4. Permutation Test ─────────────────────────────────

/**
 * Sharpe-based permutation test.
 *
 * Tests whether trade *timing* matters by shuffling P&L values across
 * the observed entry dates.  Each permutation keeps the same set of
 * entry dates and the same set of P&L values but randomly reassigns
 * which P&L lands on which date.  A portfolio equity curve is built
 * from the shuffled (date, pnl) pairs and Sharpe is computed.
 *
 * p-value = fraction of shuffled Sharpes >= observed Sharpe.
 * Low p-value means the strategy's timing adds real alpha.
 *
 * The old DD-based test is preserved as `permutationTestLegacy`.
 */
export function permutationTest(
  trades: OptionTrade[],
  nPermutations: number = 5_000,
  startingCapital: number = 100_000,
  seed: number = 42,
): PermutationTestResult {
  if (trades.length < 5) {
    return { observedValue: 0, pValue: 1, nullMean: 0, nullStd: 0 };
  }

  // Compute observed Sharpe from daily P&L attribution
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  const observedSharpe = computeDailySharpe(sorted, startingCapital);

  const rng = createRng(seed);
  const pnls = sorted.map(t => t.pnl);
  const shuffledSharpes: number[] = [];

  for (let i = 0; i < nPermutations; i++) {
    // Fisher-Yates shuffle of P&L values (dates stay fixed)
    const shuffledPnl = [...pnls];
    for (let j = shuffledPnl.length - 1; j > 0; j--) {
      const k = Math.floor(rng() * (j + 1));
      [shuffledPnl[j], shuffledPnl[k]] = [shuffledPnl[k], shuffledPnl[j]];
    }

    // Build pseudo-trades with shuffled P&L but original exit dates
    const pseudoTrades = sorted.map((t, idx) => ({
      ...t,
      pnl: shuffledPnl[idx],
    }));

    shuffledSharpes.push(computeDailySharpe(pseudoTrades, startingCapital));
  }

  // p-value: fraction of shuffled Sharpes >= observed
  const betterCount = shuffledSharpes.filter(s => s >= observedSharpe).length;
  const pValue = (betterCount + 1) / (nPermutations + 1); // +1 for continuity correction

  const nullMean = shuffledSharpes.reduce((s, v) => s + v, 0) / shuffledSharpes.length;
  const nullStd = Math.sqrt(
    shuffledSharpes.reduce((s, v) => s + (v - nullMean) ** 2, 0) / shuffledSharpes.length
  );

  return {
    observedValue: observedSharpe,
    pValue,
    nullMean,
    nullStd,
  };
}

/** Daily Sharpe from trade-level exit P&L (no dailyMtM needed). */
function computeDailySharpe(sortedTrades: OptionTrade[], startingCapital: number): number {
  // Bucket P&L by exit date → daily returns
  const dailyPnl = new Map<string, number>();
  for (const t of sortedTrades) {
    dailyPnl.set(t.exitDate, (dailyPnl.get(t.exitDate) ?? 0) + t.pnl);
  }

  const dates = [...dailyPnl.keys()].sort();
  if (dates.length < 2) return 0;

  let equity = startingCapital;
  const returns: number[] = [];
  for (const date of dates) {
    const pnl = dailyPnl.get(date) ?? 0;
    if (equity > 0) returns.push(pnl / equity);
    equity += pnl;
  }

  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
  );
  return std > 0 ? (mean / std) * Math.sqrt(252) : 0;
}

/**
 * Legacy trade-order permutation test (DD-based).
 * @deprecated Use permutationTest() which tests Sharpe significance.
 */
export function permutationTestLegacy(
  trades: OptionTrade[],
  nPermutations: number = 10_000,
  startingCapital: number = 100_000,
  seed: number = 42,
): PermutationTestResult {
  const observedDD = computeMaxDD(trades, startingCapital);
  const rng = createRng(seed);
  const shuffledDDs: number[] = [];

  for (let i = 0; i < nPermutations; i++) {
    const shuffled = [...trades];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(rng() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    shuffledDDs.push(computeMaxDD(shuffled, startingCapital));
  }

  const worseCount = shuffledDDs.filter(dd => dd >= observedDD).length;
  const pValue = worseCount / nPermutations;
  const nullMean = shuffledDDs.reduce((s, d) => s + d, 0) / shuffledDDs.length;
  const nullStd = Math.sqrt(
    shuffledDDs.reduce((s, d) => s + (d - nullMean) ** 2, 0) / shuffledDDs.length
  );

  return { observedValue: observedDD, pValue, nullMean, nullStd };
}

// ── 5. Benjamini-Hochberg Correction ────────────────────

/**
 * Benjamini-Hochberg procedure for controlling False Discovery Rate.
 */
export function benjaminiHochberg(
  pValues: { configId: string; pValue: number }[],
  fdr: number = 0.05,
): BHCorrectedResult[] {
  const n = pValues.length;
  if (n === 0) return [];

  // Sort by p-value ascending
  const sorted = [...pValues].sort((a, b) => a.pValue - b.pValue);

  // BH adjustment
  const results: BHCorrectedResult[] = sorted.map((item, i) => {
    const rank = i + 1;
    const adjusted = Math.min(item.pValue * n / rank, 1);
    return {
      configId: item.configId,
      rawPValue: item.pValue,
      adjustedPValue: adjusted,
      significant: false, // set below
    };
  });

  // Enforce monotonicity (adjusted p-values must be non-decreasing from bottom)
  for (let i = results.length - 2; i >= 0; i--) {
    results[i].adjustedPValue = Math.min(results[i].adjustedPValue, results[i + 1].adjustedPValue);
  }

  // Mark significant
  for (const r of results) {
    r.significant = r.adjustedPValue <= fdr;
  }

  return results;
}

// ── 6. Parameter Stability ──────────────────────────────

/**
 * Analyze stability of best config parameters across WFA windows.
 */
export function computeParameterStability(
  windows: WFAv2Window[],
  paramNames: string[],
): ParameterStability[] {
  return paramNames.map(name => {
    const values = windows.map(w => {
      const config = w.bestConfig as any;
      return typeof config[name] === 'number' ? config[name] : NaN;
    }).filter(v => !isNaN(v));

    if (values.length < 2) {
      return { paramName: name, values, mean: values[0] ?? 0, stdDev: 0, cv: 0, isStable: true };
    }

    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const stdDev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
    const cv = mean !== 0 ? stdDev / Math.abs(mean) : 0;

    return {
      paramName: name,
      values,
      mean,
      stdDev,
      cv,
      isStable: cv < 0.30,
    };
  });
}
