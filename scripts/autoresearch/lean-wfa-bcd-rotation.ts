/**
 * BCD rotation WFA — v1, intentionally narrow.
 *
 * Question: does liquidity-filtered mega-cap BCD rotation beat or
 * diversify QQQ-only BCD under the same WFA discipline?
 *
 * Universe: 23 BCD Tier A+B tickers from the liquidity scorecard
 *   (post-backfill state, 2026-04-25).
 *
 * Structure: BCD F1 config verbatim — long δ 0.50, short δ 0.20,
 *   DTE 30-60, PT 50%, max hold 45d, min exit DTE 7, bid/ask fills.
 *   No parameter sweep, no entry gate (other than the optional RV-shock
 *   variant noted below).
 *
 * Rotation rule: every 10 trading days, rank eligible tickers by
 *   (126d return − 21d return) / 63d realized vol  (12-1 momentum
 *   risk-adjusted). Take top 3. Emit BCD CALL signals for those 3.
 *   Tickers with <126d history on the rebalance date are excluded.
 *
 * Capital: $6,000 total (3 slots × $2K per slot, matching the F1
 *   per-position size). maxPositions=3, maxPerTicker=1.
 *
 * QQQ-only baseline: BCD F1 anchor exactly — $2K capital, maxPositions=1,
 *   QQQ-only, every 10 trading days.
 *
 * Optional variant: same as rotation, but skip rebalance dates where
 *   QQQ RV5 / RV60 ≥ 1.5 (the only structural gate that survived the
 *   sealed-anchor regime attribution). RV is QQQ's, not per-ticker.
 *
 * WFA: 252 train / 126 forward step / 10 purge gap, rolling, 5 holdout.
 *   Identical to the sealed BCD F1 anchor.
 *
 * No pre-reg, no dsrM cost, no sealer. Output is a parked artifact
 * pending the 2026-10-20 holdout boundary refresh.
 *
 * Run: npx tsx scripts/autoresearch/lean-wfa-bcd-rotation.ts
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
const REPORT_DIR = path.resolve(__dirname, '../../backtesting history/credit-spread/reports/bcd-rotation-mega-cap');

// ── Universe (23 BCD Tier A+B tickers, post-backfill 2026-04-25) ─────────

const TICKERS: string[] = [
  'AMD', 'MSFT', 'AAPL', 'JPM', 'META', 'ORCL', 'NVDA', 'IWM', 'CRM',
  'BA', 'TSLA', 'CRWD', 'AMZN', 'GS', 'NFLX', 'AVGO', 'PANW', 'COST',
  'LULU', 'SHOP', 'GOOG', 'ANET', 'NOW',
];

// ── Strategy params (F1 verbatim) ────────────────────────────────────────

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
const TOP_N = 3;
const ROTATION_CAPITAL = 6_000;
const BASELINE_CAPITAL = 2_000;
const RV_ELEVATED_THRESHOLD = 1.5;

// ── Cache load ──────────────────────────────────────────────────────────

interface DataCache {
  tickers: Record<string, { candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> }>;
}

const cachePath = path.resolve(__dirname, 'data-cache.json');
if (!fs.existsSync(cachePath)) { console.error(`ERROR: ${cachePath} missing.`); process.exit(1); }
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as DataCache;
const qqqCandles = cache.tickers.QQQ?.candles;
if (!qqqCandles) { console.error('ERROR: QQQ not in cache'); process.exit(1); }
for (const t of TICKERS) {
  if (!cache.tickers[t]?.candles) { console.error(`ERROR: ${t} not in cache`); process.exit(1); }
}

initDB(undefined, true);

const allDates: string[] = qqqCandles.map(c => c.date).sort();
const maxDate = allDates[allDates.length - 1];
const dateIdx = new Map<string, number>(allDates.map((d, i) => [d, i]));

// Per-ticker close-by-date for ranking + RV computation.
const closesByTicker: Record<string, Map<string, number>> = {};
for (const t of TICKERS) {
  const m = new Map<string, number>();
  for (const c of cache.tickers[t]!.candles) m.set(c.date, c.close);
  closesByTicker[t] = m;
}
const qqqCloseByDate = new Map<string, number>();
for (const c of qqqCandles) qqqCloseByDate.set(c.date, c.close);

console.log(`Loaded ${TICKERS.length} tickers + QQQ. Trading days: ${allDates.length} (${allDates[0]} → ${maxDate})`);

// ── Realized vol (annualized) per ticker, per date ───────────────────────

function rvSeries(closes: Map<string, number>, window: number): Map<string, number> {
  const out = new Map<string, number>();
  const sortedDates = [...closes.keys()].sort();
  const logRet: number[] = [0];
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = closes.get(sortedDates[i - 1])!;
    const cur  = closes.get(sortedDates[i])!;
    logRet.push(prev > 0 && cur > 0 ? Math.log(cur / prev) : 0);
  }
  for (let i = window; i < sortedDates.length; i++) {
    const slice = logRet.slice(i - window + 1, i + 1);
    const mean = slice.reduce((s, x) => s + x, 0) / slice.length;
    const variance = slice.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, slice.length - 1);
    out.set(sortedDates[i], Math.sqrt(variance * 252));
  }
  return out;
}

const rv63ByTicker: Record<string, Map<string, number>> = {};
for (const t of TICKERS) rv63ByTicker[t] = rvSeries(closesByTicker[t], 63);
const qqqRv5  = rvSeries(qqqCloseByDate, 5);
const qqqRv60 = rvSeries(qqqCloseByDate, 60);

// ── Rotation ranking: (126d ret − 21d ret) / 63d RV ─────────────────────

interface RankedTicker { ticker: string; score: number; }

function rankAt(date: string): RankedTicker[] {
  const out: RankedTicker[] = [];
  for (const t of TICKERS) {
    const closes = closesByTicker[t];
    const cur = closes.get(date);
    if (cur == null || cur <= 0) continue;
    // Need ≥126 trading days of history before `date` for this ticker.
    const tickerDates = [...closes.keys()].sort();
    const idx = tickerDates.indexOf(date);
    if (idx < 126) continue;
    const px126 = closes.get(tickerDates[idx - 126]);
    const px21  = closes.get(tickerDates[idx - 21]);
    if (px126 == null || px21 == null || px126 <= 0 || px21 <= 0) continue;
    const ret126 = (cur - px126) / px126;
    const ret21  = (cur - px21)  / px21;
    const rv = rv63ByTicker[t].get(date);
    if (rv == null || rv <= 0) continue;
    const score = (ret126 - ret21) / rv;
    out.push({ ticker: t, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ── Build rebalance dates + signals ─────────────────────────────────────

const rebalanceDates: string[] = [];
for (let i = 60; i < allDates.length; i += REBALANCE_DAYS) rebalanceDates.push(allDates[i]);
console.log(`${rebalanceDates.length} rebalance dates (${REBALANCE_DAYS}-day cadence from i=60)`);

interface RotationOutcome {
  rotationSignals: EntrySignal[];
  rotationRvFilteredSignals: EntrySignal[];
  pickFreq: Record<string, number>;
  pickFreqRvFiltered: Record<string, number>;
  rebalancesSkipped: number;
}

function buildRotationSignals(): RotationOutcome {
  const signals: EntrySignal[] = [];
  const signalsRv: EntrySignal[] = [];
  const freq: Record<string, number> = {};
  const freqRv: Record<string, number> = {};
  for (const t of TICKERS) { freq[t] = 0; freqRv[t] = 0; }
  let skipped = 0;

  for (const d of rebalanceDates) {
    const ranked = rankAt(d);
    if (ranked.length < TOP_N) continue;
    const top = ranked.slice(0, TOP_N);
    for (const r of top) {
      signals.push({ ticker: r.ticker, date: d, direction: 'CALL', score: 50 });
      freq[r.ticker] = (freq[r.ticker] ?? 0) + 1;
    }

    // RV-elevated variant: skip the rebalance entirely if QQQ RV5/RV60 ≥ 1.5.
    const rv5  = qqqRv5.get(d);
    const rv60 = qqqRv60.get(d);
    const rvElevated = rv5 != null && rv60 != null && rv60 > 0 && (rv5 / rv60) >= RV_ELEVATED_THRESHOLD;
    if (rvElevated) { skipped += 1; continue; }
    for (const r of top) {
      signalsRv.push({ ticker: r.ticker, date: d, direction: 'CALL', score: 50 });
      freqRv[r.ticker] = (freqRv[r.ticker] ?? 0) + 1;
    }
  }
  return { rotationSignals: signals, rotationRvFilteredSignals: signalsRv, pickFreq: freq, pickFreqRvFiltered: freqRv, rebalancesSkipped: skipped };
}

const rotation = buildRotationSignals();
console.log(`Rotation signals: ${rotation.rotationSignals.length} · RV-filtered: ${rotation.rotationRvFilteredSignals.length} (${rotation.rebalancesSkipped} rebalances skipped)`);

// QQQ-only baseline: emit a CALL on QQQ at every rebalance date.
const baselineSignals: EntrySignal[] = rebalanceDates.map(d => ({
  ticker: 'QQQ', date: d, direction: 'CALL', score: 50,
}));

// ── WFA windows ─────────────────────────────────────────────────────────

const wfaStartDate = allDates.find(d => d >= '2018-01-01') ?? allDates[0];
const allWindows = buildWFAWindows(allDates, { ...WFA, startDate: wfaStartDate, endDate: maxDate });
const selectionWindows = allWindows.slice(0, -HOLDOUT_COUNT);
const holdoutWindows = allWindows.slice(-HOLDOUT_COUNT);
const combinedWindows: WindowDef[] = [...selectionWindows, ...holdoutWindows];
const firstHoldoutStart = holdoutWindows[0]?.oosStart ?? '';

console.log(`WFA: ${selectionWindows.length} sel + ${holdoutWindows.length} holdout · holdout boundary ${firstHoldoutStart}`);

// ── Strategy runner ─────────────────────────────────────────────────────

interface StrategyResult {
  name: string;
  trades: OptionTrade[];
  capital: number;
  selStart: string; selEnd: string;
  holdStart: string; holdEnd: string;
  // Computed below
  selSharpe: number; selMaxDD: number; selPnl: number; selTrades: number; selWinRate: number;
  holdSharpe: number; holdMaxDD: number; holdPnl: number; holdTrades: number; holdWinRate: number;
  // Daily returns (selection then holdout, same date grid as windows)
  selDailyReturns: { date: string; ret: number }[];
  holdDailyReturns: { date: string; ret: number }[];
}

function runStrategy(name: string, signals: EntrySignal[], capital: number, maxPositions: number, config: SimConfig = BCD_F1_CONFIG): StrategyResult {
  const evaluator = makeDebitSpreadEvaluator(config);
  const exec = { maxPositions, maxPerTicker: 1, startingCapital: capital };
  const oosMaxDate = combinedWindows[combinedWindows.length - 1].oosEnd;
  let state: PortfolioConstraintState = createConstraintState();
  const all: OptionTrade[] = [];
  for (const w of combinedWindows) {
    const oosSigs = signals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const configured: ConfiguredSignal[] = oosSigs.map(s => ({ signal: s, config }));
    const result = evaluateConfiguredSignalsWithState(configured, exec, allDates, oosMaxDate, evaluator, state);
    state = result.state;
    all.push(...result.trades);
  }

  const selStart = selectionWindows[0]?.oosStart ?? allDates[0];
  const selEnd   = selectionWindows[selectionWindows.length - 1]?.oosEnd ?? maxDate;
  const holdStart = holdoutWindows[0]?.oosStart ?? '';
  const holdEnd   = holdoutWindows[holdoutWindows.length - 1]?.oosEnd ?? maxDate;

  const selTradesArr  = firstHoldoutStart ? all.filter(t => t.entryDate <  firstHoldoutStart) : all;
  const holdTradesArr = firstHoldoutStart ? all.filter(t => t.entryDate >= firstHoldoutStart) : [];

  const selMetrics  = computePortfolioDailyMetrics(all, allDates, selStart, selEnd, capital);
  const finalSelEquity = selMetrics.equityCurve[selMetrics.equityCurve.length - 1]?.equity ?? capital;
  const selPeak = Math.max(...selMetrics.equityCurve.map(e => e.equity), capital);
  const holdMetrics = computePortfolioDailyMetrics(all, allDates, holdStart, holdEnd, capital, finalSelEquity, selPeak);

  const selAn  = computeOptionAnalytics(selTradesArr,  { allTradingDates: allDates });
  const holdAn = computeOptionAnalytics(holdTradesArr, { allTradingDates: allDates });

  return {
    name, trades: all, capital, selStart, selEnd, holdStart, holdEnd,
    selSharpe: selMetrics.sharpe, selMaxDD: selMetrics.maxDrawdownPct,
    selPnl: selAn.totalPnl, selTrades: selTradesArr.length, selWinRate: selAn.winRate,
    holdSharpe: holdMetrics.sharpe, holdMaxDD: holdMetrics.maxDrawdownPct,
    holdPnl: holdAn.totalPnl, holdTrades: holdTradesArr.length, holdWinRate: holdAn.winRate,
    selDailyReturns: selMetrics.equityCurve.map((e, i) => ({ date: e.date, ret: selMetrics.dailyReturns[i] ?? 0 })),
    holdDailyReturns: holdMetrics.equityCurve.map((e, i) => ({ date: e.date, ret: holdMetrics.dailyReturns[i] ?? 0 })),
  };
}

console.log('\nRunning strategies...');
const t0 = Date.now();

const baseline = runStrategy('QQQ-only baseline (F1 anchor)', baselineSignals, BASELINE_CAPITAL, 1);
console.log(`  baseline   ${baseline.trades.length}t  sel ${baseline.selSharpe.toFixed(2)}/${baseline.selMaxDD.toFixed(1)}%  hold ${baseline.holdSharpe.toFixed(2)}/${baseline.holdMaxDD.toFixed(1)}%`);

const rotationStrat = runStrategy('Rotation top-3', rotation.rotationSignals, ROTATION_CAPITAL, TOP_N);
console.log(`  rotation   ${rotationStrat.trades.length}t  sel ${rotationStrat.selSharpe.toFixed(2)}/${rotationStrat.selMaxDD.toFixed(1)}%  hold ${rotationStrat.holdSharpe.toFixed(2)}/${rotationStrat.holdMaxDD.toFixed(1)}%`);

const rotationRv = runStrategy('Rotation top-3 + RV filter', rotation.rotationRvFilteredSignals, ROTATION_CAPITAL, TOP_N);
console.log(`  rot+rv     ${rotationRv.trades.length}t  sel ${rotationRv.selSharpe.toFixed(2)}/${rotationRv.selMaxDD.toFixed(1)}%  hold ${rotationRv.holdSharpe.toFixed(2)}/${rotationRv.holdMaxDD.toFixed(1)}%`);

console.log(`Strategies done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── Daily-return correlation: rotation vs baseline ──────────────────────

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

const corrSel  = pearsonByDate(rotationStrat.selDailyReturns,  baseline.selDailyReturns);
const corrHold = pearsonByDate(rotationStrat.holdDailyReturns, baseline.holdDailyReturns);
const corrSelRv  = pearsonByDate(rotationRv.selDailyReturns,  baseline.selDailyReturns);
const corrHoldRv = pearsonByDate(rotationRv.holdDailyReturns, baseline.holdDailyReturns);

// ── Per-ticker contribution (rotation only) ─────────────────────────────

interface TickerContribution { ticker: string; picks: number; trades: number; wins: number; losses: number; pnl: number; }

function tickerContribution(trades: OptionTrade[], picks: Record<string, number>): TickerContribution[] {
  const by = new Map<string, OptionTrade[]>();
  for (const t of trades) {
    if (!by.has(t.ticker)) by.set(t.ticker, []);
    by.get(t.ticker)!.push(t);
  }
  const out: TickerContribution[] = [];
  for (const t of TICKERS) {
    const ts = by.get(t) ?? [];
    const wins = ts.filter(x => x.pnl > 0).length;
    out.push({
      ticker: t, picks: picks[t] ?? 0,
      trades: ts.length, wins, losses: ts.length - wins,
      pnl: ts.reduce((s, x) => s + x.pnl, 0),
    });
  }
  out.sort((a, b) => b.pnl - a.pnl);
  return out;
}

const rotationContribution = tickerContribution(rotationStrat.trades, rotation.pickFreq);
const rotationRvContribution = tickerContribution(rotationRv.trades, rotation.pickFreqRvFiltered);

// ── Render report ───────────────────────────────────────────────────────

function dollar(n: number): string { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString(); }
function fmtPct(n: number, digits = 1): string { return n.toFixed(digits) + '%'; }

const lines: string[] = [];
lines.push('# BCD rotation WFA — v1');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push('');
lines.push('## Question');
lines.push('');
lines.push('Does liquidity-filtered mega-cap BCD rotation beat or diversify QQQ-only BCD under the same WFA discipline?');
lines.push('');
lines.push('## Setup');
lines.push('');
lines.push(`- **Universe:** ${TICKERS.length} tickers (BCD Tier A+B from liquidity scorecard, post-backfill 2026-04-25): ${TICKERS.join(', ')}`);
lines.push(`- **Strategy structure:** BCD F1 verbatim — long δ 0.50, short δ 0.20, DTE 30-60, PT 50%, max hold 45d, min exit DTE 7, bid/ask fills`);
lines.push(`- **Rotation rule:** every ${REBALANCE_DAYS} trading days, top ${TOP_N} eligible tickers by (126d return − 21d return) / 63d realized vol`);
lines.push(`- **WFA:** 252 train / 126 forward / 10 purge / rolling, ${selectionWindows.length} selection + ${HOLDOUT_COUNT} holdout windows`);
lines.push(`- **Capital:** rotation $${ROTATION_CAPITAL.toLocaleString()} (${TOP_N} slots × $${BASELINE_CAPITAL.toLocaleString()}/slot), baseline $${BASELINE_CAPITAL.toLocaleString()} × 1 slot`);
lines.push(`- **No gates** in primary rotation. Optional variant adds RV5/RV60 ≥ ${RV_ELEVATED_THRESHOLD} skip on QQQ.`);
lines.push(`- **Holdout boundary:** ${firstHoldoutStart}`);
lines.push('');

// Headline comparison
lines.push('## Headline comparison');
lines.push('');
lines.push('### Selection (everything before holdout)');
lines.push('');
lines.push('| Strategy | Trades | Win% | Sharpe | MaxDD | PnL | Sharpe Δ | DD Δ | Corr to baseline |');
lines.push('|----------|-------:|-----:|-------:|------:|----:|---------:|-----:|-----------------:|');
const baseSelSharpe = baseline.selSharpe;
const baseSelDD = baseline.selMaxDD;
const sel = (s: StrategyResult, corr: number | null) => {
  const dSh = corr === null ? '—' : (s.selSharpe - baseSelSharpe).toFixed(2);
  const dDD = corr === null ? '—' : (s.selMaxDD - baseSelDD).toFixed(1) + 'pp';
  const cor = corr === null ? '—' : corr.toFixed(2);
  lines.push(`| ${s.name} | ${s.selTrades} | ${fmtPct(s.selWinRate)} | ${s.selSharpe.toFixed(2)} | ${fmtPct(s.selMaxDD)} | ${dollar(s.selPnl)} | ${dSh} | ${dDD} | ${cor} |`);
};
sel(baseline, null);
sel(rotationStrat, corrSel.r);
sel(rotationRv, corrSelRv.r);
lines.push('');

lines.push('### Holdout (last 5 windows)');
lines.push('');
lines.push('| Strategy | Trades | Win% | Sharpe | MaxDD | PnL | Sharpe Δ | DD Δ | Corr to baseline |');
lines.push('|----------|-------:|-----:|-------:|------:|----:|---------:|-----:|-----------------:|');
const baseHoldSharpe = baseline.holdSharpe;
const baseHoldDD = baseline.holdMaxDD;
const hol = (s: StrategyResult, corr: number | null) => {
  const dSh = corr === null ? '—' : (s.holdSharpe - baseHoldSharpe).toFixed(2);
  const dDD = corr === null ? '—' : (s.holdMaxDD - baseHoldDD).toFixed(1) + 'pp';
  const cor = corr === null ? '—' : corr.toFixed(2);
  lines.push(`| ${s.name} | ${s.holdTrades} | ${fmtPct(s.holdWinRate)} | ${s.holdSharpe.toFixed(2)} | ${fmtPct(s.holdMaxDD)} | ${dollar(s.holdPnl)} | ${dSh} | ${dDD} | ${cor} |`);
};
hol(baseline, null);
hol(rotationStrat, corrHold.r);
hol(rotationRv, corrHoldRv.r);
lines.push('');

// Per-ticker contribution
lines.push('## Per-ticker contribution (Rotation top-3)');
lines.push('');
lines.push('| Ticker | Picks | Trades | Wins | Losses | Win% | Sum PnL |');
lines.push('|--------|------:|-------:|-----:|-------:|-----:|--------:|');
for (const c of rotationContribution) {
  const wr = c.trades ? (c.wins / c.trades) * 100 : 0;
  lines.push(`| ${c.ticker} | ${c.picks} | ${c.trades} | ${c.wins} | ${c.losses} | ${fmtPct(wr)} | ${dollar(c.pnl)} |`);
}
lines.push('');

// RV-filtered contribution (only if it differs meaningfully)
lines.push('## Per-ticker contribution (Rotation + RV filter)');
lines.push('');
lines.push(`Rebalances skipped due to QQQ RV5/RV60 ≥ ${RV_ELEVATED_THRESHOLD}: **${rotation.rebalancesSkipped}** of ${rebalanceDates.length} (${fmtPct((rotation.rebalancesSkipped / rebalanceDates.length) * 100)}).`);
lines.push('');
lines.push('| Ticker | Picks | Trades | Wins | Losses | Win% | Sum PnL |');
lines.push('|--------|------:|-------:|-----:|-------:|-----:|--------:|');
for (const c of rotationRvContribution) {
  const wr = c.trades ? (c.wins / c.trades) * 100 : 0;
  lines.push(`| ${c.ticker} | ${c.picks} | ${c.trades} | ${c.wins} | ${c.losses} | ${fmtPct(wr)} | ${dollar(c.pnl)} |`);
}
lines.push('');

// Rebalance pick frequency (top of report)
lines.push('## Pick concentration check');
lines.push('');
lines.push(`Rotation top-3 was selected from ${rebalanceDates.length} rebalance dates. Equal distribution would give each ticker ~${Math.round((TOP_N * rebalanceDates.length) / TICKERS.length)} picks. Concentration shows whether the rule is finding diversification or just buying the same names.`);
lines.push('');
const sortedByPicks = [...TICKERS].sort((a, b) => (rotation.pickFreq[b] ?? 0) - (rotation.pickFreq[a] ?? 0));
lines.push('| Rank | Ticker | Picks | % of top-3 slots |');
lines.push('|-----:|--------|------:|-----------------:|');
for (let i = 0; i < sortedByPicks.length; i++) {
  const t = sortedByPicks[i];
  const picks = rotation.pickFreq[t] ?? 0;
  const pct = (picks / (TOP_N * rebalanceDates.length)) * 100;
  lines.push(`| ${i + 1} | ${t} | ${picks} | ${fmtPct(pct)} |`);
}
lines.push('');

// Caveats
lines.push('## Caveats');
lines.push('');
lines.push('- Earnings calendar not modeled. Single-name BCD trades through earnings drift carry unmeasured event risk.');
lines.push('- WFA capital constraint: rotation runs at $6K (3 slots × $2K) vs baseline at $2K. Sharpe is unitless so the comparison is honest, but absolute PnL is 3× scale.');
lines.push('- Per-position sizing is fixed at $2K — large-underlying tickers (AMZN at $1.5K+) may not afford the BCD spread on early-history dates with small strikes; the simulator returns null and the slot stays empty for that signal.');
lines.push('- Holdout boundary same as the sealed F1 anchor (2024-01-22). Rotation has not been pre-registered, no dsrM cost, no sealed adoption claim.');
lines.push('- "Correlation to baseline" is daily-MtM Pearson correlation over the same window. Low correlation = better portfolio diversification candidate; high correlation = rotation is essentially a leveraged QQQ proxy.');
lines.push('');

// Write report
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = path.resolve(REPORT_DIR, 'wfa-v1.md');
fs.writeFileSync(reportPath, lines.join('\n'));

// Also dump JSON for downstream analysis.
const jsonPath = path.resolve(REPORT_DIR, 'wfa-v1-results.json');
fs.writeFileSync(jsonPath, JSON.stringify({
  generated: new Date().toISOString(),
  universe: TICKERS,
  config: { rotation: 'top-3 by (126d-21d)/63d-RV', cadenceDays: REBALANCE_DAYS, capital: { rotation: ROTATION_CAPITAL, baseline: BASELINE_CAPITAL } },
  windows: { selection: selectionWindows.length, holdout: HOLDOUT_COUNT, holdoutBoundary: firstHoldoutStart },
  rebalanceDates: rebalanceDates.length,
  rebalancesSkippedRV: rotation.rebalancesSkipped,
  results: {
    baseline: { ...baseline, trades: baseline.trades.length, selDailyReturns: undefined, holdDailyReturns: undefined },
    rotation: { ...rotationStrat, trades: rotationStrat.trades.length, selDailyReturns: undefined, holdDailyReturns: undefined },
    rotationRvFiltered: { ...rotationRv, trades: rotationRv.trades.length, selDailyReturns: undefined, holdDailyReturns: undefined },
  },
  correlations: {
    rotation_vs_baseline_selection: corrSel,
    rotation_vs_baseline_holdout: corrHold,
    rotationRv_vs_baseline_selection: corrSelRv,
    rotationRv_vs_baseline_holdout: corrHoldRv,
  },
  perTickerContribution: { rotation: rotationContribution, rotationRvFiltered: rotationRvContribution },
  pickFrequency: { rotation: rotation.pickFreq, rotationRvFiltered: rotation.pickFreqRvFiltered },
}, null, 2));

console.log(`\nWrote ${reportPath}`);
console.log(`Wrote ${jsonPath}`);

// Brief headline echo
console.log('\n──────────────────────────────────────────────────');
console.log(`Selection (5 yrs):  baseline ${baseline.selSharpe.toFixed(2)}/${baseline.selMaxDD.toFixed(1)}% · rotation ${rotationStrat.selSharpe.toFixed(2)}/${rotationStrat.selMaxDD.toFixed(1)}% · +RV ${rotationRv.selSharpe.toFixed(2)}/${rotationRv.selMaxDD.toFixed(1)}%`);
console.log(`Holdout (2.1 yrs):  baseline ${baseline.holdSharpe.toFixed(2)}/${baseline.holdMaxDD.toFixed(1)}% · rotation ${rotationStrat.holdSharpe.toFixed(2)}/${rotationStrat.holdMaxDD.toFixed(1)}% · +RV ${rotationRv.holdSharpe.toFixed(2)}/${rotationRv.holdMaxDD.toFixed(1)}%`);
console.log(`Daily-MtM correlation rotation vs baseline:  selection ${corrSel.r.toFixed(2)} · holdout ${corrHold.r.toFixed(2)}`);
