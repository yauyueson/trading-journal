# Coding Conventions

**Analysis Date:** 2026-03-14

## Naming Patterns

**Files:**
- React components: PascalCase `.tsx` (e.g., `PositionCard.tsx`, `LoadingSpinner.tsx`)
- Pages: PascalCase `.tsx` with `Page` or descriptive suffix (e.g., `Portfolio.tsx` exports `PortfolioPage`, `Backtest.tsx` exports `BacktestPage`)
- Hooks: camelCase prefixed with `use` (e.g., `usePositions.ts`, `usePositionMutations.ts`)
- Utility/lib modules: camelCase (e.g., `riskSizing.ts`, `oss-core.ts`, `queryKeys.ts`)
- Test files: `*.test.ts` or `*.test.tsx`

**Functions:**
- Pure utility functions: camelCase (e.g., `formatCurrency`, `formatDate`, `computePositionPnL`)
- React components: PascalCase const with `React.FC<Props>` type annotation
- Hook factories: camelCase `use` prefix (e.g., `usePositionAction`, `useUpdateScore`)
- Math/scoring functions: camelCase descriptive verbs (e.g., `compressLambda`, `getThetaPenalty`, `getDeltaBonus`)
- Local helpers inside a file: camelCase (e.g., `normalizeExpiration`, `useInvalidatePositionsAndTransactions`)

**Variables:**
- camelCase throughout
- Constants exported from modules: SCREAMING_SNAKE_CASE (e.g., `HARD_FILTER_DEFAULTS`, `MIN_BUCKET_SIZE`, `STOP_OUT_PCT`)
- Boolean flags: `is` or `has` prefix (e.g., `isDayTrade`, `isLoading`, `hasUpcomingEarnings`)

**Types / Interfaces:**
- `interface` for object shapes (e.g., `Position`, `Transaction`, `PositionLeg`)
- `type` for unions and aliases (e.g., `Strategy = 'long' | 'short'`, `StrategyCategory`, `Recommendation`)
- Props interfaces named `<ComponentName>Props` (e.g., `PositionCardProps`, `ScannerPageProps`)
- All shared domain types centralized in `src/lib/types.ts`

## Component Patterns

**Declaration style:** Named const with explicit `React.FC<Props>` typing:
```tsx
export const PositionCard: React.FC<PositionCardProps> = (props) => { ... };
```

**Props pattern:** Props interfaces declared immediately above the component. Pages accept optional prop overrides that fall back to React Query hooks:
```tsx
// Page receives optional props for testing/overrides, falls back to hooks
const { data: positionsQuery = [] } = usePositions();
const positions = props.positions ?? positionsQuery;
```

**Mutations:** Each mutation from `usePositionMutations.ts` is instantiated at the call site, never passed as raw Supabase calls:
```tsx
const updateScoreMut = useUpdateScore();
// ...
await updateScoreMut.mutateAsync({ id, score });
```

## Code Style

**Formatting:**
- No Prettier config present — formatting is not enforced by tooling
- 4-space indentation in `src/` TypeScript/TSX files
- 2-space indentation in `tests/` directory files

**Linting:**
- ESLint 9 with `@typescript-eslint` recommended rules
- Config: `eslint.config.js`
- `@typescript-eslint/no-explicit-any`: off (any is permitted)
- `@typescript-eslint/no-unused-vars`: warn (args prefixed `_` are ignored)
- `react-hooks/rules-of-hooks`: error
- `react-hooks/exhaustive-deps`: warn
- `no-console`: off (console allowed everywhere)
- Lint scope: `src/` only (api/, lib/, *.cjs excluded)
- Max warnings threshold: 20 (`npm run lint -- --max-warnings 20`)

## Import Organization

**Order (observed pattern — not enforced by tooling):**
1. React and third-party libraries (`react`, `lucide-react`, `@tanstack/react-query`)
2. Type-only imports from `../lib/types`
3. Local components (`../components/...`)
4. Context imports (`../context/...`)
5. Local lib utilities (`../lib/...`)
6. Local hooks (`../hooks/...`)

**Example from `src/pages/Portfolio.tsx`:**
```ts
import React, { useState, useEffect, useMemo } from 'react';
import { RefreshCw, ChevronDown } from 'lucide-react';
import { Position, Transaction } from '../lib/types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { useAppSettings } from '../context/AppSettingsContext';
import { formatCurrency } from '../lib/utils';
import { usePositions } from '../hooks/usePositions';
```

**Path Aliases:**
- `@` resolves to `./src` (configured in `vite.config.ts` via `resolve.alias`)
- In practice, relative paths (`../lib/`, `../hooks/`) are used throughout — `@` alias is not commonly used

## Error Handling

**Supabase queries:** Destructure `{ data, error }` and throw on error:
```ts
const { data, error } = await supabase.from('positions').select('*');
if (error) throw error;
return (data ?? []) as Position[];
```

**React Query mutations:** Errors bubble to mutation state; no explicit try/catch in mutationFns unless cleanup is needed.

**API route handlers (api/*.js):** Use try/catch with `res.status(500).json({ error })` pattern.

**Defensive returns:** `data ?? []` and `data ?? {}` patterns used for nullable query results. Numeric formatting guards with `isNaN` checks in `src/lib/utils.ts`.

## Logging

**Framework:** `console` (native, no wrapper)

**Patterns:**
- `console.error(...)` for Supabase errors and API failures
- `console.log(...)` for debug tracing in hooks/components (not cleaned up — `no-console` is off)
- API routes use `console.error` with tagged prefixes like `[vite-shim]`, `❌ CBOE API Error [${ticker}]`
- No structured logging or log levels

## Comments

**Module-level:** JSDoc block at top of key lib files explaining purpose and sync requirements:
```ts
/**
 * OSS Core - Options Scoring System v2.3
 * ═══════════════════════════════════
 * SINGLE SOURCE OF TRUTH for all scoring algorithms.
 * ...
 * DO NOT duplicate these functions elsewhere.
 */
```

**Section dividers:** Used in `src/lib/oss-core.ts` and test files:
```ts
// ────────────────────────────────────────────────────────────────
// Section Name
// ────────────────────────────────────────────────────────────────
```

**JSDoc on exported functions:** Used consistently in `src/lib/backtest/bsm-pricing.ts` with `@param` and `@returns` tags. Used selectively elsewhere (not universally enforced).

**Inline comments:** Explain non-obvious math and business logic. Warnings for critical sync invariants marked with `⚠️` or `DO NOT`.

## TypeScript Usage

**`as const`:** Used for readonly tuples and config objects (e.g., `queryKeys.positions = ['positions'] as const`). Observed 36 usages across `src/lib/`.

**`as any`:** Permitted (rule is off). Used in test stubs (`as any`) and API handlers for untyped external data.

**Type imports:** `import type { ... }` used for type-only imports in test files and some modules.

**Generics:** Used in React Query hooks (`useQuery<T>`) via inference rather than explicit annotation.

## Module Design

**Exports:**
- Named exports throughout — no default exports for library modules
- Pages and components use named exports (`export const PortfolioPage`)
- No barrel `index.ts` files — import directly from the file

**Dual-format scoring module:** `src/lib/oss-core.ts` (ESM TypeScript) is mirrored by `lib/_shared/scoring.cjs` (CommonJS). Both must be kept in sync. Any scoring change requires updating both files and running the 307 parity tests.

---

*Convention analysis: 2026-03-14*
