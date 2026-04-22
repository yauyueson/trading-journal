/**
 * Phase E1 Task 11 — oracle fixture data harvester.
 *
 * Prints real QQQ chain rows for three canonical PMCC scenarios. Run once to
 * harvest the numbers, then hand-compute expected P&L and paste into
 * tests/fixtures/pmcc-reference-scenarios.json.
 *
 * Usage: npx tsx scripts/build-pmcc-oracle-fixture.ts
 *
 * ── Adjustments from initial plan SCENARIOS list ────────────────────────────
 *
 * Initial plan targets were calibrated for QQQ ~$300 in 2023-03 but QQQ
 * was actually at $305-$365 in the study window. All three scenarios were
 * adjusted after probing the cache:
 *
 * happy (entry 2023-03-20, spot 305.56):
 *   - longStrikeTarget: 290 → 280  (delta 0.720, closest to 0.725 midpoint)
 *   - shortStrikeTarget: 330 → 322 (delta 0.243, closest to 0.25 midpoint)
 *   - longExpiry 2023-12-15 kept as-is (available in cache)
 *   - shortExpiry 2023-04-21 kept as-is
 *
 * rolled (entry 2023-05-15, spot 326.5):
 *   - longStrikeTarget: 315 → 300  (delta 0.736, closest to 0.725 midpoint)
 *   - shortStrikeTarget: 345 → 339 (delta 0.241, closest to 0.25 midpoint)
 *   - longExpiry 2024-01-19 kept as-is
 *   - shortExpiry 2023-06-16 kept as-is
 *   - exitDate 2023-06-09 → long actually exits 2023-05-30 via PROFIT_TARGET
 *     (+42% gain on long). The maxDate=2023-06-09 is still valid but the
 *     trade resolves earlier. The fixture records the actual exit date.
 *
 * drawdown (entry 2023-08-21, spot 364.28):
 *   - longStrikeTarget: 345 → 340  (delta 0.724, closest to 0.725 midpoint)
 *   - shortStrikeTarget: 380 kept (delta 0.259, closest to 0.25 midpoint)
 *   - longExpiry 2024-06-21 kept as-is (available in cache)
 *   - shortExpiry 2023-09-15 kept as-is
 *
 * ── allDates note ────────────────────────────────────────────────────────────
 *
 * allDates must contain ONLY dates present in the SQLite cache.  The
 * weekday-generator in the plan includes market holidays (e.g. 2023-04-07
 * Good Friday) which are absent from the cache, causing ORATS 401 errors.
 * The harvester and test both query the DB to build allDates.
 */

import { initDB, getCachedChain, findStrikeByDelta } from '../src/lib/backtest/chain-cache';
import { simulateDiagonal, DEFAULT_LEAP_CONFIG } from '../src/lib/backtest/option-sim';
import type { SimConfig } from '../src/lib/backtest/option-sim';
import Database from 'better-sqlite3';

interface Scenario {
  label: string;
  entryDate: string;
  exitDate: string;
  diagLongDTERange: [number, number];
  diagShortDTERange: [number, number];
}

// Refined scenarios — all verified to produce non-empty long + short candidates.
const SCENARIOS: Scenario[] = [
  {
    label: 'happy',
    entryDate: '2023-03-20',
    exitDate: '2023-04-21',
    diagLongDTERange: [230, 310],
    diagShortDTERange: [20, 50],
  },
  {
    label: 'rolled',
    entryDate: '2023-05-15',
    // maxDate given to simulateDiagonal; long may exit earlier via PT
    exitDate: '2023-06-09',
    diagLongDTERange: [220, 290],
    diagShortDTERange: [20, 45],
  },
  {
    label: 'drawdown',
    entryDate: '2023-08-21',
    exitDate: '2023-09-15',
    diagLongDTERange: [270, 320],
    diagShortDTERange: [15, 35],
  },
];

const BASE_CONFIG: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DIAGONAL',
  diagLongDeltaRange: [0.65, 0.80],
  diagShortDeltaRange: [0.20, 0.30],
  diagLongProfitTarget: 0.40,
  diagLongStopLoss: 0.35,
  diagLongTimeStopDTE: 60,
  diagShortProfitTarget: 0.50,
  diagRollTriggerMoneyness: 0.02,
  monitoringIntervalDays: 1,
  fillMode: 'mid',
  slippage: { ...DEFAULT_LEAP_CONFIG.slippage, enabled: false },
};

