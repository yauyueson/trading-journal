const path = require('path');
const root = path.join(__dirname, '..');

// Phase2-3: signal x exit x tier OOS comparison (maxPositions=50, mpt3)
const ph23 = require(path.join(root, 'backtesting history/credit-spread/results/phase2-3-portfolio-sim.json'));
const signals = ['MF', 'ema', 'mom', 'EM'];
const exits = ['std30', 'std50', 'ph30_50_be', 'ph30_50_25', 'ph30_75_25', 'ph50_75_25'];

console.log('=== Phase2-3 exit strategy comparison (OOS, ALL tier, mpt3, maxPos=50) ===');
exits.forEach(exit => {
  signals.forEach(sig => {
    const r = ph23.results.find(r =>
      r.period === 'OOS' && r.maxPositions === 50 &&
      r.configLabel === `${sig} ALL ${exit} mpt3`
    );
    if (r) console.log(`${sig} ${exit} | Sharpe: ${r.sharpe.toFixed(3)} | WR: ${r.winRate.toFixed(1)}% | ROC: ${r.annualizedROC.toFixed(1)}% | DD: ${r.maxDrawdown.toFixed(1)}%`);
  });
});

console.log('\n=== Phase2-3 S vs ALL tier OOS (std30, mpt3, maxPos=50) ===');
signals.forEach(sig => {
  ['ALL','S'].forEach(tier => {
    const r = ph23.results.find(r =>
      r.period === 'OOS' && r.maxPositions === 50 &&
      r.configLabel === `${sig} ${tier} std30 mpt3`
    );
    if (r) console.log(`${sig} ${tier} | Sharpe: ${r.sharpe.toFixed(3)} | WR: ${r.winRate.toFixed(1)}% | ROC: ${r.annualizedROC.toFixed(1)}% | Trades: ${r.totalTrades} | Util: ${r.capitalUtilization.toFixed(1)}%`);
  });
});

// Phase4: all IS/OOS for ema signal grouped by experiment type
const ph4 = require(path.join(root, 'backtesting history/credit-spread/results/phase4-experiment-sim.json'));
console.log('\n=== Phase4 IS vs OOS Sharpe (ema, noFilter baseline) ===');
const emaBase = ph4.results.filter(r => r.signalKey === 'ema' && r.configLabel === 'ema noFilter');
emaBase.forEach(r => console.log(r.period, '| Sharpe:', r.sharpe.toFixed(3), '| WR:', r.winRate.toFixed(1)+'%'));

console.log('\n=== Phase4 IV filter IS+OOS for all signals ===');
const ivFilters = ['noFilter', 'iv20plus', 'iv30plus'];
signals.forEach(sig => {
  ivFilters.forEach(f => {
    const isR = ph4.results.find(r => r.signalKey === sig.toLowerCase() || r.configLabel.startsWith(sig.toLowerCase() === 'mf' ? 'MF' : sig) && r.period === 'IS' && r.configLabel === `${sig === 'MF' ? 'MF' : sig} ${f}`);
    const oosR = ph4.results.find(r => r.configLabel === `${sig === 'MF' ? 'MF' : sig} ${f}` && r.period === 'OOS');
    if (isR && oosR) {
      console.log(`${sig} ${f} | IS Sharpe: ${isR.sharpe.toFixed(3)} | OOS Sharpe: ${oosR.sharpe.toFixed(3)} | IS WR: ${isR.winRate.toFixed(1)}% | OOS WR: ${oosR.winRate.toFixed(1)}%`);
    }
  });
});
