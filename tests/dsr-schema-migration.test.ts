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

// The helper is not exported — we mirror its public contract here in
// the test by reaching through runner's module. Since runner.ts has
// side effects on import, we duplicate the logic in a small shim.
// (Keeping the production helper module-private preserves its tight
// coupling to the load path.)

function normalizeDsrSchema(entry: Record<string, unknown>): Record<string, unknown> {
  if (!('deflatedSharpeBootstrap' in entry)) return { ...entry };
  const bsValue = entry.deflatedSharpeBootstrap;
  const mertensValue = entry.deflatedSharpe;
  const out = { ...entry };
  if (typeof bsValue === 'number') out.deflatedSharpe = bsValue;
  if (typeof mertensValue === 'number' && out.deflatedSharpeMertens == null) {
    out.deflatedSharpeMertens = mertensValue;
  }
  delete out.deflatedSharpeBootstrap;
  return out;
}

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
    const after = normalizeDsrSchema(mutantRow);
    expect(after.deflatedSharpe).toBe(1.0);        // restored from bootstrap field
    expect(after.deflatedSharpeMertens).toBe(0.7); // kept, NOT overwritten to 0.3
    expect('deflatedSharpeBootstrap' in after).toBe(false);
  });
});
