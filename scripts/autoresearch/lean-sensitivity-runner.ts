/**
 * Unsealed sensitivity runner — maps response surfaces for single-parameter
 * sweeps against the F1 sealed BCD / PMCC anchors without touching the
 * production trial ledger, pre-registration gate, or sealer ceremony.
 *
 * Purpose: descriptive research only. Used to decide whether a candidate
 * parameter has enough effect size to justify burning a sealed attempt
 * against the dsrM global counter. Not for adoption.
 *
 * Unlike scripts/autoresearch/runner.ts this:
 *   - skips .handoff/current.md pre-reg parsing
 *   - does not call appendTrial() — no global attempt increment
 *   - does not compute holdout metrics, SPY IR, or sealer audit fields
 *   - emits a plain JSON + markdown table so the response surface is
 *     readable at a glance
 *
 * Run:
 *   LEAN_SWEEP=bcd-sl            npx tsx scripts/autoresearch/lean-sensitivity-runner.ts
 *   LEAN_SWEEP=bcd-short-delta   npx tsx scripts/autoresearch/lean-sensitivity-runner.ts
 *   LEAN_SWEEP=bcd-dte           npx tsx scripts/autoresearch/lean-sensitivity-runner.ts
 *   LEAN_SWEEP=pmcc-roll         npx tsx scripts/autoresearch/lean-sensitivity-runner.ts
 *   LEAN_SWEEP=pmcc-short-pt     npx tsx scripts/autoresearch/lean-sensitivity-runner.ts
 *   LEAN_SWEEP=pmcc-long-sl      npx tsx scripts/autoresearch/lean-sensitivity-runner.ts
 *   LEAN_SWEEP=all               npx tsx scripts/autoresearch/lean-sensitivity-runner.ts  (runs every sweep)
 *
 * Back-compat: LEAN_STRATEGY=bcd|pmcc still works and maps to the original
 * bcd-sl / pmcc-roll sweeps.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB } from '../../src/lib/backtest/chain-cache';
import {
  computeOptionAnalytics, DEFAULT_LEAP_CONFIG,
  type SimConfig, type OptionTrade, type EntrySignal,
} from '../../src/lib/backtest/option-sim';
import { makeDebitSpreadEvaluator, makeDiagonalEvaluator } from './worker';
import type { TradeEvaluator } from '../../src/lib/backtest/wfa-options';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type StrategyKey = 'bcd' | 'pmcc';
type Variant = { name: string; overrides: Partial<SimConfig> };
type Sweep = {
  name: string;
  strategy: StrategyKey;
  description: string;
  variants: Variant[];
};

// ── Anchors: copy of F1 sealed configs (singleton source of truth is the
//    strategy-*-f1.ts files; duplicated here to keep this runner standalone
//    and not touch those sealed files). ────────────────────────────────────

const BCD_F1_ANCHOR: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DEBIT_SPREAD',
  debitDTERange: [30, 60],
  debitLongDelta: 0.50,
  debitShortDelta: 0.20,
  debitProfitTargetPct: 0.50,
  debitMaxHoldDays: 45,
  debitMinExitDTE: 7,
  monitoringIntervalDays: 1,
  fillMode: 'bidask',
};

const PMCC_F1_ANCHOR: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DIAGONAL',
  diagLongDeltaRange: [0.70, 0.80],
  diagLongDTERange: [240, 300],
  diagShortDeltaRange: [0.20, 0.30],
  diagShortDTERange: [30, 45],
  diagLongProfitTarget: 0.60,
  diagLongStopLoss: 0.35,
  diagLongTimeStopDTE: 90,
  diagShortProfitTarget: 0.50,
  diagRollTriggerMoneyness: 0.02,
  monitoringIntervalDays: 1,
};

// ── Sweep catalogue ─────────────────────────────────────────────────────

const SWEEPS: Sweep[] = [
  // Round 1 (sensitivity-findings.md) — BCD stop-loss; both anchors vs candidate variants.
  {
    name: 'bcd-sl',
    strategy: 'bcd',
    description: 'BCD: debit-based stop-loss (none / 30% / 50% / 70%)',
    variants: [
      { name: 'bcd-no-sl (F1 anchor)', overrides: {} },
      { name: 'bcd-sl30',              overrides: { debitStopLossPct: 0.30 } },
      { name: 'bcd-sl50',              overrides: { debitStopLossPct: 0.50 } },
      { name: 'bcd-sl70',              overrides: { debitStopLossPct: 0.70 } },
    ],
  },
  // Round 1 — PMCC roll threshold.
  {
    name: 'pmcc-roll',
    strategy: 'pmcc',
    description: 'PMCC: DTE≤2 pin-risk roll threshold (never / 1% / 2% / 3% / 5%)',
    variants: [
      { name: 'pmcc-roll-never',         overrides: { diagRollTriggerMoneyness: 0 } },
      { name: 'pmcc-roll-1pct',          overrides: { diagRollTriggerMoneyness: 0.01 } },
      { name: 'pmcc-roll-2pct (anchor)', overrides: {} },
      { name: 'pmcc-roll-3pct',          overrides: { diagRollTriggerMoneyness: 0.03 } },
      { name: 'pmcc-roll-5pct',          overrides: { diagRollTriggerMoneyness: 0.05 } },
    ],
  },
  // Round 2 — BCD short-leg delta. Directly reshapes payoff (wider vs narrower spread).
  {
    name: 'bcd-short-delta',
    strategy: 'bcd',
    description: 'BCD: short-leg delta (0.15 / 0.20 anchor / 0.25 / 0.30)',
    variants: [
      { name: 'bcd-short-d15',          overrides: { debitShortDelta: 0.15 } },
      { name: 'bcd-short-d20 (anchor)', overrides: {} },
      { name: 'bcd-short-d25',          overrides: { debitShortDelta: 0.25 } },
      { name: 'bcd-short-d30',          overrides: { debitShortDelta: 0.30 } },
    ],
  },
  // Round 2 — BCD DTE band. Short vs long expiry reshapes theta/gamma/beta mix.
  {
    name: 'bcd-dte',
    strategy: 'bcd',
    description: 'BCD: DTE band ([21,45] / [30,60] anchor / [45,75] / [60,90])',
    variants: [
      { name: 'bcd-dte-21-45',          overrides: { debitDTERange: [21, 45] } },
      { name: 'bcd-dte-30-60 (anchor)', overrides: {} },
      { name: 'bcd-dte-45-75',          overrides: { debitDTERange: [45, 75] } },
      { name: 'bcd-dte-60-90',          overrides: { debitDTERange: [60, 90] } },
    ],
  },
  // Round 2 — PMCC short-call profit target. The active-management lever
  // that fires often (unlike the pin-roll, which rarely triggers).
  {
    name: 'pmcc-short-pt',
    strategy: 'pmcc',
    description: 'PMCC: short-call profit target (30% / 40% / 50% anchor / 60% / 70%)',
    variants: [
      { name: 'pmcc-short-pt30',          overrides: { diagShortProfitTarget: 0.30 } },
      { name: 'pmcc-short-pt40',          overrides: { diagShortProfitTarget: 0.40 } },
      { name: 'pmcc-short-pt50 (anchor)', overrides: {} },
      { name: 'pmcc-short-pt60',          overrides: { diagShortProfitTarget: 0.60 } },
      { name: 'pmcc-short-pt70',          overrides: { diagShortProfitTarget: 0.70 } },
    ],
  },
  // Round 2 — PMCC long-leg stop loss. Active in sharp drawdowns.
  // Testing "none" via a large value (1.00 = -100% return on LEAP,
  // effectively never triggers since maxloss on a long call is 100%).
  {
    name: 'pmcc-long-sl',
    strategy: 'pmcc',
    description: 'PMCC: long-leg stop loss (25% / 35% anchor / 45% / 55% / none)',
    variants: [
      { name: 'pmcc-long-sl25',          overrides: { diagLongStopLoss: 0.25 } },
      { name: 'pmcc-long-sl35 (anchor)', overrides: {} },
      { name: 'pmcc-long-sl45',          overrides: { diagLongStopLoss: 0.45 } },
      { name: 'pmcc-long-sl55',          overrides: { diagLongStopLoss: 0.55 } },
      { name: 'pmcc-long-sl-none',       overrides: { diagLongStopLoss: 1.00 } },
    ],
  },
];

// ── Initialize chain-cache DB (readonly, mirrors worker.ts) ──────────────

initDB(undefined, true);

// ── Load QQQ candles from data-cache.json (runner's local cache) ─────────

interface DataCache {
  tickers: Record<string, { candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> }>;
}

const cachePath = path.resolve(__dirname, 'data-cache.json');
if (!fs.existsSync(cachePath)) {
  console.error(`ERROR: ${cachePath} not found. Run: npx tsx scripts/autoresearch/prefetch-data.ts`);
  process.exit(1);
}
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as DataCache;
const qqq = cache.tickers.QQQ;
if (!qqq) {
  console.error('ERROR: QQQ not in data-cache.json');
  process.exit(1);
}

const allDates: string[] = qqq.candles.map(c => c.date).sort();
const maxDate = allDates[allDates.length - 1];
console.log(`Loaded QQQ: ${allDates.length} trading days, ${allDates[0]} → ${maxDate}`);

// ── Signal generators (mirror the F1 strategy files) ─────────────────────

function bcdSignals(): EntrySignal[] {
  const sigs: EntrySignal[] = [];
  for (let i = 60; i < allDates.length; i += 10) {
    sigs.push({ ticker: 'QQQ', date: allDates[i], direction: 'CALL', score: 50 });
  }
  return sigs;
}

function pmccSignals(): EntrySignal[] {
  const sigs: EntrySignal[] = [];
  for (let i = 60; i < allDates.length; i++) {
    sigs.push({ ticker: 'QQQ', date: allDates[i], direction: 'CALL', score: 0 });
  }
  return sigs;
}

// ── maxPositions=1 gated evaluation ───────────────────────────────────────

function runVariant(
  evaluator: TradeEvaluator,
  signals: EntrySignal[],
  config: SimConfig,
): OptionTrade[] {
  const trades: OptionTrade[] = [];
  let openUntil = '';  // exit date of the currently open trade, '' = flat
  for (const sig of signals) {
    if (sig.date <= openUntil) continue;        // position still open → skip
    const trade = evaluator(sig, config, allDates, maxDate);
    if (trade) {
      trades.push(trade);
      openUntil = trade.exitDate;
    }
  }
  return trades;
}

interface ResultRow {
  name: string;
  overrides: Partial<SimConfig>;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  returnOnCapital: number;
  avgPnlPct: number;
  profitFactor: number;
  dailyPortfolioSharpe: number | undefined;
  dailyMtMDrawdownPct: number | undefined;
  realizedExitDrawdownPct: number;
  avgHoldDays: number;
  avgCapitalPerTrade: number;
  byExit: Record<string, number>;
}

function runSweep(sweep: Sweep): ResultRow[] {
  const baseConfig = sweep.strategy === 'bcd' ? BCD_F1_ANCHOR : PMCC_F1_ANCHOR;
  const signals = sweep.strategy === 'bcd' ? bcdSignals() : pmccSignals();
  const evaluatorFactory = sweep.strategy === 'bcd' ? makeDebitSpreadEvaluator : makeDiagonalEvaluator;

  console.log(`\n━━ Sweep: ${sweep.name} (${sweep.strategy.toUpperCase()}) ━━`);
  console.log(`    ${sweep.description}`);
  console.log(`    signals ${signals.length} · variants ${sweep.variants.length}`);

  const results: ResultRow[] = [];
  for (const v of sweep.variants) {
    const config: SimConfig = { ...baseConfig, ...v.overrides };
    const evaluator = evaluatorFactory(config);
    const t0 = Date.now();
    const trades = runVariant(evaluator, signals, config);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const a = computeOptionAnalytics(trades, { allTradingDates: allDates });
    results.push({
      name: v.name,
      overrides: v.overrides,
      totalTrades: a.totalTrades,
      winRate: a.winRate,
      totalPnl: a.totalPnl,
      returnOnCapital: a.returnOnCapital,
      avgPnlPct: a.avgPnlPct,
      profitFactor: a.profitFactor,
      dailyPortfolioSharpe: a.dailyPortfolioSharpe,
      dailyMtMDrawdownPct: a.dailyMtMDrawdownPct,
      realizedExitDrawdownPct: a.realizedExitDrawdownPct,
      avgHoldDays: a.avgHoldDays,
      avgCapitalPerTrade: a.avgCapitalPerTrade,
      byExit: a.byExit,
    });
    console.log(
      `  [${v.name}] ${elapsed}s · ${a.totalTrades} trades · winRate ${a.winRate.toFixed(1)}% · ` +
      `sharpe ${a.dailyPortfolioSharpe?.toFixed(2) ?? 'N/A'} · ` +
      `mtmDD ${a.dailyMtMDrawdownPct?.toFixed(1) ?? 'N/A'}% · ` +
      `pnl $${a.totalPnl.toFixed(0)}`,
    );
  }
  return results;
}

function writeJson(sweep: Sweep, results: ResultRow[]) {
  const outPath = path.resolve(__dirname, `lean-sensitivity-${sweep.name}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    sweep: sweep.name,
    description: sweep.description,
    strategy: sweep.strategy,
    anchor: sweep.strategy === 'bcd' ? 'bcd-qqq-wide-f1' : 'pmcc-qqq-pt60-f1',
    dataRange: [allDates[0], maxDate],
    results,
  }, null, 2));
  console.log(`    wrote ${path.basename(outPath)}`);
}

function printMarkdownTable(sweep: Sweep, results: ResultRow[]) {
  const lines: string[] = [];
  lines.push(`\n### ${sweep.name} — ${sweep.description}\n`);
  lines.push('| Variant | Trades | WinRate | Sharpe | MtM DD | Realized DD | ROC | PF | TotalPnl |');
  lines.push('|---------|-------:|--------:|-------:|-------:|------------:|----:|---:|---------:|');
  for (const r of results) {
    lines.push(
      `| ${r.name} | ${r.totalTrades} | ${r.winRate.toFixed(1)}% | ` +
      `${r.dailyPortfolioSharpe?.toFixed(2) ?? 'N/A'} | ` +
      `${r.dailyMtMDrawdownPct?.toFixed(1) ?? 'N/A'}% | ` +
      `${r.realizedExitDrawdownPct.toFixed(1)}% | ` +
      `${r.returnOnCapital.toFixed(1)}% | ` +
      `${r.profitFactor.toFixed(2)} | ` +
      `$${r.totalPnl.toFixed(0)} |`,
    );
  }
  console.log(lines.join('\n'));
}

// ── Dispatch ──────────────────────────────────────────────────────────────

// Back-compat: LEAN_STRATEGY=bcd → bcd-sl, LEAN_STRATEGY=pmcc → pmcc-roll
const legacyStrategy = (process.env.LEAN_STRATEGY || '').toLowerCase();
const requestedSweep = (process.env.LEAN_SWEEP
  || (legacyStrategy === 'bcd' ? 'bcd-sl' : legacyStrategy === 'pmcc' ? 'pmcc-roll' : 'all')
).toLowerCase();

let toRun: Sweep[];
if (requestedSweep === 'all') {
  toRun = SWEEPS;
} else {
  const match = SWEEPS.find(s => s.name === requestedSweep);
  if (!match) {
    console.error(`ERROR: unknown sweep '${requestedSweep}'. Available: ${SWEEPS.map(s => s.name).join(', ')}, all`);
    process.exit(1);
  }
  toRun = [match];
}

for (const sweep of toRun) {
  const results = runSweep(sweep);
  writeJson(sweep, results);
  printMarkdownTable(sweep, results);
}
