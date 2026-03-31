import { describe, expect, it } from 'vitest';

import {
  buildDebitCandidates,
  buildUnderlyingCandidates,
  compareDirectionalSignals,
  formatDebitConfigLabel,
  formatUnderlyingConfigLabel,
} from '../scripts/wfa-pipeline-directional';

describe('directional pipeline sweep builders', () => {
  it('builds the expected underlying candidate grid', () => {
    const candidates = buildUnderlyingCandidates({
      presets: ['pb8', 'pb21'],
      underlyingExitEMAs: [21, 34],
      underlyingExitConfirmDays: [1, 2],
      underlyingExitRequireSlope: [true],
      underlyingMaxHoldDays: [15, 20],
      underlyingMinDirConfidences: [0, 55],
      underlyingMaxEntryD8s: [1.5, Infinity],
      underlyingMaxRecentGapPcts: [3, Infinity],
      underlyingMinEntryVrpPcts: [0, 60],
      underlyingMaxEntryContangoPcts: [50, Infinity],
    });

    expect(candidates).toHaveLength(512);
    expect(formatUnderlyingConfigLabel(candidates[0])).toContain('pb');
    expect(candidates.some(candidate => candidate.minDirConfidence === 55)).toBe(true);
    expect(candidates.some(candidate => candidate.minEntryVrpPct === 60)).toBe(true);
    expect(candidates.some(candidate => candidate.maxEntryContangoPct === 50)).toBe(true);
  });

  it('builds blended underlying routing candidates with pb21 bonus and slot count', () => {
    const candidates = buildUnderlyingCandidates({
      presets: ['pb8', 'pb21'],
      underlyingSignalBundles: [['pb8'], ['pb21'], ['pb8', 'pb21']],
      underlyingExitEMAs: [21],
      underlyingExitConfirmDays: [2],
      underlyingExitRequireSlope: [true],
      underlyingMaxHoldDays: [15],
      underlyingPb21RankingBonuses: [0, 10],
      underlyingMaxPositions: [3, 5],
    });

    expect(candidates).toHaveLength(12);
    expect(candidates.some(candidate => candidate.signalSourceLabel === 'pb8+pb21')).toBe(true);
    expect(candidates.some(candidate => candidate.pb21RankingBonus === 10)).toBe(true);
    expect(candidates.some(candidate => candidate.maxPositions === 5)).toBe(true);
  });

  it('builds routed pb8+pb21 candidates without multiplying pb21 ranking bonus on routed modes', () => {
    const candidates = buildUnderlyingCandidates({
      presets: ['pb8', 'pb21'],
      underlyingSignalBundles: [['pb8', 'pb21']],
      underlyingPb21RouterModes: ['off', 'vrpPct_gte_50'],
      underlyingPb21RankingBonuses: [0, 10],
      underlyingExitEMAs: [21],
      underlyingExitConfirmDays: [2],
      underlyingExitRequireSlope: [true],
      underlyingMaxHoldDays: [15],
      underlyingMaxPositions: [3],
    });

    expect(candidates).toHaveLength(3);
    expect(candidates.filter(candidate => candidate.pb21RouterMode === 'off')).toHaveLength(2);
    expect(candidates.filter(candidate => candidate.pb21RouterMode === 'vrpPct_gte_50')).toHaveLength(1);
  });

  it('builds debit candidates across both DTE bands and labels them clearly', () => {
    const candidates = buildDebitCandidates('bidask', {
      presets: ['pb'],
      debitDTERanges: [[30, 45], [60, 75]],
      debitLongDeltas: [0.5],
      debitShortDeltas: [0.2, 0.3],
      debitProfitTargets: [0.5],
      debitExitEMAs: [21],
      debitExitConfirmDays: [2],
      debitExitRequireSlope: [true],
      debitMaxHoldDays: [20],
      debitMinExitDTEs: [14],
    });

    expect(candidates).toHaveLength(4);
    expect(candidates.every(candidate => candidate.mode === 'DEBIT_SPREAD')).toBe(true);
    expect(formatDebitConfigLabel(candidates[0])).toContain('dte30_45');
  });

  it('ranks same-day directional signals by quality instead of ticker order', () => {
    const signals = [
      { ticker: 'SPY', date: '2024-01-05', direction: 'CALL', score: 72, dirConfidence: 55, d8: 0.2 },
      { ticker: 'AAPL', date: '2024-01-05', direction: 'CALL', score: 88, dirConfidence: 70, d8: 0.1 },
      { ticker: 'QQQ', date: '2024-01-05', direction: 'CALL', score: 88, dirConfidence: 40, d8: 1.8 },
    ] as const;

    const sorted = [...signals].sort(compareDirectionalSignals);

    expect(sorted.map(signal => signal.ticker)).toEqual(['AAPL', 'QQQ', 'SPY']);
  });

  it('can bias blended ranking toward pb21 when quality is otherwise tied', () => {
    const signals = [
      { ticker: 'AAPL', date: '2024-01-05', direction: 'CALL', score: 88, dirConfidence: 70, d8: 0.1, sourcePreset: 'pb8' },
      { ticker: 'MSFT', date: '2024-01-05', direction: 'CALL', score: 88, dirConfidence: 70, d8: 0.1, sourcePreset: 'pb21' },
    ] as const;

    const sorted = [...signals].sort((a, b) => compareDirectionalSignals(a, b, { pb21RankingBonus: 10 }));

    expect(sorted.map(signal => signal.ticker)).toEqual(['MSFT', 'AAPL']);
  });
});
