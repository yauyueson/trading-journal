import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildWFAWindows } from '../../src/lib/backtest/wfa-options';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cache = JSON.parse(fs.readFileSync('/Users/yuchenqiu/03_Projects/trading-journal/scripts/autoresearch/data-cache.json', 'utf-8'));
const allDates = [...new Set(Object.values(cache.tickers).flatMap((t: any) => t.candles.map((c: any) => c.date)))].sort() as string[];
const wfaStart = allDates.find(d => d >= '2018-01-01') ?? allDates[0];
const windows = buildWFAWindows(allDates, {
  trainWindowDays: 252,
  forwardStepDays: 126,
  purgeGapDays: 10,
  mode: 'rolling',
  startDate: wfaStart,
  endDate: allDates[allDates.length - 1],
});
console.log(`Total windows: ${windows.length}`);
for (let i = 0; i < windows.length; i++) {
  const w = windows[i];
  console.log(`  #${String(i+1).padStart(2)}  train ${w.trainStart} -> ${w.trainEnd}   OOS ${w.oosStart} -> ${w.oosEnd}`);
}
for (const hc of [2, 3, 4, 5, 6]) {
  const sel = windows.slice(0, -hc);
  const hld = windows.slice(-hc);
  console.log(`\nholdoutCount=${hc}: selection ends at OOS ${sel[sel.length-1]?.oosEnd}, holdout starts at ${hld[0]?.oosStart}`);
}
