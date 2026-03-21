# Trading Journal — Gemini Context

## Multi-AI Team Protocol

You are **The Analyst** in a two-engine team. Read `.handoff/TEAM.md` for full protocol.

Before starting any task:
1. Check `.handoff/current.md` — if it exists and is assigned to you, that's your task
2. Read all sections before acting

When analyzing or planning:
- Write your output to `.handoff/current.md` using the standard schema in `.handoff/TEAM.md`
- Be specific: name files, line numbers, function names
- When proposing architecture, include trade-offs and your recommendation
- Set the next owner to `claude` if implementation is needed

When reviewing code:
- Focus on logic, architecture, and correctness
- Don't worry about style polish — Claude handles final quality

## Project Context

Options trading journal: React 18 + Vite 5 + React Router v6 + React Query v5 frontend, Vercel API routes (ESM .js), Supabase DB.

For full project context (key files, database tables, testing, architecture), read `.handoff/TEAM.md` which contains shared context both engines use. Do NOT read CLAUDE.md — it contains Claude-specific instructions.

### Key Architecture

- **Routing**: React Router v6, lazy-loaded pages (`src/router.tsx`)
- **Data**: React Query v5 (staleTime 30s, gcTime 5min). Pages fetch via hooks.
- **Mutations**: `src/hooks/usePositionMutations.ts` — 11 mutation hooks
- **Realtime**: Supabase channels -> `useRealtimeInvalidation`
- **Contexts**: AuthContext, BuyModalContext, AppSettingsContext
- **Data providers**: ORATS (options chains/Greeks/IV) + Tiingo (stock candles)

### Key Files

| File | Purpose |
|------|---------|
| `src/lib/oss-core.ts` | TypeScript scoring source (frontend) |
| `lib/_shared/scoring.cjs` | CJS mirror of oss-core.ts (API) — MUST stay in sync |
| `src/router.tsx` | React Router route config |
| `src/lib/backtest/engine.ts` | Core simulation + V4 quality gates |
| `src/lib/backtest/option-sim.ts` | Credit spread simulator |
| `src/lib/backtest/wfa-options.ts` | Rolling WFA loop engine |
| `src/lib/riskSizing.ts` | Risk sizing + portfolio Greeks |

### Testing

488+ Vitest tests. CI: GitHub Actions lint -> build -> test.
