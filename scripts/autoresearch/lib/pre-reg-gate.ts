import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'child_process';

export interface PreRegBlock {
  hypothesis: string;
  configGrid: string;
  decisionRule: string;
  adoptionThreshold: string;
  holdoutWindowHash: string;
  declaredEnvOverrides: string[];
  rawBlock: string;
  blockHash: string;
}

export interface PreRegResult {
  ok: true;
  block: PreRegBlock;
  currentMdPath: string;
  gitClean: boolean;
  gitSha: string | null;
  bypassed: false;
}

export interface PreRegBypass {
  ok: true;
  block: null;
  currentMdPath: string;
  gitClean: null;
  gitSha: null;
  bypassed: true;
  bypassReason: string;
}

export type PreRegOutcome = PreRegResult | PreRegBypass;

export interface PreRegFailure {
  ok: false;
  reason: string;
  hint: string;
}

// Use fileURLToPath — `new URL(...).pathname` keeps URL escapes so paths
// containing spaces or other reserved characters become broken filesystem
// paths. Codex round-5 Finding 1, 2026-04-18.
function resolveRepoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '../../..');
}

const REQUIRED_SECTIONS = [
  'Hypothesis',
  'Config Grid',
  'Decision Rule',
  'Adoption Threshold',
  'Holdout Window Hash',
] as const;

function extractSection(block: string, heading: string): string | null {
  const headingPattern = new RegExp(`(^|\\n)\\s*(?:[-*]\\s*)?\\*\\*${heading}\\*\\*:?\\s*`, 'i');
  const m = block.match(headingPattern);
  if (!m) return null;
  const rest = block.slice((m.index ?? 0) + m[0].length);
  const next = rest.match(/\n\s*(?:[-*]\s*)?\*\*[A-Z][^*\n]{1,60}\*\*:?\s*/);
  const raw = next ? rest.slice(0, next.index) : rest;
  return raw.trim();
}

