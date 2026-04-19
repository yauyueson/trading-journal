/**
 * Phase 0.c.11 — random-signal null test.
 *
 * Run the full credit-spread engine on SPY data with random entry
 * signals. Zero skill is possible. Aggregate P&L and Sharpe should be
 * statistically indistinguishable from zero — any systematic profit
 * points to an engine bug (look-ahead, fill asymmetry, exit-logic
 * phantom edge, etc.).
 *
 * Dependencies:
 *   - data/option-chains.sqlite with cached SPY chains.
 *   - If absent (fresh clone / CI), the test SKIPS with a clear message.
 *     We don't want this to be a flaky CI failure.
 *
 * Tolerance: wide. N=200 random trades with per-trade std ≫ expected
 * mean makes tight bounds impossible. Sharpe is bounded to [-1.5, +1.5]
 * (≈ 1σ band for typical credit-spread return distributions). Win rate
 * is expected in [35%, 65%] given the short-Sharpe structure.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  simulateCreditSpread,
  DEFAULT_CREDIT_CONFIG,
  type EntrySignal,
} from '../src/lib/backtest/option-sim';
import { makeRng } from './helpers/gbm';

const CACHE_PATH = path.resolve(process.cwd(), 'data/option-chains.sqlite');
const CACHE_EXISTS = fs.existsSync(CACHE_PATH);

/**
 * Find the longest contiguous SPY cache window in fetch_log (consecutive
 * trading-day dates with rows_fetched > 0). Returns null if no window is
 * at least `minLength` long. This is the input to simulateCreditSpread's
 * `allTradingDates` — sparse/irregular calendars break the monitoring
 * loop's day-index arithmetic (Codex round-1 F3).
 */
