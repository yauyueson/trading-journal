import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { ACTIVE_STRATEGIES, RETIRED_STRATEGIES } from '../src/lib/strategyProfiles';

const repoRoot = resolve(__dirname, '..');
const governancePath = resolve(repoRoot, 'config/strategy-governance.json');
const cleanSheetPath = resolve(repoRoot, 'docs/wfa/CLEAN-SHEET-RESET-2026-05-06.md');
const refreshLogPath = resolve(repoRoot, 'docs/holdout-refresh-log.md');

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('strategy governance registry', () => {
  it('defines canonical governance entries for every active strategy', () => {
    expect(existsSync(governancePath)).toBe(true);
    const registry = readJson(governancePath);
    const strategies = registry.strategies ?? {};

    expect(Object.keys(strategies).sort()).toEqual([...ACTIVE_STRATEGIES].sort());

    for (const strategy of ACTIVE_STRATEGIES) {
      const entry = strategies[strategy];
      expect(entry.status).toBe('paper-approved');
      expect(entry.canonicalSealPath).toMatch(/^docs\/holdout-evaluations\/.+\.md$/);
      expect(entry.permission).toMatchObject({ paper: true, live: false });
      expect(entry.capitalTier?.startingCapital).toBeGreaterThan(0);
      expect(entry.riskPolicy?.maxConcurrentPositions).toBe(1);
    }
  });

  it('does not allow retired strategies in the active governance registry', () => {
    const registry = readJson(governancePath);
    const strategyNames = Object.keys(registry.strategies ?? {});
    for (const retired of RETIRED_STRATEGIES) {
      expect(strategyNames).not.toContain(retired);
    }
  });

  it('records low-sample waivers for active seals whose rows are reviewer-invalid', () => {
    const registry = readJson(governancePath);
    for (const entry of Object.values<any>(registry.strategies ?? {})) {
      expect(entry.lowSampleWaiver).toMatchObject({
        required: true,
        approvedBy: 'model-risk',
      });
      expect(entry.lowSampleWaiver.reason).toContain('low-frequency');
    }
  });
});

describe('WFA clean-sheet reset policy', () => {
  it('creates a clean-sheet reset document that retires old WFA as evidence without deleting it', () => {
    expect(existsSync(cleanSheetPath)).toBe(true);
    const doc = readFileSync(cleanSheetPath, 'utf-8');
    expect(doc).toContain('Historical only');
    expect(doc).toContain('Do not delete');
    expect(doc).toContain('No pre-2026-05-06 WFA artifact may be used as current adoption evidence');
  });

  it('updates the holdout refresh log for BCD/PMCC paper approval and clean-sheet status', () => {
    const log = readFileSync(refreshLogPath, 'utf-8');
    expect(log).toContain('2026-05-06');
    expect(log).toContain('BCD QQQ wide');
    expect(log).toContain('PMCC QQQ pt60');
    expect(log).toContain('paper-approved');
    expect(log).toContain('clean-sheet WFA reset');
  });

  it('keeps the QQQ-only clean-sheet validation plan linked to completed evidence', () => {
    const plan = readFileSync(resolve(repoRoot, 'docs/wfa/QQQ-CLEAN-SHEET-VALIDATION-2026-05-07.md'), 'utf-8');

    expect(plan).toContain('Completed');
    expect(plan).toContain('QQQ-CLEAN-SHEET-VALIDATION-RESULTS-2026-05-07.md');
    expect(plan).toContain('Ticker universe: QQQ only');
    expect(plan).toContain('API calls required before QQQ clean-sheet validation: 0');
    expect(plan).toContain('No new parameter search');
    expect(plan).toContain('Live adoption remains blocked');
  });
});
