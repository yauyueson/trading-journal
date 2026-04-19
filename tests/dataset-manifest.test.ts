/**
 * Regression tests for Phase 0.b.6 dataset-manifest module.
 * Mirrors tests/adoption-gates.test.ts structure — tmpdir git repo with
 * tracked/dirty/untracked state transitions.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadDatasetManifest,
  validateManifestRanges,
  assertManifestConfigTracked,
  assertManifestUnchanged,
  windowFallsInHoldout,
  recomputeRawHash,
  type DatasetManifest,
} from '../scripts/autoresearch/lib/dataset-manifest';

const MANIFEST_REL = 'config/dataset-manifest.json';

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function initRepo(root: string): void {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  sh('git init -q -b main', root);
  sh('git config user.email "test@example.com"', root);
  sh('git config user.name "Test"', root);
  sh('git config commit.gpgsign false', root);
}

function defaultManifest(): DatasetManifest {
  return {
    manifestVersion: 1,
    dataStartDate: '2017-01-01',
    dataEndDate: '2026-02-28',
    holdoutStartDate: '2024-01-22',
    holdoutEndDate: '2026-02-28',
    generatedAt: '2026-04-19T10:30:00Z',
    notes: 'test',
  };
}

function writeManifestCommitted(root: string, override?: Partial<DatasetManifest>): void {
  const m = { ...defaultManifest(), ...override };
  fs.writeFileSync(path.join(root, MANIFEST_REL), JSON.stringify(m, null, 2));
  sh('git add config/dataset-manifest.json', root);
  sh('git commit -q -m "manifest"', root);
}

describe('validateManifestRanges', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => validateManifestRanges(defaultManifest())).not.toThrow();
  });

  it('rejects manifestVersion != 1', () => {
    const m = { ...defaultManifest(), manifestVersion: 2 };
    expect(() => validateManifestRanges(m)).toThrow(/manifestVersion/);
  });

  it('rejects non-ISO date', () => {
    const m = { ...defaultManifest(), dataStartDate: '2017/01/01' };
    expect(() => validateManifestRanges(m)).toThrow(/dataStartDate/);
  });

  it('rejects impossible calendar date', () => {
    const m = { ...defaultManifest(), holdoutEndDate: '2026-02-30' };
    expect(() => validateManifestRanges(m)).toThrow(/holdoutEndDate/);
  });

  it('rejects dataStartDate >= dataEndDate', () => {
    const m = { ...defaultManifest(), dataStartDate: '2027-01-01' };
    expect(() => validateManifestRanges(m)).toThrow(/precede/);
  });

  it('rejects holdoutStartDate > holdoutEndDate', () => {
    const m = { ...defaultManifest(), holdoutStartDate: '2026-03-01' };
    expect(() => validateManifestRanges(m)).toThrow(/holdoutStartDate/);
  });

  it('rejects holdoutStartDate before dataStartDate', () => {
    const m = { ...defaultManifest(), holdoutStartDate: '2016-12-01' };
    expect(() => validateManifestRanges(m)).toThrow(/before dataStartDate/);
  });

  it('rejects holdoutEndDate after dataEndDate', () => {
    const m = { ...defaultManifest(), holdoutEndDate: '2027-01-01' };
    expect(() => validateManifestRanges(m)).toThrow(/after dataEndDate/);
  });
});

describe('loadDatasetManifest', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
    initRepo(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('throws when the file does not exist', () => {
    expect(() => loadDatasetManifest({ repoRoot: tmpRoot })).toThrow(/missing/);
  });

  it('loads a committed manifest and produces a stable hash', () => {
    writeManifestCommitted(tmpRoot);
    const a = loadDatasetManifest({ repoRoot: tmpRoot });
    const b = loadDatasetManifest({ repoRoot: tmpRoot });
    expect(a.rawHash).toBe(b.rawHash);
    expect(a.rawHash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.manifest.holdoutStartDate).toBe('2024-01-22');
  });

  it('throws on invalid JSON', () => {
    fs.writeFileSync(path.join(tmpRoot, MANIFEST_REL), '{ not json');
    sh('git add config/dataset-manifest.json', tmpRoot);
    sh('git commit -q -m "bad json"', tmpRoot);
    expect(() => loadDatasetManifest({ repoRoot: tmpRoot })).toThrow(/not valid JSON/);
  });

  it('throws on missing required fields', () => {
    const bad = { manifestVersion: 1, dataStartDate: '2017-01-01' };
    fs.writeFileSync(path.join(tmpRoot, MANIFEST_REL), JSON.stringify(bad, null, 2));
    sh('git add config/dataset-manifest.json', tmpRoot);
    sh('git commit -q -m "partial"', tmpRoot);
    expect(() => loadDatasetManifest({ repoRoot: tmpRoot })).toThrow();
  });
});

describe('assertManifestConfigTracked', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
    initRepo(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('throws when the manifest is untracked (present but never added)', () => {
    fs.writeFileSync(path.join(tmpRoot, MANIFEST_REL), JSON.stringify(defaultManifest(), null, 2));
    const loaded = loadDatasetManifest({ repoRoot: tmpRoot });
    expect(() => assertManifestConfigTracked(loaded, { repoRoot: tmpRoot })).toThrow(/not tracked/);
  });

  it('throws when the manifest has uncommitted changes', () => {
    writeManifestCommitted(tmpRoot);
    const loaded = loadDatasetManifest({ repoRoot: tmpRoot });
    fs.appendFileSync(path.join(tmpRoot, MANIFEST_REL), '\n');
    expect(() => assertManifestConfigTracked(loaded, { repoRoot: tmpRoot })).toThrow(/uncommitted/);
  });

  it('succeeds when the manifest is tracked and clean', () => {
    writeManifestCommitted(tmpRoot);
    const loaded = loadDatasetManifest({ repoRoot: tmpRoot });
    expect(() => assertManifestConfigTracked(loaded, { repoRoot: tmpRoot })).not.toThrow();
  });
});

describe('assertManifestUnchanged', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
    initRepo(tmpRoot);
    writeManifestCommitted(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not throw when the file is unchanged after load', () => {
    const loaded = loadDatasetManifest({ repoRoot: tmpRoot });
    expect(() => assertManifestUnchanged(loaded)).not.toThrow();
  });

  it('throws when the file is edited after load', () => {
    const loaded = loadDatasetManifest({ repoRoot: tmpRoot });
    fs.appendFileSync(path.join(tmpRoot, MANIFEST_REL), ' ');
    expect(() => assertManifestUnchanged(loaded)).toThrow(/modified mid-campaign/);
  });

  it('recomputeRawHash returns current content hash', () => {
    const loaded = loadDatasetManifest({ repoRoot: tmpRoot });
    const current = recomputeRawHash(loaded);
    expect(current).toBe(loaded.rawHash);
  });
});

describe('windowFallsInHoldout', () => {
  const m = defaultManifest();

  it('returns true for a window exactly matching the holdout range', () => {
    expect(windowFallsInHoldout(m.holdoutStartDate, m.holdoutEndDate, m)).toBe(true);
  });

  it('returns true for a window inside the holdout range', () => {
    expect(windowFallsInHoldout('2024-03-15', '2024-06-30', m)).toBe(true);
  });

  it('returns false when start is before holdoutStartDate', () => {
    expect(windowFallsInHoldout('2024-01-01', '2024-06-30', m)).toBe(false);
  });

  it('returns false when end is after holdoutEndDate', () => {
    expect(windowFallsInHoldout('2024-03-15', '2026-03-01', m)).toBe(false);
  });
});

describe('hash stability across whitespace', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
    initRepo(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // NOTE: the manifest hash is of the RAW bytes. Changing whitespace
  // changes the hash. This test documents the behavior: if an operator
  // reformats the file, the hash shifts and the pre-reg must be updated.
  // That's the intended behavior (the manifest is byte-identical or different).
  it('changes when whitespace differs (byte-level hash)', () => {
    fs.writeFileSync(path.join(tmpRoot, MANIFEST_REL), JSON.stringify(defaultManifest(), null, 2));
    sh('git add config/dataset-manifest.json', tmpRoot);
    sh('git commit -q -m "v1"', tmpRoot);
    const a = loadDatasetManifest({ repoRoot: tmpRoot }).rawHash;

    fs.writeFileSync(path.join(tmpRoot, MANIFEST_REL), JSON.stringify(defaultManifest(), null, 4));
    sh('git add config/dataset-manifest.json', tmpRoot);
    sh('git commit -q -m "v2"', tmpRoot);
    const b = loadDatasetManifest({ repoRoot: tmpRoot }).rawHash;

    expect(a).not.toBe(b);
  });
});
