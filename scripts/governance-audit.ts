import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

type Permission = {
  paper: boolean;
  live: boolean;
  liveRequires?: string[];
};

type StrategyGovernanceEntry = {
  label: string;
  status: string;
  canonicalSealPath: string;
  canonicalSealSha256: string;
  strategyType: string;
  permission: Permission;
  capitalTier?: {
    startingCapital: number;
    riskPctPerTrade: number;
    maxConcurrentPositions: number;
  };
  riskPolicy?: {
    underlying?: string;
    maxConcurrentPositions?: number;
    aggregateQqqExposureGroup?: string;
    paperToLivePromotion?: string;
  };
  lowSampleWaiver?: {
    required: boolean;
    approvedBy: string;
    reason: string;
  };
};

type StrategyGovernanceRegistry = {
  version: number;
  lastUpdated: string;
  globalPolicy: {
    currentManifestPath: string;
    currentManifestSha256: string;
    adoptionGatesPath: string;
    adoptionGatesSha256: string;
    wfaEvidenceCutoffDate: string;
    preCutoffWfaEvidenceStatus: string;
    nextFreshHoldoutBackstopDate: string;
    liveTradingRequiresHumanConfirmation: boolean;
    liveTradingDefaultPermission: boolean;
  };
  strategies: Record<string, StrategyGovernanceEntry>;
};

export type GovernanceCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type StrategyAuditSummary = {
  strategy: string;
  label: string;
  status: string;
  permission: Permission;
  liveBlockers: string[];
  canonicalSealPath: string;
  capital: string;
};

export type GovernanceAudit = {
  ok: boolean;
  registryPath: string;
  registryVersion: number;
  lastUpdated: string;
  nextFreshHoldoutBackstopDate: string;
  wfaEvidenceCutoffDate: string;
  preCutoffWfaEvidenceStatus: string;
  checks: GovernanceCheck[];
  strategies: StrategyAuditSummary[];
};

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function checkHash(repoRoot: string, name: string, relativePath: string, expectedSha: string): GovernanceCheck {
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return { name, ok: false, detail: `${relativePath} is missing` };
  }
  const actualSha = sha256File(absolutePath);
  return {
    name,
    ok: actualSha === expectedSha,
    detail: actualSha === expectedSha
      ? `${relativePath} matches ${expectedSha}`
      : `${relativePath} hash mismatch: expected ${expectedSha}, got ${actualSha}`,
  };
}

function summarizeCapital(entry: StrategyGovernanceEntry): string {
  const c = entry.capitalTier;
  if (!c) return 'unconfigured';
  return `$${c.startingCapital} tier, risk ${c.riskPctPerTrade}%, max ${c.maxConcurrentPositions}`;
}

export function auditStrategyGovernance(options: { repoRoot?: string } = {}): GovernanceAudit {
  const repoRoot = options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const registryPath = path.resolve(repoRoot, 'config/strategy-governance.json');
  const registry = readJson<StrategyGovernanceRegistry>(registryPath);

  const checks: GovernanceCheck[] = [
    checkHash(
      repoRoot,
      'dataset manifest hash',
      registry.globalPolicy.currentManifestPath,
      registry.globalPolicy.currentManifestSha256,
    ),
    checkHash(
      repoRoot,
      'adoption gates hash',
      registry.globalPolicy.adoptionGatesPath,
      registry.globalPolicy.adoptionGatesSha256,
    ),
  ];

  const strategies = Object.entries(registry.strategies).map(([strategy, entry]) => {
    checks.push(checkHash(
      repoRoot,
      `${strategy} canonical seal hash`,
      entry.canonicalSealPath,
      entry.canonicalSealSha256,
    ));

    const liveBlockers = entry.permission.live
      ? []
      : entry.permission.liveRequires ?? ['live permission is false'];

    return {
      strategy,
      label: entry.label,
      status: entry.status,
      permission: entry.permission,
      liveBlockers,
      canonicalSealPath: entry.canonicalSealPath,
      capital: summarizeCapital(entry),
    };
  });

  return {
    ok: checks.every(check => check.ok),
    registryPath,
    registryVersion: registry.version,
    lastUpdated: registry.lastUpdated,
    nextFreshHoldoutBackstopDate: registry.globalPolicy.nextFreshHoldoutBackstopDate,
    wfaEvidenceCutoffDate: registry.globalPolicy.wfaEvidenceCutoffDate,
    preCutoffWfaEvidenceStatus: registry.globalPolicy.preCutoffWfaEvidenceStatus,
    checks,
    strategies,
  };
}

export function formatGovernanceAudit(audit: GovernanceAudit): string {
  const lines: string[] = [];
  lines.push('Strategy Governance Audit');
  lines.push(`Overall: ${audit.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`Registry: ${audit.registryPath}`);
  lines.push(`Registry version: ${audit.registryVersion} (updated ${audit.lastUpdated})`);
  lines.push(`WFA evidence cutoff: ${audit.wfaEvidenceCutoffDate} (${audit.preCutoffWfaEvidenceStatus})`);
  lines.push(`Next fresh holdout backstop: ${audit.nextFreshHoldoutBackstopDate}`);
  lines.push('');
  lines.push('Checks:');
  for (const check of audit.checks) {
    lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  }
  lines.push('');
  lines.push('Strategies:');
  for (const strategy of audit.strategies) {
    lines.push(`- ${strategy.label} (${strategy.strategy})`);
    lines.push(`  Status: ${strategy.status}`);
    lines.push(`  Paper: ${strategy.permission.paper ? 'allowed' : 'blocked'}`);
    lines.push(`  Live: ${strategy.permission.live ? 'allowed' : 'blocked'}`);
    lines.push(`  Capital: ${strategy.capital}`);
    lines.push(`  Seal: ${strategy.canonicalSealPath}`);
    if (strategy.liveBlockers.length > 0) {
      lines.push(`  Live blockers: ${strategy.liveBlockers.join('; ')}`);
    }
  }
  return lines.join('\n');
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const audit = auditStrategyGovernance();
  console.log(formatGovernanceAudit(audit));
  process.exitCode = audit.ok ? 0 : 1;
}
