/**
 * PMCC RV-elevated gate — frozen-spec observational holdout test.
 *
 * The sealed-anchor regime attribution (selection-period what-if table)
 * showed that skipping PMCC entries when QQQ RV5 / RV60 ≥ 1.5 lifted
 * selection Sharpe from 1.72 → 2.06 (+0.34) and dropped MaxDD 17.5% →
 * 13.1%. That gate was DISCOVERED on selection trades. To respect the
 * adoption discipline, this script applies the FROZEN spec as an actual
 * entry filter through the same WFA structure, then reports holdout
 * metrics separately as "selection-discovered, holdout-observed."
 *
 * Frozen spec (per Codex's review — do not tune):
 *   - Threshold: QQQ RV5 / RV60 ≥ 1.5 → skip entry
 *   - Lookback: 5d / 60d realized vol on QQQ daily log returns,
 *     annualized × √252
 *   - Scope: skip new LEAP entries/reopens. Short-call management on
 *     existing diagonals proceeds normally (the simulator handles
 *     rolls without needing new signals).
 *   - PMCC F1 config verbatim: long δ 0.70-0.80 DTE 240-300, short δ
 *     0.20-0.30 DTE 30-45, longPT 60%, longSL 35%, shortPT 50%,
 *     rollMoneyness 0.02.
 *
 * Output is observational only — no pre-reg, no dsrM cost, no sealer.
 * If the gate degrades holdout, keep PMCC as-is. If it improves or stays
 * flat, it's a candidate for October dsrM-refresh adoption (the user's
 * decision to make then).
 *
 * Run: npx tsx scripts/autoresearch/lean-wfa-pmcc-rv-gate.ts
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
const REPORT_DIR = path.resolve(__dirname, '../../backtesting history/credit-spread/reports/pmcc-rv-gate-observational');

// ── Frozen config ───────────────────────────────────────────────────────

const PMCC_F1_CONFIG: SimConfig = {
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

const WFA = { trainWindowDays: 252, forwardStepDays: 126, purgeGapDays: 10, mode: 'rolling' as const };
const HOLDOUT_COUNT = 5;
const STARTING_CAPITAL = 10_000;
const MAX_POSITIONS = 1;
const RV_GATE_THRESHOLD = 1.5;

// ── Cache load ──────────────────────────────────────────────────────────

const cachePath = path.resolve(__dirname, 'data-cache.json');
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as {
  tickers: Record<string, { candles: Array<{ date: string; close: number }> }>;
};
const qqqCandles = cache.tickers.QQQ?.candles;
if (!qqqCandles) { console.error('ERROR: QQQ not in cache'); process.exit(1); }

initDB(undefined, true);

const allDates: string[] = qqqCandles.map(c => c.date).sort();
const maxDate = allDates[allDates.length - 1];

// ── Realized vol on QQQ ─────────────────────────────────────────────────

function rvSeries(window: number): Map<string, number> {
  const out = new Map<string, number>();
  const closes = qqqCandles.map(c => c.close);
  const dates  = qqqCandles.map(c => c.date);
  const logRet: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    logRet.push(closes[i - 1] > 0 && closes[i] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0);
  }
  for (let i = window; i < closes.length; i++) {
    const slice = logRet.slice(i - window + 1, i + 1);
    const m = slice.reduce((s, x) => s + x, 0) / slice.length;
    const v = slice.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, slice.length - 1);
    out.set(dates[i], Math.sqrt(v * 252));
  }
  return out;
}

const rv5  = rvSeries(5);
const rv60 = rvSeries(60);

function gateAllowsEntry(date: string): boolean {
  const a = rv5.get(date);
  const b = rv60.get(date);
  if (a == null || b == null || b <= 0) return true; // missing data → don't penalize
  return (a / b) < RV_GATE_THRESHOLD;
}

// ── Signals ─────────────────────────────────────────────────────────────

function pmccSignalsAlwaysIn(): EntrySignal[] {
  const sigs: EntrySignal[] = [];
  for (let i = 60; i < allDates.length; i++) {
    sigs.push({ ticker: 'QQQ', date: allDates[i], direction: 'CALL', score: 0 });
  }
  return sigs;
}

function pmccSignalsRvGated(): EntrySignal[] {
  return pmccSignalsAlwaysIn().filter(s => gateAllowsEntry(s.date));
}

const baselineSignals = pmccSignalsAlwaysIn();
const gatedSignals    = pmccSignalsRvGated();
const skippedDays     = baselineSignals.length - gatedSignals.length;

console.log(`Signals: baseline ${baselineSignals.length} · RV-gated ${gatedSignals.length} (skipped ${skippedDays} days, ${((skippedDays / baselineSignals.length) * 100).toFixed(1)}%)`);

// ── WFA windows ─────────────────────────────────────────────────────────

const wfaStartDate = allDates.find(d => d >= '2018-01-01') ?? allDates[0];
const allWindows = buildWFAWindows(allDates, { ...WFA, startDate: wfaStartDate, endDate: maxDate });
const selectionWindows = allWindows.slice(0, -HOLDOUT_COUNT);
const holdoutWindows = allWindows.slice(-HOLDOUT_COUNT);
const combinedWindows: WindowDef[] = [...selectionWindows, ...holdoutWindows];
const firstHoldoutStart = holdoutWindows[0]?.oosStart ?? '';

const selStart = selectionWindows[0]?.oosStart ?? allDates[0];
const selEnd   = selectionWindows[selectionWindows.length - 1]?.oosEnd ?? maxDate;
const holdStart = holdoutWindows[0]?.oosStart ?? '';
const holdEnd   = holdoutWindows[holdoutWindows.length - 1]?.oosEnd ?? maxDate;

console.log(`WFA: ${selectionWindows.length} sel + ${HOLDOUT_COUNT} holdout · holdout boundary ${firstHoldoutStart}`);

// ── Strategy runner ─────────────────────────────────────────────────────

interface StratResult {
  name: string;
  trades: OptionTrade[];
  selTrades: number; selSharpe: number; selMaxDD: number; selPnl: number; selWinRate: number;
  holdTrades: number; holdSharpe: number; holdMaxDD: number; holdPnl: number; holdWinRate: number;
  perWindowSharpe: number[];   // selection windows only, for stability inspection
}

function runStrategy(name: string, signals: EntrySignal[]): StratResult {
  const evaluator = makeDiagonalEvaluator(PMCC_F1_CONFIG);
  const exec = { maxPositions: MAX_POSITIONS, maxPerTicker: MAX_POSITIONS, startingCapital: STARTING_CAPITAL };
  const oosMaxDate = combinedWindows[combinedWindows.length - 1].oosEnd;
  let state: PortfolioConstraintState = createConstraintState();
  const all: OptionTrade[] = [];
  const perWindowSelSharpe: number[] = [];

  for (let i = 0; i < combinedWindows.length; i++) {
    const w = combinedWindows[i];
    const oosSigs = signals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const configured: ConfiguredSignal[] = oosSigs.map(s => ({ signal: s, config: PMCC_F1_CONFIG }));
    const result = evaluateConfiguredSignalsWithState(configured, exec, allDates, oosMaxDate, evaluator, state);
    state = result.state;
    all.push(...result.trades);
    if (i < selectionWindows.length) {
      const m = computePortfolioDailyMetrics(all, allDates, w.oosStart, w.oosEnd, STARTING_CAPITAL);
      perWindowSelSharpe.push(m.sharpe);
    }
  }

  const selTradesArr  = firstHoldoutStart ? all.filter(t => t.entryDate <  firstHoldoutStart) : all;
  const holdTradesArr = firstHoldoutStart ? all.filter(t => t.entryDate >= firstHoldoutStart) : [];

  const selMetrics = computePortfolioDailyMetrics(all, allDates, selStart, selEnd, STARTING_CAPITAL);
  const finalSelEquity = selMetrics.equityCurve[selMetrics.equityCurve.length - 1]?.equity ?? STARTING_CAPITAL;
  const selPeak = Math.max(...selMetrics.equityCurve.map(e => e.equity), STARTING_CAPITAL);
  const holdMetrics = computePortfolioDailyMetrics(all, allDates, holdStart, holdEnd, STARTING_CAPITAL, finalSelEquity, selPeak);

  const selAn  = computeOptionAnalytics(selTradesArr,  { allTradingDates: allDates });
  const holdAn = computeOptionAnalytics(holdTradesArr, { allTradingDates: allDates });

  return {
    name, trades: all,
    selTrades: selTradesArr.length, selSharpe: selMetrics.sharpe, selMaxDD: selMetrics.maxDrawdownPct,
    selPnl: selAn.totalPnl, selWinRate: selAn.winRate,
    holdTrades: holdTradesArr.length, holdSharpe: holdMetrics.sharpe, holdMaxDD: holdMetrics.maxDrawdownPct,
    holdPnl: holdAn.totalPnl, holdWinRate: holdAn.winRate,
    perWindowSharpe: perWindowSelSharpe,
  };
}

console.log('\nRunning strategies...');
const t0 = Date.now();
const baseline = runStrategy('PMCC F1 baseline', baselineSignals);
console.log(`  baseline  ${baseline.trades.length}t · sel ${baseline.selSharpe.toFixed(2)}/${baseline.selMaxDD.toFixed(1)}% · hold ${baseline.holdSharpe.toFixed(2)}/${baseline.holdMaxDD.toFixed(1)}%`);

const gated = runStrategy('PMCC F1 + RV gate', gatedSignals);
console.log(`  RV-gated  ${gated.trades.length}t · sel ${gated.selSharpe.toFixed(2)}/${gated.selMaxDD.toFixed(1)}% · hold ${gated.holdSharpe.toFixed(2)}/${gated.holdMaxDD.toFixed(1)}%`);

console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

// ── Render ──────────────────────────────────────────────────────────────

function dollar(n: number): string { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString(); }
function fmtPct(n: number, digits = 1): string { return n.toFixed(digits) + '%'; }
function f2(n: number): string { return n.toFixed(2); }

const lines: string[] = [];
lines.push('# PMCC RV-elevated gate — frozen-spec observational test');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push('');
lines.push('## Status: observational only');
lines.push('');
lines.push('The selection result here is **selection-discovered** (the gate spec was identified in the sealed-anchor regime attribution\'s what-if-gate table on selection trades). The holdout result is **holdout-observed** — applied as a frozen entry filter, no tuning, no iteration.');
lines.push('');
lines.push('No pre-reg, no dsrM cost, no sealer. If the gate degrades holdout, PMCC stays as-is. If it improves or stays flat, it\'s a candidate for October dsrM-refresh adoption — that decision is for the user.');
lines.push('');

lines.push('## Frozen spec');
lines.push('');
lines.push(`- **Gate:** skip new LEAP entries when QQQ 5d realized vol / 60d realized vol ≥ ${RV_GATE_THRESHOLD}`);
lines.push('- **RV definition:** stdev of QQQ daily log returns over N trading days, annualized × √252');
lines.push('- **Scope:** filters new LEAP entries/reopens only. Short-call management on existing diagonals proceeds normally (the simulator handles rolls).');
lines.push(`- **PMCC F1 config:** long δ 0.70-0.80 DTE 240-300, short δ 0.20-0.30 DTE 30-45, longPT 60%, longSL 35%, shortPT 50%, rollMoneyness 0.02. Verbatim from sealed F1 anchor.`);
lines.push(`- **Capital:** $${STARTING_CAPITAL.toLocaleString()}, maxPositions=${MAX_POSITIONS}.`);
lines.push(`- **WFA:** 252/126/10 rolling, ${selectionWindows.length} selection + ${HOLDOUT_COUNT} holdout windows, holdout boundary ${firstHoldoutStart}.`);
lines.push('');

lines.push('## Signal stream impact');
lines.push('');
lines.push(`Always-in signals: ${baselineSignals.length} trading days. After RV gate: ${gatedSignals.length}. **Skipped ${skippedDays} days (${fmtPct((skippedDays / baselineSignals.length) * 100)})** because QQQ RV5/RV60 ≥ ${RV_GATE_THRESHOLD}.`);
lines.push('');
lines.push('(Most always-in signals never produce a trade because the portfolio constraint maxPositions=1 blocks them when a prior LEAP is still open. The gate only matters at moments where a new LEAP would otherwise enter — i.e., on or just after the prior trade\'s exit date.)');
lines.push('');

lines.push('## Headline comparison');
lines.push('');
lines.push('| Window | Strategy | Trades | Win% | Sharpe | MaxDD | PnL | Δ Sharpe | Δ MaxDD |');
lines.push('|--------|----------|-------:|-----:|-------:|------:|----:|---------:|--------:|');
lines.push(`| Selection | ${baseline.name} | ${baseline.selTrades} | ${fmtPct(baseline.selWinRate)} | ${f2(baseline.selSharpe)} | ${fmtPct(baseline.selMaxDD)} | ${dollar(baseline.selPnl)} | — | — |`);
const dSelShp = (gated.selSharpe - baseline.selSharpe).toFixed(2);
const dSelDD  = (gated.selMaxDD - baseline.selMaxDD).toFixed(1) + 'pp';
lines.push(`| Selection | ${gated.name} | ${gated.selTrades} | ${fmtPct(gated.selWinRate)} | ${f2(gated.selSharpe)} | ${fmtPct(gated.selMaxDD)} | ${dollar(gated.selPnl)} | ${dSelShp} | ${dSelDD} |`);
lines.push(`| Holdout | ${baseline.name} | ${baseline.holdTrades} | ${fmtPct(baseline.holdWinRate)} | ${f2(baseline.holdSharpe)} | ${fmtPct(baseline.holdMaxDD)} | ${dollar(baseline.holdPnl)} | — | — |`);
const dHoldShp = (gated.holdSharpe - baseline.holdSharpe).toFixed(2);
const dHoldDD  = (gated.holdMaxDD - baseline.holdMaxDD).toFixed(1) + 'pp';
lines.push(`| Holdout | ${gated.name} | ${gated.holdTrades} | ${fmtPct(gated.holdWinRate)} | ${f2(gated.holdSharpe)} | ${fmtPct(gated.holdMaxDD)} | ${dollar(gated.holdPnl)} | ${dHoldShp} | ${dHoldDD} |`);
lines.push('');

// Per-window selection Sharpe for stability check
lines.push('## Per-window selection Sharpe (stability check)');
lines.push('');
lines.push('| Window | Baseline | RV-gated | Δ |');
lines.push('|------:|---------:|---------:|---:|');
for (let i = 0; i < baseline.perWindowSharpe.length; i++) {
  const b = baseline.perWindowSharpe[i];
  const g = gated.perWindowSharpe[i];
  const delta = (g - b).toFixed(2);
  lines.push(`| sel-${i + 1} | ${f2(b)} | ${f2(g)} | ${delta} |`);
}
lines.push('');

// Verdict text
lines.push('## Verdict');
lines.push('');
const baselineSelSharpe = baseline.selSharpe;
const baselineHoldSharpe = baseline.holdSharpe;
const gatedSelSharpe = gated.selSharpe;
const gatedHoldSharpe = gated.holdSharpe;

const selImproved = gatedSelSharpe > baselineSelSharpe + 0.05;
const selDegraded = gatedSelSharpe < baselineSelSharpe - 0.05;
const holdImproved = gatedHoldSharpe > baselineHoldSharpe + 0.05;
const holdDegraded = gatedHoldSharpe < baselineHoldSharpe - 0.05;

if (selImproved && holdImproved) {
  lines.push('**Both windows improved.** Gate is a strong candidate for October dsrM-refresh adoption as a singleton overlay on PMCC F1. Decision rule, threshold, and lookback should be locked exactly as in this run.');
} else if (selImproved && !holdDegraded) {
  lines.push('**Selection improved, holdout neutral.** Gate is a reasonable candidate for October adoption — the holdout doesn\'t penalize it, and the selection lift survives applied as an entry filter. User decision whether the effect-size confidence (small holdout sample) is enough to commit a dsrM slot.');
} else if (selImproved && holdDegraded) {
  lines.push('**Selection improved, holdout degraded.** Gate is overfit to the selection window and should NOT be adopted. Keep PMCC as-is.');
} else if (!selImproved && !holdDegraded) {
  lines.push('**No meaningful improvement either window.** Gate is not worth the dsrM-slot cost. Keep PMCC as-is.');
} else {
  lines.push('**Gate degraded one or both windows.** Do not adopt.');
}
lines.push('');
lines.push('## Caveats');
lines.push('');
lines.push('- The selection what-if-gate Sharpe (in attribution) was 2.06 vs baseline 1.72. The selection result here may differ slightly because applying the gate as an actual entry filter changes which trades carry across window boundaries — different trade set than the post-hoc what-if pruning. This is intentional honesty, not a bug.');
lines.push('- Holdout sample is small (5 windows). A 0.10-0.20 Sharpe delta in either direction may not be statistically distinguishable from noise.');
lines.push('- The gate filters NEW LEAP entries only. Existing PMCC positions continue unaffected — the simulator handles short-call rolls and exits via its own logic.');
lines.push('- Reminder: this is observational. Do not iterate the threshold (1.5) or lookback (5d/60d) based on this result. October adoption decision uses these exact values or none.');
lines.push('');

if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = path.resolve(REPORT_DIR, 'wfa-v1.md');
fs.writeFileSync(reportPath, lines.join('\n'));

const jsonPath = path.resolve(REPORT_DIR, 'wfa-v1-results.json');
fs.writeFileSync(jsonPath, JSON.stringify({
  generated: new Date().toISOString(),
  frozenSpec: { rvGateThreshold: RV_GATE_THRESHOLD, rvLookbacks: { short: 5, long: 60 }, scope: 'new LEAP entries only', config: PMCC_F1_CONFIG },
  windows: { selection: selectionWindows.length, holdout: HOLDOUT_COUNT, holdoutBoundary: firstHoldoutStart },
  signals: { baseline: baselineSignals.length, gated: gatedSignals.length, skipped: skippedDays },
  results: {
    baseline: { ...baseline, trades: baseline.trades.length },
    rvGated:  { ...gated,    trades: gated.trades.length },
  },
  deltas: {
    selection: { sharpe: gated.selSharpe - baseline.selSharpe, maxDD: gated.selMaxDD - baseline.selMaxDD, pnl: gated.selPnl - baseline.selPnl },
    holdout:   { sharpe: gated.holdSharpe - baseline.holdSharpe, maxDD: gated.holdMaxDD - baseline.holdMaxDD, pnl: gated.holdPnl - baseline.holdPnl },
  },
}, null, 2));

console.log(`\nWrote ${reportPath}`);
console.log(`Wrote ${jsonPath}`);

// Brief headline echo
console.log('\n──────────────────────────────────────────────────');
console.log(`Selection:  baseline ${f2(baseline.selSharpe)}/${baseline.selMaxDD.toFixed(1)}% · RV-gated ${f2(gated.selSharpe)}/${gated.selMaxDD.toFixed(1)}%   Δ Sharpe ${dSelShp}`);
console.log(`Holdout:    baseline ${f2(baseline.holdSharpe)}/${baseline.holdMaxDD.toFixed(1)}% · RV-gated ${f2(gated.holdSharpe)}/${gated.holdMaxDD.toFixed(1)}%   Δ Sharpe ${dHoldShp}`);
