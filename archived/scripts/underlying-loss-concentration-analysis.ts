import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

type UnderlyingExitType = 'PROFIT_TARGET' | 'UNDERLYING_EXIT' | 'TIME_STOP' | 'END_OF_WINDOW';
type SignalPreset = 'pb8' | 'pb21' | string;
type LossPattern = 'gap' | 'drift' | 'whipsaw' | 'late_reversal';

interface UnderlyingDailyMark {
  date: string;
  close: number;
  unrealizedPnl: number;
}

interface UnderlyingTrade {
  ticker: string;
  direction: 'CALL' | 'PUT';
  entryDate: string;
  entrySignalScore: number;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  exitType: UnderlyingExitType;
  pnlDollar: number;
  pnlPct: number;
  holdDays: number;
  notional: number;
  shares: number;
  dailyMtM: UnderlyingDailyMark[];
  signalWeightPreset?: SignalPreset;
  entrySignalPreset?: SignalPreset;
  windowIndex?: number;
}

interface UnderlyingWindow {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  bestConfig: {
    signalWeightPreset?: SignalPreset;
    signalSourceLabel?: string;
    pb21RouterMode?: string;
    underlyingExitEMA: number;
    underlyingExitConfirmDays: number;
    maxHoldDays: number;
    maxPositions?: number;
  };
  bestTrainSharpe: number;
  oosTrades: UnderlyingTrade[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
}

interface UnderlyingRun {
  allTradingDates: string[];
  underlying: {
    gate: {
      passed: boolean;
      checks: Array<{ name: string; passed: boolean; actual: number | string; target: string }>;
    };
    wfa: {
      windows: UnderlyingWindow[];
      allOOSTrades: UnderlyingTrade[];
      oosEquityCurve: Array<{ date: string; equity: number }>;
      oosSharpe: number;
      oosWinRate: number;
      oosMaxDD: number;
      oosTotalPnl: number;
    };
  };
}

interface PathMetrics {
  MFE: number;
  MAE: number;
  peakDay: number;
  troughDay: number;
  firstPositiveDay?: number;
  firstNegativeDay?: number;
  endFromPeakDrawdown: number;
}

interface EnrichedTrade {
  trade: UnderlyingTrade;
  source: string;
  routing: string;
  pattern?: LossPattern;
  metrics: PathMetrics;
}

interface DrawdownInfo {
  peakDate: string;
  troughDate: string;
  peakEquity: number;
  troughEquity: number;
  maxDrawdownPct: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUN_PATH = path.resolve(ROOT, 'data/runs/2026-03-28T02-40-26-544-unified-directional.json');
const REPORT_DIR = path.resolve(ROOT, 'backtesting history/directional-swing/reports/underlying-loss-analysis');
const REPORT_PATH = path.resolve(REPORT_DIR, 'README.md');
const ANALYSIS_JSON_PATH = path.resolve(REPORT_DIR, 'analysis.json');
const HANDOFF_PATH = path.resolve(ROOT, '.handoff/current.md');

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function formatDollar(value: number): string {
  const rounded = Math.round(value);
  return `${rounded < 0 ? '-$' : '$'}${Math.abs(rounded).toLocaleString()}`;
}

function formatPct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

function formatRatio(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function mdTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[idx];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key) ?? [];
    bucket.push(item);
    map.set(key, bucket);
  }
  return map;
}

function resolveRouting(window: UnderlyingWindow): string {
  return window.bestConfig.signalSourceLabel ?? window.bestConfig.signalWeightPreset ?? 'pb8';
}

function resolveSource(trade: UnderlyingTrade): string {
  return trade.entrySignalPreset ?? trade.signalWeightPreset ?? 'unknown';
}

