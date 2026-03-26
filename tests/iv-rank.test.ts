import { describe, expect, it } from 'vitest';
import { computeIVRankMinMax, IV_RANK_METHOD_MIN_MAX_252D } from '../src/lib/backtest/iv-rank';

describe('computeIVRankMinMax', () => {
  it('uses the shared 252-day min-max definition used by report pipelines', () => {
    const leading = Array.from({ length: 252 }, (_, i) => i + 1);
    const ivSeries = [...leading, 253];

    const result = computeIVRankMinMax(ivSeries);

    expect(IV_RANK_METHOD_MIN_MAX_252D).toBe('min_max_252d');
    expect(result[251]).toBeNull();
    expect(result[252]).toBe(100);
  });

  it('returns 50 when the 252-day range is flat', () => {
    const ivSeries = Array.from({ length: 253 }, () => 25);

    const result = computeIVRankMinMax(ivSeries);

    expect(result[252]).toBe(50);
  });

  it('returns null when the series is shorter than the rolling window', () => {
    const result = computeIVRankMinMax([10, 12, 11, 9]);

    expect(result).toEqual([null, null, null, null]);
  });

  it('handles null gaps while still using the remaining valid observations', () => {
    const leading = Array.from({ length: 200 }, (_, i) => i + 1);
    const padded = Array.from({ length: 53 }, () => null);

    const result = computeIVRankMinMax([...leading, ...padded, 150]);

    expect(result[253]).toBeCloseTo(((150 - 2) / (200 - 2)) * 100, 8);
  });

  it('returns zero when the current value is at the bottom of a descending range', () => {
    const descending = Array.from({ length: 252 }, (_, i) => 253 - i);
    const result = computeIVRankMinMax([...descending, 1]);

    expect(result[252]).toBe(0);
  });

  it('enforces the configurable minimum sample threshold', () => {
    const sparseSeries = Array.from({ length: 252 }, (_, i) => (i < 98 ? i + 1 : null));
    const result = computeIVRankMinMax([...sparseSeries, 100], 252, 100);

    expect(result[252]).toBeNull();
  });
});
