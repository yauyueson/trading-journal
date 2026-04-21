/**
 * Phase 0.c.9.B — CBOE BXM replication.
 *
 * Replicates the CBOE BXM (S&P 500 BuyWrite Index) on SPY using
 * simulateBuyWrite and compares monthly returns to the published CBOE
 * series at data/cboe-bxm-daily.csv. A successful replication
 * (correlation ≥ 0.85) validates the buy-write simulator against an
 * industry-standard benchmark — a signal that unit-test-based
 * validation cannot give on its own.
 *
 * Usage:
 *   npx tsx scripts/replicate-bxm.ts                 # default window (full cache)
 *   npx tsx scripts/replicate-bxm.ts --from 2020-01  # optional sub-window
 *
 * Outputs:
 *   data/bxm-replication-results.json — monthly return pairs + summary stats.
 *   stdout                             — correlation + diagnostic residuals.
 *
 * Prerequisite: `data/option-chains.sqlite` must be prefetched for SPY
 * with DTE covering [25, 40] (simulateBuyWrite requires requireMonthlyExpiry
 * plus DTE coverage around the target — see option-sim.ts).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import {
  simulateBuyWrite,
  DEFAULT_CREDIT_CONFIG,
  isThirdFriday,
  type EntrySignal,
  type OptionTrade,
  type SimConfig,
} from '../src/lib/backtest/option-sim';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CACHE_PATH = path.join(PROJECT_ROOT, 'data', 'option-chains.sqlite');
const BXM_CSV_PATH = path.join(PROJECT_ROOT, 'data', 'cboe-bxm-daily.csv');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'data', 'bxm-replication-results.json');

// ── CLI args ──────────────────────────────────────────────
function parseArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const argFrom = parseArg('--from');
const argTo = parseArg('--to');

// ── Data loaders ──────────────────────────────────────────
interface BxmDailyRow { date: string; close: number; }

function loadBxmDaily(): BxmDailyRow[] {
  const raw = fs.readFileSync(BXM_CSV_PATH, 'utf-8');
  const lines = raw.trim().split('\n');
  const out: BxmDailyRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const [dateStr, closeStr] = lines[i].split(',');
    if (!dateStr || !closeStr) continue;
    const [mm, dd, yyyy] = dateStr.split('/');
    const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    out.push({ date: iso, close: Number(closeStr) });
  }
  return out;
}

function loadSpyTradingDates(db: Database.Database): string[] {
  const rows = db.prepare(
    `SELECT trade_date FROM fetch_log
     WHERE ticker='SPY' AND rows_fetched > 0
     ORDER BY trade_date`,
  ).all() as Array<{ trade_date: string }>;
  return rows.map(r => r.trade_date);
}

// ── BXM-style roll schedule ───────────────────────────────
/**
 * Discover the CBOE BXM roll dates inside a trading calendar.
 * BXM methodology: roll on the FIRST TRADING DAY AFTER the 3rd-Friday
 * expiration of each month. Since our trading dates exclude weekends and
 * holidays, the first trading day after the 3rd Friday is almost always
 * the Monday (or Tuesday if MLK-style). Returns the list of roll dates.
 */
function bxmRollDates(tradingDates: string[]): string[] {
  const rolls: string[] = [];
  let lastRollMonth = '';
  for (let i = 0; i < tradingDates.length; i++) {
    const d = tradingDates[i];
    const prev = i > 0 ? tradingDates[i - 1] : null;
    if (!prev) continue;
    // Candidate: `d` is the first trading day strictly after a 3rd Friday.
    // Check if any date between prev (exclusive) and d (exclusive) is a
    // 3rd Friday. Since prev+1 .. d-1 are all non-trading, we can just
    // check all calendar dates in that gap for isThirdFriday.
    const ms = Date.parse(`${prev}T00:00:00Z`);
    const msD = Date.parse(`${d}T00:00:00Z`);
    for (let t = ms + 86_400_000; t < msD; t += 86_400_000) {
      const iso = new Date(t).toISOString().slice(0, 10);
      if (isThirdFriday(iso)) {
        const ym = d.slice(0, 7);
        if (ym !== lastRollMonth) {
          rolls.push(d);
          lastRollMonth = ym;
        }
        break;
      }
    }
  }
  return rolls;
}

