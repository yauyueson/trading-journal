import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'child_process';

export interface AdoptionGates {
  minOosTrades: number;
  maxOosDrawdownPct: number;
  minSaneOosDrawdownPct: number;    // Phase 1.c: lower-bound sanity. OOS MaxDD below this is a simulator-bug fingerprint (TRAILING_LOCK class).
  maxSanePerTradeEdge: number;      // Phase 1.d: cap on mean(grossPnl / maxProfit) for credit spreads. Mean near 1.0 = bug (TRAILING_LOCK-style fill-at-threshold).
  minHoldoutSharpe: number;
  maxSaneOosSharpe: number;
  minHoldoutMetric: number;
  minHoldoutIrFloor: number;
  minNewHoldoutTrades: number;
  bootstrapIterations: number;
  naiveBaselineIntervalDays: number;
  // Phase 1.b: holdout/OOS stability ratio bounds. Sharpe(holdout)/Sharpe(OOS)
  // outside [min, max] flags overfit-to-selection (ratio < min) or
  // data-snooping / pre-reg drift (ratio > max). Hashed here so adoption
  // policy changes trip `adoptionGatesRawHash`. Codex round-12 Finding 2
  // (2026-04-20): previously hardcoded 0.5/2.0 in runner.ts bypassed the
  // audit hash.
  minStabilityHoldoutOosRatio: number;
  maxStabilityHoldoutOosRatio: number;
  // Phase 2.h (2026-04-20) — max acceptable ratio between the two
  // Sharpe SE estimators (bootstrap vs Mertens), SYMMETRIC — triggered
  // when `max(bs/mertens, mertens/bs)` exceeds this.
  //
  // Phase 2.n (2026-04-20) promoted the flag to a HARD GATE wired into
  // `isValid`. Default raised from 2.5× → 5.0× so legitimately fat-
  // tailed strategies (where the parametric SE formula is biased by
  // high kurtosis) aren't auto-rejected. At 5.0× the gate only trips on
  // pathological disagreement — the Phase 2.d cross-validation confirms
  // the two estimators agree within 2× on IID and low-phi AR(1), so
  // anything past 5× is a genuine methodology warning worth acting on.
  //
  // Operators who want a soft warning INSTEAD of a hard gate can set
  // this to 10 (upper validation bound, effectively disables the gate)
  // and rely on the `passesStatConsistency` boolean + `statConsistency-
  // Ratio` number in the reviewer log for manual triage.
  maxStatConsistencyRatio: number;
}

export interface GateEnvOverrideSpec {
  overrides: keyof AdoptionGates;
  reason: string;
  mustBeDeclaredInPreReg: boolean;
}

export interface AdoptionGatesFile {
  version: number;
  description: string;
  lastModified: string;
  lastModifier: string;
  rationale: string;
  gates: AdoptionGates;
  environmentOverrides: Record<string, GateEnvOverrideSpec>;
}

export interface LoadedGates {
  file: AdoptionGatesFile;
  gates: AdoptionGates;
  rawHash: string;
  effectiveHash: string;
  envOverrides: Array<{ envVar: string; target: keyof AdoptionGates; rawValue: string; parsed: number }>;
  configPath: string;
}

const CONFIG_REL = 'config/adoption-gates.json';

// Use fileURLToPath — `new URL(...).pathname` keeps URL escapes so paths
// containing spaces or other reserved characters become broken filesystem
// paths. Codex round-5 Finding 1, 2026-04-18.
function resolveRepoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '../../..');
}