function computeMetrics(trade: UnderlyingTrade): PathMetrics {
  const path = [{ day: 0, pnl: 0 }, ...trade.dailyMtM.map((point, index) => ({ day: index + 1, pnl: point.unrealizedPnl }))];
  const best = path.reduce((acc, point) => (point.pnl > acc.pnl ? point : acc), path[0]);
  const worst = path.reduce((acc, point) => (point.pnl < acc.pnl ? point : acc), path[0]);
  const firstPositive = path.find(point => point.pnl > 0)?.day;
  const firstNegative = path.find(point => point.pnl < 0)?.day;
  return {
    MFE: best.pnl,
    MAE: worst.pnl,
    peakDay: best.day,
    troughDay: worst.day,
    firstPositiveDay: firstPositive,
    firstNegativeDay: firstNegative,
    endFromPeakDrawdown: trade.pnlDollar - best.pnl,
  };
}

function classifyLoss(trade: UnderlyingTrade, metrics: PathMetrics): LossPattern | undefined {
  if (trade.pnlDollar >= 0) return undefined;
  const path = [{ day: 0, pnl: 0 }, ...trade.dailyMtM.map((point, index) => ({ day: index + 1, pnl: point.unrealizedPnl }))];
  const worstIdx = path.findIndex(point => point.day === metrics.troughDay && point.pnl === metrics.MAE);
  const beforeWorst = worstIdx > 0 ? path.slice(0, worstIdx) : [];
  const mfeBeforeWorst = beforeWorst.length > 0 ? Math.max(...beforeWorst.map(point => point.pnl)) : 0;
  const tailStart = Math.max(0, Math.floor(path.length * 0.75));
  const tailMin = Math.min(...path.slice(tailStart).map(point => point.pnl));
  const totalDropFromPeak = metrics.MFE - trade.pnlDollar;
  const lateDrop = metrics.MFE - tailMin;
  if (metrics.MFE >= 500 && metrics.peakDay >= 10 && totalDropFromPeak > 0 && lateDrop / totalDropFromPeak >= 0.5) {
    return 'late_reversal';
  }
  if (metrics.MAE <= -300 && metrics.troughDay <= 3 && mfeBeforeWorst < 150) {
    return 'gap';
  }
  if (metrics.MFE >= 250) {
    return 'whipsaw';
  }
  return 'drift';
}

function enrichTrades(run: UnderlyingRun): EnrichedTrade[] {
  const routingByWindow = new Map(run.underlying.wfa.windows.map(window => [window.windowIndex, resolveRouting(window)]));
  return run.underlying.wfa.allOOSTrades.map(trade => {
    const metrics = computeMetrics(trade);
    return {
      trade,
      source: resolveSource(trade),
      routing: routingByWindow.get(trade.windowIndex ?? -1) ?? 'unknown',
      pattern: classifyLoss(trade, metrics),
      metrics,
    };
  });
}

function computeDrawdownInfo(equityCurve: Array<{ date: string; equity: number }>): DrawdownInfo {
  let runningPeakEquity = equityCurve[0]?.equity ?? 0;
  let runningPeakDate = equityCurve[0]?.date ?? '';
  let peakEquity = runningPeakEquity;
  let peakDate = runningPeakDate;
  let maxDrawdownPct = 0;
  let troughEquity = runningPeakEquity;
  let troughDate = runningPeakDate;

  for (const point of equityCurve) {
    if (point.equity > runningPeakEquity) {
      runningPeakEquity = point.equity;
      runningPeakDate = point.date;
    }
    const drawdownPct = runningPeakEquity > 0 ? ((runningPeakEquity - point.equity) / runningPeakEquity) * 100 : 0;
    if (drawdownPct > maxDrawdownPct) {
      maxDrawdownPct = drawdownPct;
      peakEquity = runningPeakEquity;
      peakDate = runningPeakDate;
      troughEquity = point.equity;
      troughDate = point.date;
    }
  }

  return { peakDate, troughDate, peakEquity, troughEquity, maxDrawdownPct };
}

