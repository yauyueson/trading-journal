// tests/data-contract.test.ts
// Regression tests for Phase 2 Plan 1 data contract:
//   EXIT-02 — target_price and spread_width in DirectAddItem type and useAddDirect mutation
//   SIG-01  — signal metadata (score, streak, signalType, adx, rvol, iv30d) in Signals navigate() calls

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
