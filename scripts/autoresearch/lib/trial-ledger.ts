import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 0.a.3 (2026-04-18 foundation rebuild) — global trial ledger with
 * effective-trial tracking for multiple-testing correction.
 *
 * BACKGROUND
 *
 * Raw attempt count is a bad denominator for Deflated Sharpe when many of
 * our trials are **correlated** (e.g. a grid sweep over SL = 0.30 / 0.33 /
 * 0.35 produces near-identical strategies). López de Prado's false-strategy
 * theorem and Codex's round-1 methodology review both flag this: raw N can
 * over-deflate or under-deflate depending on correlation structure.
 *
 * EFFECTIVE TRIAL COUNT
 *
 * For a symmetric N×N correlation matrix `M` of the per-trial return
 * vectors, the **participation ratio** gives the effective rank:
 *
 *   N_eff = (Σλᵢ)² / Σλᵢ²
 *
 * For a symmetric matrix this simplifies to
 *
 *   N_eff = trace(M)² / ||M||_F²   =   N² / Σᵢⱼ Mᵢⱼ²
 *
 * (no eigendecomposition required because
 *  trace(M)     = Σλᵢ            — sum of diagonals
 *  ||M||_F²     = trace(M·Mᵀ)   = trace(M²) = Σλᵢ²   for symmetric M).
 *
 * Perfectly uncorrelated trials → N_eff ≈ N.
 * Perfectly correlated trials   → N_eff ≈ 1.
 *
 * STORAGE
 *
 * `data/attempts-global.json`  (index, small, ships with repo-local audit):
 *   { version: 2, count, lastSource, lastUpdated, trials: TrialEntry[] }
 *
 * `data/trial-ledger/trial-<ordinal>.json` (per-trial return vector):
 *   { ordinal, oosDates: string[], oosDailyReturns: number[], … }
 *
 * Both live under `data/` which is gitignored (per-machine audit only).
 * That matches the existing attempts-global behavior; cross-clone audit
 * is a separate phase.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface TrialEntry {
  ordinal: number;
  source: string;                       // e.g. "primary:smoke30-naive-d65-sl35-ts105"
  strategyName: string;
  timestamp: string;                    // ISO
  leaderboardSuffix: string;            // "" for primary, else campaign name
  oosSharpe: number;
  oosTrades: number;
  returnsFile: string;                  // relative to data/trial-ledger/
  adoptionGatesEffectiveHash?: string;  // round-3 audit field — links trial to gate version
  preRegBlockHash?: string;             // round-3 audit field — links trial to pre-reg
}

export interface TrialLedger {
  version: 2;
  count: number;
  lastSource: string;
  lastUpdated: string;
  trials: TrialEntry[];
}

export interface TrialReturns {
  ordinal: number;
  oosDates: string[];
  oosDailyReturns: number[];
  strategyName: string;
  timestamp: string;
}

export interface NEffResult {
  nRaw: number;
  nEff: number;
  method: 'participation-ratio';
  /** Number of trials used in the calculation (some may be dropped for sparse/misaligned data). */
  nUsed: number;
  /** Mean pairwise |correlation| across the N×N matrix (diagnostic only). */
  meanAbsCorrelation: number;
}

// ── Paths ───────────────────────────────────────────────────────────

function resolveRepoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '../../..');
}

function ledgerPath(repoRoot: string): string {
  return path.resolve(repoRoot, 'data/attempts-global.json');
}

function trialsDir(repoRoot: string): string {
  return path.resolve(repoRoot, 'data/trial-ledger');
}

function trialReturnsPath(repoRoot: string, ordinal: number): string {
  const padded = String(ordinal).padStart(6, '0');
  return path.resolve(trialsDir(repoRoot), `trial-${padded}.json`);
}

function pendingMarkerPath(repoRoot: string, ordinal: number): string {
  const padded = String(ordinal).padStart(6, '0');
  return path.resolve(trialsDir(repoRoot), `.pending-${padded}.json`);
}