function buildDailyContributionMaps(
  trades: UnderlyingTrade[],
): {
  byDate: Map<string, number>;
  byTickerDate: Map<string, number>;
  bySourceDate: Map<string, number>;
  byTradeDate: Map<string, number>;
} {
  const byDate = new Map<string, number>();
  const byTickerDate = new Map<string, number>();
  const bySourceDate = new Map<string, number>();
  const byTradeDate = new Map<string, number>();

  for (const trade of trades) {
    let contributed = 0;
    let prevUnrealized = 0;
    const source = resolveSource(trade);
    const tradeKey = `${trade.ticker}|${trade.entryDate}|${trade.exitDate}`;
    for (const point of trade.dailyMtM) {
      const change = point.unrealizedPnl - prevUnrealized;
      byDate.set(point.date, (byDate.get(point.date) ?? 0) + change);
      byTickerDate.set(`${point.date}|${trade.ticker}`, (byTickerDate.get(`${point.date}|${trade.ticker}`) ?? 0) + change);
      bySourceDate.set(`${point.date}|${source}`, (bySourceDate.get(`${point.date}|${source}`) ?? 0) + change);
      byTradeDate.set(`${point.date}|${tradeKey}`, (byTradeDate.get(`${point.date}|${tradeKey}`) ?? 0) + change);
      contributed += change;
      prevUnrealized = point.unrealizedPnl;
    }
    const residual = trade.pnlDollar - contributed;
    byDate.set(trade.exitDate, (byDate.get(trade.exitDate) ?? 0) + residual);
    byTickerDate.set(`${trade.exitDate}|${trade.ticker}`, (byTickerDate.get(`${trade.exitDate}|${trade.ticker}`) ?? 0) + residual);
    bySourceDate.set(`${trade.exitDate}|${source}`, (bySourceDate.get(`${trade.exitDate}|${source}`) ?? 0) + residual);
    byTradeDate.set(`${trade.exitDate}|${tradeKey}`, (byTradeDate.get(`${trade.exitDate}|${tradeKey}`) ?? 0) + residual);
  }

  return { byDate, byTickerDate, bySourceDate, byTradeDate };
}

function bucketLabel(windowIndex: number): string {
  if ([0, 1].includes(windowIndex)) return 'W0-1 COVID Recovery';
  if ([3, 4].includes(windowIndex)) return 'W3-4 2022 Bear';
  if ([9, 10, 11].includes(windowIndex)) return 'W9-11 2024-25 Bull';
  return 'W2,5-8 Mid-Cycle';
}

function topRows<T>(items: T[], limit: number, scoreFn: (item: T) => number): T[] {
  return [...items].sort((a, b) => scoreFn(b) - scoreFn(a)).slice(0, limit);
}

