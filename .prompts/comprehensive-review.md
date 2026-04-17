# Comprehensive Codebase Review Prompt

## Context

You are reviewing a **trading journal web application** built with:
- **Frontend**: React 18 + Vite 5 + TypeScript + Tailwind CSS
- **Backend**: Vercel serverless API routes (ESM `.js` files in `api/`)
- **Database**: Supabase PostgreSQL + Realtime
- **Data Providers**: ORATS (options chains), Tiingo (stock candles)
- **Routing**: React Router v6, lazy-loaded pages
- **State**: React Query v5 (staleTime 30s, gcTime 5min), contexts for auth/settings
- **Testing**: Vitest, 738+ tests, jsdom environment

### Key Architecture

- `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` are dual-file scoring systems that MUST stay in sync (307 parity tests enforce this)
- `src/lib/backtest/` contains a backtesting engine with BSM pricing, option simulation, WFA
- `src/components/PositionCard.tsx` is the largest component (~1030 lines) — position display, live Greeks, P&L, alerts
- `src/hooks/usePositionMutations.ts` has 11 mutation hooks for position CRUD
- `api/strategy-recommend.js` is the main recommendation engine using raw `fetch()` for Supabase REST

### Active Strategy

DTE5 Bull Put Credit Spread (QQQ only): short delta 0.30 / long delta 0.20, DTE 2-7, EMA34 gate, hold-to-expiry. Paper trading at $10K, 10% risk per trade.

---

## Review Scope

Perform a deep, file-by-file review across six dimensions. For each finding, provide:
- **File path and line number(s)**
- **Severity**: Critical / High / Medium / Low
- **Category** (which of the 6 dimensions)
- **What's wrong** (concrete, not vague)
- **Suggested fix** (code snippet or clear instruction)

---

### 1. Trading Strategy Correctness

Review all financial calculations for mathematical correctness and edge cases.

**Files to focus on:**
- `src/components/PositionCard.tsx` — P&L (unrealized, realized), TP progress, TP target, risk-at-stopout
- `src/lib/riskSizing.ts` — position sizing, portfolio risk aggregation, concentration warnings
- `src/lib/oss-core.ts` — scoring formulas (EMA alignment, IV rank, delta checks)
- `src/lib/backtest/engine.ts` — simulation logic, quality gates
- `src/lib/backtest/option-sim.ts` — credit spread simulation, BSM pricing, delta stop exits
- `src/lib/backtest/bsm-pricing.ts` — Black-Scholes-Merton implementation
- `api/strategy-recommend.js` — recommendation engine filters and scoring
- `api/cron-trade-outcomes.js` — MFE/MAE computation

**Check for:**
- [ ] P&L formulas: credit vs debit spread sign conventions. Verify `(avgPrice - currentPrice)` for credit and `(currentPrice - avgPrice)` for debit are applied consistently everywhere
- [ ] Spread net price calculation: `shortAsk - longBid` for credit cost-to-close — can this go negative? Should it be floored at 0?
- [ ] TP target and TP progress: are they using avg price (not entry price) consistently?
- [ ] Risk sizing: does `getPositionRiskAtStopOutDollars` handle multi-leg spreads correctly?
- [ ] Greeks aggregation: sign conventions for short vs long legs (should short delta be negative)
- [ ] Realized P&L on partial closes (Size Down): does it correctly use avg cost at time of sale?
- [ ] Edge cases: what happens with 0 qty positions, expired positions, missing price data?
- [ ] BSM pricing: verify d1/d2 formulas, put-call parity, boundary conditions (DTE=0, IV=0)
- [ ] Scoring parity: any divergence between `oss-core.ts` and `scoring.cjs`?

---

### 2. UI/UX Consistency

Review the frontend for visual consistency, responsive behavior, and design system adherence.

**Files to focus on:**
- `src/layouts/AppLayout.tsx` — layout structure (desktop floating bar, mobile slim bar + bottom tab)
- `src/components/MobileTabBar.tsx` — iOS bottom navigation
- `src/components/TabNav.tsx` — desktop navigation
- `src/components/PositionCard.tsx` — card layout, data display, action buttons
- `src/pages/*.tsx` — all page components
- `src/index.css` — global styles, design tokens, safe area handling
- `tailwind.config.js` — custom theme tokens

**Check for:**
- [ ] Design token consistency: are colors using Tailwind tokens (`text-text-primary`, `bg-bg-secondary`, etc.) or hardcoded hex values? Flag any hardcoded colors
- [ ] Spacing consistency: are padding/margins using Tailwind scale consistently (e.g., `px-4`, `gap-6`) or arbitrary values?
- [ ] Font size consistency: is there a clear type scale, or are sizes scattered (`text-[10px]`, `text-[13px]`, `text-xs`, `text-sm`)?
- [ ] Responsive breakpoints: does every component work at mobile (<640px), tablet (640-1024px), and desktop (>1024px)?
- [ ] iOS safe area: are `pb-safe`, `pb-safe-nav`, `env(safe-area-inset-*)` applied correctly?
- [ ] Touch targets: all interactive elements >= 44x44px on mobile (WCAG 2.5.8)?
- [ ] Dark theme only: any accidental light-mode colors or poor contrast?
- [ ] Loading/empty/error states: does every page handle these three states?
- [ ] Animation consistency: is framer-motion used consistently, or are there mixed CSS transitions?
- [ ] Button styles: are all CTAs styled consistently (same radius, padding, font)?
- [ ] Accessibility: proper aria labels, keyboard navigation, screen reader support?

