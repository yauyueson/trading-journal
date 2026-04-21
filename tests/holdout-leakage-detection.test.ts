/**
 * Regression tests for holdout-outcome leakage into the autoresearch
 * search loop — Phase 0.a.4 of the 2026-04-18 foundation rebuild.
 *
 * Contract in scripts/autoresearch/lib/leaderboard-redaction.ts:
 *
 *   Denylist (runtime):  HOLDOUT_DERIVED_FIELDS + stripHoldoutMetrics (recursive).
 *   Allowlist (CI):      AGENT_VISIBLE_FIELDS — every top-level key in an
 *                        agent-visible row must be classified here.
 *   Structural guard:    isBannedHoldoutKey + collectBannedKeyPaths (recursive).
 *
 * Layers enforced here:
 *   L1   — stripHoldoutMetrics removes every banned key from a flat row.
 *   L2   — stripHoldoutMetrics preserves agent-visible fields.
 *   L3   — every on-disk agent-visible row uses only AGENT_VISIBLE_FIELDS keys.
 *   L3b  — regex guard catches a rogue holdout-named field not yet banned.
 *   L3c  — recursive scan catches a nested banned key.
 *   L3d  — allowlist catches an unknown, innocuously-named top-level field.
 *   L3e  — stripHoldoutMetrics recursively removes nested banned keys.
 *   L4   — audit leaderboards DO contain banned keys (agent/full paths not swapped).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_VISIBLE_FIELDS,
  HOLDOUT_DERIVED_FIELDS,
  collectBannedKeyPaths,
  isBannedHoldoutKey,
  stripHoldoutMetrics,
} from '../scripts/autoresearch/lib/leaderboard-redaction';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const AGENT_DIR = path.resolve(REPO_ROOT, 'scripts/autoresearch');
const AUDIT_DIR = path.resolve(REPO_ROOT, 'data');

function syntheticBannedRow(): Record<string, unknown> {
  const row: Record<string, unknown> = {
    strategyName: 'test-strategy',
    oosSharpe: 1.23,
    oosSpyIR: 0.45,
    isValidForSearch: true,
    attemptNumber: 42,
    deflatedSharpe: 0.87,
    preRegBypassed: false,
    adoptionGatesRawHash: 'sha256:deadbeef',
  };
  for (const f of HOLDOUT_DERIVED_FIELDS) {
    row[f] = f === 'isValid' || f.startsWith('passes') ? true : 0.99;
  }
  return row;
}

function listAgentLeaderboards(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => /^leaderboard.*\.json$/.test(f))
    .map(f => path.join(dir, f));
}

function listAuditLeaderboards(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => /^leaderboard-full.*\.json$/.test(f))
    .map(f => path.join(dir, f));
}

type Leak = { file: string; rowIdx: number; keyPath: string };

/** Recursive scan: any banned key at any depth is a leak. */
function scanFileForLeaks(file: string): Leak[] {
  const raw = fs.readFileSync(file, 'utf-8');
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(rows)) throw new Error(`${file} top-level is not an array`);
  const leaks: Leak[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (const keyPath of collectBannedKeyPaths(rows[i])) {
      leaks.push({ file, rowIdx: i, keyPath });
    }
  }
  return leaks;
}

/** Allowlist scan: any top-level key not in AGENT_VISIBLE_FIELDS is unknown. */
type UnknownField = { file: string; rowIdx: number; key: string };
function scanFileForUnknownFields(file: string): UnknownField[] {
  const raw = fs.readFileSync(file, 'utf-8');
  const rows = JSON.parse(raw) as unknown;
  if (!Array.isArray(rows)) throw new Error(`${file} top-level is not an array`);
  const allow = new Set<string>(AGENT_VISIBLE_FIELDS);
  const hits: UnknownField[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row == null || typeof row !== 'object') continue;
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (!allow.has(key)) hits.push({ file, rowIdx: i, key });
    }
  }
  return hits;
}

