/**
 * Regression tests for the Phase 0.a.5 seal ceremony (Codex round-2 hardening).
 *
 * The ceremony reads an APPEND-ONLY docs/audit-rows/<preRegBlockHash>.jsonl,
 * filters rows by (strategyName, strategyBlobSha, repoGitSha), and takes the
 * FIRST match. It enforces strong chain of custody:
 *   - pre-reg block committed + hash matches --prereg-hash
 *   - strategy file committed + tracked
 *   - audit-row file committed + tracked
 *   - row.strategyBlobSha === current strategy blob
 *   - row.repoGitSha === current repo HEAD
 *   - row.strategyGitSha === strategy file's last-touch commit
 *   - row.holdoutEvaluated === true
 *   - no prior seal for this block hash
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealHoldout, normalizeBlockHashArg } from '../scripts/autoresearch/lib/seal-holdout';

const STRATEGY_REL = 'strategy.ts';
const HANDOFF_REL = '.handoff/current.md';
const VALID_HASH = 'sha256:' + 'a'.repeat(64);

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function initRepo(root: string): void {
  fs.mkdirSync(path.join(root, '.handoff'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs/audit-rows'), { recursive: true });
  sh('git init -q -b main', root);
  sh('git config user.email "test@example.com"', root);
  sh('git config user.name "Test"', root);
  sh('git config commit.gpgsign false', root);
}

function buildPreRegMarkdown(): string {
  return [
    '---',
    'task: test seal',
    'stage: building',
    'owner: claude',
    'from: human',
    'timestamp: 2026-04-19T00:00:00Z',
    '---',
    '',
    '## Pre-Registration',
    '',
    '**Hypothesis**: Candidate beats holdout gate.',
    '**Config Grid**: delta 0.30, DTE 5.',
    '**Decision Rule**: Adopt if holdout passes.',
    '**Adoption Threshold**: holdoutSharpe >= 0.3 AND holdout SPY IR >= 0.',
    `**Holdout Window Hash**: ${VALID_HASH}`,
    '**Declared Env Overrides**: none',
    '',
  ].join('\n');
}

function writePreRegCommitted(root: string): void {
  fs.writeFileSync(path.join(root, HANDOFF_REL), buildPreRegMarkdown());
  sh('git add .handoff/current.md', root);
  sh('git commit -q -m "pre-reg"', root);
}

function writeStrategyCommitted(root: string, body = `export default { name: 'seal-test-strategy' };\n`): { sha: string; blob: string; head: string } {
  fs.writeFileSync(path.join(root, STRATEGY_REL), body);
  sh('git add strategy.ts', root);
  sh('git commit -q -m "strategy"', root);
  return {
    sha: sh('git log -n 1 --format=%H -- strategy.ts', root),
    blob: sh('git hash-object strategy.ts', root),
    head: sh('git rev-parse HEAD', root),
  };
}

function extractBlockHash(root: string): string {
  const md = fs.readFileSync(path.join(root, HANDOFF_REL), 'utf-8');
  const blockMatch = md.match(/##+\s*Pre-?Registration\b[\s\S]*?(?=\n##+\s+|\n---\s*\n|$)/i);
  if (!blockMatch) throw new Error('test helper: no pre-reg block');
  return crypto.createHash('sha256').update(blockMatch[0]).digest('hex');
}

interface RowOverrides {
  strategyName?: string;
  preRegBlockHash?: string;
  strategyGitSha?: string | null;
  strategyBlobSha?: string | null;
  repoGitSha?: string | null;
  holdoutEvaluated?: boolean;
  passesHoldoutAndIR?: boolean;
  passesHoldoutIRFloor?: boolean;
  isValid?: boolean;
  holdoutSharpe?: number;
}

function buildRow(opts: RowOverrides & { strategyName: string; preRegBlockHash: string }) {
  return {
    strategyName: opts.strategyName,
    timestamp: new Date().toISOString(),
    oosSharpe: 1.0,
    oosMaxDD: 0.1,
    oosWinRate: 0.6,
    oosTrades: 50,
    oosTotalPnl: 1000,
    combinedSharpe: 1.2,
    correlationWithDTE5: 0.1,
    combinedMaxDD: 0.1,
    holdoutSharpe: opts.holdoutSharpe ?? 0.5,
    holdoutTrades: 20,
    newHoldoutTrades: 20,
    carriedHoldoutTrades: 0,
    passesHoldoutNewEntries: true,
    oosSpyIR: 0.2,
    oosSpyExcessReturn: 0.05,
    holdoutSpyIR: 0.1,
    holdoutSpyExcessReturn: 0.03,
    avgTrainSharpe: 1.0,
    wfEfficiency: 0.9,
    passesMinTrades: true,
    passesMaxDD: true,
    passesWFA: true,
    passesHoldout: true,
    passesHoldoutOrIR: true,
    passesHoldoutIRFloor: opts.passesHoldoutIRFloor ?? true,
    passesHoldoutAndIR: opts.passesHoldoutAndIR ?? true,
    passesSanity: true,
    isValidForSearch: true,
    isValid: opts.isValid ?? true,
    holdoutOOSRatio: 0.5,
    bootstrapSharpe95CI: [0.2, 1.5],
    bootstrapSignificant: true,
    attemptNumber: 1,
    deflatedSharpe: 0.8,
    preRegBypassed: false,
    preRegBlockHash: opts.preRegBlockHash,
    preRegGitSha: 'deadbeef0000',
    preRegHoldoutWindowHash: VALID_HASH,
    adoptionGatesRawHash: 'sha256:gate',
    adoptionGatesEffectiveHash: 'sha256:gate',
    adoptionGatesOverrides: [],
    strategyGitSha: opts.strategyGitSha,
    strategyBlobSha: opts.strategyBlobSha,
    repoGitSha: opts.repoGitSha,
    holdoutEvaluated: opts.holdoutEvaluated ?? true,
    exitTypeBreakdown: {},
    signalsGenerated: 100,
    signalsSkippedNoChain: 0,
    elapsedMs: 1000,
  };
}

function appendAuditLine(root: string, blockHash: string, row: object): void {
  const rel = `docs/audit-rows/${blockHash}.jsonl`;
  fs.appendFileSync(path.join(root, rel), JSON.stringify(row) + '\n');
}

function commitAuditRow(root: string, blockHash: string, rowArgs: RowOverrides & { strategyGitSha: string | null; strategyBlobSha: string | null; repoGitSha: string | null }): void {
  const row = buildRow({
    strategyName: rowArgs.strategyName ?? 'seal-test-strategy',
    preRegBlockHash: rowArgs.preRegBlockHash ?? blockHash,
    ...rowArgs,
  });
  appendAuditLine(root, blockHash, row);
  const rel = `docs/audit-rows/${blockHash}.jsonl`;
  sh(`git add "${rel}"`, root);
  sh('git commit -q -m "audit"', root);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('normalizeBlockHashArg', () => {
  it('accepts sha256-prefixed 64-hex', () => {
    expect(normalizeBlockHashArg('sha256:' + 'f'.repeat(64))).toBe('f'.repeat(64));
  });
  it('accepts bare 64-hex', () => {
    expect(normalizeBlockHashArg('a'.repeat(64))).toBe('a'.repeat(64));
  });
  it('lowercases', () => {
    expect(normalizeBlockHashArg('SHA256:' + 'A'.repeat(64))).toBe('a'.repeat(64));
  });
  it('rejects short', () => {
    expect(normalizeBlockHashArg('deadbeef')).toBeNull();
  });
  it('rejects non-hex', () => {
    expect(normalizeBlockHashArg('z'.repeat(64))).toBeNull();
  });
});

describe('sealHoldout (JSONL + strong identity)', () => {
  let tmpRoot: string;
  let blockHash: string;
  let strategy: { sha: string; blob: string; head: string };

  // Base setup: committed pre-reg + committed strategy + empty repo (no
  // audit row yet). Each test commits the rows it needs. This keeps the
  // append-only history clean — no test truncates or rewrites.
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-'));
    initRepo(tmpRoot);
    writePreRegCommitted(tmpRoot);
    blockHash = extractBlockHash(tmpRoot);
    strategy = writeStrategyCommitted(tmpRoot);
  });

  /** Shortcut: commit the default PASS row for tests that expect one. */
  function commitDefaultPassRow(): void {
    commitAuditRow(tmpRoot, blockHash, {
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
    });
  }

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AUTORESEARCH_PREREG_BYPASS;
  });

  it('happy path: writes a PASS seal when all identity fields match', () => {
    commitDefaultPassRow();
    const out = sealHoldout({
      repoRoot: tmpRoot,
      strategyPath: STRATEGY_REL,
      strategyName: 'seal-test-strategy',
      preRegHash: blockHash,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.passes).toBe(true);
      const md = fs.readFileSync(out.sealPath, 'utf-8');
      expect(md).toMatch(/Verdict:\*\* PASS/);
      expect(md).toContain(strategy.blob);
      expect(md).toContain(strategy.head);
      expect(md).toContain(blockHash);
    }
  });

  it('refuses when --prereg-hash does not match the block', () => {
    commitDefaultPassRow();
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: 'f'.repeat(64) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/block-hash mismatch/i);
  });

  it('refuses when .handoff/current.md is uncommitted', () => {
    commitDefaultPassRow();
    const p = path.join(tmpRoot, HANDOFF_REL);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf-8').replace('stage: building', 'stage: edited'));
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/uncommitted/i);
  });

  it('refuses when the strategy file has uncommitted changes', () => {
    commitDefaultPassRow();
    fs.appendFileSync(path.join(tmpRoot, STRATEGY_REL), '\n// dirty\n');
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/uncommitted changes/i);
  });

  it('refuses when the audit-row file is missing', () => {
    // No audit row ever committed — the file simply does not exist.
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/audit-row file not found/i);
  });

  it('refuses when the audit-row file has uncommitted changes', () => {
    commitDefaultPassRow();
    fs.appendFileSync(path.join(tmpRoot, `docs/audit-rows/${blockHash}.jsonl`), '{"fake": true}\n');
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/audit-row file has uncommitted/i);
  });

  it('refuses when the audit-row file is untracked', () => {
    commitDefaultPassRow();
    const rel = `docs/audit-rows/${blockHash}.jsonl`;
    sh(`git rm --cached -q "${rel}"`, tmpRoot);
    sh('git commit -q -m "untrack"', tmpRoot);
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/uncommitted|not tracked/i);
  });

  it('refuses when no row matches strategyName', () => {
    // Append a row with a different name, commit.
    commitAuditRow(tmpRoot, blockHash, {
      strategyName: 'different',
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
    });
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'not-found', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/No audit row with strategyName/i);
  });

  it('refuses when no row matches the current strategyBlobSha (strategy file changed)', () => {
    commitDefaultPassRow();
    // Change strategy file content, re-commit.
    fs.writeFileSync(path.join(tmpRoot, STRATEGY_REL), `export default { name: 'seal-test-strategy' /* v2 */ };\n`);
    sh('git add strategy.ts', tmpRoot);
    sh('git commit -q -m "strategy v2"', tmpRoot);
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/strategy blob|strategy file has changed/i);
  });

  it('refuses when non-audit files changed between runner-time HEAD and seal-time HEAD', () => {
    commitDefaultPassRow();
    fs.writeFileSync(path.join(tmpRoot, 'unrelated.md'), 'hello');
    sh('git add unrelated.md', tmpRoot);
    sh('git commit -q -m "unrelated"', tmpRoot);
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/outside the audit trail/i);
  });

  it('allows the seal when only docs/ files changed between runner-time HEAD and seal-time HEAD', () => {
    commitDefaultPassRow();
    fs.writeFileSync(path.join(tmpRoot, 'docs/some-note.md'), 'operator note');
    sh('git add docs/some-note.md', tmpRoot);
    sh('git commit -q -m "note"', tmpRoot);
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(true);
  });

  it('refuses when the only committed row has holdoutEvaluated=false (skip-holdout mode)', () => {
    // Commit a single row with holdoutEvaluated=false, nothing else.
    commitAuditRow(tmpRoot, blockHash, {
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
      holdoutEvaluated: false,
    });
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/holdoutEvaluated/i);
  });

  it('takes the FIRST matching row, not the last (prevents rerun-until-favorable)', () => {
    commitDefaultPassRow();
    // Append a SECOND row with the same identity triple but passesHoldoutAndIR=false.
    commitAuditRow(tmpRoot, blockHash, {
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
      passesHoldoutAndIR: false,
      passesHoldoutIRFloor: false,
      isValid: false,
    });
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.passes).toBe(true); // first row (PASS), not second (FAIL)
      expect(out.rowIndex).toBe(0);
    }
  });

  it('refuses a second seal for the same block hash', () => {
    commitDefaultPassRow();
    const first = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(first.ok).toBe(true);
    const second = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/seal already exists/i);
  });

  it('writes FAIL when the only committed row is a FAIL', () => {
    commitAuditRow(tmpRoot, blockHash, {
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
      passesHoldoutAndIR: false,
      passesHoldoutIRFloor: false,
      isValid: false,
    });
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.passes).toBe(false);
      const md = fs.readFileSync(out.sealPath, 'utf-8');
      expect(md).toMatch(/Verdict:\*\* FAIL/);
    }
  });

  it('refuses when the only committed row has strategyGitSha null (dirty strategy at run time)', () => {
    commitAuditRow(tmpRoot, blockHash, {
      strategyGitSha: null,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
    });
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    // Row matches the identity filter (name+blob+preReg); the strategyGitSha
    // check is a separate content check that fails because null !== currentSha.
    if (!out.ok) expect(out.reason).toMatch(/strategy commit|no strategyGitSha/i);
  });

  it('refuses when the only committed row has repoGitSha null (whole tree dirty at run time)', () => {
    commitAuditRow(tmpRoot, blockHash, {
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: null,
    });
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/repo HEAD|repoGitSha/i);
  });

  it('refuses when AUTORESEARCH_PREREG_BYPASS is set', () => {
    commitDefaultPassRow();
    process.env.AUTORESEARCH_PREREG_BYPASS = 'bypass-for-ceremony-test-reason';
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/bypass|cannot be produced/i);
  });

  it('refuses when the strategy file does not exist', () => {
    // Doesn't need an audit row — fails earlier.
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: 'missing/strategy.ts', strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/does not exist/i);
  });

  it('refuses on malformed JSONL line', () => {
    commitDefaultPassRow();
    const rel = `docs/audit-rows/${blockHash}.jsonl`;
    fs.appendFileSync(path.join(tmpRoot, rel), 'this is not json\n');
    sh(`git add "${rel}"`, tmpRoot);
    sh('git commit -q -m "bad line"', tmpRoot);
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/not valid JSON/i);
  });

  // Round-3 F1 regression tests.
  it('refuses when the audit-row file history is not append-only (prepend attack)', () => {
    commitDefaultPassRow();
    const rel = `docs/audit-rows/${blockHash}.jsonl`;
    const original = fs.readFileSync(path.join(tmpRoot, rel), 'utf-8');
    const forgedRow = buildRow({
      strategyName: 'seal-test-strategy',
      preRegBlockHash: blockHash,
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
      passesHoldoutAndIR: true,
      holdoutSharpe: 9.99,
    });
    // Prepend the forged row in a docs-only commit.
    fs.writeFileSync(path.join(tmpRoot, rel), JSON.stringify(forgedRow) + '\n' + original);
    sh(`git add "${rel}"`, tmpRoot);
    sh('git commit -q -m "docs: prepend forged row"', tmpRoot);
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/append-only|rewritten|reordered/i);
  });

  it('refuses when a later docs-only commit reorders lines in the JSONL', () => {
    commitDefaultPassRow();
    const rel = `docs/audit-rows/${blockHash}.jsonl`;
    // Append a second legit row first.
    commitAuditRow(tmpRoot, blockHash, {
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
      holdoutSharpe: 0.2,
    });
    // Reorder (swap lines 1 and 2) in a later docs-only commit.
    const content = fs.readFileSync(path.join(tmpRoot, rel), 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    fs.writeFileSync(path.join(tmpRoot, rel), lines[1] + '\n' + lines[0] + '\n');
    sh(`git add "${rel}"`, tmpRoot);
    sh('git commit -q -m "docs: reorder"', tmpRoot);
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/append-only|rewritten|reordered/i);
  });

  it('refuses when a later commit truncates the JSONL', () => {
    commitDefaultPassRow();
    const rel = `docs/audit-rows/${blockHash}.jsonl`;
    fs.writeFileSync(path.join(tmpRoot, rel), '');
    sh(`git add "${rel}"`, tmpRoot);
    sh('git commit -q -m "docs: truncate"', tmpRoot);
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/append-only|empty|rewritten/i);
  });

  // Round-3 F2 regression: markdown must label runner-time vs seal-time SHAs correctly.
  it('seal markdown records runner-time HEAD (row.repoGitSha), not seal-time HEAD', () => {
    commitDefaultPassRow();
    // row.repoGitSha was set to strategy.head (before audit-row commit).
    // After commitDefaultPassRow, current HEAD has advanced.
    const currentHead = sh('git rev-parse HEAD', tmpRoot);
    expect(currentHead).not.toBe(strategy.head); // sanity
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rowRepoGitSha).toBe(strategy.head);
      expect(out.sealRepoHead).toBe(currentHead);
      const md = fs.readFileSync(out.sealPath, 'utf-8');
      expect(md).toContain(`Runner-time repo HEAD`);
      expect(md).toContain(strategy.head);
      expect(md).toContain(`Seal-time repo HEAD`);
      expect(md).toContain(currentHead);
    }
  });

  it('refuses when the audit-row file is empty (all lines blank)', () => {
    // Commit an empty-ish file directly — append-only history is satisfied
    // (first-commit prefix of first-commit is trivially true).
    const rel = `docs/audit-rows/${blockHash}.jsonl`;
    fs.writeFileSync(path.join(tmpRoot, rel), '\n\n\n');
    sh(`git add "${rel}"`, tmpRoot);
    sh('git commit -q -m "empty"', tmpRoot);
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/empty/i);
  });
});
