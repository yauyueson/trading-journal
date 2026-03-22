/**
 * Unified WFA Runner — Single entry point for all Walk-Forward Analysis.
 *
 * Usage:
 *   npx tsx scripts/wfa-run-unified.ts --profile swing
 *   npx tsx scripts/wfa-run-unified.ts --profile swing --seed 42 --fill bidask
 *   npx tsx scripts/wfa-run-unified.ts --profile short --tickers SPY,QQQ,IWM --workers 8
 *   npx tsx scripts/wfa-run-unified.ts --profile swing --experiment custom.json
 *   npx tsx scripts/wfa-run-unified.ts --profile swing --smoke
 *   npx tsx scripts/wfa-run-unified.ts --profile swing --benchmark
 *   npx tsx scripts/wfa-run-unified.ts analyze --advisor
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env ────────────────────────────────────────────
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

import type { FillMode } from '../src/lib/backtest/types';
import type { SignalPresetKey } from '../src/lib/backtest/option-sim';
import {
  runSwingPipeline,
  closePipelineDB,
  SWING_DEFAULTS,
  SWING_SWEEP_DEFAULTS,
  type SwingPipelineConfig,
  type SwingSweepDimensions,
  fetchTickerData,
} from './wfa-pipeline-swing';
import {
  runShortPipeline,
  closeShortPipelineDB,
  SHORT_DEFAULTS as SHORT_PIPELINE_DEFAULTS,
  SHORT_SWEEP_DEFAULTS,
  type ShortPipelineConfig,
  type ShortSweepDimensions,
} from './wfa-pipeline-short';
import { buildMetadata, generateRunFilename } from './wfa-metadata';
import {
  buyAndHoldBenchmark,
  mechanicalPutSellBenchmark,
  randomEntryBenchmark,
  printBenchmarkComparison,
  type BenchmarkResult,
} from '../src/lib/backtest/benchmarks';
import { printAdvisorReport } from './wfa-advisor';

// ── CLI Arg Parsing ──────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

// ── Profile Defaults ─────────────────────────────────────

interface ProfileDefaults {
  tickers: string[];
  dataStart: string;
  startDate: string;
  endDate: string;
  trainWindowDays: number;
  forwardStepDays: number;
  purgeGapDays: number;
  mode: 'rolling' | 'anchored';
  maxPositions: number;
  maxPerTicker: number;
  startingCapital: number;
  fillMode: FillMode;
  presets: SignalPresetKey[];
}

const SHORT_DEFAULTS: ProfileDefaults = SHORT_PIPELINE_DEFAULTS as ProfileDefaults;

function getProfileDefaults(profile: string): ProfileDefaults {
  if (profile === 'short') return SHORT_DEFAULTS;
  return SWING_DEFAULTS as ProfileDefaults;
}

// ── Experiment Config Overlay ────────────────────────────

function loadExperimentOverrides(experimentPath: string): Record<string, unknown> {
  const fullPath = path.resolve(process.cwd(), experimentPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Experiment config not found: ${fullPath}`);
  }
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  // ── Subcommand: advisor ──
  if (args[0] === 'analyze' && hasFlag('--advisor')) {
    printAdvisorReport();
    return;
  }

  const profile = (getArg('--profile') || 'swing') as 'swing' | 'short';
  const seed = parseInt(getArg('--seed') || '42');
  const smoke = hasFlag('--smoke');
  const benchmark = hasFlag('--benchmark');
  const experimentPath = getArg('--experiment');
  const outFilename = getArg('--out');

  if (profile !== 'swing' && profile !== 'short') {
    console.error(`Invalid profile: "${profile}". Must be "swing" or "short".`);
    process.exit(1);
  }

  const defaults = getProfileDefaults(profile);

  // Parse CLI overrides
  const tickersArg = getArg('--tickers');
  const tickerArg = getArg('--ticker');
  const tickers = tickersArg
    ? tickersArg.split(',').map(t => t.trim().toUpperCase())
    : tickerArg
      ? [tickerArg.toUpperCase()]
      : defaults.tickers;

  const fillMode = (getArg('--fill') || defaults.fillMode) as FillMode;
  const numWorkers = Math.max(1, Math.min(
    parseInt(getArg('--workers') || String(Math.min(4, Math.max(1, os.cpus().length - 2)))),
    Math.max(1, os.cpus().length),
  ));
  const mode = (getArg('--mode') || defaults.mode) as 'rolling' | 'anchored';
  const trainDays = parseInt(getArg('--train') || String(defaults.trainWindowDays));
  const stepDays = parseInt(getArg('--step') || String(defaults.forwardStepDays));
  const purgeDays = parseInt(getArg('--purge') || String(defaults.purgeGapDays));
  const capital = parseInt(getArg('--capital') || String(defaults.startingCapital));
  const maxPos = parseInt(getArg('--max-pos') || String(defaults.maxPositions));
  const maxTicker = parseInt(getArg('--max-ticker') || String(defaults.maxPerTicker));

  // Build config
  let pipelineConfig: SwingPipelineConfig = {
    tickers,
    dataStart: defaults.dataStart,
    startDate: defaults.startDate,
    endDate: defaults.endDate,
    trainWindowDays: trainDays,
    forwardStepDays: stepDays,
    purgeGapDays: purgeDays,
    mode,
    maxPositions: maxPos,
    maxPerTicker: maxTicker,
    startingCapital: capital,
    fillMode,
    numWorkers,
    presets: defaults.presets,
  };

  // Apply experiment overrides
  if (experimentPath) {
    console.log(`Loading experiment config: ${experimentPath}`);
    const overrides = loadExperimentOverrides(experimentPath);
    pipelineConfig = deepMerge(pipelineConfig, overrides) as SwingPipelineConfig;
    console.log(`Experiment overrides applied:`, JSON.stringify(overrides, null, 2));
  }

  // Smoke mode: limit candidates
  let sweepOverrides: Partial<SwingSweepDimensions> | undefined;
  if (smoke) {
    console.log('SMOKE MODE: using minimal sweep grid');
    sweepOverrides = {
      profitTargets: [0.30],
      spreadWidths: [15],
      ivRankMins: [0],
      deltaStops: [Infinity],
      timeStopDTEs: [7],
    };
    pipelineConfig.sweepOverrides = sweepOverrides;
  }

  console.log(`\n  Profile:  ${profile}`);
  console.log(`  Seed:     ${seed}`);
  console.log(`  Tickers:  ${tickers.join(', ')}`);
  console.log(`  Fill:     ${fillMode}`);
  console.log(`  Workers:  ${numWorkers}`);
  console.log(`  Window:   ${trainDays}d train / ${stepDays}d step / ${purgeDays}d purge`);
  console.log(`  Capital:  $${capital.toLocaleString()}`);
  if (smoke) console.log(`  Mode:     SMOKE (minimal sweep)`);
  console.log('');

  const t0 = Date.now();

  // Route to appropriate pipeline
  if (profile === 'swing') {
    const result = await runSwingPipeline(pipelineConfig);

    // Save with metadata
    const elapsedMs = Date.now() - t0;
    const metadata = buildMetadata({
      profile,
      cliArgs: args,
      seed,
      config: pipelineConfig as unknown as Record<string, unknown>,
      elapsedMs,
    });

    const exportResult = {
      metadata,
      ...result.wfa,
      windows: result.wfa.windows.map(w => ({
        ...w,
        oosTrades: w.oosTrades.map(t => ({
          ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
          pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
          exitType: t.exitType, direction: t.direction,
          entryDelta: t.entryDelta, entryDTE: t.entryDTE,
          strike: t.strike, spreadWidth: t.spreadWidth,
        })),
      })),
      allOOSTrades: result.wfa.allOOSTrades.map(t => ({
        ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
        pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
        exitType: t.exitType, direction: t.direction,
        entryDelta: t.entryDelta, entryDTE: t.entryDTE,
        strike: t.strike, spreadWidth: t.spreadWidth,
      })),
    };

    // Save to data/runs/
    const runsDir = path.resolve(__dirname, '../data/runs');
    if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
    const filename = outFilename || generateRunFilename(profile);
    const outPath = path.resolve(runsDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(exportResult, null, 2));
    console.log(`Results saved to ${outPath}`);
    console.log(`Reproduce: ${metadata.cliCommand}`);

    // ── Benchmarks ──
    if (benchmark) {
      console.log('\nRunning benchmark comparisons (real chain evaluator)...');
      const spyData = await fetchTickerData('SPY', pipelineConfig.dataStart, pipelineConfig.endDate);

      // Buy & hold (candle-based, no chain needed)
      const bh = buyAndHoldBenchmark(
        spyData.candles, pipelineConfig.startDate, pipelineConfig.endDate, capital,
      );

      // Mechanical put-sell (real evaluator, same leverage)
      const benchOpts = {
        startingCapital: capital,
        maxPositions: maxPos,
        fillMode,
      };
      const mps = mechanicalPutSellBenchmark(
        result.allTradingDates, result.evaluator,
        pipelineConfig.startDate, pipelineConfig.endDate, benchOpts,
      );

      // Random entry (real evaluator, Monte Carlo average of M2M Sharpe)
      const rand = randomEntryBenchmark(
        result.allTradingDates, result.evaluator,
        pipelineConfig.startDate, pipelineConfig.endDate, benchOpts,
      );

      const strategyResult: BenchmarkResult = {
        name: `WFA ${profile.toUpperCase()}`,
        sharpe: result.wfa.oosSharpe,
        maxDrawdownPct: result.wfa.oosMaxDD,
        totalPnl: result.wfa.oosTotalPnl,
        totalReturnPct: (result.wfa.oosTotalPnl / capital) * 100,
        winRate: result.wfa.oosWinRate,
        trades: result.wfa.allOOSTrades.length,
      };

      printBenchmarkComparison(strategyResult, [bh, mps, rand]);
    }

    // Close DB after benchmarks are done
    closePipelineDB();
  } else {
    // Short profile — 4H intraday pipeline
    const shortConfig: ShortPipelineConfig = {
      tickers,
      dataStart: defaults.dataStart,
      startDate: defaults.startDate,
      endDate: defaults.endDate,
      trainWindowDays: trainDays,
      forwardStepDays: stepDays,
      purgeGapDays: purgeDays,
      mode,
      maxPositions: maxPos,
      maxPerTicker: maxTicker,
      startingCapital: capital,
      fillMode,
      numWorkers,
      presets: defaults.presets,
    };

    // Apply experiment overrides
    if (experimentPath) {
      const overrides = loadExperimentOverrides(experimentPath);
      Object.assign(shortConfig, deepMerge(shortConfig as any, overrides));
      console.log(`Experiment overrides applied:`, JSON.stringify(overrides, null, 2));
    }

    // Smoke mode: minimal grid
    if (smoke) {
      console.log('SMOKE MODE: using minimal sweep grid');
      shortConfig.sweepOverrides = {
        profitTargets: [0.30],
        spreadWidths: [5],
        ivRankMins: [0],
        deltaStops: [Infinity],
        timeStopDTEs: [1],
        periodMultipliers: [2.0],
      };
    }

    const result = await runShortPipeline(shortConfig);

    // Save with metadata
    const elapsedMs = Date.now() - t0;
    const metadata = buildMetadata({
      profile,
      cliArgs: args,
      seed,
      config: shortConfig as unknown as Record<string, unknown>,
      elapsedMs,
    });

    const exportResult = {
      metadata,
      ...result.wfa,
      windows: result.wfa.windows.map(w => ({
        ...w,
        oosTrades: w.oosTrades.map(t => ({
          ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
          pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
          exitType: t.exitType, direction: t.direction,
          entryDelta: t.entryDelta, entryDTE: t.entryDTE,
          strike: t.strike, spreadWidth: t.spreadWidth,
        })),
      })),
      allOOSTrades: result.wfa.allOOSTrades.map(t => ({
        ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
        pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
        exitType: t.exitType, direction: t.direction,
        entryDelta: t.entryDelta, entryDTE: t.entryDTE,
        strike: t.strike, spreadWidth: t.spreadWidth,
      })),
    };

    // Save to data/runs/
    const runsDir = path.resolve(__dirname, '../data/runs');
    if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
    const filename = outFilename || generateRunFilename(profile);
    const outPath = path.resolve(runsDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(exportResult, null, 2));
    console.log(`Results saved to ${outPath}`);
    console.log(`Reproduce: ${metadata.cliCommand}`);

    // Benchmarks (skip for short — different evaluator)
    if (benchmark) {
      console.log('\nBenchmarks not yet supported for short profile (different evaluator type).');
    }

    closeShortPipelineDB();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
