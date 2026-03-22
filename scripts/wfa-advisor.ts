/**
 * WFA Advisor — Analyzes past runs and recommends experiment configs.
 *
 * Reads all data/runs/*.json result files, extracts explored parameter
 * ranges, identifies gaps in coverage, and recommends new configs.
 *
 * Usage:
 *   npx tsx scripts/wfa-advisor.ts
 *   npx tsx scripts/wfa-run-unified.ts analyze --advisor
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ParamRange {
  values: Set<string | number>;
  min?: number;
  max?: number;
}

interface RunSummary {
  filename: string;
  profile: string;
  sharpe: number;
  winRate: number;
  maxDD: number;
  trades: number;
  bestConfigs: Record<string, unknown>[];
  timestamp?: string;
}

export function analyzeRuns(): { runs: RunSummary[]; recommendations: string[] } {
  const runsDir = path.resolve(__dirname, '../data/runs');
  if (!fs.existsSync(runsDir)) {
    console.log('No runs found in data/runs/. Run the unified WFA first.');
    return { runs: [], recommendations: [] };
  }

  const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No result files found in data/runs/.');
    return { runs: [], recommendations: [] };
  }

  const runs: RunSummary[] = [];
  const allParams = new Map<string, ParamRange>();

  // Track which parameter values have been explored
  const trackParam = (name: string, value: unknown) => {
    if (value == null || value === undefined) return;
    if (!allParams.has(name)) allParams.set(name, { values: new Set() });
    const range = allParams.get(name)!;
    if (typeof value === 'number' && isFinite(value)) {
      range.values.add(value);
      range.min = range.min != null ? Math.min(range.min, value) : value;
      range.max = range.max != null ? Math.max(range.max, value) : value;
    } else {
      range.values.add(String(value));
    }
  };

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8'));
      const bestConfigs: Record<string, unknown>[] = [];

      // Extract configs from windows
      const windows = data.windows ?? [];
      for (const w of windows) {
        const cfg = w.bestConfig;
        if (!cfg) continue;
        bestConfigs.push(cfg);

        trackParam('signalWeightPreset', cfg.signalWeightPreset);
        trackParam('creditProfitTarget', cfg.creditProfitTarget);
        trackParam('creditSpreadWidth', cfg.creditSpreadWidth);
        trackParam('minIVRank', cfg.minIVRank);
        trackParam('creditShortDelta', cfg.creditShortDelta);
        trackParam('creditDeltaStop', cfg.creditDeltaStop);
        trackParam('creditTimeStopDTE', cfg.creditTimeStopDTE);
      }

      runs.push({
        filename: file,
        profile: data.metadata?.profile ?? 'unknown',
        sharpe: data.oosSharpe ?? 0,
        winRate: data.oosWinRate ?? 0,
        maxDD: data.oosMaxDD ?? 0,
        trades: data.allOOSTrades?.length ?? 0,
        bestConfigs,
        timestamp: data.metadata?.timestamp,
      });
    } catch { /* skip malformed files */ }
  }

  // Generate recommendations based on coverage gaps
  const recommendations: string[] = [];

  // Check signal preset coverage
  const testedPresets = allParams.get('signalWeightPreset')?.values ?? new Set();
  const allPresets = ['ema', 'mom', 'em', 'mf', 'vol', 'full', 'mb', 'adx'];
  const missingPresets = allPresets.filter(p => !testedPresets.has(p));
  if (missingPresets.length > 0) {
    recommendations.push(`Untested signal presets: ${missingPresets.join(', ')}. Create experiment with: {"sweepOverrides": {"presets": ${JSON.stringify(missingPresets)}}}`);
  }

  // Check profit target range
  const tpRange = allParams.get('creditProfitTarget');
  if (tpRange && tpRange.max != null && tpRange.max < 0.60) {
    recommendations.push(`Max tested profit target is ${(tpRange.max * 100).toFixed(0)}%. Try higher: {"sweepOverrides": {"profitTargets": [0.60, 0.70]}}`);
  }
  if (tpRange && tpRange.min != null && tpRange.min > 0.20) {
    recommendations.push(`Min tested profit target is ${(tpRange.min * 100).toFixed(0)}%. Try lower: {"sweepOverrides": {"profitTargets": [0.15, 0.20]}}`);
  }

  // Check IV rank filter range
  const ivRange = allParams.get('minIVRank');
  if (ivRange && !ivRange.values.has(50) && !ivRange.values.has(40)) {
    recommendations.push(`IV Rank ≥40 and ≥50 not tested. Try: {"sweepOverrides": {"ivRankMins": [40, 50]}}`);
  }

  // Check spread width range
  const widthRange = allParams.get('creditSpreadWidth');
  if (widthRange && !widthRange.values.has(10) && !widthRange.values.has(20)) {
    recommendations.push(`Spread widths $10 and $20 not tested. Try: {"sweepOverrides": {"spreadWidths": [10, 20]}}`);
  }

  // Check fill mode
  const fillModes = new Set<string>();
  for (const run of runs) {
    for (const cfg of run.bestConfigs) {
      if ((cfg as any).fillMode) fillModes.add(String((cfg as any).fillMode));
    }
  }
  if (!fillModes.has('bidask')) {
    recommendations.push('No runs with bidask fill mode. Run with --fill bidask for realistic execution.');
  }

  // General recommendation if few runs
  if (runs.length < 3) {
    recommendations.push('Few runs recorded. Run more experiments to build parameter space coverage.');
  }

  return { runs, recommendations };
}

export function printAdvisorReport() {
  const { runs, recommendations } = analyzeRuns();

  console.log('\n' + '═'.repeat(80));
  console.log('  WFA ADVISOR — Parameter Space Analysis');
  console.log('═'.repeat(80));

  if (runs.length === 0) {
    console.log('\n  No prior runs found. Run experiments first.\n');
    return;
  }

  // Print run history
  console.log('\n  PRIOR RUNS');
  console.log('  ' + '─'.repeat(78));
  console.log('  File                                              Profile  Sharpe  Trades');
  console.log('  ' + '·'.repeat(78));
  for (const run of runs.sort((a, b) => b.sharpe - a.sharpe)) {
    const nameStr = run.filename.length > 48 ? '...' + run.filename.slice(-45) : run.filename;
    console.log(
      `  ${nameStr.padEnd(50)} ${run.profile.padEnd(7)} ${run.sharpe.toFixed(2).padStart(6)} ${String(run.trades).padStart(7)}`
    );
  }

  // Print recommendations
  if (recommendations.length > 0) {
    console.log('\n  RECOMMENDED EXPERIMENTS');
    console.log('  ' + '─'.repeat(78));
    for (let i = 0; i < recommendations.length; i++) {
      console.log(`  ${i + 1}. ${recommendations[i]}`);
    }
  } else {
    console.log('\n  Good coverage — no obvious gaps in parameter space.');
  }

  console.log('\n' + '═'.repeat(80) + '\n');
}

// Run standalone
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))) {
  printAdvisorReport();
}
