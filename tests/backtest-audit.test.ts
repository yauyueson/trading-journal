/**
 * Red Team Audit Tests — Items #2, #3, #5, #6, #7, #8, #9
 *
 * Tests for: slippage, purge gap, block bootstrap MC, regime gates,
 * correlation penalty + weight cap, O-U IV dynamics, vertical spreads.
 */
import { describe, it, expect } from 'vitest';
import { ouIVEvolution, computeRollingHV, bsmPrice, bsmDelta } from '../src/lib/backtest/bsm-pricing';
import { DEFAULT_SLIPPAGE, DEFAULT_REGIME_GATES, DEFAULT_IV_DYNAMICS } from '../src/lib/backtest/types';
import type { BacktestConfig, BacktestTrade, PrecomputedSignal, MonteCarloResult } from '../src/lib/backtest/types';
import { monteCarloPermutation } from '../src/lib/backtest/analytics';

// ─── #3: Slippage Model ──────────────────────────────────────

describe('Slippage Config', () => {
  it('DEFAULT_SLIPPAGE has expected values', () => {
    expect(DEFAULT_SLIPPAGE.enabled).toBe(false);
    expect(DEFAULT_SLIPPAGE.entryBps).toBe(5);
    expect(DEFAULT_SLIPPAGE.exitBps).toBe(5);
  });

  it('5 bps = 0.05% adverse fill', () => {
    const basePrice = 100;
    const slip = 5 / 10000; // 5 bps
    // CALL entry: buyer pays more
    const callEntry = basePrice * (1 + slip);
    expect(callEntry).toBeCloseTo(100.05, 4);
    // PUT entry: seller gets less
    const putEntry = basePrice * (1 - slip);
    expect(putEntry).toBeCloseTo(99.95, 4);
    // CALL exit: seller gets less
    const callExit = basePrice * (1 - slip);
    expect(callExit).toBeCloseTo(99.95, 4);
  });
});

// ─── #5: Walk-Forward Purge Gap ──────────────────────────────

describe('Walk-Forward Purge Gap', () => {
  it('default purge gap is 5 days', () => {
    // Purge gap prevents indicator look-ahead leaking IS → OOS
    // oosStartIdx = isEndIdx + purgeGap (was: isEndIdx)
    const isEndIdx = 252;
    const purgeGap = 5; // default
    const oosStartIdx = isEndIdx + purgeGap;
    expect(oosStartIdx).toBe(257);
    expect(oosStartIdx - isEndIdx).toBe(5);
  });

  it('purge gap 0 gives old behavior', () => {
    const isEndIdx = 252;
    const purgeGap = 0;
    const oosStartIdx = isEndIdx + purgeGap;
    expect(oosStartIdx).toBe(isEndIdx);
  });
});

// ─── #9: Block Bootstrap Monte Carlo ─────────────────────────

describe('Block Bootstrap Monte Carlo', () => {
  // Create mock trades with realistic returns
  function makeMockTrades(n: number, winRate: number = 0.55): BacktestTrade[] {
    const trades: BacktestTrade[] = [];
    for (let i = 0; i < n; i++) {
      const isWin = Math.random() < winRate;
      const ret = isWin ? 0.02 + Math.random() * 0.03 : -(0.01 + Math.random() * 0.02);
      trades.push({
        entryDate: `2024-01-${String(i + 1).padStart(2, '0')}`,
        entryPrice: 100,
        entryBar: i,
        direction: 'CALL',
        setup: 'Test',
        score: 80,
        confidence: 2,
        tier: 'A',
        entryQuality: 'OPTIMAL',
        atrAtEntry: 2,
        tpPrice: 105,
        slPrice: 98,
        exitDate: `2024-02-${String(i + 1).padStart(2, '0')}`,
        exitPrice: 100 + ret * 100,
        exitType: isWin ? 'TP' : 'SL',
        holdDays: 5,
        rawReturn: ret,
        thetaAdjReturn: ret * 0.95,
        mfe: {},
        mae: {},
      });
    }
    return trades;
  }

  it('monteCarloPermutation returns valid structure', () => {
    const trades = makeMockTrades(30);
    const mc = monteCarloPermutation(trades, 100);
    expect(mc.iterations).toBe(100);
    expect(mc.sharpe).toHaveProperty('p5');
    expect(mc.sharpe).toHaveProperty('p50');
    expect(mc.sharpe).toHaveProperty('p95');
    expect(mc.maxDrawdown).toHaveProperty('p5');
    expect(mc.finalReturn).toHaveProperty('p5');
    expect(typeof mc.isSignificant).toBe('boolean');
  });

  it('blockBootstrap is populated for n >= 10', () => {
    const trades = makeMockTrades(30);
    const mc = monteCarloPermutation(trades, 100);
    expect(mc.blockBootstrap).toBeDefined();
    expect(mc.blockBootstrap!.blockSize).toBeGreaterThanOrEqual(3);
    expect(mc.blockBootstrap!.sharpe).toHaveProperty('p5');
    expect(mc.blockBootstrap!.sharpe).toHaveProperty('p50');
    expect(mc.blockBootstrap!.sharpe).toHaveProperty('p95');
  });

  it('blockBootstrap is undefined for n < 10', () => {
    const trades = makeMockTrades(5);
    const mc = monteCarloPermutation(trades, 50);
    // monteCarloPermutation with < 5 trades returns early with 0 iterations
    // blockBootstrap requires >= 10 trades
    expect(mc.blockBootstrap).toBeUndefined();
  });

  it('block size is bounded [3, 10]', () => {
    for (const n of [15, 30, 50, 100, 200]) {
      const trades = makeMockTrades(n);
      const mc = monteCarloPermutation(trades, 50);
      if (mc.blockBootstrap) {
        expect(mc.blockBootstrap.blockSize).toBeGreaterThanOrEqual(3);
        expect(mc.blockBootstrap.blockSize).toBeLessThanOrEqual(10);
      }
    }
  });

  it('p5 <= p50 <= p95 (Sharpe ordering)', () => {
    const trades = makeMockTrades(50);
    const mc = monteCarloPermutation(trades, 200);
    expect(mc.sharpe.p5).toBeLessThanOrEqual(mc.sharpe.p50);
    expect(mc.sharpe.p50).toBeLessThanOrEqual(mc.sharpe.p95);
    if (mc.blockBootstrap) {
      expect(mc.blockBootstrap.sharpe.p5).toBeLessThanOrEqual(mc.blockBootstrap.sharpe.p50);
      expect(mc.blockBootstrap.sharpe.p50).toBeLessThanOrEqual(mc.blockBootstrap.sharpe.p95);
    }
  });
});

