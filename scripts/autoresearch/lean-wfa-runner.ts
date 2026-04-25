/**
 * WFA validation for sensitivity-sweep candidates, unsealed.
 *
 * Runs the PMCC live candidates (sl-none, sl45, short-pt30) and the F1 anchor
 * through the SAME WFA window structure the sealed F1 eval used:
 *   - trainWindowDays: 252, forwardStepDays: 126, purgeGapDays: 10, rolling
 *   - last 5 windows are holdout; the rest are selection
 *   - start date: first trading day >= 2018-01-01 (mirrors runner.ts)
 *
 * Reports per variant: selection Sharpe/DD/trades, holdout Sharpe/DD/trades,
 * and holdoutSpyIR. No trial ledger, no pre-reg gate, no sealer — same
 * zero-dsrM stance as lean-sensitivity-runner.ts.
 *
 * Run: npx tsx scripts/autoresearch/lean-wfa-runner.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB } from '../../src/lib/backtest/chain-cache';
import {
  DEFAULT_LEAP_CONFIG, computeOptionAnalytics,
  type SimConfig, type EntrySignal, type OptionTrade,
} from '../../src/lib/backtest/option-sim';
import { makeDiagonalEvaluator } from './worker';
import {
  buildWFAWindows, evaluateConfiguredSignalsWithState,
  computePortfolioDailyMetrics, createConstraintState,
  type ConfiguredSignal, type PortfolioConstraintState, type WindowDef,
} from '../../src/lib/backtest/wfa-options';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── WFA parameters (mirror F1 sealed configs) ────────────────────────────

const WFA = {
  trainWindowDays: 252,
  forwardStepDays: 126,
  purgeGapDays: 10,
  mode: 'rolling' as const,
};
const HOLDOUT_COUNT = 5;
const STARTING_CAPITAL = 10_000;   // PMCC anchor tier
const MAX_POSITIONS = 1;

// ── Anchor + candidates ──────────────────────────────────────────────────

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

type Variant = { name: string; overrides: Partial<SimConfig> };

const VARIANTS: Variant[] = [
  { name: 'pmcc-pt60-f1 (anchor)',   overrides: {} },
  { name: 'pmcc-long-sl45',          overrides: { diagLongStopLoss: 0.45 } },
  { name: 'pmcc-long-sl-none',       overrides: { diagLongStopLoss: 1.00 } },
  { name: 'pmcc-short-pt30',         overrides: { diagShortProfitTarget: 0.30 } },
];

// ── Init chain DB ─────────────────────────────────────────────────────────

initDB(undefined, true);

// ── Load cached QQQ + SPY ─────────────────────────────────────────────────

interface DataCache {
  tickers: Record<string, { candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> }>;
  spy: { dates: string[]; dailyReturns: number[] };
}

const cachePath = path.resolve(__dirname, 'data-cache.json');
if (!fs.existsSync(cachePath)) {
  console.error(`ERROR: ${cachePath} missing. Run prefetch-data.ts first.`);
  process.exit(1);
}
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as DataCache;
const qqqCandles = cache.tickers.QQQ?.candles;
if (!qqqCandles) { console.error('ERROR: QQQ not in cache'); process.exit(1); }

const allDates: string[] = qqqCandles.map(c => c.date).sort();
const maxDate = allDates[allDates.length - 1];

const spyReturnByDate = new Map<string, number>();
for (let i = 0; i < cache.spy.dates.length; i++) {
  spyReturnByDate.set(cache.spy.dates[i], cache.spy.dailyReturns[i]);
}

console.log(`Loaded QQQ: ${allDates.length} trading days, ${allDates[0]} → ${maxDate}`);
console.log(`Loaded SPY benchmark: ${cache.spy.dates.length} daily returns`);

// ── Build windows (runner.ts: wfaStartDate = first date >= 2018-01-01) ───

const wfaStartDate = allDates.find(d => d >= '2018-01-01') ?? allDates[0];
const allWindows = buildWFAWindows(allDates, {
  ...WFA,
  startDate: wfaStartDate,
  endDate: maxDate,
});
const selectionWindows = allWindows.slice(0, -HOLDOUT_COUNT);
const holdoutWindows = allWindows.slice(-HOLDOUT_COUNT);
const combinedWindows: WindowDef[] = [...selectionWindows, ...holdoutWindows];

console.log(`\nWFA: ${selectionWindows.length} selection + ${holdoutWindows.length} holdout windows`);
console.log(`  Selection OOS:  ${selectionWindows[0]?.oosStart} → ${selectionWindows[selectionWindows.length - 1]?.oosEnd}`);
console.log(`  Holdout OOS:    ${holdoutWindows[0]?.oosStart} → ${holdoutWindows[holdoutWindows.length - 1]?.oosEnd}`);

const firstHoldoutStart = holdoutWindows[0]?.oosStart ?? '';

// ── Signal generator (PMCC always-in, i=60 forward) ──────────────────────

function pmccSignals(): EntrySignal[] {
  const sigs: EntrySignal[] = [];
  for (let i = 60; i < allDates.length; i++) {
    sigs.push({ ticker: 'QQQ', date: allDates[i], direction: 'CALL', score: 0 });
  }
  return sigs;
}

const allSignals = pmccSignals();

// ── SPY IR (mirrors runner.ts computeInformationRatio) ───────────────────

function spyIR(stratReturns: number[], stratDates: string[]): { ir: number; excessAnnualized: number; overlap: number } {
  const excess: number[] = [];
  for (let i = 0; i < stratDates.length; i++) {
    const sr = stratReturns[i] ?? 0;
    const br = spyReturnByDate.get(stratDates[i]);
    if (br !== undefined) excess.push(sr - br);
  }
  if (excess.length < 20) return { ir: 0, excessAnnualized: 0, overlap: excess.length };
  const mean = excess.reduce((s, r) => s + r, 0) / excess.length;
  const variance = excess.reduce((s, r) => s + (r - mean) ** 2, 0) / excess.length;
  const stdv = Math.sqrt(variance);
  const ir = stdv > 0 ? (mean / stdv) * Math.sqrt(252) : 0;
  return { ir, excessAnnualized: mean * 252, overlap: excess.length };
}

// ── Evaluate one variant end-to-end across all WFA windows ───────────────

interface VariantResult {
  name: string;
  overrides: Partial<SimConfig>;
  // Selection (OOS pre-holdout)
  selTrades: number;
  selWinRate: number;
  selSharpe: number;
  selMaxDD: number;
  selTotalPnl: number;
  // Holdout
  holdoutTrades: number;
  holdoutWinRate: number;
  holdoutSharpe: number;
  holdoutMaxDD: number;
  holdoutTotalPnl: number;
  holdoutSpyIR: number;
  holdoutSpyExcess: number;
  // Per-window selection Sharpe (for stability inspection)
  windowSharpes: number[];
}

function runVariant(v: Variant): VariantResult {
  const config: SimConfig = { ...PMCC_F1_ANCHOR, ...v.overrides };
  const evaluator = makeDiagonalEvaluator(config);
  const executionConfig = { maxPositions: MAX_POSITIONS, maxPerTicker: MAX_POSITIONS, startingCapital: STARTING_CAPITAL };
  const oosMaxDate = combinedWindows[combinedWindows.length - 1].oosEnd;

  // Carry portfolio state across ALL windows (matches worker.ts: selection+holdout combined)
  let state: PortfolioConstraintState = createConstraintState();
  const allTrades: OptionTrade[] = [];
  const perWindowSharpe: number[] = [];

  for (const w of combinedWindows) {
    const oosSigs = allSignals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const configured: ConfiguredSignal[] = oosSigs.map(s => ({ signal: s, config }));
    const result = evaluateConfiguredSignalsWithState(
      configured, executionConfig, allDates, oosMaxDate, evaluator, state,
    );
    state = result.state;

    // Per-window selection-only Sharpe
    const cumulative = allTrades.concat(result.trades);
    const m = computePortfolioDailyMetrics(
      cumulative, allDates, w.oosStart, w.oosEnd, STARTING_CAPITAL,
    );
    perWindowSharpe.push(m.sharpe);
    allTrades.push(...result.trades);
  }

  // Split trades by entry date vs holdout boundary
  const selTrades  = firstHoldoutStart ? allTrades.filter(t => t.entryDate <  firstHoldoutStart) : allTrades;
  const holdTrades = firstHoldoutStart ? allTrades.filter(t => t.entryDate >= firstHoldoutStart) : [];

  // Selection analytics: combined over selection OOS range
  const selStart = selectionWindows[0]?.oosStart ?? allDates[0];
  const selEnd   = selectionWindows[selectionWindows.length - 1]?.oosEnd ?? allDates[allDates.length - 1];
  const selMetrics = computePortfolioDailyMetrics(allTrades, allDates, selStart, selEnd, STARTING_CAPITAL);
  const selAn = computeOptionAnalytics(selTrades, { allTradingDates: allDates });

  // Holdout analytics (seed equity/peak from end of selection)
  const finalSelEquity = selMetrics.equityCurve[selMetrics.equityCurve.length - 1]?.equity ?? STARTING_CAPITAL;
  const selPeak = Math.max(...selMetrics.equityCurve.map(e => e.equity), STARTING_CAPITAL);
  const holdStart = holdoutWindows[0]?.oosStart ?? selEnd;
  const holdEnd   = holdoutWindows[holdoutWindows.length - 1]?.oosEnd ?? maxDate;
  const holdMetrics = computePortfolioDailyMetrics(
    allTrades, allDates, holdStart, holdEnd, STARTING_CAPITAL, finalSelEquity, selPeak,
  );
  const holdAn = computeOptionAnalytics(holdTrades, { allTradingDates: allDates });

  const holdDates = holdMetrics.equityCurve.map(e => e.date);
  const ir = spyIR(holdMetrics.dailyReturns, holdDates);

  return {
    name: v.name,
    overrides: v.overrides,
    selTrades: selTrades.length,
    selWinRate: selAn.winRate,
    selSharpe: selMetrics.sharpe,
    selMaxDD: selMetrics.maxDrawdownPct,
    selTotalPnl: selAn.totalPnl,
    holdoutTrades: holdTrades.length,
    holdoutWinRate: holdAn.winRate,
    holdoutSharpe: holdMetrics.sharpe,
    holdoutMaxDD: holdMetrics.maxDrawdownPct,
    holdoutTotalPnl: holdAn.totalPnl,
    holdoutSpyIR: ir.ir,
    holdoutSpyExcess: ir.excessAnnualized,
    windowSharpes: perWindowSharpe,
  };
}

// ── Run ───────────────────────────────────────────────────────────────────

console.log(`\nEvaluating ${VARIANTS.length} variants through WFA...`);
const results: VariantResult[] = [];
for (const v of VARIANTS) {
  const t0 = Date.now();
  const r = runVariant(v);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  results.push(r);
  console.log(
    `  [${v.name}] ${elapsed}s · ` +
    `sel: ${r.selTrades}t sharpe ${r.selSharpe.toFixed(2)} dd ${r.selMaxDD.toFixed(1)}% · ` +
    `holdout: ${r.holdoutTrades}t sharpe ${r.holdoutSharpe.toFixed(2)} IR ${r.holdoutSpyIR.toFixed(2)} dd ${r.holdoutMaxDD.toFixed(1)}%`,
  );
}

// ── Output ────────────────────────────────────────────────────────────────

const outPath = path.resolve(__dirname, 'lean-wfa-pmcc-candidates.json');
fs.writeFileSync(outPath, JSON.stringify({
  generated: new Date().toISOString(),
  anchor: 'pmcc-qqq-pt60-f1',
  wfa: { ...WFA, holdoutCount: HOLDOUT_COUNT, startingCapital: STARTING_CAPITAL, maxPositions: MAX_POSITIONS },
  selectionRange: [selectionWindows[0]?.oosStart, selectionWindows[selectionWindows.length - 1]?.oosEnd],
  holdoutRange: [holdoutWindows[0]?.oosStart, holdoutWindows[holdoutWindows.length - 1]?.oosEnd],
  results,
}, null, 2));
console.log(`\nWrote ${path.basename(outPath)}`);

// Markdown tables
console.log('\n### PMCC WFA candidate evaluation — Selection OOS');
console.log('| Variant | Trades | WinRate | Sharpe | MaxDD | TotalPnl |');
console.log('|---------|-------:|--------:|-------:|------:|---------:|');
for (const r of results) {
  console.log(
    `| ${r.name} | ${r.selTrades} | ${r.selWinRate.toFixed(1)}% | ` +
    `${r.selSharpe.toFixed(2)} | ${r.selMaxDD.toFixed(1)}% | $${r.selTotalPnl.toFixed(0)} |`,
  );
}

console.log('\n### PMCC WFA candidate evaluation — Holdout (last 5 windows)');
console.log('| Variant | Trades | WinRate | Sharpe | MaxDD | SPY IR | Ann. excess | TotalPnl |');
console.log('|---------|-------:|--------:|-------:|------:|-------:|------------:|---------:|');
for (const r of results) {
  console.log(
    `| ${r.name} | ${r.holdoutTrades} | ${r.holdoutWinRate.toFixed(1)}% | ` +
    `${r.holdoutSharpe.toFixed(2)} | ${r.holdoutMaxDD.toFixed(1)}% | ` +
    `${r.holdoutSpyIR.toFixed(2)} | ${(r.holdoutSpyExcess * 100).toFixed(1)}% | $${r.holdoutTotalPnl.toFixed(0)} |`,
  );
}

console.log('\n### Per-window selection Sharpe (stability inspection)');
const headers = combinedWindows.slice(0, selectionWindows.length + holdoutWindows.length).map((w, i) =>
  i < selectionWindows.length ? `sel-w${i}` : `hold-w${i - selectionWindows.length}`,
);
console.log('| Variant | ' + headers.join(' | ') + ' |');
console.log('|---------|' + headers.map(() => '-------:').join('|') + '|');
for (const r of results) {
  console.log(
    `| ${r.name} | ` +
    r.windowSharpes.map(s => s.toFixed(2)).join(' | ') +
    ' |',
  );
}
