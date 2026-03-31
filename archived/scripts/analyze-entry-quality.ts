/**
 * Entry Quality Ablation — Diagnostic Script
 *
 * Regenerates swing signals with d8 data preserved, then buckets
 * by entry quality (OPTIMAL/ACCEPTABLE/MARGINAL/CHASING) to quantify
 * how entry timing impacts trade outcomes.
 *
 * Uses the same data source and signal generation as the swing WFA pipeline.
 *
 * Usage: npx tsx scripts/analyze-entry-quality.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Load env (same pattern as wfa-run.ts) ───────────────
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

import { SIGNAL_PRESETS } from '../src/lib/backtest/types';
import type { SignalPresetKey, PrecomputedSignal } from '../src/lib/backtest/types';
import { precomputeSignals, classifyEntryQuality } from '../src/lib/backtest/engine';
import { fetchTickerData, SWING_DEFAULTS } from './wfa-pipeline-swing';

// ── Config (match March 21 sign-off parameters) ─────────────
const PRESETS: SignalPresetKey[] = ['vol', 'em', 'mf', 'ema', 'mom'];
const MIN_SCORE = 70;
const MIN_ADX = 10;
const DATA_START = SWING_DEFAULTS.dataStart;   // '2017-01-01'
const START_DATE = SWING_DEFAULTS.startDate;    // '2018-01-01'
const END_DATE = SWING_DEFAULTS.endDate;        // '2026-02-28'
const TICKERS = SWING_DEFAULTS.tickers;

// ── Bucket definitions ──────────────────────────────────────
type Bucket = 'OPTIMAL' | 'ACCEPTABLE' | 'MARGINAL' | 'CHASING';

function classifyD8(d8: number): Bucket {
  const abs = Math.abs(d8);
  if (abs < 0.3) return 'OPTIMAL';
  if (abs < 0.8) return 'ACCEPTABLE';
  if (abs < 1.5) return 'MARGINAL';
  return 'CHASING';
}

interface BucketStats {
  count: number;
  callCount: number;
  putCount: number;
  avgScore: number;
  avgD8: number;
  avgAbsD8: number;
  d8Values: number[];
  scores: number[];
  setups: Map<string, number>;
}

function newBucket(): BucketStats {
  return {
    count: 0, callCount: 0, putCount: 0,
    avgScore: 0, avgD8: 0, avgAbsD8: 0,
    d8Values: [], scores: [],
    setups: new Map(),
  };
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  console.log('=== Entry Quality Ablation ===');
  console.log(`Tickers: ${TICKERS.join(', ')}`);
  console.log(`Period: ${START_DATE} → ${END_DATE}`);
  console.log(`Presets: ${PRESETS.join(', ')}`);
  console.log();

  // Results by preset
  const resultsByPreset = new Map<string, Map<Bucket, BucketStats>>();

  for (const preset of PRESETS) {
    const buckets = new Map<Bucket, BucketStats>([
      ['OPTIMAL', newBucket()],
      ['ACCEPTABLE', newBucket()],
      ['MARGINAL', newBucket()],
      ['CHASING', newBucket()],
    ]);
    let totalSignals = 0;

    for (const ticker of TICKERS) {
      let td;
      try {
        td = await fetchTickerData(ticker, DATA_START, END_DATE);
      } catch (e: any) {
        console.error(`  [${ticker}] fetch failed: ${e.message}`);
        continue;
      }

      const techOptions = SIGNAL_PRESETS[preset];
      const { signals } = precomputeSignals(td.candles, '1D', techOptions);

      for (const sig of signals) {
        if (sig.date < START_DATE || sig.date > END_DATE) continue;
        if (sig.type === 'NEUTRAL' || sig.score < MIN_SCORE) continue;
        if (sig.adx === undefined || sig.adx < MIN_ADX) continue;

        totalSignals++;
        const bucket = classifyD8(sig.d8);
        const stats = buckets.get(bucket)!;
        stats.count++;
        if (sig.type === 'CALL') stats.callCount++;
        else stats.putCount++;
        stats.d8Values.push(sig.d8);
        stats.scores.push(sig.score);
        const setupCount = stats.setups.get(sig.setup) ?? 0;
        stats.setups.set(sig.setup, setupCount + 1);
      }
    }

    // Compute averages
    for (const [, stats] of buckets) {
      if (stats.count > 0) {
        stats.avgD8 = stats.d8Values.reduce((a, b) => a + b, 0) / stats.count;
        stats.avgAbsD8 = stats.d8Values.reduce((a, b) => a + Math.abs(b), 0) / stats.count;
        stats.avgScore = stats.scores.reduce((a, b) => a + b, 0) / stats.count;
      }
    }

    resultsByPreset.set(preset, buckets);
    console.log(`\n─── Preset: ${preset} (${totalSignals} total signals) ───`);
    console.log();

    // Table header
    console.log(
      'Bucket'.padEnd(14) +
      'Count'.padStart(7) +
      '   %'.padStart(6) +
      'CALL'.padStart(6) +
      ' PUT'.padStart(6) +
      'AvgScore'.padStart(10) +
      'Avg|d8|'.padStart(9) +
      'AvgD8'.padStart(8)
    );
    console.log('-'.repeat(66));

    for (const bucket of ['OPTIMAL', 'ACCEPTABLE', 'MARGINAL', 'CHASING'] as Bucket[]) {
      const s = buckets.get(bucket)!;
      const pct = totalSignals > 0 ? ((s.count / totalSignals) * 100).toFixed(1) : '0.0';
      console.log(
        bucket.padEnd(14) +
        String(s.count).padStart(7) +
        `${pct}%`.padStart(6) +
        String(s.callCount).padStart(6) +
        String(s.putCount).padStart(6) +
        (s.count > 0 ? s.avgScore.toFixed(1) : '-').padStart(10) +
        (s.count > 0 ? s.avgAbsD8.toFixed(3) : '-').padStart(9) +
        (s.count > 0 ? s.avgD8.toFixed(3) : '-').padStart(8)
      );
    }

    // Top setups per bucket
    console.log();
    for (const bucket of ['OPTIMAL', 'ACCEPTABLE', 'MARGINAL', 'CHASING'] as Bucket[]) {
      const s = buckets.get(bucket)!;
      if (s.count === 0) continue;
      const topSetups = [...s.setups.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');
      console.log(`  ${bucket}: ${topSetups}`);
    }
  }

  // ── Cross-preset summary ──────────────────────────────────
  console.log('\n\n═══ Cross-Preset Summary: % CHASING ═══\n');
  for (const [preset, buckets] of resultsByPreset) {
    const total = [...buckets.values()].reduce((a, b) => a + b.count, 0);
    const chasing = buckets.get('CHASING')!.count;
    const marginal = buckets.get('MARGINAL')!.count;
    const optimal = buckets.get('OPTIMAL')!.count;
    const acceptable = buckets.get('ACCEPTABLE')!.count;
    console.log(
      `  ${preset.padEnd(5)}  ` +
      `OPTIMAL: ${((optimal / total) * 100).toFixed(1)}%  ` +
      `ACCEPT: ${((acceptable / total) * 100).toFixed(1)}%  ` +
      `MARGINAL: ${((marginal / total) * 100).toFixed(1)}%  ` +
      `CHASING: ${((chasing / total) * 100).toFixed(1)}%  ` +
      `(${total} signals)`
    );
  }

  // ── D8 distribution histogram ─────────────────────────────
  console.log('\n\n═══ D8 Distribution (vol preset) ═══\n');
  const volBuckets = resultsByPreset.get('vol');
  if (volBuckets) {
    const allD8: number[] = [];
    for (const [, stats] of volBuckets) allD8.push(...stats.d8Values);
    allD8.sort((a, b) => a - b);

    const bins = [-3, -2, -1.5, -1, -0.8, -0.5, -0.3, 0, 0.3, 0.5, 0.8, 1, 1.5, 2, 3];
    for (let i = 0; i < bins.length - 1; i++) {
      const lo = bins[i], hi = bins[i + 1];
      const count = allD8.filter(v => v >= lo && v < hi).length;
      const bar = '█'.repeat(Math.round(count / Math.max(1, allD8.length) * 80));
      console.log(`  [${lo >= 0 ? '+' : ''}${lo.toFixed(1)}, ${hi >= 0 ? '+' : ''}${hi.toFixed(1)})  ${String(count).padStart(5)}  ${bar}`);
    }
    const above3 = allD8.filter(v => v >= 3).length;
    const below3 = allD8.filter(v => v < -3).length;
    if (above3 > 0) console.log(`  [+3.0, ∞)    ${String(above3).padStart(5)}`);
    if (below3 > 0) console.log(`  (-∞, -3.0)   ${String(below3).padStart(5)}`);

    // Percentile stats
    const p = (pct: number) => allD8[Math.floor(allD8.length * pct / 100)] ?? NaN;
    console.log(`\n  Percentiles: p10=${p(10).toFixed(2)}  p25=${p(25).toFixed(2)}  p50=${p(50).toFixed(2)}  p75=${p(75).toFixed(2)}  p90=${p(90).toFixed(2)}`);
    const avgAbsD8 = allD8.reduce((a, b) => a + Math.abs(b), 0) / allD8.length;
    console.log(`  Mean |d8|: ${avgAbsD8.toFixed(3)}%`);
  }

  console.log('\n\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
