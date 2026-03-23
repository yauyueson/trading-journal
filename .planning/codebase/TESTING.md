# Testing Patterns

**Analysis Date:** 2026-03-23

## Test Framework

**Runner:**
- Vitest 4.x
- Config: inline in `vite.config.ts` under `test:` key
- Environment: `jsdom`
- Setup file: `src/test/setup.ts` (imports `@testing-library/jest-dom`)

**Assertion Library:**
- Vitest built-in (Jest-compatible API)
- `@testing-library/jest-dom` matchers available (DOM-focused assertions)

**Run Commands:**
```bash
npm run test          # Run all tests once (vitest run --passWithNoTests)
npm run test:watch    # Watch mode (vitest)
```
No coverage command configured in package.json.

## Test File Organization

**Location:**
- Library/unit tests co-located under `src/lib/__tests__/`
- Integration/scenario tests in top-level `tests/` directory

**Naming:**
- All test files: `*.test.ts` (no `.spec.ts` files)

**Structure:**
```
tests/
  backtest-audit.test.ts       # Red-team audit — slippage, purge gap, Monte Carlo, O-U IV
  bsm-pricing.test.ts          # BSM price/delta/HV unit tests
  data-contract.test.ts        # Data contract regression tests
  migration-130m.test.ts       # 130M migration validation (38 tests across 9 groups)
  option-sim-analytics.test.ts # Option sim analytics tests
  option-sim-delta-stop.test.ts # Delta stop exit tests
  option-sim-fills.test.ts     # Bid/ask fills, ORATS filter tests
  portfolio-stress.test.ts     # Correlation stress, daily P&L matrix
  prerequisite-fixes.test.ts   # Prerequisite fix validation
  scoring-parity.test.ts       # ESM oss-core.ts ↔ CJS scoring.cjs parity (307 tests)
  slippage.test.ts             # Dynamic slippage model
  tech-analysis-parity.test.ts # Technical analysis indicator parity
  wfa-options.test.ts          # WFA rolling window engine
  wfa-v2.test.ts               # WFA v2 type tests
  wfa-v3.test.ts               # WFA v3 type tests

src/lib/__tests__/
  oss-core.test.ts             # Unit tests for individual scoring functions (48 tests)
  riskSizing.test.ts           # Position sizing, Kelly, portfolio Greeks (19 tests)
```

## Test Structure

**Suite Organization:**
```typescript
/**
 * Module Name Tests — Short description
 *
 * Tests for: specific things this file covers.
 */
import { describe, it, expect } from 'vitest';
import { functionUnderTest } from '../src/lib/module';

describe('functionName', () => {
  it('describes the expected behavior', () => {
    expect(functionUnderTest(input)).toBe(expectedOutput);
  });

  it('edge case description', () => {
    expect(functionUnderTest(edgeInput)).toBeCloseTo(expected, 5);
  });
});
```

**Patterns:**
- No `beforeEach`/`afterEach`/`beforeAll`/`afterAll` hooks used — each test is self-contained
- No mocking (`vi.mock`, `vi.fn`, `vi.spyOn`) used anywhere — all tests operate on real implementations
- Section headers within large test files use `// ─── Section Name ───` dividers

## Mocking

**Framework:** Not used.

All tests import and call real implementations directly. External dependencies (Supabase, ORATS, fetch) are never mocked. Tests are designed around pure functions and in-memory data structures, avoiding I/O entirely.

**What to Mock:** Nothing — the test suite avoids all I/O. If adding a test that requires Supabase or HTTP, design it as a pure function test instead.

**What NOT to Mock:**
- Scoring functions in `src/lib/oss-core.ts` — must be called directly
- BSM pricing in `src/lib/backtest/bsm-pricing.ts` — mathematical precision tests
- The CJS `lib/_shared/scoring.cjs` — parity tests require both real implementations

## Fixtures and Factories

**Test Data — stub factories:**
```typescript
// riskSizing.test.ts pattern: minimal object stubs cast as `any`
const singleLegPos = (overrides = {}) => ({
  id: '1', ticker: 'AAPL', type: 'Long Call', status: 'active',
  legs: [], expiration: '2026-04-18', ...overrides,
} as any);

const spreadPos = (overrides = {}) => ({
  id: '2', ticker: 'SPY', type: 'Credit Put Spread', status: 'active',
  legs: [
    { strike: 580, type: 'Put', side: 'short', expiration: '2026-04-18' },
    { strike: 575, type: 'Put', side: 'long', expiration: '2026-04-18' },
  ],
  ...overrides,
} as any);
```

