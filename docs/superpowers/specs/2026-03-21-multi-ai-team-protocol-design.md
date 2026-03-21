# Multi-AI Team Protocol Design

> Two-engine coordination framework: Gemini 3.1 Pro (Analyst) + Claude Opus 4.6 (Executor) with a file-based handoff protocol. Designed for minimal setup with a growth path to add Codex as a third engine.

## 1. Problem Statement

Using multiple AI coding assistants (Claude Code, Gemini, Codex) in silos wastes context, duplicates effort, and fails to leverage each engine's unique strengths. We need a lightweight coordination protocol that:

- Preserves context across engine switches (no re-explaining)
- Routes tasks to the engine best suited for them
- Enables a think-then-build pipeline with quality checkpoints
- Requires minimal setup (file-based conventions, no custom tooling)
- Can grow into automation (MCP servers, scripted pipelines) later

## 2. IDE Setup

Antigravity is Google's VSCode fork with native Gemini integration. It supports standard VSCode extensions, so Claude Code and Codex run as extensions inside it.

| Engine | Surface | Role |
|--------|---------|------|
| Gemini 3.1 Pro | Native in Antigravity IDE | The Analyst |
| Claude Opus 4.6 | VSCode extension in Antigravity | The Executor |
| Codex (GPT-5.4) | Future addition via extension/cloud | The Guardian (Phase 2) |

All engines share the same workspace and can read/write the same files. **Only one engine operates on `.handoff/current.md` at a time. The human is the traffic controller.**

## 3. Role Definitions

### Gemini 3.1 Pro — The Analyst

**Why this role:** Best abstract reasoning and novel problem-solving among current frontier models. Strongest at multi-step tool orchestration. 7.5x cheaper than Claude — ideal for high-volume iterative work. Native Google Search grounding for research. Inline autocomplete in Antigravity for daily editing.

<details><summary>Benchmark evidence (March 2026 — may go stale)</summary>

- GPQA Diamond: 94.3% (best abstract reasoning)
- ARC-AGI-2: 77.1% (best novel problem-solving)
- MCP Atlas: 69.2% (best multi-step tool orchestration)
- SWE-Bench Verified: 80.6% (near-tied with Claude)
- Cost: ~$0.67/$3.33 per M tokens (7.5x cheaper than Claude)
</details>

**Responsibilities:**
- Brainstorming and exploring approaches
- Architecture design and trade-off analysis
- Writing specs, plans, and design documents
- Research (libraries, APIs, approaches)
- First-pass code review (high-volume, cheap)
- Quick inline edits and autocomplete while coding

