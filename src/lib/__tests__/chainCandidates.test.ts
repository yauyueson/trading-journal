import { describe, expect, it } from 'vitest';
import {
  buildBCDCandidates,
  buildPMCCLeapCandidates,
  buildPMCCRollShortCandidates,
  buildPMCCShortCandidates,
  findClosestDelta,
  type ChainOption,
} from '../chainCandidates';

function mkOpt(partial: Partial<ChainOption> & { strike: number; dte: number; delta: number; expiration: string; price?: number }): ChainOption {
  return {
    strike: partial.strike,
    type: partial.type ?? 'Call',
    expiration: partial.expiration,
    dte: partial.dte,
    price: partial.price ?? 1.0,
    greeks: {
      delta: partial.delta,
      gamma: partial.greeks?.gamma ?? 0,
      theta: partial.greeks?.theta ?? 0,
      vega: partial.greeks?.vega ?? 0,
      iv: partial.greeks?.iv ?? 0.25,
    },
    liquidity: partial.liquidity ?? { volume: 100, openInterest: 100, bid: 0.95, ask: 1.05 },
  };
}

describe('findClosestDelta', () => {
  it('returns the contract with |delta| closest to the target', () => {
    const opts = [
      mkOpt({ strike: 100, dte: 30, delta: 0.30, expiration: '2026-06-19' }),
      mkOpt({ strike: 105, dte: 30, delta: 0.48, expiration: '2026-06-19' }),
      mkOpt({ strike: 110, dte: 30, delta: 0.70, expiration: '2026-06-19' }),
    ];
    expect(findClosestDelta(opts, 0.50)?.strike).toBe(105);
    expect(findClosestDelta(opts, 0.30)?.strike).toBe(100);
    expect(findClosestDelta(opts, 0.75)?.strike).toBe(110);
  });

  it('respects the optional predicate', () => {
    const opts = [
      mkOpt({ strike: 100, dte: 30, delta: 0.50, expiration: '2026-06-19' }),
      mkOpt({ strike: 110, dte: 30, delta: 0.30, expiration: '2026-06-19' }),
    ];
    const above = findClosestDelta(opts, 0.50, o => o.strike > 100);
    expect(above?.strike).toBe(110);
  });

  it('returns null when nothing matches the predicate', () => {
    const opts = [mkOpt({ strike: 100, dte: 30, delta: 0.50, expiration: '2026-06-19' })];
    expect(findClosestDelta(opts, 0.20, o => o.strike > 999)).toBeNull();
  });
});

describe('buildBCDCandidates', () => {
  it('pairs a δ ≈ 0.50 long with a δ ≈ 0.20 short at the same expiration', () => {
    const chain: ChainOption[] = [
      mkOpt({ strike: 490, dte: 40, delta: 0.50, expiration: '2026-06-19', price: 6.00 }),
      mkOpt({ strike: 500, dte: 40, delta: 0.35, expiration: '2026-06-19', price: 3.00 }),
      mkOpt({ strike: 510, dte: 40, delta: 0.20, expiration: '2026-06-19', price: 1.50 }),
    ];
    const candidates = buildBCDCandidates(chain, 0.50, 0.20);
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.long.strike).toBe(490);
    expect(c.short.strike).toBe(510);
    expect(c.netDebit).toBeCloseTo(4.50);
    expect(c.width).toBe(20);
    expect(c.maxProfit).toBeCloseTo(15.50);
    expect(c.breakeven).toBeCloseTo(494.50);
  });

  it('returns one candidate per expiration, sorted by DTE', () => {
    const chain: ChainOption[] = [
      // Earlier expiry
      mkOpt({ strike: 490, dte: 35, delta: 0.50, expiration: '2026-05-22', price: 5.00 }),
      mkOpt({ strike: 510, dte: 35, delta: 0.20, expiration: '2026-05-22', price: 1.20 }),
      // Later expiry
      mkOpt({ strike: 490, dte: 55, delta: 0.50, expiration: '2026-06-19', price: 7.50 }),
      mkOpt({ strike: 510, dte: 55, delta: 0.20, expiration: '2026-06-19', price: 2.20 }),
    ];
    const candidates = buildBCDCandidates(chain);
    expect(candidates.map(c => c.dte)).toEqual([35, 55]);
  });

  it('skips expirations where short strike is not above long strike', () => {
    const chain: ChainOption[] = [
      mkOpt({ strike: 500, dte: 40, delta: 0.50, expiration: '2026-06-19', price: 5.00 }),
      // Only a single contract — the δ 0.20 lookup finds the same strike,
      // which is filtered out because short.strike > long.strike is required.
    ];
    expect(buildBCDCandidates(chain)).toHaveLength(0);
  });

  it('skips expirations where net debit is non-positive (bad quote data)', () => {
    const chain: ChainOption[] = [
      mkOpt({ strike: 490, dte: 40, delta: 0.50, expiration: '2026-06-19', price: 1.00 }),
      mkOpt({ strike: 510, dte: 40, delta: 0.20, expiration: '2026-06-19', price: 2.00 }),
    ];
    expect(buildBCDCandidates(chain)).toHaveLength(0);
  });
});

describe('buildPMCCLeapCandidates', () => {
  it('sorts calls by |delta| proximity to the target', () => {
    const chain: ChainOption[] = [
      mkOpt({ strike: 400, dte: 270, delta: 0.85, expiration: '2027-01-15' }),
      mkOpt({ strike: 420, dte: 270, delta: 0.74, expiration: '2027-01-15' }),
      mkOpt({ strike: 440, dte: 270, delta: 0.60, expiration: '2027-01-15' }),
    ];
    const ranked = buildPMCCLeapCandidates(chain, 0.75);
    expect(ranked.map(o => o.strike)).toEqual([420, 400, 440]);
  });
});

describe('buildPMCCShortCandidates', () => {
  it('excludes contracts at or below the LEAP strike', () => {
    const leapStrike = 420;
    const chain: ChainOption[] = [
      mkOpt({ strike: 420, dte: 35, delta: 0.40, expiration: '2026-06-19' }),
      mkOpt({ strike: 440, dte: 35, delta: 0.25, expiration: '2026-06-19' }),
      mkOpt({ strike: 460, dte: 35, delta: 0.15, expiration: '2026-06-19' }),
    ];
    const candidates = buildPMCCShortCandidates(chain, leapStrike, 0.25);
    expect(candidates.map(o => o.strike)).toEqual([440, 460]);
  });
});

describe('buildPMCCRollShortCandidates', () => {
  it('suggests up-and-out PMCC shorts above both the LEAP and current short strike', () => {
    const chain: ChainOption[] = [
      mkOpt({ strike: 430, dte: 35, delta: 0.30, expiration: '2026-06-19' }),
      mkOpt({ strike: 440, dte: 35, delta: 0.26, expiration: '2026-06-19' }),
      mkOpt({ strike: 450, dte: 35, delta: 0.24, expiration: '2026-06-19' }),
      mkOpt({ strike: 460, dte: 42, delta: 0.18, expiration: '2026-06-26' }),
    ];

    const candidates = buildPMCCRollShortCandidates(chain, {
      leapStrike: 410,
      currentShortStrike: 430,
      targetDelta: 0.25,
    });

    expect(candidates.map(o => o.strike)).toEqual([440, 450, 460]);
  });
});
