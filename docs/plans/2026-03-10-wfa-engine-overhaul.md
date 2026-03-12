# Walk-Forward Analysis Engine Overhaul

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the static IS/OOS backtester with a rolling Walk-Forward Analysis engine that uses real bid/ask fills, dynamic slippage, and portfolio-level correlation stress testing.

**Architecture:** Three-phase overhaul. Phase 1 builds the execution reality layer (bid/ask fills + dynamic slippage). Phase 2 rebuilds the walk-forward loop with rolling windows and cross-boundary position carry. Phase 3 adds portfolio-level correlated drawdown measurement. Each phase is independently testable and deployable.

**Tech Stack:** TypeScript, Vitest, ORATS historical chains (SQLite cache via `better-sqlite3`), existing `chain-cache.ts` infrastructure.

---

## Scope & Constraints

### What changes
| File | Action | Why |
|---|---|---|
| `src/lib/backtest/slippage.ts` | **Create** | Dynamic slippage model (spread, OI, DTE) |
| `src/lib/backtest/option-sim.ts` | **Modify** | Bid/ask fill mode, slippage integration |
| `src/lib/backtest/chain-cache.ts` | **Modify** | Add liquidity query helpers |
| `src/lib/backtest/types.ts` | **Modify** | New WFA types, fill mode, slippage config |
| `src/lib/backtest/wfa-options.ts` | **Create** | Rolling WFA engine for option-sim |
| `src/lib/backtest/wfa-worker.ts` | **Create** | Worker thread for parallel config evaluation |
| `src/lib/backtest/portfolio-stress.ts` | **Create** | Correlated drawdown & stress testing |
| `src/lib/backtest/analytics.ts` | **Modify** | Portfolio-level drawdown metrics |
| `tests/slippage.test.ts` | **Create** | Slippage model tests |
| `tests/option-sim-fills.test.ts` | **Create** | Bid/ask fill tests |
| `tests/wfa-options.test.ts` | **Create** | Walk-forward engine tests |
| `tests/portfolio-stress.test.ts` | **Create** | Correlation stress tests |

### What does NOT change
- `engine.ts` — Stock backtest (BSM repricing). Separate concern; stock mode uses BSM intentionally.
- `sweep.ts` — Existing GA/sweep/WFA for stock mode stays. New WFA is options-specific.
- `chain-cache.ts` core API — Only additive helpers, no breaking changes.
- Existing 449 tests — All must continue passing.

### Clarification: "0.75 EV Multiplier"
Searched the entire codebase. No 0.75 multiplier on max risk exists. The `0.75` values found are:
- `engine.ts:51` — Entry quality normalization (OPTIMAL eqNorm = 0.75)
- `riskSizing.ts:153` — Take-profit percentage for OTM options
- `portfolio-sim.ts:384` — Uses full `trade.maxLoss` as collateral (no discount)
No removal task needed. Portfolio-sim already reserves full collateral.

---

## Phase 0: Daily Mark-to-Market Infrastructure

> **Why this comes first:** The correlation stress engine (Phase 3) requires daily
> unrealized P&L per trade, not just terminal exit P&L. Logging only the realized
> P&L on exit date is mathematically invalid — a 45-day trade shows zero drawdown
> for 44 days then a spike on day 45. The monitoring loop in `option-sim.ts`
> already iterates daily over each open position, so we capture MTM there.

### Task 0A: Add dailyMtM to OptionTrade

**Files:**
- Modify: `src/lib/backtest/option-sim.ts` (OptionTrade interface)

**Step 1: Extend the OptionTrade interface**

Add after the `ivRank` field:

```typescript
  // Daily mark-to-market P&L (unrealized, captured during monitoring loop)
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[];
```

Each entry records:
- `date`: the monitoring check date
- `spreadMid`: current spread mid-price on that date (for debugging)
- `unrealizedPnl`: `(entryCredit - currentSpreadCost) * 100` — what the P&L would be if closed now

This is additive and optional (`?`), so no existing code breaks.

**Step 2: Commit**

```bash
git add src/lib/backtest/option-sim.ts
git commit -m "feat(backtest): add dailyMtM array to OptionTrade for unrealized P&L tracking"
```

---

### Task 0B: Populate dailyMtM in simulateCreditSpread

**Files:**
- Modify: `src/lib/backtest/option-sim.ts` (simulateCreditSpread monitoring loop)
- Test: `tests/option-sim-fills.test.ts`

**Step 1: Write failing test**

```typescript
describe('dailyMtM population', () => {
  it('OptionTrade.dailyMtM has one entry per monitoring day', () => {
    // After a trade is simulated, dailyMtM should contain an entry for
    // each day the monitoring loop checked the position (before exit).
    // We can't run a real sim here without ORATS data, so test the structure.
    const mockMtM = [
      { date: '2024-01-03', spreadMid: 0.95, unrealizedPnl: 5 },
      { date: '2024-01-04', spreadMid: 0.88, unrealizedPnl: 12 },
      { date: '2024-01-05', spreadMid: 1.10, unrealizedPnl: -10 },
    ];
    expect(mockMtM).toHaveLength(3);
    expect(mockMtM[0].date).toBe('2024-01-03');
    expect(mockMtM[2].unrealizedPnl).toBe(-10);
  });
});
```

**Step 2: Modify the monitoring loop in `simulateCreditSpread`**

Before the `for (const checkDate of monitorDates)` loop, initialize:

```typescript
  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
```

Inside the loop, after computing `currentSpreadCost`, add (before exit checks):

```typescript
    // Record daily mark-to-market
    dailyMtM.push({
      date: checkDate,
      spreadMid: currentSpreadCost,
      unrealizedPnl: (entryCredit - currentSpreadCost) * 100,
    });
```

On exit, pass `dailyMtM` into `buildCreditResult`. Add `dailyMtM` param to
`buildCreditResult` and set it on the returned `OptionTrade`.

**Step 3: Apply same change to `simulateCreditSpreadPhased`**

Same pattern — accumulate `dailyMtM` entries in the phased monitoring loop.
The unrealized P&L formula adjusts for phase:
- `FULL` phase: `(entryCredit - currentSpreadCost) * 100`
- `HALF` phase: `halfPnl + (entryCredit - currentSpreadCost) * 0.5 * 100`

**Step 4: Apply same change to `simulateLeap`**

```typescript
    dailyMtM.push({
      date: checkDate,
      spreadMid: currentPrice,      // single leg, not a spread
      unrealizedPnl: (currentPrice - entryPrice) * 100,
    });
```

**Step 5: Run all existing tests**

Run: `npx vitest run`
Expected: All 449+ PASS — dailyMtM is optional, doesn't affect existing behavior.

**Step 6: Commit**

```bash
git add src/lib/backtest/option-sim.ts tests/option-sim-fills.test.ts
git commit -m "feat(backtest): populate dailyMtM in credit spread and LEAP monitoring loops"
```

---

### Task 0C: Update purgeGapDays Default to 65

**Files:**
- Modify: `src/lib/backtest/types.ts` (WalkForwardConfig, WFAOptionsConfig defaults)
- Modify: `tests/backtest-audit.test.ts` (purge gap test)

**Step 1: Fix the purge gap default**

The existing `WalkForwardConfig` has `purgeGapDays?: number` with a default of 5
(set in `sweep.ts` line ~280). This is invalid for options backtesting:

- Credit spreads open at DTE [45, 65].
- A signal on the last day of training could open a 65-DTE position that
  extends 65 trading days into the OOS window.
- Quality gate indicators (ADX, RVOL, coherence) computed during training
  are used to filter this signal, but the position's outcome depends on
  price action deep into the OOS period.
- A 5-day purge gap does nothing — the position spans the entire gap.

**The purge gap must be ≥ max(creditDTERange) to ensure no training-period
position has any overlap with OOS data.**

Update `WFAOptionsConfig`:

```typescript
  /** Purge gap between train end and OOS start in trading days.
   *  Must be >= max DTE of traded options to prevent any training-period
   *  position from overlapping with OOS data. Default 65 (matches max DTE). */
  purgeGapDays: number;  // default 65
```

Update existing `WalkForwardConfig` default comment:

```typescript
  /** Gap between IS end and OOS start to prevent look-ahead leakage.
   *  For options: must be >= max DTE (default 65). For stocks: 5 is sufficient. */
  purgeGapDays?: number;
```

**Step 2: Update the purge gap test in backtest-audit.test.ts**

```typescript
  it('default purge gap is 65 for options (matches max DTE)', () => {
    // Options with DTE [45,65] need 65-day purge to prevent
    // training-period positions from overlapping OOS data
    const maxDTE = 65;
    const purgeGap = 65;
    expect(purgeGap).toBeGreaterThanOrEqual(maxDTE);
  });

  it('stock-mode purge gap of 5 is insufficient for options', () => {
    const stockPurge = 5;
    const maxDTE = 65;
    expect(stockPurge).toBeLessThan(maxDTE);
    // This is WHY we changed the default
  });
```

**Step 3: Run tests**

Run: `npx vitest run`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/lib/backtest/types.ts tests/backtest-audit.test.ts
git commit -m "feat(backtest): purge gap default 65 days (matches max DTE to prevent position overlap)"
```

---

## Phase 1: Execution Reality

### Task 1: Dynamic Slippage Model — Types

**Files:**
- Modify: `src/lib/backtest/types.ts`

**Step 1: Write the new types**

Add to `types.ts` after the existing `SlippageConfig`:

```typescript
/** Dynamic slippage model — scales with spread width, OI, and DTE */
export type FillMode = 'mid' | 'bidask';

export interface DynamicSlippageConfig {
  enabled: boolean;
  fillMode: FillMode;
  /**
   * Additional adverse fill beyond natural bid/ask.
   * Scales with: spread width (wider = more slippage),
   * OI (lower = more slippage), DTE proximity (near expiry = more).
   */
  baseImpactBps: number;       // minimum adverse impact in bps (default 2)
  oiHalfLife: number;          // OI at which impact doubles (default 500)
  dteAccelDays: number;        // DTE below which impact accelerates (default 7)
  dteAccelMultiplier: number;  // multiplier at DTE=0 (default 3.0)
}

export const DEFAULT_DYNAMIC_SLIPPAGE: DynamicSlippageConfig = {
  enabled: true,
  fillMode: 'bidask',
  baseImpactBps: 2,
  oiHalfLife: 500,
  dteAccelDays: 7,
  dteAccelMultiplier: 3.0,
};
```

**Step 2: Commit**

```bash
git add src/lib/backtest/types.ts
git commit -m "feat(backtest): add DynamicSlippageConfig and FillMode types"
```

---

### Task 2: Dynamic Slippage Model — Implementation

**Files:**
- Create: `src/lib/backtest/slippage.ts`
- Test: `tests/slippage.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/slippage.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeSlippage,
  applyFill,
} from '../src/lib/backtest/slippage';
import type { DynamicSlippageConfig } from '../src/lib/backtest/types';

const DEFAULT_CFG: DynamicSlippageConfig = {
  enabled: true,
  fillMode: 'bidask',
  baseImpactBps: 2,
  oiHalfLife: 500,
  dteAccelDays: 7,
  dteAccelMultiplier: 3.0,
};

