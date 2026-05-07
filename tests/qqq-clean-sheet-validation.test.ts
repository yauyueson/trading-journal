import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  classifyValidationDecision,
  computeInformationRatio,
  sha256File,
  summarizeTradeExits,
  type StrategyValidationMetrics,
} from '../scripts/qqq-clean-sheet-validation';

function metrics(overrides: Partial<StrategyValidationMetrics> = {}): StrategyValidationMetrics {
  return {
    selectionTrades: 20,
    selectionSharpe: 1.1,
    selectionMaxDrawdownPct: 8,
    selectionTotalPnl: 500,
    selectionWinRate: 55,
    holdoutTrades: 6,
    holdoutSharpe: 0.7,
    holdoutMaxDrawdownPct: 9,
    holdoutTotalPnl: 200,
    holdoutWinRate: 50,
    holdoutSpyIR: 0.25,
    holdoutSpyExcessAnnualized: 0.03,
    noChainTrades: 0,
    totalTrades: 26,
    ...overrides,
  };
}

describe('QQQ clean-sheet validation helpers', () => {
  it('keeps live blocked for failed holdout, sparse trades, or missing-chain exits', () => {
    expect(classifyValidationDecision(metrics()).decision).toBe('paper_candidate');
    expect(classifyValidationDecision(metrics({ holdoutSharpe: -0.1 })).decision).toBe('blocked');
    expect(classifyValidationDecision(metrics({ holdoutTrades: 2 })).decision).toBe('blocked');
    expect(classifyValidationDecision(metrics({ noChainTrades: 1 })).decision).toBe('blocked');
  });

  it('computes information ratio on overlapping benchmark dates only', () => {
    const result = computeInformationRatio(
      [0.02, -0.01, 0.03, 0.01],
      ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07'],
      new Map([
        ['2026-01-02', 0.01],
        ['2026-01-06', 0.02],
        ['2026-01-07', -0.01],
      ]),
      2,
    );

    expect(result.overlap).toBe(3);
    expect(result.excessAnnualized).toBeCloseTo(((0.01 + 0.01 + 0.02) / 3) * 252, 8);
    expect(result.ir).toBeGreaterThan(0);
  });

  it('summarizes NO_CHAIN exits and hashes citeable artifacts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqq-clean-sheet-'));
    const filePath = path.join(tmpDir, 'artifact.json');
    fs.writeFileSync(filePath, '{"decision":"pass"}\n');

    expect(sha256File(filePath)).toMatch(/^[a-f0-9]{64}$/);
    expect(summarizeTradeExits([
      { exitType: 'PROFIT_TARGET' },
      { exitType: 'NO_CHAIN' },
      { exitType: 'NO_CHAIN' },
    ])).toEqual({ PROFIT_TARGET: 1, NO_CHAIN: 2 });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