// ── Monthly return series ─────────────────────────────────
/**
 * Look up BXM close on a specific date. Walks back up to 5 days if the
 * exact date isn't in the series (CBOE can have holiday gaps that don't
 * align with our trading calendar).
 */
function bxmCloseOnOrBefore(closeByDate: Map<string, number>, date: string): number | null {
  for (let k = 0; k < 5; k++) {
    const probe = new Date(Date.parse(`${date}T00:00:00Z`) - k * 86_400_000).toISOString().slice(0, 10);
    const v = closeByDate.get(probe);
    if (v != null) return v;
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.error(`[bxm] cache missing: ${CACHE_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(BXM_CSV_PATH)) {
    console.error(`[bxm] BXM CSV missing: ${BXM_CSV_PATH}`);
    process.exit(1);
  }

  const db = new Database(CACHE_PATH, { readonly: true });
  const spyDates = loadSpyTradingDates(db);
  const bxmDaily = loadBxmDaily();
  db.close();

  const windowStart = argFrom ? `${argFrom}-01` : spyDates[0];
  const windowEnd = argTo ? `${argTo}-31` : spyDates[spyDates.length - 1];
  const spyInWindow = spyDates.filter(d => d >= windowStart && d <= windowEnd);

  console.log(`[bxm] SPY cache: ${spyInWindow[0]} → ${spyInWindow.at(-1)} (${spyInWindow.length} days)`);
  console.log(`[bxm] BXM CSV:   ${bxmDaily[0].date} → ${bxmDaily.at(-1)!.date} (${bxmDaily.length} days)`);

  const rollDates = bxmRollDates(spyInWindow);
  console.log(`[bxm] Discovered ${rollDates.length} monthly roll dates.`);

  // Config for BXM-like replication.
  const config: SimConfig = {
    ...DEFAULT_CREDIT_CONFIG,
    creditDTERange: [25, 40],
    fillMode: 'mid',
    monitoringIntervalDays: 1,
    requireMonthlyExpiry: true,
    minIVRank: 0, vrpFilter: 0, contangoFilter: 0,
    vrpPctFilter: 0, contangoPctFilter: 0, slopeFilter: 0,
  };

  // Build our replication monthly return path via simulateBuyWrite.
  // Each cycle enters on a roll date and exits at expiration (the next
  // roll date is typically ~30 days later). Capital = 100 × entrySpot.
  const trades: OptionTrade[] = [];
  const nullReasons = new Map<string, number>();
  for (const rollDate of rollDates) {
    const signal: EntrySignal = { ticker: 'SPY', date: rollDate, direction: 'CALL', score: 50 };
    try {
      const trade = await simulateBuyWrite('', signal, config, spyInWindow, spyInWindow[spyInWindow.length - 1]);
      if (trade) {
        trades.push(trade);
      } else {
        nullReasons.set('sim_returned_null', (nullReasons.get('sim_returned_null') ?? 0) + 1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      nullReasons.set(msg.slice(0, 60), (nullReasons.get(msg.slice(0, 60)) ?? 0) + 1);
    }
  }
  console.log(`[bxm] Executed ${trades.length}/${rollDates.length} cycles.`);
  if (nullReasons.size > 0) {
    for (const [reason, n] of nullReasons) console.log(`[bxm]   skip (${n}): ${reason}`);
  }

  // Pair BXM and replication returns over the SAME interval.
  //
  // Trade i: entered at rollDates[i], exits at trade.exitDate (~= rollDates[i+1]).
  // Its return over that window: trade.pnl / (100 × entryStockPrice).
  //
  // BXM's return over the SAME window: bxm_close[trade.exitDate] /
  //   bxm_close[trade.entryDate] − 1. That's the total-return path the
  //   index booked between our cycle's two boundary events.
  //
  // Earlier naive pairing keyed on trade.entryDate's calendar month and
  // BXM's next-roll month, which is off by one cycle and produced
  // correlation ≈ 0 because rep[i] was compared to bxm[i−1].
  const closeByDate = new Map(bxmDaily.map(r => [r.date, r.close]));
  const pairs: Array<{ month: string; entryDate: string; exitDate: string; bxm: number; rep: number; residual: number }> = [];
  for (const t of trades) {
    const notional = 100 * (t.stockLeg?.entryPrice ?? t.entryStockPrice ?? 0);
    if (notional <= 0) continue;
    const repRet = t.pnl / notional;

    const cEntry = bxmCloseOnOrBefore(closeByDate, t.entryDate);
    const cExit = bxmCloseOnOrBefore(closeByDate, t.exitDate);
    if (cEntry == null || cExit == null || cEntry <= 0) continue;
    const bxmRet = cExit / cEntry - 1;

    pairs.push({
      month: t.entryDate.slice(0, 7),
      entryDate: t.entryDate,
      exitDate: t.exitDate,
      bxm: bxmRet,
      rep: repRet,
      residual: repRet - bxmRet,
    });
  }
  console.log(`[bxm] Paired cycles: ${pairs.length}`);

  // ── Stats ───────────────────────────────────────────────
  const bxmRets = pairs.map(p => p.bxm);
  const repRets = pairs.map(p => p.rep);
  const meanBxm = mean(bxmRets), meanRep = mean(repRets);
  // Sum-of-squares formulation uses the same implicit denominator for
  // cov and both sds — avoids the population-vs-sample variance mismatch
  // that introduces a factor-of-n/(n-1) bias when the script mixes them.
  const ssxy = pairs.reduce((s, p) => s + (p.bxm - meanBxm) * (p.rep - meanRep), 0);
  const ssx = pairs.reduce((s, p) => s + (p.bxm - meanBxm) ** 2, 0);
  const ssy = pairs.reduce((s, p) => s + (p.rep - meanRep) ** 2, 0);
  const corr = ssx > 0 && ssy > 0 ? ssxy / Math.sqrt(ssx * ssy) : 0;
  const sdBxm = sd(bxmRets, meanBxm), sdRep = sd(repRets, meanRep);
  const annualGap = 12 * (meanRep - meanBxm);

  const summary = {
    window: { start: spyInWindow[0], end: spyInWindow.at(-1), months: pairs.length },
    correlation: corr,
    meanMonthlyReturn: { bxm: meanBxm, rep: meanRep },
    annualizedReturnGap: annualGap,
    residualSd: sd(pairs.map(p => p.residual), 0),
    maxAbsResidual: Math.max(...pairs.map(p => Math.abs(p.residual))),
  };

  console.log(`\n[bxm] === Summary ===`);
  console.log(`  correlation:          ${corr.toFixed(4)}  (target ≥ 0.85)`);
  console.log(`  mean monthly:         BXM ${(meanBxm * 100).toFixed(3)}%   rep ${(meanRep * 100).toFixed(3)}%`);
  console.log(`  annual gap (rep-BXM): ${(annualGap * 100).toFixed(2)}%   ${annualGap < -0.005 ? '(< 0 means rep lacks ~div yield)' : ''}`);
  console.log(`  residual σ (monthly): ${(summary.residualSd * 100).toFixed(3)}%`);
  console.log(`  max |residual|:       ${(summary.maxAbsResidual * 100).toFixed(3)}%`);

  // Top residuals (diagnostic)
  const worst = [...pairs].sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual)).slice(0, 10);
  console.log(`\n[bxm] Top-10 |residual| cycles (diagnose outliers):`);
  for (const w of worst) {
    console.log(`  ${w.entryDate} → ${w.exitDate}: bxm ${(w.bxm * 100).toFixed(2).padStart(7)}%  rep ${(w.rep * 100).toFixed(2).padStart(7)}%  resid ${(w.residual * 100).toFixed(2).padStart(7)}%`);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ summary, pairs }, null, 2));
  console.log(`\n[bxm] Wrote ${OUTPUT_PATH}`);
}

function mean(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length; }
function sd(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

main().catch(err => { console.error(err); process.exit(1); });
