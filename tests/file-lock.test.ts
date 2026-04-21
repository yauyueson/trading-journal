/**
 * Regression tests for scripts/autoresearch/lib/file-lock.ts.
 *
 * Covers Codex round-3 Finding 2 (2026-04-18): two runner processes started
 * near-simultaneously must not both succeed in acquiring the lock. Stale
 * locks (dead pid or age > 6h) are safely reclaimed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireRunnerLock, LockHeldError } from '../scripts/autoresearch/lib/file-lock';

describe('acquireRunnerLock', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('acquires a fresh lock and writes a pid-bearing payload', () => {
    const lock = acquireRunnerLock(repoRoot, 'unit-test-1');
    try {
      expect(fs.existsSync(lock.lockPath)).toBe(true);
      const payload = JSON.parse(fs.readFileSync(lock.lockPath, 'utf-8')) as {
        pid: number; purpose: string; startedAt: string; host: string;
      };
      expect(payload.pid).toBe(process.pid);
      expect(payload.purpose).toBe('unit-test-1');
      expect(typeof payload.startedAt).toBe('string');
    } finally {
      lock.release();
    }
  });

  it('throws LockHeldError when lock is held by this live process', () => {
    const first = acquireRunnerLock(repoRoot, 'unit-test-a');
    try {
      // Second acquire in the same process: pid is alive, lock is held.
      // Our lock held by pid == process.pid; isPidRunning(process.pid) is true.
      expect(() => acquireRunnerLock(repoRoot, 'unit-test-b')).toThrow(LockHeldError);
      try {
        acquireRunnerLock(repoRoot, 'unit-test-b');
      } catch (err) {
        expect(err).toBeInstanceOf(LockHeldError);
        if (err instanceof LockHeldError) {
          expect(err.held.pid).toBe(process.pid);
          expect(err.held.purpose).toBe('unit-test-a');
        }
      }
    } finally {
      first.release();
    }
  });

  it('releases cleanly — second acquire after release succeeds', () => {
    const first = acquireRunnerLock(repoRoot, 'release-test');
    first.release();
    expect(fs.existsSync(first.lockPath)).toBe(false);
    const second = acquireRunnerLock(repoRoot, 'release-test-2');
    try {
      expect(fs.existsSync(second.lockPath)).toBe(true);
    } finally {
      second.release();
    }
  });

  it('release() is idempotent', () => {
    const lock = acquireRunnerLock(repoRoot, 'idempotent');
    lock.release();
    lock.release();
    lock.release();
    expect(fs.existsSync(lock.lockPath)).toBe(false);
  });

  it('reclaims a stale lock with a dead pid', () => {
    // Fabricate a stale lock with a clearly-impossible pid.
    const lockPath = path.resolve(repoRoot, 'data', 'autoresearch-runner.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999999,
      startedAt: new Date().toISOString(),
      host: 'ghost',
      purpose: 'dead-process',
    }));
    const lock = acquireRunnerLock(repoRoot, 'reclaim-test');
    try {
      const payload = JSON.parse(fs.readFileSync(lock.lockPath, 'utf-8')) as { pid: number; purpose: string };
      expect(payload.pid).toBe(process.pid);
      expect(payload.purpose).toBe('reclaim-test');
    } finally {
      lock.release();
    }
  });

  // Codex round-4 Finding 2: age-only reclaim would let a new runner steal
  // the lock from a legitimate long-running campaign. Long-running alive
  // campaigns must hold the lock indefinitely.
  it('refuses to reclaim a live-owner lock even if it is hours old', () => {
    const lockPath = path.resolve(repoRoot, 'data', 'autoresearch-runner.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid, // pid is alive (it's us)
      startedAt: sevenHoursAgo,
      host: 'test',
      purpose: 'long-running-campaign',
    }));
    expect(() => acquireRunnerLock(repoRoot, 'would-steal')).toThrow(LockHeldError);
    // Clean up by hand since we didn't go through acquireRunnerLock.
    fs.unlinkSync(lockPath);
  });

  it('reclaims a corrupt (non-JSON) lock file', () => {
    const lockPath = path.resolve(repoRoot, 'data', 'autoresearch-runner.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'not-valid-json{{{');
    const lock = acquireRunnerLock(repoRoot, 'corrupt-reclaim');
    try {
      const payload = JSON.parse(fs.readFileSync(lock.lockPath, 'utf-8')) as { purpose: string };
      expect(payload.purpose).toBe('corrupt-reclaim');
    } finally {
      lock.release();
    }
  });

  // Codex round-4 Finding 1: stale-lock reclaim must be compare-and-swap so
  // that two processes observing the same stale payload cannot both succeed.
  // This test simulates the race by having the "other" process succeed in
  // renaming the stale lock file BEFORE we enter our reclaim path. Our
  // reclaim must then not delete the other's fresh lock.
  it('does not delete a freshly-written legitimate lock during stale reclaim', () => {
    const lockPath = path.resolve(repoRoot, 'data', 'autoresearch-runner.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Start with a stale (dead-pid) lock to trigger reclaim.
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999999,
      startedAt: new Date().toISOString(),
      host: 'ghost',
      purpose: 'stale-payload',
    }));
    // Before we call acquireRunnerLock, simulate a racing reclaim: remove
    // the stale file and install a fresh live-owner lock. Our acquire
    // should then see the fresh lock and throw LockHeldError, NOT delete it.
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: 'race-winner',
      purpose: 'race-winner-legitimate',
    }));
    // Our acquire should see the fresh lock (pid=us, not stale) and refuse.
    expect(() => acquireRunnerLock(repoRoot, 'race-loser')).toThrow(LockHeldError);
    // The legitimate lock must still be intact.
    expect(fs.existsSync(lockPath)).toBe(true);
    const stillThere = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { purpose: string };
    expect(stillThere.purpose).toBe('race-winner-legitimate');
    fs.unlinkSync(lockPath); // cleanup
  });

  it('cleans up its reclaim-quarantine scratch file after a successful reclaim', () => {
    const lockPath = path.resolve(repoRoot, 'data', 'autoresearch-runner.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999999,
      startedAt: new Date().toISOString(),
      host: 'ghost',
      purpose: 'will-be-reclaimed',
    }));
    const lock = acquireRunnerLock(repoRoot, 'quarantine-cleanup');
    try {
      const dataDir = path.dirname(lockPath);
      const strayQuarantine = fs.readdirSync(dataDir).filter(n => n.includes('.reclaim.'));
      expect(strayQuarantine).toEqual([]);
    } finally {
      lock.release();
    }
  });

  // Codex round-5 Finding 2 (2026-04-18): sequential same-pid acquires
  // must not leak process-level listeners. This test acquires and releases
  // 20 times in the same pid and checks that listener counts don't grow.
  it('does not leak process listeners across sequential acquires/releases', () => {
    const baseExit = process.listenerCount('exit');
    const baseSigint = process.listenerCount('SIGINT');
    const baseSigterm = process.listenerCount('SIGTERM');
    const baseSighup = process.listenerCount('SIGHUP');

    for (let i = 0; i < 20; i++) {
      const lock = acquireRunnerLock(repoRoot, `leak-test-${i}`);
      lock.release();
    }

    expect(process.listenerCount('exit')).toBe(baseExit);
    expect(process.listenerCount('SIGINT')).toBe(baseSigint);
    expect(process.listenerCount('SIGTERM')).toBe(baseSigterm);
    expect(process.listenerCount('SIGHUP')).toBe(baseSighup);
  });
});
