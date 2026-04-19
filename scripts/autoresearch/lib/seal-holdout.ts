/**
 * seal-holdout — Phase 0.a.5 ceremony library (round-2 hardening)
 *
 * Produces a sealed Markdown record of a holdout evaluation. Contract:
 *
 *   The seal reads an APPEND-ONLY, git-committed JSONL file at
 *   `docs/audit-rows/<preRegBlockHash>.jsonl` — one line per non-bypassed
 *   run under that pre-reg block. It filters rows by strategyName +
 *   strategyBlobSha + preRegBlockHash and picks the FIRST match (not last)
 *   to prevent rerun-until-favorable selection.
 *
 *   For the selected row, the seal additionally requires:
 *
 *     row.strategyGitSha  === strategy file's current last-touch commit
 *     row.holdoutEvaluated === true
 *     row.repoGitSha      is non-null, is an ancestor of current HEAD,
 *                         and only files under docs/, .handoff/, or data/
 *                         changed between row.repoGitSha and current HEAD.
 *                         (The ancestor+audit-only-diff check tolerates the
 *                          operator committing the audit-row file between
 *                          runner and seal.)
 *
 *   No prior seal exists for the pre-reg block.
 *
 * Closes Codex round-2 findings:
 *   - F1: strategyGitSha alone didn't bind imports. Now strategyBlobSha
 *         binds the exact strategy content, and repoGitSha + ancestor-with-
 *         audit-only-diff binds the rest of the code under test.
 *   - F2: Per-block row file was silently overwritten. Now append-only JSONL;
 *         the seal picks the FIRST matching row.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { validatePreRegOrBypass } from './pre-reg-gate';
import { loadDatasetManifest } from './dataset-manifest';
import type { RunResult } from '../types';

export interface SealArgs {
  repoRoot: string;
  strategyPath: string;        // relative to repoRoot
  strategyName: string;        // must match RunResult.strategyName on the row
  preRegHash: string;          // 64 hex chars (no prefix); normalized before use
  now?: Date;                  // injectable clock (tests)
}

export type SealOutcome =
  | {
      ok: true;
      sealPath: string;
      passes: boolean;
      row: RunResult;
      strategyGitSha: string;
      strategyBlobSha: string;
      /** The HEAD the runner saw when it stamped the row (a.k.a. row.repoGitSha). */
      rowRepoGitSha: string;
      /** The HEAD observed at seal time. Usually `rowRepoGitSha` + the audit-row commit. */
      sealRepoHead: string;
      preRegGitSha: string | null;
      auditRowGitSha: string;
      rowIndex: number; // 0-based line index within the JSONL file
    }
  | { ok: false; reason: string; hint?: string };

