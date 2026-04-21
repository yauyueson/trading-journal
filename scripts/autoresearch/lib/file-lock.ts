import fs from 'fs';
import path from 'path';

/**
 * Cooperative single-writer file lock for the autoresearch runner.
 *
 * The runner reads+modifies+writes several JSON files in a loop
 * (`data/leaderboard-*.json`, `data/attempts-global.json`). Without a lock,
 * two runner processes that start near-simultaneously can both read the same
 * snapshot, each append their own row, and the last writer wins — one row is
 * lost and the global attempt counter stays low by one. Codex adversarial
 * re-review (round 3, 2026-04-18) Finding 2.
 *
 * Design:
 *   - `fs.writeFileSync(lockPath, payload, { flag: 'wx' })` atomically creates
 *     the lock file or fails if it exists.
 *   - Lock payload contains `{ pid, startedAt, host }` so a stale lock can be
 *     recognized (process-not-running OR >6 h old).
 *   - Acquirer releases the lock in a `finally`-style unlock call.
 *   - On stale lock: reclaim with a console warning; log the old payload.
 *
 * Ergonomics:
 *   - Solo-user machine → retries are rarely useful. Default is single-shot:
 *     if the lock is held by a live process, abort with a clear error that
 *     names the other pid.
 *   - For CI or parallel experimentation we could add retry; not today.
 */

export interface LockPayload {
  pid: number;
  startedAt: string;
  host: string;
  purpose: string;
}

export interface AcquiredLock {
  lockPath: string;
  payload: LockPayload;
  release(): void;
}

export class LockHeldError extends Error {
  constructor(public readonly held: LockPayload, public readonly lockPath: string) {
    super(`Autoresearch lock at ${lockPath} is held by pid ${held.pid} (started ${held.startedAt} on ${held.host}, purpose: ${held.purpose}).`);
    this.name = 'LockHeldError';
  }
}

// Intentionally no age-based stale trigger. Codex round-4 Finding 2: a
// legitimate long-running campaign (multi-day parameter sweep) must not
// be reclaimable solely because it's been running > N hours. Reclaim is
// only permitted when the pid is actually gone or the lock file is
// corrupt. Pid reuse across days is extremely unlikely on modern OSes,
// and the worst case (manual cleanup required) is visible and recoverable.

function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 = probe, does not send anything. Throws if pid doesn't exist
    // or is not accessible by this user.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM = pid exists but we can't signal (still counts as "alive").
    if (e.code === 'EPERM') return true;
    return false;
  }
}

function readLockPayload(lockPath: string): LockPayload | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.host === 'string' &&
      typeof parsed.purpose === 'string'
    ) {
      return parsed as LockPayload;
    }
    return null;
  } catch {
    return null;
  }
}

export function acquireRunnerLock(repoRoot: string, purpose: string): AcquiredLock {
  const lockDir = path.resolve(repoRoot, 'data');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.resolve(lockDir, 'autoresearch-runner.lock');

  const payload: LockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown',
    purpose,
  };
  const payloadJson = JSON.stringify(payload);

  const tryWrite = (): boolean => {
    try {
      fs.writeFileSync(lockPath, payloadJson, { flag: 'wx' });
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EEXIST') return false;
      throw err;
    }
  };

  if (tryWrite()) {
    return makeLock(lockPath, payload);
  }

  const existing = readLockPayload(lockPath);

  // Reclaim is only safe for corrupt-payload or dead-pid cases, and the
  // reclaim step itself must be atomic — two processes observing the same
  // stale file must not both unlink-then-write. We use renameSync as a
  // compare-and-swap: whichever process successfully renames the stale
  // file to its unique quarantine name is the sole reclaimer (Codex
  // round-4 Finding 1).
  const isCorrupt = existing === null;
  const isDeadOwner = existing !== null && !isPidRunning(existing.pid);
  if (!isCorrupt && !isDeadOwner) {
    // Lock is alive and valid. No reclaim.
    throw new LockHeldError(existing!, lockPath);
  }

  const quarantinePath = `${lockPath}.reclaim.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      // Another process reclaimed first. Retry the whole acquire flow once
      // — a fresh lock may now be ours for the taking, or someone else
      // may now legitimately hold it.
      if (tryWrite()) return makeLock(lockPath, payload);
      const afterRace = readLockPayload(lockPath);
      if (afterRace) throw new LockHeldError(afterRace, lockPath);
      throw new Error(`Failed to acquire lock at ${lockPath} after reclaim race`);
    }
    throw err;
  }
  // We own the reclaim. Safe to delete the quarantine and write fresh.
  try { fs.unlinkSync(quarantinePath); } catch { /* best effort */ }
  if (isCorrupt) {
    console.warn(`[lock] corrupt lock file at ${lockPath} — reclaimed (pid ${process.pid})`);
  } else {
    console.warn(`[lock] dead-owner lock at ${lockPath} (pid ${existing!.pid} not running) — reclaimed (pid ${process.pid})`);
  }
  if (tryWrite()) return makeLock(lockPath, payload);
  // Someone sneaked in between our rename and wx-write. Very unlikely but
  // handle gracefully.
  const after = readLockPayload(lockPath);
  if (after) throw new LockHeldError(after, lockPath);
  throw new Error(`Failed to acquire lock at ${lockPath} after successful reclaim`);
}

function makeLock(lockPath: string, payload: LockPayload): AcquiredLock {
  let released = false;

  const releaseCore = (): void => {
    if (released) return;
    released = true;
    try {
      const current = readLockPayload(lockPath);
      // Only delete if we still own it (same pid). Otherwise another
      // reclaim happened after a stale detection; don't stomp on it.
      if (current && current.pid === payload.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      /* best effort */
    }
  };

  // Codex round-5 Finding 2 (2026-04-18): sequential same-pid acquires
  // leaked handlers. Each lock now installs its own removable handlers
  // and uninstalls them on release(). Important for tests that exercise
  // acquireRunnerLock multiple times in one process, and for any future
  // orchestration that re-enters main().
  const exitHandler = (): void => { releaseCore(); };
  const signalHandlers: Array<{ sig: NodeJS.Signals; fn: NodeJS.SignalsListener }> = [];
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const fn: NodeJS.SignalsListener = () => {
      releaseCore();
      process.exit(130);
    };
    signalHandlers.push({ sig, fn });
  }

  const release = (): void => {
    if (released) {
      // Still remove handlers even on idempotent double-release.
      process.off('exit', exitHandler);
      for (const { sig, fn } of signalHandlers) process.off(sig, fn);
      return;
    }
    releaseCore();
    process.off('exit', exitHandler);
    for (const { sig, fn } of signalHandlers) process.off(sig, fn);
  };

  process.on('exit', exitHandler);
  for (const { sig, fn } of signalHandlers) process.on(sig, fn);

  return { lockPath, payload, release };
}
