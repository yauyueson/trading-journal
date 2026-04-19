/**
 * series-validation — Phase 0.b.7
 *
 * Per-series coverage check for the autoresearch runner. Closes the
 * round-3 F1 Codex gap where `allTradingDates` union-masking let a single
 * intact ticker hide truncation in others.
 *
 * Each ticker's candle series must span [resolveTickerStart(t), manifest.
 * dataEndDate]. SPY benchmark + market context must span the full manifest
 * data range. On any violation, returns a structured failure that the
 * runner converts to a fatal console error.
 *
 * Also computes `tickerCoverageHash` — a canonical sha256 of the per-
 * ticker first/last-candle summary that gets stamped onto every RunResult
 * for post-hoc audit (and verified by the seal ceremony).
 */
import crypto from 'crypto';
import { resolveTickerStart, type DatasetManifest } from './dataset-manifest';

/**
 * Weekend/holiday slack between a calendar-date manifest boundary and the
 * actual first/last trading day in a candle series. The manifest typically
 * declares calendar bounds (e.g. 2017-01-01), but the cache only has
 * trading days (2017-01-03). The longest US market closure around the
 * New Year is ~5 calendar days (weekend + holiday). 10 days is a safe
 * upper bound that still refuses truly truncated data.
 * Codex Phase 0.b.7 round-2 F1.
 */
const BOUNDARY_SLACK_DAYS = 10;

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface TickerSeriesSummary {
  /** Earliest candle date on this ticker, inclusive. Empty series → null. */
  firstCandle: string | null;
  /** Latest candle date on this ticker, inclusive. */
  lastCandle: string | null;
  /** Total candle count (for logging). */
  candleCount: number;
}

export interface SeriesValidationOk {
  ok: true;
  tickerCoverageHash: string;
  perTicker: Record<string, TickerSeriesSummary>;
}

export interface SeriesValidationFail {
  ok: false;
  reason: string;
  hint?: string;
}

export type SeriesValidationOutcome = SeriesValidationOk | SeriesValidationFail;

/** Extract ticker summary from a series of {date, ...} objects. */
export function summarizeTickerSeries(candles: ReadonlyArray<{ date: string }>): TickerSeriesSummary {
  if (candles.length === 0) {
    return { firstCandle: null, lastCandle: null, candleCount: 0 };
  }
  // The runner's candles are already sorted ascending by construction;
  // defensive min/max here catches any caller that passes unsorted data.
  let first = candles[0].date;
  let last = candles[0].date;
  for (const c of candles) {
    if (c.date < first) first = c.date;
    if (c.date > last) last = c.date;
  }
  return { firstCandle: first, lastCandle: last, candleCount: candles.length };
}

/**
 * Validate a map of loaded ticker series + SPY series against the manifest.
 *
 * Phase 0.b.7 round-1 (Codex F1+F2): SPY coverage is validated against the
 * market-context SPY series because it carries actual candle dates. The
 * benchmark's `dates[]` are return dates — one trading day later than the
 * first candle — and would fail an equality bound check even for correct
 * input. We instead use marketContext's dates for bounds and then cross-
 * check the benchmark by asserting its full date list equals the market-
 * context's date list dropped by one leading entry.
 *
 * @param tickerSeries         per-ticker summaries.
 * @param spyBenchmarkDates    FULL sorted list of SPY benchmark return dates.
 *                             These align with candle[1..N-1] of the candle series.
 * @param marketContextDates   FULL sorted list of market-context SPY candle dates.
 *                             Align with candle[0..N-1] of the candle series.
 * @param manifest             loaded dataset manifest.
 */
