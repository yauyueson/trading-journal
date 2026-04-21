/**
 * update-dataset-manifest — Phase 0.b.6 / 0.b.7 helper
 *
 * Usage:
 *   npx tsx scripts/update-dataset-manifest.ts
 *       — print current hash and info.
 *
 *   npx tsx scripts/update-dataset-manifest.ts --bump
 *       — refresh generatedAt + rewrite file.
 *
 *   npx tsx scripts/update-dataset-manifest.ts --add-ticker-start <SYMBOL> <YYYY-MM-DD>
 *       — add or update a per-ticker dataStart override (Phase 0.b.7).
 *         Also bumps generatedAt so the file hash rotates.
 *
 * After any write the operator must:
 *   1. git commit config/dataset-manifest.json
 *   2. copy the new hash into .handoff/current.md Pre-Registration block
 *   3. git commit .handoff/current.md
 *   4. re-run the runner
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { loadDatasetManifest, validateManifestRanges, type DatasetManifest } from './autoresearch/lib/dataset-manifest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_REL = 'config/dataset-manifest.json';

function writeManifest(manifestAbs: string, parsed: Record<string, unknown>): string {
  parsed.generatedAt = new Date().toISOString();
  // Phase 0.b.7 round-1 F3: validate the mutated manifest before writing,
  // so an invalid ticker start or impossible date can't persist and print
  // a fresh hash that the operator would copy into the pre-reg block.
  try {
    validateManifestRanges(parsed as unknown as DatasetManifest);
  } catch (err) {
    console.error(`Refusing to write: ${(err as Error).message}`);
    process.exit(2);
  }
  const out = JSON.stringify(parsed, null, 2) + '\n';
  fs.writeFileSync(manifestAbs, out);
  return crypto.createHash('sha256').update(out).digest('hex');
}

function printNextSteps(newHash: string): void {
  console.log(`New sha256: ${newHash}`);
  console.log(`Pre-Registration "Holdout Window Hash" should be: sha256:${newHash}`);
  console.log('');
  console.log('Next: git add config/dataset-manifest.json && git commit -m "config: update dataset manifest"');
}

function main(): void {
  const argv = process.argv.slice(2);
  const manifestAbs = path.resolve(REPO_ROOT, MANIFEST_REL);
  const addTickerIdx = argv.indexOf('--add-ticker-start');

  if (addTickerIdx >= 0) {
    const symbol = argv[addTickerIdx + 1];
    const dateStr = argv[addTickerIdx + 2];
    if (!symbol || !dateStr) {
      console.error('Usage: --add-ticker-start <SYMBOL> <YYYY-MM-DD>');
      process.exit(2);
    }
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
      console.error(`Invalid symbol ${JSON.stringify(symbol)} — expected uppercase letters/digits.`);
      process.exit(2);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      console.error(`Invalid date ${JSON.stringify(dateStr)} — expected YYYY-MM-DD.`);
      process.exit(2);
    }
    const raw = fs.readFileSync(manifestAbs, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if ((parsed.manifestVersion as number) < 2) {
      parsed.manifestVersion = 2;
      console.log(`Bumped manifestVersion 1 → 2 (required for per-ticker overrides).`);
    }
    const tickers = (parsed.tickers ?? {}) as Record<string, { dataStart?: string }>;
    tickers[symbol] = { ...tickers[symbol], dataStart: dateStr };
    parsed.tickers = tickers;
    const newHash = writeManifest(manifestAbs, parsed);
    console.log(`Set tickers.${symbol}.dataStart = ${dateStr}`);
    printNextSteps(newHash);
    return;
  }

  if (argv.includes('--bump')) {
    const raw = fs.readFileSync(manifestAbs, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const newHash = writeManifest(manifestAbs, parsed);
    console.log(`Rewrote ${MANIFEST_REL} with generatedAt=${parsed.generatedAt}`);
    printNextSteps(newHash);
    return;
  }

  const loaded = loadDatasetManifest({ repoRoot: REPO_ROOT });
  console.log(`Manifest path:    ${MANIFEST_REL}`);
  console.log(`Raw sha256:       ${loaded.rawHash}`);
  console.log(`Pre-reg hash form: sha256:${loaded.rawHash}`);
  console.log(`Version:          ${loaded.manifest.manifestVersion}`);
  console.log(`Data range:       ${loaded.manifest.dataStartDate} → ${loaded.manifest.dataEndDate}`);
  console.log(`Holdout range:    ${loaded.manifest.holdoutStartDate} → ${loaded.manifest.holdoutEndDate}`);
  console.log(`Generated at:     ${loaded.manifest.generatedAt}`);
  if (loaded.manifest.tickers) {
    const entries = Object.entries(loaded.manifest.tickers);
    console.log(`Ticker overrides: ${entries.length}`);
    for (const [symbol, override] of entries.sort()) {
      if (override.dataStart) {
        console.log(`  ${symbol.padEnd(6)} dataStart=${override.dataStart}`);
      }
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`update-dataset-manifest: ${(err as Error).message}`);
  process.exit(1);
}