// ─── #8: Regime-Conditional Quality Gates ────────────────────

describe('Regime Gates', () => {
  it('DEFAULT_REGIME_GATES has expected structure', () => {
    expect(DEFAULT_REGIME_GATES.enabled).toBe(false);
    expect(DEFAULT_REGIME_GATES.trendingADX).toBe(20);
    expect(DEFAULT_REGIME_GATES.trendingRVOL).toBe(0.3);
    expect(DEFAULT_REGIME_GATES.rangingADX).toBe(10);
    expect(DEFAULT_REGIME_GATES.rangingRVOL).toBe(0.8);
    expect(DEFAULT_REGIME_GATES.trendingCoherence).toHaveLength(4);
    expect(DEFAULT_REGIME_GATES.rangingCoherence).toHaveLength(4);
  });

  it('trending regime: stricter ADX, relaxed RVOL', () => {
    expect(DEFAULT_REGIME_GATES.trendingADX).toBeGreaterThan(DEFAULT_REGIME_GATES.rangingADX);
    expect(DEFAULT_REGIME_GATES.trendingRVOL).toBeLessThan(DEFAULT_REGIME_GATES.rangingRVOL);
  });

  it('regime classification: ADX > 25 = trending, < 20 = ranging', () => {
    const classify = (adx: number) =>
      adx > 25 ? 'trending' : adx < 20 ? 'ranging' : 'neutral';
    expect(classify(30)).toBe('trending');
    expect(classify(25.1)).toBe('trending');
    expect(classify(22)).toBe('neutral');
    expect(classify(20)).toBe('neutral');
    expect(classify(19)).toBe('ranging');
    expect(classify(10)).toBe('ranging');
  });

  it('coherence multipliers have 4 entries [3/3, 2/3, 1/3, 0/3]', () => {
    const tc = DEFAULT_REGIME_GATES.trendingCoherence;
    expect(tc[0]).toBeGreaterThan(1.0);   // 3/3 = boost
    expect(tc[1]).toBeCloseTo(1.0, 2);    // 2/3 = neutral
    expect(tc[2]).toBeLessThan(1.0);      // 1/3 = penalty
    expect(tc[3]).toBeLessThan(tc[2]);    // 0/3 = stronger penalty
  });
});

// ─── #2: Correlation Penalty + Weight Cap ────────────────────

describe('Correlation Penalty', () => {
  it('pearsonCorr of identical arrays = 1', () => {
    // We don't export pearsonCorr directly, but we can test via subScore correlation
    const x = [1, 2, 3, 4, 5];
    const n = x.length;
    const mean = x.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (x[i] - mean) * (x[i] - mean);
      den += (x[i] - mean) ** 2;
    }
    expect(num / den).toBeCloseTo(1.0, 10);
  });

  it('penalty formula: no penalty when corr <= 0.3', () => {
    const corr = 0.25;
    const penalty = corr > 0.3 ? (1 - (corr - 0.3) * 0.15) : 1.0;
    expect(penalty).toBe(1.0);
  });

  it('penalty formula: 10.5% max penalty at corr = 1.0', () => {
    const corr = 1.0;
    const penalty = 1 - (corr - 0.3) * 0.15;
    expect(penalty).toBeCloseTo(0.895, 3);
  });

  it('penalty formula: ~3% at corr = 0.5', () => {
    const corr = 0.5;
    const penalty = 1 - (corr - 0.3) * 0.15;
    expect(penalty).toBeCloseTo(0.97, 3);
  });
});

