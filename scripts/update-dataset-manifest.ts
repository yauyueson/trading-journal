/**
 * update-dataset-manifest — Phase 0.b.6 helper
 *
 * Usage:
 *   npx tsx scripts/update-dataset-manifest.ts              # print current hash
 *   npx tsx scripts/update-dataset-manifest.ts --bump       # refresh generatedAt + rewrite file
 *
 * After --bump the operator must:
 *   1. git commit config/dataset-manifest.json
 *   2. copy the new hash into .handoff/current.md Pre-Registration block
 *   3. git commit .handoff/current.md
 *   4. re-run the runner
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { loadDatasetManifest } from './autoresearch/lib/dataset-manifest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_REL = 'config/dataset-manifest.json';

function main(): void {
  const bump = process.argv.includes('--bump');
  const manifestAbs = path.resolve(REPO_ROOT, MANIFEST_REL);

  if (bump) {
    const raw = fs.readFileSync(manifestAbs, 'utf-8');
    const parsed = JSON.parse(raw);
    parsed.generatedAt = new Date().toISOString();
    // Preserve 2-space pretty-print — matches the committed file's format
    // so the hash diff is obvious and git-friendly.
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(manifestAbs, out);
    const newHash = crypto.createHash('sha256').update(out).digest('hex');
    console.log(`Rewrote ${MANIFEST_REL} with generatedAt=${parsed.generatedAt}`);
    console.log(`New sha256: ${newHash}`);
    console.log(`Pre-Registration "Holdout Window Hash" should be: sha256:${newHash}`);
    console.log('');
    console.log('Next: git add config/dataset-manifest.json && git commit -m "config: bump dataset manifest"');
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
}

try {
  main();
} catch (err) {
  console.error(`update-dataset-manifest: ${(err as Error).message}`);
  process.exit(1);
}
