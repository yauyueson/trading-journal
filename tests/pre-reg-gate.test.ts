/**
 * Regression tests for scripts/autoresearch/lib/pre-reg-gate.ts.
 *
 * Covers all three Codex adversarial-review findings (2026-04-18):
 *   Finding 1 — AUTORESEARCH_PREREG_SKIP_GIT backdoor removed at the caller
 *               (runner.ts). No behavior to test here; a grep check is part
 *               of the rebuild verification checklist.
 *   Finding 2 — parseDeclaredEnvOverrides no longer mangles underscores.
 *   Finding 3 — Holdout Window Hash is format-validated (sha256, 64 hex).
 *
 * Uses an isolated tmp directory as `repoRoot` so tests never touch the real
 * .handoff/current.md. requireGitClean: false is used in tests that don't
 * explicitly exercise the git-clean branch — that's the whole reason the
 * parameter was kept on the helper (production code can't set it to false,
 * see runner.ts).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  validatePreRegOrBypass,
  normalizeHoldoutWindowHash,
  parseDeclaredEnvOverrides,
} from '../scripts/autoresearch/lib/pre-reg-gate';

const VALID_HASH = 'sha256:' + 'a'.repeat(64);
const VALID_HASH_NO_PREFIX = 'b'.repeat(64);
const PLACEHOLDER_HASH = 'sha256:' + '0'.repeat(64);

function buildPreReg(opts: {
  holdoutHash?: string;
  declaredEnvOverrides?: string;
  omitSection?: string;
} = {}): string {
  const lines: string[] = [
    '---',
    'task: test pre-reg block',
    'stage: building',
    'owner: claude',
    'from: human',
    'timestamp: 2026-04-18T00:00:00-04:00',
    '---',
    '',
    '## Objective',
    'Test the pre-reg gate.',
    '',
    '## Pre-Registration',
    '',
  ];
  const sections: Record<string, string> = {
    'Hypothesis': 'Candidate LEAP strategy outperforms incumbent on the 2024-2026 holdout.',
    'Config Grid': 'delta {0.65, 0.70}, DTE {180, 270}.',
    'Decision Rule': 'Adopt the single variant with highest N_eff DSR.',
    'Adoption Threshold': 'holdout Sharpe >= 0.5.',
    'Holdout Window Hash': opts.holdoutHash ?? VALID_HASH,
  };
  for (const [h, v] of Object.entries(sections)) {
    if (opts.omitSection === h) continue;
    lines.push(`**${h}**: ${v}`);
  }
  if (opts.declaredEnvOverrides !== undefined) {
    lines.push(`**Declared Env Overrides**: ${opts.declaredEnvOverrides}`);
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('-');
  return lines.join('\n');
}

describe('normalizeHoldoutWindowHash', () => {
  it('accepts a valid sha256: prefixed 64-char lowercase hash', () => {
    expect(normalizeHoldoutWindowHash(VALID_HASH)).toBe(VALID_HASH);
  });

  it('accepts a valid 64-char hash without the sha256: prefix and canonicalizes', () => {
    expect(normalizeHoldoutWindowHash(VALID_HASH_NO_PREFIX)).toBe(`sha256:${VALID_HASH_NO_PREFIX}`);
  });

  it('accepts the all-zeros placeholder', () => {
    expect(normalizeHoldoutWindowHash(PLACEHOLDER_HASH)).toBe(PLACEHOLDER_HASH);
  });

  it('strips backticks, whitespace, and asterisks before matching', () => {
    const decorated = `  \`**${VALID_HASH}**\`  `;
    expect(normalizeHoldoutWindowHash(decorated)).toBe(VALID_HASH);
  });

  it('lowercases uppercase hex so match is case-insensitive', () => {
    const upper = 'SHA256:' + 'A'.repeat(64);
    expect(normalizeHoldoutWindowHash(upper)).toBe('sha256:' + 'a'.repeat(64));
  });

  it('rejects short placeholders like "tbd"', () => {
    expect(normalizeHoldoutWindowHash('tbd')).toBeNull();
  });

  it('rejects non-hex characters', () => {
    expect(normalizeHoldoutWindowHash('sha256:notreal' + 'z'.repeat(58))).toBeNull();
  });

  it('rejects a 32-char (too-short) hash', () => {
    expect(normalizeHoldoutWindowHash('sha256:' + 'a'.repeat(32))).toBeNull();
  });

  it('rejects a 65-char (too-long) hash', () => {
    expect(normalizeHoldoutWindowHash('sha256:' + 'a'.repeat(65))).toBeNull();
  });

  it('rejects the empty string', () => {
    expect(normalizeHoldoutWindowHash('')).toBeNull();
  });
});

describe('validatePreRegOrBypass — bypass path', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prereg-test-'));
    fs.mkdirSync(path.join(tmpRoot, '.handoff'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AUTORESEARCH_PREREG_BYPASS;
  });

  it('rejects a bypass reason shorter than 12 characters', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = 'short';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/too short|substantive/i);
    }
  });

  it('accepts a bypass reason of exactly 12 characters with real content', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = 'twelveCharss';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(true);
    if (r.ok === true) {
      expect(r.bypassed).toBe(true);
      if (r.bypassed === true) {
        expect(r.bypassReason).toBe('twelveCharss');
      }
    }
  });

  // Codex re-review Finding 1 regression: whitespace-only reasons must be rejected.
  it('rejects a bypass reason of 12 whitespace characters', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '            ';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/substantive|too short/i);
    }
  });

  it('rejects a bypass reason of 20 spaces around short content', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '     xy     ';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
  });

  it('rejects a bypass reason that is only punctuation', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '............';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
  });

  it('rejects a bypass reason of tabs and newlines', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '\t\t\t\t\t\t\n\n\n\n\n\n';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
  });

  // Codex round-3 Finding 1: invisible Unicode format chars slipped through
  // the v2 `\s\p{P}` filter because RLM/ZWSP are neither whitespace nor punctuation.
  it('rejects a bypass reason of 12 RTL marks (U+200F)', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '\u200f'.repeat(12);
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/visible|substantive|too short/i);
    }
  });

  it('rejects a bypass reason of 12 zero-width spaces (U+200B)', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '\u200b'.repeat(12);
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
  });

  it('rejects a bypass reason of BOM + control characters', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '\ufeff\u0007\u0008\u0009\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
  });

  it('rejects a bypass reason with only 4 letters mixed with invisible chars', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '\u200fabcd\u200f\u200f\u200f\u200f\u200f\u200f';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
  });

  it('accepts a bypass reason with mixed Unicode + ASCII that has ≥ 6 letters', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = 'smoke test for Phase 0.a';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(true);
  });

  // Codex round-4 Finding 3: Hangul fillers and other Default_Ignorable
  // letters (U+3164, U+115F, U+1160) are \p{L} but visually blank. The
  // v3 \p{L}\p{N} check alone would accept them.
  it('rejects 12 Hangul Filler characters (U+3164, \\p{L} but visually blank)', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '\u3164'.repeat(12);
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/visible|invisible-code-point|substantive/i);
    }
  });

  it('rejects 12 HANGUL CHOSEONG FILLER characters (U+115F)', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '\u115f'.repeat(12);
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
  });

  it('rejects mixed Hangul filler + RTL mark (all Default_Ignorable)', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '\u3164\u200f\u115f\u200b\u1160\u3164\u200f\u115f\u200b\u1160\u3164\u200f';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
  });

  it('accepts a realistic bypass reason and never reads .handoff/current.md', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = 'Phase 0.a.1 integration smoke test';
    // Note: no .handoff/current.md created — bypass path must not require it.
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(true);
    if (r.ok === true) {
      expect(r.bypassed).toBe(true);
      if (r.bypassed === true) {
        // Reason is trimmed before being persisted.
        expect(r.bypassReason).toBe('Phase 0.a.1 integration smoke test');
      }
    }
  });

  it('trims surrounding whitespace from the persisted bypass reason', () => {
    process.env.AUTORESEARCH_PREREG_BYPASS = '  a reasonable twelve-plus char reason  ';
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(true);
    if (r.ok === true && r.bypassed === true) {
      expect(r.bypassReason).toBe('a reasonable twelve-plus char reason');
    }
  });
});

describe('validatePreRegOrBypass — normal path', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prereg-test-'));
    fs.mkdirSync(path.join(tmpRoot, '.handoff'), { recursive: true });
    delete process.env.AUTORESEARCH_PREREG_BYPASS;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeCurrent(content: string): void {
    fs.writeFileSync(path.join(tmpRoot, '.handoff', 'current.md'), content, 'utf-8');
  }

  it('rejects when .handoff/current.md does not exist', () => {
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/does not exist/i);
    }
  });

  it('rejects when the Pre-Registration section is missing', () => {
    writeCurrent('# Some other markdown\n\nNo pre-reg here.\n');
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/no "## Pre-Registration"/i);
    }
  });

  it('rejects when a required sub-section is missing', () => {
    writeCurrent(buildPreReg({ omitSection: 'Hypothesis' }));
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/missing "Hypothesis"/);
    }
  });

  it('accepts a valid pre-reg with a proper sha256 holdout hash', () => {
    writeCurrent(buildPreReg({ holdoutHash: VALID_HASH }));
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(true);
    if (r.ok === true && r.bypassed === false) {
      expect(r.block.holdoutWindowHash).toBe(VALID_HASH);
    }
  });

  it('accepts the all-zeros placeholder hash (smoke-test escape)', () => {
    writeCurrent(buildPreReg({ holdoutHash: PLACEHOLDER_HASH }));
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(true);
  });

  it('rejects a "tbd" placeholder in Holdout Window Hash — Finding 3 regression', () => {
    writeCurrent(buildPreReg({ holdoutHash: 'tbd' }));
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/Holdout Window Hash.*not a valid SHA-256/i);
    }
  });

  it('rejects a shortened (32-char) hash — Finding 3 regression', () => {
    writeCurrent(buildPreReg({ holdoutHash: 'sha256:' + 'a'.repeat(32) }));
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/Holdout Window Hash.*not a valid SHA-256/i);
    }
  });

  it('rejects a hash with non-hex characters — Finding 3 regression', () => {
    writeCurrent(buildPreReg({ holdoutHash: 'sha256:notreal' + 'z'.repeat(58) }));
    const r = validatePreRegOrBypass({ repoRoot: tmpRoot, requireGitClean: false });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/Holdout Window Hash.*not a valid SHA-256/i);
    }
  });
});

describe('validatePreRegOrBypass — env-override declaration (Finding 2 regression)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prereg-test-'));
    fs.mkdirSync(path.join(tmpRoot, '.handoff'), { recursive: true });
    delete process.env.AUTORESEARCH_PREREG_BYPASS;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeCurrent(content: string): void {
    fs.writeFileSync(path.join(tmpRoot, '.handoff', 'current.md'), content, 'utf-8');
  }

  it('accepts the documented AUTORESEARCH_MIN_OOS_TRADES declaration without mangling', () => {
    writeCurrent(buildPreReg({ declaredEnvOverrides: 'AUTORESEARCH_MIN_OOS_TRADES' }));
    const r = validatePreRegOrBypass({
      repoRoot: tmpRoot,
      requireGitClean: false,
      envOverridesRequired: ['AUTORESEARCH_MIN_OOS_TRADES'],
    });
    expect(r.ok).toBe(true);
    if (r.ok === true && r.bypassed === false) {
      expect(r.block.declaredEnvOverrides).toContain('AUTORESEARCH_MIN_OOS_TRADES');
    }
  });

  it('rejects when env override is required but not declared', () => {
    writeCurrent(buildPreReg({ declaredEnvOverrides: 'none' }));
    const r = validatePreRegOrBypass({
      repoRoot: tmpRoot,
      requireGitClean: false,
      envOverridesRequired: ['AUTORESEARCH_MIN_OOS_TRADES'],
    });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/AUTORESEARCH_MIN_OOS_TRADES.*not declared/i);
    }
  });

  it('accepts the declaration wrapped in backticks and asterisks', () => {
    writeCurrent(buildPreReg({ declaredEnvOverrides: '`AUTORESEARCH_MIN_OOS_TRADES`' }));
    const r = validatePreRegOrBypass({
      repoRoot: tmpRoot,
      requireGitClean: false,
      envOverridesRequired: ['AUTORESEARCH_MIN_OOS_TRADES'],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts multiple comma-separated overrides', () => {
    writeCurrent(
      buildPreReg({ declaredEnvOverrides: 'AUTORESEARCH_MIN_OOS_TRADES, AUTORESEARCH_LEADERBOARD_SUFFIX' }),
    );
    const r = validatePreRegOrBypass({
      repoRoot: tmpRoot,
      requireGitClean: false,
      envOverridesRequired: ['AUTORESEARCH_MIN_OOS_TRADES', 'AUTORESEARCH_LEADERBOARD_SUFFIX'],
    });
    expect(r.ok).toBe(true);
    if (r.ok === true && r.bypassed === false) {
      expect(r.block.declaredEnvOverrides).toContain('AUTORESEARCH_MIN_OOS_TRADES');
      expect(r.block.declaredEnvOverrides).toContain('AUTORESEARCH_LEADERBOARD_SUFFIX');
    }
  });

  // Codex re-review Finding 3: the permissive regex accepted env-var-looking
  // tokens buried in prose; now the parser is strict grammar.
  it('rejects prose like "none unless using AUTORESEARCH_MIN_OOS_TRADES=60"', () => {
    writeCurrent(buildPreReg({ declaredEnvOverrides: 'none unless using AUTORESEARCH_MIN_OOS_TRADES=60' }));
    const r = validatePreRegOrBypass({
      repoRoot: tmpRoot,
      requireGitClean: false,
      envOverridesRequired: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/invalid token/i);
    }
  });

  it('rejects a command example with an env var assignment', () => {
    writeCurrent(buildPreReg({ declaredEnvOverrides: '`AUTORESEARCH_MIN_OOS_TRADES=60 npx tsx runner.ts`' }));
    const r = validatePreRegOrBypass({
      repoRoot: tmpRoot,
      requireGitClean: false,
      envOverridesRequired: ['AUTORESEARCH_MIN_OOS_TRADES'],
    });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/invalid token/i);
    }
  });

  it('rejects contradictory prose mixing "none" with env var names', () => {
    writeCurrent(buildPreReg({ declaredEnvOverrides: 'AUTORESEARCH_MIN_OOS_TRADES but actually none' }));
    const r = validatePreRegOrBypass({
      repoRoot: tmpRoot,
      requireGitClean: false,
      envOverridesRequired: ['AUTORESEARCH_MIN_OOS_TRADES'],
    });
    expect(r.ok).toBe(false);
  });

  it('does not treat short uppercase tokens like "SPY" as env-var declarations (strict parser rejects)', () => {
    writeCurrent(buildPreReg({ declaredEnvOverrides: 'We benchmark against SPY and QQQ' }));
    const r = validatePreRegOrBypass({
      repoRoot: tmpRoot,
      requireGitClean: false,
      envOverridesRequired: [],
    });
    // Strict parser rejects free-form prose entirely — no silent acceptance of "SPY" OR "QQQ".
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/invalid token/i);
    }
  });
});

describe('parseDeclaredEnvOverrides — strict-grammar regressions (Finding 3)', () => {
  function pr(content: string): string {
    return `## Pre-Registration\n\n**Declared Env Overrides**: ${content}\n`;
  }

  it('treats an empty section as zero declarations', () => {
    const r = parseDeclaredEnvOverrides(pr(''));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.overrides).toEqual([]);
  });

  it('accepts "none" case-insensitively', () => {
    expect(parseDeclaredEnvOverrides(pr('none'))).toEqual({ kind: 'ok', overrides: [] });
    expect(parseDeclaredEnvOverrides(pr('None'))).toEqual({ kind: 'ok', overrides: [] });
    expect(parseDeclaredEnvOverrides(pr('NONE'))).toEqual({ kind: 'ok', overrides: [] });
  });

  it('accepts a single env-var token', () => {
    const r = parseDeclaredEnvOverrides(pr('AUTORESEARCH_MIN_OOS_TRADES'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.overrides).toEqual(['AUTORESEARCH_MIN_OOS_TRADES']);
  });

  it('accepts multiple comma-separated tokens', () => {
    const r = parseDeclaredEnvOverrides(pr('AUTORESEARCH_MIN_OOS_TRADES, AUTORESEARCH_LEADERBOARD_SUFFIX'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.overrides).toEqual(['AUTORESEARCH_MIN_OOS_TRADES', 'AUTORESEARCH_LEADERBOARD_SUFFIX']);
  });

  it('accepts newline-separated tokens', () => {
    const r = parseDeclaredEnvOverrides(pr('AUTORESEARCH_MIN_OOS_TRADES\nAUTORESEARCH_LEADERBOARD_SUFFIX'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.overrides.sort()).toEqual(['AUTORESEARCH_LEADERBOARD_SUFFIX', 'AUTORESEARCH_MIN_OOS_TRADES']);
  });

  it('accepts tokens wrapped in backticks', () => {
    const r = parseDeclaredEnvOverrides(pr('`AUTORESEARCH_MIN_OOS_TRADES`'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.overrides).toEqual(['AUTORESEARCH_MIN_OOS_TRADES']);
  });

  it('accepts tokens with asterisk bold markers', () => {
    const r = parseDeclaredEnvOverrides(pr('**AUTORESEARCH_MIN_OOS_TRADES**'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.overrides).toEqual(['AUTORESEARCH_MIN_OOS_TRADES']);
  });

  it('rejects prose mixed with a token', () => {
    const r = parseDeclaredEnvOverrides(pr('use AUTORESEARCH_MIN_OOS_TRADES for diagnostics'));
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.reason).toMatch(/invalid token/i);
  });

  it('rejects a shell-style assignment', () => {
    const r = parseDeclaredEnvOverrides(pr('AUTORESEARCH_MIN_OOS_TRADES=60'));
    expect(r.kind).toBe('error');
  });

  it('rejects a lowercase token', () => {
    const r = parseDeclaredEnvOverrides(pr('autoresearch_min_oos_trades'));
    expect(r.kind).toBe('error');
  });

  it('rejects short uppercase tokens (<6 chars)', () => {
    const r = parseDeclaredEnvOverrides(pr('SPY, QQQ'));
    expect(r.kind).toBe('error');
  });

  it('deduplicates repeated tokens', () => {
    const r = parseDeclaredEnvOverrides(pr('AUTORESEARCH_MIN_OOS_TRADES, AUTORESEARCH_MIN_OOS_TRADES'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.overrides).toEqual(['AUTORESEARCH_MIN_OOS_TRADES']);
  });
});
