import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { closeDB, getApiCallCount, initDB, resetApiCallCount } from '../src/lib/backtest/chain-cache';
import {
  computeOptionAnalytics,
  DEFAULT_LEAP_CONFIG,
  type EntrySignal,
  type OptionTrade,
  type SimConfig,
} from '../src/lib/backtest/option-sim';
import {
  buildWFAWindows,
  computePortfolioDailyMetrics,
  createConstraintState,
  evaluateConfiguredSignalsWithState,
  type ConfiguredSignal,
  type PortfolioConstraintState,
  type TradeEvaluator,
  type WindowDef,
} from '../src/lib/backtest/wfa-options';
import { loadDailyCandlesFromIntradayCache } from './wfa-local-cache';
import { makeDebitSpreadEvaluator, makeDiagonalEvaluator } from './autoresearch/worker';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_AT = '2026-05-07T00:00:00.000Z';

const WFA = {
  trainWindowDays: 252,
  forwardStepDays: 126,
  purgeGapDays: 10,
  mode: 'rolling' as const,
};
const HOLDOUT_COUNT = 5;
const DATA_START = '2017-01-01';
const WFA_START_FLOOR = '2018-01-01';
const DATA_END = '2026-02-28';

const BCD_CONFIG: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DEBIT_SPREAD',
  debitDTERange: [30, 60],
  debitLongDelta: 0.50,
  debitShortDelta: 0.20,
  debitProfitTargetPct: 0.50,
  debitMaxHoldDays: 45,
  debitMinExitDTE: 7,
  monitoringIntervalDays: 1,
  fillMode: 'bidask',
};

const PMCC_CONFIG: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DIAGONAL',
  diagLongDeltaRange: [0.70, 0.80],
  diagLongDTERange: [240, 300],
  diagShortDeltaRange: [0.20, 0.30],
  diagShortDTERange: [30, 45],
  diagLongProfitTarget: 0.60,
  diagLongStopLoss: 0.35,
  diagLongTimeStopDTE: 90,
  diagShortProfitTarget: 0.50,
  diagRollTriggerMoneyness: 0.02,
  monitoringIntervalDays: 1,
};

type StrategySpec = {
  id: 'bcd-qqq-wide-f1' | 'pmcc-qqq-pt60-f1';
  label: string;
  config: SimConfig;
  startingCapital: number;
  maxPositions: number;
  signalCadenceDays: number;
  signalScore: number;
  evaluatorFactory: (config: SimConfig) => TradeEvaluator;
};

export type StrategyValidationMetrics = {
  selectionTrades: number;
  selectionSharpe: number;
  selectionMaxDrawdownPct: number;
  selectionTotalPnl: number;
  selectionWinRate: number;
  holdoutTrades: number;
  holdoutSharpe: number;
  holdoutMaxDrawdownPct: number;
  holdoutTotalPnl: number;
  holdoutWinRate: number;
  holdoutSpyIR: number;
  holdoutSpyExcessAnnualized: number;
  noChainTrades: number;
  totalTrades: number;
};

type StrategyValidationResult = StrategyValidationMetrics & {
  id: string;
  label: string;
  decision: ValidationDecision;
  rationale: string[];
  exitSummary: Record<string, number>;
  windowSharpes: number[];
};

type ValidationDecision = 'blocked' | 'paper_candidate';

type InformationRatio = {
  ir: number;
  excessAnnualized: number;
  overlap: number;
};

type ArtifactRef = {
  path: string;
  sha256: string;
};

type ValidationReport = {
  generatedAt: string;
  mode: 'cache-only';
  ticker: 'QQQ';
  benchmark: 'SPY';
  dataStart: string;
  dataEnd: string;
  wfa: typeof WFA & { holdoutCount: number; wfaStartDate: string };
  ranges: {
    selectionOOS: [string, string];
    holdoutOOS: [string, string];
  };
  cacheArtifacts: {
    dataCoverage?: ArtifactRef;
    cacheQuality?: ArtifactRef;
  };
  apiCallsObserved: number;
  results: StrategyValidationResult[];
};

