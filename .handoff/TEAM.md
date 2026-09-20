# AI Team Protocol

## Engines

| Engine | Role | Config | Status |
|--------|------|--------|--------|
| Claude Opus 4.7 | Primary Builder + Planner — designs, implements, debugs, tests; owns the `.handoff/` workflow | CLAUDE.md | Active |
| Codex (GPT-5) | Adversarial Reviewer + Rescue — second-pass review, cross-checks, fresh-eyes diagnosis, alternative implementations | Codex session + repo docs | Active |
| Gemini 3.1 Pro | The Analyst — thinks, plans, reviews long docs, native web grounding | GEMINI.md | **Paused (2026-05-08)** — may be revived; routing language below preserved for that case |

## Task Routing

**Simple rule: "Am I building, or having my work checked?"**

- Building (plan + implement) -> Claude
- Adversarial review, second opinion, rescue when stuck -> Codex
- Claude/Codex disagree after one round-trip -> human tiebreaks

Full routing table (active engines):

| Task | Engine | Rationale |
|------|--------|-----------|
| Explore an idea | Claude | Long context + repo skills/memory; Codex as second opinion if needed |
| Analyze code / "what does X do" | Claude | 1M context, strong cross-file analysis |
| Design architecture | Claude drafts, Codex adversarial-reviews | Single primary planner avoids handoff churn; Codex stress-tests feasibility |
| Write a spec or plan | Claude | Plans live in `.handoff/current.md` and feed directly into Claude's build loop |
| Code review (first pass) | Claude (self-review per `verification-before-completion`) | No cheap-iteration analyst until Gemini revives — replace with explicit verify step |
| Code review (final, adversarial) | Codex | Different model family = real fresh eyes; see `feedback_codex-review-discipline.md` |
| Implement a feature | Claude | Tool integration (Claude Code, MCP, agents, skills) is here |
| Multi-file refactor | Claude | Cross-file edits with parity-test discipline (e.g., `oss-core.ts` ↔ `scoring.cjs`) |
| Fix a bug | Claude primary; Codex via `codex:codex-rescue` if stuck | Rescue agent exists for exactly this case |
| Write tests | Claude | Edge-case-focused implementation + verification; Codex reviews adversarially |
| Quick edit / rename | Claude (inline) | — |
| Research a library or API | Claude with `documentation-lookup` / Context7; Codex for second opinion | Lost Gemini's native web grounding; use MCP-backed docs lookup instead |
| Adoption-affecting code (sealer, gates, parity tests) | Claude implements, Codex adversarial-reviews **before merge** | Research-cannot-approve-its-own-model still holds; Codex is the cross-check |

In shared handoffs, Claude and Codex use the same role-lens vocabulary from `docs/08_AGENT_ROLES_AND_KNOWLEDGE_BASE.md` and the same guardrails.

## Role Lens Layer

The engine assignment above answers "which model should do the work?" The role lens answers "which responsibility is being exercised?" Use `docs/08_AGENT_ROLES_AND_KNOWLEDGE_BASE.md` as the source of truth for role responsibilities, knowledge bases, decision rights, and guardrails.

Default mapping (active 2-engine team):

| Work Type | Primary Role Lens | Engine Assignment |
|---|---|---|
| Strategy hypothesis, pre-registration, factor idea | Quant Research Agent | Claude drafts; **Codex adversarial-reviews before runner starts** |
| Backtest skepticism, leakage, overfit, adoption challenge | Research Validation / Model Risk Agent | Codex primary (must be a different engine than the one that built the strategy) |
| Simulator, scoring, API, test implementation | Quant Dev / Simulation Engineer Agent | Claude; Codex reviews parity-critical code (`oss-core.ts` ↔ `scoring.cjs`, sealer, adoption gates) |
| ORATS/Tiingo/Supabase freshness, coverage, lineage | Data Engineering / Data Steward Agent | Claude |
| Live entry, roll, no-trade ticket | Trader / Execution Agent | Claude validates UI/data path; **human confirms any real-money action** |
| Position size, drawdown, concentration, Greeks | Risk Manager Agent | Claude implements; Codex reviews; **human signs off on limit changes** |
| Workflow design and decision states | Product / UX Discipline Agent | Claude |
| React/Tailwind/Query work | Frontend / App Engineer Agent | Claude |
| Vercel, cron, env, CI, RLS, production readiness | Platform / DevOps / Security Agent | Claude; Codex reviews secrets/permission changes |
| Trade review, Academy, behavioral feedback | Journal / Education Agent | Claude |
| Strategy adoption and capital allocation | Portfolio Governor / CIO Agent | **Human decision**, with Claude + Codex support |

The "different engine reviews adoption-affecting code" rule replaces what used to be Gemini's first-pass review lane. Without it, the research-cannot-approve-its-own-model guardrail collapses to self-review.

Guardrails:
- Research cannot approve its own model — **enforced now by routing the adversarial review to the engine that did *not* implement the change** (Claude builds → Codex reviews; if Codex rescued/built → Claude reviews).
- Risk can veto execution.
- Data quality issues block performance claims.
- Human confirmation is required for real-money orders.
- Trade-affecting UI changes need Product / UX plus Risk review.
- **Human is the sole tiebreaker** when Claude and Codex disagree (no third engine to mediate while Gemini is paused).

## Handoff Format

Active task lives in `.handoff/current.md`. Schema:

```
---
task: <short description>
stage: thinking | review | building | blocked | done
owner: gemini | claude | codex
from: gemini | claude | codex | human
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
- The full automated test suite must keep passing after any change; run `npm run test` for the current suite size
- Data providers: ORATS (options) + Tiingo (stock candles + IEX intraday for 130M)
- Crons: most triggered via cronjobs.org. Exception: `cron-iv` uses Vercel cron (22:00 UTC weekdays)
- Short-term strategy uses 130M timeframe (not 4H). Scoring overhaul phase 1 complete (VRP, orFcst20d).
