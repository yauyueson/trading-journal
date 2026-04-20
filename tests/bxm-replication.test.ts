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
// Re-runs simulateBuyWrite over a fixed sub-window and compares its output
// to the committed snapshot. Catches simulator / fill-model / pairing
// regressions that the snapshot-only layer would miss.
//
// CI coverage caveat (Codex round-3 P2 a): `data/option-chains.sqlite`
// is gitignored (15GB+ ORATS data). GitHub Actions runs `npm test`
// against a fresh checkout with no cache, so this suite skips in CI.
// The snapshot layer above is the CI line of defense; this live layer
// covers local dev, where simulator changes actually get authored.
// Provisioning a fixture DB for CI is tracked as a Phase 1 refinement.
//
// Tolerance caveat (Codex round-3 P2 b): the local cache is ORATS data
// that can be refreshed/corrected, so bit-level match is unstable.
// Using 1e-4 per-cycle (catches ≥ 1 bp return drift, generous against
// vendor data revisions) plus a mean-delta check to trip any uniform
// bias that per-cycle tolerance would individually smooth over.
describe.skipIf(!CACHE_EXISTS || !RESULTS_EXIST)(
  'BXM replication live re-run (Phase 0.c.9.B)',
  () => {
    const snapshot = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8')) as ResultsFile;

    it(
      'simulateBuyWrite reproduces snapshot P&L on a 2023 sub-window',
      { timeout: 120_000 },
      async (ctx) => {
        // Dynamic import keeps the test cheap when skipped (no SQLite).
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(CACHE_PATH, { readonly: true });

        // Readiness check (Codex round-3 P2 c): the required sub-window
        // must have BXM-capable chain coverage — i.e., at least some
        // 25-40 DTE rows for SPY. A LEAP-only prefetch (DTE 60-330)
        // would cause simulateBuyWrite to return null on every cycle,
        // which would fail this test spuriously even though the engine
        // hasn't regressed. Skip with a clear message instead.
        const covRow = db.prepare(
          `SELECT COUNT(*) AS n FROM option_chains
           WHERE ticker='SPY'
             AND trade_date BETWEEN '2022-12-01' AND '2024-01-31'
             AND dte BETWEEN 25 AND 40`,
        ).get() as { n: number };
        if (covRow.n < 1000) {
          ctx.skip(
            `SPY cache has only ${covRow.n} rows at DTE 25-40 in the 2022-12 ` +
            `→ 2024-01 window; need ≥ 1000 for a meaningful BXM re-run. ` +
            `Run prefetch-chains.ts with a DTE range covering 25-40.`,
          );
          db.close();
          return;
        }

        const rows = db.prepare(
          `SELECT trade_date FROM fetch_log
           WHERE ticker='SPY' AND rows_fetched > 0
           ORDER BY trade_date`,
        ).all() as Array<{ trade_date: string }>;
        db.close();
        const spyDates = rows.map(r => r.trade_date);

        // Fixed sub-window: 2023 calendar year + buffer. Gives ~12
        // monthly cycles — enough to catch systematic bugs without
        // running the full 9 years.
        const winStart = '2022-12-01';
        const winEnd = '2024-01-31';
        const window = spyDates.filter(d => d >= winStart && d <= winEnd);
        if (window.length < 200) {
          ctx.skip(`sub-window too short (${window.length} days)`);
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
        // our sub-window, so the simulator would force-close early here
        // while the snapshot (full-window run) settled at true expiration.
        // Comparing those two differently-exited trades is a boundary
        // artifact, not a regression.
        const rollDates = allRollDates.slice(0, -1);
        expect(rollDates.length).toBeGreaterThanOrEqual(10);

        // Match the script's config exactly so outputs are comparable.
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
        const PER_CYCLE_TOL = 1e-4;      // ≥ 1 bp return drift fails
        const MEAN_DELTA_TOL = 5e-5;     // ≥ 5 bp uniform bias fails
        const deltas: number[] = [];
        const mismatches: string[] = [];
        let checked = 0;

        for (const rollDate of rollDates) {
          const snap = snapshotByEntry.get(rollDate);
          if (!snap) continue;
          checked++;
          const signal: EntrySignal = { ticker: 'SPY', date: rollDate, direction: 'CALL', score: 50 };
          const trade = await simulateBuyWrite('', signal, config, window, maxDate);
          if (!trade) {
            mismatches.push(`${rollDate}: simulator returned null (was non-null in snapshot)`);
            continue;
          }
          const notional = 100 * (trade.stockLeg?.entryPrice ?? trade.entryStockPrice ?? 0);
          const repRet = notional > 0 ? trade.pnl / notional : 0;
          const delta = repRet - snap.rep;
          deltas.push(delta);
          if (Math.abs(delta) > PER_CYCLE_TOL) {
            mismatches.push(
              `${rollDate}: rep ${repRet.toFixed(6)} vs snapshot ${snap.rep.toFixed(6)} ` +
              `(Δ ${delta.toExponential(3)})`,
            );
          }
        }

        expect(checked).toBeGreaterThanOrEqual(8);
        if (mismatches.length > 0) {
          throw new Error(
            `${mismatches.length}/${checked} cycles exceed per-cycle tol ${PER_CYCLE_TOL}:\n  ` +
            mismatches.slice(0, 5).join('\n  '),
          );
        }
        // Uniform-bias check: if every cycle drifts +0.0005 in the same
        // direction, per-cycle tolerance would pass but the simulator
        // would be consistently biased. Catch that via mean-delta.
        const meanDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
        expect(Math.abs(meanDelta)).toBeLessThan(MEAN_DELTA_TOL);
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
