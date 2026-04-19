/**
 * Phase 0.c.10 — zero-EV stress test.
 *
 * Generate zero-drift GBM paths, run random option trades, and assert the
 * aggregate P&L is statistically indistinguishable from zero. Any
 * systematic bias reveals a bug in BSM pricing or settlement. Tests are
 * seeded and fully deterministic.
 *
 * Complementary to tests/bsm-quantlib-parity.test.ts: the parity test
 * anchors our math to a reference; this test asserts the math is actually
 * ARBITRAGE-FREE in the zero-drift regime (the risk-neutral world BSM
 * claims to price in, when r=0).
 *
 * Assertion form: |observed mean| < 3 × stderr — a 3-sigma band that
 * accepts sampling noise but rejects genuine drift.
 */
import { describe, expect, it } from 'vitest';
import { generateGBMPath, makeRng, type GBMPath } from './helpers/gbm';
import {
  simulateSingleOptionTrade,
  mean,
  stderrOfMean,
  type Direction,
} from './helpers/synthetic-option';
import { bsmPrice } from '../src/lib/backtest/bsm-pricing';

/** Produce N IID trades. Each trade gets its own seeded GBM path so
 *  trades are strictly independent — the required assumption for stderr
 *  to accurately describe the sampling distribution of the mean.
 *
 *  Throws if any trade is invalid (null): the statistical power of the
 *  test depends on the claimed iid N, and silent sample-loss would
 *  defeat that. Codex round-1 F2 (2026-04-19). */
function runManyTrades(opts: {
  nTrades: number;
  sigma: number;
  seedBase: number;
  dteDays: number;
  strikeMoneyness: number;
  isCall: boolean;
  direction: Direction;
  r?: number;
}): number[] {
  const pnls: number[] = [];
  // Each path only needs dteDays+1 steps: entry at idx 0, exit at idx dteDays.
  const pathDays = opts.dteDays + 1;
  for (let i = 0; i < opts.nTrades; i++) {
    const path = generateGBMPath({
      days: pathDays,
      sigma: opts.sigma,
      seed: opts.seedBase + i * 1_000_003, // large coprime step; avoids correlated RNG states
    });
    const t = simulateSingleOptionTrade({
      path,
      entryDayIdx: 0,
      dteDays: opts.dteDays,
      strikeMoneyness: opts.strikeMoneyness,
      isCall: opts.isCall,
      direction: opts.direction,
      sigma: opts.sigma,
      r: opts.r,
    });
    if (!t) {
      throw new Error(
        `runManyTrades: trade ${i} returned null. Silent sample-loss is not allowed in a statistical test; ` +
        `fix the generator or path sizing.`,
      );
    }
    pnls.push(t.pnl);
  }
  if (pnls.length !== opts.nTrades) {
    throw new Error(`runManyTrades: produced ${pnls.length} trades, expected ${opts.nTrades} (nominal).`);
  }
  return pnls;
}

/**
 * Generic zero-EV checker.
 *
 * Enforces BOTH a statistical band (3·stderr) AND an absolute per-contract
 * cap (default $0.05/share = $5/contract). The statistical band alone is
 * too loose for high-vol scenarios where stderr is large; a $5/contract
 * drift is material even if it falls inside 3σ on a 20k-trade sample.
 * Codex Phase 0.c.10 round-1 F1 (2026-04-19).
 */
function expectZeroEV(
  pnls: number[], label: string,
  opts: { statMultiplier?: number; absMaxPerShare?: number; minTrades?: number } = {},
) {
  const statMult = opts.statMultiplier ?? 3;
  // $0.10/share = $10 per 100-share contract. Above this is a
  // "business-meaningful" systematic bias that indicates a real math
  // asymmetry rather than sampling noise, regardless of stderr.
  const absMax = opts.absMaxPerShare ?? 0.10;
  const minTrades = opts.minTrades ?? 10_000;
  expect(pnls.length, `${label}: at least ${minTrades} trades`).toBeGreaterThanOrEqual(minTrades);
  const m = mean(pnls);
  const se = stderrOfMean(pnls);
  const statBand = statMult * se;
  if (Math.abs(m) > statBand) {
    throw new Error(
      `${label}: mean P&L = ${m.toFixed(5)} exceeds statistical band ±${statBand.toFixed(5)} ` +
      `(${statMult}σ of stderr ${se.toFixed(5)}, N=${pnls.length}).`,
    );
  }
  if (Math.abs(m) > absMax) {
    throw new Error(
      `${label}: mean P&L = ${m.toFixed(5)} exceeds absolute cap $${absMax}/share ` +
      `(within stat band but too large to be noise — increase N or investigate).`,
    );
  }
}

