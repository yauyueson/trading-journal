import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'option-chains.sqlite');
const db = new Database(DB_PATH, { readonly: true });

const TICKERS = ['SPY','QQQ','AMD','IWM','TSLA','AAPL','JPM','NVDA','AMZN','MSFT'];
const OOS_START = '2024-04-01';
const OOS_END   = '2025-12-31';

const stmt = db.prepare(`
  SELECT DISTINCT ticker, trade_date, stock_price
  FROM option_chains
  WHERE ticker = ? AND trade_date BETWEEN ? AND ?
  ORDER BY trade_date
`);

const allDailyReturns = new Map<string, number[]>();
const tickerStats: { ticker: string; totalRet: number; days: number }[] = [];

for (const ticker of TICKERS) {
  const rows = stmt.all(ticker, OOS_START, OOS_END) as { ticker: string; trade_date: string; stock_price: number }[];
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.trade_date, r.stock_price);
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) continue;

  let cumReturn = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = byDate.get(dates[i - 1])!;
    const curr = byDate.get(dates[i])!;
    let ret = (curr - prev) / prev;
    
    // Detect stock splits: if price drops >40% in one day, it's a split
    // Adjust by finding the split ratio (nearest integer)
    if (ret < -0.4) {
      const ratio = Math.round(prev / curr);
      if (ratio >= 2) {
        ret = (curr * ratio - prev) / prev; // split-adjusted return
      }
    }
    
    cumReturn *= (1 + ret);
    if (!allDailyReturns.has(dates[i])) allDailyReturns.set(dates[i], []);
    allDailyReturns.get(dates[i])!.push(ret);
  }
  
  tickerStats.push({ ticker, totalRet: cumReturn - 1, days: dates.length });
}

// Equal-weight portfolio
const sortedDates = [...allDailyReturns.keys()].sort();
const portfolioReturns: number[] = [];
for (const d of sortedDates) {
  const rets = allDailyReturns.get(d)!;
  portfolioReturns.push(rets.reduce((a, b) => a + b, 0) / rets.length);
}

const mean = portfolioReturns.reduce((a, b) => a + b, 0) / portfolioReturns.length;
const std = Math.sqrt(portfolioReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (portfolioReturns.length - 1));
const sharpe = (mean / std) * Math.sqrt(252);
const totalReturn = portfolioReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;
const annualized = (Math.pow(1 + totalReturn, 252 / sortedDates.length) - 1);

let peak = 1, maxDD = 0, equity = 1;
for (const r of portfolioReturns) {
  equity *= (1 + r);
  if (equity > peak) peak = equity;
  const dd = (peak - equity) / peak;
  if (dd > maxDD) maxDD = dd;
}

const winRate = portfolioReturns.filter(r => r > 0).length / portfolioReturns.length;

console.log('\n  ═══ BUY & HOLD BENCHMARK (Split-Adjusted, Equal-Weight) ═══');
console.log(`  Period: ${OOS_START} → ${sortedDates[sortedDates.length-1]} (${sortedDates.length} trading days)\n`);

console.log('  Per-Ticker Total Return (split-adjusted):');
tickerStats.sort((a, b) => b.totalRet - a.totalRet);
for (const t of tickerStats) {
  const bar = '█'.repeat(Math.max(0, Math.min(40, Math.round(t.totalRet * 20))));
  console.log(`    ${t.ticker.padEnd(5)} ${(t.totalRet * 100).toFixed(1).padStart(7)}%  ${bar}`);
}

console.log('\n  ═══ HEAD-TO-HEAD COMPARISON ═══\n');
console.log('  ┌────────────────────────────────────┬────────┬────────┬──────────┬────────┐');
console.log('  │ Strategy                            │ Sharpe │  WR %  │  Max DD  │ Return │');
console.log('  ├────────────────────────────────────┼────────┼────────┼──────────┼────────┤');
console.log(`  │ Buy & Hold (10-stock EW)            │  ${sharpe.toFixed(2).padStart(5)} │ ${(winRate*100).toFixed(1).padStart(5)}% │  ${(maxDD*100).toFixed(1).padStart(5)}% │ ${(annualized*100).toFixed(1).padStart(5)}% │`);
console.log('  ├────────────────────────────────────┼────────┼────────┼──────────┼────────┤');

// Credit spread configs (OOS results from sweep)
const configs = [
  { name: '#1  A, IV≥0, TP30%, No SL       ', sharpe: 0.83, wr: 87.4, pnl: 5200, maxRisk: 500 * 15 }, // ~15 concurrent
  { name: '#2  ALL, IV≥50, TP30%, No SL     ', sharpe: 0.81, wr: 86.7, pnl: 3000, maxRisk: 500 * 8 },
  { name: '#3  ALL, IV≥50, TP30%, 5× SL     ', sharpe: 0.67, wr: 86.0, pnl: 2600, maxRisk: 500 * 8 },
  { name: '#4  S, IV≥50, TP30%, No SL       ', sharpe: 0.66, wr: 86.7, pnl: 2000, maxRisk: 500 * 6 },
  { name: '#5  ALL, IV≥50, TP50%, No SL     ', sharpe: 0.60, wr: 80.0, pnl: 2200, maxRisk: 500 * 6 },
];

for (const c of configs) {
  // ROC = P&L / max capital at risk (rough estimate)
  const roc = (c.pnl / c.maxRisk) * 100 / 1.75; // annualize over 1.75yr OOS
  console.log(`  │ Credit: ${c.name}│  ${c.sharpe.toFixed(2).padStart(5)} │ ${c.wr.toFixed(1).padStart(5)}% │  capped │ ${roc.toFixed(1).padStart(5)}% │`);
}
console.log('  └────────────────────────────────────┴────────┴────────┴──────────┴────────┘');
console.log('  * Credit spread max DD is capped by design (defined risk: $500/trade)');
console.log('  * Return = annualized ROC on deployed capital\n');

console.log('  ═══ VERDICT ═══');
console.log(`    Buy & Hold Sharpe:            ${sharpe.toFixed(2)}`);
console.log(`    Best Credit Spread Sharpe:    0.83  (Tier A, TP30%, No SL)`);
if (sharpe > 0.83) {
  console.log(`    → Buy & Hold wins on risk-adjusted returns by ${((sharpe - 0.83) / sharpe * 100).toFixed(0)}%`);
} else {
  console.log(`    → Credit Spreads slightly trail but with MUCH less capital at risk`);
}
console.log(`    Buy & Hold max DD:            ${(maxDD*100).toFixed(1)}%`);
console.log(`    Credit Spread max DD:         Capped at ~$500 per trade (defined risk)`);
console.log(`    Buy & Hold capital needed:    ~$100k (10 stocks)`);
console.log(`    Credit Spread capital needed: ~$5-8k (concurrent positions)\n`);

db.close();
