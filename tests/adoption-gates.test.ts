/**
 * Regression tests for scripts/autoresearch/lib/adoption-gates.ts —
 * specifically the `assertGateConfigTracked` helper added in response
 * to Codex round-6 Finding 1 (2026-04-18).
 *
 * The invariant: the runner refuses to start unless
 * `config/adoption-gates.json` is both tracked in git AND git-clean.
 *
 * Each test spins up a tmp git repo, stages or doesn't stage the
 * gate file, and checks that assertGateConfigTracked either throws or
 * returns void with the right signal.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAdoptionGates, assertGateConfigTracked, validateGateRanges } from '../scripts/autoresearch/lib/adoption-gates';

const SAMPLE_GATES = {
  version: 1,
  description: 'test fixture',
  lastModified: '2026-04-18',
  lastModifier: 'test',
  rationale: 'unit-test only',
  gates: {
    minOosTrades: 100,
    maxOosDrawdownPct: 45,
    minSaneOosDrawdownPct: 2.0,
    maxSanePerTradeEdge: 0.95,
    minHoldoutSharpe: 0,
    maxSaneOosSharpe: 3.0,
    minHoldoutMetric: 0.3,
    minHoldoutIrFloor: 0,
    minNewHoldoutTrades: 1,
    bootstrapIterations: 1000,
    naiveBaselineIntervalDays: 5,
  },
  environmentOverrides: {},
};

function gitInit(root: string): void {
  execSync('git init -q', { cwd: root });
  execSync('git config user.email "test@example.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });
  execSync('git config commit.gpgsign false', { cwd: root });
}

function writeGates(root: string, contents: unknown = SAMPLE_GATES): string {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'adoption-gates.json');
  fs.writeFileSync(p, JSON.stringify(contents, null, 2));
  return p;
}

function commitGates(root: string): void {
  execSync('git add config/adoption-gates.json', { cwd: root });
  execSync('git commit -q -m "add gates"', { cwd: root });
}

describe('assertGateConfigTracked', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-test-'));
    gitInit(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns void when the gate file is tracked and clean', () => {
    writeGates(tmpRoot);
    commitGates(tmpRoot);
    const loaded = loadAdoptionGates({ repoRoot: tmpRoot });
    expect(() => assertGateConfigTracked(loaded, { repoRoot: tmpRoot })).not.toThrow();
  });

  it('throws with an actionable hint when the gate file is not tracked', () => {
    writeGates(tmpRoot);
    // Do NOT commit — file exists on disk but is untracked.
    const loaded = loadAdoptionGates({ repoRoot: tmpRoot });
    expect(() => assertGateConfigTracked(loaded, { repoRoot: tmpRoot })).toThrow(
      /not tracked in git/i,
    );
  });

  it('throws when the gate file has uncommitted changes', () => {
    writeGates(tmpRoot);
    commitGates(tmpRoot);
    // Modify without committing.
    const modified = { ...SAMPLE_GATES, gates: { ...SAMPLE_GATES.gates, minOosTrades: 200 } };
    writeGates(tmpRoot, modified);
    const loaded = loadAdoptionGates({ repoRoot: tmpRoot });
    expect(() => assertGateConfigTracked(loaded, { repoRoot: tmpRoot })).toThrow(
      /uncommitted changes/i,
    );
  });

  it('throws when the gate file is staged but not committed', () => {
    writeGates(tmpRoot);
    execSync('git add config/adoption-gates.json', { cwd: tmpRoot });
    // Staged but not committed — porcelain output will have "A".
    const loaded = loadAdoptionGates({ repoRoot: tmpRoot });
    expect(() => assertGateConfigTracked(loaded, { repoRoot: tmpRoot })).toThrow();
  });

  it('throws clearly when the repoRoot is not a git checkout', () => {
    // Delete the .git directory so the repo looks like a plain folder.
    fs.rmSync(path.join(tmpRoot, '.git'), { recursive: true, force: true });
    writeGates(tmpRoot);
    const loaded = loadAdoptionGates({ repoRoot: tmpRoot });
    expect(() => assertGateConfigTracked(loaded, { repoRoot: tmpRoot })).toThrow();
  });

  it('accepts a subsequent committed change (PR workflow)', () => {
    writeGates(tmpRoot);
    commitGates(tmpRoot);
    // PR-style amend: modify + stage + commit a new version.
    const modified = { ...SAMPLE_GATES, gates: { ...SAMPLE_GATES.gates, minOosTrades: 150 } };
    writeGates(tmpRoot, modified);
    execSync('git add config/adoption-gates.json', { cwd: tmpRoot });
    execSync('git commit -q -m "raise min trades"', { cwd: tmpRoot });
    const loaded = loadAdoptionGates({ repoRoot: tmpRoot });
    expect(() => assertGateConfigTracked(loaded, { repoRoot: tmpRoot })).not.toThrow();
    expect(loaded.gates.minOosTrades).toBe(150);
  });
});

// Codex round-7 Finding 1: domain/range validation on gate values.
describe('validateGateRanges', () => {
  const baseGates = { ...SAMPLE_GATES.gates };

  it('accepts the shipped sample gates', () => {
    expect(() => validateGateRanges(baseGates)).not.toThrow();
  });

  it('rejects minOosTrades = 0', () => {
    expect(() => validateGateRanges({ ...baseGates, minOosTrades: 0 })).toThrow(/minOosTrades.*integer >= 1/);
  });

  it('rejects minOosTrades negative', () => {
    expect(() => validateGateRanges({ ...baseGates, minOosTrades: -5 })).toThrow(/minOosTrades/);
  });

  it('rejects minOosTrades fractional', () => {
    expect(() => validateGateRanges({ ...baseGates, minOosTrades: 1.5 })).toThrow(/minOosTrades/);
  });

  it('rejects bootstrapIterations = 0 (would break CI path)', () => {
    expect(() => validateGateRanges({ ...baseGates, bootstrapIterations: 0 })).toThrow(/bootstrapIterations/);
  });

  it('rejects bootstrapIterations below minimum (< 100)', () => {
    expect(() => validateGateRanges({ ...baseGates, bootstrapIterations: 50 })).toThrow(/bootstrapIterations/);
  });

  it('rejects naiveBaselineIntervalDays = 0 (would cause infinite loop)', () => {
    expect(() => validateGateRanges({ ...baseGates, naiveBaselineIntervalDays: 0 })).toThrow(/naiveBaselineIntervalDays/);
  });

  it('rejects naiveBaselineIntervalDays negative', () => {
    expect(() => validateGateRanges({ ...baseGates, naiveBaselineIntervalDays: -1 })).toThrow(/naiveBaselineIntervalDays/);
  });

  it('accepts minNewHoldoutTrades = 0 (legitimate "no minimum")', () => {
    expect(() => validateGateRanges({ ...baseGates, minNewHoldoutTrades: 0 })).not.toThrow();
  });

  it('rejects minNewHoldoutTrades negative', () => {
    expect(() => validateGateRanges({ ...baseGates, minNewHoldoutTrades: -1 })).toThrow(/minNewHoldoutTrades/);
  });

  it('rejects maxOosDrawdownPct = 0 (would reject all strategies)', () => {
    expect(() => validateGateRanges({ ...baseGates, maxOosDrawdownPct: 0 })).toThrow(/maxOosDrawdownPct/);
  });

  it('rejects maxOosDrawdownPct > 100', () => {
    expect(() => validateGateRanges({ ...baseGates, maxOosDrawdownPct: 150 })).toThrow(/maxOosDrawdownPct/);
  });

  it('rejects maxSaneOosSharpe = 0', () => {
    expect(() => validateGateRanges({ ...baseGates, maxSaneOosSharpe: 0 })).toThrow(/maxSaneOosSharpe/);
  });

  it('rejects negative minHoldoutMetric (would silently relax gate)', () => {
    expect(() => validateGateRanges({ ...baseGates, minHoldoutMetric: -0.5 })).toThrow(/minHoldoutMetric/);
  });

  it('accepts negative minHoldoutIrFloor (research flexibility)', () => {
    expect(() => validateGateRanges({ ...baseGates, minHoldoutIrFloor: -0.1 })).not.toThrow();
  });

  // Phase 1.c: minSaneOosDrawdownPct — lower-bound sanity for TRAILING_LOCK-class bugs.
  it('rejects negative minSaneOosDrawdownPct (would silently accept simulator bugs)', () => {
    expect(() => validateGateRanges({ ...baseGates, minSaneOosDrawdownPct: -0.5 })).toThrow(/minSaneOosDrawdownPct/);
  });

  it('rejects minSaneOosDrawdownPct >= maxOosDrawdownPct (pair inverted — catches misconfig)', () => {
    expect(() => validateGateRanges({ ...baseGates, minSaneOosDrawdownPct: 45 })).toThrow(/minSaneOosDrawdownPct/);
    expect(() => validateGateRanges({ ...baseGates, minSaneOosDrawdownPct: 50 })).toThrow(/minSaneOosDrawdownPct/);
  });

  it('accepts minSaneOosDrawdownPct = 0 (research flexibility — disables the gate)', () => {
    expect(() => validateGateRanges({ ...baseGates, minSaneOosDrawdownPct: 0 })).not.toThrow();
  });

  // Phase 1.d: maxSanePerTradeEdge
  it('rejects maxSanePerTradeEdge <= 0 (would reject all positive-mean strategies)', () => {
    expect(() => validateGateRanges({ ...baseGates, maxSanePerTradeEdge: 0 })).toThrow(/maxSanePerTradeEdge/);
    expect(() => validateGateRanges({ ...baseGates, maxSanePerTradeEdge: -0.1 })).toThrow(/maxSanePerTradeEdge/);
  });

  it('rejects maxSanePerTradeEdge > 1.0 (physically impossible — grossPnl clamped at maxProfit)', () => {
    expect(() => validateGateRanges({ ...baseGates, maxSanePerTradeEdge: 1.01 })).toThrow(/maxSanePerTradeEdge/);
    expect(() => validateGateRanges({ ...baseGates, maxSanePerTradeEdge: 2.0 })).toThrow(/maxSanePerTradeEdge/);
  });

  it('accepts maxSanePerTradeEdge = 1.0 (upper bound, disables gate)', () => {
    expect(() => validateGateRanges({ ...baseGates, maxSanePerTradeEdge: 1.0 })).not.toThrow();
  });

  it('validation fires inside loadAdoptionGates when env override pushes a value out of range', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-env-test-'));
    try {
      gitInit(tmp);
      // Build a gates config with an env override that pushes minOosTrades = 0 (invalid).
      const cfg = {
        ...SAMPLE_GATES,
        environmentOverrides: {
          AUTORESEARCH_MIN_OOS_TRADES: {
            overrides: 'minOosTrades',
            reason: 'unit test',
            mustBeDeclaredInPreReg: true,
          },
        },
      };
      writeGates(tmp, cfg);
      const origEnv = process.env.AUTORESEARCH_MIN_OOS_TRADES;
      process.env.AUTORESEARCH_MIN_OOS_TRADES = '0';
      try {
        expect(() => loadAdoptionGates({ repoRoot: tmp })).toThrow(/minOosTrades/);
      } finally {
        if (origEnv === undefined) delete process.env.AUTORESEARCH_MIN_OOS_TRADES;
        else process.env.AUTORESEARCH_MIN_OOS_TRADES = origEnv;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