export function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function summarizeTradeExits(trades: Array<{ exitType?: string | null }>): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const trade of trades) {
    const key = trade.exitType ?? 'UNKNOWN';
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

export function computeInformationRatio(
  strategyReturns: number[],
  strategyDates: string[],
  benchmarkReturnsByDate: Map<string, number>,
  minOverlap = 20,
): InformationRatio {
  const excess: number[] = [];
  for (let index = 0; index < strategyDates.length; index++) {
    const benchmarkReturn = benchmarkReturnsByDate.get(strategyDates[index]);
    if (benchmarkReturn == null) continue;
    excess.push((strategyReturns[index] ?? 0) - benchmarkReturn);
  }

  if (excess.length < minOverlap) {
    return { ir: 0, excessAnnualized: 0, overlap: excess.length };
  }

  const mean = excess.reduce((sum, value) => sum + value, 0) / excess.length;
  const variance = excess.reduce((sum, value) => sum + (value - mean) ** 2, 0) / excess.length;
  const std = Math.sqrt(variance);
  return {
    ir: std > 0 ? (mean / std) * Math.sqrt(252) : 0,
    excessAnnualized: mean * 252,
    overlap: excess.length,
  };
}

export function classifyValidationDecision(metrics: StrategyValidationMetrics): {
  decision: ValidationDecision;
  rationale: string[];
} {
  const rationale: string[] = [];
  if (metrics.totalTrades < 12) rationale.push('too few total trades for a governed read');
  if (metrics.holdoutTrades < 5) rationale.push('too few holdout trades');
  if (metrics.selectionSharpe <= 0) rationale.push('selection Sharpe is non-positive');
  if (metrics.holdoutSharpe <= 0) rationale.push('holdout Sharpe is non-positive');
  if (metrics.holdoutSpyIR <= 0) rationale.push('holdout SPY information ratio is non-positive');
  if (metrics.noChainTrades > 0) rationale.push('NO_CHAIN exits observed');

  if (rationale.length > 0) return { decision: 'blocked', rationale };
  return {
    decision: 'paper_candidate',
    rationale: ['passes minimum clean-sheet statistical gates; live trading remains separately blocked by governance'],
  };
}

function latestArtifact(dir: string, suffix: string): ArtifactRef | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const candidates = fs.readdirSync(dir)
    .filter(name => name.endsWith(suffix))
    .sort();
  const latest = candidates[candidates.length - 1];
  if (!latest) return undefined;
  const fullPath = path.join(dir, latest);
  return {
    path: path.relative(ROOT_DIR, fullPath),
    sha256: sha256File(fullPath),
  };
}

function buildSignals(allDates: string[], spec: StrategySpec): EntrySignal[] {
  const signals: EntrySignal[] = [];
  for (let index = 60; index < allDates.length; index += spec.signalCadenceDays) {
    signals.push({
      ticker: 'QQQ',
      date: allDates[index],
      direction: 'CALL',
      score: spec.signalScore,
    });
  }
  return signals;
}

function benchmarkReturnsByDate(candles: Array<{ date: string; close: number }>): Map<string, number> {
  const returns = new Map<string, number>();
  for (let index = 1; index < candles.length; index++) {
    const previousClose = candles[index - 1].close;
    const close = candles[index].close;
    returns.set(candles[index].date, previousClose > 0 ? close / previousClose - 1 : 0);
  }
  return returns;
}

