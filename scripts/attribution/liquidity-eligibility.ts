/**
 * Liquidity eligibility table — sweeps each cached ticker through monthly
 * snapshots from 2018-01 → 2026-02 and asks two questions:
 *
 *   1. BCD eligibility: can we find a same-expiry δ-0.50 + δ-0.20 call pair
 *      in DTE 30-60? (mirrors makeDebitSpreadEvaluator's two-step pick)
 *
 *   2. PMCC eligibility: can we find a δ-0.70-0.80 LEAP in DTE 240-300 AND
 *      a δ-0.20-0.30 short call in DTE 30-45? (independent expiries)
 *
 * For each successfully-constructed structure we capture median OI per leg
 * and median bid/ask as % of mid (the slippage proxy).
 *
 * Output: per-ticker scorecard with tradability %, liquidity stats, and a
 * BCD-rotation / PMCC-sleeve tier recommendation.
 *
 * Earnings calendar coverage is OUT of scope for v1 — flagged in the report.
 * Sector ETFs (XLK, XLF, ...) are NOT in the cache and excluded — flagged.
 *
 * Run: npx tsx scripts/attribution/liquidity-eligibility.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDB, getCachedChain, findStrikeByDelta,
  type ChainRow, type StrikeMatch,
} from '../../src/lib/backtest/chain-cache';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(
  __dirname, '../../backtesting history/credit-spread/reports/liquidity-eligibility/scorecard.md',
);

initDB(undefined, true);

// ── Universe ─────────────────────────────────────────────────────────────

const TICKERS: string[] = [
  // Core mega-cap (12)
  'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA',
  'JPM', 'GS', 'COST', 'NFLX', 'IWM',
  // Growth (9)
  'AMD', 'AVGO', 'BA', 'COIN', 'HOOD', 'LULU', 'MSTR', 'PLTR', 'UBER',
  // Dow + AI/hot (9)
  'CRM', 'ORCL', 'CRWD', 'SHOP', 'PANW', 'ANET', 'VRT', 'ARM', 'NOW',
];

// ── Monthly snapshot calendar ────────────────────────────────────────────

const cachePath = path.resolve(__dirname, '../autoresearch/data-cache.json');
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as { tickers: Record<string, { candles: Array<{ date: string }> }> };
const allDates: string[] = (cache.tickers.QQQ?.candles ?? []).map(c => c.date).sort();

const SNAPSHOT_DATES: string[] = (() => {
  const out: string[] = [];
  let lastYM = '';
  for (const d of allDates) {
    if (d < '2018-01-01' || d > '2026-02-28') continue;
    const ym = d.slice(0, 7);
    if (ym !== lastYM) { out.push(d); lastYM = ym; }
  }
  return out;
})();

console.log(`${SNAPSHOT_DATES.length} monthly snapshots from ${SNAPSHOT_DATES[0]} to ${SNAPSHOT_DATES[SNAPSHOT_DATES.length - 1]}`);

// ── Eligibility checks ──────────────────────────────────────────────────

interface LegStats {
  bidAskPctMid: number;   // (ask - bid) / mid
  oi: number;
  strike: number;
  dte: number;
  delta: number;
}

function legFromMatch(m: StrikeMatch): LegStats | null {
  const mid = m.mid;
  if (!isFinite(mid) || mid <= 0) return null;
  const spread = m.ask - m.bid;
  return {
    bidAskPctMid: spread / mid,
    oi: m.oi,
    strike: m.row.strike,
    dte: m.row.dte,
    delta: m.delta,
  };
}

function checkBCD(chain: ChainRow[]): { long: LegStats; short: LegStats } | null {
  // Long δ 0.50, then re-pick short δ 0.20 in same expiry (mirror evaluator).
  const long = findStrikeByDelta(chain, 0.50, 'Call', [30, 60], 0);
  if (!long) return null;
  let short = findStrikeByDelta(chain, 0.20, 'Call', [30, 60], 0);
  if (!short) return null;
  if (short.row.expir_date !== long.row.expir_date) {
    const exact: [number, number] = [long.row.dte, long.row.dte];
    const retry = findStrikeByDelta(chain, 0.20, 'Call', exact, 0);
    if (!retry || retry.row.expir_date !== long.row.expir_date) return null;
    short = retry;
  }
  if (long.row.strike >= short.row.strike) return null;
  const longLeg = legFromMatch(long);
  const shortLeg = legFromMatch(short);
  if (!longLeg || !shortLeg) return null;
  return { long: longLeg, short: shortLeg };
}

function checkPMCCLeap(chain: ChainRow[]): LegStats | null {
  // δ 0.75 target inside the 0.70-0.80 band (findStrikeByDelta picks closest).
  const m = findStrikeByDelta(chain, 0.75, 'Call', [240, 300], 0);
  if (!m) return null;
  if (m.delta < 0.70 || m.delta > 0.80) return null;
  return legFromMatch(m);
}

function checkPMCCShort(chain: ChainRow[]): LegStats | null {
  const m = findStrikeByDelta(chain, 0.25, 'Call', [30, 45], 0);
  if (!m) return null;
  if (m.delta < 0.20 || m.delta > 0.30) return null;
  return legFromMatch(m);
}

// ── Per-ticker sweep ─────────────────────────────────────────────────────

interface TickerScorecard {
  ticker: string;
  snapshots: number;
  withData: number;            // snapshots where chain has any rows
  // Cache coverage by DTE window — distinguishes "no data fetched" vs "no
  // such structure exists in market". A ticker with withData=98 but
  // bcdDteCoverage=10 means we'd need to backfill ORATS DTE 30-60 chains
  // before claiming it's market-illiquid.
  bcdDteCoverage: number;      // snapshots with ANY rows in DTE 30-60
  pmccLeapDteCoverage: number; // snapshots with ANY rows in DTE 240-300
  pmccShortDteCoverage: number;// snapshots with ANY rows in DTE 30-45
  bcdOk: number;
  pmccLeapOk: number;
  pmccShortOk: number;
  pmccBothOk: number;
  underlyingPriceMin: number;
  underlyingPriceMedian: number;
  underlyingPriceMax: number;
  bcdLongOiMedian: number;
  bcdShortOiMedian: number;
  bcdLongSpreadPctMedian: number;
  bcdShortSpreadPctMedian: number;
  pmccLeapOiMedian: number;
  pmccShortOiMedian: number;
  pmccLeapSpreadPctMedian: number;
  pmccShortSpreadPctMedian: number;
  firstChainDate: string | null;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function scoreTicker(ticker: string): TickerScorecard {
  const card: TickerScorecard = {
    ticker, snapshots: SNAPSHOT_DATES.length, withData: 0,
    bcdDteCoverage: 0, pmccLeapDteCoverage: 0, pmccShortDteCoverage: 0,
    bcdOk: 0, pmccLeapOk: 0, pmccShortOk: 0, pmccBothOk: 0,
    underlyingPriceMin: NaN, underlyingPriceMedian: NaN, underlyingPriceMax: NaN,
    bcdLongOiMedian: NaN, bcdShortOiMedian: NaN,
    bcdLongSpreadPctMedian: NaN, bcdShortSpreadPctMedian: NaN,
    pmccLeapOiMedian: NaN, pmccShortOiMedian: NaN,
    pmccLeapSpreadPctMedian: NaN, pmccShortSpreadPctMedian: NaN,
    firstChainDate: null,
  };

  const prices: number[] = [];
  const bcdLongOis: number[] = [], bcdShortOis: number[] = [];
  const bcdLongSp: number[] = [], bcdShortSp: number[] = [];
  const pmccLeapOis: number[] = [], pmccShortOis: number[] = [];
  const pmccLeapSp: number[] = [], pmccShortSp: number[] = [];

  for (const d of SNAPSHOT_DATES) {
    const chain = getCachedChain(ticker, d);
    if (chain.length === 0) continue;
    card.withData += 1;
    if (!card.firstChainDate) card.firstChainDate = d;
    prices.push(chain[0].stock_price);

    // DTE-window cache coverage (cheap pre-check that distinguishes
    // "ORATS data exists for this DTE window" from "delta target wasn't
    // found within fetched data"). A ticker with withData=98 but
    // bcdDteCoverage=10 needs a chain backfill, not a market explanation.
    if (chain.some(r => r.dte >= 30 && r.dte <= 60))   card.bcdDteCoverage += 1;
    if (chain.some(r => r.dte >= 240 && r.dte <= 300)) card.pmccLeapDteCoverage += 1;
    if (chain.some(r => r.dte >= 30 && r.dte <= 45))   card.pmccShortDteCoverage += 1;

    const bcd = checkBCD(chain);
    if (bcd) {
      card.bcdOk += 1;
      bcdLongOis.push(bcd.long.oi);
      bcdShortOis.push(bcd.short.oi);
      bcdLongSp.push(bcd.long.bidAskPctMid);
      bcdShortSp.push(bcd.short.bidAskPctMid);
    }

    const leap = checkPMCCLeap(chain);
    if (leap) {
      card.pmccLeapOk += 1;
      pmccLeapOis.push(leap.oi);
      pmccLeapSp.push(leap.bidAskPctMid);
    }
    const short = checkPMCCShort(chain);
    if (short) {
      card.pmccShortOk += 1;
      pmccShortOis.push(short.oi);
      pmccShortSp.push(short.bidAskPctMid);
    }
    if (leap && short) card.pmccBothOk += 1;
  }

  if (prices.length) {
    card.underlyingPriceMin = Math.min(...prices);
    card.underlyingPriceMedian = median(prices);
    card.underlyingPriceMax = Math.max(...prices);
  }
  card.bcdLongOiMedian = median(bcdLongOis);
  card.bcdShortOiMedian = median(bcdShortOis);
  card.bcdLongSpreadPctMedian = median(bcdLongSp);
  card.bcdShortSpreadPctMedian = median(bcdShortSp);
  card.pmccLeapOiMedian = median(pmccLeapOis);
  card.pmccShortOiMedian = median(pmccShortOis);
  card.pmccLeapSpreadPctMedian = median(pmccLeapSp);
  card.pmccShortSpreadPctMedian = median(pmccShortSp);
  return card;
}

console.log('\nScoring tickers...');
const cards: TickerScorecard[] = [];
for (const t of TICKERS) {
  const t0 = Date.now();
  const c = scoreTicker(t);
  cards.push(c);
  console.log(
    `  ${t.padEnd(5)}  data ${c.withData}/${c.snapshots}  ` +
    `dteCov bcd=${c.bcdDteCoverage} pmccL=${c.pmccLeapDteCoverage} pmccS=${c.pmccShortDteCoverage}  ` +
    `ok bcd=${c.bcdOk} pmcc=${c.pmccBothOk}  ` +
    `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
}

// ── Tier classification ─────────────────────────────────────────────────

function bcdTradablePct(c: TickerScorecard): number {
  return c.withData ? (c.bcdOk / c.withData) * 100 : 0;
}
function pmccTradablePct(c: TickerScorecard): number {
  return c.withData ? (c.pmccBothOk / c.withData) * 100 : 0;
}

// Liquidity score combines tradability rate, median OI (capped), and bid/ask
// spread tightness. Composite = tradability% × clip(medianOI/100, 0, 50)
// × (1 − clip(spreadPct, 0, 0.5)). Higher is better.
function bcdScore(c: TickerScorecard): number {
  const oi = isNaN(c.bcdLongOiMedian) ? 0 : c.bcdLongOiMedian;
  const sp = isNaN(c.bcdLongSpreadPctMedian) ? 0.5 : c.bcdLongSpreadPctMedian;
  return bcdTradablePct(c) * Math.min(50, oi / 100) * (1 - Math.min(0.5, sp));
}
function pmccScore(c: TickerScorecard): number {
  const oi = isNaN(c.pmccLeapOiMedian) ? 0 : c.pmccLeapOiMedian;
  const sp = isNaN(c.pmccLeapSpreadPctMedian) ? 0.5 : c.pmccLeapSpreadPctMedian;
  return pmccTradablePct(c) * Math.min(50, oi / 100) * (1 - Math.min(0.5, sp));
}

// Tier thresholds (predeclared, post-hoc adjustable but this is v1):
//   A — tradable on ≥80% of in-cache snapshots, leg OI median ≥ 200, spread% ≤ 15%
//   B — tradable on ≥60%, leg OI median ≥ 50,  spread% ≤ 25%
//   C — tradable on ≥40%
//   D — below C
function bcdTier(c: TickerScorecard): 'A' | 'B' | 'C' | 'D' {
  const t = bcdTradablePct(c);
  const oi = isFinite(c.bcdLongOiMedian) ? c.bcdLongOiMedian : 0;
  const sp = isFinite(c.bcdLongSpreadPctMedian) ? c.bcdLongSpreadPctMedian : 1;
  if (t >= 80 && oi >= 200 && sp <= 0.15) return 'A';
  if (t >= 60 && oi >= 50  && sp <= 0.25) return 'B';
  if (t >= 40) return 'C';
  return 'D';
}
function pmccTier(c: TickerScorecard): 'A' | 'B' | 'C' | 'D' {
  const t = pmccTradablePct(c);
  const oi = isFinite(c.pmccLeapOiMedian) ? c.pmccLeapOiMedian : 0;
  const sp = isFinite(c.pmccLeapSpreadPctMedian) ? c.pmccLeapSpreadPctMedian : 1;
  // PMCC needs higher underlying price for $5K+ LEAP sizing.
  const priceOk = c.underlyingPriceMedian >= 75;
  if (priceOk && t >= 70 && oi >= 100 && sp <= 0.20) return 'A';
  if (priceOk && t >= 50 && oi >= 30  && sp <= 0.30) return 'B';
  if (t >= 30) return 'C';
  return 'D';
}

// ── Render ───────────────────────────────────────────────────────────────

function pct(n: number): string { return isFinite(n) ? n.toFixed(1) + '%' : '—'; }
function num(n: number, digits = 0): string { return isFinite(n) ? n.toFixed(digits) : '—'; }
function dollar(n: number): string { return isFinite(n) ? '$' + n.toFixed(0) : '—'; }

const lines: string[] = [];
lines.push('# Liquidity eligibility scorecard');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push('');
lines.push(`Universe: ${TICKERS.length} cached tickers · monthly snapshots ${SNAPSHOT_DATES[0]} → ${SNAPSHOT_DATES[SNAPSHOT_DATES.length - 1]} (${SNAPSHOT_DATES.length} total)`);
lines.push('');
lines.push('## Critical caveats');
lines.push('');
lines.push('### Cache coverage gap (READ FIRST)');
lines.push('');
lines.push('The chain SQLite was populated by various WFA studies that fetched **only the DTE windows their target strategy needed**. Many tickers have full data for DTE 60+ (PMCC short / mid-DTE) but are sparse or missing in DTE 30-60 (BCD) and DTE 240+ (PMCC LEAP).');
lines.push('');
lines.push('"DTE coverage" columns below show, for each ticker, the % of in-cache snapshots that have **any** chain row in the relevant DTE window. A ticker with `bcd-dte-cov 12%` but `withData 100%` is **infrastructure-limited, not market-illiquid** — backfilling ORATS chains would change its tier.');
lines.push('');
lines.push('Tier rankings should be read as: "what we can trade *given the current cache*". A separate chain backfill pass is implied for any ticker we want to promote later.');
lines.push('');
lines.push('### Other caveats');
lines.push('');
lines.push('- **Earnings calendar coverage is OUT of scope for v1.** Single-name event risk is unmodeled here. Treat single-name BCD/PMCC results as upper bounds.');
lines.push('- **Sector ETFs (XLK / XLF / XLV / XLY / XLE / XLI / XLP) are NOT in the cache.** Adding them requires a separate ORATS chain fetch + Supabase ingest. Tracked as a follow-up.');
lines.push('- Snapshot cadence is monthly (first trading day of each month). Day-to-day tradability noise is not measured — this is a *macro* eligibility scorecard, not a microstructure one.');
lines.push('- "BCD eligibility" requires both legs in the SAME expiry (mirrors `makeDebitSpreadEvaluator`).');
lines.push('- "PMCC eligibility" requires both legs found in their respective DTE windows (independent expiries).');
lines.push('- IPO-recent tickers (ARM, COIN, HOOD, PLTR) have shorter `withData` denominators — interpret tradability % relative to coverage.');
lines.push('');

lines.push('## BCD rotation tier (long δ 0.50 + short δ 0.20, DTE 30-60)');
lines.push('');
lines.push('| Tier | Ticker | DTE 30-60 cov | Tradable % | Coverage | Med Px | Long OI | Short OI | Long spread% | Short spread% | Score |');
lines.push('|:-:|--------|--------------:|-----------:|---------:|-------:|--------:|---------:|-------------:|--------------:|------:|');
const bcdRanked = [...cards].sort((a, b) => bcdScore(b) - bcdScore(a));
for (const c of bcdRanked) {
  const dteCovPct = c.withData ? (c.bcdDteCoverage / c.withData) * 100 : 0;
  lines.push(
    `| ${bcdTier(c)} | ${c.ticker} | ${pct(dteCovPct)} | ` +
    `${pct(bcdTradablePct(c))} | ${c.withData}/${c.snapshots} | ` +
    `${dollar(c.underlyingPriceMedian)} | ${num(c.bcdLongOiMedian)} | ${num(c.bcdShortOiMedian)} | ` +
    `${pct(c.bcdLongSpreadPctMedian * 100)} | ${pct(c.bcdShortSpreadPctMedian * 100)} | ` +
    `${num(bcdScore(c), 0)} |`,
  );
}
lines.push('');
lines.push('Tier definitions:');
lines.push('- **A** — Tradable ≥80% of in-cache snapshots, long-leg OI median ≥200, long-leg spread% ≤15%.');
lines.push('- **B** — Tradable ≥60%, OI ≥50, spread% ≤25%.');
lines.push('- **C** — Tradable ≥40% (anything below A/B but still investible).');
lines.push('- **D** — Below C; not viable.');
lines.push('');

lines.push('## PMCC sleeve tier (LEAP δ 0.70-0.80 DTE 240-300, short δ 0.20-0.30 DTE 30-45)');
lines.push('');
lines.push('| Tier | Ticker | LEAP DTE cov | Short DTE cov | LEAP % | Short % | Both % | Coverage | Med Px | LEAP OI | Short OI | LEAP spread% | Short spread% | Score |');
lines.push('|:-:|--------|-------------:|--------------:|-------:|--------:|-------:|---------:|-------:|--------:|---------:|-------------:|--------------:|------:|');
const pmccRanked = [...cards].sort((a, b) => pmccScore(b) - pmccScore(a));
for (const c of pmccRanked) {
  const leapCovPct = c.withData ? (c.pmccLeapDteCoverage / c.withData) * 100 : 0;
  const shortCovPct = c.withData ? (c.pmccShortDteCoverage / c.withData) * 100 : 0;
  lines.push(
    `| ${pmccTier(c)} | ${c.ticker} | ${pct(leapCovPct)} | ${pct(shortCovPct)} | ` +
    `${pct(c.withData ? (c.pmccLeapOk / c.withData) * 100 : 0)} | ` +
    `${pct(c.withData ? (c.pmccShortOk / c.withData) * 100 : 0)} | ` +
    `${pct(pmccTradablePct(c))} | ${c.withData}/${c.snapshots} | ` +
    `${dollar(c.underlyingPriceMedian)} | ${num(c.pmccLeapOiMedian)} | ${num(c.pmccShortOiMedian)} | ` +
    `${pct(c.pmccLeapSpreadPctMedian * 100)} | ${pct(c.pmccShortSpreadPctMedian * 100)} | ` +
    `${num(pmccScore(c), 0)} |`,
  );
}
lines.push('');
lines.push('Tier definitions (PMCC is more demanding — adds underlying price floor for $5K LEAP sizing):');
lines.push('- **A** — Both-legs tradable ≥70%, LEAP OI ≥100, LEAP spread% ≤20%, **median underlying price ≥ $75**.');
lines.push('- **B** — Tradable ≥50%, OI ≥30, spread% ≤30%, median price ≥ $75.');
lines.push('- **C** — Tradable ≥30% (price floor relaxed).');
lines.push('- **D** — Below C.');
lines.push('');

// Recommendations
lines.push('## Recommendations');
lines.push('');
const bcdAB = bcdRanked.filter(c => bcdTier(c) === 'A' || bcdTier(c) === 'B').map(c => c.ticker);
const pmccAB = pmccRanked.filter(c => pmccTier(c) === 'A' || pmccTier(c) === 'B').map(c => c.ticker);
const bcdC = bcdRanked.filter(c => bcdTier(c) === 'C').map(c => c.ticker);
const pmccC = pmccRanked.filter(c => pmccTier(c) === 'C').map(c => c.ticker);

lines.push(`- **BCD rotation universe (Tier A + B, given current cache)** — ${bcdAB.length} ticker${bcdAB.length === 1 ? '' : 's'}: ${bcdAB.join(', ') || '(none)'}.`);
if (bcdC.length) lines.push(`  - Tier C (marginal): ${bcdC.join(', ')}. Investigate why before including.`);
lines.push(`- **PMCC sleeve universe (Tier A + B, given current cache)** — ${pmccAB.length} ticker${pmccAB.length === 1 ? '' : 's'}: ${pmccAB.join(', ') || '(none)'}.`);
if (pmccC.length) lines.push(`  - Tier C (marginal): ${pmccC.join(', ')}. Likely fail under stricter WFA gates.`);
// Backfill candidates: high data coverage but low DTE-window coverage = cache gap.
const bcdBackfill = cards.filter(c => c.withData >= 60 && c.bcdDteCoverage / Math.max(1, c.withData) < 0.5);
if (bcdBackfill.length) {
  lines.push('');
  lines.push('### Backfill candidates (cache-limited, not market-limited)');
  lines.push('');
  lines.push('These tickers have full per-day cache data but their **DTE 30-60 window is sparse or missing** — likely because earlier WFA studies fetched only DTE 60+ for them. A targeted ORATS chain backfill at DTE 30-60 would meaningfully change their tier.');
  lines.push('');
  for (const c of bcdBackfill) {
    const cov = c.withData ? (c.bcdDteCoverage / c.withData) * 100 : 0;
    lines.push(`- **${c.ticker}** — withData ${c.withData}/${c.snapshots}, DTE 30-60 coverage ${cov.toFixed(0)}%`);
  }
}
lines.push('');
lines.push('Score formula: `tradability% × clip(medianOI / 100, 0, 50) × (1 − clip(legSpread%, 0, 50%))`. Higher is better. Use it for ranking, not absolute interpretation.');

if (!fs.existsSync(path.dirname(REPORT_PATH))) fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, lines.join('\n'));
console.log(`\nWrote ${REPORT_PATH}`);
