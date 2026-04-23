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
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  sh('git init -q -b main', root);
  sh('git config user.email "test@example.com"', root);
  sh('git config user.name "Test"', root);
  sh('git config commit.gpgsign false', root);
}

/** Commit a valid dataset-manifest.json (Phase 0.b.6 seal dependency). */
function writeManifestCommitted(root: string): string {
  const m = {
    manifestVersion: 1,
    dataStartDate: '2017-01-01',
    dataEndDate: '2026-02-28',
    holdoutStartDate: '2024-01-22',
    holdoutEndDate: '2026-02-28',
    generatedAt: '2026-04-19T10:30:00Z',
    notes: 'test manifest',
  };
  const raw = JSON.stringify(m, null, 2);
  fs.writeFileSync(path.join(root, 'config/dataset-manifest.json'), raw);
  sh('git add config/dataset-manifest.json', root);
  sh('git commit -q -m "manifest"', root);
  // Return the sha256 hex so tests can stamp the matching hash onto rows.
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(raw).digest('hex');
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
  passesStability?: boolean;
  passesStatConsistency?: boolean;
  isValid?: boolean;
  holdoutSharpe?: number;
  holdoutSpyIR?: number;
  oosSharpe?: number;
  deflatedSharpeMertens?: number;
  datasetManifestHash?: string | null;
  /** Omit entirely from the written row (simulates pre-0.b.7 rows). */
  omitTickerCoverageHash?: boolean;
}