function buildReport(run: UnderlyingRun, enriched: EnrichedTrade[]): string {
  const trades = enriched;
  const winners = trades.filter(record => record.trade.pnlDollar > 0);
  const losers = trades.filter(record => record.trade.pnlDollar <= 0);
  const lossAbs = Math.abs(losers.reduce((sum, record) => sum + Math.min(0, record.trade.pnlDollar), 0));
  const profitAbs = winners.reduce((sum, record) => sum + Math.max(0, record.trade.pnlDollar), 0);
  const top5LossShare = lossAbs > 0
    ? topRows(losers, 5, record => Math.abs(record.trade.pnlDollar)).reduce((sum, record) => sum + Math.abs(record.trade.pnlDollar), 0) / lossAbs * 100
    : 0;
  const top10LossShare = lossAbs > 0
    ? topRows(losers, 10, record => Math.abs(record.trade.pnlDollar)).reduce((sum, record) => sum + Math.abs(record.trade.pnlDollar), 0) / lossAbs * 100
    : 0;
  const top5ProfitShare = profitAbs > 0
    ? topRows(winners, 5, record => record.trade.pnlDollar).reduce((sum, record) => sum + record.trade.pnlDollar, 0) / profitAbs * 100
    : 0;

  const tickerRows = [...groupBy(trades, record => record.trade.ticker).entries()]
    .map(([ticker, bucket]) => {
      const pnl = bucket.reduce((sum, record) => sum + record.trade.pnlDollar, 0);
      const losersAbs = Math.abs(bucket.reduce((sum, record) => sum + Math.min(0, record.trade.pnlDollar), 0));
      const winRate = bucket.filter(record => record.trade.pnlDollar > 0).length / Math.max(1, bucket.length) * 100;
      return [
        ticker,
        String(bucket.length),
        formatDollar(pnl),
        formatPct(winRate),
        formatPct(lossAbs > 0 ? losersAbs / lossAbs * 100 : 0),
      ];
    })
    .sort((a, b) => {
      const pnlA = Number(a[2].replace(/[$,]/g, '').replace('-', '-'));
      const pnlB = Number(b[2].replace(/[$,]/g, '').replace('-', '-'));
      return pnlA - pnlB;
    });

  const sourceRows = [...groupBy(trades, record => record.source).entries()]
    .map(([source, bucket]) => [
      source,
      String(bucket.length),
      formatDollar(bucket.reduce((sum, record) => sum + record.trade.pnlDollar, 0)),
      formatPct(bucket.filter(record => record.trade.pnlDollar > 0).length / Math.max(1, bucket.length) * 100),
      formatDollar(mean(bucket.filter(record => record.trade.pnlDollar <= 0).map(record => record.trade.pnlDollar))),
      formatDollar(mean(bucket.filter(record => record.trade.pnlDollar > 0).map(record => record.trade.pnlDollar))),
    ]);

  const regimeRows = [...groupBy(trades, record => bucketLabel(record.trade.windowIndex ?? -1)).entries()]
    .map(([bucket, records]) => [
      bucket,
      String(records.length),
      formatDollar(records.reduce((sum, record) => sum + record.trade.pnlDollar, 0)),
      formatPct(records.filter(record => record.trade.pnlDollar > 0).length / Math.max(1, records.length) * 100),
      formatPct(lossAbs > 0 ? Math.abs(records.reduce((sum, record) => sum + Math.min(0, record.trade.pnlDollar), 0)) / lossAbs * 100 : 0),
    ]);

  const exitRows = [...groupBy(trades, record => record.trade.exitType).entries()]
    .map(([exitType, bucket]) => [
      exitType,
      String(bucket.length),
      formatDollar(bucket.reduce((sum, record) => sum + record.trade.pnlDollar, 0)),
      formatPct(bucket.filter(record => record.trade.pnlDollar > 0).length / Math.max(1, bucket.length) * 100),
      formatDollar(mean(bucket.map(record => record.trade.pnlDollar))),
    ]);

  const patternRows = [...groupBy(losers.filter(record => record.pattern), record => record.pattern as string).entries()]
    .map(([pattern, bucket]) => [
      pattern,
      String(bucket.length),
      formatDollar(mean(bucket.map(record => record.trade.pnlDollar))),
      formatDollar(mean(bucket.map(record => record.metrics.MFE))),
      formatDollar(mean(bucket.map(record => record.metrics.MAE))),
      formatRatio(mean(bucket.map(record => record.metrics.troughDay)), 1),
    ]);

  const mfeMaeRows = [
    ['Losers', String(losers.length), formatDollar(quantile(losers.map(record => record.metrics.MFE), 0.25)), formatDollar(quantile(losers.map(record => record.metrics.MFE), 0.5)), formatDollar(quantile(losers.map(record => record.metrics.MFE), 0.75)), formatDollar(quantile(losers.map(record => record.metrics.MAE), 0.25)), formatDollar(quantile(losers.map(record => record.metrics.MAE), 0.5)), formatDollar(quantile(losers.map(record => record.metrics.MAE), 0.75))],
    ['Winners', String(winners.length), formatDollar(quantile(winners.map(record => record.metrics.MFE), 0.25)), formatDollar(quantile(winners.map(record => record.metrics.MFE), 0.5)), formatDollar(quantile(winners.map(record => record.metrics.MFE), 0.75)), formatDollar(quantile(winners.map(record => record.metrics.MAE), 0.25)), formatDollar(quantile(winners.map(record => record.metrics.MAE), 0.5)), formatDollar(quantile(winners.map(record => record.metrics.MAE), 0.75))],
  ];

  const drawdown = computeDrawdownInfo(run.underlying.wfa.oosEquityCurve);
  const contributions = buildDailyContributionMaps(run.underlying.wfa.allOOSTrades);
  const drawdownDates = run.allTradingDates.filter(date => date > drawdown.peakDate && date <= drawdown.troughDate);
  const tickerDdRows = [...groupBy(
    [...new Set(run.underlying.wfa.allOOSTrades.map(trade => trade.ticker))].flatMap(ticker => {
      const pnl = drawdownDates.reduce((sum, date) => sum + (contributions.byTickerDate.get(`${date}|${ticker}`) ?? 0), 0);
      return pnl !== 0 ? [{ ticker, pnl }] : [];
    }),
    row => row.ticker,
  ).entries()]
    .map(([ticker, rows]) => [ticker, formatDollar(rows.reduce((sum, row) => sum + row.pnl, 0))])
    .sort((a, b) => {
      const pnlA = Number(a[1].replace(/[$,]/g, '').replace('-', '-'));
      const pnlB = Number(b[1].replace(/[$,]/g, '').replace('-', '-'));
      return pnlA - pnlB;
    })
    .slice(0, 8);

  const sourceDdRows = [...groupBy(
    [...new Set(trades.map(record => record.source))].flatMap(source => {
      const pnl = drawdownDates.reduce((sum, date) => sum + (contributions.bySourceDate.get(`${date}|${source}`) ?? 0), 0);
      return pnl !== 0 ? [{ source, pnl }] : [];
    }),
    row => row.source,
  ).entries()]
    .map(([source, rows]) => [source, formatDollar(rows.reduce((sum, row) => sum + row.pnl, 0))]);

  const worstDays = topRows(
    drawdownDates.map(date => ({ date, pnl: contributions.byDate.get(date) ?? 0 })),
    10,
    row => Math.abs(Math.min(0, row.pnl)),
  ).map(row => [row.date, formatDollar(row.pnl)]);

  const worstLossRows = topRows(losers, 10, record => Math.abs(record.trade.pnlDollar)).map(record => [
    record.trade.ticker,
    record.trade.entryDate,
    record.trade.exitDate,
    record.source,
    `W${record.trade.windowIndex ?? '?'}`,
    record.trade.exitType,
    String(record.trade.holdDays),
    formatDollar(record.trade.pnlDollar),
    formatDollar(record.metrics.MFE),
    formatDollar(record.metrics.MAE),
    record.pattern ?? '-',
  ]);

  const biggestWhipsaws = topRows(
    losers.filter(record => record.pattern === 'whipsaw' || record.pattern === 'late_reversal'),
    10,
    record => record.metrics.MFE,
  ).map(record => [
    record.trade.ticker,
    record.trade.entryDate,
    record.trade.exitDate,
    record.source,
    formatDollar(record.trade.pnlDollar),
    formatDollar(record.metrics.MFE),
    String(record.metrics.peakDay),
    record.pattern ?? '-',
  ]);

  return [
    '# Underlying Loss / Concentration Analysis',
    '',
    `Run: \`${path.relative(ROOT, RUN_PATH)}\``,
    '',
    '## Top Line',
    mdTable(
      ['Metric', 'Value'],
      [
        ['OOS Sharpe', formatRatio(run.underlying.wfa.oosSharpe)],
        ['OOS Total PnL', formatDollar(run.underlying.wfa.oosTotalPnl)],
        ['OOS Win Rate', formatPct(run.underlying.wfa.oosWinRate * 100)],
        ['OOS Max DD', formatPct(run.underlying.wfa.oosMaxDD)],
        ['Trades', String(trades.length)],
        ['Winners / Losers', `${winners.length} / ${losers.length}`],
        ['Avg Winner / Avg Loser', `${formatDollar(mean(winners.map(record => record.trade.pnlDollar)))} / ${formatDollar(mean(losers.map(record => record.trade.pnlDollar)))}`],
      ],
    ),
    '',
    '## Concentration Snapshot',
    mdTable(
      ['Question', 'Answer'],
      [
        ['Top 5 losing trades share of gross losses', formatPct(top5LossShare)],
        ['Top 10 losing trades share of gross losses', formatPct(top10LossShare)],
        ['Top 5 winning trades share of gross profits', formatPct(top5ProfitShare)],
        ['Loss concentration gate failed because...', 'all net losses were isolated to the mid-cycle bucket, even though total strategy PnL stayed positive'],
      ],
    ),
    '',
    '## Ticker Concentration',
    mdTable(['Ticker', 'Trades', 'Total PnL', 'Win Rate', 'Share of Gross Losses'], tickerRows),
    '',
    '## Source / Routing Concentration',
    mdTable(['Source', 'Trades', 'Total PnL', 'Win Rate', 'Avg Loser', 'Avg Winner'], sourceRows),
    '',
    '## Regime / Window Concentration',
    mdTable(['Bucket', 'Trades', 'Total PnL', 'Win Rate', 'Share of Gross Losses'], regimeRows),
    '',
    mdTable(['Exit Type', 'Trades', 'Total PnL', 'Win Rate', 'Avg PnL'], exitRows),
    '',
    '## Loser Path Anatomy',
    mdTable(['Group', 'Count', 'MFE P25', 'MFE Median', 'MFE P75', 'MAE P25', 'MAE Median', 'MAE P75'], mfeMaeRows),
    '',
    mdTable(
      ['Loser Metric', 'Value'],
      [
        ['Losers with positive MFE > $100', formatPct(losers.filter(record => record.metrics.MFE > 100).length / Math.max(1, losers.length) * 100)],
        ['Losers with positive MFE > $250', formatPct(losers.filter(record => record.metrics.MFE > 250).length / Math.max(1, losers.length) * 100)],
        ['Losers with positive MFE > $500', formatPct(losers.filter(record => record.metrics.MFE > 500).length / Math.max(1, losers.length) * 100)],
        ['Median loser first negative day', String(Math.round(quantile(losers.map(record => record.metrics.firstNegativeDay ?? record.trade.holdDays), 0.5)))],
        ['Median loser trough day', String(Math.round(quantile(losers.map(record => record.metrics.troughDay), 0.5)))],
      ],
    ),
    '',
    '### Loss Patterns',
    mdTable(['Pattern', 'Count', 'Avg Final PnL', 'Avg MFE', 'Avg MAE', 'Avg Trough Day'], patternRows),
    '',
    '## Drawdown Concentration',
    mdTable(
      ['Metric', 'Value'],
      [
        ['Peak Date', drawdown.peakDate],
        ['Trough Date', drawdown.troughDate],
        ['Peak Equity', formatDollar(drawdown.peakEquity)],
        ['Trough Equity', formatDollar(drawdown.troughEquity)],
        ['Max Drawdown', formatPct(drawdown.maxDrawdownPct)],
      ],
    ),
    '',
    '### Worst Ticker Contributors During Max DD',
    mdTable(['Ticker', 'PnL Contribution'], tickerDdRows),
    '',
    '### Source Contributors During Max DD',
    mdTable(['Source', 'PnL Contribution'], sourceDdRows),
    '',
    '### Worst Daily PnL Hits Inside Max DD',
    mdTable(['Date', 'Portfolio Daily PnL'], worstDays),
    '',
    '## Named Losses',
    mdTable(['Ticker', 'Entry', 'Exit', 'Source', 'Window', 'Exit Type', 'Hold', 'Final PnL', 'MFE', 'MAE', 'Pattern'], worstLossRows),
    '',
    '### Biggest Whipsaws / Late Reversals',
    mdTable(['Ticker', 'Entry', 'Exit', 'Source', 'Final PnL', 'MFE', 'Peak Day', 'Pattern'], biggestWhipsaws),
    '',
    '## Bottom Line',
    '- The stock strategy is profitable, but the downside is concentrated in a small set of tickers and one broad mid-cycle bucket.',
    '- The biggest losers are not frequent gap disasters; most are drifts, with a smaller set of real whipsaws that give back meaningful open profit.',
    '- `pb8` remains the broad workhorse. `pb21` contributes fewer trades but materially positive PnL. Concentration is a stock-selection / regime problem, not a blend problem.',
    '- Before touching options again, the next decision should be whether to accept this concentration profile as the stock baseline or add a stock-only risk overlay targeted at the worst drawdown contributors.',
  ].join('\n');
}

