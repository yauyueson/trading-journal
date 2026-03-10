/**
 * Signal Ablation Test — which features help vs hurt credit spread P&L?
 *
 * Fixed trade config: Tier A (80-89), TP 30%, No SL, IV ≥ 0
 * Variable: signal composition (remove one feature at a time)
 *
 * Also tests on ALL tier and both credit spreads & LEAPs to see
 * if features matter differently by trade type.
 *
 * Usage:
 *   npx tsx scripts/ablation-test.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env ────────────────────────────────────────────
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
      if (key && !key.startsWith('#')) process.env[key] = value;
    }
  });
}

import type { BacktestCandle } from '../src/lib/backtest/types';
import type { TechScoreOptions } from '../src/lib/tech-analysis';
import { precomputeSignals } from '../src/lib/backtest/engine';
import { initDB, closeDB } from '../src/lib/backtest/chain-cache';
import {
  simulateCreditSpread, simulateLeap, computeOptionAnalytics,
  DEFAULT_CREDIT_CONFIG, DEFAULT_LEAP_CONFIG,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionSimAnalytics,
} from '../src/lib/backtest/option-sim';

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';

const DATA_START = '2019-01-01';
const OOS_START  = '2024-04-01';
const OOS_END    = '2025-12-31';
const DATA_END   = '2025-12-31';

const ALL_TICKERS = ['SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT'];

// ── Ablation Configs ────────────────────────────────────

interface AblationConfig {
  label: string;
  options: TechScoreOptions;
}

const ABLATIONS: AblationConfig[] = [
  { label: 'BASELINE (all)',     options: {} },
  { label: '−MB  (w_mb=0)',     options: { w_mb: 0 } },
  { label: '−BXS (w_bxs=0)',    options: { w_bxs: 0 } },
  { label: '−BXL (w_bxl=0)',    options: { w_bxl: 0 } },
  { label: '−EMA (w_ema=0)',    options: { w_ema: 0 } },
  { label: '−MOM (w_mom=0)',    options: { w_mom: 0 } },
  { label: '−ADX (w_adx=0)',    options: { w_adx: 0 } },
  { label: '−VOL (w_vol=0)',    options: { w_vol: 0 } },
  // Also test removing multiple low-weight features
  { label: '−MOM−VOL',          options: { w_mom: 0, w_vol: 0 } },
  { label: '−ADX−VOL−MOM',      options: { w_adx: 0, w_vol: 0, w_mom: 0 } },
  // Test core-only (just the big 3)
  { label: 'CORE ONLY (MB+BXS+BXL)', options: { w_ema: 0, w_mom: 0, w_adx: 0, w_vol: 0 } },
];

// Trade configs
const CREDIT_CONFIG: SimConfig = {
  ...DEFAULT_CREDIT_CONFIG,
  creditProfitTarget: 0.30,
  creditStopLossMultiple: 100,  // effectively no SL
  minIVRank: 0,
};

// ── Supabase ────────────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── IV Rank ─────────────────────────────────────────────

function computeIVRank(ivSeries: (number | null)[]): (number | null)[] {
  const WINDOW = 252;
  return ivSeries.map((v, i) => {
    if (i < WINDOW || v == null) return null;
    const w = ivSeries.slice(i - WINDOW, i + 1).filter(x => x != null) as number[];
    if (w.length < 100) return null;
    const min = Math.min(...w), max = Math.max(...w), range = max - min;
    return range > 0 ? ((v - min) / range) * 100 : 50;
  });
}

// ── Fetch Data Once ─────────────────────────────────────

interface TickerData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
  allTradingDates: string[];
}

async function fetchTickerData(ticker: string): Promise<TickerData> {
  const candles: BacktestCandle[] = (await supabaseGet('stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`
  )).map(r => ({
    date: r.date, timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume,
  }));

  const ivData = await supabaseGet('orats_iv_cache',
    `select=date,iv30d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`);

  const ivByDate = new Map(ivData.map((r: any) => [r.date, r.iv30d]));
  const ivSeries = candles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRank(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));
  const allTradingDates = candles
    .filter(c => c.date >= OOS_START && c.date <= OOS_END)
    .map(c => c.date);

  return { ticker, candles, ivRanks, dateToIdx, allTradingDates };
}

// ── Generate Signals with Specific Options ──────────────

function generateSignals(
  td: TickerData,
  techOptions: TechScoreOptions,
  minScore: number,
  maxScore: number,
): EntrySignal[] {
  const { signals } = precomputeSignals(td.candles, '1D', techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    if (sig.date < OOS_START || sig.date > OOS_END) continue;
    if (sig.type === 'NEUTRAL') continue;
    if (sig.score < minScore || sig.score >= maxScore) continue;

    const idx = td.dateToIdx.get(sig.date);
    entries.push({
      ticker: td.ticker,
      date: sig.date,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
    });
  }
  return entries;
}

// ── Simulate ────────────────────────────────────────────

async function runCreditSim(
  allSignals: { entries: EntrySignal[]; allTradingDates: string[] }[],
  config: SimConfig,
  maxDate: string,
): Promise<OptionSimAnalytics> {
  const trades: OptionTrade[] = [];

  for (const ts of allSignals) {
    let exitDate: string | null = null;
    for (const signal of ts.entries) {
      if (exitDate && signal.date < exitDate) continue;
      exitDate = null;
      const trade = await simulateCreditSpread(
        ORATS_TOKEN, signal, config, ts.allTradingDates, maxDate,
      );
      if (trade) {
        trades.push(trade);
        exitDate = trade.exitDate;
      }
    }
  }

  return computeOptionAnalytics(trades);
}

async function runLeapSim(
  allSignals: { entries: EntrySignal[]; allTradingDates: string[] }[],
  config: SimConfig,
  maxDate: string,
): Promise<OptionSimAnalytics> {
  const trades: OptionTrade[] = [];

  for (const ts of allSignals) {
    let exitDate: string | null = null;
    for (const signal of ts.entries) {
      if (exitDate && signal.date < exitDate) continue;
      exitDate = null;
      const trade = await simulateLeap(
        ORATS_TOKEN, signal, config, ts.allTradingDates, maxDate,
      );
      if (trade) {
        trades.push(trade);
        exitDate = trade.exitDate;
      }
    }
  }

  return computeOptionAnalytics(trades);
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║   SIGNAL ABLATION TEST — Which features help vs hurt?                       ║');
  console.log('╠═══════════════════════════════════════════════════════════════════════════════╣');
  console.log('║   Period:  OOS 2024-04-01 → 2025-12-31                                     ║');
  console.log('║   Credit:  Tier A (80-89), TP 30%, No SL, IV ≥ 0                           ║');
  console.log('║   LEAP:    Tier A (80-89), default config                                   ║');
  console.log('║   Tickers: SPY, QQQ, AMD, IWM, TSLA, AAPL, JPM, NVDA, AMZN, MSFT          ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝\n');

  initDB();

  // Phase 1: Fetch all ticker data once
  console.log('  Phase 1: Fetching ticker data...');
  const tickerData: TickerData[] = [];
  for (const ticker of ALL_TICKERS) {
    const td = await fetchTickerData(ticker);
    tickerData.push(td);
    process.stdout.write(`    ${ticker}: ${td.candles.length} candles\n`);
  }

  const maxDate = OOS_END;

  // Phase 2: Run ablation for credit spreads (Tier A)
  console.log('\n  Phase 2: Credit Spread ablation (Tier A, TP30%, No SL)...\n');

  interface AblationResult {
    label: string;
    signalCount: number;
    analytics: OptionSimAnalytics;
  }

  const creditResults: AblationResult[] = [];

  for (const abl of ABLATIONS) {
    const t0 = Date.now();
    const allSignals: { entries: EntrySignal[]; allTradingDates: string[] }[] = [];
    let totalSignals = 0;

    for (const td of tickerData) {
      const entries = generateSignals(td, abl.options, 80, 90); // Tier A
      totalSignals += entries.length;
      allSignals.push({ entries, allTradingDates: td.allTradingDates });
    }

    const analytics = await runCreditSim(allSignals, CREDIT_CONFIG, maxDate);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    creditResults.push({ label: abl.label, signalCount: totalSignals, analytics });
    process.stdout.write(`    ${abl.label.padEnd(28)} ${totalSignals.toString().padStart(4)} sigs → ${analytics.totalTrades.toString().padStart(3)} trades, Sharpe ${analytics.sharpe.toFixed(2).padStart(5)} (${elapsed}s)\n`);
  }

  // Phase 3: Run ablation for LEAPs (Tier A)
  console.log('\n  Phase 3: LEAP ablation (Tier A, default config)...\n');

  const leapResults: AblationResult[] = [];

  for (const abl of ABLATIONS) {
    const t0 = Date.now();
    const allSignals: { entries: EntrySignal[]; allTradingDates: string[] }[] = [];
    let totalSignals = 0;

    for (const td of tickerData) {
      const entries = generateSignals(td, abl.options, 80, 90); // Tier A
      totalSignals += entries.length;
      allSignals.push({ entries, allTradingDates: td.allTradingDates });
    }

    const analytics = await runLeapSim(allSignals, DEFAULT_LEAP_CONFIG, maxDate);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    leapResults.push({ label: abl.label, signalCount: totalSignals, analytics });
    process.stdout.write(`    ${abl.label.padEnd(28)} ${totalSignals.toString().padStart(4)} sigs → ${analytics.totalTrades.toString().padStart(3)} trades, Sharpe ${analytics.sharpe.toFixed(2).padStart(5)} (${elapsed}s)\n`);
  }

  // Phase 4: Summary tables
  const baseline = creditResults[0];

  console.log('\n  ╔═══════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('  ║   CREDIT SPREAD ABLATION RESULTS (Tier A, OOS)                                                         ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════════════════════════════════════════════════╝');
  console.log('  ┌────────────────────────────────┬───────┬────────┬────────┬────────┬────────┬──────────┬──────────────────┐');
  console.log('  │ Signal Config                  │  Sigs │ Trades │  WR %  │ Sharpe │   PF   │  Tot P&L │ Sharpe Δ        │');
  console.log('  ├────────────────────────────────┼───────┼────────┼────────┼────────┼────────┼──────────┼──────────────────┤');

  for (const r of creditResults) {
    const a = r.analytics;
    const delta = a.sharpe - baseline.analytics.sharpe;
    const deltaStr = r === baseline ? '  (baseline)    '
      : delta > 0.05 ? ` ▲ +${delta.toFixed(2)} BETTER  `
      : delta < -0.05 ? ` ▼ ${delta.toFixed(2)} WORSE   `
      : `   ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ≈ same  `;

    console.log(`  │ ${r.label.padEnd(30)} │ ${r.signalCount.toString().padStart(5)} │  ${a.totalTrades.toString().padStart(4)} │ ${a.winRate.toFixed(1).padStart(5)}% │ ${a.sharpe.toFixed(2).padStart(5)} │ ${a.profitFactor.toFixed(2).padStart(5)} │ ${a.totalPnl >= 0 ? '+' : ''}$${(Math.abs(a.totalPnl) / 1000).toFixed(1)}k`.padEnd(10) + ` │${deltaStr}│`);
  }
  console.log('  └────────────────────────────────┴───────┴────────┴────────┴────────┴────────┴──────────┴──────────────────┘');

  // LEAP table
  const leapBaseline = leapResults[0];

  console.log('\n  ╔═══════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('  ║   LEAP ABLATION RESULTS (Tier A, OOS)                                                                  ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════════════════════════════════════════════════╝');
  console.log('  ┌────────────────────────────────┬───────┬────────┬────────┬────────┬────────┬──────────┬──────────────────┐');
  console.log('  │ Signal Config                  │  Sigs │ Trades │  WR %  │ Sharpe │   PF   │  Tot P&L │ Sharpe Δ        │');
  console.log('  ├────────────────────────────────┼───────┼────────┼────────┼────────┼────────┼──────────┼──────────────────┤');

  for (const r of leapResults) {
    const a = r.analytics;
    const delta = a.sharpe - leapBaseline.analytics.sharpe;
    const deltaStr = r === leapBaseline ? '  (baseline)    '
      : delta > 0.05 ? ` ▲ +${delta.toFixed(2)} BETTER  `
      : delta < -0.05 ? ` ▼ ${delta.toFixed(2)} WORSE   `
      : `   ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ≈ same  `;

    console.log(`  │ ${r.label.padEnd(30)} │ ${r.signalCount.toString().padStart(5)} │  ${a.totalTrades.toString().padStart(4)} │ ${a.winRate.toFixed(1).padStart(5)}% │ ${a.sharpe.toFixed(2).padStart(5)} │ ${a.profitFactor.toFixed(2).padStart(5)} │ ${a.totalPnl >= 0 ? '+' : ''}$${(Math.abs(a.totalPnl) / 1000).toFixed(1)}k`.padEnd(10) + ` │${deltaStr}│`);
  }
  console.log('  └────────────────────────────────┴───────┴────────┴────────┴────────┴────────┴──────────┴──────────────────┘');

  // Verdict
  console.log('\n  ═══ FEATURE IMPORTANCE (by Sharpe impact) ═══\n');

  const features = creditResults.slice(1, 8); // single-feature ablations
  const ranked = features.map(r => ({
    label: r.label,
    creditDelta: r.analytics.sharpe - baseline.analytics.sharpe,
    leapDelta: leapResults.find(l => l.label === r.label)!.analytics.sharpe - leapBaseline.analytics.sharpe,
  })).sort((a, b) => a.creditDelta - b.creditDelta); // worst impact first = most important

  console.log('  Removing feature → Sharpe change (negative = feature HELPS, positive = feature HURTS):');
  console.log('  ┌────────────────────────┬───────────────┬───────────────┬─────────────────────────────┐');
  console.log('  │ Removed Feature        │ Credit Δ      │ LEAP Δ        │ Verdict                     │');
  console.log('  ├────────────────────────┼───────────────┼───────────────┼─────────────────────────────┤');

  for (const f of ranked) {
    const cDir = f.creditDelta < -0.05 ? 'HELPS credit ' : f.creditDelta > 0.05 ? 'HURTS credit ' : 'neutral credit';
    const lDir = f.leapDelta < -0.05 ? 'HELPS LEAP' : f.leapDelta > 0.05 ? 'HURTS LEAP' : 'neutral LEAP';
    console.log(`  │ ${f.label.padEnd(22)} │ ${f.creditDelta >= 0 ? '+' : ''}${f.creditDelta.toFixed(2).padStart(6)}        │ ${f.leapDelta >= 0 ? '+' : ''}${f.leapDelta.toFixed(2).padStart(6)}        │ ${cDir} / ${lDir} │`);
  }
  console.log('  └────────────────────────┴───────────────┴───────────────┴─────────────────────────────┘');

  closeDB();
}

main().catch(e => { console.error(e); process.exit(1); });