function runStrategy(options: {
  spec: StrategySpec;
  allDates: string[];
  windows: WindowDef[];
  selectionWindows: WindowDef[];
  holdoutWindows: WindowDef[];
  benchmarkReturns: Map<string, number>;
}): StrategyValidationResult {
  const { spec, allDates, windows, selectionWindows, holdoutWindows, benchmarkReturns } = options;
  const evaluator = spec.evaluatorFactory(spec.config);
  const executionConfig = {
    maxPositions: spec.maxPositions,
    maxPerTicker: 1,
    startingCapital: spec.startingCapital,
  };
  const signals = buildSignals(allDates, spec);
  const oosMaxDate = windows[windows.length - 1].oosEnd;
  let state: PortfolioConstraintState = createConstraintState();
  const trades: OptionTrade[] = [];
  const windowSharpes: number[] = [];

  for (const windowDef of windows) {
    const configuredSignals: ConfiguredSignal[] = signals
      .filter(signal => signal.date >= windowDef.oosStart && signal.date <= windowDef.oosEnd)
      .map(signal => ({ signal, config: spec.config }));
    const result = evaluateConfiguredSignalsWithState(
      configuredSignals,
      executionConfig,
      allDates,
      oosMaxDate,
      evaluator,
      state,
    );
    state = result.state;
    trades.push(...result.trades);
    const cumulative = computePortfolioDailyMetrics(
      trades,
      allDates,
      windowDef.oosStart,
      windowDef.oosEnd,
      spec.startingCapital,
    );
    windowSharpes.push(cumulative.sharpe);
  }

  const firstHoldoutStart = holdoutWindows[0].oosStart;
  const selectionTrades = trades.filter(trade => trade.entryDate < firstHoldoutStart);
  const holdoutTrades = trades.filter(trade => trade.entryDate >= firstHoldoutStart);
  const selectionStart = selectionWindows[0].oosStart;
  const selectionEnd = selectionWindows[selectionWindows.length - 1].oosEnd;
  const holdoutStart = holdoutWindows[0].oosStart;
  const holdoutEnd = holdoutWindows[holdoutWindows.length - 1].oosEnd;

  const selectionMetrics = computePortfolioDailyMetrics(
    trades,
    allDates,
    selectionStart,
    selectionEnd,
    spec.startingCapital,
  );
  const finalSelectionEquity = selectionMetrics.equityCurve.at(-1)?.equity ?? spec.startingCapital;
  const selectionPeak = Math.max(...selectionMetrics.equityCurve.map(point => point.equity), spec.startingCapital);
  const holdoutMetrics = computePortfolioDailyMetrics(
    trades,
    allDates,
    holdoutStart,
    holdoutEnd,
    spec.startingCapital,
    finalSelectionEquity,
    selectionPeak,
  );
  const selectionAnalytics = computeOptionAnalytics(selectionTrades, { allTradingDates: allDates });
  const holdoutAnalytics = computeOptionAnalytics(holdoutTrades, { allTradingDates: allDates });
  const holdoutIR = computeInformationRatio(
    holdoutMetrics.dailyReturns,
    holdoutMetrics.equityCurve.map(point => point.date),
    benchmarkReturns,
  );
  const exitSummary = summarizeTradeExits(trades);

  const metrics: StrategyValidationMetrics = {
    selectionTrades: selectionTrades.length,
    selectionSharpe: selectionMetrics.sharpe,
    selectionMaxDrawdownPct: selectionMetrics.maxDrawdownPct,
    selectionTotalPnl: selectionAnalytics.totalPnl,
    selectionWinRate: selectionAnalytics.winRate,
    holdoutTrades: holdoutTrades.length,
    holdoutSharpe: holdoutMetrics.sharpe,
    holdoutMaxDrawdownPct: holdoutMetrics.maxDrawdownPct,
    holdoutTotalPnl: holdoutAnalytics.totalPnl,
    holdoutWinRate: holdoutAnalytics.winRate,
    holdoutSpyIR: holdoutIR.ir,
    holdoutSpyExcessAnnualized: holdoutIR.excessAnnualized,
    noChainTrades: exitSummary.NO_CHAIN ?? 0,
    totalTrades: trades.length,
  };
  const classification = classifyValidationDecision(metrics);

  return {
    id: spec.id,
    label: spec.label,
    ...metrics,
    decision: classification.decision,
    rationale: classification.rationale,
    exitSummary,
    windowSharpes,
  };
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function roundedReport(report: ValidationReport): ValidationReport {
  return {
    ...report,
    results: report.results.map(result => ({
      ...result,
      selectionSharpe: round(result.selectionSharpe),
      selectionMaxDrawdownPct: round(result.selectionMaxDrawdownPct),
      selectionTotalPnl: round(result.selectionTotalPnl, 2),
      selectionWinRate: round(result.selectionWinRate, 2),
      holdoutSharpe: round(result.holdoutSharpe),
      holdoutMaxDrawdownPct: round(result.holdoutMaxDrawdownPct),
      holdoutTotalPnl: round(result.holdoutTotalPnl, 2),
      holdoutWinRate: round(result.holdoutWinRate, 2),
      holdoutSpyIR: round(result.holdoutSpyIR),
      holdoutSpyExcessAnnualized: round(result.holdoutSpyExcessAnnualized),
      windowSharpes: result.windowSharpes.map(value => round(value)),
    })),
  };
}

function markdownReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push('# QQQ clean-sheet validation results');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: ${report.mode}; observed API calls: ${report.apiCallsObserved}`);
  lines.push(`Data: ${report.dataStart} to ${report.dataEnd}`);
  lines.push(`Selection OOS: ${report.ranges.selectionOOS[0]} to ${report.ranges.selectionOOS[1]}`);
  lines.push(`Holdout OOS: ${report.ranges.holdoutOOS[0]} to ${report.ranges.holdoutOOS[1]}`);
  lines.push('');
  lines.push('## Cache evidence');
  lines.push('');
  for (const [name, artifact] of Object.entries(report.cacheArtifacts)) {
    if (!artifact) continue;
    lines.push(`- ${name}: \`${artifact.path}\` (${artifact.sha256})`);
  }
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| Strategy | Decision | Sel trades | Sel Sharpe | Sel DD | Hold trades | Hold Sharpe | Hold DD | Hold SPY IR | NO_CHAIN | Hold PnL |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const result of report.results) {
    lines.push([
      `| ${result.label}`,
      result.decision,
      result.selectionTrades,
      result.selectionSharpe.toFixed(2),
      `${result.selectionMaxDrawdownPct.toFixed(1)}%`,
      result.holdoutTrades,
      result.holdoutSharpe.toFixed(2),
      `${result.holdoutMaxDrawdownPct.toFixed(1)}%`,
      result.holdoutSpyIR.toFixed(2),
      result.noChainTrades,
      `$${result.holdoutTotalPnl.toFixed(0)} |`,
    ].join(' | '));
  }
  lines.push('');
  lines.push('## Decision notes');
  lines.push('');
  for (const result of report.results) {
    lines.push(`- ${result.label}: ${result.rationale.join('; ')}.`);
  }
  lines.push('');
  lines.push('Live deployment remains blocked unless a separate governance review explicitly promotes a paper candidate.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function buildCleanSheetValidationReport(): ValidationReport {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('QQQ clean-sheet validation is cache-only; fetch is disabled');
  }) as typeof fetch;

  resetApiCallCount();
  initDB(undefined, true);
  try {
    const qqqCandles = loadDailyCandlesFromIntradayCache({
      ticker: 'QQQ',
      startDate: DATA_START,
      endDate: DATA_END,
    });
    const spyCandles = loadDailyCandlesFromIntradayCache({
      ticker: 'SPY',
      startDate: DATA_START,
      endDate: DATA_END,
    });
    const allDates = qqqCandles.map(candle => candle.date).sort();
    const wfaStartDate = allDates.find(date => date >= WFA_START_FLOOR) ?? allDates[0];
    const allWindows = buildWFAWindows(allDates, {
      ...WFA,
      startDate: wfaStartDate,
      endDate: allDates[allDates.length - 1],
    });
    const selectionWindows = allWindows.slice(0, -HOLDOUT_COUNT);
    const holdoutWindows = allWindows.slice(-HOLDOUT_COUNT);
    if (selectionWindows.length === 0 || holdoutWindows.length !== HOLDOUT_COUNT) {
      throw new Error(`Insufficient WFA windows: ${selectionWindows.length} selection, ${holdoutWindows.length} holdout`);
    }

    const specs: StrategySpec[] = [
      {
        id: 'bcd-qqq-wide-f1',
        label: 'BCD QQQ wide F1',
        config: BCD_CONFIG,
        startingCapital: 2_000,
        maxPositions: 1,
        signalCadenceDays: 10,
        signalScore: 50,
        evaluatorFactory: makeDebitSpreadEvaluator,
      },
      {
        id: 'pmcc-qqq-pt60-f1',
        label: 'PMCC QQQ PT60 F1',
        config: PMCC_CONFIG,
        startingCapital: 10_000,
        maxPositions: 1,
        signalCadenceDays: 1,
        signalScore: 0,
        evaluatorFactory: makeDiagonalEvaluator,
      },
    ];
    const benchmarkReturns = benchmarkReturnsByDate(spyCandles);
    const windows = [...selectionWindows, ...holdoutWindows];
    const report: ValidationReport = {
      generatedAt: GENERATED_AT,
      mode: 'cache-only',
      ticker: 'QQQ',
      benchmark: 'SPY',
      dataStart: DATA_START,
      dataEnd: DATA_END,
      wfa: { ...WFA, holdoutCount: HOLDOUT_COUNT, wfaStartDate },
      ranges: {
        selectionOOS: [selectionWindows[0].oosStart, selectionWindows[selectionWindows.length - 1].oosEnd],
        holdoutOOS: [holdoutWindows[0].oosStart, holdoutWindows[holdoutWindows.length - 1].oosEnd],
      },
      cacheArtifacts: {
        dataCoverage: latestArtifact(path.join(ROOT_DIR, 'docs/data-coverage'), '-cache-only-coverage.json'),
        cacheQuality: latestArtifact(path.join(ROOT_DIR, 'docs/data-quality'), '-wfa-cache-quality.json'),
      },
      apiCallsObserved: 0,
      results: specs.map(spec => runStrategy({
        spec,
        allDates,
        windows,
        selectionWindows,
        holdoutWindows,
        benchmarkReturns,
      })),
    };
    report.apiCallsObserved = getApiCallCount();
    return roundedReport(report);
  } finally {
    globalThis.fetch = originalFetch;
    closeDB();
  }
}

function writeReport(report: ValidationReport): { jsonPath: string; markdownPath: string } {
  const jsonPath = path.join(ROOT_DIR, 'data/runs/qqq-clean-sheet-validation-2026-05-07.json');
  const markdownPath = path.join(ROOT_DIR, 'docs/wfa/QQQ-CLEAN-SHEET-VALIDATION-RESULTS-2026-05-07.md');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, markdownReport(report));
  return { jsonPath, markdownPath };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const report = buildCleanSheetValidationReport();
  const paths = writeReport(report);
  console.log(`Wrote ${path.relative(ROOT_DIR, paths.jsonPath)}`);
  console.log(`Wrote ${path.relative(ROOT_DIR, paths.markdownPath)}`);
  for (const result of report.results) {
    console.log(`${result.label}: ${result.decision} · holdout Sharpe ${result.holdoutSharpe.toFixed(2)} · SPY IR ${result.holdoutSpyIR.toFixed(2)} · NO_CHAIN ${result.noChainTrades}`);
  }
}