export function validatePerSeriesCoverage(
  tickerSeries: Record<string, TickerSeriesSummary>,
  spyBenchmarkDates: readonly string[],
  marketContextDates: readonly string[],
  manifest: DatasetManifest,
): SeriesValidationOutcome {
  // Per-ticker coverage.
  //
  // Slack policy (Codex round-3 F1): boundary slack only applies to
  // UNLISTED tickers, whose required start is manifest.dataStartDate — a
  // calendar boundary that may fall on a non-trading day. For LISTED
  // tickers (per-ticker overrides), the override is assumed to be a
  // concrete IPO/first-trading-day and is enforced EXACTLY (firstCandle
  // must be <= override with no slack). Otherwise a cache starting a week
  // after the declared IPO would silently slip through — reintroducing
  // the per-series truncation this phase was supposed to close.
  //
  // The last-candle check uses slack regardless because manifest.
  // dataEndDate is always a calendar boundary.
  for (const [symbol, summary] of Object.entries(tickerSeries)) {
    const effectiveStart = resolveTickerStart(symbol, manifest);
    const hasOverride = manifest.tickers?.[symbol]?.dataStart != null;
    const maxAcceptableFirst = hasOverride ? effectiveStart : addDays(effectiveStart, BOUNDARY_SLACK_DAYS);
    const minAcceptableLast = addDays(manifest.dataEndDate, -BOUNDARY_SLACK_DAYS);
    if (summary.firstCandle == null || summary.lastCandle == null) {
      return {
        ok: false,
        reason: `Ticker ${symbol}: loaded zero candles (empty series). Either fetch data or remove the ticker.`,
      };
    }
    if (summary.firstCandle > maxAcceptableFirst) {
      const override = manifest.tickers?.[symbol]?.dataStart;
      const hintPrefix = override
        ? `Manifest declares ${symbol}.dataStart=${override} (required exactly — no slack on explicit overrides), but the loaded data starts at ${summary.firstCandle}.`
        : `Manifest has no ${symbol} override, so ${symbol} must cover dataStartDate (${manifest.dataStartDate}) within ${BOUNDARY_SLACK_DAYS} days. Loaded data starts at ${summary.firstCandle}.`;
      return {
        ok: false,
        reason: hasOverride
          ? `Ticker ${symbol} data starts at ${summary.firstCandle}, AFTER required start ${effectiveStart} (override is exact).`
          : `Ticker ${symbol} data starts at ${summary.firstCandle}, more than ${BOUNDARY_SLACK_DAYS} days after required start ${effectiveStart}.`,
        hint: `${hintPrefix} Either refresh the cache, or update config/dataset-manifest.json (--add-ticker-start ${symbol} ${summary.firstCandle}) if the later start is intentional.`,
      };
    }
    if (summary.lastCandle < minAcceptableLast) {
      return {
        ok: false,
        reason: `Ticker ${symbol} data ends at ${summary.lastCandle}, more than ${BOUNDARY_SLACK_DAYS} days before manifest dataEndDate ${manifest.dataEndDate}. Likely stale cache or truncated fetch.`,
        hint: `Re-run scripts/autoresearch/prefetch-data.ts (or equivalent) to refresh the cache, then re-run.`,
      };
    }
  }

  // SPY candle coverage — validated via the market-context series, which
  // carries actual candle dates (not return dates, which would be off-by-one).
  // Same weekend/holiday slack as per-ticker coverage.
  if (marketContextDates.length === 0) {
    return { ok: false, reason: `Market-context SPY series is empty.` };
  }
  const spyCandleFirst = marketContextDates[0];
  const spyCandleLast = marketContextDates[marketContextDates.length - 1];
  const spyMaxAcceptableFirst = addDays(manifest.dataStartDate, BOUNDARY_SLACK_DAYS);
  const spyMinAcceptableLast = addDays(manifest.dataEndDate, -BOUNDARY_SLACK_DAYS);
  if (spyCandleFirst > spyMaxAcceptableFirst) {
    return {
      ok: false,
      reason: `SPY candle series starts at ${spyCandleFirst}, more than ${BOUNDARY_SLACK_DAYS} days after manifest dataStartDate ${manifest.dataStartDate}.`,
      hint: `Refresh the cache — SPY must cover the full manifest range.`,
    };
  }
  if (spyCandleLast < spyMinAcceptableLast) {
    return {
      ok: false,
      reason: `SPY candle series ends at ${spyCandleLast}, more than ${BOUNDARY_SLACK_DAYS} days before manifest dataEndDate ${manifest.dataEndDate}.`,
      hint: `Refresh the SPY cache.`,
    };
  }

  // Cross-check the two SPY sources against each other. The benchmark's
  // return dates equal the candle dates from index 1 onward (close-to-close
  // returns skip the first candle). Verify the full date sequences are
  // consistent, not just endpoints — catches an interior gap that would
  // leave endpoints matched. Closes Codex round-1 F2.
  if (spyBenchmarkDates.length === 0) {
    return { ok: false, reason: `SPY benchmark series is empty.` };
  }
  const expectedBenchDates = marketContextDates.slice(1);
  if (spyBenchmarkDates.length !== expectedBenchDates.length) {
    return {
      ok: false,
      reason: `SPY benchmark date count (${spyBenchmarkDates.length}) does not match marketContext date count - 1 (${expectedBenchDates.length}). ` +
        `Likely one SPY source has an interior gap the other doesn't.`,
      hint: `Refresh the cache or investigate cache vs Supabase drift.`,
    };
  }
  for (let i = 0; i < spyBenchmarkDates.length; i++) {
    if (spyBenchmarkDates[i] !== expectedBenchDates[i]) {
      return {
        ok: false,
        reason: `SPY benchmark and market-context SPY diverge at index ${i}: ` +
          `benchmark=${spyBenchmarkDates[i]}, expected=${expectedBenchDates[i]} (from marketContext). ` +
          `Interior date mismatch between SPY sources.`,
        hint: `Refresh the cache or investigate cache vs Supabase drift.`,
      };
    }
  }

  return {
    ok: true,
    tickerCoverageHash: computeTickerCoverageHash(tickerSeries),
    perTicker: tickerSeries,
  };
}

/**
 * Canonical sha256 of the per-ticker first/last-candle summary. Does NOT
 * include SPY — the SPY series is validated to match manifest exactly, so
 * it contributes no variation. The hash is stamped onto every RunResult
 * and verified by the seal ceremony.
 */
export function computeTickerCoverageHash(series: Record<string, TickerSeriesSummary>): string {
  const lines = Object.entries(series)
    .map(([symbol, s]) => `${symbol}:${s.firstCandle ?? ''}..${s.lastCandle ?? ''}:${s.candleCount}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}
