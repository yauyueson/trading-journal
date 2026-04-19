# AI Team Protocol

## Engines

| Engine | Role | Config |
|--------|------|--------|
| Gemini 3.1 Pro | The Analyst — thinks, plans, reviews | GEMINI.md |
| Claude Opus 4.6 | The Executor — builds, debugs, tests | CLAUDE.md |

## Task Routing

**Simple rule: "Am I thinking or building?"**

- Thinking -> Gemini
- Building -> Claude
- Both -> Gemini drafts, Claude executes

Full routing table:

| Task | Engine | Rationale |
|------|--------|-----------|
| Explore an idea | Gemini | Best reasoning, cheap for iteration |
| Analyze code / "what does X do" | Gemini | 1M context, strong analysis |
| Design architecture | Gemini first, Claude validates | Gemini drafts, Claude reviews for feasibility |
| Write a spec or plan | Gemini | Cheaper for iterative drafting |
| Code review (first pass) | Gemini | Catches logic issues cheap |
| Code review (final) | Claude | Catches subtle quality issues |
| Implement a feature | Claude | Best execution quality |
| Multi-file refactor | Claude | Best at cross-file changes |
| Fix a bug | Claude | Best autonomous debug loops |
| Write tests | Claude | Stronger at edge cases |
| Quick edit / rename | Gemini (inline) | Fast, free, already there |
| Research a library or API | Gemini | Native Google Search grounding |

## Handoff Format

Active task lives in `.handoff/current.md`. Schema:

```
---
task: <short description>
stage: thinking | review | building | blocked | done
owner: gemini | claude
from: gemini | claude | human
timestamp: YYYY-MM-DDTHH:MM:SS (local time)
---

## Objective
<what needs to happen>

## Context
<relevant files, decisions, constraints>

## Work Done
<!-- Current state summary (replace each handoff): -->
<one-paragraph summary of where things stand>

<!-- Chronological log (append only): -->
### [engine] — [timestamp]
<what this engine produced>

## Artifacts
<files created/modified, decisions made>

## Next Action
<what the next owner should do>
```

## Rules

1. Always read `current.md` before starting work
2. Always update `current.md` when done
3. In Work Done: replace the summary paragraph, append to the chronological log
4. If you disagree with the previous engine's approach, explain why in Work Done
5. The human makes final decisions on disagreements
6. Only one engine works on `current.md` at a time — the human controls handoffs
7. If you cannot proceed, set stage to `blocked` and explain why

## Error States

- `blocked` — cannot proceed. Explain why in Work Done, set owner to whoever can unblock.
- To abandon: human moves `current.md` to `history/` with "cancelled: <reason>" in Work Done.
- If engines disagree after one round-trip: human mediates.

## Pre-Registration Convention (autoresearch runs)

Every autoresearch run (`scripts/autoresearch/runner.ts`) requires a **Pre-Registration** block in `.handoff/current.md`, committed to git before the run starts. The runner reads the file, validates it has the required sub-sections, format-checks the holdout hash, and refuses to start otherwise.

**What the runner actually enforces today:**
1. A `## Pre-Registration` section exists in `.handoff/current.md`.
2. The file is committed (`git status --porcelain .handoff/current.md` is clean).
3. Each required sub-section below is present and non-empty.
4. **Holdout Window Hash** matches the SHA-256 format `^(sha256:)?[a-f0-9]{64}$` (case-insensitive).
5. Any `AUTORESEARCH_*` env var that overrides a gate in `config/adoption-gates.json` appears in the **Declared Env Overrides** list.

**What is NOT automatically enforced yet** (audit-trail / manual-review only — will be automated in later phases):
- Semantic match of `Holdout Window Hash` against a committed `data/manifests/*` entry (deferred to Phase 0.b.6).
- That the runner actually evaluates the parameter combinations listed in `Config Grid` (deferred; requires per-run strategy-bundle introspection).
- That `Decision Rule` and `Adoption Threshold` match the gate file (deferred; interpreted by the human at decision time).
- The hypothesis is well-calibrated or the decision rule is unbiased (human judgment).

**Required sub-sections** (inside the `## Pre-Registration` section):

- **Hypothesis** — one or two sentences, written *before* seeing the result.
- **Config Grid** — the exact parameter combinations the runner will evaluate.
- **Decision Rule** — the rule that turns the leaderboard into a go/no-go decision (e.g. "adopt if holdout Sharpe ≥ 0.5 AND IR > 0 AND PBO < 0.2").
- **Adoption Threshold** — the numeric bar the winning variant must clear.
- **Holdout Window Hash** — format-checked sha256 (64 hex chars, optional `sha256:` prefix). Use `sha256:0000000000000000000000000000000000000000000000000000000000000000` as a placeholder for smokes.
- **Declared Env Overrides** (required iff any `AUTORESEARCH_*` env var overrides a gate) — list of env-var names. Example: `**Declared Env Overrides**: AUTORESEARCH_MIN_OOS_TRADES`.

**Template:**

```markdown
## Pre-Registration

**Hypothesis**: Candidate LEAP strategy with SL=0.35 will out-perform the incumbent in the 2024-2026 holdout.
**Config Grid**: delta {0.65, 0.70}, DTE {180, 270}, SL {0.30, 0.35}, timeStop {105, 150}.
**Decision Rule**: Adopt only the single variant with the highest N_eff-adjusted DSR, subject to PBO < 0.2 and positive IR vs all three baselines.
**Adoption Threshold**: holdout Sharpe ≥ 0.5, holdout SPY IR ≥ 0.2, no gate failure.
**Holdout Window Hash**: sha256:0000000000000000000000000000000000000000000000000000000000000000
**Declared Env Overrides**: none
```

**Bypass** (the only supported way to skip the gate for legitimate smokes):

```bash
AUTORESEARCH_PREREG_BYPASS="smoke test post Phase 0 rebuild, tracked in docs/rebuild-2026-04/" \
  npx tsx scripts/autoresearch/runner.ts
```

The bypass reason must be ≥ 12 characters. It is printed at the top of the run, logged alongside the leaderboard entry, and counts as a declared trial for the global trial ledger. There is no other way to skip the gate — git-clean is not opt-outable from the environment (Codex adversarial-review Finding 1, 2026-04-18).

**Gate-config immutability:**
All adoption thresholds live in `config/adoption-gates.json`. The runner hashes the file at start, re-hashes it before each leaderboard write, and aborts if the hash changes mid-campaign. To change a gate, open a git PR against `config/adoption-gates.json`.

## Shared Project Context

Options trading journal: React 18 + Vite 5 + React Router v6 + React Query v5 frontend, Vercel API routes (ESM .js), Supabase DB.

Critical rules:
- `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` MUST stay in sync (307 parity tests)
- All 683 existing tests must keep passing after any change
- Data providers: ORATS (options) + Tiingo (stock candles + IEX intraday for 130M)
- Crons: most triggered via cronjobs.org. Exception: `cron-iv` uses Vercel cron (22:00 UTC weekdays)
- Short-term strategy uses 130M timeframe (not 4H). Scoring overhaul phase 1 complete (VRP, orFcst20d).
