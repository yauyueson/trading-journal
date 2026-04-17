/**
 * Campaign C — Post-replay analyzer for portfolio-level responses.
 * Pre-registered in .prompts/campaign-c-portfolio-response-preregistration.md
 *
 * Loads campaign-trades-d65-tp40-gate-none.json (baseline trades), applies
 * 3 pre-registered gates (drawdown circuit breaker, rolling WR throttle,
 * per-ticker cooldown), recomputes combined + holdout metrics, applies the
 * pre-committed decision rule. Writes campaign-c-results.md.
 *
 * Limitation: post-replay approximation does not re-allocate freed slots to
 * signals that were originally blocked by portfolio caps, so gate value is
 * understated. A gate that improves under this understatement is real.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Types ──────────────────────────────────────────────────

interface ReplayTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  exitType: string;
  pnl: number;
  pnlPct: number;
  entryPrice: number;
  exitPrice: number;
  dailyMtM: Array<{ date: string; unrealizedPnl: number }>;
}

interface TradeDump {
  strategyName: string;
  selectionStart: string;
  selectionEnd: string;
  holdoutStart: string;
  holdoutEnd: string;
  baselineDates: string[];
  baselineReturns: number[];
  spyDates: string[];
  spyReturns: number[];
  allTradingDates: string[];
  startingCapital: number;
  oosTrades: ReplayTrade[];
  holdoutTrades: ReplayTrade[];
}

interface GateContext {
  ticker: string;
  entryDate: string;
  closedTradesSorted: ReplayTrade[];    // all trades with exitDate < entryDate, sorted asc
  realizedEquity: number;
  peakRealizedEquity: number;
  startingCapital: number;
}

type GateFn = (ctx: GateContext, state: Record<string, unknown>) => boolean;

// ── Pre-registered gates ──────────────────────────────────

// C1 — realized drawdown circuit breaker
// pause at 15% DD, resume below 5% (hysteresis)
function gateC1_drawdownCB(ctx: GateContext, state: Record<string, unknown>): boolean {
  const ddPct = (ctx.peakRealizedEquity - ctx.realizedEquity) / ctx.peakRealizedEquity;
  if (state.paused === undefined) state.paused = false;
  if (state.paused) {
    if (ddPct <= 0.05) state.paused = false;
    return !state.paused;
  }
  if (ddPct > 0.15) {
    state.paused = true;
    return false;
  }
  return true;
}

// C2 — rolling 10-trade WR throttle
// if ≥10 closed and WR<40%, skip
function gateC2_rollingWR(ctx: GateContext, _state: Record<string, unknown>): boolean {
  const last10 = ctx.closedTradesSorted.slice(-10);
  if (last10.length < 10) return true;
  const wins = last10.filter((t) => t.pnl > 0).length;
  const wr = wins / last10.length;
  return wr >= 0.40;
}

// C3 — per-ticker 3-strikes cooldown (60 days)
function gateC3_tickerCooldown(ctx: GateContext, _state: Record<string, unknown>): boolean {
  const tickerHistory = ctx.closedTradesSorted.filter((t) => t.ticker === ctx.ticker);
  if (tickerHistory.length < 3) return true;
  const last3 = tickerHistory.slice(-3);
  const allLosers = last3.every((t) => t.pnl <= 0);
  if (!allLosers) return true;
  const lastLossDate = last3[last3.length - 1].exitDate;
  const daysSince = (new Date(ctx.entryDate).getTime() - new Date(lastLossDate).getTime()) / 86400000;
  return daysSince > 60;
}

const CANDIDATES: Array<{ name: string; gate: GateFn | null }> = [
  { name: 'baseline', gate: null },
  { name: 'c1-drawdown-cb', gate: gateC1_drawdownCB },
  { name: 'c2-rolling-wr', gate: gateC2_rollingWR },
  { name: 'c3-ticker-cooldown', gate: gateC3_tickerCooldown },
];

// ── Replay + filter ───────────────────────────────────────

function replay(
  allTrades: ReplayTrade[],
  startingCapital: number,
  gate: GateFn | null,
): { kept: ReplayTrade[]; skipped: ReplayTrade[] } {
  const sorted = [...allTrades].sort((a, b) =>
    a.entryDate === b.entryDate ? a.ticker.localeCompare(b.ticker) : a.entryDate.localeCompare(b.entryDate),
  );
  const kept: ReplayTrade[] = [];
  const skipped: ReplayTrade[] = [];
  const gateState: Record<string, unknown> = {};

  // Closed trades at entry time: trades from KEPT set whose exitDate <= entryDate.
  // Mirrors the engine: skipped trades don't affect realized equity.
  const closedSorted: ReplayTrade[] = [];
  let realizedEquity = startingCapital;
  let peakRealizedEquity = startingCapital;

  // Flush newly-closed kept trades whose exitDate ≤ entryDate.
  let nextFlushIdx = 0;
  const keptSortedByExit: ReplayTrade[] = [];

  for (const t of sorted) {
    // First flush kept trades whose exitDate ≤ current entryDate
    while (nextFlushIdx < keptSortedByExit.length && keptSortedByExit[nextFlushIdx].exitDate <= t.entryDate) {
      const closed = keptSortedByExit[nextFlushIdx++];
      closedSorted.push(closed);
      realizedEquity += closed.pnl;
      if (realizedEquity > peakRealizedEquity) peakRealizedEquity = realizedEquity;
    }

    // Apply gate
    let allow = true;
    if (gate) {
      allow = gate(
        {
          ticker: t.ticker,
          entryDate: t.entryDate,
          closedTradesSorted: closedSorted,
          realizedEquity,
          peakRealizedEquity,
          startingCapital,
        },
        gateState,
      );
    }

    if (!allow) {
      skipped.push(t);
      continue;
    }
    kept.push(t);
    // Insert into exit-sorted list (small n, linear insert OK)
    let i = keptSortedByExit.length;
    while (i > 0 && keptSortedByExit[i - 1].exitDate > t.exitDate) i--;
    keptSortedByExit.splice(i, 0, t);
  }
  return { kept, skipped };
}

// ── Metrics helpers (mirror runner.ts / wfa-options.ts) ────

function computeDailyPnL(trades: ReplayTrade[], dates: string[]): number[] {
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const dailyPnl = new Array(dates.length).fill(0);
  for (const trade of trades) {
    let contributed = 0;
    if (trade.dailyMtM && trade.dailyMtM.length > 0) {
      let prevUnrealized = 0;
      for (const mtm of trade.dailyMtM) {
        const day = mtm.date.slice(0, 10);
        const idx = dateIdx.get(day);
        const change = mtm.unrealizedPnl - prevUnrealized;
        if (idx !== undefined) {
          dailyPnl[idx] += change;
          contributed += change;
        }
        prevUnrealized = mtm.unrealizedPnl;
      }
    }
    const residual = trade.pnl - contributed;
    if (Math.abs(residual) > 1e-9) {
      const exitIdx = dateIdx.get(trade.exitDate.slice(0, 10));
      if (exitIdx !== undefined) dailyPnl[exitIdx] += residual;
    }
  }
  return dailyPnl;
}

function sharpeFromReturns(returns: number[]): number {
  if (returns.length === 0) return 0;
  const n = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return std > 0 ? (mean / std) * Math.sqrt(252) : 0;
}

function maxDDFromReturns(returns: number[]): number {
  let equity = 1, peak = 1, maxDD = 0;
  for (const r of returns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function portfolioDailyMetrics(
  trades: ReplayTrade[],
  allTradingDates: string[],
  startDate: string,
  endDate: string,
  startingCapital: number,
): { sharpe: number; maxDD: number; equityCurve: Array<{ date: string; equity: number }>; dailyReturns: number[]; dates: string[] } {
  const dates = allTradingDates.filter((d) => d >= startDate && d <= endDate);
  if (dates.length === 0) return { sharpe: 0, maxDD: 0, equityCurve: [], dailyReturns: [], dates: [] };
  const dailyPnl = computeDailyPnL(trades, dates);
  const dailyReturns: number[] = [];
  const equityCurve: Array<{ date: string; equity: number }> = [];
  let equity = startingCapital, peak = startingCapital, maxDD = 0;
  for (let i = 0; i < dates.length; i++) {
    const prev = equity;
    equity += dailyPnl[i];
    const r = prev > 0 ? (equity - prev) / prev : 0;
    dailyReturns.push(r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
    equityCurve.push({ date: dates[i], equity });
  }
  const sharpe = sharpeFromReturns(dailyReturns);
  return { sharpe, maxDD, equityCurve, dailyReturns, dates };
}

function combinedSharpe(
  strategyReturns: number[],
  strategyDates: string[],
  baselineDates: string[],
  baselineReturns: number[],
): { combined: number; correlation: number; combinedMaxDD: number } {
  const stratMap = new Map<string, number>();
  for (let i = 0; i < strategyDates.length; i++) stratMap.set(strategyDates[i], strategyReturns[i] ?? 0);
  const baseMap = new Map<string, number>();
  for (let i = 0; i < baselineDates.length; i++) baseMap.set(baselineDates[i], baselineReturns[i] ?? 0);
  const allDates = [...new Set([...strategyDates, ...baselineDates])].sort();
  const combined: number[] = [];
  for (const d of allDates) {
    combined.push(0.5 * (stratMap.get(d) ?? 0) + 0.5 * (baseMap.get(d) ?? 0));
  }
  // correlation on dates with both
  const sO: number[] = [], bO: number[] = [];
  for (const d of allDates) {
    const s = stratMap.get(d), b = baseMap.get(d);
    if (s !== undefined && b !== undefined) { sO.push(s); bO.push(b); }
  }
  let corr = 0;
  if (sO.length >= 20) {
    const n = sO.length;
    const meanS = sO.reduce((s, r) => s + r, 0) / n;
    const meanB = bO.reduce((s, r) => s + r, 0) / n;
    let cov = 0, vS = 0, vB = 0;
    for (let i = 0; i < n; i++) {
      const ds = sO[i] - meanS, db = bO[i] - meanB;
      cov += ds * db; vS += ds * ds; vB += db * db;
    }
    corr = (vS > 0 && vB > 0) ? cov / Math.sqrt(vS * vB) : 0;
  }
  return { combined: sharpeFromReturns(combined), correlation: corr, combinedMaxDD: maxDDFromReturns(combined) };
}

function informationRatio(strategyReturns: number[], strategyDates: string[], spyDates: string[], spyReturns: number[]): { ir: number; excessReturn: number } {
  const stratMap = new Map<string, number>();
  for (let i = 0; i < strategyDates.length; i++) stratMap.set(strategyDates[i], strategyReturns[i] ?? 0);
  const spyMap = new Map<string, number>();
  for (let i = 0; i < spyDates.length; i++) spyMap.set(spyDates[i], spyReturns[i] ?? 0);
  const excess: number[] = [];
  for (const d of strategyDates) {
    const s = stratMap.get(d), b = spyMap.get(d);
    if (s !== undefined && b !== undefined) excess.push(s - b);
  }
  if (excess.length < 20) return { ir: 0, excessReturn: 0 };
  const n = excess.length;
  const mean = excess.reduce((s, r) => s + r, 0) / n;
  const variance = excess.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return { ir: std > 0 ? (mean / std) * Math.sqrt(252) : 0, excessReturn: mean * 252 };
}

// ── Main ───────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dumpPath = path.resolve(__dirname, 'campaign-trades-d65-tp40-gate-none.json');
const resultsPath = path.resolve(__dirname, 'campaign-c-results.md');

if (!fs.existsSync(dumpPath)) {
  console.error(`Missing ${dumpPath}. Run:\n  GATE=none SAVE_TRADES=1 AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-c AUTORESEARCH_MIN_OOS_TRADES=60 npx tsx scripts/autoresearch/runner.ts`);
  process.exit(1);
}
const dump: TradeDump = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));

interface Row {
  name: string;
  selSharpe: number;
  selCombined: number;
  selCorr: number;
  selMaxDD: number;
  selTradesKept: number;
  selTradesSkipped: number;
  selSpyIR: number;
  hldSharpe: number;
  hldCombined: number;
  hldCorr: number;
  hldMaxDD: number;
  hldTradesKept: number;
  hldTradesSkipped: number;
  hldSpyIR: number;
  hldExcessRet: number;
  passesValidity: boolean;
  passesHoldout: boolean;
}

const rows: Row[] = [];

for (const cand of CANDIDATES) {
  // For the selection window we replay ONLY the oosTrades.
  // For the holdout we replay BOTH (state at holdout entry time needs the full
  // realized history, not just holdout trades).
  const sel = replay(dump.oosTrades, dump.startingCapital, cand.gate);

  // Holdout: start state from selection final state, then replay holdout trades
  const fullReplay = replay(
    [...dump.oosTrades, ...dump.holdoutTrades],
    dump.startingCapital,
    cand.gate,
  );
  const hldKept = fullReplay.kept.filter((t) => t.entryDate >= dump.holdoutStart);
  const hldSkipped = fullReplay.skipped.filter((t) => t.entryDate >= dump.holdoutStart);

  // Metrics
  const selM = portfolioDailyMetrics(
    sel.kept, dump.allTradingDates, dump.selectionStart, dump.selectionEnd, dump.startingCapital,
  );
  const hldM = portfolioDailyMetrics(
    hldKept, dump.allTradingDates, dump.holdoutStart, dump.holdoutEnd, dump.startingCapital,
  );
  const selCmb = combinedSharpe(selM.dailyReturns, selM.dates, dump.baselineDates, dump.baselineReturns);
  const hldCmb = combinedSharpe(hldM.dailyReturns, hldM.dates, dump.baselineDates, dump.baselineReturns);
  const selIR = informationRatio(selM.dailyReturns, selM.dates, dump.spyDates, dump.spyReturns);
  const hldIR = informationRatio(hldM.dailyReturns, hldM.dates, dump.spyDates, dump.spyReturns);

  const passValidity =
    selM.maxDD <= 35 &&
    sel.kept.length >= 60 &&
    selM.sharpe > 0;
  const passHoldoutGate = hldM.sharpe >= 0.3 || hldIR.ir >= 0.3;

  rows.push({
    name: cand.name,
    selSharpe: selM.sharpe,
    selCombined: selCmb.combined,
    selCorr: selCmb.correlation,
    selMaxDD: selM.maxDD,
    selTradesKept: sel.kept.length,
    selTradesSkipped: sel.skipped.length,
    selSpyIR: selIR.ir,
    hldSharpe: hldM.sharpe,
    hldCombined: hldCmb.combined,
    hldCorr: hldCmb.correlation,
    hldMaxDD: hldM.maxDD,
    hldTradesKept: hldKept.length,
    hldTradesSkipped: hldSkipped.length,
    hldSpyIR: hldIR.ir,
    hldExcessRet: hldIR.excessReturn,
    passesValidity: passValidity,
    passesHoldout: passHoldoutGate,
  });
}

// ── Decision rule: highest selCombined that passes validity ──
const qualified = rows.filter((r) => r.passesValidity);
const sortedQ = [...qualified].sort((a, b) => b.selCombined - a.selCombined);
const winner = sortedQ[0];
const baseline = rows.find((r) => r.name === 'baseline')!;

// ── Output table + verdict ───────────────────────────────
function pad(n: number, w: number): string { return n.toFixed(3).padStart(w); }
function pct(n: number, w: number): string { return (n.toFixed(1) + '%').padStart(w); }

let md = '';
md += '# Campaign C — Portfolio Response Results\n\n';
md += `**Run:** ${new Date().toISOString()}\n`;
md += `**Pre-registration:** [.prompts/campaign-c-portfolio-response-preregistration.md](../../.prompts/campaign-c-portfolio-response-preregistration.md)\n`;
md += `**Method:** Post-replay approximation (does not reallocate freed slots — gate value understated)\n`;
md += `**Base trade list:** ${dump.oosTrades.length} OOS + ${dump.holdoutTrades.length} holdout (baseline d65-tp40)\n\n`;

md += '## Selection window (2019-01-17 → 2024-01-19)\n\n';
md += '| Variant             | Combd | StandS | MaxDD | Corr  | Kept / Skipped | SPY IR | Valid |\n';
md += '|---------------------|-------|--------|-------|-------|----------------|--------|-------|\n';
for (const r of rows) {
  md += `| ${r.name.padEnd(19)} | ${pad(r.selCombined, 5)} | ${pad(r.selSharpe, 6)} | ${pct(r.selMaxDD, 5)} | ${pad(r.selCorr, 5)} | ${String(r.selTradesKept).padStart(4)} / ${String(r.selTradesSkipped).padEnd(3)}     | ${pad(r.selSpyIR, 6)} | ${r.passesValidity ? 'YES' : ' NO'}   |\n`;
}

md += '\n## Holdout window (2024-01-22 → 2026-02-27, includes 45-loss streak)\n\n';
md += '| Variant             | Combd | StandS | MaxDD | Corr  | Kept / Skipped | SPY IR | Excess/yr | H-pass |\n';
md += '|---------------------|-------|--------|-------|-------|----------------|--------|-----------|--------|\n';
for (const r of rows) {
  md += `| ${r.name.padEnd(19)} | ${pad(r.hldCombined, 5)} | ${pad(r.hldSharpe, 6)} | ${pct(r.hldMaxDD, 5)} | ${pad(r.hldCorr, 5)} | ${String(r.hldTradesKept).padStart(4)} / ${String(r.hldTradesSkipped).padEnd(3)}     | ${pad(r.hldSpyIR, 6)} | ${pct(r.hldExcessRet * 100, 8)} | ${r.passesHoldout ? 'PASS' : 'FAIL'}   |\n`;
}

md += '\n## Decision (per pre-registered rule)\n\n';
if (winner) {
  md += `Highest selection combinedSharpe passing validity: **${winner.name}** (${winner.selCombined.toFixed(3)})\n\n`;
  md += `Baseline selection combinedSharpe: **${baseline.selCombined.toFixed(3)}**\n`;
  md += `Baseline holdout Sharpe / IR: ${baseline.hldSharpe.toFixed(3)} / ${baseline.hldSpyIR.toFixed(3)}\n\n`;

  const beatsBaselineSel = winner.selCombined > baseline.selCombined + 0.01;  // meaningful margin
  const beatsBaselineHold = (winner.hldSharpe > baseline.hldSharpe + 0.1) || (winner.hldSpyIR > baseline.hldSpyIR + 0.1);

  md += `### Write-once holdout\n\n`;
  md += `Winner's holdout: Sharpe=${winner.hldSharpe.toFixed(3)}, IR=${winner.hldSpyIR.toFixed(3)}, MaxDD=${winner.hldMaxDD.toFixed(1)}%, excess return ${(winner.hldExcessRet * 100).toFixed(2)}%/yr\n\n`;

  if (winner.name === 'baseline') {
    md += `### Verdict: No portfolio response beats baseline.\n\n`;
    md += `The ungated baseline wins on selection combinedSharpe. Portfolio-level responses do not add value under the post-replay approximation. Keep d65-tp40 as-is.\n`;
  } else if (beatsBaselineSel && beatsBaselineHold) {
    md += `### Verdict: Adopt ${winner.name}.\n\n`;
    md += `Strictly beats baseline on both selection AND holdout. Genuine portfolio-level edge under the approximation.\n`;
  } else if (!beatsBaselineSel && beatsBaselineHold) {
    md += `### Verdict: ${winner.name} trades off — no selection improvement, but improved holdout.\n\n`;
    md += `Interpret cautiously: the gate may or may not generalize. Per the pre-committed rule (selection-based ranking), do NOT adopt unless selection also improved. Holdout signal alone isn't enough.\n`;
  } else {
    md += `### Verdict: No decisive improvement over baseline.\n\n`;
    md += `Winner (${winner.name}) does not meaningfully beat baseline on either window. Keep d65-tp40 unchanged.\n`;
  }
} else {
  md += `No candidate passes validity. Campaign C null.\n`;
}

md += '\n---\n\n## Raw metrics\n\n```json\n';
md += JSON.stringify(rows, null, 2);
md += '\n```\n';

fs.writeFileSync(resultsPath, md);
console.log(`Wrote ${resultsPath}`);

// Terse stdout summary
console.log('\n=== Campaign C Summary ===');
console.log('Variant              Sel Combd  Sel Sharpe  Sel MaxDD  Sel Kept  |  Hld Sharpe  Hld IR     Hld MaxDD  Hld Kept  Valid   H-Pass');
for (const r of rows) {
  console.log(
    `${r.name.padEnd(20)}  ${r.selCombined.toFixed(3).padStart(9)}  ${r.selSharpe.toFixed(3).padStart(10)}  ${(r.selMaxDD.toFixed(1) + '%').padStart(8)}  ${String(r.selTradesKept).padStart(8)}  |  ${r.hldSharpe.toFixed(3).padStart(10)}  ${r.hldSpyIR.toFixed(3).padStart(8)}  ${(r.hldMaxDD.toFixed(1) + '%').padStart(8)}  ${String(r.hldTradesKept).padStart(8)}  ${r.passesValidity ? 'VALID' : 'inval'}   ${r.passesHoldout ? 'PASS' : 'FAIL'}`,
  );
}
if (winner) {
  console.log(`\nWinner: ${winner.name}`);
}