/** Normalize a CLI-supplied hash into the pure 64-hex form used in RunResult. */
export function normalizeBlockHashArg(raw: string): string | null {
  const cleaned = raw.replace(/[`*\s]/g, '').toLowerCase();
  const m = cleaned.match(/^(?:sha256:)?([a-f0-9]{64})$/);
  return m ? m[1] : null;
}

function gitStatusFile(repoRoot: string, file: string): string {
  return execSync(`git status --porcelain -- "${file}"`, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}

function gitLastCommitSha(repoRoot: string, file: string): string {
  return execSync(`git log -n 1 --format=%H -- "${file}"`, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}

function gitBlobSha(repoRoot: string, file: string): string {
  return execSync(`git hash-object "${file}"`, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}

function gitHead(repoRoot: string): string {
  return execSync(`git rev-parse HEAD`, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}

/**
 * Files changed between two commits as git-relative paths, or null if the
 * ancestor relation doesn't hold (from is not a committish reachable from to).
 */
function gitDiffFilesSince(repoRoot: string, from: string, to: string): string[] | null {
  try {
    execSync(`git merge-base --is-ancestor "${from}" "${to}"`, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  const raw = execSync(`git diff --name-only "${from}" "${to}"`, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

// Paths allowed to differ between the runner-time HEAD and the seal-time HEAD.
// The seal refuses if anything outside this set changed — that indicates the
// evaluated code itself may have moved since the row was produced.
// `docs/` covers audit-row appends and sealed markdown. `.handoff/` covers
// operator pre-reg edits. `data/` is gitignored so shouldn't appear in a
// committed diff, but listed for completeness.
function isAuditOnlyPath(p: string): boolean {
  return p.startsWith('docs/') || p.startsWith('.handoff/') || p.startsWith('data/');
}

/**
 * Verify the audit-row JSONL file has an append-only history: every commit
 * that touched the file produced content that is a PREFIX of the next
 * committed content. Rewriting, reordering, or prepending lines violates
 * this and makes the seal refuse.
 *
 * Closes Codex round-3 F1: without this check, a committer could rewrite
 * the JSONL in a docs-only commit (which the ancestor-audit-only-diff check
 * allows) and seal a forged "first matching" row.
 */
function verifyAppendOnlyHistory(repoRoot: string, relPath: string): { ok: true } | { ok: false; reason: string } {
  let log: string;
  try {
    log = execSync(`git log --reverse --format=%H -- "${relPath}"`, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    return { ok: false, reason: `git log failed for ${relPath}: ${(err as Error).message}` };
  }
  const commits = log.split('\n').map(s => s.trim()).filter(Boolean);
  if (commits.length === 0) {
    return { ok: false, reason: `${relPath} has no git history.` };
  }
  let prev = '';
  for (const c of commits) {
    let contentAtCommit: string;
    try {
      contentAtCommit = execSync(`git show ${c}:${relPath}`, {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
    } catch (err) {
      return { ok: false, reason: `git show ${c}:${relPath} failed: ${(err as Error).message}` };
    }
    if (!contentAtCommit.startsWith(prev)) {
      return {
        ok: false,
        reason: `Audit-row file ${relPath} was rewritten/reordered/shortened at commit ${c.slice(0, 10)}. ` +
          `Expected the file history to be strictly append-only.`,
      };
    }
    prev = contentAtCommit;
  }
  return { ok: true };
}

export function sealHoldout(args: SealArgs): SealOutcome {
  const now = args.now ?? new Date();

  // 1. Validate + match pre-reg block.
  const outcome = validatePreRegOrBypass({ repoRoot: args.repoRoot });
  if (!outcome.ok) {
    return { ok: false, reason: `Pre-reg validation failed: ${outcome.reason}`, hint: outcome.hint };
  }
  if (outcome.bypassed) {
    return {
      ok: false,
      reason: 'A seal cannot be produced with AUTORESEARCH_PREREG_BYPASS set. The seal ceremony requires a committed Pre-Registration block.',
      hint: 'Unset AUTORESEARCH_PREREG_BYPASS, ensure .handoff/current.md has a Pre-Registration section, commit it, retry.',
    };
  }
  if (outcome.block.blockHash !== args.preRegHash) {
    return {
      ok: false,
      reason: `Pre-reg block-hash mismatch. .handoff/current.md block hashes to ${outcome.block.blockHash}, but --prereg-hash passed ${args.preRegHash}.`,
      hint: 'Re-compute the block hash (sha256 of the extracted Pre-Registration block), or update current.md and re-commit.',
    };
  }

  // 2. Strategy file must exist, be tracked, and have no uncommitted edits.
  const strategyAbsPath = path.resolve(args.repoRoot, args.strategyPath);
  if (!fs.existsSync(strategyAbsPath)) {
    return { ok: false, reason: `Strategy file does not exist: ${args.strategyPath}` };
  }
  let currentStrategyGitSha = '';
  let currentStrategyBlobSha = '';
  try {
    const stat = gitStatusFile(args.repoRoot, args.strategyPath);
    if (stat.length > 0) {
      return {
        ok: false,
        reason: `Strategy file has uncommitted changes: ${args.strategyPath} (${stat.split('\n')[0]})`,
        hint: `git add "${args.strategyPath}" && git commit -m "<candidate name>"`,
      };
    }
    currentStrategyGitSha = gitLastCommitSha(args.repoRoot, args.strategyPath);
    if (!currentStrategyGitSha) {
      return {
        ok: false,
        reason: `Strategy file is not tracked by git: ${args.strategyPath}`,
        hint: `git add "${args.strategyPath}" && git commit -m "<candidate name>"`,
      };
    }
    currentStrategyBlobSha = gitBlobSha(args.repoRoot, args.strategyPath);
  } catch (err) {
    return { ok: false, reason: `git check failed on strategy file: ${(err as Error).message}` };
  }

  // 3. Whole-repo HEAD — used to match row.repoGitSha. We do NOT require the
  //    working tree to be fully clean at seal time (the runner did that at
  //    row-write time). But HEAD must exist.
  let currentRepoHead = '';
  try {
    currentRepoHead = gitHead(args.repoRoot);
    if (!currentRepoHead) {
      return { ok: false, reason: `git rev-parse HEAD returned empty — no commits in this repo?` };
    }
  } catch (err) {
    return { ok: false, reason: `git rev-parse HEAD failed: ${(err as Error).message}` };
  }

  // 4. One-seal-per-block check.
  const hashPrefix = args.preRegHash.slice(0, 12);
  const sealsDir = path.resolve(args.repoRoot, 'docs/holdout-evaluations');
  fs.mkdirSync(sealsDir, { recursive: true });
  const existingSeal = fs
    .readdirSync(sealsDir)
    .filter(f => f.endsWith('.md') && f.includes(hashPrefix));
  if (existingSeal.length > 0) {
    return {
      ok: false,
      reason: `A seal already exists for this Pre-Registration block: ${existingSeal[0]}`,
      hint: 'One seal per block is enforced. Write a new Pre-Registration block (with a new hash) before sealing a revised candidate.',
    };
  }

  // 5. Load the committed per-block audit-row JSONL file.
  const rowRelPath = `docs/audit-rows/${args.preRegHash}.jsonl`;
  const rowAbsPath = path.resolve(args.repoRoot, rowRelPath);
  if (!fs.existsSync(rowAbsPath)) {
    return {
      ok: false,
      reason: `Audit-row file not found: ${rowRelPath}`,
      hint: 'Run the runner against the committed strategy + pre-reg block. That produces (or appends to) the per-block audit-row file.',
    };
  }
  let auditRowGitSha = '';
  try {
    const rowStat = gitStatusFile(args.repoRoot, rowRelPath);
    if (rowStat.length > 0) {
      return {
        ok: false,
        reason: `Audit-row file has uncommitted changes: ${rowRelPath} (${rowStat.split('\n')[0]})`,
        hint: `git add "${rowRelPath}" && git commit -m "audit: <candidate>"`,
      };
    }
    auditRowGitSha = gitLastCommitSha(args.repoRoot, rowRelPath);
    if (!auditRowGitSha) {
      return {
        ok: false,
        reason: `Audit-row file is not tracked by git: ${rowRelPath}`,
        hint: `git add "${rowRelPath}" && git commit -m "audit: <candidate>"`,
      };
    }
  } catch (err) {
    return { ok: false, reason: `git check failed on audit-row file: ${(err as Error).message}` };
  }

  // 6. Append-only history check. Prevents a committer from rewriting the
  //    JSONL in a docs-only commit to insert/reorder rows. Codex round-3 F1.
  const appendOnly = verifyAppendOnlyHistory(args.repoRoot, rowRelPath);
  if (!appendOnly.ok) {
    return { ok: false, reason: appendOnly.reason, hint: 'The audit trail must be strictly append-only. If you need to correct a bad row, add a new Pre-Registration block and seal fresh.' };
  }

  // 7. Parse all JSONL lines; filter; pick the FIRST match.
  //    First-match rather than last-match: deliberate. The operator must not
  //    rerun-until-favorable and then seal the newer row — the FIRST row
  //    produced under a given (strategy blob, repo HEAD, variant name) is
  //    the verdict. Later identical runs are diagnostic replays.
  const raw = fs.readFileSync(rowAbsPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const rows: Array<{ idx: number; row: RunResult }> = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      rows.push({ idx: i, row: JSON.parse(lines[i]) as RunResult });
    } catch (err) {
      return { ok: false, reason: `Audit-row file line ${i + 1} is not valid JSON: ${(err as Error).message}` };
    }
  }
  if (rows.length === 0) {
    return { ok: false, reason: `Audit-row file is empty: ${rowRelPath}` };
  }

  // Filter on fields that uniquely identify the evaluated code:
  // strategyName + strategyBlobSha + preRegBlockHash + has-manifest-hash
  // (excluding pre-0.b.6 rows which lack the field). The repoGitSha is
  // verified separately via ancestor-with-audit-only-diff, because
  // committing the audit-row file itself advances HEAD.
  //
  // Pre-0.b.6 rows (datasetManifestHash == null) are deliberately skipped
  // rather than rejected-as-first-match. Codex round-1 F2 (Phase 0.b.6):
  // a stale null-hash first row would otherwise make any downstream run
  // permanently unsealable under the same pre-reg/blob identity.
  const baseMatches = rows.filter(({ row }) =>
    row.strategyName === args.strategyName
    && row.strategyBlobSha === currentStrategyBlobSha
    && row.preRegBlockHash === args.preRegHash,
  );
  const matches = baseMatches.filter(({ row }) => row.datasetManifestHash != null);
  if (matches.length === 0) {
    // Distinguish "no identity match at all" from "only pre-0.b.6 rows matched".
    if (baseMatches.length > 0) {
      return {
        ok: false,
        reason: `All ${baseMatches.length} row(s) matching strategyName="${args.strategyName}" + current strategy blob + preRegBlockHash were produced before Phase 0.b.6 (no datasetManifestHash). Re-run the runner to append a row stamped with the current manifest.`,
        hint: 'Pre-0.b.6 rows cannot be sealed. Run the runner once more under the current code to append a properly-stamped row, then seal.',
      };
    }
    const byName = rows.filter(r => r.row.strategyName === args.strategyName);
    if (byName.length === 0) {
      return {
        ok: false,
        reason: `No audit row with strategyName "${args.strategyName}" in ${rowRelPath}.`,
        hint: 'Check that --strategy-name matches the exported `name` field of the strategy evaluated.',
      };
    }
    const byBlob = byName.filter(r => r.row.strategyBlobSha === currentStrategyBlobSha);
    if (byBlob.length === 0) {
      return {
        ok: false,
        reason: `No audit row matches the current strategy blob ${currentStrategyBlobSha.slice(0, 10)} — ` +
          `the strategy file has changed since the last committed run (most recent row blob: ` +
          `${String(byName[byName.length - 1].row.strategyBlobSha).slice(0, 10)}).`,
        hint: 'Re-run the runner against the current strategy, then commit the new audit-row line before sealing.',
      };
    }
    return { ok: false, reason: `No audit row matches all identity fields; diagnostics exhausted.` };
  }

  const chosen = matches[0]; // first-match, not last-match (see comment above)
  const row = chosen.row;

  // 7. Verify repoGitSha: the row's recorded HEAD must be an ancestor of the
  //    current HEAD with no non-audit changes in between. This closes Codex
  //    round-2 F1 (imported helpers changing silently) while tolerating the
  //    expected audit-row commit that happens between runner and seal.
  if (!row.repoGitSha) {
    return {
      ok: false,
      reason: `Audit row has no repoGitSha — the working tree was dirty at run time, which makes the row unsealable.`,
      hint: 'Commit everything (or stash unrelated edits), then re-run the runner.',
    };
  }
  if (row.repoGitSha !== currentRepoHead) {
    const diff = gitDiffFilesSince(args.repoRoot, row.repoGitSha, currentRepoHead);
    if (diff === null) {
      return {
        ok: false,
        reason: `Audit row's repoGitSha ${row.repoGitSha.slice(0, 10)} is not an ancestor of current HEAD ${currentRepoHead.slice(0, 10)}. ` +
          `Likely a branch switch or rebase.`,
      };
    }
    const disallowed = diff.filter(p => !isAuditOnlyPath(p));
    if (disallowed.length > 0) {
      return {
        ok: false,
        reason: `Files outside the audit trail changed between runner-time HEAD (${row.repoGitSha.slice(0, 10)}) and seal-time HEAD (${currentRepoHead.slice(0, 10)}): ` +
          `${disallowed.slice(0, 5).join(', ')}${disallowed.length > 5 ? `, +${disallowed.length - 5} more` : ''}. ` +
          `Re-run the runner so the row reflects the current repo state.`,
        hint: 'Only changes under docs/, .handoff/, or data/ are tolerated between runner and seal.',
      };
    }
  }

  // 8. Additional content checks against the matched row.
  if (row.holdoutEvaluated !== true) {
    return {
      ok: false,
      reason: `Audit row was produced without a real holdout evaluation (holdoutEvaluated=${row.holdoutEvaluated}). Likely the runner ran with AUTORESEARCH_SKIP_HOLDOUT=1.`,
      hint: 'Re-run the runner WITHOUT AUTORESEARCH_SKIP_HOLDOUT to produce a sealable row, then commit the new line.',
    };
  }
  if (!row.strategyGitSha) {
    return {
      ok: false,
      reason: `Audit row has no strategyGitSha — likely the strategy file was dirty or untracked at run time.`,
    };
  }
  if (row.strategyGitSha !== currentStrategyGitSha) {
    return {
      ok: false,
      reason: `Audit row was produced from strategy commit ${row.strategyGitSha.slice(0, 10)} but the current strategy file is at ${currentStrategyGitSha.slice(0, 10)}. Re-run the runner.`,
    };
  }

  // Phase 0.b.6 content check: the row must have been produced against the
  // same dataset manifest currently committed. Mismatches mean the operator
  // changed dates/range after the row was produced.
  let currentManifestHash = '';
  try {
    currentManifestHash = loadDatasetManifest({ repoRoot: args.repoRoot }).rawHash;
  } catch (err) {
    return { ok: false, reason: `Dataset manifest load failed: ${(err as Error).message}` };
  }
  if (!row.datasetManifestHash) {
    return {
      ok: false,
      reason: `Audit row has no datasetManifestHash — the runner that produced it predates Phase 0.b.6 binding.`,
      hint: 'Re-run the runner so the row is stamped with the current manifest hash.',
    };
  }
  if (row.datasetManifestHash !== currentManifestHash) {
    return {
      ok: false,
      reason: `Audit row was produced against dataset manifest ${row.datasetManifestHash.slice(0, 10)} but the current manifest is ${currentManifestHash.slice(0, 10)}. ` +
        `The manifest changed after the row was produced — re-run the runner against the current manifest.`,
    };
  }

  // 8. Compose and write the seal.
  const passes = Boolean(row.passesHoldoutAndIR);
  const utcDate = now.toISOString().slice(0, 10);
  const sealFilename = `${utcDate}-${hashPrefix}.md`;
  const sealPath = path.join(sealsDir, sealFilename);
  const md = buildSealMarkdown({
    timestampIso: now.toISOString(),
    strategyName: args.strategyName,
    strategyPath: args.strategyPath,
    strategyGitSha: currentStrategyGitSha,
    strategyBlobSha: currentStrategyBlobSha,
    rowRepoGitSha: String(row.repoGitSha),
    sealRepoHead: currentRepoHead,
    auditRowRelPath: rowRelPath,
    auditRowGitSha,
    rowIndex: chosen.idx,
    preRegBlockHash: args.preRegHash,
    preRegGitSha: outcome.gitSha,
    adoptionThresholdText: outcome.block.adoptionThreshold,
    hypothesisText: outcome.block.hypothesis,
    decisionRuleText: outcome.block.decisionRule,
    holdoutWindowHash: outcome.block.holdoutWindowHash,
    row,
    passes,
  });
  try {
    fs.writeFileSync(sealPath, md, { flag: 'wx' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') {
      return {
        ok: false,
        reason: `Seal file already exists at ${path.relative(args.repoRoot, sealPath)} (likely a race with another sealer).`,
      };
    }
    return { ok: false, reason: `Failed to write seal file: ${e.message}` };
  }

  return {
    ok: true,
    sealPath,
    passes,
    row,
    strategyGitSha: currentStrategyGitSha,
    strategyBlobSha: currentStrategyBlobSha,
    rowRepoGitSha: String(row.repoGitSha),
    sealRepoHead: currentRepoHead,
    preRegGitSha: outcome.gitSha,
    auditRowGitSha,
    rowIndex: chosen.idx,
  };
}

