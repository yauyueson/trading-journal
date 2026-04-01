/**
 * Extracts viewer-ready data from the large simulation result files.
 * Output: data/viewer-signals.json + data/viewer-configs.json
 */
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');

const ph4 = require(path.join(root, 'backtesting history/credit-spread/results/phase4-experiment-sim.json'));
const ph23 = require(path.join(root, 'backtesting history/credit-spread/results/phase2-3-portfolio-sim.json'));

// ── viewer-signals.json ───────────────────────────────────────────────────────
// 1. Signal × IV filter IS/OOS comparison (phase4)
const signals = ['MF', 'ema', 'mom', 'EM'];
const ivFilters = ['noFilter', 'iv20plus', 'iv30plus'];
const signalIV = [];
signals.forEach(sig => {
  ivFilters.forEach(f => {
    const label = `${sig} ${f}`;
    const isR = ph4.results.find(r => r.configLabel === label && r.period === 'IS');
    const oosR = ph4.results.find(r => r.configLabel === label && r.period === 'OOS');
    if (isR && oosR) {
      signalIV.push({
        signal: sig,
        filter: f,
        is: { sharpe: +isR.sharpe.toFixed(3), wr: +isR.winRate.toFixed(2), roc: +isR.annualizedROC.toFixed(2), trades: isR.totalTrades, util: +isR.capitalUtilization.toFixed(2) },
        oos: { sharpe: +oosR.sharpe.toFixed(3), wr: +oosR.winRate.toFixed(2), roc: +oosR.annualizedROC.toFixed(2), trades: oosR.totalTrades, util: +oosR.capitalUtilization.toFixed(2) },
      });
    }
  });
});

// 2. S-tier vs ALL tier (phase2-3, std30, mpt3, maxPos=50)
const scoreTier = [];
signals.forEach(sig => {
  ['ALL', 'S'].forEach(tier => {
    const label = `${sig} ${tier} std30 mpt3`;
    const oosR = ph23.results.find(r => r.configLabel === label && r.period === 'OOS' && r.maxPositions === 50);
    const isR = ph23.results.find(r => r.configLabel === label && r.period === 'IS' && r.maxPositions === 50);
    if (oosR && isR) {
      scoreTier.push({
        signal: sig,
        tier,
        is: { sharpe: +isR.sharpe.toFixed(3), wr: +isR.winRate.toFixed(2), roc: +isR.annualizedROC.toFixed(2), trades: isR.totalTrades },
        oos: { sharpe: +oosR.sharpe.toFixed(3), wr: +oosR.winRate.toFixed(2), roc: +oosR.annualizedROC.toFixed(2), trades: oosR.totalTrades },
      });
    }
  });
});

const viewerSignals = { signalIV, scoreTier };
fs.writeFileSync(path.join(root, 'data/viewer-signals.json'), JSON.stringify(viewerSignals, null, 2));
console.log('viewer-signals.json written:', signalIV.length, 'signalIV rows,', scoreTier.length, 'scoreTier rows');


// ── viewer-configs.json ───────────────────────────────────────────────────────
// 1. All option filters for ema (phase4, all IS+OOS)
const allFilters = [...new Set(ph4.results.filter(r => r.signalKey === 'ema').map(r => r.configLabel.split(' ')[1]))];
const optionFilters = [];
allFilters.forEach(f => {
  const label = `ema ${f}`;
  const isR = ph4.results.find(r => r.configLabel === label && r.period === 'IS');
  const oosR = ph4.results.find(r => r.configLabel === label && r.period === 'OOS');
  if (isR && oosR) {
    optionFilters.push({
      filter: f,
      is: { sharpe: +isR.sharpe.toFixed(3), wr: +isR.winRate.toFixed(2), trades: isR.totalTrades, util: +isR.capitalUtilization.toFixed(2) },
      oos: { sharpe: +oosR.sharpe.toFixed(3), wr: +oosR.winRate.toFixed(2), trades: oosR.totalTrades, util: +oosR.capitalUtilization.toFixed(2) },
    });
  }
});
optionFilters.sort((a, b) => b.oos.sharpe - a.oos.sharpe);

// 2. Exit strategies (phase2-3, all signals, OOS, ALL tier, mpt3, maxPos=50)
const exitStrats = ['std30', 'std50', 'ph30_50_be', 'ph30_50_25', 'ph30_75_25', 'ph50_75_25'];
const exitStratLabels = {
  std30: 'TP 30%',
  std50: 'TP 50%',
  ph30_50_be: 'Partial 30% → B/E',
  ph30_50_25: 'Partial 30%/25%',
  ph30_75_25: 'Partial 30%→75%/25%',
  ph50_75_25: 'Partial 50%→75%/25%',
};
const exitRows = [];
exitStrats.forEach(exit => {
  signals.forEach(sig => {
    const isR = ph23.results.find(r => r.configLabel === `${sig} ALL ${exit} mpt3` && r.period === 'IS' && r.maxPositions === 50);
    const oosR = ph23.results.find(r => r.configLabel === `${sig} ALL ${exit} mpt3` && r.period === 'OOS' && r.maxPositions === 50);
    if (isR && oosR) {
      exitRows.push({
        exit,
        label: exitStratLabels[exit],
        signal: sig,
        is: { sharpe: +isR.sharpe.toFixed(3), wr: +isR.winRate.toFixed(2), roc: +isR.annualizedROC.toFixed(2), dd: +isR.maxDrawdown.toFixed(2) },
        oos: { sharpe: +oosR.sharpe.toFixed(3), wr: +oosR.winRate.toFixed(2), roc: +oosR.annualizedROC.toFixed(2), dd: +oosR.maxDrawdown.toFixed(2) },
      });
    }
  });
});

// 3. IV filter for all signals (phase4, all 3 IV levels) — already in signalIV but grouped differently
const ivRows = [];
signals.forEach(sig => {
  ivFilters.forEach(f => {
    const row = signalIV.find(r => r.signal === sig && r.filter === f);
    if (row) ivRows.push(row);
  });
});

const viewerConfigs = { optionFilters, exitRows, ivRows };
fs.writeFileSync(path.join(root, 'data/viewer-configs.json'), JSON.stringify(viewerConfigs, null, 2));
console.log('viewer-configs.json written:', optionFilters.length, 'option filters,', exitRows.length, 'exit rows,', ivRows.length, 'iv rows');
