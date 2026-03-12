const d = require('../data/wfa-results.json');
const byTicker = {};
d.allOOSTrades.forEach(t => {
  const tk = t.ticker;
  if (!byTicker[tk]) byTicker[tk] = {trades:0, wins:0, pnl:0};
  byTicker[tk].trades++;
  if (t.exitType === 'PROFIT_TARGET') byTicker[tk].wins++;
  byTicker[tk].pnl += t.pnl || 0;
});
console.log('Ticker breakdown:');
Object.entries(byTicker).sort((a,b)=>b[1].pnl-a[1].pnl).forEach(([tk,v]) => {
  const wr = (v.wins/v.trades*100).toFixed(1);
  console.log(tk+':', 'trades='+v.trades, 'WR='+wr+'%', 'pnl='+v.pnl.toFixed(0));
});
// exitType distribution
const exits = {};
d.allOOSTrades.forEach(t => { exits[t.exitType] = (exits[t.exitType]||0)+1; });
console.log('\nExit types:', exits);
// equity curve deduplication check
const dates = {};
d.oosEquityCurve.forEach(p => { dates[p.date] = p.equity; });
const deduped = Object.entries(dates).sort((a,b)=>a[0].localeCompare(b[0]));
console.log('\nDeduped equity curve length:', deduped.length, '(raw:', d.oosEquityCurve.length+')');
console.log('First:', deduped[0], 'Last:', deduped[deduped.length-1]);
