/**
 * compute-effective-trials.ts — Phase 0.a.3 CLI
 *
 * Reads the global trial ledger (`data/attempts-global.json` + per-trial
 * return vectors under `data/trial-ledger/`), computes the effective
 * number of independent trials via participation ratio, and writes a
 * report to `docs/trial-budget.md`.
 *
 * Usage:
 *   npx tsx scripts/compute-effective-trials.ts
 *
 * Flags:
 *   --dry-run   Print to stdout, don't write docs/trial-budget.md.
 *   --min-overlap <N>   Override the default 20-day minimum date overlap
 *                       below which a pair is treated as uncorrelated.
 *
 * WHY
 *
 * Raw attempt count overstates search burden when trials are correlated
 * (grid sweeps over adjacent SL / TP / delta). Deflated-Sharpe and PBO
 * should use N_eff as the denominator, not N_raw.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import {
  loadTrialLedger,
  computeEffectiveTrialCount,
  formatTrialBudgetReport,
} from './autoresearch/lib/trial-ledger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function main(): void {
  const dryRun = hasFlag('--dry-run');
  const minOverlapArg = getFlag('--min-overlap');
  const minOverlap = minOverlapArg != null ? parseInt(minOverlapArg, 10) : 20;
  if (minOverlapArg != null && !Number.isFinite(minOverlap)) {
    console.error(`--min-overlap must be an integer, got '${minOverlapArg}'`);
    process.exit(1);
  }
  const minCoverageArg = getFlag('--min-coverage');
  const minCoverage = minCoverageArg != null ? parseFloat(minCoverageArg) : 0.5;
  if (minCoverageArg != null && !(Number.isFinite(minCoverage) && minCoverage >= 0 && minCoverage <= 1)) {
    console.error(`--min-coverage must be a number in [0, 1], got '${minCoverageArg}'`);
    process.exit(1);
  }

  const ledger = loadTrialLedger({ repoRoot: REPO_ROOT });
  const nEff = computeEffectiveTrialCount(ledger, {
    repoRoot: REPO_ROOT,
    minOverlapDays: minOverlap,
    minCoverageRatio: minCoverage,
  });

  const report = formatTrialBudgetReport(ledger, nEff);

  console.log(`N_raw = ${nEff.nRaw}`);
  console.log(`N_eff = ${nEff.nEff.toFixed(2)}`);
  console.log(`Trials with return vectors: ${nEff.nUsed} (of ${nEff.nRaw} raw)`);
  console.log(`Mean |pairwise ρ|: ${nEff.meanAbsCorrelation.toFixed(3)}`);

  if (nEff.nUsed === 0 && nEff.nRaw > 0) {
    console.log('');
    console.log('NOTE: no per-trial return vectors found. N_eff is a conservative floor (= N_raw).');
    console.log('This is expected for attempts logged before Phase 0.a.3 (2026-04-18). New attempts will populate the ledger.');
  }

  if (!dryRun) {
    const outPath = path.resolve(REPO_ROOT, 'docs/trial-budget.md');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report);
    console.log('');
    console.log(`Wrote ${path.relative(REPO_ROOT, outPath)}`);
  } else {
    console.log('');
    console.log('--- report (not written, --dry-run) ---');
    console.log(report);
  }
}

main();
