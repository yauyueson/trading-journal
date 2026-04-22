/**
 * Phase E1 Task 11 — oracle replay test.
 *
 * For each scenario in tests/fixtures/pmcc-reference-scenarios.json:
 *   1. Call simulateDiagonal using real cached chain data.
 *   2. Assert combined P&L matches expectedCombinedPnl within tolerancePct of capital.
 *
 * Skipped gracefully on fresh clones without data/option-chains.sqlite.
 *
 * allDates is derived from the SQLite cache (not a calendar generator) to avoid
 * market holidays (e.g. 2023-04-07 Good Friday) that are absent from the cache
 * and would trigger ORATS API calls → 401 errors in offline runs.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'fs';
import { initDB } from '../src/lib/backtest/chain-cache';
import { simulateDiagonal, DEFAULT_LEAP_CONFIG } from '../src/lib/backtest/option-sim';
import type { SimConfig } from '../src/lib/backtest/option-sim';

const FIXTURE_PATH = 'tests/fixtures/pmcc-reference-scenarios.json';
const CACHE_PATH = 'data/option-chains.sqlite';

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
const cachePresent = fs.existsSync(CACHE_PATH);

(cachePresent ? describe : describe.skip)('PMCC oracle replay', () => {
  let db: ReturnType<typeof initDB>;

  beforeAll(() => {
    // Open writable (not readonly) so isCovered() can write fetch_log entries
    // if needed, preventing ORATS API calls for already-cached dates.
    db = initDB(CACHE_PATH);
  });

  for (const s of fixture.scenarios) {
    it(s.label, async () => {
      // Build allDates from the cache — only actual trading days that are present.
      // This excludes market holidays (e.g. 2023-04-07 Good Friday) that the
      // weekday-only calendar generator would incorrectly include.
      const allDates = (db.prepare(
        `SELECT DISTINCT trade_date FROM option_chains
         WHERE ticker = 'QQQ' AND trade_date >= ? AND trade_date <= ?
         ORDER BY trade_date`,
      ).all(s.entryDate, s.exitDate) as { trade_date: string }[]).map(r => r.trade_date);

      if (allDates.length === 0) {
        console.warn(`[oracle:${s.label}] no cached dates for ${s.entryDate}..${s.exitDate} — skipping`);
        return;
      }

      const cfg = fixture._config;
      const config: SimConfig = {
        ...DEFAULT_LEAP_CONFIG,
        mode: 'DIAGONAL',
        diagLongDeltaRange: cfg.diagLongDeltaRange as [number, number],
        diagLongDTERange: s.longEntryDTERange as [number, number],
        diagShortDeltaRange: cfg.diagShortDeltaRange as [number, number],
        diagShortDTERange: s.shortEntryDTERange as [number, number],
        diagLongProfitTarget: cfg.diagLongProfitTarget,
        diagLongStopLoss: cfg.diagLongStopLoss,
        diagLongTimeStopDTE: cfg.diagLongTimeStopDTE,
        diagShortProfitTarget: cfg.diagShortProfitTarget,
        diagRollTriggerMoneyness: cfg.diagRollTriggerMoneyness,
        monitoringIntervalDays: 1,
        fillMode: 'mid',
        slippage: { ...DEFAULT_LEAP_CONFIG.slippage, enabled: false },
      };

      const signal = { ticker: 'QQQ', date: s.entryDate, direction: 'CALL' as const, score: 0 };
      const trade = await simulateDiagonal('', signal, config, allDates, s.exitDate);

      expect(trade, `[oracle:${s.label}] simulateDiagonal returned null`).not.toBeNull();

      const capital = (s.entryLongPremium - s.entryShortCredit) * 100;
      const tolerance = Math.abs(capital * s.tolerancePct);
      const gap = Math.abs(trade!.pnl - s.expectedCombinedPnl);

      if (gap > tolerance) {
        console.error(
          `[oracle:${s.label}] P&L mismatch: gap=${gap.toFixed(4)} tol=${tolerance.toFixed(4)} ` +
          `got=${trade!.pnl.toFixed(4)} expected=${s.expectedCombinedPnl}`,
        );
        if (trade!.diagonalLegs) {
          const lc = trade!.diagonalLegs.longCall;
          console.error(`  long: strike=${lc.strike} entry=${lc.entryPrice?.toFixed(5)} exit=${lc.exitPrice?.toFixed(5)} reason=${lc.exitReason}`);
          for (const [i, sc] of trade!.diagonalLegs.shortCallCycles.entries()) {
            console.error(`  short[${i}]: strike=${sc.strike} entry=${sc.entryCredit?.toFixed(5)} exit=${sc.exitCost?.toFixed(5)} reason=${sc.exitReason}`);
          }
        }
      }

      expect(gap).toBeLessThanOrEqual(tolerance);
    });
  }
});
