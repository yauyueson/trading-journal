import { describe, expect, it } from 'vitest';

import {
  OPTION_NATIVE_STAGE0_DEFAULTS,
  OPTION_NATIVE_STAGE1_DEFAULTS,
  buildSwingLongCandidates,
  compareOptionNativeSignals,
  scoreOptionNativeSignalQuality,
} from '../scripts/wfa-pipeline-option-native';

describe('option-native pipeline candidate builders', () => {
  it('builds the expected Stage 0 grid', () => {
    const candidates = buildSwingLongCandidates('bidask', 100_000, 1, OPTION_NATIVE_STAGE0_DEFAULTS);
    expect(candidates).toHaveLength(32);
    expect(candidates.every(candidate => candidate.mode === 'SWING_LONG_OPTION')).toBe(true);
  });

  it('builds the expected Stage 1 grid', () => {
    const candidates = buildSwingLongCandidates('bidask', 100_000, 1, OPTION_NATIVE_STAGE1_DEFAULTS);
    expect(candidates).toHaveLength(512);
  });

  it('ranks same-day signals with gap and anomaly penalties', () => {
    const strong = {
      ticker: 'AAPL',
      date: '2024-01-05',
      direction: 'CALL',
      score: 88,
      dirConfidence: 75,
      d8: 0.2,
      recentMaxGapPct10: 1.5,
      frontBackIVAnomaly: 1.02,
    };
    const risky = {
      ticker: 'QQQ',
      date: '2024-01-05',
      direction: 'CALL',
      score: 88,
      dirConfidence: 75,
      d8: 0.2,
      recentMaxGapPct10: 4.5,
      frontBackIVAnomaly: 1.30,
    };

    expect(scoreOptionNativeSignalQuality(strong as any)).toBeGreaterThan(scoreOptionNativeSignalQuality(risky as any));
    const sorted = [risky, strong].sort(compareOptionNativeSignals as any);
    expect(sorted[0].ticker).toBe('AAPL');
  });
});
