/**
 * Quick targeted test: High IV + wide SL combinations
 * Tests whether high IV (richer credit) + wide SL can outperform no SL
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
  simulateCreditSpread, computeOptionAnalytics,
  DEFAULT_CREDIT_CONFIG,
  type EntrySignal, type OptionTrade,
} from '../src/lib/backtest/option-sim';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';
const OOS_START = '2024-04-01';
const OOS_END = '2025-12-31';
const DATA_START = '2019-01-01';
const tickers = ['SPY', 'QQQ', 'AMD', 'IWM', 'TSLA'];

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  return res.json();
}

interface TickerSignals { ticker: string; entries: EntrySignal[]; allTradingDates: string[]; }

async function generateSignals(ticker: string): Promise<TickerSignals> {
  const candles: BacktestCandle[] = (await supabaseGet('stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${OOS_END}&order=date.asc&limit=5000`
  )).map(r => ({
    date: r.date, timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume,
  }));
  const ivData = await supabaseGet('orats_iv_cache',
    `select=date,iv30d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${OOS_END}&order=date.asc&limit=5000`);

  const ivByDate = new Map(ivData.map((r: any) => [r.date, r.iv30d]));
  const ivSeries = candles.map(c => ivByDate.get(c.date) ?? null);
  const WINDOW = 252;
  const ivRanks = ivSeries.map((v, i) => {
    if (i < WINDOW || v == null) return null;
    const w = ivSeries.slice(i - WINDOW, i + 1).filter(x => x != null) as number[];
    if (w.length < 100) return null;
    const min = Math.min(...w), max = Math.max(...w), range = max - min;
    return range > 0 ? ((v as number - min) / range) * 100 : 50;
  });
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  const { signals } = precomputeSignals(candles, '1D', {});
  const entries: EntrySignal[] = [];
  for (const sig of signals) {
    if (sig.date < OOS_START || sig.date > OOS_END) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 75) continue;
    const idx = dateToIdx.get(sig.date);
    entries.push({
      ticker, date: sig.date, direction: sig.type as 'CALL' | 'PUT',
      score: sig.score, ivRank: idx != null ? (ivRanks[idx] ?? undefined) : undefined,
    });
  }
  const allTradingDates = candles.filter(c => c.date >= OOS_START && c.date <= OOS_END).map(c => c.date);
  return { ticker, entries, allTradingDates };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   HIGH IV × STOP LOSS TEST — Finding the sweet spot            ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  initDB();

  console.log('  Generating signals...');
  const allSignals: TickerSignals[] = [];
  for (const ticker of tickers) {
    allSignals.push(await generateSignals(ticker));
  }

  const slMultiples = [1.5, 2.0, 3.0, 4.0, 5.0, 7.0, 10.0, 100]; // 100 = no SL
  const ivThresholds = [0, 30, 50];

  console.log('\n  TP=30% fixed. Testing IV rank × SL multiple.\n');
  console.log('  ┌─────────┬──────┬────────┬────────┬────────┬────────┬────────┬────────────┬────────┬───────────────────────────────┐');
  console.log('  │ IV Rank │ SL×  │ Trades │  WR %  │ Sharpe │   PF   │ Avg%   │  Total P&L │ ROC %  │ Exits (TP / SL / TS / EXP)    │');
  console.log('  ├─────────┼──────┼────────┼────────┼────────┼────────┼────────┼────────────┼────────┼───────────────────────────────┤');

  for (const ivMin of ivThresholds) {
    for (const sl of slMultiples) {
      const config = {
        ...DEFAULT_CREDIT_CONFIG,
        minIVRank: ivMin,
        creditProfitTarget: 0.30,
        creditStopLossMultiple: sl,
      };

      const trades: OptionTrade[] = [];
      for (const ts of allSignals) {
        let exitDate: string | null = null;
        for (const signal of ts.entries) {
          if (exitDate && signal.date < exitDate) continue;
          exitDate = null;
          const trade = await simulateCreditSpread(ORATS_TOKEN, signal, config, ts.allTradingDates, OOS_END);
          if (trade) { trades.push(trade); exitDate = trade.exitDate; }
        }
      }

      const a = computeOptionAnalytics(trades);
      const slLabel = sl >= 100 ? 'None' : `${sl.toFixed(1)}×`;
      const pnlStr = a.totalPnl >= 0 ? `+$${(a.totalPnl / 1000).toFixed(1)}k` : `-$${(Math.abs(a.totalPnl) / 1000).toFixed(1)}k`;
      const tp = a.byExit['PROFIT_TARGET'] || 0;
      const slE = a.byExit['STOP_LOSS'] || 0;
      const ts = a.byExit['TIME_STOP'] || 0;
      const ex = a.byExit['EXPIRATION'] || 0;
      const exits = `${tp} / ${slE} / ${ts} / ${ex}`;
      console.log(
        `  │  >${String(ivMin).padStart(3)}  │ ${slLabel.padStart(4)} │ ` +
        `${String(a.totalTrades).padStart(6)} │ ${a.winRate.toFixed(1).padStart(5)}% │ ` +
        `${a.sharpe.toFixed(2).padStart(6)} │ ${a.profitFactor.toFixed(2).padStart(6)} │ ` +
        `${a.avgPnlPct.toFixed(1).padStart(5)}% │ ${pnlStr.padStart(10)} │ ${a.returnOnCapital.toFixed(1).padStart(5)}% │ ${exits.padEnd(29)} │`
      );
    }
    if (ivMin < 50) {
      console.log('  ├─────────┼──────┼────────┼────────┼────────┼────────┼────────┼────────────┼────────┼───────────────────────────────┤');
    }
  }
  console.log('  └─────────┴──────┴────────┴────────┴────────┴────────┴────────┴────────────┴────────┴───────────────────────────────┘');

  closeDB();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