**Limitations to account for:**
- Lower output polish (GDPval Elo 1317 vs Claude's 1606)
- Can hallucinate — verify its suggestions before building
- Rougher at multi-file implementation

### Claude Opus 4.6 — The Executor

**Why this role:** Best coding execution and output quality among current frontier models. Strongest at multi-file refactoring, autonomous debug loops, and long-context retrieval. Most extensible platform (hooks, subagents, skills, MCP).

<details><summary>Benchmark evidence (March 2026 — may go stale)</summary>

- SWE-Bench Verified: 80.8% (best coding execution)
- SWE-Bench Pro: 59% (best multi-language coding)
- GDPval-AA: 1606 Elo (highest expert work quality)
- Terminal-Bench 2.0: 65.4% (best agentic terminal coding)
- MRCR v2: 76% (best long-context retrieval at 1M tokens)
- Cost: $5/$25 per M tokens
</details>

**Responsibilities:**
- Implementing features (multi-file edits, refactors)
- Debugging complex issues (autonomous fix/test loops)
- Test generation and TDD
- Final code review (highest output quality)
- Git operations (commits, branches, PRs)
- Long-running autonomous tasks
- Validating Gemini's architecture proposals for implementation feasibility

**Limitations to account for:**
- More expensive (7.5x cost of Gemini)
- No inline autocomplete
- Overkill for simple analysis or brainstorming

## 4. Task Router

### Decision Matrix

| Task | Engine | Rationale |
|------|--------|-----------|
| "I have an idea, let's explore it" | Gemini | Best reasoning, cheap for iteration |
| "Analyze this code / what does X do" | Gemini | 1M context, strong analysis |
| "Design the architecture for X" | Gemini first, Claude validates | Gemini drafts (best abstract reasoning), Claude reviews for implementation reality |
| "Write a spec / plan for X" | Gemini | Cheaper for iterative drafting |
| "Review this code" (first pass) | Gemini | Catches logic issues cheap |
| "Review this code" (final) | Claude | Catches subtle quality issues |
| "Implement this feature" | Claude | Best execution quality |
| "Refactor across multiple files" | Claude | SWE-Bench Pro leader |
| "Fix this bug" | Claude | Best autonomous debug loops |
| "Write tests for X" | Claude | Stronger at edge cases and correctness |
| "Quick edit / rename / small change" | Gemini (inline) | Already there, fast, free |
| "Research a library / API / approach" | Gemini | Native Google Search grounding |
| "What should we build next?" | Gemini | Broad reasoning, explores trade-offs |

### The Simple Rule

**"Am I thinking or building?"**

- **Thinking** -> Gemini
- **Building** -> Claude
- **Both** -> Gemini drafts, Claude executes

### Two-Step Handoff (Architecture / Design Tasks)

1. Gemini designs (explores approaches, trade-offs, reasoning)
2. Gemini writes result to `.handoff/current.md`
3. Claude reviews for implementation feasibility (fits codebase? edge cases? practical concerns?)
4. Claude approves or flags issues in `.handoff/current.md`
5. Human decides
6. Claude implements

## 5. Handoff Protocol

### Directory Structure

```
.handoff/
├── TEAM.md              # Roles, routing rules, protocol (both engines read)
├── current.md           # Active task state (the "baton")
└── history/             # Completed handoffs (human reference, not auto-indexed)
    └── YYYY-MM-DD-<description>.md
```

The `history/` directory is primarily for human reference — a log of past decisions and outcomes. Engines do not automatically scan it. If you want an engine to reference a past task, point it to the specific file.

### `current.md` Schema

```markdown
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
<one-paragraph summary of where things stand right now>

<!-- Chronological log (append only): -->
### [engine] — [timestamp]
<what this engine produced>

## Artifacts
<files created/modified, specs written, decisions made>

## Next Action
<what the next owner should do>
```

### Stage Lifecycle

```
human creates task (stage: thinking, owner: gemini)
    -> gemini analyzes/plans (stage: review, owner: claude)
        -> claude validates or flags (stage: building, owner: claude)
            -> claude implements (stage: done)
                -> file moves to history/
```

Not all tasks go through every stage. Simple implementation tasks skip straight to `building`. Simple analysis tasks end at `thinking`.

**Error states:**
- `blocked` — the current owner cannot proceed. Must explain why in Work Done and set `owner` to whoever can unblock (or `human`).
- To abandon a task: human moves `current.md` to `history/` with a note "cancelled: <reason>" in Work Done.
- If Claude rejects Gemini's plan entirely: set `stage: blocked`, explain why, set `owner: gemini` for a rethink. Human mediates if they go back and forth more than once.

### Concurrency

This is a **serial protocol** — one active task at a time. If you want Gemini researching while Claude implements something else, finish or shelve the current task first. Parallel work support is out of scope for Phase 1.

### Git Tracking

The `.handoff/` directory should be tracked in git. `TEAM.md` and `history/` provide durable team context. `current.md` will have some churn during active work — this is fine, it's ephemeral coordination state.

### Workflow Examples

**Example 1: "Design and build a new feature"**

1. Human tells Gemini: "Plan the architecture for X. Write your plan to `.handoff/current.md`"
2. Gemini researches, explores approaches, writes plan
   - `stage: thinking` -> `stage: review`, `owner: claude`
3. Human tells Claude: "Review the plan in `.handoff/current.md`"
4. Claude reads, adds implementation review notes
   - If issues: flags them, `owner: gemini` for revision
   - If approved: `stage: building`, `owner: claude`
5. Human tells Claude: "Implement the plan in `.handoff/current.md`"
6. Claude builds, `stage: done`
7. Human moves file to `history/`

**Example 2: "Code review"**

1. Human tells Gemini: "Review changes in `src/lib/X.ts`, write findings to `.handoff/current.md`"
2. Gemini reviews, writes findings (`stage: review`)
3. If issues found, human tells Claude: "Fix issues in `.handoff/current.md`"
4. Claude fixes, `stage: done`

**Example 3: "Debug a failing test"**

1. Skip Gemini — go straight to Claude (building task)
2. Claude debugs and fixes
3. Claude writes summary to `.handoff/current.md` (`stage: done`) for context continuity

**Example 4: "Research before deciding"**

1. Human tells Gemini: "Research approaches for X, write findings to `.handoff/current.md`"
2. Gemini researches, writes comparison (`stage: done`)
3. Human reads findings, decides next step
4. No handoff to Claude needed — task complete

## 6. Engine Configuration

### CLAUDE.md Addition

Add to the project's existing `CLAUDE.md`:

```markdown
## Multi-AI Team Protocol

You are **The Executor** in a two-engine team. Read `.handoff/TEAM.md` for full protocol.

Before starting any task:
1. Check `.handoff/current.md` — if it exists and is assigned to you, that's your task
2. Read the Objective, Context, and Work Done sections before acting
3. When done, update `current.md` with your work in the Work Done section

When implementing from a Gemini plan:
- Validate the plan against the actual codebase before building
- Flag implementation concerns in current.md rather than silently working around them
- You own the final quality — if the plan has gaps, fill them

When you complete a task:
- Set `stage: done` and summarize what you did in Work Done
- List all modified files in Artifacts
```

### GEMINI.md (New File)

Create `GEMINI.md` in the project root:

```markdown
# Trading Journal — Gemini Context

## Multi-AI Team Protocol

You are **The Analyst** in a two-engine team. Read `.handoff/TEAM.md` for full protocol.

Before starting any task:
1. Check `.handoff/current.md` — if it exists and is assigned to you, that's your task
2. Read all sections before acting

When analyzing or planning:
- Write your output to `.handoff/current.md` using the standard schema
- Be specific: name files, line numbers, function names
- When proposing architecture, include trade-offs and your recommendation
- Set the next owner to `claude` if implementation is needed

When reviewing code:
- Focus on logic, architecture, and correctness
- Don't worry about style polish — Claude handles final quality

## Project Context

Options trading journal: React 18 + Vite 5 + React Router v6 + React Query v5 frontend, Vercel API routes (ESM .js), Supabase DB.

For full project context (key files, database tables, testing, architecture), read `.handoff/TEAM.md` which contains shared context both engines use. Do NOT read CLAUDE.md — it contains Claude-specific instructions.
```

### .handoff/TEAM.md

```markdown
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

See the full routing table in the design spec:
`docs/superpowers/specs/2026-03-21-multi-ai-team-protocol-design.md`

## Handoff Format

Active task lives in `.handoff/current.md`. Schema:

- `task`: short description
- `stage`: thinking | review | building | done
- `owner`: gemini | claude
- `from`: who set this state
- `timestamp`: when

Sections: Objective, Context, Work Done, Artifacts, Next Action.

## Rules

1. Always read `current.md` before starting work
2. Always update `current.md` when done
3. In Work Done: replace the summary paragraph, append to the chronological log
4. If you disagree with the previous engine's approach, explain why in Work Done
5. The human makes final decisions on disagreements
6. Only one engine works on `current.md` at a time — the human controls handoffs
7. If you cannot proceed, set stage to `blocked` and explain why

## Shared Project Context

Options trading journal: React 18 + Vite 5 + React Router v6 + React Query v5 frontend, Vercel API routes (ESM .js), Supabase DB.

Key files, architecture, database tables, and testing details are documented in the project's CLAUDE.md (for Claude) and GEMINI.md (for Gemini). This section contains only the shared context both engines need.

Critical rules:
- `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` MUST stay in sync (307 parity tests)
- All 488+ existing tests must keep passing after any change
- Data providers: ORATS (options) + Tiingo (stock candles)
```

## 7. Future: Adding Codex (Phase 2)

When ready to add Codex as a third engine for automated PR review and CI/CD:

### Prerequisites

- Adopt PR workflow (Claude creates branches instead of committing to main)
- Install Codex extension or configure Codex Cloud with GitHub repo
- Create `AGENTS.md` in project root

### Codex's Role: The Guardian

| Task | Trigger |
|------|---------|
| Auto-review every PR | `@codex review` or automatic review mode |
| Fix CI failures | GitHub Action (`codex-action@v1`) on test failure |
| Parallel async tasks | Fire-and-forget bulk work |

### Updated Pipeline

```
Human -> Gemini (think) -> Claude (build) -> PR -> Codex (review) -> Merge
```

### Changes Required

1. Add to `TEAM.md`: Codex role as "The Guardian"
2. Create `AGENTS.md` mirroring relevant TEAM.md rules
3. Update Claude's workflow: create branch + open PR instead of committing to main
4. Enable Codex auto-review in GitHub settings
5. Optional: add `codex-action@v1` GitHub Action for CI auto-fix

Nothing in the two-engine setup needs to change — Codex is purely additive.

## 8. Usage Guide

### Setup

Both engines live in the same Antigravity IDE window:
- **Gemini (The Analyst)** — Native in Antigravity. Use the built-in chat panel or inline autocomplete.
- **Claude Code (The Executor)** — VSCode extension panel in the sidebar.

### Starting a New Task

1. Copy the template: `cp .handoff/TEMPLATE.md .handoff/current.md`
2. Fill in: `task`, `timestamp`, `Objective`, `Context`, and `Next Action`
3. Tell the appropriate engine to pick it up

Or just tell Gemini directly — it knows to write to `current.md`:
> "I want to [do X]. Explore approaches and write your plan to `.handoff/current.md`"

### Talking to Each Engine

**To Gemini:**
> "Do X. Write your output to `.handoff/current.md`"

**To Claude (shortcut):**
> `/handoff`

The `/handoff` skill automatically reads `current.md`, checks ownership and stage, and acts accordingly. No need to type the full instruction.

**To Claude (manual, if needed):**
> "Read `.handoff/current.md` and [review / implement / fix] it."

### Workflow by Scenario

**Add a new feature:**
1. Gemini panel: "I want to add [feature]. Explore approaches and write your plan to `.handoff/current.md`"
2. Claude panel: `/handoff` (Claude reviews the plan, flags issues or approves)
3. Claude panel: `/handoff` (if approved, Claude implements)

**Fix a bug:**
1. Skip Gemini — go straight to Claude (building task)
2. Claude panel: "The test [X] is failing with [error]. Debug and fix it."

**Research something:**
1. Skip Claude — go straight to Gemini (thinking task)
2. Gemini panel: "Research [topic]. Write findings to `.handoff/current.md`"
3. Read findings yourself. If action needed → Claude panel: `/handoff`

**Code review:**
1. Gemini panel (first pass, cheap): "Review changes in `[file]`. Write findings to `.handoff/current.md`"
2. Claude panel (fix, if needed): `/handoff`

**Quick edit while coding:**
1. Just use Gemini's inline autocomplete. No handoff needed.

**Design an architecture:**
1. Gemini panel: "Design the architecture for [X]. Include trade-offs and your recommendation. Write to `.handoff/current.md`"
2. Claude panel: `/handoff` (reviews for implementation feasibility)
3. Resolve any disagreements yourself
4. Claude panel: `/handoff` (implements the approved plan)

### Quick Decision Flowchart

```
You have a task
    |
    +-- Thinking? --> Gemini panel
    |                  "Do X. Write to .handoff/current.md"
    |                      |
    |                      +-- Need implementation? --> Claude: /handoff
    |                      |
    |                      +-- Research only? --> Read findings yourself. Done.
    |
    +-- Building? --> Claude panel
    |                  "Do X" (no handoff needed)
    |
    +-- Quick edit? --> Just type (Gemini autocomplete)
```

### Key Files

| File | Purpose |
|------|---------|
| `.handoff/TEAM.md` | Shared protocol — roles, routing, rules, project context |
| `.handoff/TEMPLATE.md` | Copy to `current.md` to start a new task |
| `.handoff/current.md` | Active task baton (created per-task) |
| `.handoff/history/` | Completed handoffs for reference |
| `GEMINI.md` | Gemini config — Analyst role + full project context |
| `CLAUDE.md` | Claude config — Executor role (section at bottom) |
| `.claude/skills/handoff/SKILL.md` | `/handoff` slash command for Claude |

### What NOT to Do

- Don't tell both engines to work on the same thing at the same time
- Don't skip pointing to `current.md` — if you tell Claude "implement X" without the handoff file, it loses the context Gemini built
- Don't use Gemini for multi-file implementation — output quality won't match Claude
- Don't use Claude for quick research — it works but costs 7.5x more for the same answer

---

## 9. Success Criteria

- [ ] Both engines can read `.handoff/TEAM.md` and understand their role
- [ ] Handoff via `current.md` preserves enough context that the receiving engine doesn't need re-explanation
- [ ] Task routing is clear — user always knows which engine to use
- [ ] No duplicate work — each engine has a distinct lane
- [ ] Protocol adds < 1 minute overhead per task (reading/writing `current.md`)
- [ ] Context continuity across sessions via `history/` directory
