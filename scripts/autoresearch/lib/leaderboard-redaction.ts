/**
 * leaderboard-redaction — Phase 0.a.4
 *
 * Single source of truth for the contract between the audit leaderboard
 * (data/leaderboard-full*.json) and the agent-visible leaderboard
 * (scripts/autoresearch/leaderboard*.json).
 *
 * The autoresearch search-loop agent reads the agent-visible file on every
 * iteration. Any holdout-derived metric in that file leaks the holdout
 * outcome into the selection process, breaking the sealed-holdout contract.
 *
 * Two complementary guarantees:
 *
 *   1. Denylist (runtime). `HOLDOUT_DERIVED_FIELDS` + `stripHoldoutMetrics`
 *      recursively strip every banned key at every depth before the row is
 *      written to the agent path. Recursion is required because `RunResult`
 *      already carries nested structures (`exitTypeBreakdown`,
 *      `adoptionGatesOverrides`), so a future field like
 *      `diagnostics.holdoutSharpe` would otherwise slip past a top-level
 *      strip.
 *
 *   2. Allowlist (CI). `AGENT_VISIBLE_FIELDS` enumerates every top-level
 *      key that may appear in an agent-visible row. The Phase 0.a.4 test
 *      rejects any on-disk row that has a top-level key NOT in this list.
 *      This forces every new `RunResult` field to be classified as
 *      agent-visible or audit-only — it stops a holdout-derived field named
 *      innocuously (e.g. `promotionEligible`) from silently shipping.
 *
 * Keep this file free of heavy runtime deps (no worker_threads, no sqlite)
 * so tests can import it without dragging in the entire runner graph.
 */
import type { RunResult } from '../types';

/**
 * Canonical banned-key list. Holdout-related fields AND the combined
 * `isValid` boolean (which embeds the holdout gate) must be stripped.
 * `isValidForSearch` stays — that's the selection-only validity gate.
 *
 * Codex adversarial review (2026-04-17): `isValid` leaking as a boolean is
 * the same leak as exposing the raw numbers. Keep it banned.
 *
 * Codex adversarial review (2026-04-18, Phase 0.a.4 round 1): `isValid`
 * proves that holdout-derived fields don't always advertise themselves
 * with "holdout" in the name — hence the allowlist below.
 */
export const HOLDOUT_DERIVED_FIELDS = [
  'holdoutSharpe',
  'holdoutSpyIR',
  'holdoutSpyExcessReturn',
  'holdoutOOSRatio',
  'passesHoldout',
  'passesHoldoutOrIR',
  'passesHoldoutIRFloor',
  'passesHoldoutAndIR',
  'passesHoldoutNewEntries',
  // Phase 1.b — `passesStability` embeds holdoutOOSRatio (which embeds
  // holdoutSharpe), so same leak concern as the other holdout booleans.
  'passesStability',
  'holdoutTrades',
  'newHoldoutTrades',
  'carriedHoldoutTrades',
  'isValid',
] as const;

export type HoldoutDerivedField = (typeof HOLDOUT_DERIVED_FIELDS)[number];

/**
 * Allowlist of top-level keys legal in an agent-visible leaderboard row.
 * Every optional RunResult field is included; optional fields that happen
 * not to appear in a given row simply don't exercise their slot.
 *
 * ADDING A NEW RUN-RESULT FIELD: classify it here (if selection-only /
 * safe for the search-loop agent) OR in `HOLDOUT_DERIVED_FIELDS` (if it
 * leaks the holdout outcome). A field that ends up in neither list will
 * fail CI the first time it hits disk.
 */