/**
 * Scan `data/trial-ledger/` for existing `trial-NNNNNN.json` files and return
 * the maximum ordinal found. 0 if no directory or no matching files. Ignores
 * quarantined `.orphan.*` suffixes and pending-transaction markers.
 *
 * Phase 0.a.3 Codex round-2 Finding 1 (2026-04-18): using ledger.count alone
 * to pick the next ordinal would let a stale-backup restore silently
 * overwrite newer trial files. We cross-check against the actual directory
 * contents as part of appendTrial's collision protection.
 */
function scanMaxExistingOrdinal(repoRoot: string): number {
  const dir = trialsDir(repoRoot);
  if (!fs.existsSync(dir)) return 0;
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^trial-(\d{6})\.json$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Scan for `.pending-NNNNNN.json` transaction markers left by a crashed
 * append. Returns { ordinal, path } tuples sorted ascending by ordinal.
 */
function scanPendingMarkers(repoRoot: string): Array<{ ordinal: number; markerPath: string }> {
  const dir = trialsDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  const found: Array<{ ordinal: number; markerPath: string }> = [];
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^\.pending-(\d{6})\.json$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) {
      found.push({ ordinal: n, markerPath: path.resolve(dir, name) });
    }
  }
  return found.sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Codex Phase 0.a.3 round-5 Finding 1 (2026-04-18): the `count+1` fingerprint
 * alone is not enough to distinguish a crashed-mid-append from a stale-
 * backup-off-by-one, so recovery needs an EXPLICIT transaction marker.
 *
 * Before writing the returns file, appendTrial now writes a
 * `.pending-<ordinal>.json` marker carrying the full TrialEntry blueprint.
 * On the next run, this function:
 *   - Commits any pending transaction whose returns file exists on disk AND
 *     whose ordinal = ledger.count + 1 AND whose ordinal is not already in
 *     ledger.trials. The ledger is extended with the blueprint entry.
 *   - Deletes stale markers (no matching returns file, or already in ledger).
 *
 * Ambiguous cases fail closed (do NOT auto-recover a restore-off-by-one).
 * Returns the possibly-mutated ledger so the caller sees the committed count.
 */
