import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import {
  auditStrategyGovernance,
  formatGovernanceAudit,
} from '../scripts/governance-audit';

const repoRoot = resolve(__dirname, '..');

describe('governance audit command', () => {
  it('summarizes active strategy governance and live blockers', () => {
    const audit = auditStrategyGovernance({ repoRoot });

    expect(audit.ok).toBe(true);
    expect(audit.strategies.map(s => s.strategy).sort()).toEqual(['bcd', 'pmcc']);
    expect(audit.strategies.every(s => s.status === 'paper-approved')).toBe(true);
    expect(audit.strategies.every(s => s.permission.paper === true)).toBe(true);
    expect(audit.strategies.every(s => s.permission.live === false)).toBe(true);
    expect(audit.strategies.every(s => s.liveBlockers.length > 0)).toBe(true);
  });

  it('verifies manifest, adoption-gate, and canonical seal hashes', () => {
    const audit = auditStrategyGovernance({ repoRoot });

    expect(audit.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'dataset manifest hash', ok: true }),
        expect.objectContaining({ name: 'adoption gates hash', ok: true }),
        expect.objectContaining({ name: 'bcd canonical seal hash', ok: true }),
        expect.objectContaining({ name: 'pmcc canonical seal hash', ok: true }),
      ]),
    );
  });

  it('formats a human-readable trust report', () => {
    const output = formatGovernanceAudit(auditStrategyGovernance({ repoRoot }));

    expect(output).toContain('Strategy Governance Audit');
    expect(output).toContain('Overall: PASS');
    expect(output).toContain('BCD QQQ wide');
    expect(output).toContain('PMCC QQQ pt60');
    expect(output).toContain('paper-approved');
    expect(output).toContain('Live: blocked');
    expect(output).toContain('Next fresh holdout backstop: 2026-10-20');
  });
});
