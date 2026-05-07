import path from 'path';
import fs from 'fs';

import {
  buildDataCoverageReport,
  writeDataCoverageArtifact,
  type DataCoverageReport,
} from './data-coverage-report';
import {
  buildWFACacheQualityReport,
  validateWFACacheQuality,
  writeWFACacheQualityArtifact,
  type WFAProfile,
} from './wfa-cache-quality';

export type WFARunDataPolicy = {
  mode: 'cache-first';
  vendorApiCalls: 'disabled-during-wfa';
  coverageArtifactPath: string;
  coverageArtifactSha256: string;
  coverageGeneratedAt: string;
  manifestHash: string;
  chainDbPath: string;
  inputCaches: Array<{
    role: 'option-chain' | 'intraday-candles';
    path: string;
    bytes: number;
    mtimeMs: number;
  }>;
  qualityGate?: {
    decision: 'pass' | 'blocked';
    artifactPath: string;
    artifactSha256: string;
    failures: string[];
  };
  requiredBands: Array<{
    strategy: string;
    bandName: string;
    ticker: string;
    dteMin: number;
    dteMax: number;
    intervalCoveredDates: number;
    chainRowDates: number;
  }>;
};

export function validateCacheOnlyCoverage(report: DataCoverageReport): void {
  if (report.mode !== 'cache-only' || report.vendorApiCalls !== 'disabled') {
    throw new Error('WFA data policy requires cache-only coverage with vendor API calls disabled.');
  }
  if (!report.chainDbPresent) {
    throw new Error(`WFA data policy requires a local chain cache: ${report.chainDbPath}`);
  }

  const missingBands = report.strategyBands.filter(band =>
    band.intervalCoveredDates <= 0 || band.chainRowDates <= 0,
  );
  if (missingBands.length > 0) {
    const details = missingBands
      .map(band => `${band.strategy}/${band.bandName} ${band.ticker} DTE ${band.dteMin}-${band.dteMax}`)
      .join(', ');
    throw new Error(`WFA data policy found missing cached option coverage: ${details}`);
  }
}

export function createWFARunDataPolicy(options: {
  repoRoot?: string;
  chainDbPath?: string;
  intradayDbPath?: string;
  generatedAt?: string;
  outputDir?: string;
  qualityOutputDir?: string;
  qualityRequest?: {
    profile: WFAProfile;
    tickers: string[];
    dataStart: string;
    endDate: string;
    minIVProxyCoveragePct?: number;
    minCandleDates?: number;
  };
} = {}): WFARunDataPolicy {
  const repoRoot = options.repoRoot ?? process.cwd();
  const report = buildDataCoverageReport({
    repoRoot,
    chainDbPath: options.chainDbPath,
    generatedAt: options.generatedAt,
  });
  validateCacheOnlyCoverage(report);

  const artifact = writeDataCoverageArtifact(report, {
    outputDir: options.outputDir ?? path.resolve(repoRoot, 'docs/data-coverage'),
  });
  const intradayDbPath = options.intradayDbPath ?? process.env.WFA_INTRADAY_DB_PATH ?? path.resolve(repoRoot, 'data/intraday-candles.sqlite');
  const inputCaches = [
    { role: 'option-chain' as const, path: report.chainDbPath },
    { role: 'intraday-candles' as const, path: intradayDbPath },
  ].filter(cache => fs.existsSync(cache.path)).map(cache => {
    const stats = fs.statSync(cache.path);
    return {
      role: cache.role,
      path: path.relative(repoRoot, cache.path),
      bytes: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  });
  let qualityGate: WFARunDataPolicy['qualityGate'];
  if (options.qualityRequest) {
    const quality = buildWFACacheQualityReport({
      repoRoot,
      profile: options.qualityRequest.profile,
      tickers: options.qualityRequest.tickers,
      dataStart: options.qualityRequest.dataStart,
      endDate: options.qualityRequest.endDate,
      intradayDbPath,
      chainDbPath: report.chainDbPath,
      generatedAt: options.generatedAt,
      minCandleDates: options.qualityRequest.minCandleDates,
      minIVProxyCoveragePct: options.qualityRequest.minIVProxyCoveragePct,
    });
    validateWFACacheQuality(quality);
    const qualityArtifact = writeWFACacheQualityArtifact(quality, {
      outputDir: options.qualityOutputDir ?? path.resolve(repoRoot, 'docs/data-quality'),
    });
    qualityGate = {
      decision: quality.decision,
      artifactPath: path.relative(repoRoot, qualityArtifact.path),
      artifactSha256: qualityArtifact.sha256,
      failures: quality.failures,
    };
  }

  return {
    mode: 'cache-first',
    vendorApiCalls: 'disabled-during-wfa',
    coverageArtifactPath: path.relative(repoRoot, artifact.path),
    coverageArtifactSha256: artifact.sha256,
    coverageGeneratedAt: report.generatedAt,
    manifestHash: report.manifestHash,
    chainDbPath: path.relative(repoRoot, report.chainDbPath),
    inputCaches,
    qualityGate,
    requiredBands: report.strategyBands.map(band => ({
      strategy: band.strategy,
      bandName: band.bandName,
      ticker: band.ticker,
      dteMin: band.dteMin,
      dteMax: band.dteMax,
      intervalCoveredDates: band.intervalCoveredDates,
      chainRowDates: band.chainRowDates,
    })),
  };
}
