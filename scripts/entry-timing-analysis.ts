#!/usr/bin/env npx tsx
/**
 * Entry Timing Analysis — DTE5 Credit Spreads
 *
 * Estimates how much entry timing (open vs close) affects credit received.
 * Uses stock price movement as a proxy since option chains are EOD-only.
 *
 * Methodology:
 *   For each trade entry date in the bear study results:
 *   1. Load 1H intraday candles for the ticker
 *   2. Compare stock price at day open vs day close
 *   3. Estimate credit differential: credit_delta ≈ short_delta × (close - open)
 *      - Bull put: stock higher → less credit (put worth less)
 *      - Bear call: stock lower → less credit (call worth less)
 *   4. Aggregate to see if timing consistently matters
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initIntradayDB, get1HCandles } from '../src/lib/backtest/intraday-cache';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load bear study results ────────────────────────────
const bearReportPath = path.resolve(__dirname, '../backtesting history/credit-spread/reports/bear-strategy/bear-strategy.json');
if (!fs.existsSync(bearReportPath)) {
  console.error('Bear strategy report not found. Run the bear study first.');
  process.exit(1);
}

const bearData = JSON.parse(fs.readFileSync(bearReportPath, 'utf8'));
const sweepResults = bearData.sweepResults as Array<{
  ticker: string; proximity: string; rally: string; spread: string;
  sharpe: number; trades: number;
}>;

const bestPerTicker = bearData.bestPerTicker as Record<string, typeof sweepResults[0]>;

// ── Load chain DB to get trade entry dates ────────────
import Database from 'better-sqlite3';
import { initDB, getCachedChain } from '../src/lib/backtest/chain-cache';

// We'll reconstruct entry dates by checking which dates had signals
// by looking at chain data where the bear regime held (EMA21 < EMA34 < EMA55)

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  Entry Timing Analysis — DTE5 Credit Spread (Open vs Close)     ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

const intradayDb = initIntradayDB();
initDB();

const TICKERS = ['QQQ', 'SPY', 'IWM'];
const START_DATE = '2019-06-01';
const END_DATE = '2026-02-28';

// ── Get daily open/close from 1H candles ────────────
interface DayOpenClose {
  date: string;
  open: number;   // first 1H bar open
  close: number;  // last 1H bar close
  high: number;   // day high
  low: number;    // day low
  range: number;  // close - open
  rangePct: number; // (close - open) / open
}

function getDailyOpenClose(ticker: string): Map<string, DayOpenClose> {
  const candles = get1HCandles(intradayDb, ticker, START_DATE, END_DATE);
  const byDate = new Map<string, typeof candles>();

  for (const c of candles) {
    const existing = byDate.get(c.date) ?? [];
    existing.push(c);
    byDate.set(c.date, existing);
  }

  const result = new Map<string, DayOpenClose>();
  for (const [date, bars] of byDate) {
    if (bars.length < 2) continue;
    bars.sort((a, b) => a.timestamp - b.timestamp);
    const dayOpen = bars[0].open;
    const dayClose = bars[bars.length - 1].close;
    const dayHigh = Math.max(...bars.map(b => b.high));
    const dayLow = Math.min(...bars.map(b => b.low));
    result.set(date, {
      date, open: dayOpen, close: dayClose, high: dayHigh, low: dayLow,
      range: dayClose - dayOpen,
      rangePct: dayOpen > 0 ? (dayClose - dayOpen) / dayOpen : 0,
    });
  }
  return result;
}

// ── Reconstruct bear signal dates ────────────────────
// A bear signal fires when EMA21 < EMA34 < EMA55 and price is near EMA21
// We'll use chain data stock prices to rebuild EMA and find signal dates

function computeEMA(closes: number[], period: number): number[] {
  const result: number[] = [];
  const mult = 2 / (period + 1);
  let prev = closes[0];
  result.push(prev);
  for (let i = 1; i < closes.length; i++) {
    prev = closes[i] * mult + prev * (1 - mult);
    result.push(prev);
  }
  return result;
}

function findBearSignalDates(ticker: string, openClose: Map<string, DayOpenClose>): string[] {
  const dates = [...openClose.keys()].sort();
  const closes = dates.map(d => openClose.get(d)!.close);
  if (closes.length < 55) return [];

  const ema21 = computeEMA(closes, 21);
  const ema34 = computeEMA(closes, 34);
  const ema55 = computeEMA(closes, 55);

  const signals: string[] = [];
  for (let i = 55; i < dates.length; i++) {
    // Bear regime: EMA21 < EMA34 < EMA55
    if (ema21[i] < ema34[i] && ema34[i] < ema55[i]) {
      // Price below EMA21 (required for all bear configs)
      if (closes[i] < ema21[i]) {
        signals.push(dates[i]);
      }
    }
  }
  return signals;
}

// ── Main analysis ────────────────────────────────────

interface TimingResult {
  ticker: string;
  date: string;
  dayOpen: number;
  dayClose: number;
  move: number;       // close - open
  movePct: number;    // (close - open) / open
  // Credit impact estimate (for bear call spread: stock drops = less credit)
  // credit_delta ≈ -short_delta × (close - open) for bear calls
  // (negative move = stock dropped = call worth less = LESS credit at open)
  creditImpactEst: number;
}

const allResults: TimingResult[] = [];
const DELTA_SHORT = 0.35; // approximate average short delta across configs

for (const ticker of TICKERS) {
  console.log(`\n─── ${ticker} ───`);
  const openClose = getDailyOpenClose(ticker);
  console.log(`  1H candle dates: ${openClose.size}`);

  const bearDates = findBearSignalDates(ticker, openClose);
  console.log(`  Bear signal dates: ${bearDates.length}`);

  for (const date of bearDates) {
    const oc = openClose.get(date);
    if (!oc) continue;

    // For bear call spreads: selling calls
    // If stock drops from open to close: calls are worth less at close → less credit received at close
    // Enter at open = higher stock price = call worth more = more credit
    // credit_impact = -delta × (close - open) [positive means entering at open gets more credit]
    const creditImpactEst = -DELTA_SHORT * oc.range;

    allResults.push({
      ticker, date, dayOpen: oc.open, dayClose: oc.close,
      move: oc.range, movePct: oc.rangePct,
      creditImpactEst,
    });
  }
}

// ── Aggregate Results ────────────────────────────────

console.log(`\n${'═'.repeat(80)}`);
console.log('  ENTRY TIMING ANALYSIS — SUMMARY');
console.log('═'.repeat(80));

// Overall stats
const avgMove = allResults.reduce((s, r) => s + r.movePct, 0) / allResults.length;
const avgAbsMove = allResults.reduce((s, r) => s + Math.abs(r.movePct), 0) / allResults.length;
const avgCreditImpact = allResults.reduce((s, r) => s + r.creditImpactEst, 0) / allResults.length;
const avgAbsCreditImpact = allResults.reduce((s, r) => s + Math.abs(r.creditImpactEst), 0) / allResults.length;

// Direction bias: how often does stock drop on bear signal days?
const dropDays = allResults.filter(r => r.move < 0).length;
const rallyDays = allResults.filter(r => r.move > 0).length;

console.log(`\n  Total bear signal days analyzed: ${allResults.length}`);
console.log(`  Drop days: ${dropDays} (${(dropDays/allResults.length*100).toFixed(0)}%) | Rally days: ${rallyDays} (${(rallyDays/allResults.length*100).toFixed(0)}%)`);
console.log(`  Avg intraday move: ${(avgMove*100).toFixed(3)}%`);
console.log(`  Avg |intraday move|: ${(avgAbsMove*100).toFixed(3)}%`);
console.log(`  Avg credit impact (open vs close): $${avgCreditImpact.toFixed(2)}/share`);
console.log(`  Avg |credit impact|: $${avgAbsCreditImpact.toFixed(2)}/share`);

// Per-ticker breakdown
console.log('\n  Per-Ticker Breakdown:');
console.log('  ' + 'Ticker'.padEnd(8) + 'Signals'.padStart(8) + 'Drop%'.padStart(8) + 'AvgMove%'.padStart(10) + 'Avg|Move|%'.padStart(11) + 'AvgCrImpact'.padStart(13) + 'Avg|CrImpact|'.padStart(14));
console.log('  ' + '-'.repeat(72));

for (const ticker of TICKERS) {
  const subset = allResults.filter(r => r.ticker === ticker);
  if (subset.length === 0) continue;
  const drops = subset.filter(r => r.move < 0).length;
  const am = subset.reduce((s, r) => s + r.movePct, 0) / subset.length;
  const aam = subset.reduce((s, r) => s + Math.abs(r.movePct), 0) / subset.length;
  const aci = subset.reduce((s, r) => s + r.creditImpactEst, 0) / subset.length;
  const aaci = subset.reduce((s, r) => s + Math.abs(r.creditImpactEst), 0) / subset.length;

  console.log('  ' + ticker.padEnd(8) + String(subset.length).padStart(8) +
    (drops/subset.length*100).toFixed(0).padStart(7) + '%' +
    (am*100).toFixed(3).padStart(9) + '%' +
    (aam*100).toFixed(3).padStart(10) + '%' +
    ('$'+aci.toFixed(2)).padStart(13) +
    ('$'+aaci.toFixed(2)).padStart(14));
}

// Verdict
const AVG_CREDIT = 1.50; // approximate average credit received per DTE5 spread ($1.50/share)
const impactPct = Math.abs(avgCreditImpact) / AVG_CREDIT * 100;
console.log(`\n  ───────────────────────────────────────────────`);
console.log(`  VERDICT:`);
console.log(`  Avg credit impact: $${Math.abs(avgCreditImpact).toFixed(2)}/share = ${impactPct.toFixed(1)}% of typical $${AVG_CREDIT.toFixed(2)} credit`);
if (impactPct > 10) {
  console.log(`  → SIGNIFICANT (>10%) — Entry timing optimization is worth pursuing.`);
  console.log(`  → Recommendation: Add morning scan to compare open-period vs close-period pricing.`);
} else if (impactPct > 5) {
  console.log(`  → MODERATE (5-10%) — Entry timing has mild impact. Consider logging but not blocking.`);
} else {
  console.log(`  → NEGLIGIBLE (<5%) — Entry timing does not meaningfully affect credit. Stick with close-of-day.`);
}
console.log(`  ───────────────────────────────────────────────`);

// Write report
const reportDir = 'backtesting history/credit-spread/reports/entry-timing';
fs.mkdirSync(reportDir, { recursive: true });

let md = `# Entry Timing Analysis — DTE5 Credit Spreads\n\n`;
md += `**Date:** ${new Date().toISOString().split('T')[0]}\n`;
md += `**Method:** Stock price open vs close as proxy for option credit change\n`;
md += `**Formula:** credit_delta ≈ -short_delta × (close - open), where delta = ${DELTA_SHORT}\n`;
md += `**Period:** ${START_DATE} to ${END_DATE}\n\n`;

md += `## Summary\n\n`;
md += `| Metric | Value |\n`;
md += `|--------|-------|\n`;
md += `| Total bear signal days | ${allResults.length} |\n`;
md += `| Drop days (stock fell open→close) | ${dropDays} (${(dropDays/allResults.length*100).toFixed(0)}%) |\n`;
md += `| Rally days | ${rallyDays} (${(rallyDays/allResults.length*100).toFixed(0)}%) |\n`;
md += `| Avg intraday move | ${(avgMove*100).toFixed(3)}% |\n`;
md += `| Avg |intraday move| | ${(avgAbsMove*100).toFixed(3)}% |\n`;
md += `| Avg credit impact (open vs close) | $${avgCreditImpact.toFixed(2)}/share |\n`;
md += `| Impact as % of typical credit | ${impactPct.toFixed(1)}% |\n\n`;

md += `## Per-Ticker\n\n`;
md += `| Ticker | Signals | Drop% | Avg Move% | Avg|Move|% | Avg Credit Impact | Avg|Impact| |\n`;
md += `|--------|---------|-------|-----------|------------|-------------------|------------|\n`;
for (const ticker of TICKERS) {
  const subset = allResults.filter(r => r.ticker === ticker);
  if (subset.length === 0) continue;
  const drops = subset.filter(r => r.move < 0).length;
  const am = subset.reduce((s, r) => s + r.movePct, 0) / subset.length;
  const aam = subset.reduce((s, r) => s + Math.abs(r.movePct), 0) / subset.length;
  const aci = subset.reduce((s, r) => s + r.creditImpactEst, 0) / subset.length;
  const aaci = subset.reduce((s, r) => s + Math.abs(r.creditImpactEst), 0) / subset.length;
  md += `| ${ticker} | ${subset.length} | ${(drops/subset.length*100).toFixed(0)}% | ${(am*100).toFixed(3)}% | ${(aam*100).toFixed(3)}% | $${aci.toFixed(2)} | $${aaci.toFixed(2)} |\n`;
}
md += '\n';

md += `## Verdict\n\n`;
md += impactPct > 10
  ? `**SIGNIFICANT** — ${impactPct.toFixed(1)}% of typical credit. Entry timing optimization is worth pursuing.\n`
  : impactPct > 5
    ? `**MODERATE** — ${impactPct.toFixed(1)}% of typical credit. Consider logging but not blocking.\n`
    : `**NEGLIGIBLE** — ${impactPct.toFixed(1)}% of typical credit. Stick with close-of-day entry.\n`;

fs.writeFileSync(`${reportDir}/README.md`, md);
console.log(`\n  Report saved to: ${reportDir}/README.md`);

intradayDb.close();
