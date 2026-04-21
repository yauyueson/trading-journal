/**
 * dataset-manifest — Phase 0.b.6
 *
 * Committed-config source of truth for the dataset range any campaign
 * runs against. Mirrors the `adoption-gates.ts` pattern: load + hash +
 * refuse-if-changed-mid-run.
 *
 * The raw sha256 of the file bytes is the "Holdout Window Hash" that a
 * Pre-Registration block must declare. Runner verifies the match; seal
 * ceremony records the row's `datasetManifestHash` for post-hoc audit.
 *
 * See docs/sealed-holdout.md for the policy context.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'child_process';

export interface DatasetManifestTickerOverride {
  /** Earliest trading date this ticker is required to have data for.
   *  Must fall in [manifest.dataStartDate, manifest.holdoutStartDate].
   *  Used for tickers that IPO'd after the manifest's dataStartDate. */
  dataStart?: string;
}

export interface DatasetManifest {
  manifestVersion: number;
  dataStartDate: string;       // YYYY-MM-DD
  dataEndDate: string;         // YYYY-MM-DD
  holdoutStartDate: string;    // YYYY-MM-DD
  holdoutEndDate: string;      // YYYY-MM-DD
  generatedAt: string;         // ISO timestamp (informational)
  notes?: string;
  /** Phase 0.b.7: per-ticker dataStart overrides for post-IPO tickers.
   *  Tickers not listed here must span the full manifest dataStartDate. */
  tickers?: Record<string, DatasetManifestTickerOverride>;
}

export interface LoadedManifest {
  manifest: DatasetManifest;
  rawHash: string;             // pure 64-hex sha256 of file bytes
  manifestPath: string;
}

const CONFIG_REL = 'config/dataset-manifest.json';

function resolveRepoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '../../..');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Canonical YYYY-MM-DD check plus real-date sanity. */
function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Reject things like 2024-02-30 that Date silently rolls.
  return d.toISOString().slice(0, 10) === s;
}

export function validateManifestRanges(m: DatasetManifest): void {
  if (m.manifestVersion !== 1 && m.manifestVersion !== 2) {
    throw new Error(`dataset-manifest: unsupported manifestVersion ${m.manifestVersion} (expected 1 or 2)`);
  }
  for (const field of ['dataStartDate', 'dataEndDate', 'holdoutStartDate', 'holdoutEndDate'] as const) {
    if (!isIsoDate(m[field])) {
      throw new Error(`dataset-manifest: ${field}=${JSON.stringify(m[field])} is not a valid YYYY-MM-DD date.`);
    }
  }
  if (!(m.dataStartDate < m.dataEndDate)) {
    throw new Error(`dataset-manifest: dataStartDate (${m.dataStartDate}) must precede dataEndDate (${m.dataEndDate}).`);
  }
  if (!(m.holdoutStartDate <= m.holdoutEndDate)) {
    throw new Error(`dataset-manifest: holdoutStartDate (${m.holdoutStartDate}) must not be after holdoutEndDate (${m.holdoutEndDate}).`);
  }
  if (m.holdoutStartDate < m.dataStartDate) {
    throw new Error(`dataset-manifest: holdoutStartDate (${m.holdoutStartDate}) is before dataStartDate (${m.dataStartDate}).`);
  }
  if (m.holdoutEndDate > m.dataEndDate) {
    throw new Error(`dataset-manifest: holdoutEndDate (${m.holdoutEndDate}) is after dataEndDate (${m.dataEndDate}).`);
  }
  // Phase 0.b.7: per-ticker overrides. Each dataStart must be a valid ISO
  // date inside [manifest.dataStartDate, manifest.holdoutStartDate]. Outside
  // that range makes no sense (before → no constraint; after → ticker has
  // no pre-holdout history, WFA training would fail).
  if (m.tickers) {
    if (m.manifestVersion !== 2) {
      throw new Error(`dataset-manifest: "tickers" map requires manifestVersion 2, got ${m.manifestVersion}.`);
    }
    for (const [symbol, override] of Object.entries(m.tickers)) {
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
        throw new Error(`dataset-manifest: tickers key ${JSON.stringify(symbol)} is not a plausible symbol.`);
      }
      if (override.dataStart !== undefined) {
        if (!isIsoDate(override.dataStart)) {
          throw new Error(`dataset-manifest: tickers.${symbol}.dataStart=${JSON.stringify(override.dataStart)} is not a valid YYYY-MM-DD date.`);
        }
        if (override.dataStart < m.dataStartDate) {
          throw new Error(`dataset-manifest: tickers.${symbol}.dataStart (${override.dataStart}) is before manifest dataStartDate (${m.dataStartDate}); remove the override.`);
        }
        if (override.dataStart > m.holdoutStartDate) {
          throw new Error(`dataset-manifest: tickers.${symbol}.dataStart (${override.dataStart}) is after manifest holdoutStartDate (${m.holdoutStartDate}); ticker would have no pre-holdout history for WFA training.`);
        }
      }
    }
  }
}

