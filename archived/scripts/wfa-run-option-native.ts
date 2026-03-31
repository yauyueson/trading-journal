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
  OPTION_NATIVE_DEFAULTS,
  closeOptionNativePipelineDB,
  formatSwingLongConfigLabel,
  runOptionNativePipeline,
  type OptionNativePipelineConfig,
  type OptionNativeResult,
} from './wfa-pipeline-option-native';
import { buildMetadata, generateRunFilename } from './wfa-metadata';

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
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

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function summarizeGate(result: OptionNativeResult): string {
  return result.gate.checks.map(check => {
    const actual = typeof check.actual === 'number'
      ? (Math.abs(check.actual) < 10 ? check.actual.toFixed(2) : String(Math.round(check.actual)))
      : String(check.actual);
    return `- ${check.name}: ${check.passed ? 'PASS' : 'FAIL'} (${actual} vs ${check.target})`;
  }).join('\n');
}

function buildRegimeRows(result: OptionNativeResult): string[][] {
  const buckets = [
    { label: 'W0-1 COVID Recovery', indices: [0, 1] },
    { label: 'W2,5-8 Mid-Cycle', indices: [2, 5, 6, 7, 8] },
    { label: 'W3-4 2022 Bear', indices: [3, 4] },
    { label: 'W9-11 2024-25 Bull', indices: [9, 10, 11] },
  ];
  return buckets.map(bucket => {
    const bucketWindows = result.windows.filter(window => bucket.indices.includes(window.windowIndex));
    const trades = bucketWindows.flatMap(window => window.oosTrades);
    const totalPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
    const avgSharpe = bucketWindows.length > 0
      ? bucketWindows.reduce((sum, window) => sum + window.oosSharpe, 0) / bucketWindows.length
      : 0;
    const shadowPnl = bucketWindows.reduce((sum, window) => sum + window.shadowTotalPnl, 0);
    return [
      bucket.label,
      String(trades.length),
      formatCurrency(totalPnl),
      formatCurrency(shadowPnl),
      avgSharpe.toFixed(2),
    ];
  });
}

