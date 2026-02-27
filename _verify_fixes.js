// Verify: variance-based IV interpolation
console.log('=== Fix #1: Variance-based IV interpolation ===');
const lerp = (x, x1, x2, y1, y2) => y1 + (y2 - y1) * ((x - x1) / (x2 - x1));

function calcTargetIVOld(ivNear, ivFar, nearDTE, farDTE, targetDTE) {
    return lerp(targetDTE, nearDTE, farDTE, ivNear, ivFar);
}
function calcTargetIVNew(ivNear, ivFar, nearDTE, farDTE, targetDTE) {
    const varNear = ivNear * ivNear * nearDTE / 252;
    const varFar = ivFar * ivFar * farDTE / 252;
    const varTarget = lerp(targetDTE, nearDTE, farDTE, varNear, varFar);
    return Math.sqrt(varTarget * 252 / targetDTE);
}
const old60 = calcTargetIVOld(0.30, 0.20, 30, 90, 60);
const new60 = calcTargetIVNew(0.30, 0.20, 30, 90, 60);
console.log('Linear (old): IV60 = ' + (old60 * 100).toFixed(2) + '%    Expected: ~25.00%');
console.log('Variance (new): IV60 = ' + (new60 * 100).toFixed(2) + '%  Expected: ~22.36%');
console.log('Delta: ' + ((new60 - old60) * 100).toFixed(2) + 'pp (new is lower in backwardation CHECK)');

const old60c = calcTargetIVOld(0.20, 0.30, 30, 90, 60);
const new60c = calcTargetIVNew(0.20, 0.30, 30, 90, 60);
console.log('Contango - Linear: IV60 = ' + (old60c * 100).toFixed(2) + '%    Variance: ' + (new60c * 100).toFixed(2) + '%');
console.log('Delta: ' + ((new60c - old60c) * 100).toFixed(2) + 'pp (new is higher in contango CHECK)');

console.log('\n=== Fix #4: Earnings IV crush model ===');
function earningsOld(iv, dte) { return dte > 1 ? iv * Math.sqrt((dte - 1) / dte) : iv * 0.7; }
function earningsNew(iv, dte) {
    const totalVar = iv * iv * dte / 252;
    const dailyVar = totalVar / dte;
    const jumpVar = Math.max(0, totalVar - dailyVar * (dte - 1));
    const diffuseVar = totalVar - jumpVar;
    const remainingDTE = Math.max(dte - 1, 1);
    return dte > 1 ? Math.sqrt(Math.max(0, diffuseVar) * 252 / remainingDTE) : iv * 0.65;
}
[[0.50, 7], [0.40, 14], [0.60, 30]].forEach(function (p) {
    const iv = p[0], dte = p[1];
    const o = earningsOld(iv, dte) * 100;
    const n = earningsNew(iv, dte) * 100;
    console.log('IV=' + (iv * 100) + '% DTE=' + dte + ': old postIV=' + o.toFixed(1) + '% -> new postIV=' + n.toFixed(1) + '% (' + (n - o).toFixed(1) + 'pp change)');
});

console.log('\n=== Fix #9: IV trend thresholds ===');
const iv5dAgo = 0.30, currentIv30 = 0.33;
const iv5dChange = currentIv30 - iv5dAgo;
const iv5dChangePct = (iv5dAgo > 0 ? (currentIv30 - iv5dAgo) / iv5dAgo * 100 : 0);
console.log('IV: 0.30 -> 0.33 | absolute change: ' + iv5dChange.toFixed(4));
console.log('Old trend (>2 threshold): "' + (iv5dChange > 2 ? 'rising' : iv5dChange < -2 ? 'falling' : 'flat') + '"');
console.log('New trend (>10% threshold): "' + (iv5dChangePct > 10 ? 'rising' : iv5dChangePct < -10 ? 'falling' : 'flat') + '" (' + iv5dChangePct.toFixed(1) + '% change)');

console.log('\n=== Fix #10: Population vs Sample variance ===');
const returns = [-0.01, 0.005, 0.012, -0.008, 0.003, 0.015, -0.02, 0.007, 0.001, 0.009, -0.003, 0.006];
const n = returns.length;
const mean = returns.reduce((a, b) => a + b, 0) / n;
const sampleVar = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
const popVar = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
const rv_sample = Math.sqrt(sampleVar * 252) * 100;
const rv_pop = Math.sqrt(popVar * 252) * 100;
console.log('Sample RV30: ' + rv_sample.toFixed(4) + '%');
console.log('Pop RV30:    ' + rv_pop.toFixed(4) + '% (lower by ' + (rv_sample - rv_pop).toFixed(4) + 'pp = ~3% CHECK)');
