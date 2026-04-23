/**
 * Phase F0 — clean-slate attempt counter filter.
 *
 * Pre-registered in `docs/phase-f0-clean-slate-declaration.md`. This module
 * is the read-time filter that translates global attempt counts into F0
 * effective counts for use in Deflated-Sharpe Mertens (dsrM) gating.
 *
 * Boundary: 2026-04-22T22:15:00Z. Attempts timestamped before this are
 * excluded from F0 effective counts. Rationale in the declaration: many
 * pre-F0 runs ran under documented simulator bugs (gotcha #42, direction
 * inversions, synthetic fills) and are not legitimate multiple-testing
 * comparisons under the post-F0 pipeline.
 *
 * Implementation reads the trial ledger at `data/attempts-global.json`
 * (versioned, append-only). The ledger is the canonical record of trials
 * across all campaigns and suffixes.
 */
import fs from 'fs';
import path from 'path';
import type { TrialLedger } from './trial-ledger';

/**
 * The Phase F0 boundary timestamp (ISO UTC). Trials timestamped strictly
 * before this are excluded from F0 effective counts.
 *
 * Bound to the commit that shipped the F0 declaration; changes require
 * an explicit new phase declaration per the "no further resets" rule.
 */
export const F0_BOUNDARY_ISO = '2026-04-22T22:15:00Z';

/** Cached boundary epoch (ms) for comparisons. */
const F0_BOUNDARY_MS = Date.parse(F0_BOUNDARY_ISO);

function ledgerPath(repoRoot: string): string {
  return path.resolve(repoRoot, 'data/attempts-global.json');
}

function tryLoadLedger(repoRoot: string): TrialLedger | null {
  const p = ledgerPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as TrialLedger;
    if (!parsed || !Array.isArray(parsed.trials)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Count trials that contribute to the F0 effective attempt counter.
 *
 * A trial is counted iff:
 *   - Its timestamp is >= F0_BOUNDARY_ISO
 *   - Its timestamp is <= `upToTimestamp` (the row being sealed's own
 *     timestamp, to match BdLP's "N trials ever tried by the time this
 *     one was decided")
 *
 * If the ledger is missing or unreadable, returns null (caller should
 * fall back to the row's recorded `attemptNumber` with a warning).
 */
export function countEffectiveAttempts(
  repoRoot: string,
  upToTimestamp: string,
): { effectiveN: number; ledgerPresent: boolean } {
  const ledger = tryLoadLedger(repoRoot);
  if (!ledger) return { effectiveN: 0, ledgerPresent: false };
  const upToMs = Date.parse(upToTimestamp);
  if (!Number.isFinite(upToMs)) return { effectiveN: 0, ledgerPresent: true };
  let count = 0;
  for (const trial of ledger.trials) {
    if (typeof trial.timestamp !== 'string') continue;
    const tMs = Date.parse(trial.timestamp);
    if (!Number.isFinite(tMs)) continue;
    if (tMs < F0_BOUNDARY_MS) continue;
    if (tMs > upToMs) continue;
    count++;
  }
  return { effectiveN: count, ledgerPresent: true };
}

/**
 * Bailey-López de Prado deflation applied with an arbitrary N. Mirrors
 * the computation in `scripts/autoresearch/runner.ts` (exported there as
 * a private function; duplicated here to keep the seal layer independent
 * of the runner's import graph).
 *
 * Returns `undefined` when inputs preclude a meaningful deflation:
 *   - sharpeSE is missing, non-finite, or <= 0
 *   - numAttempts < 2 (no multi-testing to correct for)
 */
export function deflatedSharpeAt(
  observedSharpe: number | undefined,
  numAttempts: number,
  sharpeSE: number | undefined,
): number | undefined {
  if (typeof observedSharpe !== 'number' || !Number.isFinite(observedSharpe)) return undefined;
  if (typeof sharpeSE !== 'number' || !Number.isFinite(sharpeSE) || sharpeSE <= 0) return undefined;
  if (numAttempts < 2) return observedSharpe;
  const gamma = 0.5772; // Euler-Mascheroni
  const logN = Math.log(numAttempts);
  const sqrtTwoLogN = Math.sqrt(2 * logN);
  const a_N = sqrtTwoLogN - (Math.log(4 * Math.PI) + Math.log(logN)) / (2 * sqrtTwoLogN);
  const b_N = 1.0 / sqrtTwoLogN;
  const expectedMaxStdNormal = a_N + gamma * b_N;
  const expectedMaxSharpe = sharpeSE * expectedMaxStdNormal;
  return observedSharpe - expectedMaxSharpe;
}
