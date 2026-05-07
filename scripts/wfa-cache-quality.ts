import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

export type WFAProfile = 'swing' | 'short';

export type WFACacheQualityTicker = {
  ticker: string;
  candleDates: number;
  firstCandleDate: string | null;
  lastCandleDate: string | null;
  ivProxyDates: number;
  firstIVProxyDate: string | null;
  lastIVProxyDate: string | null;
  ivProxyCoveragePct: number;
  stale: boolean;
  failures: string[];
};

export type WFACacheQualityReport = {
  generatedAt: string;
  profile: WFAProfile;
  mode: 'local-cache-only';
  decision: 'pass' | 'blocked';
  thresholds: {
    minCandleDates: number;
    minIVProxyCoveragePct: number;
    maxStaleCalendarDays: number;
  };
  request: {
    tickers: string[];
    dataStart: string;
    endDate: string;
  };
  caches: {
    intradayDbPath: string;
    chainDbPath: string;
  };
  tickers: WFACacheQualityTicker[];
  failures: string[];
};

export type WFACacheQualityArtifactWrite = {
  path: string;
  sha256: string;
};

function defaultRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function defaultIntradayDbPath(repoRoot: string): string {
  return path.resolve(repoRoot, 'data/intraday-candles.sqlite');
}

function defaultChainDbPath(repoRoot: string): string {
  return path.resolve(repoRoot, 'data/option-chains.sqlite');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function calendarGapDays(lastDate: string | null, endDate: string): number {
  if (!lastDate) return Number.POSITIVE_INFINITY;
  const last = new Date(`${lastDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((end - last) / 86_400_000));
}

function readCandleCoverage(options: {
  db: Database.Database;
  ticker: string;
  dataStart: string;
  endDate: string;
  profile: WFAProfile;
}): { count: number; firstDate: string | null; lastDate: string | null } {
  const table = options.profile === 'short' ? 'candles_130m' : 'candles_1h';
  return options.db.prepare(`
    SELECT COUNT(DISTINCT date) AS count,
           MIN(date) AS firstDate,
           MAX(date) AS lastDate
    FROM ${table}
    WHERE ticker = ?
      AND date >= ?
      AND date <= ?
  `).get(options.ticker, options.dataStart, options.endDate) as {
    count: number;
    firstDate: string | null;
    lastDate: string | null;
  };
}

function readIVProxyCoverage(options: {
  db: Database.Database;
  ticker: string;
  dataStart: string;
  endDate: string;
}): { count: number; firstDate: string | null; lastDate: string | null } {
  return options.db.prepare(`
    SELECT COUNT(*) AS count,
           MIN(date) AS firstDate,
           MAX(date) AS lastDate
    FROM (
      SELECT trade_date AS date,
             MIN(CASE WHEN ABS(dte - 30) <= 10 AND (call_iv IS NOT NULL OR put_iv IS NOT NULL) THEN ABS(dte - 30) END) AS near30,
             MIN(CASE WHEN ABS(dte - 60) <= 10 AND (call_iv IS NOT NULL OR put_iv IS NOT NULL) THEN ABS(dte - 60) END) AS near60
      FROM option_chains
      WHERE ticker = ?
        AND trade_date >= ?
        AND trade_date <= ?
        AND dte BETWEEN 20 AND 70
      GROUP BY trade_date
      HAVING near30 IS NOT NULL AND near60 IS NOT NULL
    )
  `).get(options.ticker, options.dataStart, options.endDate) as {
    count: number;
    firstDate: string | null;
    lastDate: string | null;
  };
}

export function buildWFACacheQualityReport(options: {
  repoRoot?: string;
  profile: WFAProfile;
  tickers: string[];
  dataStart: string;
  endDate: string;
  intradayDbPath?: string;
  chainDbPath?: string;
  generatedAt?: string;
  minCandleDates?: number;
  minIVProxyCoveragePct?: number;
  maxStaleCalendarDays?: number;
}): WFACacheQualityReport {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const intradayDbPath = options.intradayDbPath ?? defaultIntradayDbPath(repoRoot);
  const chainDbPath = options.chainDbPath ?? defaultChainDbPath(repoRoot);
  const minCandleDates = options.minCandleDates ?? 1;
  const minIVProxyCoveragePct = options.minIVProxyCoveragePct ?? 80;
  const maxStaleCalendarDays = options.maxStaleCalendarDays ?? 3;

  if (!fs.existsSync(intradayDbPath)) {
    throw new Error(`WFA cache quality requires local intraday cache: ${intradayDbPath}`);
  }
  if (!fs.existsSync(chainDbPath)) {
    throw new Error(`WFA cache quality requires local option-chain cache: ${chainDbPath}`);
  }

  const intradayDb = new Database(intradayDbPath, { readonly: true });
  const chainDb = new Database(chainDbPath, { readonly: true });
  try {
    const tickers = options.tickers.map(ticker => {
      const candle = readCandleCoverage({
        db: intradayDb,
        ticker,
        dataStart: options.dataStart,
        endDate: options.endDate,
        profile: options.profile,
      });
      const iv = readIVProxyCoverage({
        db: chainDb,
        ticker,
        dataStart: options.dataStart,
        endDate: options.endDate,
      });
      const ivProxyCoveragePct = pct(Number(iv.count ?? 0), Number(candle.count ?? 0));
      const stale = calendarGapDays(candle.lastDate, options.endDate) > maxStaleCalendarDays ||
        calendarGapDays(iv.lastDate, options.endDate) > maxStaleCalendarDays;
      const failures: string[] = [];

      if (Number(candle.count ?? 0) < minCandleDates) {
        failures.push(`insufficient candle dates (${Number(candle.count ?? 0)} < ${minCandleDates})`);
      }
      if (stale) failures.push(`stale cache before ${options.endDate}`);
      if (ivProxyCoveragePct < minIVProxyCoveragePct) {
        failures.push(`IV proxy coverage ${ivProxyCoveragePct}% < ${minIVProxyCoveragePct}%`);
      }

      return {
        ticker,
        candleDates: Number(candle.count ?? 0),
        firstCandleDate: candle.firstDate,
        lastCandleDate: candle.lastDate,
        ivProxyDates: Number(iv.count ?? 0),
        firstIVProxyDate: iv.firstDate,
        lastIVProxyDate: iv.lastDate,
        ivProxyCoveragePct,
        stale,
        failures,
      };
    });
    const failures = tickers.flatMap(ticker =>
      ticker.failures.map(failure => `${ticker.ticker}: ${failure}`),
    );

    return {
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      profile: options.profile,
      mode: 'local-cache-only',
      decision: failures.length > 0 ? 'blocked' : 'pass',
      thresholds: { minCandleDates, minIVProxyCoveragePct, maxStaleCalendarDays },
      request: {
        tickers: options.tickers,
        dataStart: options.dataStart,
        endDate: options.endDate,
      },
      caches: { intradayDbPath, chainDbPath },
      tickers,
      failures,
    };
  } finally {
    intradayDb.close();
    chainDb.close();
  }
}

export function validateWFACacheQuality(report: WFACacheQualityReport): void {
  if (report.decision !== 'pass') {
    throw new Error(`WFA cache quality gate failed: ${report.failures.join('; ')}`);
  }
}

export function writeWFACacheQualityArtifact(
  report: WFACacheQualityReport,
  options: { outputDir?: string } = {},
): WFACacheQualityArtifactWrite {
  const outputDir = options.outputDir ?? path.resolve(defaultRepoRoot(), 'docs/data-quality');
  const date = report.generatedAt.slice(0, 10);
  const filePath = path.join(outputDir, `${date}-wfa-cache-quality.json`);
  const payload = {
    artifact: {
      schemaVersion: 1,
      generatedBy: 'scripts/wfa-cache-quality.ts',
      decision: report.decision,
      mode: report.mode,
    },
    report,
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, json);
  return {
    path: filePath,
    sha256: sha256Text(json),
  };
}

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

export function formatWFACacheQualityReport(report: WFACacheQualityReport): string {
  const lines: string[] = [];
  lines.push('WFA Cache Quality Report');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Decision: ${report.decision.toUpperCase()}`);
  lines.push(`Profile: ${report.profile}`);
  lines.push(`Window: ${report.request.dataStart} -> ${report.request.endDate}`);
  lines.push(`Thresholds: min candles ${report.thresholds.minCandleDates}, IV proxy ${report.thresholds.minIVProxyCoveragePct}%`);
  lines.push('');
  for (const ticker of report.tickers) {
    lines.push(
      `- ${ticker.ticker}: candles ${ticker.candleDates} (${ticker.firstCandleDate ?? 'n/a'} -> ${ticker.lastCandleDate ?? 'n/a'}), ` +
      `IV proxy ${ticker.ivProxyDates} (${ticker.ivProxyCoveragePct}%), stale=${ticker.stale ? 'yes' : 'no'}`,
    );
    for (const failure of ticker.failures) lines.push(`  FAIL ${failure}`);
  }
  return lines.join('\n');
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const profile = (getArg('--profile') ?? 'swing') as WFAProfile;
  const tickers = (getArg('--tickers') ?? (profile === 'short'
    ? 'SPY,QQQ,AMD,IWM,TSLA,AAPL,JPM,NVDA,AMZN,MSFT,META,NFLX,GOOG,GS,COST'
    : 'SPY,QQQ,AMD,IWM,TSLA,AAPL,JPM,NVDA,AMZN,MSFT,META,NFLX,GOOG,GS'))
    .split(',')
    .map(ticker => ticker.trim().toUpperCase())
    .filter(Boolean);
  const dataStart = getArg('--data-start') ?? (profile === 'short' ? '2023-01-01' : '2017-01-01');
  const endDate = getArg('--end') ?? '2026-02-28';
  const report = buildWFACacheQualityReport({
    profile,
    tickers,
    dataStart,
    endDate,
    intradayDbPath: process.env.WFA_INTRADAY_DB_PATH,
    chainDbPath: process.env.WFA_CHAIN_DB_PATH,
  });
  const artifact = writeWFACacheQualityArtifact(report);
  console.log(formatWFACacheQualityReport(report));
  console.log('');
  console.log(`Artifact: ${artifact.path}`);
  console.log(`Artifact SHA256: ${artifact.sha256}`);
  validateWFACacheQuality(report);
}