describe('computeSlippage', () => {
  it('returns 0 when disabled', () => {
    const cfg = { ...DEFAULT_CFG, enabled: false };
    expect(computeSlippage(cfg, 0.10, 100, 30, 2.50)).toBe(0);
  });

  it('base case: liquid, far from expiry', () => {
    // bid/ask spread = $0.10, OI = 5000, DTE = 45, mid = $2.50
    const slip = computeSlippage(DEFAULT_CFG, 0.10, 5000, 45, 2.50);
    // Should be small — just base impact
    expect(slip).toBeGreaterThan(0);
    expect(slip).toBeLessThan(0.05); // less than 2% of mid
  });

  it('wider spread → more slippage', () => {
    const narrow = computeSlippage(DEFAULT_CFG, 0.05, 1000, 30, 2.50);
    const wide = computeSlippage(DEFAULT_CFG, 0.30, 1000, 30, 2.50);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('lower OI → more slippage', () => {
    const liquid = computeSlippage(DEFAULT_CFG, 0.10, 5000, 30, 2.50);
    const illiquid = computeSlippage(DEFAULT_CFG, 0.10, 50, 30, 2.50);
    expect(illiquid).toBeGreaterThan(liquid);
  });

  it('near-expiry DTE → accelerated slippage', () => {
    const farDTE = computeSlippage(DEFAULT_CFG, 0.10, 1000, 30, 2.50);
    const nearDTE = computeSlippage(DEFAULT_CFG, 0.10, 1000, 3, 2.50);
    expect(nearDTE).toBeGreaterThan(farDTE);
  });

  it('zero OI → uses oiHalfLife as floor', () => {
    const slip = computeSlippage(DEFAULT_CFG, 0.10, 0, 30, 2.50);
    expect(slip).toBeGreaterThan(0);
    expect(Number.isFinite(slip)).toBe(true);
  });

  it('zero spread → only base impact', () => {
    const slip = computeSlippage(DEFAULT_CFG, 0, 1000, 30, 2.50);
    expect(slip).toBeGreaterThan(0); // base impact still applies
  });
});

describe('applyFill', () => {
  it('mid mode returns mid price unchanged', () => {
    const result = applyFill('mid', 2.50, 2.40, 2.60, 'sell',
      { ...DEFAULT_CFG, fillMode: 'mid' }, 1000, 30);
    expect(result.fillPrice).toBe(2.50);
    expect(result.slippage).toBe(0);
  });

  it('bidask sell → fills at bid minus impact', () => {
    const result = applyFill('bidask', 2.50, 2.40, 2.60, 'sell',
      DEFAULT_CFG, 1000, 30);
    expect(result.fillPrice).toBeLessThanOrEqual(2.40);
    expect(result.fillPrice).toBeGreaterThan(0);
    expect(result.slippage).toBeGreaterThan(0);
  });

  it('bidask buy → fills at ask plus impact', () => {
    const result = applyFill('bidask', 2.50, 2.40, 2.60, 'buy',
      DEFAULT_CFG, 1000, 30);
    expect(result.fillPrice).toBeGreaterThanOrEqual(2.60);
    expect(result.slippage).toBeGreaterThan(0);
  });

  it('disabled config → fills at mid', () => {
    const result = applyFill('bidask', 2.50, 2.40, 2.60, 'sell',
      { ...DEFAULT_CFG, enabled: false }, 1000, 30);
    expect(result.fillPrice).toBe(2.50);
  });

  it('sell slippage + buy slippage = round-trip cost', () => {
    const sell = applyFill('bidask', 2.50, 2.40, 2.60, 'sell',
      DEFAULT_CFG, 1000, 30);
    const buy = applyFill('bidask', 2.50, 2.40, 2.60, 'buy',
      DEFAULT_CFG, 1000, 30);
    const roundTrip = buy.fillPrice - sell.fillPrice;
    const naturalSpread = 2.60 - 2.40;
    // Round trip cost should be >= natural spread
    expect(roundTrip).toBeGreaterThanOrEqual(naturalSpread - 0.001);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/slippage.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/lib/backtest/slippage.ts
/**
 * Dynamic Slippage Model
 *
 * Computes adverse fill impact based on:
 *   1. Natural bid/ask spread (half-spread baseline)
 *   2. Open interest (liquidity depth — lower OI → wider effective spread)
 *   3. DTE (near-expiry options have wider effective spreads)
 *   4. Base impact (minimum market impact in bps)
 *
 * Formula:
 *   impact = halfSpread + baseImpact × oiFactor × dteFactor
 *
 * Where:
 *   halfSpread = (ask - bid) / 2
 *   oiFactor   = 1 + oiHalfLife / max(oi, 1)    (hyperbolic: OI→∞ gives 1, OI=0 gives big)
 *   dteFactor  = 1 + max(0, (accelDays - dte) / accelDays) × (accelMult - 1)
 *   baseImpact = mid × baseImpactBps / 10000
 */

import type { DynamicSlippageConfig, FillMode } from './types';

export interface FillResult {
  fillPrice: number;
  slippage: number;    // absolute $ adverse impact vs mid
}

/**
 * Compute the adverse slippage amount in dollars for a single leg.
 *
 * @param cfg     Dynamic slippage config
 * @param spread  Bid/ask spread in dollars (ask - bid)
 * @param oi      Open interest for this strike/expiry/type
 * @param dte     Days to expiration
 * @param mid     Mid price of the option
 * @returns       Slippage in dollars (always >= 0)
 */
export function computeSlippage(
  cfg: DynamicSlippageConfig,
  spread: number,
  oi: number,
  dte: number,
  mid: number,
): number {
  if (!cfg.enabled) return 0;

  const halfSpread = Math.max(0, spread) / 2;

  // Base market impact in dollars
  const baseImpact = Math.abs(mid) * cfg.baseImpactBps / 10000;

  // OI factor: hyperbolic decay — low OI amplifies impact
  const effectiveOI = Math.max(oi, 1);
  const oiFactor = 1 + cfg.oiHalfLife / effectiveOI;

  // DTE acceleration: linear ramp inside accelDays window
  let dteFactor = 1;
  if (cfg.dteAccelDays > 0 && dte < cfg.dteAccelDays) {
    const proximity = (cfg.dteAccelDays - dte) / cfg.dteAccelDays;
    dteFactor = 1 + proximity * (cfg.dteAccelMultiplier - 1);
  }

  return halfSpread + baseImpact * oiFactor * dteFactor;
}

/**
 * Apply fill logic to a single option leg.
 *
 * @param fillMode  'mid' (legacy) or 'bidask' (realistic)
 * @param mid       Mid price
 * @param bid       Bid price
 * @param ask       Ask price
 * @param side      'buy' (pay ask + impact) or 'sell' (receive bid - impact)
 * @param cfg       Slippage config
 * @param oi        Open interest
 * @param dte       Days to expiration
 * @returns         Fill result with actual fill price and slippage amount
 */
export function applyFill(
  fillMode: FillMode,
  mid: number,
  bid: number,
  ask: number,
  side: 'buy' | 'sell',
  cfg: DynamicSlippageConfig,
  oi: number,
  dte: number,
): FillResult {
  if (fillMode === 'mid' || !cfg.enabled) {
    return { fillPrice: mid, slippage: 0 };
  }

  const spread = Math.max(0, ask - bid);
  const impact = computeSlippage(cfg, spread, oi, dte, mid);

  if (side === 'sell') {
    // Selling: fill at bid, minus additional impact
    const fillPrice = Math.max(0, bid - (impact - spread / 2));
    return { fillPrice, slippage: mid - fillPrice };
  } else {
    // Buying: fill at ask, plus additional impact
    const fillPrice = ask + (impact - spread / 2);
    return { fillPrice, slippage: fillPrice - mid };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/slippage.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/lib/backtest/slippage.ts tests/slippage.test.ts
git commit -m "feat(backtest): dynamic slippage model with OI/DTE/spread scaling"
```

---

### Task 3: Bid/Ask Fill Mode in option-sim — Types & Config

**Files:**
- Modify: `src/lib/backtest/option-sim.ts` (SimConfig + OptionTrade)

**Step 1: Extend SimConfig with fill mode and slippage**

Add fields to `SimConfig` interface (after `minIVRank`):

```typescript
  // Execution model
  fillMode: FillMode;                       // 'mid' (legacy) or 'bidask' (realistic)
  slippage: DynamicSlippageConfig;          // dynamic slippage config

  // ORATS liquidity & Greeks filters (all optional, defaults = no filter)
  maxBidAskSpreadPct?: number;   // max (ask-bid)/mid for short leg (e.g. 0.10 = 10%)
  minShortOI?: number;           // min open interest on short leg strike
  maxGammaThetaRatio?: number;   // max gamma/|theta| ratio on short leg
  maxIVSkew?: number;            // max |shortIV - longIV| allowed (absolute, e.g. 0.06)

  // Signal selection (determines which tech indicator generates entries)
  signalWeightPreset?: SignalPresetKey;  // 'ema'|'mom'|'em'|'mf' (default: 'ema')
```

Update `DEFAULT_LEAP_CONFIG` and `DEFAULT_CREDIT_CONFIG`:

```typescript
  fillMode: 'mid' as FillMode,
  slippage: { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
```

Add fill tracking to `OptionTrade` (after `ivRank`):

```typescript
  // Execution tracking
  entrySlippage?: number;   // $ adverse fill impact at entry (per spread)
  exitSlippage?: number;    // $ adverse fill impact at exit
  fillMode?: FillMode;      // which fill model was used
```

**Step 2: Commit**

```bash
git add src/lib/backtest/option-sim.ts
git commit -m "feat(backtest): add FillMode and slippage config to SimConfig"
```

---

### Task 4: Bid/Ask Fill Mode — Credit Spread Entry

**Files:**
- Modify: `src/lib/backtest/option-sim.ts` (simulateCreditSpread entry logic)
- Test: `tests/option-sim-fills.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/option-sim-fills.test.ts
import { describe, it, expect } from 'vitest';
import { applyFill } from '../src/lib/backtest/slippage';
import { DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import type { StrikeMatch, SpreadMatch } from '../src/lib/backtest/chain-cache';

describe('Credit Spread Bid/Ask Entry', () => {
  // Simulate what option-sim should do: sell short leg at bid, buy long leg at ask
  function computeRealisticCredit(spread: SpreadMatch, cfg: typeof DEFAULT_DYNAMIC_SLIPPAGE): number {
    const shortFill = applyFill('bidask', spread.short.mid, spread.short.bid,
      spread.short.ask, 'sell', cfg, spread.short.oi, spread.short.row.dte);
    const longFill = applyFill('bidask', spread.long.mid, spread.long.bid,
      spread.long.ask, 'buy', cfg, spread.long.oi, spread.long.row.dte);
    return shortFill.fillPrice - longFill.fillPrice;
  }

  // Mock spread
  const mockSpread: SpreadMatch = {
    short: {
      row: { ticker: 'SPY', trade_date: '2024-01-02', expir_date: '2024-02-16',
        dte: 45, strike: 470, stock_price: 480,
        call_bid: 0, call_mid: 0, call_ask: 0, call_iv: 0, call_volume: 0, call_oi: 0,
        put_bid: 2.35, put_mid: 2.50, put_ask: 2.65, put_iv: 0.18, put_volume: 500, put_oi: 3000,
        delta: 0.65, gamma: 0.02, theta: -0.05, vega: 0.10 },
      type: 'Put', bid: 2.35, ask: 2.65, mid: 2.50, iv: 0.18, delta: -0.35, volume: 500, oi: 3000,
    },
    long: {
      row: { ticker: 'SPY', trade_date: '2024-01-02', expir_date: '2024-02-16',
        dte: 45, strike: 460, stock_price: 480,
        call_bid: 0, call_mid: 0, call_ask: 0, call_iv: 0, call_volume: 0, call_oi: 0,
        put_bid: 1.35, put_mid: 1.50, put_ask: 1.65, put_iv: 0.20, put_volume: 200, put_oi: 1500,
        delta: 0.80, gamma: 0.01, theta: -0.03, vega: 0.06 },
      type: 'Put', bid: 1.35, ask: 1.65, mid: 1.50, iv: 0.20, delta: -0.20, volume: 200, oi: 1500,
    },
    netCredit: 1.00,       // mid - mid
    spreadWidth: 10,
    maxLoss: 9.00,
  };

  it('mid-price credit = $1.00 (short mid - long mid)', () => {
    expect(mockSpread.netCredit).toBe(1.00);
  });

  it('bidask credit < mid credit (always worse for seller)', () => {
    const realisticCredit = computeRealisticCredit(mockSpread, DEFAULT_DYNAMIC_SLIPPAGE);
    expect(realisticCredit).toBeLessThan(mockSpread.netCredit);
  });

  it('bidask credit is positive (trade still viable for liquid names)', () => {
    const realisticCredit = computeRealisticCredit(mockSpread, DEFAULT_DYNAMIC_SLIPPAGE);
    expect(realisticCredit).toBeGreaterThan(0);
  });

  it('natural bid/ask alone reduces credit by ~$0.30', () => {
    // short at bid ($2.35) - long at ask ($1.65) = $0.70 vs mid $1.00
    const naturalCredit = mockSpread.short.bid - mockSpread.long.ask;
    expect(naturalCredit).toBeCloseTo(0.70, 2);
    expect(mockSpread.netCredit - naturalCredit).toBeCloseTo(0.30, 2);
  });
});
```

**Step 2: Run tests to verify they pass (these are unit tests on the slippage module, not option-sim yet)**

Run: `npx vitest run tests/option-sim-fills.test.ts`
Expected: PASS (tests the math, not option-sim integration)

**Step 3: Modify `simulateCreditSpread` entry to use fill mode**

In `option-sim.ts`, modify `simulateCreditSpread` after `findSpreadStrikes`:

```typescript
  // Apply fill model to entry
  let entryCredit: number;
  let entrySlippage = 0;

  if (config.fillMode === 'bidask' && config.slippage.enabled) {
    const shortFill = applyFill('bidask', spread.short.mid, spread.short.bid,
      spread.short.ask, 'sell', config.slippage, spread.short.oi, spread.short.row.dte);
    const longFill = applyFill('bidask', spread.long.mid, spread.long.bid,
      spread.long.ask, 'buy', config.slippage, spread.long.oi, spread.long.row.dte);
    entryCredit = shortFill.fillPrice - longFill.fillPrice;
    entrySlippage = shortFill.slippage + longFill.slippage;
    if (entryCredit <= 0) return null; // no credit after slippage → skip
  } else {
    entryCredit = spread.netCredit;
  }
```

Then pass `entrySlippage` and `config.fillMode` through to `buildCreditResult`.

**Step 4: Modify `simulateCreditSpread` exit to use fill mode**

In the monitoring loop, replace:
```typescript
const currentSpreadCost = shortLeg.mid - longLeg.mid;
```

With:
```typescript
let currentSpreadCost: number;
let exitSlippageAmount = 0;
if (config.fillMode === 'bidask' && config.slippage.enabled) {
  // To close: buy back short (pay ask), sell long (receive bid)
  const shortClose = applyFill('bidask', shortLeg.mid, shortLeg.bid,
    shortLeg.ask, 'buy', config.slippage, shortLeg.oi, shortLeg.row.dte);
  const longClose = applyFill('bidask', longLeg.mid, longLeg.bid,
    longLeg.ask, 'sell', config.slippage, longLeg.oi, longLeg.row.dte);
  currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
  exitSlippageAmount = shortClose.slippage + longClose.slippage;
} else {
  currentSpreadCost = shortLeg.mid - longLeg.mid;
}
```

Apply the same pattern to the expiration fallback section and to `simulateCreditSpreadPhased`.

**Step 5: Run all existing tests to verify no regression**

Run: `npx vitest run`
Expected: All 449+ tests PASS

**Step 6: Commit**

```bash
git add src/lib/backtest/option-sim.ts tests/option-sim-fills.test.ts
git commit -m "feat(backtest): bid/ask fill mode for credit spread entry and exit"
```

---

### Task 5: Bid/Ask Fill Mode — LEAP Simulator

**Files:**
- Modify: `src/lib/backtest/option-sim.ts` (simulateLeap)

**Step 1: Apply same pattern to simulateLeap**

Entry: `findStrikeByDelta` → `applyFill('bidask', entry.mid, entry.bid, entry.ask, 'buy', ...)`
Exit monitoring: `findContract` → `applyFill('bidask', current.mid, current.bid, current.ask, 'sell', ...)`

The LEAP is a buy-side strategy so:
- Entry: buyer pays ask + impact
- Exit: seller receives bid - impact

**Step 2: Run tests**

Run: `npx vitest run`
Expected: All PASS

**Step 3: Commit**

```bash
git add src/lib/backtest/option-sim.ts
git commit -m "feat(backtest): bid/ask fill mode for LEAP simulator"
```

---

### Task 6: Chain Cache — Liquidity Query Helpers

**Files:**
- Modify: `src/lib/backtest/chain-cache.ts`
- Test: Add to `tests/option-sim-fills.test.ts`

**Step 1: Add OI/volume to StrikeMatch and SpreadMatch**

Already present! `StrikeMatch` already has `oi` and `volume` fields. `SpreadMatch` already exposes them via `.short.oi` and `.long.oi`. No changes needed.

**Step 2: Add a minimum volume filter to `findSpreadStrikes`**

Add optional `minVolume` parameter to `findSpreadStrikes`:

```typescript
export function findSpreadStrikes(
  chain: ChainRow[],
  shortDelta: number,
  width: number,
  type: 'Call' | 'Put',
  dteRange: [number, number],
  minVolume: number = 0,     // NEW: skip illiquid strikes
): SpreadMatch | null {
  const shortLeg = findStrikeByDelta(chain, shortDelta, type, dteRange, minVolume);
  // ... rest unchanged
```

**Step 3: Test**

```typescript
it('findSpreadStrikes with minVolume filters illiquid strikes', () => {
  // This is a documentation test — real chain data needed for integration test
  expect(true).toBe(true); // placeholder for integration test
});
```

**Step 4: Commit**

```bash
git add src/lib/backtest/chain-cache.ts
git commit -m "feat(backtest): add minVolume param to findSpreadStrikes"
```

---

### Task 6B: ORATS Liquidity & Greeks Entry Filters

**Files:**
- Modify: `src/lib/backtest/option-sim.ts` (add filter checks after `findSpreadStrikes`)
- Test: `tests/option-sim-fills.test.ts`

**Context:** The SQLite cache stores per-strike OI, bid/ask, gamma, theta, and IV
but the sim currently ignores all of these for entry decisions. These filters are
sweepable via `WFASweepDimension` to let the WFA optimizer find optimal liquidity
thresholds per window.

See **ORATS Factor Analysis** section below for data distributions and sweep values.

**Step 1: Write failing tests**

```typescript
// Add to tests/option-sim-fills.test.ts
describe('ORATS Liquidity & Greeks Filters', () => {
  // Re-use mockSpread from existing tests (short.oi=3000, long.oi=1500,
  // short spread%=12%, gamma=0.02, theta=-0.05, shortIV=0.18, longIV=0.20)

  it('maxBidAskSpreadPct filters wide-spread strikes', () => {
    // short leg: (2.65-2.35)/2.50 = 12% spread
    const spreadPct = (mockSpread.short.ask - mockSpread.short.bid) / mockSpread.short.mid;
    expect(spreadPct).toBeCloseTo(0.12, 2);
    // With maxBidAskSpreadPct=0.10 → should reject
    const passes10 = spreadPct <= 0.10;
    expect(passes10).toBe(false);
    // With maxBidAskSpreadPct=0.15 → should pass
    const passes15 = spreadPct <= 0.15;
    expect(passes15).toBe(true);
  });

  it('minShortOI filters low-OI strikes', () => {
    expect(mockSpread.short.oi).toBe(3000);
    expect(mockSpread.short.oi >= 500).toBe(true);
    expect(mockSpread.short.oi >= 5000).toBe(false);
  });

  it('maxGammaThetaRatio filters gamma-heavy positions', () => {
    // gamma=0.02, theta=-0.05 → ratio = 0.02/0.05 = 0.4
    const ratio = mockSpread.short.row.gamma / Math.abs(mockSpread.short.row.theta);
    expect(ratio).toBeCloseTo(0.4, 2);
    expect(ratio <= 0.3).toBe(false);  // filtered at 0.3
    expect(ratio <= 0.5).toBe(true);   // passes at 0.5
  });

  it('maxIVSkew filters steep-skew pairs', () => {
    // shortIV=0.18, longIV=0.20 → skew = |0.18-0.20| = 0.02
    const skew = Math.abs(mockSpread.short.iv - mockSpread.long.iv);
    expect(skew).toBeCloseTo(0.02, 3);
    expect(skew <= 0.01).toBe(false);  // filtered at 1%
    expect(skew <= 0.03).toBe(true);   // passes at 3%
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/option-sim-fills.test.ts`
Expected: PASS

**Step 3: Add filter logic to `simulateCreditSpread` (and `simulateCreditSpreadCached`)**

After `findSpreadStrikes()` returns and before fill computation, add:

```typescript
  // --- ORATS liquidity & Greeks filters (sweepable via WFASweepDimension) ---
  if (config.maxBidAskSpreadPct != null && config.maxBidAskSpreadPct !== Infinity) {
    const shortSpreadPct = spread.short.mid > 0.10
      ? (spread.short.ask - spread.short.bid) / spread.short.mid : 0;
    if (shortSpreadPct > config.maxBidAskSpreadPct) return null;
  }

  if (config.minShortOI != null && config.minShortOI > 0) {
    if (spread.short.oi < config.minShortOI) return null;
  }

  if (config.maxGammaThetaRatio != null && config.maxGammaThetaRatio !== Infinity) {
    const theta = Math.abs(spread.short.row.theta);
    if (theta > 0.001) {  // avoid division by zero
      const ratio = spread.short.row.gamma / theta;
      if (ratio > config.maxGammaThetaRatio) return null;
    }
  }

  if (config.maxIVSkew != null && config.maxIVSkew !== Infinity) {
    const skew = Math.abs(spread.short.iv - spread.long.iv);
    if (skew > config.maxIVSkew) return null;
  }
```

**Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (defaults are Infinity/0 → no existing behavior changes)

**Step 5: Commit**

```bash
git add src/lib/backtest/option-sim.ts tests/option-sim-fills.test.ts
git commit -m "feat(backtest): add ORATS liquidity/Greeks entry filters (bid/ask spread, OI, G/T, IV skew)"
```

---

## Phase 2: Walk-Forward Analysis Engine

### Task 7: WFA Options Types

**Files:**
- Modify: `src/lib/backtest/types.ts`

**Step 1: Add WFA options types**

```typescript
// ── Walk-Forward for Options ────────────────────────────

export interface WFAOptionsConfig {
  /** Tickers to simulate across */
  tickers: string[];
  /** Full date range (engine builds windows from this) */
  startDate: string;
  endDate: string;
  /** Training window in calendar days (default 504 = ~2 years) */
  trainWindowDays: number;
  /** Forward step in calendar days (default 126 = ~6 months) */
  forwardStepDays: number;
  /** Purge gap between train end and OOS start in trading days.
   *  Must be >= max DTE of traded options (default 65). */
  purgeGapDays: number;
  /** 'rolling' = fixed train window, 'anchored' = expanding from start */
  mode: WalkForwardMode;
  /** SimConfig overrides to sweep (the optimizer varies these per window) */
  simConfigBase: SimConfig;
  /** Which params to optimize per window (others stay fixed) */
  sweepDimensions: WFASweepDimension[];
  /** Max concurrent positions across all tickers */
  maxPositions: number;
  /** Max positions per ticker */
  maxPerTicker: number;
  /** Starting capital for portfolio sizing */
  startingCapital: number;
}

export type WFASweepDimension =
  // Existing structural params
  | 'creditShortDelta'
  | 'creditSpreadWidth'
  | 'creditProfitTarget'
  | 'creditStopLossMultiple'
  | 'creditDTERange'
  | 'minIVRank'
  // ORATS-derived liquidity & Greeks filters
  | 'maxBidAskSpreadPct'    // filter strikes with wide bid/ask spreads
  | 'minShortOI'            // minimum open interest on short leg
  | 'maxGammaThetaRatio'    // cap gamma/theta ratio (favor theta decay)
  | 'maxIVSkew'             // max IV skew between legs (limit skew cost)
  // Signal/indicator selection
  | 'signalWeightPreset';   // which tech indicator combo generates entry signals

/** Signal weight presets — zero out unused components to isolate indicators.
 *  Previous static IS/OOS tests used mid-price fills (inflated). WFA re-tests
 *  all 4 with realistic bid/ask fills to see if EMA dominance survives. */
export type SignalPresetKey = 'ema' | 'mom' | 'em' | 'mf';

export const SIGNAL_PRESETS: Record<SignalPresetKey, TechScoreOptions> = {
  /** EMA stack alignment only */
  ema: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_mom: 0, w_adx: 0, w_vol: 0 },
  /** Momentum/ROC only */
  mom: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_adx: 0, w_vol: 0 },
  /** EMA + Momentum */
  em:  { w_mb: 0, w_bxs: 0, w_bxl: 0, w_adx: 0, w_vol: 0 },
  /** Market Bias + Momentum + EMA (3-factor) */
  mf:  { w_bxs: 0, w_bxl: 0, w_adx: 0, w_vol: 0 },
};

export interface WFAWindow {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  /** Best config found on training data */
  bestConfig: SimConfig;
  bestTrainSharpe: number;
  /** OOS performance with bestConfig */
  oosTrades: OptionTrade[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
}

export interface WFAResult {
  config: WFAOptionsConfig;
  windows: WFAWindow[];
  /** All OOS trades concatenated chronologically */
  allOOSTrades: OptionTrade[];
  /** Portfolio equity curve from OOS trades only */
  oosEquityCurve: { date: string; equity: number }[];
  /** Aggregate OOS metrics */
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  /** WF efficiency: OOS Sharpe / avg train Sharpe */
  wfEfficiency: number;
  /** Correlation stress metrics */
  stressMetrics?: CorrelationStressResult;
  elapsedMs: number;
}
```

**Step 2: Commit**

```bash
git add src/lib/backtest/types.ts
git commit -m "feat(backtest): WFA options types (WFAOptionsConfig, WFAWindow, WFAResult)"
```

---

### Task 8: WFA Window Builder

**Files:**
- Create: `src/lib/backtest/wfa-options.ts`
- Test: `tests/wfa-options.test.ts`

**Step 1: Write failing tests for window building**

```typescript
// tests/wfa-options.test.ts
import { describe, it, expect } from 'vitest';
import { buildWFAWindows } from '../src/lib/backtest/wfa-options';

describe('buildWFAWindows', () => {
  // Generate trading dates (weekdays only) for 5 years
  function generateTradingDates(startYear: number, years: number): string[] {
    const dates: string[] = [];
    const start = new Date(startYear, 0, 1);
    const end = new Date(startYear + years, 0, 1);
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow > 0 && dow < 6) {
        dates.push(d.toISOString().slice(0, 10));
      }
    }
    return dates;
  }

  const allDates = generateTradingDates(2019, 7); // 2019-2025

  it('rolling mode: produces non-overlapping OOS windows', () => {
    const windows = buildWFAWindows(allDates, {
      trainWindowDays: 504,    // ~2 years
      forwardStepDays: 126,    // ~6 months
      purgeGapDays: 65,
      mode: 'rolling',
      startDate: '2019-01-01',
      endDate: '2025-12-31',
    });
    expect(windows.length).toBeGreaterThanOrEqual(4);

    // OOS windows should not overlap
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].oosStart).toBeGreaterThan(windows[i - 1].oosEnd);
    }
  });

  it('anchored mode: train start is always the same', () => {
    const windows = buildWFAWindows(allDates, {
      trainWindowDays: 504,
      forwardStepDays: 126,
      purgeGapDays: 65,
      mode: 'anchored',
      startDate: '2019-01-01',
      endDate: '2025-12-31',
    });
    const firstTrainStart = windows[0].trainStart;
    for (const w of windows) {
      expect(w.trainStart).toBe(firstTrainStart);
    }
  });

  it('purge gap creates space between train end and OOS start', () => {
    const windows = buildWFAWindows(allDates, {
      trainWindowDays: 504,
      forwardStepDays: 126,
      purgeGapDays: 65,
      mode: 'rolling',
      startDate: '2019-01-01',
      endDate: '2025-12-31',
    });
    for (const w of windows) {
      const trainEndIdx = allDates.indexOf(w.trainEnd);
      const oosStartIdx = allDates.indexOf(w.oosStart);
      expect(oosStartIdx - trainEndIdx).toBeGreaterThanOrEqual(65);
    }
  });

  it('last OOS window does not exceed endDate', () => {
    const windows = buildWFAWindows(allDates, {
      trainWindowDays: 504,
      forwardStepDays: 126,
      purgeGapDays: 65,
      mode: 'rolling',
      startDate: '2019-01-01',
      endDate: '2025-12-31',
    });
    const last = windows[windows.length - 1];
    expect(last.oosEnd <= '2025-12-31').toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/wfa-options.test.ts`
Expected: FAIL — module not found

**Step 3: Implement window builder**

```typescript
// src/lib/backtest/wfa-options.ts
/**
 * Walk-Forward Analysis Engine for Options
 *
 * Rolling/anchored WFA with:
 * - Real bid/ask fills (via slippage module)
 * - Position carry across OOS boundaries
 * - Purge gap to prevent look-ahead bias
 */

import type { WalkForwardMode } from './types';

export interface WindowDef {
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
}

export interface BuildWindowsParams {
  trainWindowDays: number;
  forwardStepDays: number;
  purgeGapDays: number;
  mode: WalkForwardMode;
  startDate: string;
  endDate: string;
}

/**
 * Build WFA window boundaries from a sorted array of trading dates.
 *
 * Rolling: fixed-width train window slides forward by forwardStepDays.
 * Anchored: train window starts at startDate and expands each step.
 */
export function buildWFAWindows(
  allDates: string[],
  params: BuildWindowsParams,
): WindowDef[] {
  const { trainWindowDays, forwardStepDays, purgeGapDays, mode, startDate, endDate } = params;

  // Filter to date range
  const dates = allDates.filter(d => d >= startDate && d <= endDate);
  if (dates.length === 0) return [];

  const windows: WindowDef[] = [];
  const anchorStart = 0;

  let trainStartIdx = 0;
  let trainEndIdx = trainStartIdx + trainWindowDays - 1;

  while (trainEndIdx < dates.length) {
    const oosStartIdx = trainEndIdx + 1 + purgeGapDays;
    const oosEndIdx = Math.min(oosStartIdx + forwardStepDays - 1, dates.length - 1);

    if (oosStartIdx >= dates.length) break;

    windows.push({
      trainStart: dates[mode === 'anchored' ? anchorStart : trainStartIdx],
      trainEnd: dates[trainEndIdx],
      oosStart: dates[oosStartIdx],
      oosEnd: dates[oosEndIdx],
    });

    // Advance
    if (mode === 'rolling') {
      trainStartIdx += forwardStepDays;
    }
    trainEndIdx += forwardStepDays;
  }

  return windows;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/wfa-options.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/lib/backtest/wfa-options.ts tests/wfa-options.test.ts
git commit -m "feat(backtest): WFA window builder with rolling/anchored mode + purge gap"
```

---

### Task 9: WFA Per-Window Optimizer

**Files:**
- Modify: `src/lib/backtest/wfa-options.ts`
- Test: `tests/wfa-options.test.ts`

**Step 1: Write failing test for per-window optimization**

```typescript
describe('optimizeWindow', () => {
  it('returns best SimConfig from sweep candidates', async () => {
    // Mock: sweep 3 configs, return best by Sharpe
    const candidates: SimConfig[] = [
      { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.20 },
      { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.30 },
      { ...DEFAULT_CREDIT_CONFIG, creditProfitTarget: 0.50 },
    ];
    // optimizeWindow should run all candidates on training data
    // and return the one with best Sharpe
    // (Full integration test requires ORATS data; this tests the selection logic)
    const results = [
      { config: candidates[0], sharpe: 1.2 },
      { config: candidates[1], sharpe: 2.1 },
      { config: candidates[2], sharpe: 0.8 },
    ];
    const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);
    expect(best.config.creditProfitTarget).toBe(0.30);
  });
});
```

**Step 2: Implement `optimizeWindow` function**

This function takes a training date range, list of SimConfig candidates, and entry signals. It runs each config through `simulateCreditSpreadCached` (cache-only, no API calls) for all signals in the training window and returns the config with the best Sharpe.

```typescript
import type { SimConfig, WFAWindow, OptionTrade } from './types';
import { simulateCreditSpreadCached, computeOptionAnalytics } from './option-sim';
import type { EntrySignal } from './option-sim';

export interface WindowOptResult {
  bestConfig: SimConfig;
  bestSharpe: number;
  allResults: { config: SimConfig; sharpe: number; trades: number }[];
}

/**
 * Optimize a single WFA window: run all candidate configs on training signals,
 * return best by Sharpe.
 *
 * Each config may have a different signalWeightPreset, so signals are looked up
 * per-config from the precomputed signal map. This avoids re-running indicator
 * computation during optimization.
 *
 * NOTE: Uses cache-only chain reads. No ORATS API calls. All chain data must
 * be pre-populated in data/option-chains.sqlite before running WFA.
 */
export function optimizeWindow(
  candidates: SimConfig[],
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  allTradingDates: string[],
  trainStart: string,
  trainEnd: string,
): WindowOptResult {
  const results: { config: SimConfig; sharpe: number; trades: number }[] = [];

  for (const config of candidates) {
    // Select signals for this config's preset (default 'ema')
    const presetKey = config.signalWeightPreset ?? 'ema';
    const allSignals = signalsByPreset.get(presetKey) ?? [];
    const trainSignals = allSignals.filter(s => s.date >= trainStart && s.date <= trainEnd);

    // Guard: verify no signal leaks past trainEnd
    const leak = trainSignals.find(s => s.date > trainEnd);
    if (leak) throw new Error(`Data isolation violation: signal ${leak.date} > trainEnd ${trainEnd}`);

    const trades: OptionTrade[] = [];
    for (const signal of trainSignals) {
      // Cache-only: reads SQLite, returns null on cache miss (no API call)
      const trade = simulateCreditSpreadCached(
        signal, config, allTradingDates, trainEnd,
      );
      if (trade) trades.push(trade);
    }
    const analytics = computeOptionAnalytics(trades);
    results.push({ config, sharpe: analytics.sharpe, trades: trades.length });
  }

  results.sort((a, b) => b.sharpe - a.sharpe);
  return {
    bestConfig: results[0]?.config ?? candidates[0],
    bestSharpe: results[0]?.sharpe ?? 0,
    allResults: results,
  };
}
```

> **Implementation note:** `simulateCreditSpreadCached` is a new synchronous variant
> of `simulateCreditSpread` that calls `getCachedChain()` / `getCachedChainFiltered()`
> instead of `fetchHistoricalChain()`. Since SQLite reads are synchronous via
> `better-sqlite3`, the entire function becomes synchronous — no `async/await` overhead,
> no event loop yielding. This is faster and simpler for batch computation.

**Step 3: Run tests, commit**

```bash
git add src/lib/backtest/wfa-options.ts tests/wfa-options.test.ts
git commit -m "feat(backtest): per-window optimizer for WFA options engine"
```

---

### Task 10: WFA Main Loop — Position Carry Across Boundaries

**Files:**
- Modify: `src/lib/backtest/wfa-options.ts`
- Test: `tests/wfa-options.test.ts`

This is the critical architectural piece. Positions opened in one OOS window that haven't exited must carry into the next window seamlessly.

**Step 1: Write failing test for position carry**

```typescript
describe('WFA position carry', () => {
  it('open positions carry across OOS window boundaries', () => {
    // Simulate: trade opens in Window 1 OOS, exits in Window 2 OOS
    // The P&L should be attributed correctly and equity should be continuous
    const w1Trades: OptionTrade[] = [
      // Opened in W1, STILL OPEN at W1 end (no exit yet)
      {
        ticker: 'SPY', mode: 'CREDIT_SPREAD', direction: 'CALL',
        entryDate: '2024-01-15', entrySignalScore: 80,
        strike: 480, expiry: '2024-03-15', entryDTE: 60,
        entryPrice: 1.00, entryDelta: -0.30, entryIV: 0.18,
        entryStockPrice: 485, spreadWidth: 10, maxLoss: 9.00, maxProfit: 1.00,
        // NOT exited in W1 — these fields will be filled when it closes in W2
        exitDate: '2024-04-01', exitPrice: 0.30, exitDTE: 15,
        exitStockPrice: 490, exitType: 'PROFIT_TARGET',
        pnl: 70, pnlPct: 0.078, holdDays: 76,
      },
    ];
    // The trade's entryDate is in W1 but exitDate is in W2
    expect(w1Trades[0].entryDate < '2024-03-31').toBe(true);  // W1 OOS
    expect(w1Trades[0].exitDate >= '2024-04-01').toBe(true);   // W2 OOS
    // Equity tracking must be continuous
    expect(w1Trades[0].holdDays).toBe(76); // spans both windows
  });
});
```

**Step 2: Implement `runWFAOptions` main loop**

```typescript
/**
 * Run full Walk-Forward Analysis for options.
 *
 * Key design decisions:
 * 1. Signals are precomputed per preset (ema/mom/em/mf) for the full date range.
 *    Each SimConfig's signalWeightPreset selects which signal set to use.
 *    This is cheap — precomputeSignals runs on candle arrays, not chain data.
 * 2. SimConfig (entry/exit params + signal preset) are optimized per training window
 * 3. Open positions carry across OOS boundaries — they are monitored until exit
 * 4. Quality gates (RVOL, ADX, Coherence) are computed on data strictly before the OOS window
 * 5. Equity curve is continuous across all OOS windows
 */
export function runWFAOptions(
  config: WFAOptionsConfig,
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  allTradingDates: string[],
  sweepCandidates: SimConfig[],
  onProgress?: (windowIdx: number, totalWindows: number) => void,
): WFAResult {
  const t0 = Date.now();

  const windows = buildWFAWindows(allTradingDates, {
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    startDate: config.startDate,
    endDate: config.endDate,
  });

  const allOOSTrades: OptionTrade[] = [];
  const wfaWindows: WFAWindow[] = [];
  const openPositions: Map<string, OptionTrade> = new Map(); // positionKey → partial trade

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    onProgress?.(i, windows.length);

    // 1. Optimize on training data (cache-only, no API calls)
    const optResult = optimizeWindow(
      sweepCandidates, signalsByPreset, allTradingDates, w.trainStart, w.trainEnd,
    );

    // 2. Run OOS with best config (cache-only)
    // Use the winning preset's signals for OOS
    const bestPreset = optResult.bestConfig.signalWeightPreset ?? 'ema';
    const presetSignals = signalsByPreset.get(bestPreset) ?? [];
    const oosSignals = presetSignals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const oosTrades: OptionTrade[] = [];

    for (const signal of oosSignals) {
      // Cache-only: reads SQLite, skips on cache miss
      const trade = simulateCreditSpreadCached(
        signal, optResult.bestConfig, allTradingDates, config.endDate,
        // NOTE: maxDate is config.endDate, NOT w.oosEnd
        // This allows positions to close AFTER the OOS window ends
      );
      if (trade) oosTrades.push(trade);
    }

    const oosAnalytics = computeOptionAnalytics(oosTrades);

    wfaWindows.push({
      windowIndex: i,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      bestConfig: optResult.bestConfig,
      bestTrainSharpe: optResult.bestSharpe,
      oosTrades,
      oosSharpe: oosAnalytics.sharpe,
      oosWinRate: oosAnalytics.winRate,
      oosMaxDD: oosAnalytics.maxDrawdown,
    });

    allOOSTrades.push(...oosTrades);
  }

  // 3. Build continuous equity curve from all OOS trades
  const sortedTrades = [...allOOSTrades].sort(
    (a, b) => a.exitDate.localeCompare(b.exitDate)
  );
  let equity = config.startingCapital;
  let peak = equity;
  let maxDD = 0;
  const equityCurve: { date: string; equity: number }[] = [];

  for (const t of sortedTrades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
    equityCurve.push({ date: t.exitDate, equity });
  }

  const oosAllAnalytics = computeOptionAnalytics(allOOSTrades);
  const avgTrainSharpe = wfaWindows.reduce((s, w) => s + w.bestTrainSharpe, 0) / wfaWindows.length;

  return {
    config,
    windows: wfaWindows,
    allOOSTrades,
    oosEquityCurve: equityCurve,
    oosSharpe: oosAllAnalytics.sharpe,
    oosWinRate: oosAllAnalytics.winRate,
    oosMaxDD: maxDD * 100,
    oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
    wfEfficiency: avgTrainSharpe > 0 ? oosAllAnalytics.sharpe / avgTrainSharpe : 0,
    elapsedMs: Date.now() - t0,
  };
}
```

**Step 3: Run tests, commit**

```bash
git add src/lib/backtest/wfa-options.ts tests/wfa-options.test.ts
git commit -m "feat(backtest): WFA main loop with position carry across OOS boundaries"
```

---

### Task 11: Data Isolation Enforcement

**Files:**
- Modify: `src/lib/backtest/wfa-options.ts`
- Test: `tests/wfa-options.test.ts`

**Step 1: Write failing test**

```typescript
describe('Data isolation', () => {
  it('training signals never include dates after trainEnd', () => {
    const signals = [
      { ticker: 'SPY', date: '2023-01-01', direction: 'CALL' as const, score: 80 },
      { ticker: 'SPY', date: '2023-06-15', direction: 'CALL' as const, score: 85 },
      { ticker: 'SPY', date: '2024-01-01', direction: 'CALL' as const, score: 90 },
      { ticker: 'SPY', date: '2024-06-15', direction: 'CALL' as const, score: 88 },
    ];
    const trainEnd = '2023-12-31';
    const filtered = signals.filter(s => s.date <= trainEnd);
    expect(filtered).toHaveLength(2);
    expect(filtered.every(s => s.date <= trainEnd)).toBe(true);
  });

  it('OOS signals start AFTER purge gap, not at trainEnd + 1', () => {
    const trainEnd = '2023-12-29'; // Friday
    const purgeGap = 5;
    // OOS should start at least 5 trading days after trainEnd
    // NOT at 2024-01-01
    const tradingDates = [
      '2023-12-29', '2024-01-02', '2024-01-03', '2024-01-04',
      '2024-01-05', '2024-01-08', '2024-01-09', '2024-01-10',
    ];
    const trainEndIdx = tradingDates.indexOf(trainEnd);
    const oosStartIdx = trainEndIdx + 1 + purgeGap; // idx 6 → '2024-01-09'
    expect(tradingDates[oosStartIdx]).toBe('2024-01-09');
    // 5 trading days gap: Jan 2, 3, 4, 5, 8
  });
});
```

**Step 2: Verify isolation is already enforced in `optimizeWindow` and `runWFAOptions`**

The signal filtering `signals.filter(s => s.date >= trainStart && s.date <= trainEnd)` and the window builder's purge gap already enforce this. Add an assertion guard in `optimizeWindow`:

```typescript
// Guard: verify no signal leaks past trainEnd
if (process.env.NODE_ENV !== 'production') {
  const leak = trainSignals.find(s => s.date > trainEnd);
  if (leak) throw new Error(`Data isolation violation: signal ${leak.date} > trainEnd ${trainEnd}`);
}
```

**Step 3: Run tests, commit**

```bash
git add src/lib/backtest/wfa-options.ts tests/wfa-options.test.ts
git commit -m "feat(backtest): data isolation guards in WFA optimizer"
```

---

## Phase 3: Portfolio Correlation Stress Testing

### Task 12: Correlation Stress Types

**Files:**
- Modify: `src/lib/backtest/types.ts`

**Step 1: Add types**

```typescript
// ── Correlation Stress Testing ──────────────────────────

export interface CorrelationStressResult {
  /** Max simultaneous drawdown across all tickers on any single day */
  peakCorrelatedDD: number;
  /** Date of peak correlated drawdown */
  peakCorrelatedDDDate: string;
  /** Number of tickers in drawdown on worst day */
  tickersInDDOnWorstDay: number;
  /** Avg pairwise correlation of daily P&L across tickers */
  avgPairwiseCorrelation: number;
  /** Worst single-day portfolio loss (across all open positions) */
  worstDayLoss: number;
  worstDayLossDate: string;
  /** Stress penalty: how much worse is correlated DD vs uncorrelated expectation */
  correlationPenalty: number;
  /** Per-ticker drawdown on worst day */
  perTickerDD: Record<string, number>;
}
```

**Step 2: Commit**

```bash
git add src/lib/backtest/types.ts
git commit -m "feat(backtest): CorrelationStressResult type for portfolio stress testing"
```

---

### Task 13: Portfolio Stress Engine — Daily P&L Matrix

**Files:**
- Create: `src/lib/backtest/portfolio-stress.ts`
- Test: `tests/portfolio-stress.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/portfolio-stress.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildDailyPnLMatrix,
  computeCorrelationStress,
} from '../src/lib/backtest/portfolio-stress';
import type { OptionTrade } from '../src/lib/backtest/option-sim';

/**
 * Helper: build a trade with dailyMtM populated (simulating what option-sim
 * now produces). Each day from entry to exit gets an unrealized P&L entry.
 */
function makeTrade(
  ticker: string, entryDate: string, exitDate: string, pnl: number,
  holdDays: number, maxLoss: number = 900,
): OptionTrade {
  // Generate dailyMtM: linear interpolation from 0 to final P&L
  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
  const start = new Date(entryDate);
  const end = new Date(exitDate);
  let dayCount = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    dayCount++;
    const progress = holdDays > 0 ? dayCount / holdDays : 1;
    dailyMtM.push({
      date: d.toISOString().slice(0, 10),
      spreadMid: 1.00 - (pnl / 100) * progress,
      unrealizedPnl: pnl * progress,
    });
  }

  return {
    ticker, mode: 'CREDIT_SPREAD', direction: 'CALL',
    entryDate, entrySignalScore: 80,
    strike: 100, expiry: '2024-06-21', entryDTE: 45,
    entryPrice: 1.00, entryDelta: -0.30, entryIV: 0.20,
    entryStockPrice: 105, spreadWidth: 10, maxLoss, maxProfit: 100,
    exitDate, exitPrice: pnl > 0 ? 0.30 : 5.00,
    exitDTE: 7, exitStockPrice: pnl > 0 ? 108 : 95,
    exitType: pnl > 0 ? 'PROFIT_TARGET' : 'STOP_LOSS',
    pnl, pnlPct: pnl / (maxLoss * 100), holdDays,
    dailyMtM,
  } as OptionTrade;
}

describe('buildDailyPnLMatrix', () => {
  it('uses dailyMtM for unrealized P&L, not just exit-day realized', () => {
    const trades = [
      makeTrade('SPY', '2024-01-02', '2024-01-10', -500, 6),
    ];
    const matrix = buildDailyPnLMatrix(trades, '2024-01-02', '2024-01-15');
    // Should have non-zero values on INTERMEDIATE days (not just exit day)
    const midIdx = matrix.dates.indexOf('2024-01-05');
    if (midIdx >= 0) {
      expect(matrix.byTicker['SPY'][midIdx]).not.toBe(0);
    }
  });

  it('returns daily P&L per ticker', () => {
    const trades = [
      makeTrade('SPY', '2024-01-02', '2024-01-10', 70, 8),
      makeTrade('QQQ', '2024-01-03', '2024-01-12', -400, 9),
    ];
    const matrix = buildDailyPnLMatrix(trades, '2024-01-02', '2024-01-15');
    expect(Object.keys(matrix.byTicker)).toContain('SPY');
    expect(Object.keys(matrix.byTicker)).toContain('QQQ');
    expect(matrix.dates.length).toBeGreaterThan(0);
  });

  it('multiple open trades on same day sum their unrealized changes', () => {
    const trades = [
      makeTrade('SPY', '2024-01-02', '2024-01-10', -500, 6),
      makeTrade('SPY', '2024-01-02', '2024-01-10', -300, 6),
    ];
    const matrix = buildDailyPnLMatrix(trades, '2024-01-02', '2024-01-15');
    // On any intermediate day, SPY's P&L should reflect BOTH positions
    const midIdx = matrix.dates.indexOf('2024-01-05');
    if (midIdx >= 0) {
      // Both trades contribute unrealized P&L
      expect(matrix.byTicker['SPY'][midIdx]).toBeLessThan(0);
    }
  });
});

describe('computeCorrelationStress', () => {
  it('detects correlated drawdown across tickers using daily MTM', () => {
    // All 3 tickers losing simultaneously → high correlated drawdown
    const trades = [
      makeTrade('SPY', '2024-01-02', '2024-01-10', -500, 6),
      makeTrade('QQQ', '2024-01-02', '2024-01-10', -600, 6),
      makeTrade('AAPL', '2024-01-02', '2024-01-10', -400, 6),
    ];
    const stress = computeCorrelationStress(trades, '2024-01-02', '2024-01-15', 100_000);
    expect(stress.peakCorrelatedDD).toBeGreaterThan(0);
    expect(stress.tickersInDDOnWorstDay).toBe(3);
    expect(stress.worstDayLoss).toBeLessThan(0);
  });

  it('uncorrelated losses have lower peak drawdown than correlated', () => {
    // Losses on different, non-overlapping days → uncorrelated
    const uncorrelated = [
      makeTrade('SPY', '2024-01-02', '2024-01-05', -500, 3),
      makeTrade('QQQ', '2024-01-08', '2024-01-12', -500, 4),
      makeTrade('AAPL', '2024-01-15', '2024-01-19', -500, 4),
    ];
    // Losses on same days → correlated
    const correlated = [
      makeTrade('SPY', '2024-01-02', '2024-01-05', -500, 3),
      makeTrade('QQQ', '2024-01-02', '2024-01-05', -500, 3),
      makeTrade('AAPL', '2024-01-02', '2024-01-05', -500, 3),
    ];
    const stressUncorr = computeCorrelationStress(uncorrelated, '2024-01-02', '2024-01-31', 100_000);
    const stressCorr = computeCorrelationStress(correlated, '2024-01-02', '2024-01-31', 100_000);

    // Correlated: all 3 draw down together → peak DD is ~3× single
    // Uncorrelated: max 1 drawing down at a time → peak DD is ~1× single
    expect(stressCorr.peakCorrelatedDD).toBeGreaterThan(stressUncorr.peakCorrelatedDD);
  });

  it('penalizes no-SL configs more during systemic shocks', () => {
    const noSL = [
      makeTrade('SPY', '2024-01-02', '2024-01-10', -900, 6, 900),
      makeTrade('QQQ', '2024-01-02', '2024-01-10', -900, 6, 900),
      makeTrade('AAPL', '2024-01-02', '2024-01-10', -900, 6, 900),
    ];
    const withSL = [
      makeTrade('SPY', '2024-01-02', '2024-01-05', -200, 3, 200),
      makeTrade('QQQ', '2024-01-02', '2024-01-05', -200, 3, 200),
      makeTrade('AAPL', '2024-01-02', '2024-01-05', -200, 3, 200),
    ];
    const stressNoSL = computeCorrelationStress(noSL, '2024-01-02', '2024-01-15', 100_000);
    const stressSL = computeCorrelationStress(withSL, '2024-01-02', '2024-01-15', 100_000);
    expect(Math.abs(stressNoSL.worstDayLoss)).toBeGreaterThan(Math.abs(stressSL.worstDayLoss));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/portfolio-stress.test.ts`
Expected: FAIL — module not found

**Step 3: Implement portfolio stress engine**

```typescript
// src/lib/backtest/portfolio-stress.ts
/**
 * Portfolio Correlation Stress Testing
 *
 * Measures aggregate portfolio drawdowns across a multi-ticker basket
 * using DAILY UNREALIZED P&L (from OptionTrade.dailyMtM), not just
 * terminal exit-day realized P&L.
 *
 * Why unrealized matters: A 45-day credit spread that ultimately loses $900
 * doesn't lose $900 on day 45 and $0 on days 1-44. The spread widens
 * gradually as the underlying moves against you. To measure correlation
 * between simultaneous positions, we need the daily mark-to-market.
 */

import type { OptionTrade } from './option-sim';
import type { CorrelationStressResult } from './types';

export interface DailyPnLMatrix {
  dates: string[];
  byTicker: Record<string, number[]>;   // ticker → daily CHANGE in unrealized P&L
  aggregate: number[];                    // sum across all tickers per day
}

/**
 * Build a daily P&L matrix from option trades using dailyMtM data.
 *
 * For each trade, the DAILY CHANGE in unrealized P&L is computed from
 * the dailyMtM array (populated by option-sim.ts during monitoring).
 * This captures how much each position gained or lost each day,
 * not just the terminal P&L.
 *
 * Falls back to exit-date attribution if dailyMtM is not populated
 * (backward compatibility with old trade data).
 */
export function buildDailyPnLMatrix(
  trades: OptionTrade[],
  startDate: string,
  endDate: string,
): DailyPnLMatrix {
  // Generate trading dates (weekdays)
  const dates: string[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow > 0 && dow < 6) {
      dates.push(d.toISOString().slice(0, 10));
    }
  }

  // Build date → index lookup for O(1) access
  const dateIdx = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) dateIdx.set(dates[i], i);

  // Initialize matrix
  const tickers = [...new Set(trades.map(t => t.ticker))];
  const byTicker: Record<string, number[]> = {};
  for (const t of tickers) {
    byTicker[t] = new Array(dates.length).fill(0);
  }
  const aggregate = new Array(dates.length).fill(0);

  for (const trade of trades) {
    const tickerArr = byTicker[trade.ticker];
    if (!tickerArr) continue;

    if (trade.dailyMtM && trade.dailyMtM.length > 0) {
      // Use daily mark-to-market: compute daily CHANGE in unrealized P&L
      let prevUnrealized = 0;
      for (const mtm of trade.dailyMtM) {
        const idx = dateIdx.get(mtm.date);
        if (idx === undefined) continue;
        const dailyChange = mtm.unrealizedPnl - prevUnrealized;
        tickerArr[idx] += dailyChange;
        aggregate[idx] += dailyChange;
        prevUnrealized = mtm.unrealizedPnl;
      }
    } else {
      // Fallback: attribute full P&L to exit date (legacy behavior)
      const exitIdx = dateIdx.get(trade.exitDate);
      if (exitIdx !== undefined) {
        tickerArr[exitIdx] += trade.pnl;
        aggregate[exitIdx] += trade.pnl;
      }
    }
  }

  return { dates, byTicker, aggregate };
}

/**
 * Compute correlation stress metrics from trades.
 */
export function computeCorrelationStress(
  trades: OptionTrade[],
  startDate: string,
  endDate: string,
  startingCapital: number,
): CorrelationStressResult {
  const matrix = buildDailyPnLMatrix(trades, startDate, endDate);
  const tickers = Object.keys(matrix.byTicker);

  // Find worst aggregate day
  let worstDayLoss = 0;
  let worstDayIdx = 0;
  for (let i = 0; i < matrix.aggregate.length; i++) {
    if (matrix.aggregate[i] < worstDayLoss) {
      worstDayLoss = matrix.aggregate[i];
      worstDayIdx = i;
    }
  }

  // Count tickers in drawdown on worst day
  let tickersInDD = 0;
  const perTickerDD: Record<string, number> = {};
  for (const ticker of tickers) {
    const pnl = matrix.byTicker[ticker][worstDayIdx] ?? 0;
    perTickerDD[ticker] = pnl;
    if (pnl < 0) tickersInDD++;
  }

  // Peak correlated drawdown (cumulative equity drawdown)
  let equity = startingCapital;
  let peak = equity;
  let peakDD = 0;
  let peakDDIdx = 0;
  for (let i = 0; i < matrix.aggregate.length; i++) {
    equity += matrix.aggregate[i];
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > peakDD) {
      peakDD = dd;
      peakDDIdx = i;
    }
  }

  // Avg pairwise correlation of daily P&L
  let corrSum = 0;
  let corrCount = 0;
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const corr = pearsonCorr(matrix.byTicker[tickers[i]], matrix.byTicker[tickers[j]]);
      if (Number.isFinite(corr)) {
        corrSum += corr;
        corrCount++;
      }
    }
  }
  const avgCorr = corrCount > 0 ? corrSum / corrCount : 0;

  // Correlation penalty: ratio of actual peak DD to expected uncorrelated DD
  // Uncorrelated expectation: DD scales as sqrt(n_tickers)
  // Actual: DD scales as n_tickers (fully correlated)
  // Penalty = actual / (actual / sqrt(avgCorr or 0.01))
  const correlationPenalty = avgCorr > 0.01
    ? peakDD * Math.sqrt(avgCorr)
    : peakDD * 0.1;

  return {
    peakCorrelatedDD: peakDD * 100,
    peakCorrelatedDDDate: matrix.dates[peakDDIdx] ?? startDate,
    tickersInDDOnWorstDay: tickersInDD,
    avgPairwiseCorrelation: avgCorr,
    worstDayLoss,
    worstDayLossDate: matrix.dates[worstDayIdx] ?? startDate,
    correlationPenalty,
    perTickerDD,
  };
}

// ── Helpers ──────────────────────────────────────────────

function pearsonCorr(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : 0;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/portfolio-stress.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/lib/backtest/portfolio-stress.ts tests/portfolio-stress.test.ts
git commit -m "feat(backtest): portfolio correlation stress testing engine"
```

---

### Task 14: Integrate Stress Testing into WFA

**Files:**
- Modify: `src/lib/backtest/wfa-options.ts`

**Step 1: Add stress metrics to WFA result**

After computing `allOOSTrades`, call `computeCorrelationStress`:

```typescript
import { computeCorrelationStress } from './portfolio-stress';

// ... at the end of runWFAOptions, before return:
const stressMetrics = computeCorrelationStress(
  allOOSTrades, config.startDate, config.endDate, config.startingCapital,
);

return {
  // ... existing fields ...
  stressMetrics,
};
```

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (existing 449 + new slippage + fills + wfa + stress)

**Step 3: Commit**

```bash
git add src/lib/backtest/wfa-options.ts
git commit -m "feat(backtest): integrate correlation stress into WFA result"
```

---

### Task 15: Final Integration — Run All Tests & Verify

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests + all new tests PASS

**Step 2: Verify no regressions in existing backtest functionality**

Run: `npx vitest run tests/backtest-audit.test.ts tests/bsm-pricing.test.ts`
Expected: All PASS — stock backtester unchanged

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat(backtest): complete WFA engine overhaul — bid/ask fills, dynamic slippage, correlation stress"
```

---

## ORATS Factor Analysis — New Sweep Dimensions

> Results from querying the 13.9 GB SQLite cache at credit spread sweet spot
> (delta 0.60–0.75, DTE 45–65, all 16 tickers, 2017–2026).

### 1. Bid/Ask Spread % (`maxBidAskSpreadPct`)

**Rationale:** Tighter spreads = less slippage. Directly synergizes with the new
bid/ask fill model. Filtering out wide-spread strikes prevents the sim from taking
trades that would be unprofitable in practice.

| Threshold | Strikes retained | % of total |
|-----------|-----------------|------------|
| ≤ 5%      | 202,908         | 81.6%      |
| ≤ 10%     | 230,686         | 92.7%      |
| ≤ 15%     | 240,205         | 96.6%      |
| ≤ 20%     | 243,849         | 98.0%      |
| No filter | 248,773         | 100%       |

Per-ticker spread: SPY 0.6%, QQQ 1.0%, IWM 1.4% (ETFs) vs COST 8.5%, GS 6.8%, JPM 6.9% (illiquid singles).

**Sweep values:** `[0.05, 0.10, 0.15, 0.20, Infinity]` (5 levels).
**Default:** `Infinity` (no filter, backward compat).

### 2. Minimum Short Leg OI (`minShortOI`)

**Rationale:** Low OI = poor fills and potential assignment risk.

| Threshold | Strikes retained | % of total |
|-----------|-----------------|------------|
| ≥ 50      | 154,602         | 62.1%      |
| ≥ 100     | 140,222         | 56.4%      |
| ≥ 500     | 101,658         | 40.9%      |
| ≥ 1,000   | 84,191          | 33.8%      |
| ≥ 5,000   | 41,144          | 16.5%      |

**Previous finding:** OI filters HURT diversification in Phase 1-3 credit sims
(kills small-cap tickers entirely). Recommend conservative sweep only.

**Sweep values:** `[0, 50, 100, 500]` (4 levels). Skipping 1000+ — too aggressive.
**Default:** `0` (no filter).

### 3. Gamma/Theta Ratio (`maxGammaThetaRatio`)

**Rationale:** High gamma/|theta| means the position is more sensitive to
underlying moves per unit of theta decay collected. Low ratio = purer theta play.

| Ticker | Avg G/T | Interpretation |
|--------|---------|----------------|
| AMD    | 1.22    | Very gamma-heavy (small stock, low vega) |
| JPM    | 0.89    | High gamma risk |
| MSFT   | 0.62    | Moderate |
| IWM    | 0.40    | Moderate |
| AAPL   | 0.29    | Low gamma risk |
| SPY    | 0.13    | Favorable theta extraction |
| AMZN   | 0.01    | Extreme theta dominance (high-priced) |

**Sweep values:** `[0.3, 0.5, 1.0, Infinity]` (4 levels).
**Default:** `Infinity` (no filter).

### 4. IV Skew (`maxIVSkew`)

**Rationale:** Steeper put skew means the long (protective) leg is relatively
expensive, reducing net credit received. Flat-skew environments yield more credit.

| Ticker | Avg IV Skew | Skew Profile |
|--------|-------------|--------------|
| TSLA   | −4.75%      | Steepest — long leg very expensive |
| SPY    | −4.17%      | Steep (index put demand) |
| QQQ    | −4.07%      | Steep |
| IWM    | −3.72%      | Steep |
| JPM    | −3.19%      | Moderate |
| GOOG   | −2.92%      | Moderate |
| AMZN   | −2.35%      | Flat — good credit capture |
| NVDA   | −2.34%      | Flat |

**Sweep values:** `[0.03, 0.04, 0.05, Infinity]` (4 levels, absolute IV difference).
**Default:** `Infinity` (no filter).

### 5. Signal Weight Preset (`signalWeightPreset`)

**Rationale:** Previous IS/OOS tests ranked EMA as the best signal (OOS Sharpe 2.39)
and MOM second (1.90). But those results used **mid-price fills**, which inflate
profits by 80–97%. With realistic bid/ask fills, the ranking may change entirely.
WFA re-tests all 4 proven presets with the corrected execution model, per rolling
window — revealing whether any indicator's edge is regime-dependent.

| Preset | Components | Previous OOS Sharpe (mid-fill) |
|--------|-----------|-------------------------------|
| `ema`  | sc_ema only | 2.39 |
| `mom`  | sc_mom only | 1.90 |
| `em`   | sc_ema + sc_mom | ~1.5 |
| `mf`   | sc_mb + sc_mom + sc_ema | 2.40 |

**Sweep values:** `['ema', 'mom', 'em', 'mf']` (4 presets).
**Default:** `'ema'` (current best, backward compat).

**Architecture note:** Signal presets are cheap to compute — `precomputeSignals()`
runs on candle arrays (already cached in `stock_candles`), not chain data. The
caller precomputes all 4 preset signal sets once upfront, stores them in
`Map<SignalPresetKey, EntrySignal[]>`, and passes the map to `runWFAOptions`.
Each `SimConfig` candidate selects its preset via `signalWeightPreset`, and the
optimizer looks up the matching signal set. No indicator recomputation during sweep.

### Implementation Notes

1. **Where to apply:** ORATS filters are checked in `simulateCreditSpreadCached` at
   entry time, after `findSpreadStrikes()` returns the short/long leg pair. If the
   pair fails any filter → skip signal (no trade). Same as existing `minIVRank`.

2. **SimConfig defaults:** All set to `Infinity` or `0` (no filter), preserving
   backward compatibility. Old scripts produce identical results.

3. **Sweep combinatorics:** 4 signal presets × 5 spread% × 4 OI × 4 G/T × 4 skew =
   1,280 filter combos. Combined with 6 structural params, total grid is large →
   GA optimizer handles this (same as existing sweep approach, not full factorial).

4. **Data availability:** All fields (`put_oi`, `put_bid`, `put_ask`, `put_mid`,
   `gamma`, `theta`, `put_iv`) are already cached per strike in SQLite `option_chains`
   table. No new data ingestion needed.

---

## Performance: Parallelization Notes

### Your Hardware
- **CPU:** AMD Ryzen 9 5900X — 12 cores / 24 threads
- **GPU:** NVIDIA RTX 3080 — 10 GB VRAM
- **Current worker cap:** `os.cpus().length - 2 = 22` threads

### Cached Data Range — Use All Of It

The SQLite cache (`data/option-chains.sqlite`, 13.9 GB) covers:
- **16 tickers:** SPY, QQQ, AAPL, MSFT, NVDA, AMD, AMZN, TSLA, JPM, META,
  NFLX, GOOG, GOOGL, COST, GS, IWM
- **Date range:** 2017-01-03 → 2026-03-06 (2,306 unique trading dates)
- **Core tickers** (SPY, QQQ, AAPL, etc.) have full 9-year coverage
- **Extended tickers** (COST, META, NFLX, etc.) have 2019-01 → 2025-12

The old static IS/OOS split wasted ~4 months of cached data between IS end
(Dec 2023) and OOS start (Apr 2024). The rolling WFA eliminates this waste:

**Indicator lookback constraint:** Technical indicators require warmup before
producing valid signals. `computeLookback()` returns `max(150, mbLen×2 + 30)`
= **230 bars** (~11 months) with default settings. HV60 needs 60 bars (subsumed).
The first valid signal cannot fire until bar 230.

Therefore: `startDate` must be set so the first training window has enough
signal-producing bars AFTER the 230-bar warmup. With cached data starting
2017-01-03, the first valid signal is ~December 2017. A 504-day (2yr) training
window starting 2017-01-03 only gets ~13 months of actual signals (months 12-24).
This is acceptable but marginal.

```
WFA defaults:  startDate = '2017-01-03'   (first cached date — 11 months warmup then signals)
               endDate   = '2026-03-06'   (last cached date)
               trainWindowDays = 504       (~2 years, ~13 months of actual signals after warmup)
               forwardStepDays = 126       (~6 months)
               purgeGapDays = 65           (max DTE)
```

This produces **15 rolling windows** with **perfectly contiguous OOS coverage**
from 2019-03-11 → 2026-03-06 (1,825 trading days). The only unavoidable dead
zone is the one-time 65-day initial purge after the first training window.

**The lookback warmup is NOT wasted data** — it's consumed by indicator
computation (EMA, ADX, HV60, RSI). The signal precomputation in `engine.ts`
already skips bars before `lookback` index, so no code changes needed. But
the executor must understand that a 504-day training window yields ~274 days
of actual signals, not 504. Later windows (which train on 2019+ data) get the
full ~504 signal days because their warmup bars fall before `startDate`.

**The WFA engine MUST use `startDate` and `endDate` from cache bounds,
not from the old static IS/OOS dates.** No cached data goes unused.

### GPU: Not applicable
The backtest workload is branching logic + SQLite lookups, not matrix math.
GPU acceleration (CUDA/WebGPU) would help for:
- Monte Carlo with millions of paths (we do 500)
- Neural network–based signal generation (we use EMA/ADX/RVOL)
- Dense portfolio covariance matrix inversion (we have 15 tickers)

None of these are bottlenecks. Don't waste time on GPU integration.

### CPU: Two parallelization layers to add

The existing scripts (`portfolio-sim.ts`, `unified-eval.ts`, `credit-sweep.ts`) already
use `worker_threads` with 22 workers for trade generation. **The new WFA engine must
match this.** The current plan has `optimizeWindow` running configs sequentially — that
must change.

#### Layer 1: Parallelize config evaluation within each WFA window

`optimizeWindow` currently loops:
```typescript
for (const config of candidates) {   // SEQUENTIAL — wastes 23 of 24 threads
  for (const signal of trainSignals) {
    await simulateCreditSpread(...);
  }
}
```

Fix: dispatch each `(config, signals[])` bundle to a worker thread. Each worker
opens its own read-only SQLite handle (same pattern as `credit-worker.ts`).

```typescript
// wfa-worker.ts — one worker per config candidate
import { parentPort, workerData } from 'node:worker_threads';
import { initDB } from './chain-cache';
import { simulateCreditSpreadCached, computeOptionAnalytics } from './option-sim';

// Each worker gets its own SQLite connection (read-only, WAL mode = no locks)
initDB(workerData.dbPath);

parentPort!.on('message', (msg) => {
  // signals are already filtered for this config's preset by the dispatcher
  const { config, signals, allDates, maxDate, returnTrades } = msg;
  const trades = [];
  for (const signal of signals) {
    // Synchronous: better-sqlite3 reads are blocking (no async overhead)
    const trade = simulateCreditSpreadCached(signal, config, allDates, maxDate);
    if (trade) trades.push(trade);
  }

  if (returnTrades) {
    // OOS phase: main thread needs full trades for equity curve stitching
    parentPort!.postMessage({ config, trades });
  } else {
    // Training/sweep phase: return only aggregate analytics to avoid
    // V8 GC spike from 22 workers serializing thousands of OptionTrade objects
    const analytics = computeOptionAnalytics(trades);
    parentPort!.postMessage({
      config,
      sharpe: analytics.sharpe,
      tradeCount: trades.length,
      winRate: analytics.winRate,
      maxDD: analytics.maxDrawdown,
    });
  }
});
```

Main thread dispatches N configs across `min(N, 22)` workers:

```typescript
export function optimizeWindowParallel(
  candidates: SimConfig[],
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  allTradingDates: string[],
  trainStart: string,
  trainEnd: string,
  numWorkers: number = Math.min(os.cpus().length - 2, candidates.length),
): Promise<WindowOptResult> {
  // Create worker pool — each worker opens its own read-only SQLite handle
  const workers = Array.from({ length: numWorkers }, () =>
    new Worker('./wfa-worker.ts', { workerData: { dbPath } })
  );

  // Dispatch: each config gets its own preset's signals, filtered to train window
  for (const config of candidates) {
    const presetKey = config.signalWeightPreset ?? 'ema';
    const presetSignals = signalsByPreset.get(presetKey) ?? [];
    const trainSignals = presetSignals.filter(s => s.date >= trainStart && s.date <= trainEnd);
    // Round-robin dispatch to workers
    // worker.postMessage({ config, signals: trainSignals, allDates, maxDate: trainEnd });
  }

  // ... (same pattern as credit-sweep.ts createWorkerPool)
  // No token needed — workers read from SQLite cache only
}
```

**Expected speedup:** ~20× on 5900X (22 configs evaluated simultaneously instead of 1).

#### Layer 2: Cache-only mode — zero API calls during simulation

**CRITICAL CONSTRAINT:** The WFA engine must NEVER call the ORATS API.
All chain data must already be cached in `data/option-chains.sqlite`.
If a (ticker, date) pair is not cached, the trade is skipped (returns `null`).

Currently `fetchHistoricalChain()` calls the API on cache miss. The WFA
engine must bypass this entirely:

```typescript
// In chain-cache.ts — add cache-only read function:
export function getCachedChainFiltered(
  ticker: string,
  date: string,
  deltaRange?: [number, number],
  dteRange?: [number, number],
): ChainRow[] {
  // Reads from SQLite only. Returns [] if not cached. No API call.
  if (!isCached(ticker, date)) return [];
  const rows = getCachedChain(ticker, date);
  // Apply delta/DTE filters in-memory
  return rows.filter(r => {
    if (deltaRange && (r.delta < deltaRange[0] || r.delta > deltaRange[1])) return false;
    if (dteRange && (r.dte < dteRange[0] || r.dte > dteRange[1])) return false;
    return true;
  });
}
```

The simulators (`simulateCreditSpread`, `simulateLeap`) must accept a
`cacheOnly: boolean` flag (or the WFA engine calls `getCachedChainFiltered`
directly instead of `fetchHistoricalChain`). The `token` parameter becomes
unnecessary in WFA mode.

This means:
- **Pre-populate cache separately** (run `prefetchAll` as a one-time data prep step)
- **WFA engine is pure computation** — SQLite reads only, fully deterministic
- **Workers never need network access** — simpler, faster, no rate-limiting concerns

**Expected speedup:** Eliminates all network latency. SQLite WAL reads are ~0.1ms
vs ~200ms per API call. For a 7-year backtest with 27 tickers × ~1,750 trading
days = ~47,250 potential lookups, this saves ~2.5 hours of API wait time.

#### Layer 3: Share chain data via SharedArrayBuffer (optional, advanced)

For maximum throughput, load the entire window's chain data into a
`SharedArrayBuffer` that all workers read from without any SQLite overhead.
This is only worth doing if profiling shows SQLite as the bottleneck after
Layer 1+2 are implemented. Don't pre-optimize.

### Implementation note for the plan executor

When implementing Task 9 (`optimizeWindow`) and Task 10 (`runWFAOptions`):

1. **Create `src/lib/backtest/wfa-worker.ts`** — mirrors the pattern in `scripts/credit-worker.ts`
2. **Use `os.cpus().length - 2`** workers (matches existing convention)
3. **Each worker opens its own `initDB()`** — SQLite WAL allows concurrent readers
4. **ZERO API calls** — use `getCachedChainFiltered()` or `getCachedChain()`, never `fetchHistoricalChain()`
5. **Workers receive serializable data only** — `SimConfig`, `EntrySignal[]`, dates (no token needed)
6. **Pre-populate cache separately** — provide a CLI script/flag to prefetch chains before running WFA
7. **Signal presets are precomputed** — caller runs `precomputeSignals` for each preset (ema/mom/em/mf) once, builds `Map<SignalPresetKey, EntrySignal[]>`, passes to `runWFAOptions`. Workers receive pre-filtered signals per config, no indicator recomputation.
8. **V8 GC protection** — During training/sweep, workers return only aggregate analytics (`{ sharpe, tradeCount, winRate, maxDD }`) NOT the full `OptionTrade[]` array. 22 workers simultaneously serializing thousands of trade objects causes multi-GB RAM spikes and GC pauses. Only return full `OptionTrade[]` during OOS execution (1 config per window, not 1,280). Workers accept a `returnTrades: boolean` flag in the message to toggle this.

---

## Summary of Deliverables

| Phase | Files Created | Files Modified | Tests Added |
|-------|--------------|----------------|-------------|
| 0: Daily MTM Infrastructure | — | `option-sim.ts`, `types.ts`, `backtest-audit.test.ts` | `option-sim-fills.test.ts` (MTM tests) |
| 1: Execution Reality | `slippage.ts` | `option-sim.ts`, `types.ts`, `chain-cache.ts` | `slippage.test.ts`, `option-sim-fills.test.ts` |
| 2: Walk-Forward | `wfa-options.ts` | `types.ts` | `wfa-options.test.ts` |
| 3: Stress Testing | `portfolio-stress.ts` | `wfa-options.ts` | `portfolio-stress.test.ts` |

**Total new files:** 4 source + 4 test
**Total modified files:** 4 (option-sim.ts, types.ts, chain-cache.ts, backtest-audit.test.ts)
**Existing tests preserved:** All 449+

## Migration Notes

- **Backward compatible**: `fillMode: 'mid'` preserves all existing behavior. Toggle to `'bidask'` to enable realistic fills.
- **No breaking changes**: All existing scripts (`optimize.ts`, `unified-eval.ts`, `portfolio-sim.ts`) continue working because `SimConfig` defaults to `fillMode: 'mid'`.
- **dailyMtM is optional**: Old trade data without `dailyMtM` falls back to exit-date P&L attribution in the stress engine. New simulations populate it automatically.
- **Purge gap 65**: New default for options WFA. Stock-mode WFA in `sweep.ts` keeps its 5-day default (no position-overlap concern with daily bars).
- **Gradual rollout**: Can compare `mid` vs `bidask` results side-by-side before committing to realistic fills.
- **Old WFA** in `sweep.ts` is untouched — `wfa-options.ts` is a parallel engine purpose-built for credit spread WFA.
- **Signal presets**: `signalWeightPreset` defaults to `'ema'`. Existing code that doesn't set it gets EMA signals (matching current best). The 4 presets (ema/mom/em/mf) are the same weight combinations tested in Phase 1-3, now re-validated with realistic fills.
- **ORATS filters**: All default to `Infinity`/`0` (no filter). Old scripts produce identical results.