export const AGENT_VISIBLE_FIELDS = [
  // Identity
  'strategyName',
  'timestamp',
  // Standalone OOS metrics
  'oosSharpe',
  'oosMaxDD',
  'oosWinRate',
  'oosTrades',
  'oosTotalPnl',
  // Combined with DTE5
  'combinedSharpe',
  'correlationWithDTE5',
  'combinedMaxDD',
  // Selection-period SPY IR (market-neutrality check on selection data)
  'oosSpyIR',
  'oosSpyExcessReturn',
  // WFA quality
  'avgTrainSharpe',
  'wfEfficiency',
  // Selection-only validity gates
  'passesMinTrades',
  'passesMaxDD',
  'passesWFA',
  'passesSanity',
  // Phase 1.d: mean grossPnl/maxProfit across OOS credit-spread trades.
  // OOS-only — safe to expose to the search loop. Useful as a search
  // signal too: agents can rule out configs trending near the sanity
  // ceiling before they burn a full evaluation.
  'meanPerTradeEdge',
  'isValidForSearch',
  // Overfitting diagnostics (selection-period only)
  'bootstrapSharpe95CI',
  'bootstrapSignificant',
  'attemptNumber',
  'deflatedSharpe',
  // Phase 2.a: N_eff diagnostic on OOS daily-return autocorrelation.
  // Purely selection-period, no holdout signal — safe to expose to the
  // search-loop agent.
  'nEffOosDaily',
  'nOosDaily',
  // Phase 2.c: Mertens closed-form Sharpe SE + higher moments. Same
  // selection-period OOS provenance as `bootstrapSharpe95CI` — safe to
  // expose. Useful search-loop signal (extreme kurtosis or skew flags
  // fat-tailed/asymmetric return streams the bootstrap may mis-calibrate).
  'mertensSharpeSE',
  'mertensSkewness',
  'mertensKurtosis',
  // Pre-registration audit trail
  'preRegBypassed',
  'preRegBypassReason',
  'preRegBlockHash',
  'preRegGitSha',
  'preRegHoldoutWindowHash',
  // Adoption-gate provenance
  'adoptionGatesRawHash',
  'adoptionGatesEffectiveHash',
  'adoptionGatesOverrides',
  // Phase 0.a.5: strategy-file git SHA at run time. Audit provenance, not
  // a holdout outcome — safe for the agent. (`holdoutEvaluated` is stripped
  // by the regex guard because its name contains "holdout".)
  'strategyGitSha',
  // Phase 0.a.5 round-2: repo HEAD SHA and strategy blob SHA at run time.
  // Audit provenance, not holdout — safe for the agent.
  'repoGitSha',
  'strategyBlobSha',
  // Phase 0.b.6: dataset-manifest provenance. Audit-only; safe for agent.
  'datasetManifestHash',
  'datasetManifestVersion',
  // Phase 0.b.7: per-series coverage hash. Audit provenance, not holdout.
  'tickerCoverageHash',
  // Diagnostics
  'exitTypeBreakdown',
  'signalsGenerated',
  'signalsSkippedNoChain',
  // Naive baseline comparison
  'baselineOosSharpe',
  'baselineMaxDD',
  'baselineCorrelation',
  'baselineSpyIR',
  'baselineTrades',
  // Delta metrics (strategy minus baseline)
  'deltaSpyIR',
  'deltaMaxDD',
  'deltaCorrelation',
  'passesDeltaSpyIR',
  'passesDeltaMaxDD',
  'passesDeltaCorr',
  'passesDeltaGates',
  // Error / timing
  'errorMessage',
  'elapsedMs',
  // Operator-added annotation explaining why a specific variant was marked
  // invalid post-hoc (e.g. "monitoring-artifact: 3-day intervals inflate
  // Sharpe"). Not tied to the holdout outcome — documents overfitting
  // patterns so the search loop learns to avoid them.
  'invalidReason',
] as const;

export type AgentVisibleField = (typeof AGENT_VISIBLE_FIELDS)[number];

/**
 * Structural guard used by the CI leakage test. A key is "banned" if:
 *   - exact match in HOLDOUT_DERIVED_FIELDS, OR
 *   - case-insensitive substring match on "holdout", OR
 *   - case-insensitive prefix match on "passesHoldout", OR
 *   - exact match "isValid".
 *
 * This is the best-effort name heuristic; the airtight guarantee comes
 * from the AGENT_VISIBLE_FIELDS allowlist check, which catches any new
 * top-level field regardless of name.
 */
export function isBannedHoldoutKey(key: string): boolean {
  if ((HOLDOUT_DERIVED_FIELDS as readonly string[]).includes(key)) return true;
  if (key === 'isValid') return true;
  if (/holdout/i.test(key)) return true;
  if (/^passesHoldout/i.test(key)) return true;
  return false;
}

function stripHoldoutRecursive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripHoldoutRecursive);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isBannedHoldoutKey(k)) continue;
    out[k] = stripHoldoutRecursive(v);
  }
  return out;
}

/**
 * Strip every banned key from a leaderboard row at ANY depth. Returns a
 * deep clone; callers must persist the return value, not mutate the input.
 * Recursion handles nested objects (e.g. `diagnostics: { holdoutSharpe }`)
 * and arrays of objects (e.g. `adoptionGatesOverrides`). `RunResult` is a
 * JSON-serializable shape with no circular references, so no cycle guard
 * is needed.
 */
export function stripHoldoutMetrics(entry: RunResult): object {
  return stripHoldoutRecursive(entry) as object;
}

/** One leak finding from the recursive scanner: the file path it came from
 *  is supplied by the caller; `path` is the dotted key path within the row. */
export type RecursiveLeak = { rowIdx: number; keyPath: string };

/**
 * Walk every object/array node in a row and collect every banned key by
 * its dotted key path (e.g. `diagnostics.holdoutSharpe`,
 * `adoptionGatesOverrides[0].holdoutTrades`).
 */
export function collectBannedKeyPaths(row: unknown, pathPrefix = ''): string[] {
  const hits: string[] = [];
  if (row == null || typeof row !== 'object') return hits;
  if (Array.isArray(row)) {
    for (let i = 0; i < row.length; i++) {
      hits.push(...collectBannedKeyPaths(row[i], `${pathPrefix}[${i}]`));
    }
    return hits;
  }
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    const p = pathPrefix === '' ? k : `${pathPrefix}.${k}`;
    if (isBannedHoldoutKey(k)) hits.push(p);
    hits.push(...collectBannedKeyPaths(v, p));
  }
  return hits;
}
