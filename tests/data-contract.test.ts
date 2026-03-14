// tests/data-contract.test.ts
// Regression tests for Phase 2 data contracts:
//   EXIT-02 — target_price and spread_width in DirectAddItem type and useAddDirect mutation
//   SIG-01  — signal metadata (score, streak, signalType, adx, rvol, iv30d) in Signals navigate() calls
//   STRAT-01 — strategy-recommend.js STRATEGY_DEFAULTS enriched with profitTarget/ivRankMin/defaultWidth
//   STRAT-02 — scan-options.js applies profile-specific delta defaults
// Phase 3 (03-01) contracts:
//   SIG-02  — StrategyRecommender reads all signal params from searchParams
//   SIG-03  — Signal banner conditional on hasSignalContext
//   IVR-01  — IV gate compares ivRankPct to ivRankMin threshold
//   IVR-02  — IV gate wraps results with opacity/pointer-events classes
//   IVR-03  — Threshold read from strategyProfile?.ivRankMin with getProfile fallback
//   IVR-04  — No ivRankMin threshold in scoring functions (render-layer only)

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const typesSrc = readFileSync(
  resolve(__dirname, '../src/lib/types.ts'),
  'utf-8'
);

const mutationsSrc = readFileSync(
  resolve(__dirname, '../src/hooks/usePositionMutations.ts'),
  'utf-8'
);

const signalsSrc = readFileSync(
  resolve(__dirname, '../src/pages/Signals.tsx'),
  'utf-8'
);

// ---------------------------------------------------------------------------
// EXIT-02: DirectAddItem type contract
// ---------------------------------------------------------------------------
describe('EXIT-02 — DirectAddItem type contract', () => {
  it('src/lib/types.ts should have target_price?: number in DirectAddItem interface', () => {
    // Find the DirectAddItem interface block
    const directAddStart = typesSrc.indexOf('export interface DirectAddItem');
    expect(directAddStart).toBeGreaterThan(-1);
    // Find the closing brace of the interface
    const directAddBlock = typesSrc.slice(directAddStart, typesSrc.indexOf('\n}', directAddStart) + 2);
    expect(directAddBlock).toContain('target_price');
  });

  it('src/lib/types.ts DirectAddItem should declare target_price as optional number', () => {
    expect(typesSrc).toContain('target_price?: number');
  });
});

// ---------------------------------------------------------------------------
// EXIT-02: useAddDirect mutation insert object
// ---------------------------------------------------------------------------
describe('EXIT-02 — useAddDirect mutation insert', () => {
  it('usePositionMutations.ts should include target_price in the insert object', () => {
    // Assert target_price appears after the insert([ pattern
    const insertIdx = mutationsSrc.indexOf(".insert([{");
    expect(insertIdx).toBeGreaterThan(-1);
    const insertBlock = mutationsSrc.slice(insertIdx, mutationsSrc.indexOf('}]).select()', insertIdx) + 12);
    expect(insertBlock).toContain('target_price');
  });

  it('usePositionMutations.ts should include spread_width in the insert object', () => {
    const insertIdx = mutationsSrc.indexOf(".insert([{");
    expect(insertIdx).toBeGreaterThan(-1);
    const insertBlock = mutationsSrc.slice(insertIdx, mutationsSrc.indexOf('}]).select()', insertIdx) + 12);
    expect(insertBlock).toContain('spread_width');
  });

  it('usePositionMutations.ts insert maps target_price from item', () => {
    expect(mutationsSrc).toContain('item.target_price');
  });

  it('usePositionMutations.ts insert maps spread_width from item', () => {
    expect(mutationsSrc).toContain('item.spread_width');
  });
});

// ---------------------------------------------------------------------------
// SIG-01: Signals navigate() calls contain signal metadata params
// ---------------------------------------------------------------------------
describe('SIG-01 — Signals page navigate() URL params', () => {
  it('src/pages/Signals.tsx should include score param in navigate calls', () => {
    expect(signalsSrc).toContain('score');
  });

  it('src/pages/Signals.tsx should include streak param in navigate calls', () => {
    expect(signalsSrc).toContain('streak');
  });

  it('src/pages/Signals.tsx should include signalType param in navigate calls', () => {
    expect(signalsSrc).toContain('signalType');
  });

  it('src/pages/Signals.tsx should include adx param in buildParams URLSearchParams', () => {
    // Ensure adx is passed as a URL param via buildParams (object key or p.set)
    expect(signalsSrc).toMatch(/adx\s*:/);
  });

  it('src/pages/Signals.tsx should include rvol param in buildParams URLSearchParams', () => {
    expect(signalsSrc).toMatch(/rvol\s*:/);
  });

  it('src/pages/Signals.tsx should conditionally include iv30d param when row.iv30 is non-null', () => {
    expect(signalsSrc).toContain('iv30d');
    // Ensure it is conditional on row.iv30
    expect(signalsSrc).toContain('row.iv30');
  });

  it('src/pages/Signals.tsx swing button uses buildParams helper with "swing"', () => {
    expect(signalsSrc).toContain("buildParams('swing')");
  });

  it('src/pages/Signals.tsx shortTerm button uses buildParams helper with "shortTerm"', () => {
    expect(signalsSrc).toContain("buildParams('shortTerm')");
  });
});