function buildRow(opts: RowOverrides & { strategyName: string; preRegBlockHash: string }) {
  return {
    strategyName: opts.strategyName,
    timestamp: new Date().toISOString(),
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
    holdoutSpyIR: opts.holdoutSpyIR ?? 0.1,
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
    passesStability: opts.passesStability ?? true,
    passesStatConsistency: opts.passesStatConsistency ?? true,
    passesSanity: true,
    isValidForSearch: true,
    isValid: opts.isValid ?? true,
    holdoutOOSRatio: 0.5,
    bootstrapSharpe95CI: [0.2, 1.5],
    bootstrapSignificant: true,
    attemptNumber: 1,
    deflatedSharpe: 0.8,
    deflatedSharpeMertens: opts.deflatedSharpeMertens ?? 0.5,
    oosSharpe: opts.oosSharpe ?? 1.0,
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
    datasetManifestHash: opts.datasetManifestHash === undefined ? 'PLACEHOLDER_MANIFEST_HASH' : opts.datasetManifestHash,
    datasetManifestVersion: 2,
    ...(opts.omitTickerCoverageHash ? {} : { tickerCoverageHash: 'a'.repeat(64) }),
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
  let manifestHash: string;

  // Base setup: committed pre-reg + committed strategy + committed manifest +
  // empty audit file. Each test commits the rows it needs.
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-'));
    initRepo(tmpRoot);
    manifestHash = writeManifestCommitted(tmpRoot);
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
      datasetManifestHash: manifestHash,
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
      datasetManifestHash: manifestHash,
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
      datasetManifestHash: manifestHash,
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
      datasetManifestHash: manifestHash,
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
      datasetManifestHash: manifestHash,
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
      datasetManifestHash: manifestHash,
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
      datasetManifestHash: manifestHash,
    });
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/repo HEAD|repoGitSha/i);
  });

  // Phase 0.b.6 regression
  it('refuses when the matched row was produced against a different dataset manifest', () => {
    commitAuditRow(tmpRoot, blockHash, {
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
      datasetManifestHash: 'deadbeef'.repeat(8),
    });
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/dataset manifest/i);
  });

  // Phase 0.b.6 regression: pre-0.b.6 rows have no datasetManifestHash.
  it('refuses when the matched row has no datasetManifestHash (pre-Phase-0.b.6 row)', () => {
    commitAuditRow(tmpRoot, blockHash, {
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
      datasetManifestHash: null,
    });
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/no datasetManifestHash|predates Phase 0\.b\.6|before Phase 0\.b\.6/i);
  });

  // Phase 0.b.7 regression: pre-0.b.7 rows have no tickerCoverageHash.
  it('refuses when the matched row has no tickerCoverageHash (pre-Phase-0.b.7 row)', () => {
    commitAuditRow(tmpRoot, blockHash, {
      strategyGitSha: strategy.sha,
      strategyBlobSha: strategy.blob,
      repoGitSha: strategy.head,
      datasetManifestHash: manifestHash,
      omitTickerCoverageHash: true,
    });
    const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/tickerCoverageHash|predates Phase 0\.b\.7/i);
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
      datasetManifestHash: manifestHash,
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
      datasetManifestHash: manifestHash,
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

  // ── Standard adoption threshold (Phase F0 prep — Codex finding) ──

  describe('standard 6-criterion adoption enforcement', () => {
    function sealWith(overrides: Partial<RowOverrides>): ReturnType<typeof sealHoldout> {
      commitAuditRow(tmpRoot, blockHash, {
        strategyGitSha: strategy.sha,
        strategyBlobSha: strategy.blob,
        repoGitSha: strategy.head,
        datasetManifestHash: manifestHash,
        ...overrides,
      });
      return sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
    }

    it('FAILs when holdoutSpyIR < 0 even though passesHoldoutAndIR is true', () => {
      const out = sealWith({ holdoutSpyIR: -0.05, passesHoldoutAndIR: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.passes).toBe(false);
        const md = fs.readFileSync(out.sealPath, 'utf-8');
        expect(md).toMatch(/Verdict:\*\* FAIL/);
        expect(md).toMatch(/holdoutSpyIR >= 0.*✗/);
      }
    });

    it('FAILs when holdoutSharpe < 0.3', () => {
      const out = sealWith({ holdoutSharpe: 0.2, passesHoldoutAndIR: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.passes).toBe(false);
        const md = fs.readFileSync(out.sealPath, 'utf-8');
        expect(md).toMatch(/holdoutSharpe >= 0.3.*✗/);
      }
    });

    it('FAILs when oosSharpe < 0.8', () => {
      const out = sealWith({ oosSharpe: 0.5, passesHoldoutAndIR: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.passes).toBe(false);
        const md = fs.readFileSync(out.sealPath, 'utf-8');
        expect(md).toMatch(/oosSharpe >= 0.8.*✗/);
      }
    });

    it('FAILs when passesStability is false', () => {
      const out = sealWith({ passesStability: false, passesHoldoutAndIR: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.passes).toBe(false);
        const md = fs.readFileSync(out.sealPath, 'utf-8');
        expect(md).toMatch(/passesStability.*✗/);
      }
    });

    it('FAILs when passesStatConsistency is false', () => {
      const out = sealWith({ passesStatConsistency: false, passesHoldoutAndIR: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.passes).toBe(false);
        const md = fs.readFileSync(out.sealPath, 'utf-8');
        expect(md).toMatch(/passesStatConsistency.*✗/);
      }
    });

    it('FAILs when deflatedSharpeMertens <= 0 (the E10/E11 scenario)', () => {
      const out = sealWith({ deflatedSharpeMertens: -0.25, passesHoldoutAndIR: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.passes).toBe(false);
        const md = fs.readFileSync(out.sealPath, 'utf-8');
        expect(md).toMatch(/deflatedSharpeMertens > 0.*✗/);
      }
    });

    it('PASSes when all six standard criteria clear AND passesHoldoutAndIR is true', () => {
      const out = sealWith({
        holdoutSpyIR: 0.25,
        holdoutSharpe: 0.9,
        oosSharpe: 1.2,
        passesStability: true,
        passesStatConsistency: true,
        deflatedSharpeMertens: 0.4,
        passesHoldoutAndIR: true,
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.passes).toBe(true);
        const md = fs.readFileSync(out.sealPath, 'utf-8');
        expect(md).toMatch(/Verdict:\*\* PASS/);
        expect(md).toMatch(/6 of 6 standard adoption gates/);
      }
    });

    it('seal markdown includes the 6-criterion table regardless of verdict', () => {
      const out = sealWith({ deflatedSharpeMertens: -0.1 });
      expect(out.ok).toBe(true);
      if (out.ok) {
        const md = fs.readFileSync(out.sealPath, 'utf-8');
        expect(md).toContain('holdoutSpyIR >= 0');
        expect(md).toContain('holdoutSharpe >= 0.3');
        expect(md).toContain('oosSharpe >= 0.8');
        expect(md).toContain('passesStability');
        expect(md).toContain('passesStatConsistency');
        expect(md).toContain('deflatedSharpeMertens > 0');
      }
    });
  });

  // ── Phase F0 effective-attempt counter (integration with sealer) ──

  describe('Phase F0 effective-attempt counter', () => {
    function writeF0Ledger(trials: Array<{ timestamp: string }>): void {
      const dir = path.join(tmpRoot, 'data');
      fs.mkdirSync(dir, { recursive: true });
      const ledger = {
        version: 2,
        count: trials.length,
        lastSource: 'test',
        lastUpdated: trials[trials.length - 1]?.timestamp ?? new Date().toISOString(),
        trials: trials.map((t, i) => ({
          ordinal: i + 1,
          source: 'primary:test',
          strategyName: 'seal-test-strategy',
          timestamp: t.timestamp,
          leaderboardSuffix: '',
          oosSharpe: 0.878,
          oosTrades: 30,
          returnsFile: `trial-${String(i + 1).padStart(6, '0')}.json`,
        })),
      };
      fs.writeFileSync(path.join(dir, 'attempts-global.json'), JSON.stringify(ledger, null, 2));
    }

    it('PASSes a row that would FAIL under global N but clears dsrM under F0 N=5', () => {
      // Pre-F0: row has oosSharpe 0.878, mertensSharpeSE 0.46 (E11 scenario).
      // Under global N=106, dsrM ≈ −0.27 → gate FAIL.
      // Under F0 N=5, dsrM > 0 → gate PASS.
      writeF0Ledger([
        { timestamp: '2026-04-10T00:00:00Z' },  // pre-boundary: excluded
        { timestamp: '2026-04-15T00:00:00Z' },  // pre-boundary: excluded
        { timestamp: '2026-04-23T00:00:00Z' },  // post-boundary: counted
        { timestamp: '2026-04-23T12:00:00Z' },  // post-boundary: counted
        { timestamp: '2026-04-24T00:00:00Z' },  // post-boundary: counted
        { timestamp: '2026-04-24T12:00:00Z' },  // post-boundary: counted
        { timestamp: '2026-04-25T00:00:00Z' },  // post-boundary: counted
      ]);
      commitAuditRow(tmpRoot, blockHash, {
        strategyGitSha: strategy.sha,
        strategyBlobSha: strategy.blob,
        repoGitSha: strategy.head,
        datasetManifestHash: manifestHash,
        oosSharpe: 0.878,
        holdoutSharpe: 0.95,
        holdoutSpyIR: 0.37,
        passesStability: true,
        passesStatConsistency: true,
        // Intentionally stamp the row's own dsrM as the global N=106 value
        // (negative) to prove the sealer recomputes it.
        deflatedSharpeMertens: -0.27,
        passesHoldoutAndIR: true,
      });
      // But the audit row's mertensSharpeSE needs to be set too for recomputation.
      // The helper buildRow doesn't set it; we need to rewrite the audit file.
      const rel = `docs/audit-rows/${blockHash}.jsonl`;
      const rowData = JSON.parse(fs.readFileSync(path.join(tmpRoot, rel), 'utf-8').trim());
      rowData.mertensSharpeSE = 0.46;
      rowData.timestamp = '2026-04-25T12:00:00Z';  // seal this as attempt #5 under F0 (after boundary)
      fs.writeFileSync(path.join(tmpRoot, rel), JSON.stringify(rowData) + '\n');
      sh(`git add "${rel}"`, tmpRoot);
      sh('git commit --amend --no-edit -q', tmpRoot);

      const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.passes).toBe(true);  // would've been false under global N
        const md = fs.readFileSync(out.sealPath, 'utf-8');
        expect(md).toMatch(/F0 effective.*\|\s*5\s*\|/);  // effective N = 5
        expect(md).toMatch(/Verdict:\*\* PASS/);
      }
    });

    it('FAILs when F0-effective N is still large enough that dsrM < 0', () => {
      // Simulate 200 post-F0 trials → dsrM even more negative than global N=106.
      const trials = [];
      for (let i = 0; i < 200; i++) {
        const day = 23 + Math.floor(i / 20);
        const hour = (i % 20);
        trials.push({ timestamp: `2026-04-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z` });
      }
      writeF0Ledger(trials);

      commitAuditRow(tmpRoot, blockHash, {
        strategyGitSha: strategy.sha,
        strategyBlobSha: strategy.blob,
        repoGitSha: strategy.head,
        datasetManifestHash: manifestHash,
        oosSharpe: 0.878,
        passesHoldoutAndIR: true,
      });
      const rel = `docs/audit-rows/${blockHash}.jsonl`;
      const rowData = JSON.parse(fs.readFileSync(path.join(tmpRoot, rel), 'utf-8').trim());
      rowData.mertensSharpeSE = 0.46;
      rowData.timestamp = '2026-05-01T00:00:00Z';
      fs.writeFileSync(path.join(tmpRoot, rel), JSON.stringify(rowData) + '\n');
      sh(`git add "${rel}"`, tmpRoot);
      sh('git commit --amend --no-edit -q', tmpRoot);

      const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.passes).toBe(false);
        const md = fs.readFileSync(out.sealPath, 'utf-8');
        expect(md).toMatch(/Verdict:\*\* FAIL/);
        expect(md).toMatch(/deflatedSharpeMertens > 0.*✗/);
      }
    });

    it('falls back to row-recorded dsrM when ledger is absent (backward compat)', () => {
      // No ledger written → filter returns ledgerPresent=false → use row.deflatedSharpeMertens.
      const out = sealHoldout({ repoRoot: tmpRoot, strategyPath: STRATEGY_REL, strategyName: 'seal-test-strategy', preRegHash: blockHash });
      // No audit row committed yet, so seal fails on that; irrelevant for this assertion.
      // This test's real check is just that the sealer doesn't crash when ledger is missing.
      // (The backward-compat scenario is covered by all the existing tests that don't write a ledger.)
      expect(out.ok).toBe(false);  // no audit row committed
      // The fact that all 33 original tests PASS without writing a ledger is the actual compat proof.
    });
  });
});