function fmtOrNA(v: number | undefined | null, digits = 3): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

function buildSealMarkdown(opts: {
  timestampIso: string;
  strategyName: string;
  strategyPath: string;
  strategyGitSha: string;
  strategyBlobSha: string;
  rowRepoGitSha: string;
  sealRepoHead: string;
  auditRowRelPath: string;
  auditRowGitSha: string;
  rowIndex: number;
  preRegBlockHash: string;
  preRegGitSha: string | null;
  adoptionThresholdText: string;
  hypothesisText: string;
  decisionRuleText: string;
  holdoutWindowHash: string;
  row: RunResult;
  passes: boolean;
}): string {
  const r = opts.row;
  const verdict = opts.passes ? 'PASS' : 'FAIL';
  return `# Holdout Seal — ${opts.strategyName}

**Verdict:** ${verdict} (\`passesHoldoutAndIR = ${opts.passes}\`)
**Sealed at:** ${opts.timestampIso}
**Pre-reg block hash:** \`${opts.preRegBlockHash}\`
**Pre-reg commit (\`.handoff/current.md\`):** \`${opts.preRegGitSha ?? 'n/a'}\`
**Strategy file:** \`${opts.strategyPath}\`
**Strategy commit:** \`${opts.strategyGitSha}\`
**Strategy blob:** \`${opts.strategyBlobSha}\`
**Runner-time repo HEAD (what was evaluated):** \`${opts.rowRepoGitSha}\`
**Seal-time repo HEAD (usually runner HEAD + audit-row commit):** \`${opts.sealRepoHead}\`
**Audit row:** \`${opts.auditRowRelPath}\` line ${opts.rowIndex + 1} (commit \`${opts.auditRowGitSha}\`)
**Holdout window hash:** \`${opts.holdoutWindowHash}\`

## Pre-Registration (at time of seal)

**Hypothesis:** ${opts.hypothesisText.replace(/\s+/g, ' ').trim()}

**Decision rule:** ${opts.decisionRuleText.replace(/\s+/g, ' ').trim()}

**Adoption threshold:** ${opts.adoptionThresholdText.replace(/\s+/g, ' ').trim()}

## Holdout metrics

| Field | Value |
|---|---|
| holdoutSharpe | ${fmtOrNA(r.holdoutSharpe)} |
| holdoutSpyIR | ${fmtOrNA(r.holdoutSpyIR)} |
| holdoutSpyExcessReturn | ${fmtOrNA(r.holdoutSpyExcessReturn)} |
| holdoutOOSRatio | ${fmtOrNA(r.holdoutOOSRatio)} |
| holdoutTrades | ${r.holdoutTrades ?? 'n/a'} |
| newHoldoutTrades | ${r.newHoldoutTrades ?? 'n/a'} |
| carriedHoldoutTrades | ${r.carriedHoldoutTrades ?? 'n/a'} |
| passesHoldout | ${r.passesHoldout} |
| passesHoldoutIRFloor | ${r.passesHoldoutIRFloor ?? 'n/a'} |
| passesHoldoutAndIR | ${r.passesHoldoutAndIR ?? 'n/a'} |
| passesHoldoutNewEntries | ${r.passesHoldoutNewEntries ?? 'n/a'} |
| isValid (search + holdout) | ${r.isValid} |
| holdoutEvaluated | ${r.holdoutEvaluated} |

## Selection-period context (for reference only)

| Field | Value |
|---|---|
| oosSharpe | ${fmtOrNA(r.oosSharpe)} |
| oosSpyIR | ${fmtOrNA(r.oosSpyIR)} |
| oosMaxDD | ${fmtOrNA(r.oosMaxDD)} |
| oosTrades | ${r.oosTrades} |
| deflatedSharpe | ${fmtOrNA(r.deflatedSharpe)} |
| attemptNumber | ${r.attemptNumber ?? 'n/a'} |

## Adoption-gate provenance

| Field | Value |
|---|---|
| adoptionGatesRawHash | \`${r.adoptionGatesRawHash ?? 'n/a'}\` |
| adoptionGatesEffectiveHash | \`${r.adoptionGatesEffectiveHash ?? 'n/a'}\` |
| adoptionGatesOverrides | ${r.adoptionGatesOverrides && r.adoptionGatesOverrides.length > 0 ? r.adoptionGatesOverrides.map(o => `${o.envVar}=${o.value} (${o.target})`).join(', ') : 'none'} |

## Known limitations at time of seal

- The holdout window has been iterated against by prior runs; see \`docs/sealed-holdout.md\` "Known limitations."
- \`preRegHoldoutWindowHash\` is format-only; semantic binding to dates deferred to Phase 0.b.6.

---
*Generated by \`scripts/evaluate-holdout.ts\` (Phase 0.a.5).*
`;
}
