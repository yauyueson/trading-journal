/**
 * evaluate-holdout — Phase 0.a.5 ceremony CLI
 *
 * Seals a single pre-registered candidate's holdout result into
 * docs/holdout-evaluations/. Reads an immutable, committed per-block audit
 * row from docs/audit-rows/<preRegBlockHash>.json. See docs/sealed-holdout.md
 * for the full protocol.
 *
 * Usage:
 *   npx tsx scripts/evaluate-holdout.ts \
 *     --strategy scripts/autoresearch/strategy.ts \
 *     --strategy-name "<exact name exported by the strategy>" \
 *     --prereg-hash <sha256 block hash from .handoff/current.md>
 *
 * Exit codes:
 *   0 — seal written, verdict PASS
 *   1 — seal written, verdict FAIL
 *   2 — refusal (pre-reg mismatch, stale row, skip-holdout row, uncommitted files, etc.)
 *   3 — unexpected error
 */
import path from 'path';
import { fileURLToPath } from 'node:url';
import { sealHoldout, normalizeBlockHashArg } from './autoresearch/lib/seal-holdout';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function getFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function printUsage(): void {
  console.error(`Usage:
  npx tsx scripts/evaluate-holdout.ts \\
    --strategy <path relative to repo root> \\
    --strategy-name "<exact name>" \\
    --prereg-hash <sha256:... or 64-hex>`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const strategyPath = getFlag(argv, '--strategy');
  const strategyName = getFlag(argv, '--strategy-name');
  const preRegHashRaw = getFlag(argv, '--prereg-hash');

  if (!strategyPath || !strategyName || !preRegHashRaw) {
    printUsage();
    process.exit(2);
  }

  const preRegHash = normalizeBlockHashArg(preRegHashRaw);
  if (!preRegHash) {
    console.error(`--prereg-hash is not a valid sha256: expected 64 hex chars (optionally prefixed with "sha256:"), got ${JSON.stringify(preRegHashRaw)}`);
    process.exit(2);
  }

  const out = sealHoldout({
    repoRoot: REPO_ROOT,
    strategyPath,
    strategyName,
    preRegHash,
  });

  if (!out.ok) {
    console.error(`evaluate-holdout: ${out.reason}`);
    if (out.hint) console.error(`Hint: ${out.hint}`);
    process.exit(2);
  }

  const rel = path.relative(REPO_ROOT, out.sealPath);
  const verdict = out.passes ? 'PASS' : 'FAIL';
  console.log(`Seal written: ${rel}`);
  console.log(`Strategy:     ${strategyName}`);
  console.log(`Block:        ${preRegHash.slice(0, 16)}...`);
  console.log(`Strategy SHA: ${out.strategyGitSha.slice(0, 10)}`);
  console.log(`Audit row SHA: ${out.auditRowGitSha.slice(0, 10)}`);
  console.log(`Verdict:      ${verdict}`);
  console.log(`  holdoutSharpe=${out.row.holdoutSharpe?.toFixed?.(3) ?? out.row.holdoutSharpe}`);
  console.log(`  holdoutSpyIR=${out.row.holdoutSpyIR?.toFixed?.(3) ?? out.row.holdoutSpyIR}`);
  console.log(`  holdoutTrades=${out.row.holdoutTrades}`);
  process.exit(out.passes ? 0 : 1);
}

main().catch(err => {
  console.error(`evaluate-holdout: unexpected error — ${(err as Error).message}`);
  console.error((err as Error).stack ?? '');
  process.exit(3);
});