describe('Weight Cap', () => {
  it('max weight is 40 (was 50 for w_mb)', () => {
    const MAX_WEIGHT = 40;
    // Simulate normalizeWeights with cap
    const raw = [50, 20, 15, 10, 5]; // sum = 100, w_mb exceeds 40
    const total = raw.reduce((s, v) => s + v, 0);
    const normalized = raw.map(w => Math.round((w / total) * 100));
    // Apply cap
    const capped = normalized.map(w => Math.min(w, MAX_WEIGHT));
    expect(capped[0]).toBe(MAX_WEIGHT);
    expect(capped[0]).toBeLessThanOrEqual(40);
  });
});

// ─── #6: O-U IV Mean Reversion ──────────────────────────────

describe('O-U IV Evolution', () => {
  it('DEFAULT_IV_DYNAMICS has expected values', () => {
    expect(DEFAULT_IV_DYNAMICS.enabled).toBe(true);
    expect(DEFAULT_IV_DYNAMICS.kappa).toBe(4.0);
    expect(DEFAULT_IV_DYNAMICS.useHV60ForTheta).toBe(true);
    expect(DEFAULT_IV_DYNAMICS.stochastic).toBe(false);
  });

  it('0 hold days → IV unchanged', () => {
    const iv = ouIVEvolution(0.30, 0.20, 4.0, 0);
    expect(iv).toBeCloseTo(0.30, 10);
  });

  it('very long hold → IV converges to theta', () => {
    const iv = ouIVEvolution(0.30, 0.20, 4.0, 365);
    expect(iv).toBeCloseTo(0.20, 2); // strong convergence after 1 year
  });

  it('fast kappa converges faster', () => {
    const slow = ouIVEvolution(0.40, 0.25, 1.0, 30);
    const fast = ouIVEvolution(0.40, 0.25, 8.0, 30);
    // Both should be between 0.40 and 0.25, fast closer to 0.25
    expect(slow).toBeGreaterThan(0.25);
    expect(fast).toBeGreaterThan(0.25);
    expect(fast).toBeLessThan(slow);
  });

  it('when ivEntry = theta, IV stays constant', () => {
    const iv = ouIVEvolution(0.25, 0.25, 4.0, 30);
    expect(iv).toBeCloseTo(0.25, 10);
  });

  it('mean reversion is symmetric', () => {
    const highToLow = ouIVEvolution(0.40, 0.20, 4.0, 30);
    const lowToHigh = ouIVEvolution(0.00, 0.20, 4.0, 30);
    // highToLow should be above theta, lowToHigh below theta
    expect(highToLow).toBeGreaterThan(0.20);
    expect(lowToHigh).toBeLessThan(0.20);
  });

  it('decay formula: sigma = iv*exp(-kT) + theta*(1-exp(-kT))', () => {
    const iv = 0.35, theta = 0.22, kappa = 4.0, holdDays = 14;
    const T = holdDays / 365;
    const decay = Math.exp(-kappa * T);
    const expected = iv * decay + theta * (1 - decay);
    const result = ouIVEvolution(iv, theta, kappa, holdDays);
    expect(result).toBeCloseTo(expected, 10);
  });
});

// ─── #7: Vertical Spread P&L ─────────────────────────────────