function reconcilePendingTransactions(repoRoot: string, ledger: TrialLedger): TrialLedger {
  const markers = scanPendingMarkers(repoRoot);
  if (markers.length === 0) return ledger;

  let current = ledger;
  let mutated = false;
  const alreadyInLedger = new Set(ledger.trials.map(t => t.ordinal));

  for (const { ordinal, markerPath } of markers) {
    const returnsPath = trialReturnsPath(repoRoot, ordinal);
    const canonicalReturnsFile = path.basename(returnsPath);
    let blueprint: TrialEntry | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Partial<TrialEntry>;
      // Codex round-6 Finding 2: strict blueprint validation. Reject any
      // marker where the `returnsFile` isn't exactly the canonical basename
      // for the ordinal (no path separators, no traversal, no pointing at
      // a different trial's file), and cross-check the actual returns file's
      // content matches the marker's ordinal + strategyName before promotion.
      if (typeof raw.ordinal === 'number' && raw.ordinal === ordinal &&
          typeof raw.source === 'string' &&
          typeof raw.strategyName === 'string' &&
          typeof raw.timestamp === 'string' &&
          typeof raw.returnsFile === 'string' &&
          raw.returnsFile === canonicalReturnsFile &&
          typeof raw.oosSharpe === 'number' &&
          typeof raw.oosTrades === 'number' &&
          typeof raw.leaderboardSuffix === 'string') {
        blueprint = raw as TrialEntry;
      }
    } catch { /* corrupt marker treated as stale */ }

    // Validate that the on-disk returns file actually corresponds to this
    // marker — the same ordinal and strategy the marker claims. Defends
    // against a marker that points at a hand-swapped or renamed trial file.
    let returnsFileValid = false;
    if (blueprint && fs.existsSync(returnsPath)) {
      try {
        const returnsObj = JSON.parse(fs.readFileSync(returnsPath, 'utf-8')) as Partial<TrialReturns>;
        if (returnsObj.ordinal === ordinal &&
            returnsObj.strategyName === blueprint.strategyName &&
            Array.isArray(returnsObj.oosDates) &&
            Array.isArray(returnsObj.oosDailyReturns)) {
          returnsFileValid = true;
        }
      } catch { /* corrupt returns file treated as unrecoverable */ }
    }

    const returnsFileExists = returnsFileValid;
    const alreadyCommitted = alreadyInLedger.has(ordinal);
    const isNextOrdinal = ordinal === current.count + 1;

    if (blueprint && returnsFileExists && !alreadyCommitted && isNextOrdinal) {
      // Legitimate crash-mid-commit: promote the blueprint into the ledger.
      const committed: TrialLedger = {
        version: 2,
        count: ordinal,
        lastSource: blueprint.source,
        lastUpdated: blueprint.timestamp,
        trials: [...current.trials, blueprint],
      };
      const lp = ledgerPath(repoRoot);
      const tmp = `${lp}.tmp.recover.${process.pid}.${Date.now()}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(committed, null, 2));
        fs.renameSync(tmp, lp);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw new Error(
          `trial-ledger: found pending-transaction marker for ordinal ${ordinal} but could ` +
          `not commit it to the ledger (${(err as Error).message}). Marker left in place; ` +
          `resolve manually before re-running.`,
        );
      }
      current = committed;
      alreadyInLedger.add(ordinal);
      mutated = true;
      try { fs.unlinkSync(markerPath); } catch { /* best effort; stray marker is harmless on next pass */ }
      console.warn(
        `[trial-ledger] recovered crashed transaction for ordinal ${ordinal} ` +
        `(strategy "${blueprint.strategyName}"): committed to ledger and cleared marker.`,
      );
    } else {
      // Stale or unrecoverable marker. Delete it so future scans aren't
      // confused. Cases:
      //   - no returns file: append never made it to disk, nothing to recover
      //   - already in ledger: double-commit safety; marker is vestigial
      //   - ordinal doesn't match count+1: stale-backup territory, will be
      //     rejected by the main stale-guard below with a clear message
      try { fs.unlinkSync(markerPath); } catch { /* best effort */ }
    }
  }
  if (mutated) {
    // Just in case the ledger on disk changed outside our control during
    // recovery (very unlikely), reload so callers see a consistent view.
    return loadTrialLedger({ repoRoot });
  }
  return current;
}

// ── Load / migrate ──────────────────────────────────────────────────

export function loadTrialLedger(opts: { repoRoot?: string } = {}): TrialLedger {
  const root = opts.repoRoot ?? resolveRepoRoot();
  const p = ledgerPath(root);
  if (!fs.existsSync(p)) {
    // Legitimately first run on this machine — empty ledger is correct.
    return { version: 2, count: 0, lastSource: '', lastUpdated: '', trials: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    // Codex Phase 0.a.3 Finding 1: fail-open to {count:0, trials:[]} would
    // make the next append reuse ordinal 1 and silently overwrite
    // trial-000001.json. That destroys the audit trail and corrupts the
    // multiple-testing denominator. Fail closed instead.
    throw new Error(
      `trial-ledger: ${p} exists but could not be parsed (${(err as Error).message}). ` +
      `Refusing to proceed — a silent reset would overwrite per-trial files and destroy ` +
      `the audit history. Restore the file from a backup or repair it manually before re-running.`,
    );
  }
  const obj = raw as Partial<TrialLedger> & { count?: number; lastSource?: string; lastUpdated?: string };
  // V1 → V2 migration: historical entries have no per-trial rows. Keep the
  // count so prior deflated-Sharpe history is preserved; new entries fill in.
  return {
    version: 2,
    count: typeof obj.count === 'number' ? obj.count : 0,
    lastSource: typeof obj.lastSource === 'string' ? obj.lastSource : '',
    lastUpdated: typeof obj.lastUpdated === 'string' ? obj.lastUpdated : '',
    trials: Array.isArray(obj.trials) ? obj.trials : [],
  };
}

// ── Append ──────────────────────────────────────────────────────────

export interface AppendTrialInput {
  source: string;
  strategyName: string;
  leaderboardSuffix: string;
  oosSharpe: number;
  oosTrades: number;
  oosDates: string[];
  oosDailyReturns: number[];
  adoptionGatesEffectiveHash?: string;
  preRegBlockHash?: string;
  /** Override clock for tests. */
  now?: Date;
  repoRoot?: string;
}

export interface AppendTrialResult {
  ordinal: number;
  ledger: TrialLedger;
  returnsPath: string;
}

export function appendTrial(input: AppendTrialInput): AppendTrialResult {
  const root = input.repoRoot ?? resolveRepoRoot();
  if (input.oosDates.length !== input.oosDailyReturns.length) {
    throw new Error(
      `trial-ledger: oosDates.length=${input.oosDates.length} != oosDailyReturns.length=${input.oosDailyReturns.length}`,
    );
  }
  let ledger = loadTrialLedger({ repoRoot: root });

  // First, reconcile any pending-transaction markers left by a crashed
  // mid-append. ONLY transactions that were explicitly marked as in-flight
  // are auto-recovered; the fingerprint alone (orphan at count+1) is not
  // enough to distinguish a crash from a stale-backup-off-by-one.
  // Codex round-5 Finding 1 (2026-04-18) replacement.
  ledger = reconcilePendingTransactions(root, ledger);

  // After reconciliation, cross-check the ledger against the trial
  // directory. Any remaining count mismatch (no matching pending marker)
  // is either a stale backup restore or an unflagged orphan; fail closed
  // — Codex round-2 Finding 1.
  const maxExistingOrdinal = scanMaxExistingOrdinal(root);
  if (ledger.count < maxExistingOrdinal) {
    throw new Error(
      `trial-ledger: ledger count (${ledger.count}) is behind the trial directory ` +
      `(max ordinal on disk = ${maxExistingOrdinal}; ${maxExistingOrdinal - ledger.count} unflagged orphan files). ` +
      `This usually means the ledger was restored from a backup that predates the trial files. ` +
      `Restore the ledger to a snapshot consistent with data/trial-ledger/, or move the stray trial-*.json ` +
      `files out of the directory if they are from abandoned runs. Refusing to append to avoid silent data loss.`,
    );
  }
  // Use the max(ledger, directory) so legacy v1 counts (ledger ahead of the
  // trial directory because there are no v2 files yet) still produce a
  // monotonic ordinal.
  const ordinal = Math.max(ledger.count, maxExistingOrdinal) + 1;
  const timestamp = (input.now ?? new Date()).toISOString();
  const returnsFile = path.basename(trialReturnsPath(root, ordinal));

  const entry: TrialEntry = {
    ordinal,
    source: input.source,
    strategyName: input.strategyName,
    timestamp,
    leaderboardSuffix: input.leaderboardSuffix,
    oosSharpe: input.oosSharpe,
    oosTrades: input.oosTrades,
    returnsFile,
    adoptionGatesEffectiveHash: input.adoptionGatesEffectiveHash,
    preRegBlockHash: input.preRegBlockHash,
  };

  const newLedger: TrialLedger = {
    version: 2,
    count: ordinal,
    lastSource: input.source,
    lastUpdated: timestamp,
    trials: [...ledger.trials, entry],
  };

  fs.mkdirSync(trialsDir(root), { recursive: true });
  const returnsPath = trialReturnsPath(root, ordinal);
  const markerPath = pendingMarkerPath(root, ordinal);
  const returnsBlob: TrialReturns = {
    ordinal,
    oosDates: input.oosDates,
    oosDailyReturns: input.oosDailyReturns,
    strategyName: input.strategyName,
    timestamp,
  };

  // Step 1: Write the pending-transaction marker. Carries the full
  // blueprint of the TrialEntry we're about to commit so a crash can
  // be recovered on the next run without ambiguity. flag: 'wx' so two
  // concurrent processes can't both enter the marker-write state.
  try {
    fs.writeFileSync(markerPath, JSON.stringify(entry), { flag: 'wx' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') {
      throw new Error(
        `trial-ledger: a pending-transaction marker already exists at ${markerPath}. ` +
        `Either another process is appending the same ordinal, or a prior crash left a marker ` +
        `that the reconcile pass couldn't clean. Inspect and resolve manually.`,
      );
    }
    throw err;
  }

  // Step 2: Write the returns file (per-trial detail).
  // Use flag: 'wx' so a pre-existing file at this ordinal is a hard error
  // instead of a silent overwrite — belt-and-suspenders for the ledger/
  // directory monotonicity check above (Codex round-2 Finding 1, 2026-04-18).
  // Codex round-6 Finding 1: the rollback here is symmetric with Step 3's —
  // attempt to clean BOTH the marker and any partial returns file, and
  // report MANUAL RECOVERY REQUIRED if either cleanup fails.
  try {
    fs.writeFileSync(returnsPath, JSON.stringify(returnsBlob), { flag: 'wx' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;

    // Codex round-7 Finding 1: EEXIST means the returns file was ALREADY
    // there before this append started — it is NOT ours to delete. In the
    // race scenario the stale-guard would have caught this is rare, but
    // if we get here (e.g. a concurrent process sneaked in), removing
    // the pre-existing file destroys someone else's audit row. Only clean
    // up our own marker and surface a clear race/collision error.
    if (e.code === 'EEXIST') {
      let markerCleanupErr: Error | null = null;
      try { fs.unlinkSync(markerPath); } catch (ce) { markerCleanupErr = ce as Error; }
      const baseMsg = `trial-ledger: refusing to overwrite existing ${returnsPath}. ` +
        `The ordinal-collision check passed but the file exists anyway — possibly a race ` +
        `with another runner process or a partial cleanup. The pre-existing file was left untouched.`;
      if (!markerCleanupErr) {
        throw new Error(`${baseMsg} Marker was rolled back; investigate the pre-existing file before re-running.`);
      }
      throw new Error(
        `${baseMsg} MANUAL RECOVERY REQUIRED: marker cleanup also failed at ${markerPath} ` +
        `(${markerCleanupErr.message}); delete the marker before re-running.`,
      );
    }

    // Non-EEXIST errors (ENOSPC, EIO, permission...): the returns file may
    // or may not have been partially created. Attempt symmetric cleanup of
    // both marker and any partial returns file.
    let markerCleanupErr: Error | null = null;
    try { fs.unlinkSync(markerPath); } catch (ce) { markerCleanupErr = ce as Error; }
    let returnsCleanupErr: Error | null = null;
    try { fs.unlinkSync(returnsPath); } catch (ce) {
      // ENOENT here is fine — the file was never created.
      const ie = ce as NodeJS.ErrnoException;
      if (ie.code !== 'ENOENT') returnsCleanupErr = ce as Error;
    }

    const baseMsg = `trial-ledger: failed to write returns file for ordinal ${ordinal} (${(err as Error).message}).`;
    if (!markerCleanupErr && !returnsCleanupErr) {
      throw new Error(`${baseMsg} Rollback succeeded (marker + partial returns removed); the next append can proceed.`);
    }
    const leftovers: string[] = [];
    if (markerCleanupErr) leftovers.push(`${markerPath} (${markerCleanupErr.message})`);
    if (returnsCleanupErr) leftovers.push(`${returnsPath} (${returnsCleanupErr.message})`);
    throw new Error(
      `${baseMsg} MANUAL RECOVERY REQUIRED: rollback failed too — could not remove: ${leftovers.join('; ')}. ` +
      `The next append will be blocked until you delete these files.`,
    );
  }

  // Step 3: Commit the ledger update via atomic temp + rename. If this
  // fails, the returns file + pending marker BOTH need rollback so the
  // next run doesn't see a false orphan or a stuck pending marker.
  const lp = ledgerPath(root);
  const tmp = `${lp}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(newLedger, null, 2));
    fs.renameSync(tmp, lp);
  } catch (ledgerErr) {
    let returnsCleanupErr: Error | null = null;
    try { fs.unlinkSync(returnsPath); } catch (e) { returnsCleanupErr = e as Error; }
    let markerCleanupErr: Error | null = null;
    try { fs.unlinkSync(markerPath); } catch (e) { markerCleanupErr = e as Error; }
    let tmpCleanupErr: Error | null = null;
    try { fs.unlinkSync(tmp); } catch (e) { tmpCleanupErr = e as Error; }

    const baseMsg = `trial-ledger: failed to commit ledger update for ordinal ${ordinal} (${(ledgerErr as Error).message}).`;
    if (!returnsCleanupErr && !markerCleanupErr) {
      throw new Error(
        `${baseMsg} Rollback succeeded (returns file + pending marker removed); the next append can proceed.` +
        (tmpCleanupErr ? ` (A tmp file at ${tmp} was left behind: ${tmpCleanupErr.message}.)` : ''),
      );
    } else {
      const leftovers: string[] = [];
      if (returnsCleanupErr) leftovers.push(`${returnsPath} (${returnsCleanupErr.message})`);
      if (markerCleanupErr) leftovers.push(`${markerPath} (${markerCleanupErr.message})`);
      throw new Error(
        `${baseMsg} MANUAL RECOVERY REQUIRED: rollback failed too — could not remove: ` +
        `${leftovers.join('; ')}. The next append will be blocked until you delete these files.` +
        (tmpCleanupErr ? ` Also orphaned: ${tmp} (${tmpCleanupErr.message}).` : ''),
      );
    }
  }

  // Step 4: Ledger committed successfully. Delete the pending marker.
  // If this fails the next run's reconcilePendingTransactions() will
  // detect the marker matches an already-committed ordinal and clean it
  // up automatically, so it's genuinely best-effort here.
  try { fs.unlinkSync(markerPath); } catch { /* best effort */ }

  return { ordinal, ledger: newLedger, returnsPath };
}

// ── N_eff computation ───────────────────────────────────────────────

function loadTrialReturns(repoRoot: string, entry: TrialEntry): TrialReturns | null {
  const p = path.resolve(trialsDir(repoRoot), entry.returnsFile);
  if (!fs.existsSync(p)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8')) as TrialReturns;
    if (!Array.isArray(obj.oosDates) || !Array.isArray(obj.oosDailyReturns)) return null;
    if (obj.oosDates.length !== obj.oosDailyReturns.length) return null;
    return obj;
  } catch {
    return null;
  }
}

function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;
  const n = x.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (!isFinite(denom) || denom < 1e-15) return 0;
  return Math.max(-1, Math.min(1, num / denom));
}

/**
 * Build a rectangular panel of returns on the common set of dates across all
 * trials. Codex Phase 0.a.3 Finding 3: pairwise correlation on different
 * date subsets does NOT produce a positive-semi-definite matrix, so the
 * participation-ratio shortcut (trace²/Frobenius²) no longer holds exactly.
 *
 * Aligning every trial to the same rows gives a genuine correlation matrix
 * that IS PSD. Trials that don't cover the common intersection for at least
 * `minOverlap` dates are dropped and counted as independent legacy trials.
 */
function buildCommonPanel(
  trials: TrialReturns[],
  minOverlap: number,
  minCoverageRatio: number,
): { columns: TrialReturns[]; panel: number[][]; dropped: number } {
  if (trials.length === 0) return { columns: [], panel: [], dropped: 0 };
  if (trials.length === 1) {
    return {
      columns: trials[0].oosDailyReturns.length >= minOverlap ? [trials[0]] : [],
      panel: trials[0].oosDailyReturns.length >= minOverlap ? [trials[0].oosDailyReturns.slice()] : [],
      dropped: trials[0].oosDailyReturns.length >= minOverlap ? 0 : 1,
    };
  }

  // Date intersection across all trials.
  let common: Set<string> = new Set(trials[0].oosDates);
  for (let i = 1; i < trials.length; i++) {
    const next = new Set(trials[i].oosDates);
    const kept = new Set<string>();
    for (const d of common) if (next.has(d)) kept.add(d);
    common = kept;
  }

  if (common.size < minOverlap) {
    // No meaningful shared date window. Fall back to keeping no aligned pairs
    // — all trials count as independent legacy.
    return { columns: [], panel: [], dropped: trials.length };
  }

  // Coverage-ratio filter (Codex round-2 Finding 2, 2026-04-18): a trial
  // joins the panel only when the common window covers at least
  // `minCoverageRatio` of its own history. Otherwise a rolling/staggered
  // trial whose full history barely overlaps the panel can be spuriously
  // correlated on the tiny slice, collapsing N_eff anti-conservatively.
  // Trials that fail the filter are dropped to the legacy bucket (the
  // `dropped` count) and counted as additively independent.
  const filtered: TrialReturns[] = [];
  const commonSize = common.size;
  let coverageDrops = 0;
  for (const t of trials) {
    if (t.oosDates.length === 0) { coverageDrops++; continue; }
    const coverage = commonSize / t.oosDates.length;
    if (coverage < minCoverageRatio) coverageDrops++;
    else filtered.push(t);
  }

  if (filtered.length < 2) {
    // Nothing meaningful to correlate. Everyone's independent.
    return { columns: [], panel: [], dropped: trials.length };
  }

  const sortedDates = Array.from(common).sort();
  const columns: TrialReturns[] = [];
  const panel: number[][] = [];
  let missingData = 0;

  for (const t of filtered) {
    const byDate = new Map<string, number>();
    for (let i = 0; i < t.oosDates.length; i++) {
      const v = t.oosDailyReturns[i];
      if (Number.isFinite(v)) byDate.set(t.oosDates[i], v);
    }
    const row: number[] = [];
    let ok = true;
    for (const d of sortedDates) {
      const v = byDate.get(d);
      if (v == null) { ok = false; break; }
      row.push(v);
    }
    if (ok) {
      columns.push(t);
      panel.push(row);
    } else {
      missingData++;
    }
  }
  return { columns, panel, dropped: coverageDrops + missingData };
}

export interface ComputeOpts {
  repoRoot?: string;
  minOverlapDays?: number;    // minimum shared date count required to include a trial in the N×N correlation matrix. Default 20.
  minCoverageRatio?: number;  // fraction of each trial's own history that must be in the common window. Default 0.5.
}

export function computeEffectiveTrialCount(ledger: TrialLedger, opts: ComputeOpts = {}): NEffResult {
  const root = opts.repoRoot ?? resolveRepoRoot();
  const minOverlap = opts.minOverlapDays ?? 20;
  const minCoverageRatio = opts.minCoverageRatio ?? 0.5;
  const usable: TrialReturns[] = [];
  for (const e of ledger.trials) {
    const r = loadTrialReturns(root, e);
    if (r && r.oosDailyReturns.length >= minOverlap) usable.push(r);
  }
  const { columns, panel, dropped } = buildCommonPanel(usable, minOverlap, minCoverageRatio);
  const n = columns.length;

  // Legacy attempts have no return vector on disk (or were dropped from the
  // panel for insufficient overlap). Codex Phase 0.a.3 Finding 2: treat them
  // as ADDITIVELY independent rather than scaling the raw count by the
  // observed compression ratio. Additive = genuinely conservative (≥
  // legacyCount under any correlation structure); multiplicative was
  // anti-conservative (made Deflated Sharpe LESS punitive).
  const legacyCount = Math.max(0, ledger.count - n);

  if (n <= 1) {
    // With 0 or 1 usable trials we can't estimate correlation. N_eff equals
    // the raw count (plus an indicator that computation was skipped).
    return {
      nRaw: ledger.count,
      nEff: Math.max(1, ledger.count),
      method: 'participation-ratio',
      nUsed: n,
      meanAbsCorrelation: 0,
    };
  }

  // Compute the N×N correlation matrix on the aligned panel. Because every
  // trial uses the same rows, the matrix is guaranteed PSD and trace²/||·||_F²
  // is the exact participation ratio.
  let offDiagSumSq = 0;
  let offDiagAbsSum = 0;
  let offDiagCount = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = pearsonCorrelation(panel[i], panel[j]);
      offDiagSumSq += c * c;
      offDiagAbsSum += Math.abs(c);
      offDiagCount += 1;
    }
  }
  const frobeniusSq = n + 2 * offDiagSumSq;
  const nEffUsed = (n * n) / frobeniusSq;

  // Total: aligned-panel contribution + independent legacy contribution.
  const nEffFull = Math.max(1, legacyCount + nEffUsed);

  // `dropped` (trials with return vectors that failed the coverage-ratio
  // filter or lacked data in the common window) is already rolled into
  // `legacyCount = ledger.count - n` above, so we don't need to add it
  // separately. Reference it to silence the unused-variable warning.
  void dropped;

  return {
    nRaw: ledger.count,
    nEff: nEffFull,
    method: 'participation-ratio',
    nUsed: n,
    meanAbsCorrelation: offDiagCount > 0 ? offDiagAbsSum / offDiagCount : 0,
  };
}

export function formatTrialBudgetReport(ledger: TrialLedger, nEff: NEffResult): string {
  const lines = [
    `# Trial Budget`,
    ``,
    `Auto-generated by \`scripts/compute-effective-trials.ts\`. Do not edit by hand.`,
    ``,
    `- **Raw attempt count (N_raw)**: ${nEff.nRaw}`,
    `- **Effective independent trials (N_eff)**: ${nEff.nEff.toFixed(2)}`,
    `- **Method**: participation-ratio (trace²/Frobenius²)`,
    `- **Trials with return vectors on disk**: ${nEff.nUsed}`,
    `- **Mean pairwise |ρ| across return vectors**: ${nEff.meanAbsCorrelation.toFixed(3)}`,
    ``,
    `## Interpretation`,
    ``,
    `Deflated Sharpe and PBO should use N_eff, not N_raw, as the multiple-testing denominator.`,
    `A haircut of N_raw for highly-correlated grid sweeps would under-penalize; the participation-ratio`,
    `N_eff measures how many *independent* trials we've effectively run.`,
    ``,
    `## Recent trials`,
    ``,
    `| # | Source | Strategy | Sharpe | Trades | When |`,
    `|---|--------|----------|--------|--------|------|`,
  ];
  const recent = ledger.trials.slice(-20);
  for (const t of recent) {
    lines.push(
      `| ${t.ordinal} | ${t.source} | ${t.strategyName} | ${t.oosSharpe.toFixed(3)} | ${t.oosTrades} | ${t.timestamp.slice(0, 10)} |`,
    );
  }
  if (ledger.trials.length === 0) lines.push(`| — | (no v2 entries yet) | | | | |`);
  lines.push(``);
  lines.push(`> Legacy attempts before Phase 0.a.3 (this rebuild) are counted in N_raw but have no return vector on disk, so they contribute conservatively to N_eff.`);
  return lines.join('\n') + '\n';
}
