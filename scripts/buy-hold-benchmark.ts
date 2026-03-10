/**
 * Buy-and-hold benchmark for OOS period comparison.
 * Computes Sharpe, return, maxDD for each ticker and equal-weight portfolio.
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

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const OOS_START = '2024-04-01';
const OOS_END = '2025-12-31';
const tickers = ['SPY','QQQ','AAPL','MSFT','NVDA','AMZN','META','TSLA','AMD','COST','BA','NFLX','JPM','AVGO'];

async function fetchCandles(ticker: string) {
  const params = new URLSearchParams({
    select: 'date,close', ticker: `eq.${ticker}`, timeframe: 'eq.1D',
    order: 'date.asc', limit: '5000',
  });
  params.set('date', `gte.${OOS_START}`);
  params.append('date', `lte.${OOS_END}`);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/stock_candles?${params}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  return (await res.json()) as { date: string; close: number }[];
}

function computeMaxDD(prices: number[]): number {
  let peak = prices[0], maxDD = 0;
  for (const p of prices) { peak = Math.max(peak, p); maxDD = Math.max(maxDD, (peak - p) / peak * 100); }
  return maxDD;
}

async function main() {
  console.log(`\nBuy-and-Hold Benchmark (OOS: ${OOS_START} → ${OOS_END})`);
  console.log('═'.repeat(80));

  const allTickerData: { ticker: string; rows: { date: string; close: number }[] }[] = [];

  for (const ticker of tickers) {
    const rows = await fetchCandles(ticker);
    if (rows.length < 50) { console.log(`  ${ticker}: skipped (${rows.length} rows)`); continue; }
    allTickerData.push({ ticker, rows });

    const closes = rows.map(r => Number(r.close));
    const dailyReturns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
    const totalReturn = (closes[closes.length - 1] - closes[0]) / closes[0] * 100;
    const avg = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
    const std = Math.sqrt(dailyReturns.reduce((s, v) => s + (v - avg) ** 2, 0) / (dailyReturns.length - 1));
    const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;
    const maxDD = computeMaxDD(closes);

    console.log(
      `  ${ticker.padEnd(6)} Return: ${totalReturn.toFixed(1).padStart(7)}%  Sharpe: ${sharpe.toFixed(2).padStart(6)}  MaxDD: ${maxDD.toFixed(1).padStart(5)}%  (${rows.length} days)`
    );
  }

  // Equal-weight portfolio
  const dateMap = new Map<string, number[]>();
  for (const { rows } of allTickerData) {
    for (let i = 1; i < rows.length; i++) {
      const date = rows[i].date;
      const ret = (Number(rows[i].close) - Number(rows[i - 1].close)) / Number(rows[i - 1].close);
      if (!dateMap.has(date)) dateMap.set(date, []);
      dateMap.get(date)!.push(ret);
    }
  }

  const dates = Array.from(dateMap.keys()).sort();
  const portfolioReturns = dates.map(d => {
    const rets = dateMap.get(d)!;
    return rets.reduce((s, v) => s + v, 0) / rets.length;
  });

  const avgPort = portfolioReturns.reduce((s, v) => s + v, 0) / portfolioReturns.length;
  const stdPort = Math.sqrt(portfolioReturns.reduce((s, v) => s + (v - avgPort) ** 2, 0) / (portfolioReturns.length - 1));
  const portSharpe = stdPort > 0 ? (avgPort / stdPort) * Math.sqrt(252) : 0;
  const portEquity = portfolioReturns.reduce((cum, r) => cum * (1 + r), 1);
  const portReturn = (portEquity - 1) * 100;

  let peak = 1, maxDD = 0, equity = 1;
  for (const r of portfolioReturns) {
    equity *= (1 + r); peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak * 100);
  }

  console.log('═'.repeat(80));
  console.log(`  EW Portfolio  Return: ${portReturn.toFixed(1).padStart(7)}%  Sharpe: ${portSharpe.toFixed(2).padStart(6)}  MaxDD: ${maxDD.toFixed(1).padStart(5)}%`);
  console.log('');
  console.log('═'.repeat(80));
  console.log('  COMPARISON');
  console.log('═'.repeat(80));
  console.log(`  Buy & Hold (EW 14 tickers):   Sharpe ${portSharpe.toFixed(2)}, Return ${portReturn.toFixed(1)}%, MaxDD ${maxDD.toFixed(1)}%`);
  console.log(`  Signal Strategy (Test E):      Sharpe 0.58, WR 53.4%, PF 1.30, 558 trades`);
  console.log(`  SPY Buy & Hold:                see above`);
  console.log('');
  if (portSharpe > 0.58) {
    console.log(`  ⚠ Buy-and-hold BEATS the signal strategy by ${(portSharpe - 0.58).toFixed(2)} Sharpe`);
  } else {
    console.log(`  ✓ Signal strategy beats buy-and-hold by ${(0.58 - portSharpe).toFixed(2)} Sharpe`);
  }
  console.log('');
  console.log('  NOTE: Signal strategy is NOT always in market (558 trades, ~21 day holds)');
  console.log('  Time in market ≈ ' + Math.round(558 * 21 / 14 / dates.length * 100) + '% vs 100% for buy-and-hold');
}

main().catch(console.error);
