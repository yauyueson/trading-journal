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

import {
  DIRECTIONAL_DEFAULTS,
  DIRECTIONAL_SWEEP_DEFAULTS,
  closeDirectionalPipelineDB,
  formatDebitConfigLabel,
  formatUnderlyingConfigLabel,
  resolveUnderlyingSignalSourceLabel,
  runDirectionalPipeline,
  type DirectionalPipelineConfig,
  type DirectionalPipelineResult,
  type DirectionalSweepDimensions,
  type UnderlyingWFAResult,
} from './wfa-pipeline-directional';
import { buildMetadata, generateRunFilename } from './wfa-metadata';
import type { WFAResult } from '../src/lib/backtest/wfa-options';
import type { UnderlyingTrade } from '../src/lib/backtest/underlying-sim';
import type { OptionTrade } from '../src/lib/backtest/option-sim';

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

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
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0, minimumFractionDigits: 0 })}`;
}

function formatPct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatMetricPct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

function formatWinRate(value: number): string {
  return `${value.toFixed(1)}%`;
}

function markdownTable(headers: string[], rows: string[][]): string {
  const separator = headers.map(() => '---');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function summarizeGate(gate: DirectionalPipelineResult['underlying']['gate'] | DirectionalPipelineResult['debit']['gate']): string {
  if (!gate) return '';
  return gate.checks.map(check => `- ${check.name}: ${check.passed ? 'PASS' : 'FAIL'} (${check.actual} vs ${check.target})`).join('\n');
}

function buildRegimeBucketRows(
  windows: Array<{ windowIndex: number; oosSharpe: number; oosTrades: Array<{ pnlDollar?: number; pnl?: number }> }>,
  pnlGetter: (trade: { pnlDollar?: number; pnl?: number }) => number,
): string[][] {
  const buckets = [
    { label: 'W0-1 COVID Recovery', indices: [0, 1] },
    { label: 'W2,5-8 Mid-Cycle', indices: [2, 5, 6, 7, 8] },
    { label: 'W3-4 2022 Bear', indices: [3, 4] },
    { label: 'W9-11 2024-25 Bull', indices: [9, 10, 11] },
  ];

  return buckets.map(bucket => {
    const bucketWindows = windows.filter(window => bucket.indices.includes(window.windowIndex));
    const trades = bucketWindows.flatMap(window => window.oosTrades);
    const pnl = trades.reduce((sum, trade) => sum + pnlGetter(trade), 0);
    const avgSharpe = bucketWindows.length > 0
      ? bucketWindows.reduce((sum, window) => sum + window.oosSharpe, 0) / bucketWindows.length
      : 0;
    const winRate = trades.length > 0
      ? trades.filter(trade => pnlGetter(trade) > 0).length / trades.length
      : 0;
    return [
      bucket.label,
      String(trades.length),
      formatCurrency(pnl),
      avgSharpe.toFixed(2),
      formatPct(winRate),
    ];
  });
}

function buildUnderlyingReport(result: UnderlyingWFAResult, gate: DirectionalPipelineResult['underlying']['gate']): string {
  const trades = result.allOOSTrades;
  const winners = trades.filter(trade => trade.pnlDollar > 0);
  const losers = trades.filter(trade => trade.pnlDollar <= 0);
  const avgWinner = winners.length > 0 ? winners.reduce((sum, trade) => sum + trade.pnlDollar, 0) / winners.length : 0;
  const avgLoser = losers.length > 0 ? losers.reduce((sum, trade) => sum + trade.pnlDollar, 0) / losers.length : 0;
  const tickerRows = [...new Set(trades.map(trade => trade.ticker))]
    .sort()
    .map(ticker => {
      const tickerTrades = trades.filter(trade => trade.ticker === ticker);
      const pnl = tickerTrades.reduce((sum, trade) => sum + trade.pnlDollar, 0);
      const winRate = tickerTrades.filter(trade => trade.pnlDollar > 0).length / Math.max(1, tickerTrades.length);
      return [ticker, String(tickerTrades.length), formatCurrency(pnl), formatPct(winRate)];
    });

  const routingRows = [...new Set(result.windows.map(window => resolveUnderlyingSignalSourceLabel(window.bestConfig)))]
    .sort()
    .map(routingLabel => {
      const routingWindows = result.windows.filter(window => resolveUnderlyingSignalSourceLabel(window.bestConfig) === routingLabel);
      const routingTrades = routingWindows.flatMap(window => window.oosTrades);
      const pnl = routingTrades.reduce((sum, trade) => sum + trade.pnlDollar, 0);
      const winRate = routingTrades.length > 0
        ? routingTrades.filter(trade => trade.pnlDollar > 0).length / routingTrades.length
        : 0;
      const avgSharpe = routingWindows.length > 0
        ? routingWindows.reduce((sum, window) => sum + window.oosSharpe, 0) / routingWindows.length
        : 0;
      return [routingLabel, String(routingWindows.length), String(routingTrades.length), formatCurrency(pnl), avgSharpe.toFixed(2), formatPct(winRate)];
    });

  const entryPresetRows = [...new Set(trades.map(trade => trade.entrySignalPreset).filter((preset): preset is string => Boolean(preset)))]
    .sort()
    .map(preset => {
      const presetTrades = trades.filter(trade => trade.entrySignalPreset === preset);
      const pnl = presetTrades.reduce((sum, trade) => sum + trade.pnlDollar, 0);
      const winRate = presetTrades.length > 0
        ? presetTrades.filter(trade => trade.pnlDollar > 0).length / presetTrades.length
        : 0;
      return [preset, String(presetTrades.length), formatCurrency(pnl), formatPct(winRate)];
    });

  const regimeRows = buildRegimeBucketRows(result.windows, trade => trade.pnlDollar ?? 0);

  const windowRows = result.windows.map(window => [
    `W${window.windowIndex}`,
    window.trainStart,
    window.oosStart,
    window.bestTrainSharpe.toFixed(2),
    window.oosSharpe.toFixed(2),
    formatCurrency(window.oosTotalPnl),
    formatPct(window.oosWinRate),
    String(window.oosTrades.length),
    formatUnderlyingConfigLabel(window.bestConfig),
  ]);

  return [
    '## Underlying Benchmark',
    '',
    markdownTable(
      ['Metric', 'Value'],
      [
        ['OOS Sharpe', result.oosSharpe.toFixed(2)],
        ['OOS Total PnL', formatCurrency(result.oosTotalPnl)],
        ['OOS Win Rate', formatPct(result.oosWinRate)],
        ['OOS Max DD', formatMetricPct(result.oosMaxDD)],
        ['Trades', String(result.allOOSTrades.length)],
        ['Avg Winner', formatCurrency(avgWinner)],
        ['Avg Loser', formatCurrency(avgLoser)],
      ],
    ),
    '',
    '### Gate',
    summarizeGate(gate),
    '',
    '### Per Window',
    markdownTable(
      ['Window', 'Train Start', 'OOS Start', 'Train Sharpe', 'OOS Sharpe', 'OOS PnL', 'WR', 'Trades', 'Best Config'],
      windowRows,
    ),
    '',
    '### Selected Routing Breakdown',
    markdownTable(['Routing', 'Windows Selected', 'Trades', 'Total PnL', 'Avg OOS Sharpe', 'Win Rate'], routingRows),
    '',
    '### Executed Signal Source Breakdown',
    markdownTable(['Signal Source', 'Trades', 'Total PnL', 'Win Rate'], entryPresetRows),
    '',
    '### Regime Breakdown',
    markdownTable(['Bucket', 'Trades', 'Total PnL', 'Avg OOS Sharpe', 'Win Rate'], regimeRows),
    '',
    '### Ticker Breakdown',
    markdownTable(['Ticker', 'Trades', 'Total PnL', 'Win Rate'], tickerRows),
  ].join('\n');
}

function computeTradeMfeMae(trade: OptionTrade): { mfe: number; mae: number } {
  const path = [0, ...(trade.dailyMtM?.map(point => point.unrealizedPnl) ?? []), trade.pnl];
  return {
    mfe: Math.max(...path),
    mae: Math.min(...path),
  };
}

function buildDebitReport(result: WFAResult, gate: DirectionalPipelineResult['debit']['gate']): string {
  const trades = result.allOOSTrades;
  const winners = trades.filter(trade => trade.pnl > 0);
  const losers = trades.filter(trade => trade.pnl <= 0);
  const avgWinner = winners.length > 0 ? winners.reduce((sum, trade) => sum + trade.pnl, 0) / winners.length : 0;
  const avgLoser = losers.length > 0 ? losers.reduce((sum, trade) => sum + trade.pnl, 0) / losers.length : 0;
  const mfeMae = trades.map(computeTradeMfeMae);
  const avgMfe = mfeMae.length > 0 ? mfeMae.reduce((sum, row) => sum + row.mfe, 0) / mfeMae.length : 0;
  const avgMae = mfeMae.length > 0 ? mfeMae.reduce((sum, row) => sum + row.mae, 0) / mfeMae.length : 0;

  const windowRows = result.windows.map(window => [
    `W${window.windowIndex}`,
    window.trainStart,
    window.oosStart,
    window.bestTrainSharpe.toFixed(2),
    window.oosSharpe.toFixed(2),
    formatCurrency(window.oosTrades.reduce((sum, trade) => sum + trade.pnl, 0)),
    formatWinRate(window.oosWinRate),
    String(window.oosTrades.length),
    formatDebitConfigLabel(window.bestConfig),
  ]);

  const tickerRows = [...new Set(trades.map(trade => trade.ticker))]
    .sort()
    .map(ticker => {
      const tickerTrades = trades.filter(trade => trade.ticker === ticker);
      const pnl = tickerTrades.reduce((sum, trade) => sum + trade.pnl, 0);
      const winRate = tickerTrades.filter(trade => trade.pnl > 0).length / Math.max(1, tickerTrades.length);
      return [ticker, String(tickerTrades.length), formatCurrency(pnl), formatPct(winRate)];
    });

  const bandRows = [
    '30_45',
    '60_75',
  ].map(band => {
    const bandWindows = result.windows.filter(window => `${window.bestConfig.debitDTERange[0]}_${window.bestConfig.debitDTERange[1]}` === band);
    const bandTrades = bandWindows.flatMap(window => window.oosTrades);
    const pnl = bandTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const sharpe = bandWindows.length > 0
      ? bandWindows.reduce((sum, window) => sum + window.oosSharpe, 0) / bandWindows.length
      : 0;
    return [band.replace('_', '-'), String(bandTrades.length), formatCurrency(pnl), sharpe.toFixed(2)];
  });

  return [
    '## Debit Spread',
    '',
    markdownTable(
      ['Metric', 'Value'],
      [
        ['OOS Sharpe', result.oosSharpe.toFixed(2)],
        ['OOS Total PnL', formatCurrency(result.oosTotalPnl)],
        ['OOS Win Rate', formatWinRate(result.oosWinRate)],
        ['OOS Max DD', formatMetricPct(result.oosMaxDD)],
        ['Trades', String(trades.length)],
        ['Avg Winner', formatCurrency(avgWinner)],
        ['Avg Loser', formatCurrency(avgLoser)],
        ['Avg MFE', formatCurrency(avgMfe)],
        ['Avg MAE', formatCurrency(avgMae)],
      ],
    ),
    '',
    '### Gate',
    summarizeGate(gate),
    '',
    '### Per Window',
    markdownTable(
      ['Window', 'Train Start', 'OOS Start', 'Train Sharpe', 'OOS Sharpe', 'OOS PnL', 'WR', 'Trades', 'Best Config'],
      windowRows,
    ),
    '',
    '### DTE Band Comparison',
    markdownTable(['Band', 'Trades', 'Total PnL', 'Avg Window Sharpe'], bandRows),
    '',
    '### Ticker Breakdown',
    markdownTable(['Ticker', 'Trades', 'Total PnL', 'Win Rate'], tickerRows),
  ].join('\n');
}

function buildReport(result: DirectionalPipelineResult): string {
  const sections = [
    '# Directional Swing Report',
    '',
    markdownTable(
      ['Config', 'Value'],
      [
        ['Strategy', result.config.strategy],
        ['Tickers', result.config.tickers.join(', ')],
        ['Date Range', `${result.config.startDate} -> ${result.config.endDate}`],
        ['Train/Step/Purge', `${result.config.trainWindowDays}/${result.config.forwardStepDays}/${result.config.purgeGapDays}`],
      ],
    ),
  ];
  if (result.underlying) sections.push('', buildUnderlyingReport(result.underlying.wfa, result.underlying.gate));
  if (result.debit) sections.push('', buildDebitReport(result.debit.wfa, result.debit.gate));
  return sections.join('\n');
}

function slimUnderlyingTrade(trade: UnderlyingTrade) {
  return {
    ticker: trade.ticker,
    direction: trade.direction,
    entryDate: trade.entryDate,
    exitDate: trade.exitDate,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    exitType: trade.exitType,
    pnlDollar: trade.pnlDollar,
    pnlPct: trade.pnlPct,
    holdDays: trade.holdDays,
    signalWeightPreset: trade.signalWeightPreset,
    windowIndex: trade.windowIndex,
    dailyMtM: trade.dailyMtM,
  };
}

function slimOptionTrade(trade: OptionTrade) {
  return {
    ticker: trade.ticker,
    direction: trade.direction,
    entryDate: trade.entryDate,
    exitDate: trade.exitDate,
    strike: trade.strike,
    longStrike: trade.longStrike,
    expiry: trade.expiry,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    entryDelta: trade.entryDelta,
    entryDTE: trade.entryDTE,
    exitDTE: trade.exitDTE,
    spreadWidth: trade.spreadWidth,
    maxProfit: trade.maxProfit,
    maxLoss: trade.maxLoss,
    exitType: trade.exitType,
    pnl: trade.pnl,
    pnlPct: trade.pnlPct,
    holdDays: trade.holdDays,
    repricingMethod: trade.repricingMethod,
    syntheticDays: trade.syntheticDays,
    dailyMtM: trade.dailyMtM,
  };
}

async function main() {
  const seed = parseInt(getArg('--seed') || '42', 10);
  const experimentPath = getArg('--experiment');
  const outFilename = getArg('--out');
  const smoke = hasFlag('--smoke');

  let config: DirectionalPipelineConfig = { ...DIRECTIONAL_DEFAULTS };
  if (experimentPath) {
    console.log(`Loading experiment config: ${experimentPath}`);
    const overrides = loadExperimentOverrides(experimentPath);
    config = deepMerge(config, overrides) as DirectionalPipelineConfig;
    console.log(`Experiment overrides applied: ${JSON.stringify(overrides, null, 2)}`);
  }

  if (smoke) {
    config.sweepOverrides = deepMerge(
      DIRECTIONAL_SWEEP_DEFAULTS as Record<string, any>,
      {
        underlyingExitEMAs: [21],
        underlyingExitConfirmDays: [2],
        underlyingMaxHoldDays: [20],
        debitDTERanges: [[30, 45]],
        debitLongDeltas: [0.5],
        debitShortDeltas: [0.2],
        debitProfitTargets: [0.5],
        debitExitEMAs: [21],
        debitExitConfirmDays: [2],
        debitMaxHoldDays: [20],
        debitMinExitDTEs: [14],
      },
    ) as Partial<DirectionalSweepDimensions>;
  }

  const startedAt = Date.now();
  const result = await runDirectionalPipeline(config);
  const elapsedMs = Date.now() - startedAt;

  const metadata = buildMetadata({
    profile: 'directional',
    cliArgs: args,
    seed,
    config: config as unknown as Record<string, unknown>,
    elapsedMs,
    cliScript: 'scripts/wfa-run-directional.ts',
  });

  const exportPayload = {
    metadata,
    config,
    allTradingDates: result.allTradingDates,
    ...(result.underlying ? {
      underlying: {
        gate: result.underlying.gate,
        wfa: {
          ...result.underlying.wfa,
          windows: result.underlying.wfa.windows.map(window => ({
            ...window,
            bestConfigLabel: formatUnderlyingConfigLabel(window.bestConfig),
            oosTrades: window.oosTrades.map(slimUnderlyingTrade),
          })),
          allOOSTrades: result.underlying.wfa.allOOSTrades.map(slimUnderlyingTrade),
        },
      },
    } : {}),
    ...(result.debit ? {
      debit: {
        gate: result.debit.gate,
        wfa: {
          ...result.debit.wfa,
          windows: result.debit.wfa.windows.map(window => ({
            ...window,
            bestConfigLabel: formatDebitConfigLabel(window.bestConfig),
            oosTrades: window.oosTrades.map(slimOptionTrade),
          })),
          allOOSTrades: result.debit.wfa.allOOSTrades.map(slimOptionTrade),
        },
      },
    } : {}),
  };

  const runsDir = path.resolve(__dirname, '../data/runs');
  if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
  const filename = outFilename || generateRunFilename('directional');
  const outPath = path.resolve(runsDir, filename);
  fs.writeFileSync(outPath, JSON.stringify(exportPayload, null, 2));

  const reportDir = path.resolve(__dirname, '../backtesting history/directional-swing/reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.resolve(reportDir, 'README.md');
  fs.writeFileSync(reportPath, buildReport(result));

  console.log(`Results saved to ${outPath}`);
  console.log(`Report written to ${reportPath}`);
  console.log(`Reproduce: ${metadata.cliCommand}`);

  closeDirectionalPipelineDB();
}

main().catch(error => {
  console.error('Fatal:', error);
  closeDirectionalPipelineDB();
  process.exit(1);
});