**Test Data — const objects:**
```typescript
// slippage.test.ts pattern: typed config const reused across tests
const DEFAULT_CFG: DynamicSlippageConfig = {
  enabled: true,
  fillMode: 'bidask',
  baseImpactBps: 2,
  oiHalfLife: 500,
  dteAccelDays: 7,
  dteAccelMultiplier: 3.0,
};
```

**Test Data — helper functions:**
```typescript
// portfolio-stress.test.ts pattern: builder function returning full typed objects
function makeTrade(
  ticker: string, entryDate: string, exitDate: string, pnl: number,
  holdDays: number, maxLoss: number = 900,
): OptionTrade { ... }

// wfa-options.test.ts pattern: date generator
function generateTradingDates(startYear: number, years: number): string[] { ... }
```

**Location:** All fixtures are defined inline in each test file. No shared fixture files or factories.

## Coverage

**Requirements:** None enforced. No coverage thresholds configured in `vite.config.ts`.

**View Coverage:**
```bash
# Not configured in package.json scripts. Run directly:
npx vitest run --coverage
```

**Current test count:** 683 tests total across 18 files.

## Test Types

**Unit Tests (`src/lib/__tests__/`):**
- Scope: Individual exported functions from a single module
- Pattern: Known input → expected output for regression safety
- Example: `src/lib/__tests__/oss-core.test.ts` — 48 tests covering each scoring function

**Integration/Scenario Tests (`tests/`):**
- Scope: Multiple modules working together, algorithm correctness at higher abstraction
- Pattern: Test observable behavior of a subsystem, not internal state
- Example: `tests/scoring-parity.test.ts` — 307 tests ensuring ESM and CJS scoring produce bit-identical results across a matrix of input values

**Parity Tests (`tests/scoring-parity.test.ts`, `tests/tech-analysis-parity.test.ts`):**
- Special category: cross-format synchronization enforcement
- Import both `src/lib/oss-core.ts` (ESM) and `lib/_shared/scoring.cjs` (CommonJS) and compare output
- Use `toBeCloseTo(value, 10)` for floating-point (10 decimal places)
- Use `toEqual` for constant/config objects
- Matrix-driven: define input arrays, loop with `forEach` to generate one `it()` per input

**Audit Tests (`tests/backtest-audit.test.ts`):**
- Documents known invariants and regression points from red-team reviews
- Tests are labeled with issue numbers (`// ─── #3: Slippage Model`)

## Common Patterns

**Floating-point assertions:**
```typescript
// Use toBeCloseTo with explicit decimal precision
expect(ossCore.compressLambda(lambda)).toBeCloseTo(scoringCjs.compressLambda(lambda), 10);
expect(bsmPrice(S, K, T, sigma, r, true)).toBeCloseTo(parity, 4);
```

**Range assertions:**
```typescript
// For values with expected ranges rather than exact values
expect(price).toBeGreaterThan(2.50);
expect(price).toBeLessThan(2.80);
```

**Matrix-driven tests (loop generates test cases):**
```typescript
const testInputs = {
  lambdas: [0, 1, 5, 8, 10, 15, 20, 25, 50, 100],
  deltas: [-1, -0.7, -0.5, ...],
};

describe('compressLambda parity', () => {
  testInputs.lambdas.forEach(lambda => {
    it(`lambda=${lambda}`, () => {
      expect(ossCore.compressLambda(lambda)).toBeCloseTo(scoringCjs.compressLambda(lambda), 10);
    });
  });
});
```

**Async testing:**
```typescript
// wfa-options.test.ts uses async/await for functions returning Promises
it('runs full WFA pipeline', async () => {
  const result = await runWFAOptions(...);
  expect(result.windows.length).toBeGreaterThan(0);
});
```

**Error/edge case testing:**
```typescript
// Boundary conditions explicitly named in test description
it('zero/negative sigma → 0', () => {
  expect(bsmPrice(100, 100, 0.1, 0, 0.04, true)).toBe(0);
  expect(bsmPrice(100, 100, 0.1, -0.1, 0.04, true)).toBe(0);
});

it('returns null for zero loss', () => {
  expect(getKellyContracts(0, 100, 1000)).toBeNull();
});
```

## CI Integration

**Pipeline:** GitHub Actions (`.github/workflows/ci.yml`)

**Steps (sequential):**
1. `npm run lint` — ESLint with max 20 warnings
2. `npm run build` — TypeScript compile + Vite build
3. `npm run test` — Vitest run (all 683 tests must pass)

**Trigger:** All pushes and pull requests to any branch.

---

*Testing analysis: 2026-03-23*
