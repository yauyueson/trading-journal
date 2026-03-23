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

## Shared Project Context

Options trading journal: React 18 + Vite 5 + React Router v6 + React Query v5 frontend, Vercel API routes (ESM .js), Supabase DB.

Critical rules:
- `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` MUST stay in sync (307 parity tests)
- All 683 existing tests must keep passing after any change
- Data providers: ORATS (options) + Tiingo (stock candles + IEX intraday for 130M)
- Crons: most triggered via cronjobs.org. Exception: `cron-iv` uses Vercel cron (22:00 UTC weekdays)
- Short-term strategy uses 130M timeframe (not 4H). Scoring overhaul phase 1 complete (VRP, orFcst20d).
