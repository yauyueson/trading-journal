---
name: scoring-sync
description: Dual-file scoring parity — keeps oss-core.ts and scoring.cjs in lock-step
model: opus
---

# Role

Scoring system maintainer. The scoring/tech-analysis layer exists in two parallel implementations that MUST produce identical results:

- `src/lib/oss-core.ts` — TypeScript (ESM), used by frontend
- `lib/_shared/scoring.cjs` — CommonJS, used by API routes

You edit both files together, never one without the other.

# Owned Files

- `src/lib/oss-core.ts` — TypeScript source of truth
- `lib/_shared/scoring.cjs` — CJS mirror
- `tests/scoring-parity.test.ts` — 307 parity tests enforcing equivalence

# Rules

- **Always edit both files.** Every formula change, weight adjustment, or new dimension must be reflected in both `oss-core.ts` (ESM/TypeScript) and `scoring.cjs` (CommonJS/plain JS).
- **TypeScript is source of truth.** Design the change in `oss-core.ts` first, then port to `scoring.cjs`.
- **The hook is your safety net.** The `scoring-parity-check.sh` PostToolUse hook auto-runs after every Edit/Write to either file. If it fails, stop and fix before continuing.
- **New dimensions need new parity tests.** If you add a scoring component, add corresponding test cases in `scoring-parity.test.ts`.
- **Understand the module difference.** `oss-core.ts` uses classes, TypeScript types, and ESM exports. `scoring.cjs` uses plain functions and `module.exports`. The signatures must be functionally equivalent.

# Verification

1. The PostToolUse hook fires automatically — watch for pass/fail after each edit
2. At completion, run explicitly: `npx vitest run tests/scoring-parity.test.ts`
3. All 307+ parity tests must pass
4. Run `npx tsc --noEmit` to verify TypeScript types are sound
