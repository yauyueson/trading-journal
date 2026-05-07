import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

type DatasetManifest = {
  manifestVersion: number;
  dataStartDate: string;
  dataEndDate: string;
  holdoutStartDate: string;
  holdoutEndDate: string;
};

type GovernanceEntry = {
  label: string;
  strategyType: string;
  status: string;
};

type GovernanceRegistry = {
  strategies: Record<string, GovernanceEntry>;
};

export type StrategyBandCoverage = {
  strategy: string;
  label: string;
  status: string;
  bandName: string;
  ticker: string;
  dteMin: number;
  dteMax: number;
  intervalCoveredDates: number;
  chainRowDates: number;
  firstIntervalDate: string | null;
  lastIntervalDate: string | null;
  firstChainDate: string | null;
  lastChainDate: string | null;
};

export type DataCoverageReport = {
  generatedAt: string;
  mode: 'cache-only';
  vendorApiCalls: 'disabled';
  manifest: DatasetManifest;
  manifestHash: string;
  chainDbPath: string;
  chainDbPresent: boolean;
  strategyBands: StrategyBandCoverage[];
};

export type DataCoverageArtifactWrite = {
  path: string;
  sha256: string;
};

function defaultRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function strategyBands(strategy: string): Array<{ bandName: string; ticker: string; dteMin: number; dteMax: number }> {
  if (strategy === 'bcd') {
    return [{ bandName: 'debit-spread', ticker: 'QQQ', dteMin: 30, dteMax: 60 }];
  }
  if (strategy === 'pmcc') {
    return [
      { bandName: 'long-leg', ticker: 'QQQ', dteMin: 240, dteMax: 300 },
      { bandName: 'short-leg', ticker: 'QQQ', dteMin: 30, dteMax: 45 },
    ];
  }
  return [];
}

function emptyCoverage(
  strategy: string,
  entry: GovernanceEntry,
  band: { bandName: string; ticker: string; dteMin: number; dteMax: number },
): StrategyBandCoverage {
  return {
    strategy,
    label: entry.label,
    status: entry.status,
    ...band,
    intervalCoveredDates: 0,
    chainRowDates: 0,
    firstIntervalDate: null,
    lastIntervalDate: null,
    firstChainDate: null,
    lastChainDate: null,
  };
}

function readBandCoverage(
  db: Database.Database,
  strategy: string,
  entry: GovernanceEntry,
  band: { bandName: string; ticker: string; dteMin: number; dteMax: number },
): StrategyBandCoverage {
  const interval = db.prepare(`
    SELECT COUNT(DISTINCT trade_date) AS count,
           MIN(trade_date) AS firstDate,
           MAX(trade_date) AS lastDate
    FROM fetch_log_intervals
    WHERE ticker = ?
      AND (
        (dte_min IS NULL AND dte_max IS NULL)
        OR (dte_min <= ? AND dte_max >= ?)
      )
  `).get(band.ticker, band.dteMin, band.dteMax) as {
    count: number;
    firstDate: string | null;
    lastDate: string | null;
  };

  const chain = db.prepare(`
    SELECT COUNT(DISTINCT trade_date) AS count,
           MIN(trade_date) AS firstDate,
           MAX(trade_date) AS lastDate
    FROM option_chains
    WHERE ticker = ?
      AND dte BETWEEN ? AND ?
  `).get(band.ticker, band.dteMin, band.dteMax) as {
    count: number;
    firstDate: string | null;
    lastDate: string | null;
  };

  return {
    strategy,
    label: entry.label,
    status: entry.status,
    ...band,
    intervalCoveredDates: Number(interval.count ?? 0),
    chainRowDates: Number(chain.count ?? 0),
    firstIntervalDate: interval.firstDate,
    lastIntervalDate: interval.lastDate,
    firstChainDate: chain.firstDate,
    lastChainDate: chain.lastDate,
  };
}

export function buildDataCoverageReport(options: {
  repoRoot?: string;
  chainDbPath?: string;
  generatedAt?: string;
} = {}): DataCoverageReport {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const manifestPath = path.resolve(repoRoot, 'config/dataset-manifest.json');
  const governancePath = path.resolve(repoRoot, 'config/strategy-governance.json');
  const chainDbPath = options.chainDbPath ?? path.resolve(repoRoot, 'data/option-chains.sqlite');
  const manifest = readJson<DatasetManifest>(manifestPath);
  const governance = readJson<GovernanceRegistry>(governancePath);
  const chainDbPresent = fs.existsSync(chainDbPath);

  const bands = Object.entries(governance.strategies).flatMap(([strategy, entry]) =>
    strategyBands(strategy).map(band => ({ strategy, entry, band })),
  );

  let strategyBandCoverage: StrategyBandCoverage[];
  if (!chainDbPresent) {
    strategyBandCoverage = bands.map(({ strategy, entry, band }) => emptyCoverage(strategy, entry, band));
  } else {
    const db = new Database(chainDbPath, { readonly: true });
    try {
      strategyBandCoverage = bands.map(({ strategy, entry, band }) =>
        readBandCoverage(db, strategy, entry, band),
      );
    } finally {
      db.close();
    }
  }

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mode: 'cache-only',
    vendorApiCalls: 'disabled',
    manifest,
    manifestHash: sha256File(manifestPath),
    chainDbPath,
    chainDbPresent,
    strategyBands: strategyBandCoverage,
  };
}

export function formatDataCoverageReport(report: DataCoverageReport): string {
  const lines: string[] = [];
  lines.push('Data Coverage Report');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Vendor API calls: ${report.vendorApiCalls}`);
  lines.push(`Manifest: ${report.manifest.dataStartDate} -> ${report.manifest.dataEndDate} (${report.manifestHash})`);
  lines.push(`Holdout: ${report.manifest.holdoutStartDate} -> ${report.manifest.holdoutEndDate}`);
  lines.push(`Chain DB: ${report.chainDbPresent ? report.chainDbPath : 'missing'}`);
  lines.push('');
  lines.push('Active strategy DTE-band cache coverage:');
  for (const band of report.strategyBands) {
    lines.push(
      `- ${band.label} (${band.strategy}/${band.bandName}) ${band.ticker} DTE ${band.dteMin}-${band.dteMax}: ` +
      `${band.intervalCoveredDates} interval dates, ${band.chainRowDates} chain-row dates ` +
      `[interval ${band.firstIntervalDate ?? 'n/a'} -> ${band.lastIntervalDate ?? 'n/a'}; ` +
      `rows ${band.firstChainDate ?? 'n/a'} -> ${band.lastChainDate ?? 'n/a'}]`,
    );
  }
  return lines.join('\n');
}

export function writeDataCoverageArtifact(
  report: DataCoverageReport,
  options: { outputDir?: string } = {},
): DataCoverageArtifactWrite {
  const repoRoot = defaultRepoRoot();
  const outputDir = options.outputDir ?? path.resolve(repoRoot, 'docs/data-coverage');
  const date = report.generatedAt.slice(0, 10);
  const filePath = path.join(outputDir, `${date}-cache-only-coverage.json`);
  const payload = {
    artifact: {
      schemaVersion: 1,
      generatedBy: 'scripts/data-coverage-report.ts',
      mode: report.mode,
      vendorApiCalls: report.vendorApiCalls,
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

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const report = buildDataCoverageReport();
  console.log(formatDataCoverageReport(report));
  const artifact = writeDataCoverageArtifact(report);
  console.log('');
  console.log(`Artifact: ${artifact.path}`);
  console.log(`Artifact SHA256: ${artifact.sha256}`);
}