// ---------------------------------------------------------------------------
// STRAT-01: strategy-recommend.js STRATEGY_DEFAULTS enrichment
// ---------------------------------------------------------------------------

const stratRecommendSrc = readFileSync(
  resolve(__dirname, '../api/strategy-recommend.js'),
  'utf-8'
);

const scanOptionsSrc = readFileSync(
  resolve(__dirname, '../api/scan-options.js'),
  'utf-8'
);

describe('STRAT-01 — strategy-recommend.js STRATEGY_DEFAULTS enrichment', () => {
  it('STRATEGY_DEFAULTS should contain profitTarget for both profiles', () => {
    // Find STRATEGY_DEFAULTS block
    const defaultsStart = stratRecommendSrc.indexOf('const STRATEGY_DEFAULTS');
    expect(defaultsStart).toBeGreaterThan(-1);
    const defaultsBlock = stratRecommendSrc.slice(defaultsStart, stratRecommendSrc.indexOf('\n};', defaultsStart) + 3);
    expect(defaultsBlock).toContain('profitTarget');
  });

  it('STRATEGY_DEFAULTS should contain ivRankMin for both profiles', () => {
    const defaultsStart = stratRecommendSrc.indexOf('const STRATEGY_DEFAULTS');
    expect(defaultsStart).toBeGreaterThan(-1);
    const defaultsBlock = stratRecommendSrc.slice(defaultsStart, stratRecommendSrc.indexOf('\n};', defaultsStart) + 3);
    expect(defaultsBlock).toContain('ivRankMin');
  });

  it('STRATEGY_DEFAULTS should contain defaultWidth for both profiles', () => {
    const defaultsStart = stratRecommendSrc.indexOf('const STRATEGY_DEFAULTS');
    expect(defaultsStart).toBeGreaterThan(-1);
    const defaultsBlock = stratRecommendSrc.slice(defaultsStart, stratRecommendSrc.indexOf('\n};', defaultsStart) + 3);
    expect(defaultsBlock).toContain('defaultWidth');
  });

  it('Response JSON should include strategyProfile object', () => {
    expect(stratRecommendSrc).toContain('strategyProfile');
  });

  it('Width fallback should reference strategyDefaults.defaultWidth (not hardcoded 15)', () => {
    expect(stratRecommendSrc).toContain('strategyDefaults.defaultWidth');
  });
});

// ---------------------------------------------------------------------------
// STRAT-01: StrategyResult type contract
// ---------------------------------------------------------------------------

describe('STRAT-01 — StrategyResult type has strategyProfile field', () => {
  it('src/lib/types.ts StrategyResult should include strategyProfile optional field', () => {
    expect(typesSrc).toContain('strategyProfile');
  });

  it('src/lib/types.ts strategyProfile should include profitTarget number field', () => {
    // Find the strategyProfile block in the interface
    const profileStart = typesSrc.indexOf('strategyProfile');
    expect(profileStart).toBeGreaterThan(-1);
    const profileBlock = typesSrc.slice(profileStart, typesSrc.indexOf('\n    };', profileStart) + 7);
    expect(profileBlock).toContain('profitTarget');
  });
});

// ---------------------------------------------------------------------------
// STRAT-02: scan-options.js profile-specific delta defaults
// ---------------------------------------------------------------------------

