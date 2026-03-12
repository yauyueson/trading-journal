const Database = require('better-sqlite3');
const db = new Database('./data/option-chains.sqlite', { readonly: true });

// IV skew between short and long legs of typical spread
const skewSQL = `
  WITH short_legs AS (
    SELECT ticker, trade_date, expir_date, strike, put_iv, put_oi, put_volume,
           (put_ask - put_bid) as put_spread, put_mid, gamma, theta, vega
    FROM option_chains
    WHERE dte BETWEEN 45 AND 65 AND delta BETWEEN 0.62 AND 0.72
  ),
  long_legs AS (
    SELECT ticker, trade_date, expir_date, strike, put_iv, put_oi
    FROM option_chains
    WHERE dte BETWEEN 45 AND 65 AND delta BETWEEN 0.78 AND 0.88
  )
  SELECT
    s.ticker,
    AVG(s.put_iv - l.put_iv) as avg_iv_skew,
    AVG(CASE WHEN s.theta < -0.001 THEN s.gamma / (-s.theta) ELSE NULL END) as avg_gamma_theta_ratio,
    AVG(CASE WHEN s.put_mid > 0.10 THEN s.put_spread / s.put_mid ELSE NULL END) as avg_spread_pct,
    AVG(s.vega) as avg_vega,
    COUNT(*) as pairs
  FROM short_legs s
  JOIN long_legs l ON s.ticker = l.ticker AND s.trade_date = l.trade_date AND s.expir_date = l.expir_date
  GROUP BY s.ticker
  ORDER BY pairs DESC
  LIMIT 16
`;
const skewData = db.prepare(skewSQL).all();
console.log('IV Skew (short vs long leg) and Greeks at credit spread strikes:');
console.log('Ticker  IVskew   G/T    Spread%  Vega   Pairs');
skewData.forEach(r => {
  const ivs = (r.avg_iv_skew * 100).toFixed(2).padStart(7);
  const gt = r.avg_gamma_theta_ratio ? r.avg_gamma_theta_ratio.toFixed(2).padStart(6) : '   N/A';
  const sp = ((r.avg_spread_pct || 0) * 100).toFixed(1).padStart(6);
  const v = r.avg_vega ? r.avg_vega.toFixed(3).padStart(7) : '    N/A';
  console.log(`${r.ticker.padEnd(7)} ${ivs}% ${gt} ${sp}% ${v}  ${r.pairs}`);
});

// OI filter impact
console.log('\nOI filter impact (put side, delta 0.60-0.75, DTE 45-65):');
const total = db.prepare(
  'SELECT COUNT(*) as c FROM option_chains WHERE dte BETWEEN 45 AND 65 AND delta BETWEEN 0.60 AND 0.75'
).get();
for (const threshold of [0, 50, 100, 500, 1000, 5000]) {
  const count = db.prepare(
    'SELECT COUNT(*) as c FROM option_chains WHERE dte BETWEEN 45 AND 65 AND delta BETWEEN 0.60 AND 0.75 AND put_oi >= ?'
  ).get(threshold);
  console.log(`  OI >= ${String(threshold).padStart(5)}: ${count.c} / ${total.c} = ${(count.c/total.c*100).toFixed(1)}%`);
}

// Spread% filter impact
console.log('\nBid/ask spread filter impact (put side, mid > $0.10):');
const totalSpread = db.prepare(
  'SELECT COUNT(*) as c FROM option_chains WHERE dte BETWEEN 45 AND 65 AND delta BETWEEN 0.60 AND 0.75 AND put_mid > 0.10'
).get();
for (const maxPct of [0.05, 0.10, 0.15, 0.20, 0.30, 0.50]) {
  const count = db.prepare(
    'SELECT COUNT(*) as c FROM option_chains WHERE dte BETWEEN 45 AND 65 AND delta BETWEEN 0.60 AND 0.75 AND put_mid > 0.10 AND (put_ask - put_bid) / put_mid <= ?'
  ).get(maxPct);
  console.log(`  Spread <= ${(maxPct*100).toFixed(0).padStart(3)}%: ${count.c} / ${totalSpread.c} = ${(count.c/totalSpread.c*100).toFixed(1)}%`);
}

// Per-ticker spread% variation
console.log('\nAvg bid/ask spread % by ticker (at credit spread strikes):');
const tickerSpreads = db.prepare(`
  SELECT ticker,
    AVG(CASE WHEN put_mid > 0.10 THEN (put_ask - put_bid) / put_mid ELSE NULL END) as avg_spread_pct,
    AVG(put_oi) as avg_oi,
    AVG(put_volume) as avg_vol,
    COUNT(*) as rows
  FROM option_chains
  WHERE dte BETWEEN 45 AND 65 AND delta BETWEEN 0.60 AND 0.75
  GROUP BY ticker ORDER BY avg_spread_pct
`).all();
tickerSpreads.forEach(r => {
  console.log(`  ${r.ticker.padEnd(6)} Spread: ${((r.avg_spread_pct||0)*100).toFixed(1).padStart(5)}%  OI: ${Math.round(r.avg_oi).toString().padStart(6)}  Vol: ${Math.round(r.avg_vol).toString().padStart(5)}`);
});

db.close();
