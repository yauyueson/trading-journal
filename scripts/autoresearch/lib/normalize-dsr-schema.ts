/**
 * Phase 2.j / 2.k (2026-04-20) — normalize Phase 2.g leaderboard rows
 * to the Phase 2.i schema.
 *
 * Phase 2.g (commit b418a51) briefly promoted Mertens-SE DSR to
 * `deflatedSharpe` and stored the historical bootstrap value at the
 * new field `deflatedSharpeBootstrap`. Phase 2.i (a49ddc5) reverted
 * the promotion because downstream analyses compare `deflatedSharpe >
 * 0` and sort by it across rows. Continuing an existing leaderboard
 * past the revert would leave the file with two incompatible
 * formulas sharing the same field name — the exact issue the revert
 * was supposed to fix.
 *
 * Detection: a Phase 2.g row carries a `deflatedSharpeBootstrap`
 * field. In such a row, `deflatedSharpe` is the Mertens-based value.
 * Migration swaps them so the row matches the Phase 2.i shape:
 *   deflatedSharpe        ← deflatedSharpeBootstrap (bootstrap-SE)
 *   deflatedSharpeMertens ← deflatedSharpe (Mertens-SE)
 *   deflatedSharpeBootstrap dropped
 *
 * Idempotent: rows lacking `deflatedSharpeBootstrap` are returned
 * as-is. Defensive: does not overwrite an existing
 * `deflatedSharpeMertens` (a pre-2.g row shouldn't be clobbered by
 * the 2.g shadow value).
 *
 * Extracted to a library module so tests can exercise the real
 * production helper (Codex round-24 Finding 2) rather than a
 * duplicated copy.
 */
export function normalizeDsrSchema<T extends object>(entry: T): T {
  const e = entry as unknown as Record<string, unknown>;
  if (!('deflatedSharpeBootstrap' in e)) return entry;
  const bsValue = e.deflatedSharpeBootstrap;
  const mertensValue = e.deflatedSharpe;
  const out = { ...e };
  if (typeof bsValue === 'number') out.deflatedSharpe = bsValue;
  if (typeof mertensValue === 'number' && out.deflatedSharpeMertens == null) {
    out.deflatedSharpeMertens = mertensValue;
  }
  delete out.deflatedSharpeBootstrap;
  return out as unknown as T;
}

/**
 * Returns true if any row in `entries` needs migration — i.e. carries
 * a `deflatedSharpeBootstrap` field. Use as a cheap precheck before
 * rewriting the on-disk leaderboard.
 */
export function leaderboardNeedsDsrMigration(entries: readonly object[]): boolean {
  return entries.some(e => 'deflatedSharpeBootstrap' in (e as Record<string, unknown>));
}
