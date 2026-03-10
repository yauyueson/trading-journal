/**
 * Head-to-head comparison: BASELINE vs CORE_ONLY signal
 * Runs specific configs on OOS with full metrics output.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  simulateCreditSpread, computeOptionAnalytics,
  DEFAULT_CREDIT_CONFIG,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionSimAnalytics,
} from '../src/lib/backtest/option-sim';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';

const DATA_START = '2019-01-01';
const OOS_START  = '2024-04-01';
const OOS_END    = '2025-12-31';
const DATA_END   = '2025-12-31';
const ALL_TICKERS = ['SPY','QQQ','AMD','IWM','TSLA','AAPL','JPM','NVDA','AMZN','MSFT'];

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

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

// ── Configs to test ────────────────────────────────────

interface TestConfig {
  label: string;
  minScore: number;
  maxScore: number;
  sim: SimConfig;
}

const CONFIGS: TestConfig[] = [
  {
    label: 'ALL, IV≥50, TP30%, No SL',
    minScore: 70, maxScore: 101,
    sim: { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.30, creditStopLossMultiple: 100, minIVRank: 50 },
  },
  {
    label: 'S, IV≥50, TP30%, No SL',
    minScore: 90, maxScore: 101,
    sim: { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.30, creditStopLossMultiple: 100, minIVRank: 50 },
  },
  {
    label: 'ALL, IV≥50, TP30%, 5× SL',
    minScore: 70, maxScore: 101,
    sim: { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.30, creditStopLossMultiple: 5.0, minIVRank: 50 },
  },
  {
    label: 'ALL, IV≥50, TP50%, No SL',
    minScore: 70, maxScore: 101,
    sim: { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.50, creditStopLossMultiple: 100, minIVRank: 50 },
  },
  {
    label: 'ALL, IV≥0, TP30%, No SL',
    minScore: 70, maxScore: 101,
    sim: { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.30, creditStopLossMultiple: 100, minIVRank: 0 },
  },
];

const SIGNAL_VARIANTS: { label: string; options: TechScoreOptions }[] = [
  { label: 'BASELINE', options: {} },
  { label: 'CORE_ONLY', options: { w_ema: 0, w_mom: 0, w_adx: 0, w_vol: 0 } },
];

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║   FULL METRICS COMPARISON: BASELINE vs CORE_ONLY (OOS)                      ║');
  console.log('║   Period: 2024-04-01 → 2025-12-31 | 10 tickers                              ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝\n');

  initDB();

  // Fetch all ticker data once
  console.log('  Loading ticker data...');
  const tickerData: {
    ticker: string;
    candles: BacktestCandle[];
    ivRanks: (number | null)[];
    dateToIdx: Map<string, number>;
    allTradingDates: string[];
  }[] = [];

  for (const ticker of ALL_TICKERS) {
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
    const allTradingDates = candles.filter(c => c.date >= OOS_START && c.date <= OOS_END).map(c => c.date);

    tickerData.push({ ticker, candles, ivRanks, dateToIdx, allTradingDates });
  }
  console.log('  Done.\n');

  // Run each config × each signal variant
  interface FullResult {
    signalLabel: string;
    configLabel: string;
    analytics: OptionSimAnalytics;
    trades: OptionTrade[];
  }

  const results: FullResult[] = [];

  for (const variant of SIGNAL_VARIANTS) {
    // Generate signals once per variant
    const allSignals: { entries: EntrySignal[]; allTradingDates: string[] }[] = [];

    for (const td of tickerData) {
      const { signals } = precomputeSignals(td.candles, '1D', variant.options);
      const entries: EntrySignal[] = [];
      for (const sig of signals) {
        if (sig.date < OOS_START || sig.date > OOS_END) continue;
        if (sig.type === 'NEUTRAL' || sig.score < 70) continue;
        const idx = td.dateToIdx.get(sig.date);
        entries.push({
          ticker: td.ticker,
          date: sig.date,
          direction: sig.type as 'CALL' | 'PUT',
          score: sig.score,
          ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
        });
      }
      allSignals.push({ entries, allTradingDates: td.allTradingDates });
    }

    for (const cfg of CONFIGS) {
      const t0 = Date.now();
      const trades: OptionTrade[] = [];

      for (const ts of allSignals) {
        const filtered = ts.entries.filter(e => e.score >= cfg.minScore && e.score < cfg.maxScore);
        let exitDate: string | null = null;
        for (const signal of filtered) {
          if (exitDate && signal.date < exitDate) continue;
          exitDate = null;
          const trade = await simulateCreditSpread(ORATS_TOKEN, signal, cfg.sim, ts.allTradingDates, OOS_END);
          if (trade) {
            trades.push(trade);
            exitDate = trade.exitDate;
          }
        }
      }

      const analytics = computeOptionAnalytics(trades);
      results.push({ signalLabel: variant.label, configLabel: cfg.label, analytics, trades });

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`    ${variant.label.padEnd(12)} ${cfg.label.padEnd(30)} → ${analytics.totalTrades} trades (${elapsed}s)\n`);
    }
  }

  // ── Display ───────────────────────────────────────────

  function fmtPnl(pnl: number): string {
    return pnl >= 0 ? `+$${(pnl / 1000).toFixed(1)}k` : `-$${(Math.abs(pnl) / 1000).toFixed(1)}k`;
  }

  function fmtDollar(pnl: number): string {
    return pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
  }

  console.log('\n');

  for (const cfg of CONFIGS) {
    const baseline = results.find(r => r.signalLabel === 'BASELINE' && r.configLabel === cfg.label)!;
    const core = results.find(r => r.signalLabel === 'CORE_ONLY' && r.configLabel === cfg.label)!;
    const bA = baseline.analytics;
    const cA = core.analytics;

    console.log(`  ╔══════════════════════════════════════════════════════════════════╗`);
    console.log(`  ║  ${cfg.label.padEnd(62)} ║`);
    console.log(`  ╠══════════════════════════════════════════════════════════════════╣`);
    console.log(`  ║  Metric               │  BASELINE     │  CORE_ONLY    │ Winner  ║`);
    console.log(`  ╟───────────────────────┼───────────────┼───────────────┼─────────╢`);

    const metrics: { label: string; bVal: string; cVal: string; bNum: number; cNum: number; higherBetter: boolean }[] = [
      { label: 'Trades',          bVal: `${bA.totalTrades}`,                    cVal: `${cA.totalTrades}`,                    bNum: bA.totalTrades,          cNum: cA.totalTrades,          higherBetter: true },
      { label: 'Win Rate',        bVal: `${bA.winRate.toFixed(1)}%`,            cVal: `${cA.winRate.toFixed(1)}%`,            bNum: bA.winRate,              cNum: cA.winRate,              higherBetter: true },
      { label: 'Sharpe',          bVal: `${bA.sharpe.toFixed(2)}`,              cVal: `${cA.sharpe.toFixed(2)}`,              bNum: bA.sharpe,               cNum: cA.sharpe,               higherBetter: true },
      { label: 'Profit Factor',   bVal: `${bA.profitFactor.toFixed(2)}`,        cVal: `${cA.profitFactor.toFixed(2)}`,        bNum: bA.profitFactor,         cNum: cA.profitFactor,         higherBetter: true },
      { label: 'Total P&L',       bVal: fmtPnl(bA.totalPnl),                   cVal: fmtPnl(cA.totalPnl),                   bNum: bA.totalPnl,             cNum: cA.totalPnl,             higherBetter: true },
      { label: 'Avg P&L %',       bVal: `${bA.avgPnlPct.toFixed(1)}%`,         cVal: `${cA.avgPnlPct.toFixed(1)}%`,         bNum: bA.avgPnlPct,            cNum: cA.avgPnlPct,            higherBetter: true },
      { label: 'ROC %',           bVal: `${bA.returnOnCapital.toFixed(1)}%`,    cVal: `${cA.returnOnCapital.toFixed(1)}%`,    bNum: bA.returnOnCapital,      cNum: cA.returnOnCapital,      higherBetter: true },
      { label: 'Max Drawdown',    bVal: `${bA.maxDrawdown.toFixed(1)}%`,        cVal: `${cA.maxDrawdown.toFixed(1)}%`,        bNum: bA.maxDrawdown,          cNum: cA.maxDrawdown,          higherBetter: false },
      { label: 'Avg Hold Days',   bVal: `${bA.avgHoldDays.toFixed(0)}`,         cVal: `${cA.avgHoldDays.toFixed(0)}`,         bNum: bA.avgHoldDays,          cNum: cA.avgHoldDays,          higherBetter: false },
      { label: 'Avg Entry Delta', bVal: `${bA.avgEntryDelta.toFixed(2)}`,       cVal: `${cA.avgEntryDelta.toFixed(2)}`,       bNum: 0,                       cNum: 0,                       higherBetter: false },
      { label: 'Avg Entry DTE',   bVal: `${bA.avgEntryDTE.toFixed(0)}`,         cVal: `${cA.avgEntryDTE.toFixed(0)}`,         bNum: 0,                       cNum: 0,                       higherBetter: false },
      { label: 'Avg $/trade',     bVal: fmtDollar(bA.totalTrades > 0 ? bA.totalPnl / bA.totalTrades : 0),
                                   cVal: fmtDollar(cA.totalTrades > 0 ? cA.totalPnl / cA.totalTrades : 0),
                                   bNum: bA.totalTrades > 0 ? bA.totalPnl / bA.totalTrades : 0,
                                   cNum: cA.totalTrades > 0 ? cA.totalPnl / cA.totalTrades : 0,
                                   higherBetter: true },
      { label: 'Capital/trade',   bVal: `$${bA.avgCapitalPerTrade.toFixed(0)}`, cVal: `$${cA.avgCapitalPerTrade.toFixed(0)}`, bNum: 0,                       cNum: 0,                       higherBetter: false },
    ];

    for (const m of metrics) {
      const diff = m.cNum - m.bNum;
      let winner = '  —    ';
      if (m.label === 'Avg Entry Delta' || m.label === 'Avg Entry DTE' || m.label === 'Capital/trade') {
        winner = '  —    ';
      } else if (m.higherBetter) {
        winner = diff > 0.001 ? ' CORE  ' : diff < -0.001 ? ' BASE  ' : '  TIE  ';
      } else {
        winner = diff < -0.001 ? ' CORE  ' : diff > 0.001 ? ' BASE  ' : '  TIE  ';
      }
      console.log(`  ║  ${m.label.padEnd(21)} │ ${m.bVal.padStart(13)} │ ${m.cVal.padStart(13)} │${winner} ║`);
    }

    console.log(`  ╚══════════════════════════════════════════════════════════════════╝`);

    // Exit type breakdown
    console.log(`    Exit breakdown:`);
    const exits = ['PROFIT_TARGET', 'STOP_LOSS', 'TIME_STOP', 'EXPIRATION'];
    for (const ex of exits) {
      const bCount = bA.byExit[ex] || 0;
      const cCount = cA.byExit[ex] || 0;
      const bPct = bA.totalTrades > 0 ? (bCount / bA.totalTrades * 100).toFixed(0) : '0';
      const cPct = cA.totalTrades > 0 ? (cCount / cA.totalTrades * 100).toFixed(0) : '0';
      console.log(`      ${ex.padEnd(16)} BASE: ${String(bCount).padStart(3)} (${bPct.padStart(2)}%)   CORE: ${String(cCount).padStart(3)} (${cPct.padStart(2)}%)`);
    }
    console.log('');
  }

  // Summary scoreboard
  console.log('  ═══ SCOREBOARD: Wins per metric across all 5 configs ═══\n');
  let baseWins = 0, coreWins = 0, ties = 0;
  const metricNames = ['Trades', 'Win Rate', 'Sharpe', 'Profit Factor', 'Total P&L', 'Avg P&L %', 'ROC %', 'Max Drawdown'];

  for (const cfg of CONFIGS) {
    const bA = results.find(r => r.signalLabel === 'BASELINE' && r.configLabel === cfg.label)!.analytics;
    const cA = results.find(r => r.signalLabel === 'CORE_ONLY' && r.configLabel === cfg.label)!.analytics;

    const comparisons = [
      { b: bA.totalTrades, c: cA.totalTrades, higher: true },
      { b: bA.winRate, c: cA.winRate, higher: true },
      { b: bA.sharpe, c: cA.sharpe, higher: true },
      { b: bA.profitFactor, c: cA.profitFactor, higher: true },
      { b: bA.totalPnl, c: cA.totalPnl, higher: true },
      { b: bA.avgPnlPct, c: cA.avgPnlPct, higher: true },
      { b: bA.returnOnCapital, c: cA.returnOnCapital, higher: true },
      { b: bA.maxDrawdown, c: cA.maxDrawdown, higher: false },
    ];

    for (const comp of comparisons) {
      const diff = comp.c - comp.b;
      if (comp.higher ? diff > 0.01 : diff < -0.01) coreWins++;
      else if (comp.higher ? diff < -0.01 : diff > 0.01) baseWins++;
      else ties++;
    }
  }

  console.log(`    BASELINE wins:   ${baseWins} / ${baseWins + coreWins + ties}`);
  console.log(`    CORE_ONLY wins:  ${coreWins} / ${baseWins + coreWins + ties}`);
  console.log(`    Ties:            ${ties} / ${baseWins + coreWins + ties}`);

  closeDB();
}

main().catch(e => { console.error(e); process.exit(1); });
