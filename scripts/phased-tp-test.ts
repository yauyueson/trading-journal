/**
 * Phased Take-Profit Test — compares fixed TP vs phased TP strategies
 *
 * Tests:
 *   1. Fixed TP 30% (current best)
 *   2. Phased: TP1=30% half + TP2=50% rest, SL→breakeven
 *   3. Phased: TP1=30% half + TP2=75% rest, SL→breakeven
 *   4. Phased: TP1=50% half + TP2=75% rest, SL→breakeven
 *   5. Fixed TP 50% (comparison)
 *
 * Signal: CORE_ONLY | ALL tier (≥70) | IV≥50 | No SL | OOS period
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
import { precomputeSignals } from '../src/lib/backtest/engine';
import { initDB, closeDB } from '../src/lib/backtest/chain-cache';
import {
  simulateCreditSpread, simulateCreditSpreadPhased, computeOptionAnalytics,
  DEFAULT_CREDIT_CONFIG,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionSimAnalytics, type PhasedTPConfig,
} from '../src/lib/backtest/option-sim';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';

const DATA_START = '2019-01-01';
const OOS_START  = '2024-04-01';
const OOS_END    = '2025-12-31';
const DATA_END   = '2025-12-31';
const ALL_TICKERS = ['SPY','QQQ','AMD','IWM','TSLA','AAPL','JPM','NVDA','AMZN','MSFT'];

// CORE_ONLY signal
const CORE_ONLY_OPTIONS = { w_ema: 0, w_mom: 0, w_adx: 0, w_vol: 0 };

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

// ── Strategy Definitions ─────────────────────────────────

interface StrategyDef {
  label: string;
  type: 'fixed' | 'phased';
  sim: SimConfig;
  phased?: PhasedTPConfig;
}

const BASE_SIM: SimConfig = {
  ...DEFAULT_CREDIT_CONFIG,
  creditStopLossMultiple: 100,  // No SL
  minIVRank: 50,
};

const STRATEGIES: StrategyDef[] = [
  {
    label: 'Fixed TP 30%',
    type: 'fixed',
    sim: { ...BASE_SIM, creditProfitTarget: 0.30 },
  },
  {
    label: 'Phased 30%→50%, SL→BE',
    type: 'phased',
    sim: { ...BASE_SIM, creditProfitTarget: 0.30, creditStopLossMultiple: 100 },
    phased: { tp1: 0.30, tp2: 0.50, beSLAfterTP1: true },
  },
  {
    label: 'Phased 30%→75%, SL→BE',
    type: 'phased',
    sim: { ...BASE_SIM, creditProfitTarget: 0.30, creditStopLossMultiple: 100 },
    phased: { tp1: 0.30, tp2: 0.75, beSLAfterTP1: true },
  },
  {
    label: 'Phased 50%→75%, SL→BE',
    type: 'phased',
    sim: { ...BASE_SIM, creditProfitTarget: 0.50, creditStopLossMultiple: 100 },
    phased: { tp1: 0.50, tp2: 0.75, beSLAfterTP1: true },
  },
  {
    label: 'Fixed TP 50%',
    type: 'fixed',
    sim: { ...BASE_SIM, creditProfitTarget: 0.50 },
  },
];

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║   PHASED TAKE-PROFIT TEST: Fixed vs Phased TP Strategies                    ║');
  console.log('║   Signal: CORE_ONLY | ALL tier | IV≥50 | OOS: 2024-04 → 2025-12             ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝\n');

  initDB();

  // Load ticker data
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
  console.log(`  Loaded ${tickerData.length} tickers.\n`);

  // Generate signals (CORE_ONLY, ALL tier ≥70)
  console.log('  Generating CORE_ONLY signals...');
  const allSignals: { entries: EntrySignal[]; allTradingDates: string[] }[] = [];

  for (const td of tickerData) {
    const { signals } = precomputeSignals(td.candles, '1D', CORE_ONLY_OPTIONS);
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

  const totalSignals = allSignals.reduce((s, ts) => s + ts.entries.length, 0);
  console.log(`  ${totalSignals} signals generated.\n`);

  // Run each strategy
  interface StratResult {
    label: string;
    analytics: OptionSimAnalytics;
    trades: OptionTrade[];
  }

  const results: StratResult[] = [];

  for (const strat of STRATEGIES) {
    const t0 = Date.now();
    const trades: OptionTrade[] = [];

    for (const ts of allSignals) {
      const filtered = ts.entries.filter(e => e.score >= 70);
      let exitDate: string | null = null;

      for (const signal of filtered) {
        if (exitDate && signal.date < exitDate) continue;
        exitDate = null;

        let trade: OptionTrade | null;
        if (strat.type === 'phased' && strat.phased) {
          trade = await simulateCreditSpreadPhased(
            ORATS_TOKEN, signal, strat.sim, strat.phased,
            ts.allTradingDates, OOS_END,
          );
        } else {
          trade = await simulateCreditSpread(
            ORATS_TOKEN, signal, strat.sim, ts.allTradingDates, OOS_END,
          );
        }

        if (trade) {
          trades.push(trade);
          exitDate = trade.exitDate;
        }
      }
    }

    const analytics = computeOptionAnalytics(trades);
    results.push({ label: strat.label, analytics, trades });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`    ${strat.label.padEnd(30)} → ${analytics.totalTrades} trades (${elapsed}s)`);
  }

  // ── Display Results ────────────────────────────────────

  function fmtPnl(pnl: number): string {
    return pnl >= 0 ? `+$${(pnl / 1000).toFixed(1)}k` : `-$${(Math.abs(pnl) / 1000).toFixed(1)}k`;
  }

  function fmtDollar(v: number): string {
    return v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`;
  }

  console.log('\n');
  console.log('  ╔═══════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('  ║  STRATEGY COMPARISON                                                                                    ║');
  console.log('  ╠═══════════════════════════════════════════════════════════════════════════════════════════════════════════╣');

  // Header row
  const colW = 18;
  let header = '  ║  Metric               │';
  for (const r of results) {
    header += ` ${r.label.substring(0, colW).padStart(colW)} │`;
  }
  // Trim trailing │ and close
  header = header.slice(0, -1) + '║';
  console.log(header);

  let sep = '  ╟───────────────────────┼';
  for (let i = 0; i < results.length; i++) {
    sep += '──────────────────' + (i < results.length - 1 ? '──┼' : '──╢');
  }
  console.log(sep);

  // Metric rows
  interface MetricRow {
    label: string;
    values: string[];
    nums: number[];
    higherBetter: boolean;
  }

  const metrics: MetricRow[] = [
    {
      label: 'Trades',
      values: results.map(r => `${r.analytics.totalTrades}`),
      nums: results.map(r => r.analytics.totalTrades),
      higherBetter: true,
    },
    {
      label: 'Win Rate',
      values: results.map(r => `${r.analytics.winRate.toFixed(1)}%`),
      nums: results.map(r => r.analytics.winRate),
      higherBetter: true,
    },
    {
      label: 'Sharpe',
      values: results.map(r => `${r.analytics.sharpe.toFixed(2)}`),
      nums: results.map(r => r.analytics.sharpe),
      higherBetter: true,
    },
    {
      label: 'Profit Factor',
      values: results.map(r => `${r.analytics.profitFactor.toFixed(2)}`),
      nums: results.map(r => r.analytics.profitFactor),
      higherBetter: true,
    },
    {
      label: 'Total P&L',
      values: results.map(r => fmtPnl(r.analytics.totalPnl)),
      nums: results.map(r => r.analytics.totalPnl),
      higherBetter: true,
    },
    {
      label: 'Avg P&L %',
      values: results.map(r => `${r.analytics.avgPnlPct.toFixed(1)}%`),
      nums: results.map(r => r.analytics.avgPnlPct),
      higherBetter: true,
    },
    {
      label: 'ROC %',
      values: results.map(r => `${r.analytics.returnOnCapital.toFixed(1)}%`),
      nums: results.map(r => r.analytics.returnOnCapital),
      higherBetter: true,
    },
    {
      label: 'Max Drawdown',
      values: results.map(r => `${r.analytics.maxDrawdown.toFixed(1)}%`),
      nums: results.map(r => r.analytics.maxDrawdown),
      higherBetter: false,
    },
    {
      label: 'Avg Hold Days',
      values: results.map(r => `${r.analytics.avgHoldDays.toFixed(0)}`),
      nums: results.map(r => r.analytics.avgHoldDays),
      higherBetter: false,
    },
    {
      label: 'Avg $/trade',
      values: results.map(r => fmtDollar(r.analytics.totalTrades > 0 ? r.analytics.totalPnl / r.analytics.totalTrades : 0)),
      nums: results.map(r => r.analytics.totalTrades > 0 ? r.analytics.totalPnl / r.analytics.totalTrades : 0),
      higherBetter: true,
    },
    {
      label: 'Capital/trade',
      values: results.map(r => `$${r.analytics.avgCapitalPerTrade.toFixed(0)}`),
      nums: results.map(r => 0),
      higherBetter: false,
    },
    {
      label: 'Avg Entry Delta',
      values: results.map(r => `${r.analytics.avgEntryDelta.toFixed(2)}`),
      nums: results.map(r => 0),
      higherBetter: false,
    },
    {
      label: 'Avg Entry DTE',
      values: results.map(r => `${r.analytics.avgEntryDTE.toFixed(0)}`),
      nums: results.map(r => 0),
      higherBetter: false,
    },
  ];

  for (const m of metrics) {
    // Find best
    let bestIdx = -1;
    if (m.nums.some(n => n !== 0)) {
      bestIdx = m.higherBetter
        ? m.nums.indexOf(Math.max(...m.nums))
        : m.nums.indexOf(Math.min(...m.nums.filter(n => n > 0)));
    }

    let row = `  ║  ${m.label.padEnd(21)} │`;
    for (let i = 0; i < results.length; i++) {
      const val = m.values[i].padStart(colW);
      const marker = (i === bestIdx && m.nums.some(n => n !== 0)) ? '*' : ' ';
      row += ` ${val}${marker}│`;
    }
    row = row.slice(0, -1) + '║';
    console.log(row);
  }

  let bottom = '  ╚═══════════════════════════════╧';
  for (let i = 0; i < results.length - 1; i++) {
    bottom += '════════════════════╧';
  }
  bottom += '════════════════════╝';
  console.log(bottom);
  console.log('  (* = best in row)\n');

  // Exit type breakdown
  console.log('  EXIT TYPE BREAKDOWN:');
  const exitTypes = ['PROFIT_TARGET', 'PROFIT_TARGET_2', 'SL_BREAKEVEN', 'STOP_LOSS', 'TIME_STOP', 'EXPIRATION'];

  let exitHeader = '    Exit Type          │';
  for (const r of results) {
    exitHeader += ` ${r.label.substring(0, 16).padStart(16)} │`;
  }
  console.log(exitHeader);
  console.log('    ───────────────────┼' + results.map(() => '──────────────────┼').join('').slice(0, -1) + '┤');

  for (const ex of exitTypes) {
    let row = `    ${ex.padEnd(21)} │`;
    for (const r of results) {
      const count = r.analytics.byExit[ex] || 0;
      const pct = r.analytics.totalTrades > 0 ? (count / r.analytics.totalTrades * 100).toFixed(0) : '0';
      row += ` ${String(count).padStart(4)} (${pct.padStart(2)}%)       │`;
    }
    console.log(row);
  }

  console.log('');

  // Per-ticker breakdown for top 2 strategies
  const sorted = [...results].sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
  console.log(`  PER-TICKER BREAKDOWN (top strategy: ${sorted[0].label}):`);
  console.log('');

  for (const top of sorted.slice(0, 2)) {
    console.log(`    ${top.label}:`);
    const byTicker = new Map<string, OptionTrade[]>();
    for (const t of top.trades) {
      if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
      byTicker.get(t.ticker)!.push(t);
    }

    console.log(`      ${'Ticker'.padEnd(8)} ${'#'.padStart(4)}  ${'WR%'.padStart(6)}  ${'Sharpe'.padStart(7)}  ${'P&L'.padStart(10)}  ${'Avg P&L%'.padStart(9)}`);
    for (const ticker of ALL_TICKERS) {
      const tTrades = byTicker.get(ticker) || [];
      if (tTrades.length === 0) {
        console.log(`      ${ticker.padEnd(8)} ${String(0).padStart(4)}`);
        continue;
      }
      const a = computeOptionAnalytics(tTrades);
      console.log(`      ${ticker.padEnd(8)} ${String(a.totalTrades).padStart(4)}  ${a.winRate.toFixed(1).padStart(6)}  ${a.sharpe.toFixed(2).padStart(7)}  ${fmtPnl(a.totalPnl).padStart(10)}  ${a.avgPnlPct.toFixed(1).padStart(8)}%`);
    }
    console.log('');
  }

  closeDB();
}

main().catch(e => { console.error(e); process.exit(1); });