/** Resolve the effective first required trading date for a ticker. Returns
 *  the per-ticker override if present, else the manifest's dataStartDate. */
export function resolveTickerStart(ticker: string, m: DatasetManifest): string {
  const override = m.tickers?.[ticker]?.dataStart;
  return override ?? m.dataStartDate;
}

export function loadDatasetManifest(opts?: { repoRoot?: string }): LoadedManifest {
  const root = opts?.repoRoot ?? resolveRepoRoot();
  const manifestPath = path.resolve(root, CONFIG_REL);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`dataset-manifest: config file missing at ${manifestPath}. Create it (see docs/sealed-holdout.md) and commit.`);
  }
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  let parsed: DatasetManifest;
  try {
    parsed = JSON.parse(raw) as DatasetManifest;
  } catch (err) {
    throw new Error(`dataset-manifest: ${manifestPath} is not valid JSON: ${(err as Error).message}`);
  }
  validateManifestRanges(parsed);
  const rawHash = crypto.createHash('sha256').update(raw).digest('hex');
  return { manifest: parsed, rawHash, manifestPath };
}

export function recomputeRawHash(loaded: LoadedManifest): string {
  const raw = fs.readFileSync(loaded.manifestPath, 'utf-8');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function assertManifestUnchanged(loaded: LoadedManifest): void {
  const current = recomputeRawHash(loaded);
  if (current !== loaded.rawHash) {
    throw new Error(
      `dataset-manifest: config file was modified mid-campaign. ` +
      `Original hash ${loaded.rawHash.slice(0, 12)}..., current ${current.slice(0, 12)}.... ` +
      `This is a hard error — do not restart without a committed PR to config/dataset-manifest.json.`,
    );
  }
}

/**
 * Verify config/dataset-manifest.json is tracked in git AND clean.
 * Mirrors adoption-gates.ts:assertGateConfigTracked — a hash of an
 * untracked file can't survive a fresh clone, making the audit trail
 * meaningless.
 */
export function assertManifestConfigTracked(loaded: LoadedManifest, opts: { repoRoot?: string } = {}): void {
  const root = opts.repoRoot ?? resolveRepoRoot();
  const relPath = path.relative(root, loaded.manifestPath);
  const humanHint = `\n  git add ${relPath} && git commit -m "config: dataset manifest"\nOnce committed, future changes go through a PR against that file.`;

  try {
    execSync(`git ls-files --error-unmatch -- ${JSON.stringify(relPath)}`, {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    const stderrText = e.stderr?.toString() ?? '';
    if (/did not match any file/.test(stderrText) || /not in index/.test(stderrText)) {
      throw new Error(
        `dataset-manifest: ${relPath} is not tracked in git. The runner refuses to stamp a hash of an ` +
        `unrecoverable local file into the leaderboard.${humanHint}`,
      );
    }
    throw new Error(
      `dataset-manifest: failed to verify git-tracking status of ${relPath}: ${(err as Error).message}`,
    );
  }

  try {
    const stat = execSync(`git status --porcelain -- ${JSON.stringify(relPath)}`, {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
    if (stat.length > 0) {
      throw new Error(
        `dataset-manifest: ${relPath} has uncommitted changes (${stat.split('\n')[0]}). ` +
        `Commit the change through a PR or revert it before re-running.`,
      );
    }
  } catch (err) {
    if ((err as Error).message.includes('uncommitted changes')) throw err;
    throw new Error(
      `dataset-manifest: failed to verify git-clean status of ${relPath}: ${(err as Error).message}`,
    );
  }
}

/**
 * True iff the window [oosStart, oosEnd] is fully contained in the
 * manifest's holdout range. Used by the runner to sanity-check the
 * WFA-produced holdout windows against the declared manifest.
 */
export function windowFallsInHoldout(oosStart: string, oosEnd: string, m: DatasetManifest): boolean {
  return oosStart >= m.holdoutStartDate && oosEnd <= m.holdoutEndDate;
}

export function formatManifestSummary(loaded: LoadedManifest): string {
  const { manifest: m, rawHash } = loaded;
  return [
    `Dataset manifest loaded from ${CONFIG_REL} (sha256 ${rawHash.slice(0, 12)}...)`,
    `  data: ${m.dataStartDate} → ${m.dataEndDate}`,
    `  holdout: ${m.holdoutStartDate} → ${m.holdoutEndDate}`,
    `  version: ${m.manifestVersion}`,
  ].join('\n');
}
