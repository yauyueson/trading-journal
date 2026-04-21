/**
 * Phase 2.j — test the Phase 2.g → 2.i schema migration on leaderboard
 * rows.
 *
 * Phase 2.g briefly promoted Mertens-SE DSR to `deflatedSharpe` and
 * stored the bootstrap value at `deflatedSharpeBootstrap`. Phase 2.i
 * reverted because downstream `analyze-*.ts` scripts compare
 * `deflatedSharpe > 0` across historical rows. To avoid leaving
 * `leaderboard-full-*.json` files with mixed semantics, the runner
 * normalizes on load: swap the fields so the bootstrap value occupies
 * `deflatedSharpe` again and the Mertens value moves to
 * `deflatedSharpeMertens`.
 *
 * This test exercises `normalizeDsrSchema` (indirectly — by loading a
 * fixture leaderboard and checking the result) without pulling runner
 * side effects.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeDsrSchema,
  leaderboardNeedsDsrMigration,
} from '../scripts/autoresearch/lib/normalize-dsr-schema';

describe('Phase 2.i/j DSR schema migration', () => {
  it('swaps Phase 2.g row to Phase 2.i schema: bootstrap restored, mertens preserved', () => {
    const phase2gRow = {
      strategyName: 'foo',
      deflatedSharpe: 0.8,            // Mertens-SE (2.g meaning)
      deflatedSharpeBootstrap: 1.2,   // bootstrap-SE (2.g shadow field)
    };
    const after = normalizeDsrSchema(phase2gRow);
    expect(after.deflatedSharpe).toBe(1.2);          // restored
    expect(after.deflatedSharpeMertens).toBe(0.8);   // moved
    expect('deflatedSharpeBootstrap' in after).toBe(false); // dropped
  });

  it('preserves an existing deflatedSharpeMertens field (Phase 2.e row)', () => {
    // Phase 2.e rows have both deflatedSharpe (bootstrap) and
    // deflatedSharpeMertens (Mertens) — already in the 2.i shape.
    // Migration must not clobber them.
    const phase2eRow = {
      strategyName: 'bar',
      deflatedSharpe: 1.5,
      deflatedSharpeMertens: 0.9,
    };
    const after = normalizeDsrSchema(phase2eRow);
    expect(after).toEqual(phase2eRow);
  });

  it('is a no-op on pre-2.e rows without any Mertens field', () => {
    const ancientRow = {
      strategyName: 'baz',
      deflatedSharpe: 0.7,
    };
    const after = normalizeDsrSchema(ancientRow);
    expect(after).toEqual(ancientRow);
  });

  it('is idempotent on already-migrated rows', () => {
    const migrated = {
      strategyName: 'qux',
      deflatedSharpe: 1.1,
      deflatedSharpeMertens: 0.6,
    };
    const once = normalizeDsrSchema(migrated);
    const twice = normalizeDsrSchema(once);
    expect(twice).toEqual(once);
  });

  it('does not overwrite an existing deflatedSharpeMertens with the 2.g value', () => {
    // Defensive: if a row somehow has both `deflatedSharpeBootstrap` AND
    // a pre-existing `deflatedSharpeMertens`, prefer the pre-existing
    // (it's more authoritative than the 2.g swap). Current helper only
    // sets Mertens if it was absent.
    const mutantRow = {
      strategyName: 'xyzzy',
      deflatedSharpe: 0.3,             // 2.g Mertens
      deflatedSharpeBootstrap: 1.0,    // 2.g bootstrap
      deflatedSharpeMertens: 0.7,      // somehow present from 2.e
    };
    const after = normalizeDsrSchema(mutantRow) as Record<string, unknown>;
    expect(after.deflatedSharpe).toBe(1.0);        // restored from bootstrap field
    expect(after.deflatedSharpeMertens).toBe(0.7); // kept, NOT overwritten to 0.3
    expect('deflatedSharpeBootstrap' in after).toBe(false);
  });
});

describe('leaderboardNeedsDsrMigration', () => {
  it('returns true when any row has a Phase 2.g deflatedSharpeBootstrap field', () => {
    const rows = [
      { deflatedSharpe: 1.0, deflatedSharpeMertens: 0.5 },
      { deflatedSharpe: 0.8, deflatedSharpeBootstrap: 1.2 }, // 2.g row
    ];
    expect(leaderboardNeedsDsrMigration(rows)).toBe(true);
  });

  it('returns false on a fully-normalized leaderboard', () => {
    const rows = [
      { deflatedSharpe: 1.0 },
      { deflatedSharpe: 1.2, deflatedSharpeMertens: 0.9 },
    ];
    expect(leaderboardNeedsDsrMigration(rows)).toBe(false);
  });

  it('returns false on an empty leaderboard', () => {
    expect(leaderboardNeedsDsrMigration([])).toBe(false);
  });
});