async function main() {
  const db = initDB('data/option-chains.sqlite');

  for (const s of SCENARIOS) {
    console.log(`\n### ${s.label} — entry ${s.entryDate}  maxDate ${s.exitDate}`);

    const config: SimConfig = {
      ...BASE_CONFIG,
      diagLongDTERange: s.diagLongDTERange,
      diagShortDTERange: s.diagShortDTERange,
    };

    // Show candidate rows for audit
    const entryChain = getCachedChain('QQQ', s.entryDate);
    const longMidDelta = ((config.diagLongDeltaRange![0] + config.diagLongDeltaRange![1]) / 2);
    const shortMidDelta = ((config.diagShortDeltaRange![0] + config.diagShortDeltaRange![1]) / 2);
    const longMatch = findStrikeByDelta(entryChain, longMidDelta, 'Call', s.diagLongDTERange, 0);
    const shortMatch = findStrikeByDelta(entryChain, shortMidDelta, 'Call', s.diagShortDTERange, 0);
    console.log('  entry spot:', entryChain[0]?.stock_price);
    console.log('  long selected:', longMatch
      ? { strike: longMatch.row.strike, expiry: longMatch.row.expir_date, delta: longMatch.delta.toFixed(4), mid: longMatch.mid.toFixed(5), dte: longMatch.row.dte }
      : null);
    console.log('  short selected:', shortMatch
      ? { strike: shortMatch.row.strike, expiry: shortMatch.row.expir_date, delta: shortMatch.delta.toFixed(4), mid: shortMatch.mid.toFixed(5), dte: shortMatch.row.dte }
      : null);

    // Get cached trading dates for this range (avoids market holiday 401s)
    const allDates = (db.prepare(
      `SELECT DISTINCT trade_date FROM option_chains
       WHERE ticker='QQQ' AND trade_date >= ? AND trade_date <= ?
       ORDER BY trade_date`,
    ).all(s.entryDate, s.exitDate) as { trade_date: string }[]).map(r => r.trade_date);

    console.log(`  trading dates [${allDates.length}]: ${allDates[0]} .. ${allDates[allDates.length - 1]}`);

    // Run simulation
    const signal = { ticker: 'QQQ', date: s.entryDate, direction: 'CALL' as const, score: 0 };
    const trade = await simulateDiagonal('', signal, config, allDates, s.exitDate);

    if (!trade) {
      console.log('  *** SIMULATION RETURNED NULL — check chain coverage ***');
      continue;
    }

    const legs = trade.diagonalLegs!;
    const lc = legs.longCall;
    console.log('\n  --- Long leg ---');
    console.log('  ', { strike: lc.strike, entryDate: lc.entryDate, exitDate: lc.exitDate, entryPrice: lc.entryPrice, exitPrice: lc.exitPrice, exitReason: lc.exitReason });

    let computedPnl = 100 * (lc.exitPrice! - lc.entryPrice!);
    console.log(`  long_leg_pnl = 100 × (${lc.exitPrice?.toFixed(5)} − ${lc.entryPrice?.toFixed(5)}) = ${computedPnl.toFixed(4)}`);

    for (const [i, sc] of legs.shortCallCycles.entries()) {
      const cyclePnl = 100 * (sc.entryCredit! - sc.exitCost!);
      computedPnl += cyclePnl;
      console.log('\n  --- Short cycle', i, '---');
      console.log('  ', { strike: sc.strike, entryDate: sc.entryDate, exitDate: sc.exitDate, entryCredit: sc.entryCredit, exitCost: sc.exitCost, exitReason: sc.exitReason });
      console.log(`  short_pnl[${i}] = 100 × (${sc.entryCredit?.toFixed(5)} − ${sc.exitCost?.toFixed(5)}) = ${cyclePnl.toFixed(4)}`);
    }

    const capital = 100 * (lc.entryPrice! - legs.shortCallCycles[0].entryCredit!);
    console.log(`\n  expected combined P&L = ${computedPnl.toFixed(6)}`);
    console.log(`  simulator pnl        = ${trade.pnl.toFixed(6)}`);
    console.log(`  match: ${Math.abs(computedPnl - trade.pnl) < 0.01 ? 'YES ✓' : 'NO ✗ gap=' + (computedPnl - trade.pnl).toFixed(6)}`);
    console.log(`  capital              = 100 × (${lc.entryPrice?.toFixed(5)} − ${legs.shortCallCycles[0].entryCredit?.toFixed(5)}) = ${capital.toFixed(4)}`);
    console.log(`  return on capital    = ${(computedPnl / capital * 100).toFixed(2)}%`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
