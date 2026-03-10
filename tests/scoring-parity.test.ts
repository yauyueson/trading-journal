/**
 * Scoring Parity Tests
 *
 * Ensures oss-core.ts (frontend) and scoring.cjs (API) produce identical results
 * for all shared scoring functions across a matrix of edge-case inputs.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

// Import TypeScript source (ESM)
import * as ossCore from '../src/lib/oss-core';

// Import CJS mirror
const require = createRequire(import.meta.url);
const scoringCjs = require('../lib/_shared/scoring.cjs');

// ─── Constants Parity ───────────────────────────────────────────────

describe('Constants parity', () => {
  it('HARD_FILTER_DEFAULTS match', () => {
    expect(ossCore.HARD_FILTER_DEFAULTS).toEqual(scoringCjs.HARD_FILTER_DEFAULTS);
  });

  it('HARD_FILTER_CREDIT match', () => {
    expect(ossCore.HARD_FILTER_CREDIT).toEqual(scoringCjs.HARD_FILTER_CREDIT);
  });

  it('DTE_BUCKETS match', () => {
    expect(ossCore.DTE_BUCKETS).toEqual(scoringCjs.DTE_BUCKETS);
  });

  it('MIN_BUCKET_SIZE match', () => {
    expect(ossCore.MIN_BUCKET_SIZE).toEqual(scoringCjs.MIN_BUCKET_SIZE);
  });

  it('LOQ_WEIGHTS match', () => {
    expect(ossCore.LOQ_WEIGHTS).toEqual(scoringCjs.LOQ_WEIGHTS);
  });

  it('LOQ_DT_WEIGHTS match', () => {
    expect(ossCore.LOQ_DT_WEIGHTS).toEqual(scoringCjs.LOQ_DT_WEIGHTS);
  });

  it('CSQ_WEIGHTS match', () => {
    expect(ossCore.CSQ_WEIGHTS).toEqual(scoringCjs.CSQ_WEIGHTS);
  });
});

// ─── Core Functions Parity ──────────────────────────────────────────

const testInputs = {
  lambdas: [0, 1, 5, 8, 10, 15, 20, 25, 50, 100],
  deltas: [-1, -0.7, -0.5, -0.3, -0.15, -0.05, 0, 0.05, 0.15, 0.3, 0.5, 0.7, 1],
  thetaBurns: [0, 0.001, 0.005, 0.01, 0.03, 0.05, 0.1, 0.5],
  ivRatios: [0.5, 0.7, 0.9, 0.95, 1.0, 1.05, 1.1, 1.3, 1.5, 2.0],
  rawScores: [-5, -3, -1, 0, 1, 3, 5, 10, -10],
  prices: [0.5, 1.0, 2.5, 5.0, 10.0, 50.0],
  strikes: [100, 200, 500],
  gammas: [0.001, 0.01, 0.05, 0.1],
  dtes: [1, 3, 7, 14, 21, 30, 45, 60, 90],
};

describe('compressLambda parity', () => {
  testInputs.lambdas.forEach(lambda => {
    it(`lambda=${lambda}`, () => {
      expect(ossCore.compressLambda(lambda)).toBeCloseTo(scoringCjs.compressLambda(lambda), 10);
    });
  });
});

describe('getThetaPenalty parity', () => {
  testInputs.thetaBurns.forEach(tb => {
    it(`thetaBurn=${tb}`, () => {
      expect(ossCore.getThetaPenalty(tb)).toBeCloseTo(scoringCjs.getThetaPenalty(tb), 10);
    });
  });
});

describe('getDeltaBonus parity', () => {
  testInputs.deltas.forEach(delta => {
    it(`delta=${delta}`, () => {
      expect(ossCore.getDeltaBonus(delta)).toBeCloseTo(scoringCjs.getDeltaBonus(delta), 10);
    });
  });
});

describe('getIVRiskFactor parity', () => {
  testInputs.ivRatios.forEach(ratio => {
    it(`ratio=${ratio}`, () => {
      expect(ossCore.getIVRiskFactor(ratio)).toBeCloseTo(scoringCjs.getIVRiskFactor(ratio), 10);
    });
  });
});

describe('getIVAdjustment parity', () => {
  testInputs.ivRatios.forEach(ratio => {
    ['long', 'short'].forEach(strategy => {
      it(`ratio=${ratio}, strategy=${strategy}`, () => {
        expect(ossCore.getIVAdjustment(ratio, strategy)).toBeCloseTo(
          scoringCjs.getIVAdjustment(ratio, strategy), 10
        );
      });
    });
  });
});

describe('normalizeScoreTo100 parity', () => {
  testInputs.rawScores.forEach(raw => {
    it(`raw=${raw}`, () => {
      expect(ossCore.normalizeScoreTo100(raw)).toBe(scoringCjs.normalizeScoreTo100(raw));
    });
  });
});

describe('calculateDollarGamma parity', () => {
  testInputs.gammas.forEach(gamma => {
    testInputs.strikes.forEach(S => {
      it(`gamma=${gamma}, S=${S}`, () => {
        expect(ossCore.calculateDollarGamma(gamma, S)).toBeCloseTo(
          scoringCjs.calculateDollarGamma(gamma, S), 10
        );
      });
    });
  });
});

describe('getIVRankAdjustment parity', () => {
  const ivRanks = [null, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const sampleDays = [0, 45, 90, 180, 252];

  ivRanks.forEach(ivRank => {
    sampleDays.forEach(days => {
      ['long', 'short'].forEach(strategy => {
        it(`ivRank=${ivRank}, days=${days}, strategy=${strategy}`, () => {
          const ts = ossCore.getIVRankAdjustment(ivRank, strategy, days);
          const cjs = scoringCjs.getIVRankAdjustment(ivRank, strategy, days);
          expect(ts).toBeCloseTo(cjs, 10);
        });
      });
    });
  });

  // Verify continuous sigmoid properties
  it('should be 0 at ivRank=0.5', () => {
    expect(ossCore.getIVRankAdjustment(0.5, 'long', 252)).toBeCloseTo(0, 10);
  });
  it('should be nonzero at ivRank=0.4 (no dead zone)', () => {
    expect(Math.abs(ossCore.getIVRankAdjustment(0.4, 'long', 252))).toBeGreaterThan(0.01);
  });
  it('should approach ±0.5 at extremes', () => {
    const extreme = ossCore.getIVRankAdjustment(0.95, 'short', 252);
    expect(Math.abs(extreme)).toBeGreaterThan(0.4);
    expect(Math.abs(extreme)).toBeLessThanOrEqual(0.5);
  });
});

describe('getLOQVegaWeight parity', () => {
  testInputs.dtes.forEach(dte => {
    [-0.5, -0.1, 0, 0.1, 0.5, 1.0].forEach(ivAdj => {
      it(`dte=${dte}, ivAdj=${ivAdj}`, () => {
        expect(ossCore.getLOQVegaWeight(dte, ivAdj)).toBeCloseTo(
          scoringCjs.getLOQVegaWeight(dte, ivAdj), 10
        );
      });
    });
  });
});

describe('calculateLOQRaw parity', () => {
  const cases = [
    [1.0, 0.5, -0.3, 0.1, 0.5, 0.0],
    [2.0, -1.0, 1.5, -0.5, -1.0, 0.2],
    [0, 0, 0, 0, 0, 0],
    [-2.0, 3.0, -1.0, 0.3, 1.5, 0.5],
  ];

  cases.forEach(([zL, zG, zT, ivAdj, dB, tP], i) => {
    it(`case ${i}`, () => {
      const ts = ossCore.calculateLOQRaw(zL, zG, zT, ivAdj, dB, tP);
      const cjs = scoringCjs.calculateLOQRaw(zL, zG, zT, ivAdj, dB, tP);
      expect(ts).toBeCloseTo(cjs, 10);
    });
  });
});

describe('calculateCSQRaw parity', () => {
  const cases = [
    [1.0, 0.5, -0.3, 0.1],
    [2.0, -1.0, 1.5, -0.5],
    [0, 0, 0, 0],
  ];

  cases.forEach(([zEdge, zPop, zSpread, ivAdj], i) => {
    it(`case ${i}`, () => {
      const ts = ossCore.calculateCSQRaw(zEdge, zPop, zSpread, ivAdj);
      const cjs = scoringCjs.calculateCSQRaw(zEdge, zPop, zSpread, ivAdj);
      expect(ts).toBeCloseTo(cjs, 10);
    });
  });
});

describe('calculateExpectedValue parity', () => {
  const cases = [
    { pop: 0.7, maxProfit: 100, maxRisk: 200 },
    { pop: 0.5, maxProfit: 50, maxRisk: 50 },
    { pop: 0.9, maxProfit: 20, maxRisk: 180 },
    { pop: 0.3, maxProfit: 300, maxRisk: 100 },
  ];

  cases.forEach(({ pop, maxProfit, maxRisk }, i) => {
    it(`case ${i}`, () => {
      expect(ossCore.calculateExpectedValue(pop, maxProfit, maxRisk)).toBeCloseTo(
        scoringCjs.calculateExpectedValue(pop, maxProfit, maxRisk), 10
      );
    });
  });
});

describe('lerp parity', () => {
  const cases = [
    [5, 0, 10, 0, 100],
    [0, 0, 10, 0, 100],
    [10, 0, 10, 0, 100],
    [3, 1, 5, -10, 10],
  ];

  cases.forEach(([x, x1, x2, y1, y2], i) => {
    it(`case ${i}`, () => {
      expect(ossCore.lerp(x, x1, x2, y1, y2)).toBeCloseTo(
        scoringCjs.lerp(x, x1, x2, y1, y2), 10
      );
    });
  });
});

describe('getBreakevenPenalty parity', () => {
  const moves = [0.01, 0.02, 0.05, 0.1, 0.15, 0.25, 0.5];
  moves.forEach(move => {
    it(`move=${move}`, () => {
      expect(ossCore.getBreakevenPenalty(move)).toBeCloseTo(
        scoringCjs.getBreakevenPenalty(move), 10
      );
    });
  });
});

describe('calculateSpreadPct parity', () => {
  const cases = [
    { bid: 1.0, ask: 1.1, mid: 1.05 },
    { bid: 0, ask: 0.5, mid: 0.25 },
    { bid: 5.0, ask: 5.5, mid: 5.25 },
  ];

  cases.forEach(({ bid, ask, mid }, i) => {
    it(`case ${i}`, () => {
      expect(ossCore.calculateSpreadPct(bid, ask, mid)).toBeCloseTo(
        scoringCjs.calculateSpreadPct(bid, ask, mid), 10
      );
    });
  });
});

describe('getVolForecastAdjustment parity', () => {
  const cases = [
    // null/edge cases
    { orFcst20d: null, iv30: 0.3, fcstR2: 0.5, strategy: 'long' as const },
    { orFcst20d: 0.25, iv30: null, fcstR2: 0.5, strategy: 'long' as const },
    { orFcst20d: 0.25, iv30: 0, fcstR2: 0.5, strategy: 'long' as const },
    { orFcst20d: 0.25, iv30: 0.3, fcstR2: null, strategy: 'long' as const },
    // low quality — should return 0
    { orFcst20d: 0.25, iv30: 0.3, fcstR2: 0.05, strategy: 'long' as const },
    // normal cases
    { orFcst20d: 0.30, iv30: 0.30, fcstR2: 0.5, strategy: 'long' as const },  // diff=0
    { orFcst20d: 0.36, iv30: 0.30, fcstR2: 0.5, strategy: 'long' as const },  // diff=+0.2
    { orFcst20d: 0.24, iv30: 0.30, fcstR2: 0.5, strategy: 'long' as const },  // diff=-0.2
    { orFcst20d: 0.36, iv30: 0.30, fcstR2: 0.5, strategy: 'short' as const }, // short reverses sign
    { orFcst20d: 0.36, iv30: 0.30, fcstR2: 1.0, strategy: 'long' as const },  // high quality
    { orFcst20d: 0.36, iv30: 0.30, fcstR2: 0.1, strategy: 'long' as const },  // min quality
    // extreme diff (should clamp at ±0.3)
    { orFcst20d: 0.60, iv30: 0.30, fcstR2: 0.8, strategy: 'long' as const },
    { orFcst20d: 0.10, iv30: 0.30, fcstR2: 0.8, strategy: 'long' as const },
  ];

  cases.forEach(({ orFcst20d, iv30, fcstR2, strategy }, i) => {
    it(`case ${i}: fcst=${orFcst20d}, iv30=${iv30}, R²=${fcstR2}, ${strategy}`, () => {
      expect(ossCore.getVolForecastAdjustment(orFcst20d, iv30, fcstR2, strategy)).toBeCloseTo(
        scoringCjs.getVolForecastAdjustment(orFcst20d, iv30, fcstR2, strategy), 10
      );
    });
  });

  // Property tests
  it('should return 0 when forecast equals current IV', () => {
    expect(ossCore.getVolForecastAdjustment(0.3, 0.3, 0.5, 'long')).toBe(0);
  });
  it('should return 0 when quality below threshold', () => {
    expect(ossCore.getVolForecastAdjustment(0.5, 0.3, 0.09, 'long')).toBe(0);
  });
  it('long and short should have opposite signs', () => {
    const longAdj = ossCore.getVolForecastAdjustment(0.36, 0.3, 0.5, 'long');
    const shortAdj = ossCore.getVolForecastAdjustment(0.36, 0.3, 0.5, 'short');
    expect(longAdj).toBeCloseTo(-shortAdj, 10);
  });
});
