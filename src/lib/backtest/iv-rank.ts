export const IV_RANK_METHOD_MIN_MAX_252D = 'min_max_252d';

export type IVRankMethod = typeof IV_RANK_METHOD_MIN_MAX_252D;

export function computeIVRankMinMax(
  ivSeries: Array<number | null>,
  window = 252,
  minSamples = 100,
): Array<number | null> {
  return ivSeries.map((value, index) => {
    if (index < window || value == null) return null;
    const sample = ivSeries.slice(index - window, index + 1).filter((entry): entry is number => entry != null);
    if (sample.length < minSamples) return null;
    const min = Math.min(...sample);
    const max = Math.max(...sample);
    const range = max - min;
    return range > 0 ? ((value - min) / range) * 100 : 50;
  });
}