---

### 3. Website Performance

Identify performance bottlenecks, unnecessary re-renders, and bundle size issues.

**Files to focus on:**
- `src/components/PositionCard.tsx` — fetches live data per card, memoization
- `src/hooks/use*.ts` — query configurations, stale times
- `src/router.tsx` — lazy loading configuration
- `vite.config.ts` — build configuration, chunk splitting
- `src/pages/*.tsx` — data fetching patterns

**Check for:**
- [ ] Unnecessary re-renders: are expensive components wrapped in `React.memo` with correct comparators? (PositionCard has a custom memo — is it complete?)
- [ ] N+1 fetch problem: PositionCard fetches Greeks per card — is bulk fetching used? Are there waterfalls?
- [ ] React Query configuration: are `staleTime`, `gcTime`, `refetchInterval` appropriate? Any over-fetching?
- [ ] Bundle size: the main chunk is 550KB — what can be code-split or lazy loaded?
- [ ] Unused dependencies: any imported but unused packages inflating the bundle?
- [ ] Image optimization: are there any unoptimized images or SVGs?
- [ ] CSS performance: any expensive selectors, large utility classes, or unnecessary `@apply`?
- [ ] Supabase Realtime: are channel subscriptions cleaned up on unmount?
- [ ] Memory leaks: any `setInterval`, `setTimeout`, or event listeners not cleaned up?
- [ ] Large component files: PositionCard is 1030+ lines — should it be decomposed?

---

### 4. Code References (Dead/Broken)

Find dead imports, unused exports, stale references, and broken links.

**Check for:**
- [ ] Unused imports in every `.ts`/`.tsx` file
- [ ] Exported functions/types that are never imported elsewhere
- [ ] Dead code paths: unreachable conditions, commented-out blocks, `// TODO` items that are stale
- [ ] Stale route references: routes defined in `router.tsx` but no link/navigation points to them
- [ ] Environment variables referenced in code but not documented or not in `.env.example`
- [ ] Database columns referenced in code but potentially not in the schema (or vice versa)
- [ ] Stale type definitions: interfaces/types with fields that don't match the actual data shape
- [ ] API endpoints referenced in frontend that may not exist in `api/`
- [ ] Test files testing functions that no longer exist

---

### 5. Code Redundancy

Find duplicated logic, patterns that should be shared, and opportunities to DRY.

**Check for:**
- [ ] Transaction aggregation pattern: `totalQtyBought`, `totalCostBasis`, `avgPrice` is computed in at least 3 places (PositionCard, Portfolio, riskSizing) — should this be a shared utility?
- [ ] Price formatting: is `formatPrice()` used consistently, or are there inline `toFixed()` / template literal formats?
- [ ] Date formatting: is there one utility or multiple ad-hoc approaches?
- [ ] Supabase query patterns: raw `fetch()` in API routes vs `@supabase/supabase-js` client — is the split intentional and consistent?
- [ ] Position type checks: `isCreditStrategy` logic — is this computed the same way everywhere?
- [ ] Tab/route definitions: tabs are defined in both `TabNav.tsx` and `MobileTabBar.tsx` — should be a single source?
- [ ] Mutation hook patterns: are all 11+ mutation hooks following the same structure, or are some inconsistent?
- [ ] Greeks calculation: is net Greeks (short/long sign convention) computed in one place or duplicated?
- [ ] Strategy profiles: `strategyProfiles.ts` vs hardcoded strategy checks in components
- [ ] Error handling patterns: is there a consistent approach, or are some try/catch blocks missing while others are overly broad?

---

### 6. Security & Data Integrity

Review for vulnerabilities, data integrity issues, and unsafe patterns.

**Check for:**
- [ ] API route authentication: do all `api/*.js` routes verify the user's auth token? Any unauthenticated endpoints?
- [ ] SQL injection: any raw SQL in API routes or Supabase calls without parameterization?
- [ ] XSS: any `dangerouslySetInnerHTML` or unescaped user input rendered in JSX?
- [ ] Env var exposure: any server-side secrets (ORATS_API_TOKEN, SUPABASE_ANON_KEY) leaking to the client via `VITE_` prefix?
- [ ] CORS: are API routes properly configured for allowed origins?
- [ ] Rate limiting: are expensive API routes (scan-options, strategy-recommend) rate-limited?
- [ ] Input validation: are user inputs (prices, quantities, dates) validated before DB writes?
- [ ] Cron security: do cron endpoints (`cron-*.js`) verify `CRON_SECRET`?
- [ ] Supabase RLS: are Row Level Security policies enabled on all tables?
- [ ] Financial data integrity: are transactions immutable? Can a user modify historical trade data?
- [ ] Race conditions: concurrent position updates — could two "Size Up" actions create inconsistent state?

---

## Output Format

Organize findings as a prioritized table:

| # | Severity | Category | File:Line | Finding | Fix |
|---|----------|----------|-----------|---------|-----|

Then provide a summary with:
1. **Critical items** (must fix before next deploy)
2. **Quick wins** (low effort, high impact)
3. **Technical debt** (important but not urgent)
4. **Architecture recommendations** (longer-term improvements)