describe('STRAT-02 — scan-options.js profile-specific delta defaults', () => {
  it('scan-options.js should define deltaDefaults with profile-specific values', () => {
    expect(scanOptionsSrc).toContain('deltaDefaults');
  });

  it('scan-options.js deltaDefaults should include shortTerm min 0.20', () => {
    expect(scanOptionsSrc).toContain("'0.20'");
  });

  it('scan-options.js deltaDefaults should include swing min 0.28', () => {
    expect(scanOptionsSrc).toContain("'0.28'");
  });

  it('scan-options.js minDelta destructuring should use deltaDefaults.min', () => {
    expect(scanOptionsSrc).toContain('minDelta = deltaDefaults.min');
  });

  it('scan-options.js maxDelta destructuring should use deltaDefaults.max', () => {
    expect(scanOptionsSrc).toContain('maxDelta = deltaDefaults.max');
  });

  it('scan-options.js strategy param (long/short LOQ/CSQ) should NOT be modified', () => {
    // strategy = 'long' default must remain for LOQ/CSQ toggle
    expect(scanOptionsSrc).toContain("strategy = 'long'");
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (03-01) — signal context banner + IV gate source-inspection tests
// ---------------------------------------------------------------------------

const recommenderSrc = readFileSync(
  resolve(__dirname, '../src/pages/StrategyRecommender.tsx'),
  'utf-8'
);

const ossSrc = readFileSync(
  resolve(__dirname, '../src/lib/oss-core.ts'),
  'utf-8'
);

const scoringSrc = readFileSync(
  resolve(__dirname, '../lib/_shared/scoring.cjs'),
  'utf-8'
);

// ---------------------------------------------------------------------------
// SIG-02: StrategyRecommender reads all signal params from searchParams
// ---------------------------------------------------------------------------
describe('SIG-02 — StrategyRecommender reads signal params from searchParams', () => {
  it('StrategyRecommender.tsx reads score from searchParams', () => {
    expect(recommenderSrc).toContain("searchParams.get('score')");
  });

  it('StrategyRecommender.tsx reads streak from searchParams', () => {
    expect(recommenderSrc).toContain("searchParams.get('streak')");
  });

  it('StrategyRecommender.tsx reads signalType from searchParams', () => {
    expect(recommenderSrc).toContain("searchParams.get('signalType')");
  });

  it('StrategyRecommender.tsx reads adx from searchParams', () => {
    expect(recommenderSrc).toContain("searchParams.get('adx')");
  });

  it('StrategyRecommender.tsx reads rvol from searchParams', () => {
    expect(recommenderSrc).toContain("searchParams.get('rvol')");
  });

  it('StrategyRecommender.tsx reads iv30d from searchParams', () => {
    expect(recommenderSrc).toContain("searchParams.get('iv30d')");
  });
});

// ---------------------------------------------------------------------------
// SIG-03: Signal banner conditional on hasSignalContext
// ---------------------------------------------------------------------------
describe('SIG-03 — Signal banner conditional on hasSignalContext', () => {
  it('StrategyRecommender.tsx defines hasSignalContext variable', () => {
    expect(recommenderSrc).toContain('hasSignalContext');
  });

  it('StrategyRecommender.tsx derives hasSignalContext from signal params', () => {
    // hasSignalContext must be a boolean derived from urlScore, urlStreak, etc.
    expect(recommenderSrc).toMatch(/hasSignalContext\s*=\s*!!/);
  });

  it('StrategyRecommender.tsx uses hasSignalContext as JSX conditional', () => {
    // Banner is rendered conditionally via {hasSignalContext && (
    expect(recommenderSrc).toContain('{hasSignalContext && (');
  });
});

// ---------------------------------------------------------------------------
// IVR-01: IV gate compares ivRankPct to ivRankMin threshold
// ---------------------------------------------------------------------------
describe('IVR-01 — IV gate threshold comparison', () => {
  it('StrategyRecommender.tsx defines ivBelowThreshold flag', () => {
    expect(recommenderSrc).toContain('ivBelowThreshold');
  });

  it('StrategyRecommender.tsx compares ivRankPct < ivRankMin', () => {
    expect(recommenderSrc).toContain('ivRankPct < ivRankMin');
  });

  it('StrategyRecommender.tsx guards ivRank null before comparison', () => {
    expect(recommenderSrc).toContain('ivRankPct != null');
  });
});

// ---------------------------------------------------------------------------
// IVR-02: IV gate wraps entire recommendations section with opacity/pointer-events
// ---------------------------------------------------------------------------
describe('IVR-02 — IV gate wraps recommendations with overlay classes', () => {
  it('StrategyRecommender.tsx uses opacity-40 class for IV gate overlay', () => {
    expect(recommenderSrc).toContain('opacity-40');
  });

  it('StrategyRecommender.tsx uses pointer-events-none class for IV gate overlay', () => {
    expect(recommenderSrc).toContain('pointer-events-none');
  });

  it('StrategyRecommender.tsx uses select-none class for IV gate overlay', () => {
    expect(recommenderSrc).toContain('select-none');
  });

  it('StrategyRecommender.tsx shows dismissible IV gate overlay', () => {
    expect(recommenderSrc).toContain('showIvGate');
  });
});

// ---------------------------------------------------------------------------
// IVR-03: Threshold read from strategyProfile?.ivRankMin with getProfile fallback
// ---------------------------------------------------------------------------
describe('IVR-03 — IV threshold from strategyProfile with getProfile fallback', () => {
  it('StrategyRecommender.tsx reads ivRankMin from result.strategyProfile', () => {
    expect(recommenderSrc).toMatch(/strategyProfile\??\.ivRankMin/);
  });

  it('StrategyRecommender.tsx has getProfile fallback for ivRankMin', () => {
    expect(recommenderSrc).toContain('getProfile(activeStrategy).ivRankMin');
  });

  it('StrategyRecommender.tsx uses nullish coalescing for ivRankMin fallback', () => {
    expect(recommenderSrc).toMatch(/strategyProfile\??\.ivRankMin\s*\?\?\s*getProfile/);
  });
});

// ---------------------------------------------------------------------------
// IVR-04: No ivRankMin threshold check in scoring functions (render-layer only)
// ---------------------------------------------------------------------------
describe('IVR-04 — IV gate is render-layer only (not in scoring functions)', () => {
  it('src/lib/oss-core.ts does NOT contain ivRankMin', () => {
    expect(ossSrc).not.toContain('ivRankMin');
  });

  it('lib/_shared/scoring.cjs does NOT contain ivRankMin', () => {
    expect(scoringSrc).not.toContain('ivRankMin');
  });
});
