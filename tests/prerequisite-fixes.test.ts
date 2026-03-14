// tests/prerequisite-fixes.test.ts
// Regression tests for Phase 1 prerequisite fixes:
//   PRE-01 — shortTerm ivRankMin corrected to 40
//   PRE-02 — API param rename: profileStrategy → activeProfile
//   PRE-03 — creditSpread removed from AppSettings type and DEFAULT_APP_SETTINGS

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { STRATEGY_PROFILES } from '../src/lib/strategyProfiles';
import { DEFAULT_APP_SETTINGS } from '../src/lib/types/settings';

// ---------------------------------------------------------------------------
// PRE-01: ivRankMin values
// ---------------------------------------------------------------------------
describe('PRE-01 — strategyProfiles ivRankMin', () => {
  it('shortTerm.ivRankMin should be 40 (not 30)', () => {
    expect(STRATEGY_PROFILES.shortTerm.ivRankMin).toBe(40);
  });

  it('swing.ivRankMin should remain 30', () => {
    expect(STRATEGY_PROFILES.swing.ivRankMin).toBe(30);
  });

  it('STRATEGY_PROFILES.swing has all expected StrategyProfile fields', () => {
    const p = STRATEGY_PROFILES.swing;
    expect(typeof p.dteMin).toBe('number');
    expect(typeof p.dteMax).toBe('number');
    expect(typeof p.dtePeak).toBe('number');
    expect(typeof p.profitTarget).toBe('number');
    expect(typeof p.ivRankMin).toBe('number');
    expect(typeof p.defaultDelta).toBe('number');
    expect(typeof p.defaultWidth).toBe('number');
  });

  it('STRATEGY_PROFILES.shortTerm has all expected StrategyProfile fields', () => {
    const p = STRATEGY_PROFILES.shortTerm;
    expect(typeof p.dteMin).toBe('number');
    expect(typeof p.dteMax).toBe('number');
    expect(typeof p.dtePeak).toBe('number');
    expect(typeof p.profitTarget).toBe('number');
    expect(typeof p.ivRankMin).toBe('number');
    expect(typeof p.defaultDelta).toBe('number');
    expect(typeof p.defaultWidth).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// PRE-02: API param naming — activeProfile (not profileStrategy)
// Scanner.tsx removed in phase 05 — test updated to only verify scan-options.js
// ---------------------------------------------------------------------------
describe('PRE-02 — API param naming', () => {
  const scanApiSrc = readFileSync(
    resolve(__dirname, '../api/scan-options.js'),
    'utf-8'
  );

  it('scan-options.js should read req.query.activeProfile not req.query.profileStrategy', () => {
    expect(scanApiSrc).toContain('req.query.activeProfile');
    expect(scanApiSrc).not.toContain('req.query.profileStrategy');
  });
});

// ---------------------------------------------------------------------------
// PRE-03: creditSpread removed from AppSettings type and DEFAULT_APP_SETTINGS
// ---------------------------------------------------------------------------
describe('PRE-03 — creditSpread removed from settings', () => {
  it('DEFAULT_APP_SETTINGS should NOT have a creditSpread property', () => {
    expect(DEFAULT_APP_SETTINGS).not.toHaveProperty('creditSpread');
  });

  it('DEFAULT_APP_SETTINGS has expected top-level keys (portfolio, techScore, strategy)', () => {
    expect(DEFAULT_APP_SETTINGS).toHaveProperty('portfolio');
    expect(DEFAULT_APP_SETTINGS).toHaveProperty('techScore');
    expect(DEFAULT_APP_SETTINGS).toHaveProperty('strategy');
  });
});
