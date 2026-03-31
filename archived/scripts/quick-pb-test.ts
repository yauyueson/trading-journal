/**
 * Quick test: how many pullback signals does the pb preset generate?
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

import { fetchTickerData, generateSignalsForPreset, SWING_DEFAULTS } from './wfa-pipeline-swing';

async function main() {
  const tickers = SWING_DEFAULTS.tickers;
  let totalPb = 0, totalVol = 0;

  for (const ticker of tickers) {
    const td = await fetchTickerData(ticker, '2017-01-01', '2026-02-28');
    const pb = generateSignalsForPreset(td, 'pb', '2018-01-01', '2026-02-28');
    const vol = generateSignalsForPreset(td, 'vol', '2018-01-01', '2026-02-28');
    totalPb += pb.length;
    totalVol += vol.length;

    const pbD8 = pb.map(s => s.d8!).sort((a, b) => a - b);
    const avgAbsD8 = pb.length > 0 ? (pbD8.reduce((a, b) => a + Math.abs(b), 0) / pb.length).toFixed(3) : '-';
    console.log(`  ${ticker.padEnd(6)} pb=${String(pb.length).padStart(4)}  vol=${String(vol.length).padStart(4)}  pb avg|d8|=${avgAbsD8}`);
  }

  console.log(`\nTotal:  pb=${totalPb}  vol=${totalVol}  ratio=${(totalPb / totalVol * 100).toFixed(1)}%`);
}

main().catch(e => { console.error(e); process.exit(1); });
