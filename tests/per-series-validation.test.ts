/**
 * Regression tests for Phase 0.b.7 per-series validation.
 * The runner's coverage check lives in scripts/autoresearch/lib/series-validation.ts
 * and is pure (no I/O) so tests can exercise it directly.
 */
import { describe, expect, it } from 'vitest';
import {
  summarizeTickerSeries,
  validatePerSeriesCoverage,
  computeTickerCoverageHash,
  type TickerSeriesSummary,
} from '../scripts/autoresearch/lib/series-validation';
import type { DatasetManifest } from '../scripts/autoresearch/lib/dataset-manifest';

function baseManifest(overrides?: Partial<DatasetManifest>): DatasetManifest {
  return {
    manifestVersion: 2,
    dataStartDate: '2017-01-01',
    dataEndDate: '2026-02-28',
    holdoutStartDate: '2024-01-22',
    holdoutEndDate: '2026-02-28',
    generatedAt: '2026-04-19T00:00:00Z',
    tickers: {
      COIN: { dataStart: '2021-04-14' },
    },
    ...overrides,
  };
}

function series(first: string, last: string, count = 100): TickerSeriesSummary {
  return { firstCandle: first, lastCandle: last, candleCount: count };
}

/** Build a pair of consistent SPY date lists for tests.
 *  `marketContextDates` = candle dates inclusive.
 *  `spyBenchmarkDates` = marketContextDates.slice(1) (return dates skip day 1). */
function makeSpyPair(firstCandle: string, lastCandle: string, interiorDates: string[] = []): { marketContextDates: string[]; spyBenchmarkDates: string[] } {
  const sorted = [firstCandle, ...interiorDates, lastCandle].sort();
  return { marketContextDates: sorted, spyBenchmarkDates: sorted.slice(1) };
}

function fullSpyPair(m: DatasetManifest) {
  return makeSpyPair(m.dataStartDate, m.dataEndDate, []);
}

describe('summarizeTickerSeries', () => {
  it('returns nulls for empty', () => {
    const s = summarizeTickerSeries([]);
    expect(s).toEqual({ firstCandle: null, lastCandle: null, candleCount: 0 });
  });

  it('returns first/last across unsorted input', () => {
    const s = summarizeTickerSeries([
      { date: '2020-06-15' },
      { date: '2017-01-03' },
      { date: '2026-02-28' },
      { date: '2023-08-11' },
    ]);
    expect(s).toEqual({ firstCandle: '2017-01-03', lastCandle: '2026-02-28', candleCount: 4 });
  });
});