describe('Phase 0.a.4 — holdout-leakage redaction', () => {
  // ── L1 ───────────────────────────────────────────────────
  it('L1: stripHoldoutMetrics removes every top-level field in HOLDOUT_DERIVED_FIELDS', () => {
    const stripped = stripHoldoutMetrics(syntheticBannedRow() as never) as Record<string, unknown>;
    for (const f of HOLDOUT_DERIVED_FIELDS) {
      expect(stripped).not.toHaveProperty(f);
    }
  });

  // ── L2 ───────────────────────────────────────────────────
  it('L2: stripHoldoutMetrics preserves agent-visible fields', () => {
    const stripped = stripHoldoutMetrics(syntheticBannedRow() as never) as Record<string, unknown>;
    for (const key of [
      'strategyName', 'oosSharpe', 'oosSpyIR', 'isValidForSearch',
      'attemptNumber', 'deflatedSharpe', 'preRegBypassed', 'adoptionGatesRawHash',
    ]) {
      expect(stripped).toHaveProperty(key);
    }
  });

  it('L2: isBannedHoldoutKey returns false for safe keys', () => {
    for (const key of ['oosSharpe', 'oosSpyIR', 'isValidForSearch', 'strategyName', 'deflatedSharpe']) {
      expect(isBannedHoldoutKey(key)).toBe(false);
    }
  });

  it('L2: HOLDOUT_DERIVED_FIELDS and AGENT_VISIBLE_FIELDS are disjoint', () => {
    const allow = new Set<string>(AGENT_VISIBLE_FIELDS);
    for (const f of HOLDOUT_DERIVED_FIELDS) {
      expect(allow.has(f)).toBe(false);
    }
  });

  // ── L3 ───────────────────────────────────────────────────
  // Primary guarantee: every top-level key in every on-disk agent row is
  // in AGENT_VISIBLE_FIELDS. This catches the "new field not classified"
  // regression regardless of whether the name advertises its purpose.
  it('L3: every agent-visible row uses only AGENT_VISIBLE_FIELDS keys', () => {
    const files = listAgentLeaderboards(AGENT_DIR);
    if (files.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[holdout-leakage L3] no leaderboard*.json found in ${AGENT_DIR}; scan skipped`);
      return;
    }
    const unknownByKey = new Map<string, { file: string; rowIdx: number }>();
    for (const f of files) {
      for (const hit of scanFileForUnknownFields(f)) {
        if (!unknownByKey.has(hit.key)) {
          unknownByKey.set(hit.key, { file: hit.file, rowIdx: hit.rowIdx });
        }
      }
    }
    if (unknownByKey.size > 0) {
      const details = [...unknownByKey.entries()]
        .map(([k, loc]) => `  ${k}  (first at ${path.relative(REPO_ROOT, loc.file)}:row[${loc.rowIdx}])`)
        .join('\n');
      throw new Error(
        `Agent-visible leaderboards contain top-level keys not in AGENT_VISIBLE_FIELDS.\n` +
        `Classify each in scripts/autoresearch/lib/leaderboard-redaction.ts — either\n` +
        `add to AGENT_VISIBLE_FIELDS (safe for the search agent) or to\n` +
        `HOLDOUT_DERIVED_FIELDS (strip before writing to agent path).\n\n` +
        `Unknown keys:\n${details}`,
      );
    }
  });

  // Deep scan backstop: beyond the allowlist, recursively check every row
  // for any banned key at any depth. Catches nested leaks like
  // diagnostics.holdoutSharpe that the top-level allowlist can't see.
  it('L3: recursive scan finds no banned keys anywhere in agent rows', () => {
    const files = listAgentLeaderboards(AGENT_DIR);
    if (files.length === 0) return; // L3 above already warned
    const allLeaks: Leak[] = [];
    for (const f of files) allLeaks.push(...scanFileForLeaks(f));
    if (allLeaks.length > 0) {
      const msg = allLeaks
        .slice(0, 10)
        .map(l => `${path.relative(REPO_ROOT, l.file)}:row[${l.rowIdx}]:${l.keyPath}`)
        .join('\n  ');
      throw new Error(
        `Agent-visible leaderboards must not contain holdout fields at any depth.\n` +
        `Scanned ${files.length} file(s), found ${allLeaks.length} leak(s):\n  ${msg}` +
        (allLeaks.length > 10 ? `\n  ... and ${allLeaks.length - 10} more` : ''),
      );
    }
  });

  // ── L3b / L3c / L3d / L3e — regression guards ───────────
  describe('regression guards (synthetic fixtures)', () => {
    const tmpDirs: string[] = [];
    afterEach(() => {
      while (tmpDirs.length > 0) {
        const d = tmpDirs.pop()!;
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    function makeTmp(prefix: string): string {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tmpDirs.push(tmp);
      return tmp;
    }

    it('L3b: regex catches holdout-named top-level field not in HOLDOUT_DERIVED_FIELDS', () => {
      const roguePath = path.join(makeTmp('phase-0a4-l3b-'), 'leaderboard.json');
      fs.writeFileSync(roguePath, JSON.stringify([{
        strategyName: 'rogue', oosSharpe: 1, isValidForSearch: true,
        holdoutSortinoRatio: 0.77,
      }]));
      expect((HOLDOUT_DERIVED_FIELDS as readonly string[]).includes('holdoutSortinoRatio')).toBe(false);
      const leaks = scanFileForLeaks(roguePath);
      expect(leaks.length).toBe(1);
      expect(leaks[0].keyPath).toBe('holdoutSortinoRatio');
    });

    it('L3b: isValid at top level is caught even without "holdout" substring', () => {
      const roguePath = path.join(makeTmp('phase-0a4-l3b-isvalid-'), 'leaderboard.json');
      fs.writeFileSync(roguePath, JSON.stringify([{ strategyName: 'x', isValid: true }]));
      const leaks = scanFileForLeaks(roguePath);
      expect(leaks.length).toBe(1);
      expect(leaks[0].keyPath).toBe('isValid');
    });

    it('L3c: nested banned key inside an object is caught by recursive scan', () => {
      // Codex F1 fixture: `diagnostics.holdoutSharpe` — a future nested
      // leak mode that a top-level-only scanner would have missed.
      const roguePath = path.join(makeTmp('phase-0a4-l3c-nested-'), 'leaderboard.json');
      fs.writeFileSync(roguePath, JSON.stringify([{
        strategyName: 'x', oosSharpe: 1, isValidForSearch: true,
        diagnostics: { holdoutSharpe: 0.99 },
      }]));
      const leaks = scanFileForLeaks(roguePath);
      expect(leaks.map(l => l.keyPath)).toContain('diagnostics.holdoutSharpe');
    });

    it('L3c: nested banned key inside an array-of-objects is caught', () => {
      const roguePath = path.join(makeTmp('phase-0a4-l3c-array-'), 'leaderboard.json');
      fs.writeFileSync(roguePath, JSON.stringify([{
        strategyName: 'x', oosSharpe: 1, isValidForSearch: true,
        adoptionGatesOverrides: [{ envVar: 'A', target: 'b', value: 1, isValid: true }],
      }]));
      const leaks = scanFileForLeaks(roguePath);
      expect(leaks.map(l => l.keyPath)).toContain('adoptionGatesOverrides[0].isValid');
    });

    it('L3d: allowlist catches unknown top-level field with innocuous name', () => {
      // Codex F2 fixture: a field that is holdout-derived but does not
      // advertise itself in the name. The banlist regex would miss it; the
      // allowlist must not.
      const roguePath = path.join(makeTmp('phase-0a4-l3d-unknown-'), 'leaderboard.json');
      fs.writeFileSync(roguePath, JSON.stringify([{
        strategyName: 'x', oosSharpe: 1, isValidForSearch: true,
        promotionEligible: true,
      }]));
      const unknown = scanFileForUnknownFields(roguePath);
      expect(unknown.length).toBe(1);
      expect(unknown[0].key).toBe('promotionEligible');
      expect((AGENT_VISIBLE_FIELDS as readonly string[]).includes('promotionEligible')).toBe(false);
    });

    it('L3e: stripHoldoutMetrics recursively removes nested banned keys', () => {
      const input = {
        strategyName: 'x',
        oosSharpe: 1.0,
        isValidForSearch: true,
        diagnostics: { holdoutSharpe: 0.99, innerSafe: 1 },
        nested: [{ holdoutTrades: 7, kept: 'yes' }, { isValid: true }],
      } as unknown;
      const stripped = stripHoldoutMetrics(input as never) as Record<string, unknown>;
      const diag = stripped.diagnostics as Record<string, unknown>;
      expect(diag).not.toHaveProperty('holdoutSharpe');
      expect(diag).toHaveProperty('innerSafe');
      const nested = stripped.nested as Record<string, unknown>[];
      expect(nested[0]).not.toHaveProperty('holdoutTrades');
      expect(nested[0]).toHaveProperty('kept');
      expect(nested[1]).not.toHaveProperty('isValid');
      // No banned keys survive anywhere.
      expect(collectBannedKeyPaths(stripped)).toEqual([]);
    });
  });

  // ── L4 ───────────────────────────────────────────────────
  it('L4: audit leaderboards do contain banned keys (agent/full paths not swapped)', () => {
    const files = listAuditLeaderboards(AUDIT_DIR);
    if (files.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[holdout-leakage L4] no leaderboard-full*.json found in ${AUDIT_DIR}; inverse scan skipped`);
      return;
    }
    const suspects: string[] = [];
    for (const f of files) {
      const rows = JSON.parse(fs.readFileSync(f, 'utf-8')) as unknown;
      if (!Array.isArray(rows) || rows.length === 0) continue;
      if (scanFileForLeaks(f).length === 0) suspects.push(path.relative(REPO_ROOT, f));
    }
    if (suspects.length > 0) {
      throw new Error(
        `Audit leaderboards must contain holdout fields. ` +
        `The following non-empty files have NONE, suggesting saveLeaderboard swapped ` +
        `the agent and audit write paths:\n  ${suspects.join('\n  ')}`,
      );
    }
  });
});