export function loadAdoptionGates(opts?: { repoRoot?: string }): LoadedGates {
  const root = opts?.repoRoot ?? resolveRepoRoot();
  const configPath = path.resolve(root, CONFIG_REL);
  if (!fs.existsSync(configPath)) {
    throw new Error(`adoption-gates: config file missing at ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as AdoptionGatesFile;

  if (parsed.version !== 1) {
    throw new Error(`adoption-gates: unsupported config version ${parsed.version} (expected 1)`);
  }
  const required: (keyof AdoptionGates)[] = [
    'minOosTrades', 'maxOosDrawdownPct', 'minSaneOosDrawdownPct',
    'maxSanePerTradeEdge',
    'minHoldoutSharpe', 'maxSaneOosSharpe',
    'minHoldoutMetric', 'minHoldoutIrFloor', 'minNewHoldoutTrades',
    'bootstrapIterations', 'naiveBaselineIntervalDays',
    'minStabilityHoldoutOosRatio', 'maxStabilityHoldoutOosRatio',
    'maxStatConsistencyRatio',
  ];
  for (const k of required) {
    if (typeof parsed.gates[k] !== 'number' || !Number.isFinite(parsed.gates[k])) {
      throw new Error(`adoption-gates: gates.${k} is missing or not a finite number`);
    }
  }

  const rawHash = crypto.createHash('sha256').update(raw).digest('hex');

  const gates: AdoptionGates = { ...parsed.gates };
  const envOverrides: LoadedGates['envOverrides'] = [];
  for (const [envVar, spec] of Object.entries(parsed.environmentOverrides ?? {})) {
    const rawValue = process.env[envVar];
    if (rawValue == null || rawValue === '') continue;
    const parsedNum = Number(rawValue);
    if (!Number.isFinite(parsedNum)) {
      throw new Error(`adoption-gates: env ${envVar}='${rawValue}' is not numeric`);
    }
    gates[spec.overrides] = parsedNum;
    envOverrides.push({ envVar, target: spec.overrides, rawValue, parsed: parsedNum });
  }

  // Domain/range validation AFTER env overrides are applied — catches both a
  // malformed committed config and a malformed declared env override. Codex
  // round-7 Finding 1 (2026-04-18): without this, values like
  // naiveBaselineIntervalDays <= 0 hang the baseline loop and
  // bootstrapIterations <= 0 corrupts the CI path.
  validateGateRanges(gates);

  const effectiveSource = JSON.stringify({ rawHash, envOverrides });
  const effectiveHash = crypto.createHash('sha256').update(effectiveSource).digest('hex');

  return { file: parsed, gates, rawHash, effectiveHash, envOverrides, configPath };
}

export function validateGateRanges(g: AdoptionGates): void {
  // Positive-integer constraints — enforced as "finite number that rounds
  // to itself AND is strictly positive" so a JSON like "100.0" is accepted.
  const positiveInts: Array<[keyof AdoptionGates, number]> = [
    ['minOosTrades', 1],
    ['bootstrapIterations', 100],
    ['naiveBaselineIntervalDays', 1],
  ];
  for (const [field, minimum] of positiveInts) {
    const v = g[field];
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < minimum) {
      throw new Error(
        `adoption-gates: gates.${field}=${v} must be an integer >= ${minimum}. ` +
        `Values like 0 or negatives would break the runner (infinite loops, invalid CI paths, or silently-relaxed policy).`,
      );
    }
  }
  // Non-negative integer (0 is a legitimate "no minimum" choice).
  if (!Number.isInteger(g.minNewHoldoutTrades) || g.minNewHoldoutTrades < 0) {
    throw new Error(`adoption-gates: gates.minNewHoldoutTrades=${g.minNewHoldoutTrades} must be an integer >= 0.`);
  }
  // Percentage in (0, 100].
  if (!(g.maxOosDrawdownPct > 0) || g.maxOosDrawdownPct > 100) {
    throw new Error(`adoption-gates: gates.maxOosDrawdownPct=${g.maxOosDrawdownPct} must be in (0, 100].`);
  }
  // Phase 1.c: minSaneOosDrawdownPct — lower bound on 8yr+ MaxDD.
  // A drawdown below ~2% over 8 years almost always means the simulator
  // is swallowing losses (TRAILING_LOCK fingerprint). Allow small values
  // for legitimately-low-vol use (e.g., 0.5% for short backtests) but
  // forbid zero/negative (always-a-bug indicator). Cap at the upper
  // bound so users can't accidentally invert the pair.
  if (!(g.minSaneOosDrawdownPct >= 0) || g.minSaneOosDrawdownPct >= g.maxOosDrawdownPct) {
    throw new Error(
      `adoption-gates: gates.minSaneOosDrawdownPct=${g.minSaneOosDrawdownPct} must be in ` +
      `[0, ${g.maxOosDrawdownPct}) (i.e. below the max-accept bound).`,
    );
  }
  // Phase 1.d: maxSanePerTradeEdge — cap on mean(grossPnl/maxProfit)
  // across credit-spread trades. A value near 1.0 means every trade
  // closed at essentially max profit — losers should drag the mean
  // well below that; its absence is the TRAILING_LOCK fingerprint.
  // Bounds: (0, 1.0]. ≤ 0 would reject any positive-mean strategy
  // (nonsense); > 1.0 is impossible since grossPnl is clamped at
  // maxProfit per contract.
  if (!(g.maxSanePerTradeEdge > 0) || g.maxSanePerTradeEdge > 1.0) {
    throw new Error(
      `adoption-gates: gates.maxSanePerTradeEdge=${g.maxSanePerTradeEdge} must be in (0, 1.0]. ` +
      `Values above 1.0 are physically impossible (grossPnl is clamped at maxProfit).`,
    );
  }
  // Positive real.
  if (!(g.maxSaneOosSharpe > 0)) {
    throw new Error(`adoption-gates: gates.maxSaneOosSharpe=${g.maxSaneOosSharpe} must be > 0. A zero/negative ceiling would reject all strategies.`);
  }
  // Non-negative real (holdout threshold — zero means "any positive Sharpe").
  if (!(g.minHoldoutMetric >= 0)) {
    throw new Error(`adoption-gates: gates.minHoldoutMetric=${g.minHoldoutMetric} must be >= 0. A negative threshold would silently relax the adoption bar.`);
  }
  // Phase 1.b stability bounds — hashed here so adoption policy changes
  // trip adoptionGatesRawHash. Min must be > 0 and strictly less than max
  // (else the gate either accepts nothing or can't invert). Max must be
  // finite and > min. Ratio of 1.0 is the "perfect stability" midpoint;
  // a sensible pair straddles it (e.g., 0.5 and 2.0).
  if (!(g.minStabilityHoldoutOosRatio > 0)) {
    throw new Error(
      `adoption-gates: gates.minStabilityHoldoutOosRatio=${g.minStabilityHoldoutOosRatio} must be > 0. ` +
      `A non-positive floor would accept wildly divergent holdout Sharpe as "stable."`,
    );
  }
  if (!Number.isFinite(g.maxStabilityHoldoutOosRatio) ||
      g.maxStabilityHoldoutOosRatio <= g.minStabilityHoldoutOosRatio) {
    throw new Error(
      `adoption-gates: gates.maxStabilityHoldoutOosRatio=${g.maxStabilityHoldoutOosRatio} must be ` +
      `a finite number strictly greater than minStabilityHoldoutOosRatio=${g.minStabilityHoldoutOosRatio}.`,
    );
  }
  // Phase 2.h stat-consistency ratio — must be > 1 (ratio of 1 means
  // strict equality required, which would flag almost every real run).
  // Upper-bounded at 10 to catch typos / accidental disabling.
  if (!(g.maxStatConsistencyRatio > 1) || g.maxStatConsistencyRatio > 10) {
    throw new Error(
      `adoption-gates: gates.maxStatConsistencyRatio=${g.maxStatConsistencyRatio} must be in (1, 10]. ` +
      `Below 1 would reject strategies where the two SE estimators agree exactly; above 10 disables the flag.`,
    );
  }
  // Unconstrained reals: minHoldoutSharpe and minHoldoutIrFloor are allowed
  // any finite value, since research scenarios can legitimately set them
  // to 0 or a small negative number. Finite-check already happened in loader.
}

export function recomputeRawHash(loaded: LoadedGates): string {
  const raw = fs.readFileSync(loaded.configPath, 'utf-8');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function assertGatesUnchanged(loaded: LoadedGates): void {
  const current = recomputeRawHash(loaded);
  if (current !== loaded.rawHash) {
    throw new Error(
      `adoption-gates: config file was modified mid-campaign. ` +
      `Original hash ${loaded.rawHash.slice(0, 12)}..., current ${current.slice(0, 12)}.... ` +
      `This is a hard error per Phase 0.a.2 of the foundation rebuild — do not restart without a committed PR to adoption-gates.json.`,
    );
  }
}

// Verify that config/adoption-gates.json is both tracked in git AND git-clean.
// Codex round-6 Finding 1 (2026-04-18): without this, the runner loads
// whatever local config/adoption-gates.json exists and stamps its hash into
// the leaderboard, even though the file is untracked and unrecoverable from
// git. The audit promise ("to change a gate, open a git PR") is worthless
// unless it's enforced at runtime.
export function assertGateConfigTracked(loaded: LoadedGates, opts: { repoRoot?: string } = {}): void {
  const root = opts.repoRoot ?? resolveRepoRoot();
  const relPath = path.relative(root, loaded.configPath);
  const humanHint = `\n  git add ${relPath} && git commit -m "config: bootstrap adoption gates"\nOnce committed, future changes go through a PR against that file.`;

  // 1) Tracked check. `git ls-files --error-unmatch` exits non-zero if the
  //    path is not tracked. Capture stderr to distinguish from git errors.
  try {
    execSync(`git ls-files --error-unmatch -- ${JSON.stringify(relPath)}`, {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    const stderrText = e.stderr?.toString() ?? '';
    if (/did not match any file/.test(stderrText) || /not in index/.test(stderrText)) {
      throw new Error(
        `adoption-gates: ${relPath} is not tracked in git. The runner refuses to stamp a hash of an ` +
        `unrecoverable local file into the leaderboard (would make the audit trail meaningless).${humanHint}`,
      );
    }
    throw new Error(
      `adoption-gates: failed to verify git-tracking status of ${relPath}: ${(err as Error).message}. ` +
      `Make sure the repo is a git checkout and git is on PATH.`,
    );
  }

  // 2) Clean check. Non-empty `git status --porcelain` means the file has
  //    staged or unstaged changes relative to HEAD.
  try {
    const stat = execSync(`git status --porcelain -- ${JSON.stringify(relPath)}`, {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
    if (stat.length > 0) {
      throw new Error(
        `adoption-gates: ${relPath} has uncommitted changes (${stat.split('\n')[0]}). ` +
        `The runner refuses to stamp a hash of a dirty gate config into the leaderboard. ` +
        `Commit the change through a PR or revert it before re-running.`,
      );
    }
  } catch (err) {
    if ((err as Error).message.includes('has uncommitted changes')) throw err;
    throw new Error(
      `adoption-gates: failed to verify git-clean status of ${relPath}: ${(err as Error).message}`,
    );
  }
}

export function formatGatesSummary(loaded: LoadedGates): string {
  const { gates, envOverrides, rawHash, effectiveHash } = loaded;
  const lines = [
    `Adoption gates loaded from ${CONFIG_REL} (raw sha256 ${rawHash.slice(0, 12)}...)`,
    `  minOosTrades=${gates.minOosTrades}  maxOosDD=${gates.maxOosDrawdownPct}%  maxSaneSharpe=${gates.maxSaneOosSharpe}`,
    `  minHoldoutSharpe=${gates.minHoldoutSharpe}  minHoldoutMetric=${gates.minHoldoutMetric}  minHoldoutIRFloor=${gates.minHoldoutIrFloor}`,
    `  bootstrapIter=${gates.bootstrapIterations}  naiveBaselineInterval=${gates.naiveBaselineIntervalDays}d`,
  ];
  if (envOverrides.length > 0) {
    lines.push(`  ENV OVERRIDES (must be declared in pre-reg):`);
    for (const o of envOverrides) {
      lines.push(`    ${o.envVar}='${o.rawValue}' → gates.${o.target}=${o.parsed}`);
    }
    lines.push(`  effective hash (incl env): ${effectiveHash.slice(0, 12)}...`);
  }
  return lines.join('\n');
}
