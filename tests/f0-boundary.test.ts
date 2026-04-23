/**
 * Phase F0 — unit tests for the effective-attempt-counter filter.
 *
 * Policy reference: docs/phase-f0-clean-slate-declaration.md.
 * Implementation: scripts/autoresearch/lib/f0-boundary.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  F0_BOUNDARY_ISO,
  countEffectiveAttempts,
  deflatedSharpeAt,
} from '../scripts/autoresearch/lib/f0-boundary';

function writeLedger(root: string, trials: Array<{ timestamp: string; strategyName?: string; oosSharpe?: number }>): void {
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const ledger = {
    version: 2,
    count: trials.length,
    lastSource: 'test',
    lastUpdated: trials[trials.length - 1]?.timestamp ?? new Date().toISOString(),
    trials: trials.map((t, i) => ({
      ordinal: i + 1,
      source: 'primary:test',
      strategyName: t.strategyName ?? 'test-strategy',
      timestamp: t.timestamp,
      leaderboardSuffix: '',
      oosSharpe: t.oosSharpe ?? 1.0,
      oosTrades: 30,
      returnsFile: `trial-${String(i + 1).padStart(6, '0')}.json`,
    })),
  };
  fs.writeFileSync(path.join(dir, 'attempts-global.json'), JSON.stringify(ledger, null, 2));
}

describe('F0_BOUNDARY_ISO', () => {
  it('is the declared 2026-04-22 boundary', () => {
    expect(F0_BOUNDARY_ISO).toBe('2026-04-22T22:15:00Z');
  });
});

describe('countEffectiveAttempts', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f0-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns ledgerPresent=false when ledger missing', () => {
    const r = countEffectiveAttempts(tmpRoot, '2026-05-01T00:00:00Z');
    expect(r.ledgerPresent).toBe(false);
    expect(r.effectiveN).toBe(0);
  });

  it('excludes trials timestamped before F0 boundary', () => {
    writeLedger(tmpRoot, [
      { timestamp: '2026-04-10T00:00:00Z' },  // pre-boundary
      { timestamp: '2026-04-20T12:00:00Z' },  // pre-boundary
      { timestamp: '2026-04-22T22:14:00Z' },  // pre-boundary (1 min before)
      { timestamp: '2026-04-22T22:15:00Z' },  // EXACTLY at boundary (inclusive)
      { timestamp: '2026-04-23T00:00:00Z' },  // post-boundary
      { timestamp: '2026-04-25T12:00:00Z' },  // post-boundary
    ]);
    const r = countEffectiveAttempts(tmpRoot, '2026-05-01T00:00:00Z');
    expect(r.ledgerPresent).toBe(true);
    expect(r.effectiveN).toBe(3);  // boundary itself + two later
  });

  it('excludes trials timestamped AFTER the upToTimestamp', () => {
    writeLedger(tmpRoot, [
      { timestamp: '2026-04-23T00:00:00Z' },  // counted
      { timestamp: '2026-04-24T00:00:00Z' },  // counted
      { timestamp: '2026-04-25T00:00:00Z' },  // NOT counted — after upTo
      { timestamp: '2026-04-30T00:00:00Z' },  // NOT counted
    ]);
    const r = countEffectiveAttempts(tmpRoot, '2026-04-24T12:00:00Z');
    expect(r.effectiveN).toBe(2);
  });

  it('returns 0 when all trials are pre-boundary', () => {
    writeLedger(tmpRoot, [
      { timestamp: '2026-04-10T00:00:00Z' },
      { timestamp: '2026-04-15T00:00:00Z' },
    ]);
    const r = countEffectiveAttempts(tmpRoot, '2026-05-01T00:00:00Z');
    expect(r.ledgerPresent).toBe(true);
    expect(r.effectiveN).toBe(0);
  });

  it('handles malformed ledger file gracefully', () => {
    fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'data/attempts-global.json'), 'not valid json');
    const r = countEffectiveAttempts(tmpRoot, '2026-05-01T00:00:00Z');
    expect(r.ledgerPresent).toBe(false);
  });
});

describe('deflatedSharpeAt', () => {
  it('returns observedSharpe when numAttempts < 2 (no multi-testing)', () => {
    expect(deflatedSharpeAt(0.9, 1, 0.5)).toBeCloseTo(0.9, 5);
  });

  it('returns undefined when SE is missing or <= 0', () => {
    expect(deflatedSharpeAt(0.9, 10, 0)).toBeUndefined();
    expect(deflatedSharpeAt(0.9, 10, undefined)).toBeUndefined();
  });

  it('returns undefined when observedSharpe is missing', () => {
    expect(deflatedSharpeAt(undefined, 10, 0.5)).toBeUndefined();
  });

  it('monotonically deflates as N grows', () => {
    const d10 = deflatedSharpeAt(1.0, 10, 0.3)!;
    const d100 = deflatedSharpeAt(1.0, 100, 0.3)!;
    const d1000 = deflatedSharpeAt(1.0, 1000, 0.3)!;
    expect(d10).toBeGreaterThan(d100);
    expect(d100).toBeGreaterThan(d1000);
  });

  it('at N=106 (pre-F0 global) and SE 0.46, reproduces the E11 ~-0.27 dsrM', () => {
    // E11 bull-call-debit-qqq-solo seal reported dsrM ≈ -0.27 at attemptNumber 106,
    // oosSharpe 0.878, mertensSharpeSE ~0.46 (from earlier audit rows).
    // Validates that deflatedSharpeAt matches runner's computeDeflatedSharpe on that row.
    const d = deflatedSharpeAt(0.878, 106, 0.46)!;
    expect(d).toBeGreaterThan(-0.35);
    expect(d).toBeLessThan(-0.20);
  });

  it('at F0-effective N=5 with the same SE, the same oosSharpe now clears dsrM > 0', () => {
    // Under F0, if we run 5 fresh attempts with the same Sharpe, deflation is much smaller.
    const d = deflatedSharpeAt(0.878, 5, 0.46)!;
    expect(d).toBeGreaterThan(0);  // cleanly positive
    expect(d).toBeLessThan(0.878);  // still deflated from raw
  });
});