describe('validatePerSeriesCoverage', () => {
  const m = baseManifest();

  it('accepts a full-coverage portfolio', () => {
    const spy = fullSpyPair(m);
    const r = validatePerSeriesCoverage(
      {
        AAPL: series(m.dataStartDate, m.dataEndDate, 2300),
        MSFT: series(m.dataStartDate, m.dataEndDate, 2300),
      },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses when a non-IPO ticker starts late', () => {
    const spy = fullSpyPair(m);
    const r = validatePerSeriesCoverage(
      { AAPL: series('2020-01-02', m.dataEndDate, 1500) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/AAPL/);
  });

  it('refuses when a ticker ends early (stale cache)', () => {
    const spy = fullSpyPair(m);
    const r = validatePerSeriesCoverage(
      { AAPL: series(m.dataStartDate, '2025-10-01', 2000) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/AAPL.*(BEFORE|more than)/i);
  });

  it('accepts an IPO ticker with a matching override', () => {
    const spy = fullSpyPair(m);
    const r = validatePerSeriesCoverage(
      { COIN: series('2021-04-14', m.dataEndDate, 800) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses an IPO ticker whose data starts after the declared override', () => {
    const spy = fullSpyPair(m);
    const r = validatePerSeriesCoverage(
      { COIN: series('2022-01-01', m.dataEndDate, 600) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/COIN/);
  });

  it('refuses an unlisted ticker even if it IPO’d recently (override required)', () => {
    const spy = fullSpyPair(m);
    const r = validatePerSeriesCoverage(
      { PLTR: series('2020-09-30', m.dataEndDate, 1200) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/PLTR/);
    if (!r.ok) expect(r.hint).toMatch(/--add-ticker-start/);
  });

  it('refuses when the SPY candle series ends early', () => {
    const spy = makeSpyPair(m.dataStartDate, '2025-10-01');
    const r = validatePerSeriesCoverage(
      { AAPL: series(m.dataStartDate, m.dataEndDate, 2300) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/SPY candle series ends/);
  });

  it('refuses when the SPY candle series starts after dataStartDate', () => {
    const spy = makeSpyPair('2017-02-01', m.dataEndDate);
    const r = validatePerSeriesCoverage(
      { AAPL: series(m.dataStartDate, m.dataEndDate, 2300) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/SPY candle series starts/);
  });

  it('accepts benchmark dates that are market-context dates minus the first day', () => {
    // Real-world pattern: market-context has all candle dates, benchmark
    // has return dates (= candles from index 1 onward). Must pass.
    const market = ['2017-01-01', '2017-01-02', '2017-01-03', m.dataEndDate];
    const bench = ['2017-01-02', '2017-01-03', m.dataEndDate];
    const r = validatePerSeriesCoverage(
      { AAPL: series(m.dataStartDate, m.dataEndDate, 2300) },
      bench, market, m,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses when benchmark has an interior gap vs market-context', () => {
    const market = ['2017-01-01', '2017-01-02', '2017-01-03', '2017-01-04', m.dataEndDate];
    // Benchmark missing 2017-01-03 in the interior:
    const bench = ['2017-01-02', '2017-01-04', m.dataEndDate];
    const r = validatePerSeriesCoverage(
      { AAPL: series(m.dataStartDate, m.dataEndDate, 2300) },
      bench, market, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/count.*does not match|diverge/i);
  });

  it('refuses when benchmark has a count mismatch vs market-context', () => {
    const market = ['2017-01-01', '2017-01-02', m.dataEndDate];
    // Benchmark has one extra date (inconsistent count).
    const bench = ['2017-01-02', '2017-01-03', m.dataEndDate];
    const r = validatePerSeriesCoverage(
      { AAPL: series(m.dataStartDate, m.dataEndDate, 2300) },
      bench, market, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/count|diverge/i);
  });

  it('refuses when a ticker has zero candles', () => {
    const spy = fullSpyPair(m);
    const r = validatePerSeriesCoverage(
      { AAPL: { firstCandle: null, lastCandle: null, candleCount: 0 } },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/zero candles/);
  });

  // Codex Phase 0.b.7 round-2 F1: manifest dataStartDate=2017-01-01 (Sunday)
  // and dataEndDate=2026-02-28 (Saturday). Real cache starts 2017-01-03 and
  // ends 2026-02-27. Must pass due to 10-day weekend/holiday slack.
  it('accepts data starting / ending on the nearest trading day when manifest bounds fall on a weekend', () => {
    const spy = {
      marketContextDates: ['2017-01-03', '2017-01-04', '2026-02-26', '2026-02-27'],
      spyBenchmarkDates: ['2017-01-04', '2026-02-26', '2026-02-27'],
    };
    const r = validatePerSeriesCoverage(
      { AAPL: series('2017-01-03', '2026-02-27', 2300) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses data that is more than 10 days past the slack window', () => {
    const spy = fullSpyPair(m);
    // AAPL starts 2017-01-20 — 19 days after manifest dataStartDate.
    const r = validatePerSeriesCoverage(
      { AAPL: series('2017-01-20', m.dataEndDate, 2280) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/AAPL.*more than 10 days/);
  });

  // Codex Phase 0.b.7 round-3 F1: per-ticker overrides must be exact
  // (no slack). Manifest declares COIN: 2021-04-14; a cache starting
  // 2021-04-20 (4 trading days late) must be REFUSED.
  it('refuses an IPO ticker whose first candle is any day after the exact override', () => {
    const spy = fullSpyPair(m);
    const r = validatePerSeriesCoverage(
      { COIN: series('2021-04-20', m.dataEndDate, 820) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/COIN.*AFTER.*override is exact/i);
  });

  it('refuses an IPO ticker one calendar day after the exact override', () => {
    const spy = fullSpyPair(m);
    // 2021-04-15 is one day after the 2021-04-14 override. No slack on overrides.
    const r = validatePerSeriesCoverage(
      { COIN: series('2021-04-15', m.dataEndDate, 819) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(false);
  });

  it('accepts an IPO ticker with a first candle exactly on the override', () => {
    const spy = fullSpyPair(m);
    const r = validatePerSeriesCoverage(
      { COIN: series('2021-04-14', m.dataEndDate, 820) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts an IPO ticker with a first candle BEFORE the override (e.g. cache has earlier data)', () => {
    const spy = fullSpyPair(m);
    // Earlier-than-override is fine — the override says "must cover AT LEAST
    // this date," earlier data is extra coverage.
    const r = validatePerSeriesCoverage(
      { COIN: series('2021-04-13', m.dataEndDate, 821) },
      spy.spyBenchmarkDates, spy.marketContextDates, m,
    );
    expect(r.ok).toBe(true);
  });
});

describe('computeTickerCoverageHash', () => {
  it('is stable under key reordering', () => {
    const a = computeTickerCoverageHash({
      AAPL: series('2017-01-03', '2026-02-27'),
      MSFT: series('2017-01-03', '2026-02-27'),
    });
    const b = computeTickerCoverageHash({
      MSFT: series('2017-01-03', '2026-02-27'),
      AAPL: series('2017-01-03', '2026-02-27'),
    });
    expect(a).toBe(b);
  });

  it('changes when any ticker boundary changes', () => {
    const a = computeTickerCoverageHash({
      AAPL: series('2017-01-03', '2026-02-27'),
    });
    const b = computeTickerCoverageHash({
      AAPL: series('2017-01-03', '2026-02-28'),
    });
    expect(a).not.toBe(b);
  });

  it('changes when a ticker count changes even with same endpoints', () => {
    const a = computeTickerCoverageHash({ AAPL: series('2017-01-03', '2026-02-27', 2100) });
    const b = computeTickerCoverageHash({ AAPL: series('2017-01-03', '2026-02-27', 2099) });
    expect(a).not.toBe(b);
  });

  it('returns a 64-hex sha256', () => {
    const h = computeTickerCoverageHash({ AAPL: series('2017-01-03', '2026-02-27') });
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});
