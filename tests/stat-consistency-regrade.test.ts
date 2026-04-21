/**
 * Phase 2.o — recompute `passesStatConsistency` and `isValid` on
 * persisted leaderboard rows under the current hard-gate threshold.
 *
 * Background in the helper doc-comment. Tests cover:
 *   - Threshold bump: a 2.h-era row with `passesStatConsistency=false`
 *     and ratio in (2.5, 5.0] becomes `passesStatConsistency=true`
 *     under 5.0x, and its `isValid` flips from whatever-stored to
 *     whatever the recomputation yields.
 *   - Hard-gate promotion: a 2.h-era row with `isValid=true` but
 *     `passesStatConsistency=false` AND ratio > 5.0x gets `isValid=false`
 *     under the 2.n hard-gate semantics.
 *   - Idempotency: rerunning the migration produces the same output.
 *   - No-op on pre-2.h rows (no statConsistencyRatio field).
 *   - Missing gate-input fields: `isValid` is left alone (we only
 *     recompute when every input is a stored boolean).
 */
import { describe, it, expect } from 'vitest';
import {
  applyCurrentStatConsistencyGate,
  leaderboardNeedsStatConsistencyRegrade,
} from '../scripts/autoresearch/lib/stat-consistency-regrade';

const MAX_RATIO_2_N = 5.0;

function makeFullyGatedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    strategyName: 'fixture',
    isValidForSearch: true,
    passesHoldoutAndIR: true,
    passesHoldoutNewEntries: true,
    passesStability: true,
    passesStatConsistency: true,
    isValid: true,
    statConsistencyRatio: 1.5,
    ...overrides,
  };
}

describe('applyCurrentStatConsistencyGate', () => {
  it('is a no-op on pre-2.h rows (no statConsistencyRatio field)', () => {
    const row = { strategyName: 'ancient', isValid: true };
    const out = applyCurrentStatConsistencyGate(row, MAX_RATIO_2_N);
    expect(out).toBe(row);
  });

  it('flips passesStatConsistency when ratio crosses threshold (2.h → 2.n upgrade)', () => {
    // Phase 2.h stamped: ratio = 3.0, threshold = 2.5 → passesStatConsistency=false.
    // Phase 2.n threshold = 5.0 → now passes.
    const row = makeFullyGatedRow({
      statConsistencyRatio: 3.0,
      passesStatConsistency: false,
      isValid: true, // 2.h didn't gate so isValid stayed true
    });
    const out = applyCurrentStatConsistencyGate(row, MAX_RATIO_2_N) as Record<string, unknown>;
    expect(out.passesStatConsistency).toBe(true);
    // isValid was already true AND passes recomputes to true → stays true.
    expect(out.isValid).toBe(true);
  });

  it('flips isValid to false when ratio exceeds 2.n hard-gate threshold', () => {
    // Phase 2.h-era row: ratio=6.0, threshold 2.5 → passesStatConsistency=false,
    // but isValid stayed true because 2.h was soft-flag only.
    const row = makeFullyGatedRow({
      statConsistencyRatio: 6.0,
      passesStatConsistency: false,
      isValid: true,
    });
    const out = applyCurrentStatConsistencyGate(row, MAX_RATIO_2_N) as Record<string, unknown>;
    expect(out.passesStatConsistency).toBe(false);
    expect(out.isValid).toBe(false);
  });

  it('preserves isValid when the recompute matches stored value (idempotent)', () => {
    const row = makeFullyGatedRow({
      statConsistencyRatio: 2.0,
      passesStatConsistency: true,
      isValid: true,
    });
    const once = applyCurrentStatConsistencyGate(row, MAX_RATIO_2_N);
    const twice = applyCurrentStatConsistencyGate(once, MAX_RATIO_2_N);
    expect(twice).toBe(once);
    expect(once).toBe(row); // identity: no change to apply
  });

  it('does not recompute isValid when prior gate booleans are missing', () => {
    // Row missing passesStability — may be pre-1.b. Leave isValid alone
    // rather than invent a partial recomputation.
    const row = {
      strategyName: 'partial',
      statConsistencyRatio: 6.0,
      passesStatConsistency: true, // wrong under 5.0x threshold
      isValid: true,
      isValidForSearch: true,
      passesHoldoutAndIR: true,
      passesHoldoutNewEntries: true,
      // passesStability absent
    };
    const out = applyCurrentStatConsistencyGate(row, MAX_RATIO_2_N) as Record<string, unknown>;
    // passesStatConsistency must be updated (it's a per-row field).
    expect(out.passesStatConsistency).toBe(false);
    // isValid must NOT be recomputed — formula inputs incomplete.
    expect(out.isValid).toBe(true);
  });

  it('handles a row whose ratio passes but whose isValid was false for unrelated reasons', () => {
    const row = makeFullyGatedRow({
      statConsistencyRatio: 1.5,
      passesStatConsistency: true,
      isValid: false, // false because (say) passesStability was false
      passesStability: false,
    });
    const out = applyCurrentStatConsistencyGate(row, MAX_RATIO_2_N) as Record<string, unknown>;
    // Recomputed isValid = false (passesStability still false).
    expect(out.isValid).toBe(false);
  });
});

describe('leaderboardNeedsStatConsistencyRegrade', () => {
  it('returns false on an empty leaderboard', () => {
    expect(leaderboardNeedsStatConsistencyRegrade([], MAX_RATIO_2_N)).toBe(false);
  });

  it('returns false when every row already matches the threshold', () => {
    const rows = [
      makeFullyGatedRow({ statConsistencyRatio: 1.0, passesStatConsistency: true, isValid: true }),
      makeFullyGatedRow({ statConsistencyRatio: 2.0, passesStatConsistency: true, isValid: true }),
    ];
    expect(leaderboardNeedsStatConsistencyRegrade(rows, MAX_RATIO_2_N)).toBe(false);
  });

  it('returns true when any row needs an update', () => {
    const rows = [
      makeFullyGatedRow({ statConsistencyRatio: 1.0, passesStatConsistency: true, isValid: true }),
      makeFullyGatedRow({ statConsistencyRatio: 3.0, passesStatConsistency: false, isValid: true }), // 2.h row, 3.0 > 2.5 stamped false but passes 5.0
    ];
    expect(leaderboardNeedsStatConsistencyRegrade(rows, MAX_RATIO_2_N)).toBe(true);
  });

  it('is a no-op on pre-2.h rows', () => {
    const rows = [
      { strategyName: 'ancient1', isValid: true },
      { strategyName: 'ancient2', isValid: false },
    ];
    expect(leaderboardNeedsStatConsistencyRegrade(rows, MAX_RATIO_2_N)).toBe(false);
  });
});
