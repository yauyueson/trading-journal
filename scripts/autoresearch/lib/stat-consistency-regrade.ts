/**
 * Phase 2.o (2026-04-20) — recompute `passesStatConsistency` and
 * `isValid` on persisted leaderboard rows under the current
 * `maxStatConsistencyRatio` threshold.
 *
 * Background:
 *   - Phase 2.h (commit d5678ab) added `passesStatConsistency` as a
 *     warning-only flag at 2.5×. Rows written during 2.h may carry
 *     `passesStatConsistency = false` for ratios in (2.5, ∞) while
 *     `isValid = true` (the flag wasn't gating).
 *   - Phase 2.n (commit b9fa___) promoted the flag to a hard gate and
 *     raised the default to 5.0×. Under the new semantics:
 *       ratios in (2.5, 5.0] are now PASSING (previously stale false).
 *       ratios in (5.0, ∞)  now fail `isValid` (previously isValid ignored).
 *
 * Two stale states can appear in a leaderboard-full-*.json written under
 * 2.h semantics:
 *
 *   (a) `passesStatConsistency = false` but `isValid = true` — ratio is
 *       in (2.5, ∞) and the 2.h soft flag didn't gate. Under 2.n the
 *       correct `isValid` depends on whether the ratio ≤ 5.0.
 *
 *   (b) `passesStatConsistency = true` but ratio > 5.0 — shouldn't exist
 *       under 2.h either (passes was true iff ratio ≤ 2.5). This is a
 *       defensive re-evaluation in case the threshold changes again.
 *
 * Migration:
 *   1. If `statConsistencyRatio` is missing, leave the row alone (pre-2.h).
 *   2. Otherwise recompute `passesStatConsistency = (ratio ≤ maxRatio)`.
 *   3. If the row also has all the other gate booleans, recompute `isValid`
 *      using the current formula (matches `runner.ts` Phase 2.n logic).
 *
 * The recompute of `isValid` only consults THIS row's stored booleans —
 * other gate thresholds (minStability, minOosTrades, etc.) could have
 * changed between when the row was written and now, and we deliberately
 * don't re-evaluate those. This migration is scoped to the specific
 * config-change-that-affects-isValid introduced by 2.n.
 */

const REQUIRED_GATE_FIELDS = [
  'isValidForSearch',
  'passesHoldoutAndIR',
  'passesHoldoutNewEntries',
  'passesStability',
] as const;

export function applyCurrentStatConsistencyGate<T extends object>(
  entry: T,
  maxRatio: number,
): T {
  const e = entry as unknown as Record<string, unknown>;
  if (typeof e.statConsistencyRatio !== 'number') return entry;

  const newPasses = e.statConsistencyRatio <= maxRatio;

  // Recompute `isValid` only when every input is a stored boolean.
  // Pre-1.b rows may lack `passesStability`; pre-2.h rows may lack
  // `passesHoldoutNewEntries`. In those cases leave `isValid` untouched
  // (we don't know the full formula under that row's era).
  const hasAllGateInputs = REQUIRED_GATE_FIELDS.every(
    k => typeof e[k] === 'boolean',
  );

  let out: Record<string, unknown> | null = null;
  if (e.passesStatConsistency !== newPasses) {
    out = out ?? { ...e };
    out.passesStatConsistency = newPasses;
  }
  if (hasAllGateInputs) {
    const passesStatForIsValid = newPasses !== false;
    const recomputedIsValid =
      (e.isValidForSearch as boolean) &&
      (e.passesHoldoutAndIR as boolean) &&
      (e.passesHoldoutNewEntries as boolean) &&
      (e.passesStability as boolean) &&
      passesStatForIsValid;
    if (e.isValid !== recomputedIsValid) {
      out = out ?? { ...e };
      out.isValid = recomputedIsValid;
    }
  }

  return (out ?? (e as unknown as T)) as T;
}

/**
 * Cheap precheck for the boot-time rewrite path. Returns true if any
 * row's stored `passesStatConsistency` or `isValid` disagrees with what
 * `applyCurrentStatConsistencyGate` would compute under `maxRatio`.
 */
export function leaderboardNeedsStatConsistencyRegrade(
  rows: readonly object[],
  maxRatio: number,
): boolean {
  for (const row of rows) {
    const migrated = applyCurrentStatConsistencyGate(row, maxRatio);
    if (migrated !== row) return true;
  }
  return false;
}
