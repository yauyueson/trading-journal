/**
 * BCD per-ticker unconditional decomposition.
 *
 * For each of the 23 BCD Tier A+B tickers, run BCD F1 verbatim on a
 * 10-day cadence, maxPositions=1, $2K capital, through the same WFA
 * structure as the sealed F1 anchor. Report per-ticker WFA stats and
 * daily-MtM correlation to QQQ. Aggregate an equal-weight basket roll-up.
 *
 * Purpose (per Codex's review of bcd-rotation v1): before testing any
 * second selection rule, decompose universe-edge from selection-edge
 * from concurrency. If most tickers are weak unconditionally, single-name
 * BCD is the problem and rotation work is wasted. If a subset has edge
 * but momentum picked bad timing, rotation rules are still alive.
 *
 * Setup mirrors the sealed BCD QQQ wide F1 anchor exactly:
 *   - long δ 0.50, short δ 0.20, DTE 30-60, PT 50%, max hold 45d,
 *     min exit DTE 7, bid/ask fills
 *   - 10-day signal-emission cadence from i=60 forward
 *   - maxPositions=1, maxPerTicker=1, $2K per-ticker capital
 *   - WFA 252/126/10 rolling, 5 holdout, holdout boundary 2024-01-22
 *
 * No rotation, no gates, no parameter sweep. One strategy per ticker.
 *
 * Run: npx tsx scripts/autoresearch/lean-wfa-bcd-per-ticker.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB } from '../../src/lib/backtest/chain-cache';
import {
  DEFAULT_LEAP_CONFIG, computeOptionAnalytics,
  type SimConfig, type EntrySignal, type OptionTrade,
} from '../../src/lib/backtest/option-sim';
import { makeDebitSpreadEvaluator } from './worker';
import {
  buildWFAWindows, evaluateConfiguredSignalsWithState,
  computePortfolioDailyMetrics, createConstraintState,
  type ConfiguredSignal, type PortfolioConstraintState, type WindowDef,
} from '../../src/lib/backtest/wfa-options';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(__dirname, '../../backtesting history/credit-spread/reports/bcd-per-ticker');

// ── Universe (23 BCD Tier A+B, post-backfill 2026-04-25) + QQQ baseline ─

const TICKERS: string[] = [
  'AMD', 'MSFT', 'AAPL', 'JPM', 'META', 'ORCL', 'NVDA', 'IWM', 'CRM',
  'BA', 'TSLA', 'CRWD', 'AMZN', 'GS', 'NFLX', 'AVGO', 'PANW', 'COST',
  'LULU', 'SHOP', 'GOOG', 'ANET', 'NOW',
];
const BASELINE_TICKER = 'QQQ';

const BCD_F1_CONFIG: SimConfig = {
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

const WFA = { trainWindowDays: 252, forwardStepDays: 126, purgeGapDays: 10, mode: 'rolling' as const };
const HOLDOUT_COUNT = 5;
const REBALANCE_DAYS = 10;
const CAPITAL = 2_000;

// ── Cache load ──────────────────────────────────────────────────────────

interface DataCache {
  tickers: Record<string, { candles: Array<{ date: string; close: number }> }>;
}

const cachePath = path.resolve(__dirname, 'data-cache.json');
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as DataCache;
const qqqCandles = cache.tickers[BASELINE_TICKER]?.candles;
if (!qqqCandles) { console.error(`ERROR: ${BASELINE_TICKER} not in cache`); process.exit(1); }

initDB(undefined, true);

const allDates: string[] = qqqCandles.map(c => c.date).sort();
const maxDate = allDates[allDates.length - 1];

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

// ── Per-ticker runner ───────────────────────────────────────────────────

interface TickerResult {
  ticker: string;
  selTrades: number; selSharpe: number; selMaxDD: number; selPnl: number; selWinRate: number;
  holdTrades: number; holdSharpe: number; holdMaxDD: number; holdPnl: number; holdWinRate: number;
  selDailyReturns: { date: string; ret: number }[];
  holdDailyReturns: { date: string; ret: number }[];
}

function buildSignals(ticker: string): EntrySignal[] {
  const sigs: EntrySignal[] = [];
  for (let i = 60; i < allDates.length; i += REBALANCE_DAYS) {
    sigs.push({ ticker, date: allDates[i], direction: 'CALL', score: 50 });
  }
  return sigs;
}

function runTicker(ticker: string): TickerResult {
  const evaluator = makeDebitSpreadEvaluator(BCD_F1_CONFIG);
  const exec = { maxPositions: 1, maxPerTicker: 1, startingCapital: CAPITAL };
  const oosMaxDate = combinedWindows[combinedWindows.length - 1].oosEnd;
  const signals = buildSignals(ticker);
  let state: PortfolioConstraintState = createConstraintState();
  const all: OptionTrade[] = [];
  for (const w of combinedWindows) {
    const oosSigs = signals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const configured: ConfiguredSignal[] = oosSigs.map(s => ({ signal: s, config: BCD_F1_CONFIG }));
    const result = evaluateConfiguredSignalsWithState(configured, exec, allDates, oosMaxDate, evaluator, state);
    state = result.state;
    all.push(...result.trades);
  }

  const selTradesArr  = firstHoldoutStart ? all.filter(t => t.entryDate <  firstHoldoutStart) : all;
  const holdTradesArr = firstHoldoutStart ? all.filter(t => t.entryDate >= firstHoldoutStart) : [];

  const selMetrics = computePortfolioDailyMetrics(all, allDates, selStart, selEnd, CAPITAL);
  const finalSelEquity = selMetrics.equityCurve[selMetrics.equityCurve.length - 1]?.equity ?? CAPITAL;
  const selPeak = Math.max(...selMetrics.equityCurve.map(e => e.equity), CAPITAL);
  const holdMetrics = computePortfolioDailyMetrics(all, allDates, holdStart, holdEnd, CAPITAL, finalSelEquity, selPeak);

  const selAn  = computeOptionAnalytics(selTradesArr,  { allTradingDates: allDates });
  const holdAn = computeOptionAnalytics(holdTradesArr, { allTradingDates: allDates });

  return {
    ticker,
    selTrades: selTradesArr.length, selSharpe: selMetrics.sharpe, selMaxDD: selMetrics.maxDrawdownPct,
    selPnl: selAn.totalPnl, selWinRate: selAn.winRate,
    holdTrades: holdTradesArr.length, holdSharpe: holdMetrics.sharpe, holdMaxDD: holdMetrics.maxDrawdownPct,
    holdPnl: holdAn.totalPnl, holdWinRate: holdAn.winRate,
    selDailyReturns:  selMetrics.equityCurve.map((e, i) => ({ date: e.date, ret: selMetrics.dailyReturns[i] ?? 0 })),
    holdDailyReturns: holdMetrics.equityCurve.map((e, i) => ({ date: e.date, ret: holdMetrics.dailyReturns[i] ?? 0 })),
  };
}

// ── Run baseline + each ticker ───────────────────────────────────────────

console.log(`\nRunning QQQ baseline...`);
const t0 = Date.now();
const baseline = runTicker(BASELINE_TICKER);
console.log(`  QQQ ${baseline.selTrades}sel + ${baseline.holdTrades}hold · sel ${baseline.selSharpe.toFixed(2)}/${baseline.selMaxDD.toFixed(1)}% · hold ${baseline.holdSharpe.toFixed(2)}/${baseline.holdMaxDD.toFixed(1)}%`);

console.log(`\nRunning per-ticker BCD on ${TICKERS.length} tickers...`);
const results: TickerResult[] = [];
for (const t of TICKERS) {
  const r = runTicker(t);
  results.push(r);
  console.log(`  ${t.padEnd(5)} ${r.selTrades}sel+${r.holdTrades}hold · sel ${r.selSharpe.toFixed(2)}/${r.selMaxDD.toFixed(1)}% · hold ${r.holdSharpe.toFixed(2)}/${r.holdMaxDD.toFixed(1)}% · sel PnL $${r.selPnl.toFixed(0)}`);
}
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

// ── Daily-MtM correlation per ticker vs baseline ────────────────────────

function pearsonByDate(a: { date: string; ret: number }[], b: { date: string; ret: number }[]): { r: number; n: number } {
  const bMap = new Map(b.map(x => [x.date, x.ret]));
  const xs: number[] = [], ys: number[] = [];
  for (const { date, ret } of a) {
    const br = bMap.get(date);
    if (br == null) continue;
    xs.push(ret); ys.push(br);
  }
  if (xs.length < 20) return { r: 0, n: xs.length };
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx  += (xs[i] - mx) ** 2;
    dy  += (ys[i] - my) ** 2;
  }
  return { r: dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0, n: xs.length };
}

interface RowEnriched extends TickerResult {
  corrSel: number; corrHold: number;
}

const enriched: RowEnriched[] = results.map(r => ({
  ...r,
  corrSel:  pearsonByDate(r.selDailyReturns,  baseline.selDailyReturns).r,
  corrHold: pearsonByDate(r.holdDailyReturns, baseline.holdDailyReturns).r,
}));

// ── Equal-weight basket: combine 23 ticker daily returns ────────────────

function basketDaily(returns: { date: string; ret: number }[][]): { date: string; ret: number }[] {
  const dateSet = new Set<string>();
  for (const arr of returns) for (const e of arr) dateSet.add(e.date);
  const dates = [...dateSet].sort();
  const out: { date: string; ret: number }[] = [];
  for (const d of dates) {
    let sum = 0;
    for (const arr of returns) {
      const e = arr.find(x => x.date === d);
      sum += e?.ret ?? 0;
    }
    out.push({ date: d, ret: sum / returns.length });
  }
  return out;
}

const basketSelDaily  = basketDaily(results.map(r => r.selDailyReturns));
const basketHoldDaily = basketDaily(results.map(r => r.holdDailyReturns));

function sharpeFromReturns(rets: number[]): number {
  if (rets.length < 20) return 0;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, rets.length - 1);
  const sd = Math.sqrt(v);
  return sd > 0 ? (m / sd) * Math.sqrt(252) : 0;
}

function maxDDFromReturns(rets: number[]): number {
  let equity = 1, peak = 1, maxDD = 0;
  for (const r of rets) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD * 100;
}

const basketSelSharpe  = sharpeFromReturns(basketSelDaily.map(x => x.ret));
const basketSelMaxDD   = maxDDFromReturns(basketSelDaily.map(x => x.ret));
const basketHoldSharpe = sharpeFromReturns(basketHoldDaily.map(x => x.ret));
const basketHoldMaxDD  = maxDDFromReturns(basketHoldDaily.map(x => x.ret));
const basketCorrSel  = pearsonByDate(basketSelDaily,  baseline.selDailyReturns).r;
const basketCorrHold = pearsonByDate(basketHoldDaily, baseline.holdDailyReturns).r;

// Aggregate stats: tickers with positive holdout sharpe, mean PnL, etc.
const positiveHoldSharpe = enriched.filter(r => r.holdSharpe > 0);
const positiveBothSharpe = enriched.filter(r => r.selSharpe > 0 && r.holdSharpe > 0);
const beatQqqHold = enriched.filter(r => r.holdSharpe > baseline.holdSharpe);
const totalSelPnl  = enriched.reduce((s, r) => s + r.selPnl,  0);
const totalHoldPnl = enriched.reduce((s, r) => s + r.holdPnl, 0);

// ── Render report ───────────────────────────────────────────────────────

function dollar(n: number): string { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString(); }
function fmtPct(n: number, digits = 1): string { return n.toFixed(digits) + '%'; }
function f2(n: number): string { return n.toFixed(2); }

const lines: string[] = [];
lines.push('# BCD per-ticker unconditional decomposition');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push('');
lines.push('## Question');
lines.push('');
lines.push('Does single-name BCD have unconditional edge across the 23-name BCD Tier A+B universe? This separates universe-edge from selection-edge from concurrency, before testing another rotation rule.');
lines.push('');
lines.push('## Setup');
lines.push('');
lines.push(`- **Universe:** ${TICKERS.length} BCD Tier A+B tickers (post-backfill scorecard, 2026-04-25)`);
lines.push(`- **Strategy:** BCD F1 verbatim — long δ 0.50, short δ 0.20, DTE 30-60, PT 50%, max hold 45d, min exit DTE 7, bid/ask fills, ${REBALANCE_DAYS}-day cadence`);
lines.push(`- **Per-ticker capital:** $${CAPITAL.toLocaleString()}, maxPositions=1, maxPerTicker=1`);
lines.push(`- **WFA:** 252/126/10 rolling, ${selectionWindows.length} selection + ${HOLDOUT_COUNT} holdout windows · holdout boundary ${firstHoldoutStart}`);
lines.push(`- **Baseline:** QQQ at the same config — the sealed F1 anchor.`);
lines.push('');

lines.push('## Per-ticker WFA stats — ranked by holdout Sharpe');
lines.push('');
lines.push('Highest holdout Sharpe at top. **Bold** rows beat the QQQ baseline holdout Sharpe.');
lines.push('');
lines.push(`Baseline (QQQ): selection Sharpe ${f2(baseline.selSharpe)} / MaxDD ${fmtPct(baseline.selMaxDD)} · holdout Sharpe ${f2(baseline.holdSharpe)} / MaxDD ${fmtPct(baseline.holdMaxDD)}.`);
lines.push('');
lines.push('| Rank | Ticker | sel.Trd | sel.Win% | sel.Shp | sel.DD | sel.PnL | hold.Trd | hold.Win% | hold.Shp | hold.DD | hold.PnL | corr.sel | corr.hold |');
lines.push('|----:|--------|--------:|---------:|--------:|-------:|--------:|---------:|----------:|---------:|--------:|---------:|---------:|----------:|');
const rankedByHoldoutSharpe = [...enriched].sort((a, b) => b.holdSharpe - a.holdSharpe);
for (let i = 0; i < rankedByHoldoutSharpe.length; i++) {
  const r = rankedByHoldoutSharpe[i];
  const beat = r.holdSharpe > baseline.holdSharpe;
  const tickerCell = beat ? `**${r.ticker}**` : r.ticker;
  lines.push(
    `| ${i + 1} | ${tickerCell} | ${r.selTrades} | ${fmtPct(r.selWinRate)} | ${f2(r.selSharpe)} | ${fmtPct(r.selMaxDD)} | ${dollar(r.selPnl)} | ` +
    `${r.holdTrades} | ${fmtPct(r.holdWinRate)} | ${f2(r.holdSharpe)} | ${fmtPct(r.holdMaxDD)} | ${dollar(r.holdPnl)} | ${f2(r.corrSel)} | ${f2(r.corrHold)} |`,
  );
}
lines.push('');

lines.push('## Equal-weight basket (avg of 23 single-ticker BCD daily returns)');
lines.push('');
lines.push('| Window | Sharpe | MaxDD | Corr to QQQ |');
lines.push('|--------|-------:|------:|------------:|');
lines.push(`| Selection | ${f2(basketSelSharpe)} | ${fmtPct(basketSelMaxDD)} | ${f2(basketCorrSel)} |`);
lines.push(`| Holdout | ${f2(basketHoldSharpe)} | ${fmtPct(basketHoldMaxDD)} | ${f2(basketCorrHold)} |`);
lines.push('');
lines.push('vs QQQ baseline:');
lines.push('');
lines.push('| Window | Sharpe | MaxDD |');
lines.push('|--------|-------:|------:|');
lines.push(`| Selection | ${f2(baseline.selSharpe)} | ${fmtPct(baseline.selMaxDD)} |`);
lines.push(`| Holdout | ${f2(baseline.holdSharpe)} | ${fmtPct(baseline.holdMaxDD)} |`);
lines.push('');

lines.push('## Aggregate counts');
lines.push('');
lines.push(`- **${positiveBothSharpe.length} of ${TICKERS.length}** tickers had positive Sharpe in both selection AND holdout.`);
lines.push(`- **${positiveHoldSharpe.length} of ${TICKERS.length}** tickers had positive holdout Sharpe.`);
lines.push(`- **${beatQqqHold.length} of ${TICKERS.length}** tickers beat the QQQ baseline holdout Sharpe (${f2(baseline.holdSharpe)}).`);
lines.push(`- Total selection PnL across all 23 tickers: ${dollar(totalSelPnl)} · holdout PnL: ${dollar(totalHoldPnl)}.`);
lines.push('');

// Top movers each side
const topSelect = [...enriched].sort((a, b) => b.selPnl - a.selPnl).slice(0, 5);
const botSelect = [...enriched].sort((a, b) => a.selPnl - b.selPnl).slice(0, 5);
const topHold = [...enriched].sort((a, b) => b.holdPnl - a.holdPnl).slice(0, 5);
const botHold = [...enriched].sort((a, b) => a.holdPnl - b.holdPnl).slice(0, 5);

lines.push('## PnL bookends');
lines.push('');
lines.push(`Selection top 5: ${topSelect.map(r => `${r.ticker} ${dollar(r.selPnl)}`).join(' · ')}`);
lines.push('');
lines.push(`Selection bottom 5: ${botSelect.map(r => `${r.ticker} ${dollar(r.selPnl)}`).join(' · ')}`);
lines.push('');
lines.push(`Holdout top 5: ${topHold.map(r => `${r.ticker} ${dollar(r.holdPnl)}`).join(' · ')}`);
lines.push('');
lines.push(`Holdout bottom 5: ${botHold.map(r => `${r.ticker} ${dollar(r.holdPnl)}`).join(' · ')}`);
lines.push('');

lines.push('## How to read this');
lines.push('');
lines.push('Codex\'s decomposition logic:');
lines.push('');
lines.push('- **If most tickers have poor holdout Sharpe / negative PnL:** single-name BCD is the universe-level problem. Stop rotation research. The earlier rotation v1 negative result was a structural BCD-on-single-names issue, not a momentum-rule issue.');
lines.push('- **If many tickers have positive holdout Sharpe but the rotation rule still failed:** universe has edge, momentum-rank picks bad timing. Selection rules are still alive. Try non-momentum (low-correlation, IV-rank tilt, dispersion) before declaring rotation dead.');
lines.push('- **If equal-weight basket Sharpe is competitive with QQQ AND correlation to QQQ is meaningfully <1.0:** a static "core QQQ + small satellite" book is real. The satellite weight question becomes the next test, not whether to expand at all.');
lines.push('');
lines.push('## Caveats');
lines.push('');
lines.push('- **No earnings calendar yet.** Single-name losses likely cluster around earnings; this isn\'t isolated here.');
lines.push('- **$2K capital constraint.** High-priced underlyings (AMZN at $1500+) may not afford every BCD spread the simulator constructs; signals returning null reduce trade counts. The trade-count column shows the actual sample.');
lines.push('- **Daily-MtM correlation is computed over the full window grid** (mostly zeros when both strategies are flat). Interpret as a directional signal, not a precise structural correlation.');
lines.push('- **Equal-weight basket is a paper construct** — running 23 concurrent $2K BCD positions = $46K total capital. Sharpe is unitless so the comparison is honest, but absolute PnL is 23× scale.');
lines.push('');

if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = path.resolve(REPORT_DIR, 'wfa-v1.md');
fs.writeFileSync(reportPath, lines.join('\n'));

const jsonPath = path.resolve(REPORT_DIR, 'wfa-v1-results.json');
fs.writeFileSync(jsonPath, JSON.stringify({
  generated: new Date().toISOString(),
  universe: TICKERS,
  config: { capital: CAPITAL, cadenceDays: REBALANCE_DAYS, maxPositions: 1 },
  windows: { selection: selectionWindows.length, holdout: HOLDOUT_COUNT, holdoutBoundary: firstHoldoutStart },
  baseline: { ticker: BASELINE_TICKER, ...baseline, selDailyReturns: undefined, holdDailyReturns: undefined },
  perTicker: enriched.map(r => ({ ...r, selDailyReturns: undefined, holdDailyReturns: undefined })),
  basket: {
    selSharpe: basketSelSharpe, selMaxDD: basketSelMaxDD,
    holdSharpe: basketHoldSharpe, holdMaxDD: basketHoldMaxDD,
    corrSel: basketCorrSel, corrHold: basketCorrHold,
  },
  aggregates: {
    positiveHoldSharpe: positiveHoldSharpe.length,
    positiveBothSharpe: positiveBothSharpe.length,
    beatQqqHoldSharpe: beatQqqHold.length,
    totalSelPnl, totalHoldPnl,
  },
}, null, 2));

console.log(`\nWrote ${reportPath}`);
console.log(`Wrote ${jsonPath}`);

// Brief headline echo
console.log('\n──────────────────────────────────────────────────');
console.log(`QQQ baseline:        sel ${f2(baseline.selSharpe)}/${baseline.selMaxDD.toFixed(1)}%  hold ${f2(baseline.holdSharpe)}/${baseline.holdMaxDD.toFixed(1)}%`);
console.log(`Equal-weight basket: sel ${f2(basketSelSharpe)}/${basketSelMaxDD.toFixed(1)}%  hold ${f2(basketHoldSharpe)}/${basketHoldMaxDD.toFixed(1)}%  corr.hold ${f2(basketCorrHold)}`);
console.log(`Tickers w/ +Shp both: ${positiveBothSharpe.length}/${TICKERS.length}  ·  beat QQQ holdout Sharpe: ${beatQqqHold.length}/${TICKERS.length}`);