function extractPreRegBlock(md: string): string | null {
  const m = md.match(/##+\s*Pre-?Registration\b[\s\S]*?(?=\n##+\s+|\n---\s*\n|$)/i);
  return m ? m[0] : null;
}

export type ParsedEnvOverrides =
  | { kind: 'ok'; overrides: string[] }
  | { kind: 'error'; reason: string };

// Parse the "Declared Env Overrides" section as a strict grammar.
// Fix history:
//   - Original impl stripped underscores → mangled env-var names (first review, Finding 2). Fixed.
//   - Permissive regex /[A-Z][A-Z0-9_]{5,}/g scanned free-form prose and accepted
//     any uppercase-looking token anywhere in the section, so "none unless
//     using AUTORESEARCH_MIN_OOS_TRADES=60" falsely counted as a declaration
//     (re-review, Finding 3). Now fixed.
// New grammar:
//   section := "none" | tokenList
//   tokenList := token (SEP token)*
//   SEP := [,\n]
//   token := ^[A-Z][A-Z0-9_]{5,}$ after trimming whitespace + markdown decoration
// Anything else → error.
export function parseDeclaredEnvOverrides(block: string): ParsedEnvOverrides {
  const section = extractSection(block, 'Declared Env Overrides');
  if (!section) return { kind: 'ok', overrides: [] };
  // Strip top-level markdown decoration only (backticks/asterisks).
  const cleaned = section.replace(/[`*]/g, '').trim();
  if (cleaned === '') return { kind: 'ok', overrides: [] };
  if (/^none$/i.test(cleaned)) return { kind: 'ok', overrides: [] };

  const rawTokens = cleaned.split(/[,\n]/).map(t => t.trim()).filter(t => t !== '');
  if (rawTokens.length === 0) return { kind: 'ok', overrides: [] };

  const overrides: string[] = [];
  for (const t of rawTokens) {
    if (!/^[A-Z][A-Z0-9_]{5,}$/.test(t)) {
      return {
        kind: 'error',
        reason: `"Declared Env Overrides" contains invalid token ${JSON.stringify(t)}. Expected either the literal "none" or a comma-separated list of env-var names (uppercase letters/digits/underscores, ≥ 6 chars).`,
      };
    }
    overrides.push(t);
  }
  // Deduplicate but preserve order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const o of overrides) {
    if (!seen.has(o)) { seen.add(o); unique.push(o); }
  }
  return { kind: 'ok', overrides: unique };
}

// Accept an optional "sha256:" prefix (case-insensitive) followed by exactly
// 64 hex characters. Strips surrounding whitespace, backticks, asterisks,
// and code-fence noise before matching. Returns the canonical lower-case
// `sha256:<64hex>` form on success, or null on failure.
// Fix for Codex adversarial-review Finding 3 (2026-04-18).
export function normalizeHoldoutWindowHash(raw: string): string | null {
  const cleaned = raw.replace(/[`*\s]/g, '').toLowerCase();
  const m = cleaned.match(/^(?:sha256:)?([a-f0-9]{64})$/);
  return m ? `sha256:${m[1]}` : null;
}

export function validatePreRegOrBypass(opts: {
  repoRoot?: string;
  requireGitClean?: boolean;
  envOverridesRequired?: string[];
}): PreRegOutcome | PreRegFailure {
  const root = opts.repoRoot ?? resolveRepoRoot();
  const currentMdPath = path.resolve(root, '.handoff/current.md');

  const rawBypass = process.env.AUTORESEARCH_PREREG_BYPASS;
  if (rawBypass != null && rawBypass !== '') {
    // Codex review iterations:
    //   v1: required rawLength >= 12. Whitespace-only slipped through.
    //   v2: required trimmedLength >= 12 AND (!/[\s\p{P}]/) >= 6.
    //       Invisible Unicode format/control chars (U+200F RTL mark,
    //       U+200B zero-width space, etc.) are neither \s nor \p{P},
    //       so 12 RTL marks still slipped through.
    //   v3: count only visible letters + digits (\p{L} | \p{N}). But some
    //       characters classified as \p{L} are visually blank — notably
    //       Hangul fillers U+3164, U+115F, U+1160 (all in the Unicode
    //       Default_Ignorable_Code_Point set). 12 of those still slipped
    //       through v3 (Codex round-4 Finding 3).
    //   v4 (now): normalize via NFC, then strip Default_Ignorable_Code_Point,
    //       THEN count \p{L}|\p{N}. Only actually-renderable characters
    //       contribute to the "visible chars" budget.
    const trimmedBypass = rawBypass.trim();
    const visibleForm = trimmedBypass
      .normalize('NFC')
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '');
    const meaningfulChars = (visibleForm.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (trimmedBypass.length < 12 || meaningfulChars < 6) {
      return {
        ok: false,
        reason: `AUTORESEARCH_PREREG_BYPASS is set but the reason is too short or lacks substantive content (need ≥ 12 chars after trim and ≥ 6 visible letters/digits; invisible-code-point characters don't count).`,
        hint: `Example:\n  AUTORESEARCH_PREREG_BYPASS="smoke test post-rebuild, tracked in docs/rebuild-2026-04/" npx tsx scripts/autoresearch/runner.ts`,
      };
    }
    return {
      ok: true,
      block: null,
      currentMdPath,
      gitClean: null,
      gitSha: null,
      bypassed: true,
      bypassReason: trimmedBypass,
    };
  }

  if (!fs.existsSync(currentMdPath)) {
    return {
      ok: false,
      reason: `.handoff/current.md does not exist. Create it with a Pre-Registration block before running the autoresearch runner.`,
      hint: `See .handoff/TEAM.md for the Pre-Registration convention.`,
    };
  }

  const md = fs.readFileSync(currentMdPath, 'utf-8');
  const block = extractPreRegBlock(md);
  if (!block) {
    return {
      ok: false,
      reason: `.handoff/current.md has no "## Pre-Registration" (or "## Pre-Reg") section. Every autoresearch run requires a pre-registration block.`,
      hint: `Copy the template from .handoff/TEAM.md and fill in hypothesis, config grid, decision rule, adoption threshold, and holdout window hash.`,
    };
  }

  const sectionValues: Record<string, string> = {};
  for (const heading of REQUIRED_SECTIONS) {
    const v = extractSection(block, heading);
    if (v == null || v.length === 0) {
      return {
        ok: false,
        reason: `.handoff/current.md Pre-Registration block is missing "${heading}".`,
        hint: `Required sections: ${REQUIRED_SECTIONS.map(s => `**${s}**`).join(', ')}.`,
      };
    }
    sectionValues[heading] = v;
  }

  // Format-check the Holdout Window Hash (Codex Finding 3). Semantic binding
  // to a committed dataset manifest was established in Phase 0.b.6 and is
  // enforced by the runner (see scripts/autoresearch/lib/dataset-manifest.ts
  // and runner.ts). This step is just the first gate (format only).
  const rawHoldoutHash = sectionValues['Holdout Window Hash'];
  const normalizedHoldoutHash = normalizeHoldoutWindowHash(rawHoldoutHash);
  if (!normalizedHoldoutHash) {
    return {
      ok: false,
      reason: `.handoff/current.md Pre-Registration "Holdout Window Hash" is not a valid SHA-256 (got ${JSON.stringify(rawHoldoutHash.slice(0, 80))}).`,
      hint: `The value must match 64 lower-case hex characters (optionally prefixed with "sha256:"). Run the hash builder (Phase 0.b.6) or use "sha256:0000...0000" for placeholder smokes.`,
    };
  }
  sectionValues['Holdout Window Hash'] = normalizedHoldoutHash;

  const parsedOverrides = parseDeclaredEnvOverrides(block);
  if (parsedOverrides.kind === 'error') {
    return {
      ok: false,
      reason: parsedOverrides.reason,
      hint: `Declared Env Overrides must be exactly "none" or a comma-separated list of env-var names — no prose, examples, or shell commands inside that section.`,
    };
  }
  const declaredEnvOverrides = parsedOverrides.overrides;
  const need = opts.envOverridesRequired ?? [];
  const missing = need.filter(e => !declaredEnvOverrides.includes(e));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Environment gate overrides ${missing.join(', ')} are set but not declared in the Pre-Registration block.`,
      hint: `Add a "**Declared Env Overrides**: ${need.join(', ')}" line to the pre-reg, or unset those env vars before running.`,
    };
  }

  let gitClean = true;
  let gitSha: string | null = null;
  if (opts.requireGitClean !== false) {
    try {
      const stat = execSync(`git status --porcelain -- .handoff/current.md`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      gitClean = stat.length === 0;
      if (!gitClean) {
        return {
          ok: false,
          reason: `.handoff/current.md has uncommitted changes (${stat.split('\n')[0]}). Pre-registration must be committed before the run.`,
          hint: `git add .handoff/current.md && git commit -m "pre-reg: <campaign name>"`,
        };
      }
      gitSha = execSync(`git log -n 1 --format=%H -- .handoff/current.md`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() || null;
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to verify git-clean status on .handoff/current.md: ${(err as Error).message}`,
        hint: `Make sure the repo is a git checkout and git is on PATH.`,
      };
    }
  }

  const blockHash = crypto.createHash('sha256').update(block).digest('hex');

  return {
    ok: true,
    bypassed: false,
    currentMdPath,
    gitClean,
    gitSha,
    block: {
      hypothesis: sectionValues['Hypothesis'],
      configGrid: sectionValues['Config Grid'],
      decisionRule: sectionValues['Decision Rule'],
      adoptionThreshold: sectionValues['Adoption Threshold'],
      holdoutWindowHash: sectionValues['Holdout Window Hash'],
      declaredEnvOverrides,
      rawBlock: block,
      blockHash,
    },
  };
}

export function formatPreRegSummary(outcome: PreRegOutcome): string {
  if (outcome.bypassed) {
    return `Pre-Registration BYPASSED via AUTORESEARCH_PREREG_BYPASS='${outcome.bypassReason}' (logged, counts as a declared trial).`;
  }
  const b = outcome.block;
  const lines = [
    `Pre-Registration accepted (sha256 ${b.blockHash.slice(0, 12)}..., git ${outcome.gitSha?.slice(0, 10) ?? 'n/a'}):`,
    `  hypothesis: ${b.hypothesis.replace(/\s+/g, ' ').slice(0, 160)}`,
    `  decision rule: ${b.decisionRule.replace(/\s+/g, ' ').slice(0, 160)}`,
    `  adoption threshold: ${b.adoptionThreshold.replace(/\s+/g, ' ').slice(0, 160)}`,
    `  holdout window hash: ${b.holdoutWindowHash.replace(/\s+/g, ' ').slice(0, 160)}`,
  ];
  if (b.declaredEnvOverrides.length > 0) {
    lines.push(`  declared env overrides: ${b.declaredEnvOverrides.join(', ')}`);
  }
  return lines.join('\n');
}
