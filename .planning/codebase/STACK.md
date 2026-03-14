# Technology Stack

**Analysis Date:** 2026-03-14

## Languages

**Primary:**
- TypeScript 5.2 — all frontend source (`src/**/*.ts`, `src/**/*.tsx`)
- JavaScript (ESM) — all API routes (`api/**/*.js`) and shared lib (`lib/**/*.js`)

**Secondary:**
- CJS JavaScript — `lib/_shared/scoring.cjs` (mirror of `src/lib/oss-core.ts`; required by API routes via `createRequire`)
- SQL — Supabase migrations in `supabase/migrations/`

## Runtime

**Environment:**
- Node.js 20 (pinned in CI via `.github/workflows/ci.yml`; local v25.8.1)
- ESM-first: `package.json` has `"type": "module"`; API routes use `.js` ESM imports

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- React 18.2 — UI component layer (`src/`)
- React Router v6.30 — client-side routing, lazy-loaded pages (`src/router.tsx`)
- React Query v5.90 (`@tanstack/react-query`) — server state, staleTime 30s, gcTime 5min (`src/lib/queryClient.ts`)

**Styling:**
- Tailwind CSS 3.3 — utility-first CSS; dark-themed design tokens in `tailwind.config.js`
- PostCSS 8 with autoprefixer — `postcss.config.js`
- `clsx` 2.1 + `tailwind-merge` 3.4 — conditional class merging (`src/lib/utils.ts` → `cn()`)

**UI Components:**
- `lucide-react` 0.294 — icon library
- `recharts` 3.7 — charting library for analytics and backtest views

**Testing:**
- Vitest 4.0 — test runner (config in `vite.config.ts` `test` block)
- `@testing-library/react` 16.3 + `@testing-library/jest-dom` 6.9 — component testing
- `jsdom` 28.1 — DOM environment for unit tests

**Build/Dev:**
- Vite 5.0 — bundler and dev server; `vite.config.ts` includes local API shim plugin
- `tsx` 4.21 — TypeScript execution for scripts
- TypeScript compiler (`tsc`) — type checking pre-build (`npm run build` = `tsc && vite build`)

## Key Dependencies

**Critical:**
- `@supabase/supabase-js` 2.39 — database client (frontend: `src/lib/supabase.ts`; API: `api/cron-iv.js`)
- `better-sqlite3` 12.6 — SQLite cache for ORATS historical option chains (`src/lib/backtest/chain-cache.ts`); stores data at `data/option-chains.sqlite`
- `date-fns` 2.30 — date arithmetic throughout scoring and backtest modules

**Infrastructure:**
- `dotenv` 16.6 — env loading in lib files (`lib/orats-client.js`, `lib/tiingo-client.js`)

## Configuration

**Environment:**
- Frontend reads `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (hardcoded fallback in `src/lib/utils.ts`)
- API routes read `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Data providers: `ORATS_API_TOKEN`, `TIINGO_API_TOKEN`, `DATA_SOURCE=ORATS`
- Notifications: `DISCORD_WEBHOOK_URL`
- Cron security: `CRON_SECRET`
- Rate limit overrides: `ORATS_RATE_LIMIT_RPM` (default 1000), `TIINGO_RATE_LIMIT_RPM` (default 50)
- Files: `.env` and `.env.local` (both present); lib files load `.env.local` first then `.env`

**Build:**
- `tsconfig.json` — strict mode, `ES2020` target, `@/*` path alias → `./src/*`, bundler moduleResolution
- `tsconfig.node.json` — separate config for Vite/Node tooling
- `vite.config.ts` — resolves `@/` alias; dev server injects local API plugin for CBOE/ORATS shims

**TypeScript path alias:**
- `@/*` resolves to `./src/*` — used throughout frontend imports

## Platform Requirements

**Development:**
- Node.js 20+, npm
- `.env.local` with `ORATS_API_TOKEN`, `TIINGO_API_TOKEN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- Run `npm run dev` for Vite dev server with local API shims

**Production:**
- Vercel (framework: vite, outputDirectory: dist)
- Build: `npm run build` (`tsc && vite build`)
- API routes as Vercel Serverless Functions (`api/*.js`), each with explicit `maxDuration`
- One Vercel-native cron: `/api/cron-iv?job=backfill` at `0 22 * * 1-5`
- External cron triggers via cronjobs.org for signal scan (21:00 UTC) and trade outcomes (21:35 UTC)
- SQLite (`data/option-chains.sqlite`) is a local/dev-only cache — not available in serverless

---

*Stack analysis: 2026-03-14*
