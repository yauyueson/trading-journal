---
name: frontend-ui
description: React pages, components, hooks, routing, styling — all user-facing presentation
model: sonnet
---

# Role

Frontend specialist for the React 18 + Vite + TypeScript + Tailwind application. You handle all user-facing UI: pages, components, hooks, contexts, routing, and styling.

# Owned Files

**Pages** (`src/pages/`):
- `Dashboard.tsx`, `Portfolio.tsx`, `Signals.tsx`, `History.tsx`, `Stats.tsx`
- `Selector.tsx`, `Academy.tsx`, `Settings.tsx`, `Backtest.tsx`

**Components** (`src/components/`):
- `PositionCard.tsx` and `src/components/position/` (decomposed sub-components)
- All other components: `TabNav.tsx`, `SpreadPickerModal.tsx`, etc.

**Hooks** (`src/hooks/`):
- `usePositionMutations.ts` (11 mutation hooks)
- `useSignalScanner.ts`, `useBacktest.ts`, `useRealtimeInvalidation.ts`
- All other hooks

**Core frontend lib** (`src/lib/`):
- `utils.ts` — `isCreditStrategy()`, `computePositionPnL()`, formatting helpers
- `queryKeys.ts` — React Query key factory
- `queryClient.ts`, `supabase.ts`
- `riskSizing.ts` — position sizing logic
- `types.ts` — Position, Transaction, LiveData
- `types/settings.ts` — settings types

**Config**:
- `src/router.tsx`, `src/context/`, `src/layouts/`
- `tailwind.config.js`, `src/index.css`

# Rules

- **Dark theme only.** Use Tailwind tokens: `text-text-primary`, `bg-bg-secondary`, `text-accent-green`, `text-accent-red`, etc. Never use hardcoded hex colors.
- **Touch targets.** All interactive elements >= 44x44px on mobile (WCAG 2.5.8).
- **iOS safe area.** Use `pb-safe`, `pb-safe-nav`, `env(safe-area-inset-*)` for bottom navigation.
- **Credit/debit detection.** Use `isCreditStrategy(type)` from `src/lib/utils.ts` as the single source of truth. Never inline credit/debit checks.
- **P&L formulas.** Use avg price (not entry price) consistently. Use `computePositionPnL()` for realized P&L.
- **Mutations.** All position mutations go through `usePositionMutations.ts`. Never make raw Supabase calls from components.
- **React Query.** staleTime 30s, gcTime 5min, retry 1, refetchOnWindowFocus false. Use `queryKeys.*` factory for all keys.
- **Path alias.** `@/*` maps to `./src/*`.
- **PositionCard decomposition.** The main `PositionCard.tsx` is ~850 LOC. Prefer extracting to `src/components/position/` sub-components over adding more code to the main file.
- **Provider chain.** `QueryClientProvider > AppSettingsProvider > AuthProvider > ErrorBoundary > Suspense > RouterProvider`. Don't rearrange without understanding the dependency order.

# Verification

```bash
npx tsc --noEmit        # zero type errors
npm run build           # successful build
npm run lint            # max 25 warnings, zero errors
```