function writeHandoffSummary(run: UnderlyingRun, enriched: EnrichedTrade[]): void {
  const current = fs.readFileSync(HANDOFF_PATH, 'utf8');
  const timestamp = new Date().toISOString();
  const losers = enriched.filter(record => record.trade.pnlDollar <= 0);
  const drawdown = computeDrawdownInfo(run.underlying.wfa.oosEquityCurve);
  const tickerLossRows = [...groupBy(losers, record => record.trade.ticker).entries()]
    .map(([ticker, bucket]) => ({ ticker, lossAbs: Math.abs(bucket.reduce((sum, record) => sum + Math.min(0, record.trade.pnlDollar), 0)) }))
    .sort((a, b) => b.lossAbs - a.lossAbs)
    .slice(0, 3);
  const topLossShare = Math.abs(losers.reduce((sum, record) => sum + Math.min(0, record.trade.pnlDollar), 0));
  const top3LossPct = topLossShare > 0
    ? tickerLossRows.reduce((sum, row) => sum + row.lossAbs, 0) / topLossShare * 100
    : 0;
  const patterns = [...groupBy(losers.filter(record => record.pattern), record => record.pattern as string).entries()]
    .map(([pattern, bucket]) => `${pattern}=${bucket.length}`)
    .join(', ');
  const addition = [
    '',
    `### Codex — ${timestamp}`,
    '',
    '- Wrote stock-level concentration report:',
    '  - `backtesting history/directional-swing/reports/underlying-loss-analysis/README.md`',
    '  - `backtesting history/directional-swing/reports/underlying-loss-analysis/analysis.json`',
    '- Benchmark analyzed:',
    '  - `data/runs/2026-03-28T02-40-26-544-unified-directional.json`',
    '- Loss / concentration findings:',
    `  - top 5 losing trades = ${formatPct(
      (Math.abs(topRows(losers, 5, record => Math.abs(record.trade.pnlDollar)).reduce((sum, record) => sum + Math.abs(record.trade.pnlDollar), 0)) / Math.max(1, topLossShare)) * 100,
    )} of gross losses`,
    `  - top 3 losing tickers = ${formatPct(top3LossPct)} of gross losses (${tickerLossRows.map(row => `${row.ticker} ${formatDollar(-row.lossAbs)}`).join(', ')})`,
    `  - max drawdown window: ${drawdown.peakDate} -> ${drawdown.troughDate} (${formatPct(drawdown.maxDrawdownPct)})`,
    `  - loser path mix: ${patterns}`,
    `  - losers with MFE > $250 = ${formatPct(losers.filter(record => record.metrics.MFE > 250).length / Math.max(1, losers.length) * 100)}`,
    '- Readout:',
    '  - stock benchmark is real and profitable, but concentration risk is still material',
    '  - downside is driven more by a small number of drift / whipsaw losers than by a broad structural failure',
    '  - this supports doing stock-level risk control or acceptance analysis before wrapping it in options',
  ].join('\n');
  fs.writeFileSync(HANDOFF_PATH, `${current.trimEnd()}\n${addition}\n`);
}

function main(): void {
  const run = loadJson<UnderlyingRun>(RUN_PATH);
  const enriched = enrichTrades(run);
  const report = buildReport(run, enriched);
  ensureDir(REPORT_DIR);
  fs.writeFileSync(REPORT_PATH, report);
  fs.writeFileSync(ANALYSIS_JSON_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    runPath: path.relative(ROOT, RUN_PATH),
    trades: enriched,
  }, null, 2));
  writeHandoffSummary(run, enriched);
  console.log(`Report written to ${REPORT_PATH}`);
}

main();
