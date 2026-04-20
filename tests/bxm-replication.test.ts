/**
 * Phase 0.c.9.B — CBOE BXM replication regression.
 *
 * Two layers of defence:
 *
 *   1. Snapshot sanity (always runs): loads the committed
 *      `data/bxm-replication-results.json` and asserts the full-window
 *      correlation / coverage / residuals are within expected ranges.
 *      This catches accidental corruption of the snapshot itself but
 *      would NOT catch a simulator regression if the snapshot weren't
 *      refreshed. Hence the second layer.
 *
 *   2. Live re-run (skipIf cache missing): actually calls
 *      `simulateBuyWrite` for a bounded sub-window and asserts that the
 *      per-cycle trade P&L numbers match the snapshot within tight
 *      tolerance. A regression in simulateBuyWrite, findStrikeByDelta,
 *      applyFill, the walk-back logic, or the pairing math will show up
 *      here as a value mismatch, even if the snapshot is never touched.
 *
 * The committed snapshot was produced on 2026-04-19 at Phase 0.c.9.A
 * across 107 monthly cycles (2017-2026 SPY). Correlation: 0.9665.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  simulateBuyWrite,
  DEFAULT_CREDIT_CONFIG,
  isThirdFriday,
  type EntrySignal,
  type SimConfig,
} from '../src/lib/backtest/option-sim';

const RESULTS_PATH = path.resolve(process.cwd(), 'data/bxm-replication-results.json');
const CACHE_PATH = path.resolve(process.cwd(), 'data/option-chains.sqlite');
const RESULTS_EXIST = fs.existsSync(RESULTS_PATH);
const CACHE_EXISTS = fs.existsSync(CACHE_PATH);

interface Pair { month: string; entryDate: string; exitDate: string; bxm: number; rep: number; residual: number; }
interface ResultsFile {
  summary: {
    window: { start: string; end: string; months: number };
    correlation: number;
    meanMonthlyReturn: { bxm: number; rep: number };
    annualizedReturnGap: number;
    residualSd: number;
    maxAbsResidual: number;
  };
  pairs: Pair[];
}

// ── Layer 1: Snapshot sanity ──────────────────────────────
describe.skipIf(!RESULTS_EXIST)('BXM replication snapshot (Phase 0.c.9.B)', () => {
  const data = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8')) as ResultsFile;

  it('snapshot covers the full 2017-2026 window (≥100 monthly cycles)', () => {
    // Tightened from >=60 after Codex round 2 noted 60 was too permissive
    // given the full window is 107 cycles — a regression that drops 3-4
    // years of coverage would still slip through at 60.
    expect(data.pairs.length).toBeGreaterThanOrEqual(100);
    expect(data.summary.window.months).toBe(data.pairs.length);
  });

  it('snapshot correlation with published BXM is ≥ 0.85 (recomputed)', () => {
    const recomputed = pearson(data.pairs.map(p => p.bxm), data.pairs.map(p => p.rep));
    expect(recomputed).toBeGreaterThanOrEqual(0.85);
    expect(Math.abs(recomputed - data.summary.correlation)).toBeLessThan(1e-6);
  });

  it('snapshot annualized return gap is within ±2%', () => {
    // The replication currently runs without a dividendSchedule; SPY's
    // stock_price already reflects the ex-date price drop, so the gap
    // captures all systematic methodology differences (total-return
    // BXM vs price-return-adjusted SPY close, fill model, etc). A value
    // outside ±2%/yr would indicate a fill-model, roll-date, or notional bug.
    expect(Math.abs(data.summary.annualizedReturnGap)).toBeLessThan(0.02);
  });

  it('snapshot residual σ is modest (<2% monthly)', () => {
    expect(data.summary.residualSd).toBeLessThan(0.02);
  });

  it('snapshot rep sign-flip destroys correlation (smoke for spurious signal)', () => {
    const inverted = pearson(data.pairs.map(p => p.bxm), data.pairs.map(p => -p.rep));
    expect(inverted).toBeLessThan(-0.5);
  });
});

// ── Layer 2: Live simulator regression ────────────────────
// Re-runs simulateBuyWrite over a fixed, small window and compares its
// output to the committed snapshot. A simulator/pairing regression will
// fail here even if the snapshot itself is untouched.
describe.skipIf(!CACHE_EXISTS || !RESULTS_EXIST)(
  'BXM replication live re-run (Phase 0.c.9.B)',
  () => {
    const snapshot = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8')) as ResultsFile;

    it(
      'simulateBuyWrite reproduces per-cycle P&L within 1e-6 on a 2023 sub-window',
      { timeout: 120_000 },
      async () => {
        // Dynamic imports keep the test cheap when skipped (no SQLite).
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(CACHE_PATH, { readonly: true });
        const rows = db.prepare(
          `SELECT trade_date FROM fetch_log
           WHERE ticker='SPY' AND rows_fetched > 0
           ORDER BY trade_date`,
        ).all() as Array<{ trade_date: string }>;
        db.close();
        const spyDates = rows.map(r => r.trade_date);

        // Fixed sub-window: 2023 calendar year + a buffer on each side.
        // Gives ~12 monthly cycles, enough to be a meaningful check
        // without running the full 9 years in CI.
        const winStart = '2022-12-01';
        const winEnd = '2024-01-31';
        const window = spyDates.filter(d => d >= winStart && d <= winEnd);
        if (window.length < 200) {
          console.warn(`[0.c.9.B live] sub-window too short (${window.length} days) — skipping`);
          return;
        }

        // Re-discover the same roll dates the replication script uses.
        const allRollDates: string[] = [];
        let lastMonth = '';
        for (let i = 1; i < window.length; i++) {
          const prev = window[i - 1], d = window[i];
          const ms = Date.parse(`${prev}T00:00:00Z`);
          const msD = Date.parse(`${d}T00:00:00Z`);
          for (let t = ms + 86_400_000; t < msD; t += 86_400_000) {
            const iso = new Date(t).toISOString().slice(0, 10);
            if (isThirdFriday(iso)) {
              const ym = d.slice(0, 7);
              if (ym !== lastMonth) { allRollDates.push(d); lastMonth = ym; }
              break;
            }
          }
        }
        // Drop the last roll — its expiry (~30 days later) is outside
        // our sub-window, so the simulator would force-close early
        // here while the snapshot (run against the full cache) lets it
        // settle at true expiration. Comparing those two differently-
        // exited trades is a boundary artifact, not a regression.
        const rollDates = allRollDates.slice(0, -1);
        expect(rollDates.length).toBeGreaterThanOrEqual(10);

        // Match the script's config exactly so we can compare outputs.
        const config: SimConfig = {
          ...DEFAULT_CREDIT_CONFIG,
          creditDTERange: [25, 40],
          fillMode: 'mid',
          monitoringIntervalDays: 1,
          requireMonthlyExpiry: true,
          minIVRank: 0, vrpFilter: 0, contangoFilter: 0,
          vrpPctFilter: 0, contangoPctFilter: 0, slopeFilter: 0,
        };

        const snapshotByEntry = new Map(snapshot.pairs.map(p => [p.entryDate, p]));
        const maxDate = window[window.length - 1];
        let matches = 0, checked = 0, tolerance = 1e-6;
        const mismatches: string[] = [];

        for (const rollDate of rollDates) {
          const snap = snapshotByEntry.get(rollDate);
          if (!snap) continue; // cycle outside snapshot — skip
          checked++;
          const signal: EntrySignal = { ticker: 'SPY', date: rollDate, direction: 'CALL', score: 50 };
          const trade = await simulateBuyWrite('', signal, config, window, maxDate);
          if (!trade) {
            mismatches.push(`${rollDate}: simulator returned null (was non-null in snapshot)`);
            continue;
          }
          const notional = 100 * (trade.stockLeg?.entryPrice ?? trade.entryStockPrice ?? 0);
          const repRet = notional > 0 ? trade.pnl / notional : 0;
          if (Math.abs(repRet - snap.rep) <= tolerance) {
            matches++;
          } else {
            mismatches.push(
              `${rollDate}: rep ${repRet.toFixed(8)} vs snapshot ${snap.rep.toFixed(8)} ` +
              `(Δ ${(repRet - snap.rep).toExponential(3)})`,
            );
          }
        }

        // We need enough cycles to be a meaningful check AND all of
        // them must match within tolerance. The exact-match assertion is
        // what catches simulator regressions — correlation-only tests
        // would miss a uniform +0.5%/cycle drift entirely.
        expect(checked).toBeGreaterThanOrEqual(8);
        if (mismatches.length > 0) {
          throw new Error(
            `${mismatches.length}/${checked} cycles disagree with snapshot:\n  ` +
            mismatches.slice(0, 5).join('\n  '),
          );
        }
        expect(matches).toBe(checked);
      },
    );
  },
);

// ── Fresh-clone placeholder ───────────────────────────────
describe.skipIf(RESULTS_EXIST)('BXM replication (skipped: results absent)', () => {
  it('notes that data/bxm-replication-results.json must be generated by scripts/replicate-bxm.ts', () => {
    console.warn('[0.c.9.B] data/bxm-replication-results.json not found; BXM replication tests skipped.');
    expect(RESULTS_EXIST).toBe(false);
  });
});

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0 || n !== ys.length) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}
