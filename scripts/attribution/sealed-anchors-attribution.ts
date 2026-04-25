/**
 * Loss / regime attribution for the two F1 sealed anchors:
 *   - bcd-qqq-wide-f1-anchor (BCD QQQ wide, $2K tier)
 *   - pmcc-qqq-pt60-f1-anchor (PMCC QQQ pt60, $10K tier)
 *
 * Replays each anchor through its sealed WFA structure (252/126/10 rolling,
 * 5 holdout windows), captures every closed trade, and tags the entry-date
 * regime with a PRE-DECLARED tag set. Per-regime PnL tables let us see
 * whether losses cluster around a specific bucket — which is the input the
 * gating-vs-rotation decision needs.
 *
 * Pre-declared tag set (LOCKED — anything else recorded later is exploratory):
 *   - qqqAboveEma100      close > 100d EMA at entry
 *   - spyAboveEma200      SPY close > 200d EMA at entry
 *   - rvShockBucket       5d realized vol / trailing 60d RV: normal / mild
 *                          / elevated / shock
 *   - ivVsHvBucket        iv30 / hv20 at entry: cheap / normal / crisis
 *   - ivPctile252Bucket   percentile rank of iv30 over trailing 252d:
 *                          low (<20) / normal (20-80) / high (>80)
 *   - daysToNearestCpi    trading days to nearest CPI release
 *   - daysToNearestFomc   trading days to nearest FOMC decision
 *   - breadthBucket       % of universe (28 names) with close > 50d EMA:
 *                          narrow (<50) / normal (50-65) / broad (>65)
 *
 * Run: npx tsx scripts/attribution/sealed-anchors-attribution.ts
 *
 * No pre-reg, no dsrM cost, no sealer — pure attribution over already-sealed
 * configs. Output is a parked artifact under
 *   backtesting history/credit-spread/reports/sealed-attribution/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB } from '../../src/lib/backtest/chain-cache';
import {
  DEFAULT_LEAP_CONFIG,
  type SimConfig, type EntrySignal, type OptionTrade,
} from '../../src/lib/backtest/option-sim';
import { makeDebitSpreadEvaluator, makeDiagonalEvaluator } from '../autoresearch/worker';
import {
  buildWFAWindows, evaluateConfiguredSignalsWithState,
  computePortfolioDailyMetrics, createConstraintState,
  type ConfiguredSignal, type PortfolioConstraintState, type WindowDef,
} from '../../src/lib/backtest/wfa-options';
import { CPI_DATES, FOMC_DATES, daysToNearestEvent } from './event-calendar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(
  __dirname, '../../backtesting history/credit-spread/reports/sealed-attribution',
);

// ── Anchor configs (verbatim from sealed strategy files) ────────────────

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
const BCD_CAPITAL = 2_000;
const PMCC_CAPITAL = 10_000;
const MAX_POSITIONS = 1;
const CADENCE_DAYS_BCD = 10;

// Tickers used as breadth proxy — the 28 single-name tradables that exist in
// the prefetch cache. SPY/QQQ are benchmarks and excluded from breadth count.
const BREADTH_UNIVERSE = [
  'AAPL', 'AMZN', 'COST', 'GOOG', 'GS', 'IWM', 'JPM',
  'META', 'MSFT', 'NFLX', 'NVDA', 'TSLA',
  'AMD', 'AVGO', 'BA', 'COIN', 'HOOD', 'LULU', 'MSTR', 'PLTR', 'UBER',
  'CRM', 'ORCL', 'CRWD', 'SHOP', 'PANW', 'ANET', 'VRT', 'NOW',
];

// ── Cache load ────────────────────────────────────────────────────────────

interface DataCache {
  tickers: Record<string, {
    candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    iv?: Array<{ date: string; iv30: number | null; iv60: number | null; hv20: number | null }>;
  }>;
  spy: { dates: string[]; dailyReturns: number[] };
}

const cachePath = path.resolve(__dirname, '../autoresearch/data-cache.json');
if (!fs.existsSync(cachePath)) {
  console.error(`ERROR: ${cachePath} missing. Run prefetch-data.ts first.`); process.exit(1);
}
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as DataCache;
const qqqCandles = cache.tickers.QQQ?.candles;
const qqqIV = cache.tickers.QQQ?.iv;
const spyCandles = cache.tickers.SPY?.candles;
if (!qqqCandles || !qqqIV || !spyCandles) {
  console.error('ERROR: QQQ/SPY data missing from cache'); process.exit(1);
}

initDB(undefined, true);

const allDates: string[] = qqqCandles.map(c => c.date).sort();
const maxDate = allDates[allDates.length - 1];

const qqqCloseByDate = new Map<string, number>();
for (const c of qqqCandles) qqqCloseByDate.set(c.date, c.close);
const spyCloseByDate = new Map<string, number>();
for (const c of spyCandles) spyCloseByDate.set(c.date, c.close);
const qqqIvByDate = new Map<string, { iv30: number | null; hv20: number | null }>();
for (const r of qqqIV) qqqIvByDate.set(r.date, { iv30: r.iv30, hv20: r.hv20 });

const spyReturnByDate = new Map<string, number>();
for (let i = 0; i < cache.spy.dates.length; i++) spyReturnByDate.set(cache.spy.dates[i], cache.spy.dailyReturns[i]);

// Pre-compute breadth: for each date, count how many of the universe close > 50d EMA.
const universeCloseByTickerDate: Record<string, Map<string, number>> = {};
for (const t of BREADTH_UNIVERSE) {
  const c = cache.tickers[t]?.candles;
  if (!c) continue;
  const m = new Map<string, number>();
  for (const r of c) m.set(r.date, r.close);
  universeCloseByTickerDate[t] = m;
}

// ── Indicator helpers (deterministic, no peeking) ────────────────────────

function emaSeries(closes: Array<{ date: string; close: number }>, period: number): Map<string, number> {
  const out = new Map<string, number>();
  if (closes.length === 0) return out;
  const k = 2 / (period + 1);
  let ema = closes[0].close;
  out.set(closes[0].date, ema);
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i].close * k + ema * (1 - k);
    out.set(closes[i].date, ema);
  }
  return out;
}

const qqqEma100 = emaSeries(qqqCandles, 100);
const spyEma200 = emaSeries(spyCandles, 200);

const universeEma50: Record<string, Map<string, number>> = {};
for (const t of BREADTH_UNIVERSE) {
  const c = cache.tickers[t]?.candles;
  if (c) universeEma50[t] = emaSeries(c, 50);
}

// Rolling realized vol (annualized) over `window` trading days, ending on date d.
function realizedVolByDate(candles: typeof qqqCandles, window: number): Map<string, number> {
  const out = new Map<string, number>();
  const logRet: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    logRet.push(Math.log(candles[i].close / candles[i - 1].close));
  }
  for (let i = window; i < candles.length; i++) {
    const slice = logRet.slice(i - window + 1, i + 1);
    const mean = slice.reduce((s, x) => s + x, 0) / slice.length;
    const variance = slice.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, slice.length - 1);
    out.set(candles[i].date, Math.sqrt(variance * 252));
  }
  return out;
}

const rv5 = realizedVolByDate(qqqCandles, 5);
const rv60 = realizedVolByDate(qqqCandles, 60);

// IV percentile rank over trailing 252 days.
function ivPercentile252(d: string): number | null {
  const idx = allDates.indexOf(d);
  if (idx < 252) return null;
  const window = allDates.slice(idx - 251, idx + 1);
  const cur = qqqIvByDate.get(d)?.iv30;
  if (cur == null) return null;
  let lower = 0, total = 0;
  for (const wd of window) {
    const v = qqqIvByDate.get(wd)?.iv30;
    if (v == null) continue;
    total += 1;
    if (v <= cur) lower += 1;
  }
  return total > 0 ? (lower / total) * 100 : null;
}

function breadthPct(d: string): number | null {
  let above = 0, total = 0;
  for (const t of BREADTH_UNIVERSE) {
    const close = universeCloseByTickerDate[t]?.get(d);
    const ema = universeEma50[t]?.get(d);
    if (close == null || ema == null) continue;
    total += 1;
    if (close > ema) above += 1;
  }
  return total === 0 ? null : (above / total) * 100;
}

// ── Tag set ──────────────────────────────────────────────────────────────

type RvShock = 'normal' | 'mild' | 'elevated' | 'shock';
type IvHv = 'cheap' | 'normal' | 'crisis';
type IvPct = 'low' | 'normal' | 'high';
type Breadth = 'narrow' | 'normal' | 'broad';

interface RegimeTags {
  qqqAboveEma100: boolean;
  spyAboveEma200: boolean;
  rvShockBucket: RvShock;
  ivVsHvBucket: IvHv | 'unknown';
  ivPctile252Bucket: IvPct | 'unknown';
  daysToNearestCpi: number;
  daysToNearestFomc: number;
  breadthBucket: Breadth | 'unknown';
}

function tagEntryDate(d: string): RegimeTags {
  const qqqClose = qqqCloseByDate.get(d) ?? 0;
  const qqqE100 = qqqEma100.get(d) ?? 0;
  const spyClose = spyCloseByDate.get(d) ?? 0;
  const spyE200 = spyEma200.get(d) ?? 0;

  const rv5v = rv5.get(d) ?? null;
  const rv60v = rv60.get(d) ?? null;
  let rvShockBucket: RvShock = 'normal';
  if (rv5v != null && rv60v != null && rv60v > 0) {
    const ratio = rv5v / rv60v;
    if (ratio >= 2.0) rvShockBucket = 'shock';
    else if (ratio >= 1.5) rvShockBucket = 'elevated';
    else if (ratio >= 1.0) rvShockBucket = 'mild';
  }

  const iv = qqqIvByDate.get(d);
  let ivVsHvBucket: IvHv | 'unknown' = 'unknown';
  if (iv?.iv30 != null && iv.hv20 != null && iv.hv20 > 0) {
    const r = iv.iv30 / iv.hv20;
    if (r < 0.9) ivVsHvBucket = 'cheap';
    else if (r > 1.6) ivVsHvBucket = 'crisis';
    else ivVsHvBucket = 'normal';
  }

  const ivPctile = ivPercentile252(d);
  let ivPctile252Bucket: IvPct | 'unknown' = 'unknown';
  if (ivPctile != null) {
    if (ivPctile < 20) ivPctile252Bucket = 'low';
    else if (ivPctile > 80) ivPctile252Bucket = 'high';
    else ivPctile252Bucket = 'normal';
  }

  const breadth = breadthPct(d);
  let breadthBucket: Breadth | 'unknown' = 'unknown';
  if (breadth != null) {
    if (breadth < 50) breadthBucket = 'narrow';
    else if (breadth > 65) breadthBucket = 'broad';
    else breadthBucket = 'normal';
  }

  return {
    qqqAboveEma100: qqqClose > qqqE100,
    spyAboveEma200: spyClose > spyE200,
    rvShockBucket,
    ivVsHvBucket,
    ivPctile252Bucket,
    daysToNearestCpi: daysToNearestEvent(d, CPI_DATES, allDates),
    daysToNearestFomc: daysToNearestEvent(d, FOMC_DATES, allDates),
    breadthBucket,
  };
}

// ── Anchor replay ────────────────────────────────────────────────────────

function bcdSignals(): EntrySignal[] {
  const sigs: EntrySignal[] = [];
  for (let i = 60; i < allDates.length; i += CADENCE_DAYS_BCD) {
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

const wfaStartDate = allDates.find(d => d >= '2018-01-01') ?? allDates[0];
const allWindows = buildWFAWindows(allDates, { ...WFA, startDate: wfaStartDate, endDate: maxDate });
const selectionWindows = allWindows.slice(0, -HOLDOUT_COUNT);
const holdoutWindows = allWindows.slice(-HOLDOUT_COUNT);
const combinedWindows: WindowDef[] = [...selectionWindows, ...holdoutWindows];
const firstHoldoutStart = holdoutWindows[0]?.oosStart ?? '';

console.log(
  `WFA: ${selectionWindows.length} selection + ${holdoutWindows.length} holdout windows. ` +
  `Holdout boundary: ${firstHoldoutStart}`,
);

interface AnchorResult {
  name: string;
  trades: OptionTrade[];
  capital: number;
  selStart: string;
  selEnd: string;
  holdStart: string;
  holdEnd: string;
}

function runAnchor(
  name: string,
  config: SimConfig,
  factory: (c: SimConfig) => ReturnType<typeof makeDebitSpreadEvaluator>,
  signals: EntrySignal[],
  capital: number,
): AnchorResult {
  const evaluator = factory(config);
  const exec = { maxPositions: MAX_POSITIONS, maxPerTicker: MAX_POSITIONS, startingCapital: capital };
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
  return {
    name,
    trades: all,
    capital,
    selStart: selectionWindows[0]?.oosStart ?? allDates[0],
    selEnd: selectionWindows[selectionWindows.length - 1]?.oosEnd ?? maxDate,
    holdStart: holdoutWindows[0]?.oosStart ?? '',
    holdEnd: holdoutWindows[holdoutWindows.length - 1]?.oosEnd ?? maxDate,
  };
}

console.log('\nReplaying BCD F1 anchor...');
const tBcd = Date.now();
const bcd = runAnchor('bcd-qqq-wide-f1', BCD_F1_CONFIG, makeDebitSpreadEvaluator, bcdSignals(), BCD_CAPITAL);
console.log(`  ${bcd.trades.length} trades, ${((Date.now() - tBcd) / 1000).toFixed(1)}s`);

console.log('Replaying PMCC F1 anchor...');
const tPmcc = Date.now();
const pmcc = runAnchor('pmcc-qqq-pt60-f1', PMCC_F1_CONFIG, makeDiagonalEvaluator, pmccSignals(), PMCC_CAPITAL);
console.log(`  ${pmcc.trades.length} trades, ${((Date.now() - tPmcc) / 1000).toFixed(1)}s`);

// ── Aggregation ──────────────────────────────────────────────────────────

interface TaggedTrade {
  trade: OptionTrade;
  tags: RegimeTags;
  bucket: 'selection' | 'holdout';
}

function tagAll(r: AnchorResult): TaggedTrade[] {
  return r.trades.map(t => ({
    trade: t,
    tags: tagEntryDate(t.entryDate),
    bucket: (firstHoldoutStart && t.entryDate >= firstHoldoutStart) ? 'holdout' : 'selection',
  }));
}

interface RegimeRow { name: string; n: number; wins: number; losses: number; winRate: number; sumPnl: number; meanPnl: number; meanWin: number; meanLoss: number; }

function aggregate(trades: TaggedTrade[], keyFn: (t: TaggedTrade) => string | null): RegimeRow[] {
  const groups = new Map<string, OptionTrade[]>();
  for (const t of trades) {
    const k = keyFn(t);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t.trade);
  }
  const rows: RegimeRow[] = [];
  for (const [name, ts] of groups) {
    const wins = ts.filter(t => t.pnl > 0);
    const losses = ts.filter(t => t.pnl <= 0);
    const sumPnl = ts.reduce((s, t) => s + t.pnl, 0);
    rows.push({
      name, n: ts.length, wins: wins.length, losses: losses.length,
      winRate: ts.length ? (wins.length / ts.length) * 100 : 0,
      sumPnl, meanPnl: ts.length ? sumPnl / ts.length : 0,
      meanWin: wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
      meanLoss: losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

interface GateImpact { gate: string; remaining: number; removed: number; pnlRemaining: number; pnlRemoved: number; winRateRemaining: number; meanPnlRemaining: number; }

function whatIf(trades: TaggedTrade[], gate: string, predicate: (t: TaggedTrade) => boolean): GateImpact {
  const kept = trades.filter(predicate);
  const removed = trades.filter(t => !predicate(t));
  const pnlR = kept.reduce((s, t) => s + t.trade.pnl, 0);
  const pnlD = removed.reduce((s, t) => s + t.trade.pnl, 0);
  const wins = kept.filter(t => t.trade.pnl > 0).length;
  return {
    gate, remaining: kept.length, removed: removed.length,
    pnlRemaining: pnlR, pnlRemoved: pnlD,
    winRateRemaining: kept.length ? (wins / kept.length) * 100 : 0,
    meanPnlRemaining: kept.length ? pnlR / kept.length : 0,
  };
}

function portfolioSharpeFromTrades(trades: OptionTrade[], capital: number, rangeStart: string, rangeEnd: string): { sharpe: number; maxDD: number } {
  const m = computePortfolioDailyMetrics(trades, allDates, rangeStart, rangeEnd, capital);
  return { sharpe: m.sharpe, maxDD: m.maxDrawdownPct };
}

// ── Render ───────────────────────────────────────────────────────────────

function fmtRow(r: RegimeRow): string {
  return `| ${r.name} | ${r.n} | ${r.wins} | ${r.losses} | ${r.winRate.toFixed(1)}% | ` +
    `$${r.sumPnl.toFixed(0)} | $${r.meanPnl.toFixed(0)} | $${r.meanWin.toFixed(0)} | $${r.meanLoss.toFixed(0)} |`;
}

function renderRegimeTable(title: string, rows: RegimeRow[]): string {
  const lines: string[] = [];
  lines.push(`### ${title}`);
  lines.push('');
  lines.push('| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |');
  lines.push('|--------|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) lines.push(fmtRow(r));
  lines.push('');
  return lines.join('\n');
}

function renderWhatIf(title: string, impacts: GateImpact[], baseline: { sharpe: number; maxDD: number; pnl: number; n: number }): string {
  const lines: string[] = [];
  lines.push(`### ${title}`);
  lines.push('');
  lines.push(`Baseline (no gate): N=${baseline.n}, Sum PnL $${baseline.pnl.toFixed(0)}, Sharpe ${baseline.sharpe.toFixed(2)}, MaxDD ${baseline.maxDD.toFixed(1)}%`);
  lines.push('');
  lines.push('| Gate | Kept | Removed | Sum PnL kept | Sum PnL removed | Win% kept | Mean PnL kept |');
  lines.push('|------|---:|---:|---:|---:|---:|---:|');
  for (const i of impacts) {
    lines.push(
      `| ${i.gate} | ${i.remaining} | ${i.removed} | $${i.pnlRemaining.toFixed(0)} | ` +
      `$${i.pnlRemoved.toFixed(0)} | ${i.winRateRemaining.toFixed(1)}% | $${i.meanPnlRemaining.toFixed(0)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function buildReport(r: AnchorResult, tagged: TaggedTrade[]): string {
  const all = tagged;
  const sel = tagged.filter(t => t.bucket === 'selection');
  const hold = tagged.filter(t => t.bucket === 'holdout');

  const baselineSelMetrics = portfolioSharpeFromTrades(sel.map(t => t.trade), r.capital, r.selStart, r.selEnd);
  const baselineHoldMetrics = portfolioSharpeFromTrades(hold.map(t => t.trade), r.capital, r.holdStart, r.holdEnd);
  const sumPnl = (ts: TaggedTrade[]) => ts.reduce((s, t) => s + t.trade.pnl, 0);

  const lines: string[] = [];
  lines.push(`# ${r.name} — sealed-anchor regime attribution`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Replay summary');
  lines.push('');
  lines.push(`- WFA: ${selectionWindows.length} selection + ${holdoutWindows.length} holdout windows (252/126/10 rolling)`);
  lines.push(`- Capital: $${r.capital.toLocaleString()}, maxPositions=${MAX_POSITIONS}`);
  lines.push(`- Total trades: **${all.length}** (selection ${sel.length} · holdout ${hold.length})`);
  lines.push(`- Selection PnL: $${sumPnl(sel).toFixed(0)}, Sharpe ${baselineSelMetrics.sharpe.toFixed(2)}, MaxDD ${baselineSelMetrics.maxDD.toFixed(1)}%`);
  lines.push(`- Holdout PnL:   $${sumPnl(hold).toFixed(0)}, Sharpe ${baselineHoldMetrics.sharpe.toFixed(2)}, MaxDD ${baselineHoldMetrics.maxDD.toFixed(1)}%`);
  lines.push('');

  // Regime tables on combined (selection + holdout) for sample size, then report
  // selection vs holdout separately for the trend gate (the headline).
  lines.push('## Per-regime PnL — combined (selection + holdout)');
  lines.push('');
  lines.push(renderRegimeTable('QQQ vs 100d EMA', aggregate(all, t => t.tags.qqqAboveEma100 ? 'above' : 'below')));
  lines.push(renderRegimeTable('SPY vs 200d EMA', aggregate(all, t => t.tags.spyAboveEma200 ? 'above' : 'below')));
  lines.push(renderRegimeTable('5d/60d RV shock', aggregate(all, t => t.tags.rvShockBucket)));
  lines.push(renderRegimeTable('IV30 / HV20', aggregate(all, t => t.tags.ivVsHvBucket)));
  lines.push(renderRegimeTable('IV30 percentile (252d)', aggregate(all, t => t.tags.ivPctile252Bucket)));
  lines.push(renderRegimeTable('Breadth (% universe > 50d EMA)', aggregate(all, t => t.tags.breadthBucket)));
  lines.push(renderRegimeTable('CPI proximity (entry within X trading days)',
    aggregate(all, t => t.tags.daysToNearestCpi <= 1 ? 'le_1d' : t.tags.daysToNearestCpi <= 3 ? 'le_3d' : t.tags.daysToNearestCpi <= 5 ? 'le_5d' : 'gt_5d')));
  lines.push(renderRegimeTable('FOMC proximity (entry within X trading days)',
    aggregate(all, t => t.tags.daysToNearestFomc <= 1 ? 'le_1d' : t.tags.daysToNearestFomc <= 3 ? 'le_3d' : t.tags.daysToNearestFomc <= 5 ? 'le_5d' : 'gt_5d')));

  // What-if gates — selection only (so the holdout stays unconditioned for honest comparison).
  const baseSel = { sharpe: baselineSelMetrics.sharpe, maxDD: baselineSelMetrics.maxDD, pnl: sumPnl(sel), n: sel.length };
  const gates: GateImpact[] = [
    whatIf(sel, 'QQQ > 100d EMA', t => t.tags.qqqAboveEma100),
    whatIf(sel, 'SPY > 200d EMA', t => t.tags.spyAboveEma200),
    whatIf(sel, 'QQQ > 100d EMA AND SPY > 200d EMA', t => t.tags.qqqAboveEma100 && t.tags.spyAboveEma200),
    whatIf(sel, 'no RV shock (5d/60d < 2.0)', t => t.tags.rvShockBucket !== 'shock'),
    whatIf(sel, 'no RV elevated (5d/60d < 1.5)', t => t.tags.rvShockBucket === 'normal' || t.tags.rvShockBucket === 'mild'),
    whatIf(sel, 'IV/HV not crisis', t => t.tags.ivVsHvBucket !== 'crisis'),
    whatIf(sel, 'IV percentile not high (<80)', t => t.tags.ivPctile252Bucket !== 'high'),
    whatIf(sel, 'breadth not narrow (>=50%)', t => t.tags.breadthBucket === 'normal' || t.tags.breadthBucket === 'broad'),
    whatIf(sel, 'CPI proximity > 1d', t => t.tags.daysToNearestCpi > 1),
    whatIf(sel, 'FOMC proximity > 1d', t => t.tags.daysToNearestFomc > 1),
    whatIf(sel, 'CPI proximity > 3d AND FOMC proximity > 3d', t => t.tags.daysToNearestCpi > 3 && t.tags.daysToNearestFomc > 3),
    whatIf(sel, 'trend ON + no RV elevated + event > 1d', t =>
      t.tags.qqqAboveEma100 && t.tags.spyAboveEma200 &&
      (t.tags.rvShockBucket === 'normal' || t.tags.rvShockBucket === 'mild') &&
      t.tags.daysToNearestCpi > 1 && t.tags.daysToNearestFomc > 1),
  ];

  // For each kept-trade subset, also compute selection-period Sharpe/DD honestly.
  lines.push('## What-if gating — selection period only');
  lines.push('');
  lines.push(`Holdout (${hold.length} trades) is left unconditioned. Sharpe/MaxDD below are computed from the kept-trade subset over the selection range ${r.selStart} → ${r.selEnd}.`);
  lines.push('');
  lines.push('| Gate | Kept | Removed | Sum PnL kept | Sum PnL removed | Win% kept | Mean PnL kept | Sharpe | MaxDD |');
  lines.push('|------|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const g of gates) {
    const keptTrades = sel.filter(t => {
      switch (g.gate) {
        case 'QQQ > 100d EMA': return t.tags.qqqAboveEma100;
        case 'SPY > 200d EMA': return t.tags.spyAboveEma200;
        case 'QQQ > 100d EMA AND SPY > 200d EMA': return t.tags.qqqAboveEma100 && t.tags.spyAboveEma200;
        case 'no RV shock (5d/60d < 2.0)': return t.tags.rvShockBucket !== 'shock';
        case 'no RV elevated (5d/60d < 1.5)': return t.tags.rvShockBucket === 'normal' || t.tags.rvShockBucket === 'mild';
        case 'IV/HV not crisis': return t.tags.ivVsHvBucket !== 'crisis';
        case 'IV percentile not high (<80)': return t.tags.ivPctile252Bucket !== 'high';
        case 'breadth not narrow (>=50%)': return t.tags.breadthBucket === 'normal' || t.tags.breadthBucket === 'broad';
        case 'CPI proximity > 1d': return t.tags.daysToNearestCpi > 1;
        case 'FOMC proximity > 1d': return t.tags.daysToNearestFomc > 1;
        case 'CPI proximity > 3d AND FOMC proximity > 3d': return t.tags.daysToNearestCpi > 3 && t.tags.daysToNearestFomc > 3;
        case 'trend ON + no RV elevated + event > 1d':
          return t.tags.qqqAboveEma100 && t.tags.spyAboveEma200 &&
                 (t.tags.rvShockBucket === 'normal' || t.tags.rvShockBucket === 'mild') &&
                 t.tags.daysToNearestCpi > 1 && t.tags.daysToNearestFomc > 1;
        default: return true;
      }
    }).map(t => t.trade);
    const m = portfolioSharpeFromTrades(keptTrades, r.capital, r.selStart, r.selEnd);
    lines.push(
      `| ${g.gate} | ${g.remaining} | ${g.removed} | $${g.pnlRemaining.toFixed(0)} | ` +
      `$${g.pnlRemoved.toFixed(0)} | ${g.winRateRemaining.toFixed(1)}% | $${g.meanPnlRemaining.toFixed(0)} | ` +
      `${m.sharpe.toFixed(2)} | ${m.maxDD.toFixed(1)}% |`,
    );
  }
  lines.push('');
  lines.push(`Baseline selection (no gate): N=${baseSel.n}, Sum PnL $${baseSel.pnl.toFixed(0)}, Sharpe ${baseSel.sharpe.toFixed(2)}, MaxDD ${baseSel.maxDD.toFixed(1)}%`);
  lines.push('');

  // Full per-trade ledger appendix
  lines.push('## Per-trade ledger (appendix)');
  lines.push('');
  lines.push('| # | bucket | entryDate | exitDate | exitType | pnl | qqq>100d | spy>200d | rvShock | iv/hv | ivPct | dCpi | dFomc | breadth |');
  lines.push('|---|--------|-----------|----------|----------|----:|:--------:|:--------:|---------|-------|-------|-----:|------:|---------|');
  for (let i = 0; i < tagged.length; i++) {
    const t = tagged[i];
    lines.push(
      `| ${i + 1} | ${t.bucket} | ${t.trade.entryDate} | ${t.trade.exitDate} | ${t.trade.exitType} | ` +
      `$${t.trade.pnl.toFixed(0)} | ${t.tags.qqqAboveEma100 ? 'Y' : 'N'} | ${t.tags.spyAboveEma200 ? 'Y' : 'N'} | ` +
      `${t.tags.rvShockBucket} | ${t.tags.ivVsHvBucket} | ${t.tags.ivPctile252Bucket} | ` +
      `${isFinite(t.tags.daysToNearestCpi) ? t.tags.daysToNearestCpi : '∞'} | ` +
      `${isFinite(t.tags.daysToNearestFomc) ? t.tags.daysToNearestFomc : '∞'} | ${t.tags.breadthBucket} |`,
    );
  }

  return lines.join('\n');
}

const bcdTagged  = tagAll(bcd);
const pmccTagged = tagAll(pmcc);

if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
const bcdReport  = buildReport(bcd, bcdTagged);
const pmccReport = buildReport(pmcc, pmccTagged);
const bcdPath  = path.resolve(REPORT_DIR, 'bcd-qqq-wide-f1.md');
const pmccPath = path.resolve(REPORT_DIR, 'pmcc-qqq-pt60-f1.md');
fs.writeFileSync(bcdPath, bcdReport);
fs.writeFileSync(pmccPath, pmccReport);
console.log(`\nWrote ${bcdPath}`);
console.log(`Wrote ${pmccPath}`);

// Brief console summary so the user can sanity-check at a glance.
function summarize(r: AnchorResult, tagged: TaggedTrade[]) {
  const sel = tagged.filter(t => t.bucket === 'selection');
  const hold = tagged.filter(t => t.bucket === 'holdout');
  const sumPnl = (ts: TaggedTrade[]) => ts.reduce((s, t) => s + t.trade.pnl, 0);
  console.log(`\n${r.name}:`);
  console.log(`  selection ${sel.length}t  PnL $${sumPnl(sel).toFixed(0)}`);
  console.log(`  holdout   ${hold.length}t  PnL $${sumPnl(hold).toFixed(0)}`);
}
summarize(bcd, bcdTagged);
summarize(pmcc, pmccTagged);