function buildReport(result: OptionNativeResult): string {
  const analyticsRows = [
    ['Stage', result.config.stage],
    ['OOS Sharpe', result.oosSharpe.toFixed(2)],
    ['OOS Total PnL', formatCurrency(result.oosTotalPnl)],
    ['OOS Win Rate', formatPct(result.oosWinRate / 100)],
    ['OOS Max DD', formatMetricPct(result.oosMaxDD)],
    ['Trades', String(result.allOOSTrades.length)],
    ['Shadow Sharpe', result.shadowSummary.sharpe.toFixed(2)],
    ['Shadow Total PnL', formatCurrency(result.shadowSummary.totalPnl)],
    ['Wrapper Cost Drag', formatCurrency(result.shadowSummary.costDrag)],
  ];

  const windowRows = result.windows.map(window => [
    `W${window.windowIndex}`,
    window.trainStart,
    window.oosStart,
    window.bestTrainSharpe.toFixed(2),
    window.oosSharpe.toFixed(2),
    formatCurrency(window.oosTotalPnl),
    formatCurrency(window.shadowTotalPnl),
    String(window.oosTrades.length),
    formatSwingLongConfigLabel(window.bestConfig),
  ]);

  const dteRows = Object.entries(result.shadowSummary.byDteBand)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([band, row]) => [
      band,
      formatCurrency(row.optionPnl),
      formatCurrency(row.shadowPnl),
      formatCurrency(row.costDrag),
    ]);

  const deltaBuckets = new Map<string, { trades: number; pnl: number }>();
  for (const trade of result.allOOSTrades) {
    const bucket = `${Math.round((trade.entryDelta - 0.05) * 100)}_${Math.round((trade.entryDelta + 0.05) * 100)}`;
    const current = deltaBuckets.get(bucket) ?? { trades: 0, pnl: 0 };
    current.trades += 1;
    current.pnl += trade.pnl;
    deltaBuckets.set(bucket, current);
  }
  const deltaRows = [...deltaBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, row]) => [bucket, String(row.trades), formatCurrency(row.pnl)]);

  const tickerRows = Object.entries(result.shadowSummary.byTicker)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ticker, row]) => [
      ticker,
      formatCurrency(row.optionPnl),
      formatCurrency(row.shadowPnl),
      formatCurrency(row.costDrag),
    ]);

  const skipRows = [
    ['Accepted Trades', String(result.diagnostics.acceptedTrades)],
    ['Portfolio Capacity Skips', String(result.diagnostics.portfolioCapacitySkips)],
    ['Portfolio Premium Cap Skips', String(result.diagnostics.portfolioPremiumCapSkips)],
    ...Object.entries(result.diagnostics.skippedByReason)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => [reason, String(count)]),
  ];

  const spreadRows = [
    ['Fill Rate', formatPct(result.diagnostics.fillRate)],
    ['Median Entry Spread %', formatPct(result.diagnostics.medianEntrySpreadPct)],
    ['P75 Entry Spread %', formatPct(result.diagnostics.p75EntrySpreadPct)],
    ['Median Entry OI', String(Math.round(median(result.diagnostics.entryOIs)))],
    ['Synthetic Mark Rate', formatPct(result.diagnostics.syntheticMarkPct)],
  ];

  const deltaDrifts = result.allOOSTrades.map(trade => {
    const entryAbsDelta = Math.abs(trade.entryDelta);
    const peakDrift = Math.max(
      0,
      ...(trade.dailyDiagnostics ?? []).map(point => Math.abs(Math.abs(point.delta ?? entryAbsDelta) - entryAbsDelta)),
    );
    return peakDrift;
  });
  const deltaDriftRows = [
    ['Avg Peak |Delta Drift|', deltaDrifts.length > 0 ? deltaDrifts.reduce((sum, value) => sum + value, 0) / deltaDrifts.length : 0]
      .map((value, index) => index === 0 ? value : Number(value).toFixed(2)) as string[],
    ['% Trades Peak Drift >= 0.15', formatPct(deltaDrifts.filter(value => value >= 0.15).length / Math.max(1, deltaDrifts.length))],
  ];

  return [
    '# Option-Native Swing Report',
    '',
    '## Top Line',
    markdownTable(['Metric', 'Value'], analyticsRows),
    '',
    '## Gate',
    summarizeGate(result),
    '',
    '## Per Window',
    markdownTable(
      ['Window', 'Train Start', 'OOS Start', 'Train Sharpe', 'OOS Sharpe', 'Option PnL', 'Shadow PnL', 'Trades', 'Best Config'],
      windowRows,
    ),
    '',
    '## DTE Band Comparison',
    markdownTable(['Band', 'Option PnL', 'Shadow PnL', 'Cost Drag'], dteRows),
    '',
    '## Delta Band Comparison',
    markdownTable(['Entry Delta Bucket', 'Trades', 'Option PnL'], deltaRows),
    '',
    '## Ticker Breakdown',
    markdownTable(['Ticker', 'Option PnL', 'Shadow PnL', 'Cost Drag'], tickerRows),
    '',
    '## Regime Breakdown',
    markdownTable(['Bucket', 'Trades', 'Option PnL', 'Shadow PnL', 'Avg OOS Sharpe'], buildRegimeRows(result)),
    '',
    '## Fill / Skip Breakdown',
    markdownTable(['Metric', 'Value'], skipRows),
    '',
    '## Spread / OI / Synthetic',
    markdownTable(['Metric', 'Value'], spreadRows),
    '',
    '## Delta Drift',
    markdownTable(['Metric', 'Value'], deltaDriftRows),
    '',
    '## Wrapper vs Shadow',
    markdownTable(
      ['Metric', 'Value'],
      [
        ['Option PnL', formatCurrency(result.oosTotalPnl)],
        ['Shadow PnL', formatCurrency(result.shadowSummary.totalPnl)],
        ['Cost Drag', formatCurrency(result.shadowSummary.costDrag)],
        ['Avg Cost Drag / Trade', formatCurrency(result.shadowSummary.avgCostDragPerTrade)],
        ['Option Sharpe', result.oosSharpe.toFixed(2)],
        ['Shadow Sharpe', result.shadowSummary.sharpe.toFixed(2)],
      ],
    ),
    '',
    '## Final Verdict',
    result.gate.passed
      ? 'The option wrapper passed the current stage gate and remains worth refining.'
      : 'The option wrapper failed the current stage gate. On the current evidence, the stock benchmark remains the cleaner expression of the edge.',
  ].join('\n');
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function main(): Promise<void> {
  const experimentPath = getArg('--experiment');
  const overrides = experimentPath ? loadExperimentOverrides(experimentPath) : {};
  const pipelineConfig = deepMerge(OPTION_NATIVE_DEFAULTS as Record<string, any>, overrides) as OptionNativePipelineConfig;

  console.log('WFA Option-Native — Swing Long Options');
  console.log('─'.repeat(60));
  console.log(`Stage: ${pipelineConfig.stage}`);
  console.log(`Tickers: ${pipelineConfig.tickers.join(', ')}`);

  const result = await runOptionNativePipeline(pipelineConfig);

  const reportDir = path.resolve(process.cwd(), 'backtesting history/option-native-swing/reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'README.md');
  const sidecarPath = path.join(reportDir, 'full-trades.json');
  fs.writeFileSync(reportPath, buildReport(result));
  fs.writeFileSync(sidecarPath, JSON.stringify({
    config: result.config,
    diagnostics: result.diagnostics,
    shadowSummary: result.shadowSummary,
    trades: result.allOOSTrades,
    shadowTrades: result.shadowTrades,
  }, null, 2));

  const metadata = buildMetadata({
    profile: 'option-native',
    cliArgs: args,
    seed: 42,
    config: pipelineConfig as unknown as Record<string, unknown>,
    elapsedMs: result.elapsedMs,
    cliScript: 'scripts/wfa-run-option-native.ts',
  });
  const runPayload = {
    metadata,
    summary: {
      oosSharpe: result.oosSharpe,
      oosTotalPnl: result.oosTotalPnl,
      oosWinRate: result.oosWinRate,
      oosMaxDD: result.oosMaxDD,
      shadowSharpe: result.shadowSummary.sharpe,
      shadowTotalPnl: result.shadowSummary.totalPnl,
      costDrag: result.shadowSummary.costDrag,
      gatePassed: result.gate.passed,
    },
    gate: result.gate,
    diagnostics: result.diagnostics,
    windows: result.windows.map(window => ({
      windowIndex: window.windowIndex,
      trainStart: window.trainStart,
      trainEnd: window.trainEnd,
      oosStart: window.oosStart,
      oosEnd: window.oosEnd,
      bestConfigLabel: formatSwingLongConfigLabel(window.bestConfig),
      bestTrainSharpe: window.bestTrainSharpe,
      oosSharpe: window.oosSharpe,
      oosTrades: window.oosTrades.length,
      oosTotalPnl: window.oosTotalPnl,
      shadowTotalPnl: window.shadowTotalPnl,
    })),
  };

  const runsDir = path.resolve(process.cwd(), 'data/runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const runPath = path.join(runsDir, generateRunFilename('option-native'));
  fs.writeFileSync(runPath, JSON.stringify(runPayload, null, 2));

  console.log(`\nOOS Sharpe: ${result.oosSharpe.toFixed(2)}`);
  console.log(`OOS Total PnL: ${formatCurrency(result.oosTotalPnl)}`);
  console.log(`Shadow PnL: ${formatCurrency(result.shadowSummary.totalPnl)}`);
  console.log(`Wrapper Cost Drag: ${formatCurrency(result.shadowSummary.costDrag)}`);
  console.log(`Gate: ${result.gate.passed ? 'PASS' : 'FAIL'}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Run: ${runPath}`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeOptionNativePipelineDB();
  });
