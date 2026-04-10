# Agent Team — Trading Journal

7 specialized agents mapped to real work domains. Use them via Claude Code's Agent tool or by name in conversation.

## Roster

| Agent | Model | Domain | Key Files |
|-------|-------|--------|-----------|
| `config-propagator` | sonnet | Strategy config cascade (8 files) | `data/strategy-config.json` → 8 downstream |
| `scoring-sync` | opus | Scoring parity (TS + CJS) | `oss-core.ts` ↔ `scoring.cjs` |
| `backtest-engine` | opus | Quant core: BSM, option-sim, WFA | `src/lib/backtest/*`, `scripts/*` |
| `api-backend` | sonnet | Serverless routes, crons, Supabase | `api/*.js`, `lib/_shared/*` |
| `frontend-ui` | sonnet | React pages, components, hooks | `src/pages/*`, `src/components/*`, `src/hooks/*` |
| `research-docs` | sonnet | Study READMEs, results tables | `backtesting history/*/README.md` |
| `quality-ops` | opus | Testing, debugging, refactoring, cleanup | `tests/*`, `src/lib/__tests__/*`, cross-domain |

## Orchestration Patterns

### A. WFA Study -> Deploy (30%)
```
/wfa-study → backtest-engine → PARALLEL(analyze-backtest, research-docs)
  → human picks champion → config-propagator
  → PARALLEL(api-backend, frontend-ui, /strategy-audit) → /deploy-check
```

### B. P&L Fix (25%)
```
Diagnose scope → frontend-ui | api-backend→frontend-ui | scoring-sync
  → PARALLEL(/deploy-check, /strategy-audit)
```

### C. Consistency Audit (20%)
```
/strategy-audit → config-propagator → PARALLEL(/strategy-audit, /deploy-check)
```

### D. UI/UX (15%)
```
frontend-ui [+ api-backend if new endpoint] → /deploy-check
```

### E. Research Docs (10%)
```
/analyze-backtest → research-docs [→ config-propagator if strategy change]
```

### F. Refactor / Cleanup Sweep
```
quality-ops (green baseline) → refactor → quality-ops (verify green)
  → /deploy-check
```

### G. Cross-Domain Bug
```
quality-ops (diagnose + failing test) → domain agent (fix) → quality-ops (verify)
```

## Quick Dispatch

| When you need to... | Use |
|---------------------|-----|
| Change EMA/SL/ticker/delta | `config-propagator` |
| Edit scoring formulas | `scoring-sync` |
| Modify backtest engine/WFA | `backtest-engine` |
| Fix/add API routes or crons | `api-backend` |
| Update UI pages/components | `frontend-ui` |
| Document study results | `research-docs` |
| Debug a cross-domain bug | `quality-ops` |
| Refactor / remove dead code | `quality-ops` |
| Write or fix tests | `quality-ops` |
| Simplify / consolidate code | `quality-ops` |
| Full codebase review | All 7 in parallel |

## Integration with Skills

Agents complement — not replace — existing skills:
- `/strategy-audit` audits consistency; `config-propagator` fixes it
- `/analyze-backtest` diagnoses results; `research-docs` writes them up
- `/wfa-study` designs studies; `backtest-engine` implements the code
- `/deploy-check` gates deployment; all agents can invoke it
- `/handoff` routes Gemini work; dispatch to appropriate agent based on task type