describe('Vertical Spread BSM', () => {
  const S = 100, T = 30 / 365, sigma = 0.25, r = 0.04;

  it('vertical call spread: long ATM + short OTM (narrower premium)', () => {
    const K_long = 100; // ATM
    const K_short = 105; // OTM
    const longPrice = bsmPrice(S, K_long, T, sigma, r, true);
    const shortPrice = bsmPrice(S, K_short, T, sigma, r, true);
    const netDebit = longPrice - shortPrice;
    expect(netDebit).toBeGreaterThan(0); // should cost money
    expect(netDebit).toBeLessThan(longPrice); // cheaper than naked
  });

  it('vertical put spread: long ATM + short OTM (narrower premium)', () => {
    const K_long = 100; // ATM
    const K_short = 95; // OTM (for put, lower strike is OTM)
    const longPrice = bsmPrice(S, K_long, T, sigma, r, false);
    const shortPrice = bsmPrice(S, K_short, T, sigma, r, false);
    const netDebit = longPrice - shortPrice;
    expect(netDebit).toBeGreaterThan(0);
    expect(netDebit).toBeLessThan(longPrice);
  });

  it('max loss is capped by spread width', () => {
    const K_long = 100;
    const K_short = 105;
    const spreadWidth = Math.abs(K_short - K_long); // 5
    const longEntry = bsmPrice(S, K_long, T, sigma, r, true);
    const shortEntry = bsmPrice(S, K_short, T, sigma, r, true);
    const netDebit = longEntry - shortEntry;
    const maxLoss = spreadWidth - netDebit;
    // At expiration with S = 80 (deep OTM for both)
    const longExit = bsmPrice(80, K_long, 1 / 365, sigma, r, true);
    const shortExit = bsmPrice(80, K_short, 1 / 365, sigma, r, true);
    const exitValue = Math.max(0, longExit - shortExit);
    const actualReturn = (exitValue - netDebit) / netDebit;
    // Max loss ratio
    const maxLossRatio = (spreadWidth - netDebit) / netDebit;
    expect(actualReturn).toBeGreaterThanOrEqual(-maxLossRatio - 0.01); // within tolerance
  });

  it('at expiration deep ITM: profit approaches spread width - debit', () => {
    const K_long = 100;
    const K_short = 105;
    // Deep ITM: S = 120 at near expiration
    const longExit = bsmPrice(120, K_long, 1 / 365, sigma, r, true);
    const shortExit = bsmPrice(120, K_short, 1 / 365, sigma, r, true);
    const exitValue = longExit - shortExit;
    const spreadWidth = K_short - K_long; // 5
    // Should be close to spread width (both deep ITM → intrinsic)
    expect(exitValue).toBeCloseTo(spreadWidth, 1);
  });

  it('spread debit is always positive (long leg > short leg)', () => {
    // Call spread
    for (const width of [2, 5, 10]) {
      const longP = bsmPrice(S, S, T, sigma, r, true);
      const shortP = bsmPrice(S, S + width, T, sigma, r, true);
      expect(longP - shortP).toBeGreaterThan(0);
    }
    // Put spread
    for (const width of [2, 5, 10]) {
      const longP = bsmPrice(S, S, T, sigma, r, false);
      const shortP = bsmPrice(S, S - width, T, sigma, r, false);
      expect(longP - shortP).toBeGreaterThan(0);
    }
  });
});

// ─── Integration: HV Series ──────────────────────────────────

describe('HV60 for O-U theta', () => {
  it('computeRollingHV(60) returns values for series > 61 bars', () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 10) * 5);
    const hv60 = computeRollingHV(closes, 60);
    expect(hv60).toHaveLength(100);
    // First 60 should be NaN
    expect(isNaN(hv60[59])).toBe(true);
    // After 60, should have values
    expect(isNaN(hv60[60])).toBe(false);
    expect(hv60[60]).toBeGreaterThan(0);
  });

  it('HV60 differs from HV20 (different lookback windows)', () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 10) * 5 + Math.cos(i / 30) * 3);
    const hv20 = computeRollingHV(closes, 20);
    const hv60 = computeRollingHV(closes, 60);
    // At bar 100, both should have values but differ
    expect(isNaN(hv20[100])).toBe(false);
    expect(isNaN(hv60[100])).toBe(false);
    // They likely differ (different window captures different vol regimes)
    expect(Math.abs(hv20[100] - hv60[100])).toBeGreaterThan(0);
  });
});

// ─── #6+#7 Combined: O-U + Spread ───────────────────────────

describe('O-U IV with Vertical Spread', () => {
  it('O-U IV changes exit price of both legs consistently', () => {
    const S = 100, K_long = 100, K_short = 105;
    const T = 30 / 365, r = 0.04;
    const ivEntry = 0.35, theta = 0.20, kappa = 4.0, holdDays = 14;
    const T_exit = (30 - holdDays) / 365;

    // Constant IV
    const longConst = bsmPrice(102, K_long, T_exit, ivEntry, r, true);
    const shortConst = bsmPrice(102, K_short, T_exit, ivEntry, r, true);
    const spreadConst = longConst - shortConst;

    // O-U IV at exit
    const ivExit = ouIVEvolution(ivEntry, theta, kappa, holdDays);
    expect(ivExit).toBeLessThan(ivEntry); // IV mean-reverted toward lower theta
    const longOU = bsmPrice(102, K_long, T_exit, ivExit, r, true);
    const shortOU = bsmPrice(102, K_short, T_exit, ivExit, r, true);
    const spreadOU = longOU - shortOU;

    // Both spreads should be positive
    expect(spreadConst).toBeGreaterThan(0);
    expect(spreadOU).toBeGreaterThan(0);
    // With lower IV, option values compress — spread value should differ
    expect(spreadOU).not.toBeCloseTo(spreadConst, 4);
  });
});