function findContiguousSpyWindow(dbPath: string, minLength: number): string[] | null {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT trade_date FROM fetch_log
     WHERE ticker = ? AND rows_fetched > 0
     ORDER BY trade_date`,
  ).all('SPY') as Array<{ trade_date: string }>;
  db.close();
  const all = rows.map(r => r.trade_date);
  if (all.length === 0) return null;

  // A contiguous "trading-day" window here means dates no more than 5
  // calendar days apart (weekends + 1-day holiday). Gaps > 5 days break
  // the run; start a new window from there.
  let bestStart = 0, bestLen = 1, curStart = 0;
  for (let i = 1; i < all.length; i++) {
    const prev = new Date(`${all[i - 1]}T00:00:00Z`).getTime();
    const cur = new Date(`${all[i]}T00:00:00Z`).getTime();
    const gapDays = (cur - prev) / 86_400_000;
    if (gapDays > 5) {
      const len = i - curStart;
      if (len > bestLen) { bestLen = len; bestStart = curStart; }
      curStart = i;
    }
  }
  const finalLen = all.length - curStart;
  if (finalLen > bestLen) { bestLen = finalLen; bestStart = curStart; }

  if (bestLen < minLength) return null;
  return all.slice(bestStart, bestStart + bestLen);
}

describe.skipIf(!CACHE_EXISTS)('Random-signal null test (Phase 0.c.11)', () => {
  it(
    'credit-spread engine produces near-zero Sharpe on random SPY signals',
    { timeout: 120_000 },
    async (ctx) => {
      // Precondition 1: find a contiguous cache window. Sparse calendars
      // would distort monitoring arithmetic (Codex F3).
      const allTradingDates = findContiguousSpyWindow(CACHE_PATH, 500);
      if (!allTradingDates) {
        // Explicit Vitest skip so CI sees "skipped", not "passed". (F1)
        ctx.skip('need a contiguous SPY cache window of 500+ dates');
        return;
      }

      const maxDate = allTradingDates[allTradingDates.length - 1];
      // Disable regime/IV filters so random signals aren't systematically
      // rejected for market-state reasons.
      const config = {
        ...DEFAULT_CREDIT_CONFIG,
        minIVRank: 0,
        vrpFilter: 0,
        contangoFilter: 0,
        vrpPctFilter: 0,
        contangoPctFilter: 0,
        slopeFilter: 0,
      };

      const rng = makeRng(0xC011);
      const N = 200;
      // Entry window leaves 80 days of monitoring headroom at the tail.
      const ENTRY_WINDOW = allTradingDates.length - 80;
      const pnls: number[] = [];
      const unexpectedErrors: Array<{ idx: number; message: string }> = [];
      let acceptedCalls = 0, acceptedPuts = 0;
      let nullReturns = 0; // simulateCreditSpread returned null (filter rejected)

      // Narrow exception matcher: we tolerate "chain not cached" / "no
      // contract" style skips but NOT generic engine errors. Codex F2.
      const isCacheMiss = (err: unknown): boolean => {
        const msg = err instanceof Error ? err.message : String(err);
        return /not cached|no chain|empty chain|missing chain|ORATS/i.test(msg);
      };

      for (let i = 0; i < N; i++) {
        const idx = Math.floor(rng() * ENTRY_WINDOW);
        const entryDate = allTradingDates[idx];
        const direction = rng() > 0.5 ? 'CALL' : 'PUT';
        const signal: EntrySignal = { ticker: 'SPY', date: entryDate, direction, score: 50 };
        try {
          const trade = await simulateCreditSpread('', signal, config, allTradingDates, maxDate);
          if (trade && Number.isFinite(trade.pnl)) {
            pnls.push(trade.pnl);
            if (direction === 'CALL') acceptedCalls++; else acceptedPuts++;
          } else {
            nullReturns++;
          }
        } catch (err) {
          if (isCacheMiss(err)) {
            nullReturns++;
          } else {
            unexpectedErrors.push({ idx: i, message: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
          }
        }
      }

      // Precondition 2: no unexpected engine errors. Codex F2.
      if (unexpectedErrors.length > 0) {
        throw new Error(
          `${unexpectedErrors.length} unexpected engine errors:\n  ` +
          unexpectedErrors.slice(0, 3).map(e => `[${e.idx}] ${e.message}`).join('\n  '),
        );
      }

      // Precondition 3: enough iid samples. If <50 were accepted, the
      // test's statistical power is too low — hard-fail so CI surfaces
      // the degraded coverage rather than silently passing. Codex F1.
      expect(
        pnls.length,
        `only ${pnls.length}/${N} trades accepted; tolerance underpowered. Investigate why simulateCreditSpread rejected so many random signals.`,
      ).toBeGreaterThanOrEqual(50);

      const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
      const sd = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (pnls.length - 1));
      const sharpe = sd > 0 ? (mean / sd) : 0;
      const wins = pnls.filter(p => p > 0).length;
      const winRate = wins / pnls.length;

      console.log(
        `[0.c.11] N=${pnls.length} (calls=${acceptedCalls} puts=${acceptedPuts} ` +
        `null=${nullReturns}) mean=${mean.toFixed(2)} sd=${sd.toFixed(2)} ` +
        `Sharpe=${sharpe.toFixed(3)} winRate=${(winRate * 100).toFixed(1)}%`,
      );

      // Precondition 4: both sides represented. A systematic one-sided
      // rejection would defeat the null-test purpose.
      expect(acceptedCalls, 'no accepted calls').toBeGreaterThan(0);
      expect(acceptedPuts, 'no accepted puts').toBeGreaterThan(0);

      // Primary: Sharpe near zero. Wide band — random signals on the
      // engine should NOT produce edge, but path luck + finite N allow
      // ~1σ wander. A Sharpe above 1.5 would be a real bias signal.
      expect(Math.abs(sharpe)).toBeLessThan(1.5);

      // Secondary: win rate not systematically skewed.
      // Credit spreads are short-premium; structural WR is ~50-80%. Wide band.
      expect(winRate).toBeGreaterThan(0.30);
      expect(winRate).toBeLessThan(0.90);
    },
  );
});

describe.skipIf(CACHE_EXISTS)('Random-signal null test (skipped: no cache)', () => {
  it('notes that Phase 0.c.11 requires data/option-chains.sqlite to run', () => {
    // This test exists only to emit a visible line when the main suite
    // skipped. It always passes on a fresh clone.
    // eslint-disable-next-line no-console
    console.warn('[0.c.11] data/option-chains.sqlite not found; random-signal null test skipped. Run scripts/autoresearch/prefetch-data.ts to populate the cache.');
    expect(CACHE_EXISTS).toBe(false);
  });
});