describe('Zero-EV stress (Phase 0.c.10)', () => {
  const N_TRADES = 20_000; // iid trades per scenario

  it('A: long ATM 30-DTE calls have zero EV under zero-drift GBM (r=0)', () => {
    const pnls = runManyTrades({
      nTrades: N_TRADES, sigma: 0.20, seedBase: 1001,
      dteDays: 30, strikeMoneyness: 1.0, isCall: true, direction: 'LONG',
      r: 0,
    });
    expectZeroEV(pnls, 'long ATM call');
  });

  it('B: long ATM 30-DTE puts have zero EV under zero-drift GBM (r=0)', () => {
    const pnls = runManyTrades({
      nTrades: N_TRADES, sigma: 0.20, seedBase: 2002,
      dteDays: 30, strikeMoneyness: 1.0, isCall: false, direction: 'LONG',
      r: 0,
    });
    expectZeroEV(pnls, 'long ATM put');
  });

  it('C: short ATM 30-DTE calls are exact sign-inverse of long calls (same seed)', () => {
    const longPnls = runManyTrades({
      nTrades: N_TRADES, sigma: 0.20, seedBase: 3003,
      dteDays: 30, strikeMoneyness: 1.0, isCall: true, direction: 'LONG',
      r: 0,
    });
    const shortPnls = runManyTrades({
      nTrades: N_TRADES, sigma: 0.20, seedBase: 3003,
      dteDays: 30, strikeMoneyness: 1.0, isCall: true, direction: 'SHORT',
      r: 0,
    });
    expect(longPnls.length).toBe(shortPnls.length);
    for (let i = 0; i < longPnls.length; i++) {
      expect(Math.abs(longPnls[i] + shortPnls[i])).toBeLessThan(1e-9);
    }
    expectZeroEV(longPnls, 'long call side');
    expectZeroEV(shortPnls, 'short call side');
  });

  it('D: ATM straddle (long call + long put) has zero EV on same paths', () => {
    const commonArgs = {
      nTrades: N_TRADES, sigma: 0.20, seedBase: 4004,
      dteDays: 30, strikeMoneyness: 1.0, direction: 'LONG' as const,
      r: 0,
    };
    const calls = runManyTrades({ ...commonArgs, isCall: true });
    const puts = runManyTrades({ ...commonArgs, isCall: false });
    expect(calls.length).toBe(puts.length);
    const combined = calls.map((c, i) => c + puts[i]);
    expectZeroEV(combined, 'ATM straddle');
  });

  it('E: OTM calls at +1σ moneyness have zero EV', () => {
    // +1σ OTM over 30 trading days: K/S ≈ 1 + σ·√(30/252) ≈ 1.069.
    const pnls = runManyTrades({
      nTrades: N_TRADES, sigma: 0.20, seedBase: 5005,
      dteDays: 30, strikeMoneyness: 1.069, isCall: true, direction: 'LONG',
      r: 0,
    });
    expectZeroEV(pnls, 'OTM +1σ call');
  });

  it('F: EV stays near zero as vol sweeps {0.15, 0.30, 0.50}', () => {
    // Higher vol → wider pnl distribution → we need more samples to keep
    // the statistical band under the absolute cap. Scale N with σ² so
    // stderr stays roughly constant across the sweep.
    for (const sigma of [0.15, 0.30, 0.50]) {
      // Stderr scales ~ σ √T / √N. At N=20k and σ=0.20 stderr ≈ $0.033; at
      // σ=0.50 we need N ≈ 20k·(0.5/0.20)² = 125k to hold stderr ≤ $0.033.
      const n = Math.round(20_000 * (sigma / 0.20) ** 2);
      const pnls = runManyTrades({
        nTrades: n, sigma, seedBase: 6006 + Math.round(sigma * 100),
        dteDays: 30, strikeMoneyness: 1.0, isCall: true, direction: 'LONG',
        r: 0,
      });
      expectZeroEV(pnls, `ATM call σ=${sigma}`, { minTrades: n });
    }
  });

  it('G: EV stays near zero as DTE sweeps {7, 30, 90}', () => {
    for (const dte of [7, 30, 90]) {
      // stderr scales ~ σ √T / √N. At N=20k σ=0.20 T=30/252 stderr ≈ $0.033;
      // at DTE=90 we need N ≈ 20k·(90/30) = 60k.
      const n = Math.round(20_000 * (dte / 30));
      const pnls = runManyTrades({
        nTrades: n, sigma: 0.20, seedBase: 7007 + dte,
        dteDays: dte, strikeMoneyness: 1.0, isCall: true, direction: 'LONG',
        r: 0,
      });
      expectZeroEV(pnls, `ATM call ${dte}-DTE`, { minTrades: n });
    }
  });

  it('H: at r=0.04 the long call EV equals BSM(r=0) − BSM(r=0.04) (rate cost)', () => {
    // Physical GBM has zero drift (E[S_T]=S_0), so E[payoff] = BSM(r=0).
    // We pay entry premium = BSM(r=0.04) > BSM(r=0), so E[pnl] is NEGATIVE,
    // equal to the pricing-rate premium: BSM(r=0) − BSM(r=0.04). This
    // confirms the engine is CONSISTENT between its "spot martingale"
    // assumption and its BSM pricing formula under non-zero r.
    const sigma = 0.20, dte = 30, r = 0.04;
    const pnls = runManyTrades({
      nTrades: N_TRADES, sigma, seedBase: 8008,
      dteDays: dte, strikeMoneyness: 1.0, isCall: true, direction: 'LONG',
      r,
    });
    const m = mean(pnls);
    const se = stderrOfMean(pnls);
    const T = dte / 252;
    const expectedBias = bsmPrice(100, 100, T, sigma, 0, true) - bsmPrice(100, 100, T, sigma, r, true);
    // 4σ band around the analytic prediction.
    expect(Math.abs(m - expectedBias)).toBeLessThan(4 * se);
    // Sanity: bias is indeed negative.
    expect(expectedBias).toBeLessThan(0);
  });

  it('I: pnl is bounded — no infinities, no NaNs (high vol × long DTE)', () => {
    const pnls = runManyTrades({
      nTrades: 2000, sigma: 0.50, seedBase: 9009,
      dteDays: 90, strikeMoneyness: 1.0, isCall: true, direction: 'LONG',
      r: 0,
    });
    for (const p of pnls) {
      expect(Number.isFinite(p), `non-finite P&L: ${p}`).toBe(true);
    }
  });

  it('determinism: same seed produces identical P&L sequence', () => {
    const common = {
      nTrades: 100, sigma: 0.20, seedBase: 11111,
      dteDays: 10, strikeMoneyness: 1.0, isCall: true, direction: 'LONG' as const,
      r: 0,
    };
    const a = runManyTrades(common);
    const b = runManyTrades(common);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });
});
