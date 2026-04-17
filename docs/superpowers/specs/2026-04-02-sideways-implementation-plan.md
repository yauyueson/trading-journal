> **Post-implementation correction (2026-04-07):** This spec references `computeADX()` using "Wilder's smoothing" with true range from OHLC data. The actual implementation uses close-only prices (no OHLC available from option chain snapshots), producing a directional movement metric that is NOT Wilder ADX. Function renamed to `computeCloseOnlyTrend()`. Thresholds (18/20/25) were WFA-optimized against this metric. See report caveats.

# Implementation Plan: Sideways Iron Condor / Butterfly Strategy

**Spec:** `docs/superpowers/specs/2026-04-02-sideways-iron-condor-butterfly-design.md`
**Pattern:** Follows `bearCallStudy()` in `scripts/short-put-1dte.ts` (line 4102+)

---

## Overview

All work happens in `scripts/short-put-1dte.ts` — extend the existing infrastructure with a new `sidewaysStudy()` function. No changes to the core engine (`option-sim.ts`, `chain-cache.ts`, etc.) because iron condors are composed from two credit spreads that the existing `runStrategy()` already knows how to simulate.

**Key insight:** An iron condor is a bull put spread + bear call spread opened on the same day. Rather than building 4-leg simulation from scratch, we run two `runStrategy()` calls per trade date (one bull put, one bear call) and merge the P&L. This reuses 100% of the existing entry/exit/pricing code.

---

## Task Breakdown

### Task 1: ADX(14) Indicator

**File:** `scripts/short-put-1dte.ts`
**Where:** Add after the existing `compute20DayLow()` function (~line 354)

Add `computeADX(period: number)` function:
- Input: `dailyCloses` Map (already computed for each ticker)
- Uses Wilder's smoothing: TR → +DI/-DI → DX → ADX
- Since we only have close prices (no OHLC from chains), use `|close - prevClose|` as TR proxy — same approach already used by `computeATRProxy()` (line 301)
- Returns `Map<string, number>` (date → ADX value, 0-100 scale)

**Test:** ADX should be ~15-25 during range-bound periods, >25 during trends. Spot-check against known choppy periods (mid-2020, mid-2023).

---

### Task 2: Sideways Regime Gate

**File:** `scripts/short-put-1dte.ts`
**Where:** Inside the new `sidewaysStudy()` function, as entry filter logic

The gate checks three conditions per (ticker, date):
1. `close < EMA34` — not in bull regime
2. NOT(`EMA21 < EMA34 < EMA55`) — not in bear regime  
3. `ADX(14) < adxThreshold` — confirmed range-bound

This uses the existing `computeEMA()` function (line 285) for EMA21/34/55, plus the new `computeADX()` from Task 1.

**Implementation:** Add a `isSidewaysRegime(date, close, ema21, ema34, ema55, adx, adxThreshold)` helper that returns boolean.

---

### Task 3: Iron Condor / Butterfly Simulation via Paired Spreads

**File:** `scripts/short-put-1dte.ts`
**Where:** New `runIronCondorStrategy()` function

**Approach:** For each trade date that passes the sideways gate:
1. Run `runStrategy()` with `direction: 'bull'` (bull put spread leg) — short put at target delta
2. Run `runStrategy()` with `direction: 'bear'` (bear call spread leg) — short call at target delta
3. Both legs share: same entry date, same DTE target, same wing width, same profit target, same delta stop
4. Merge results: combined PnL = put leg PnL + call leg PnL
5. Track as single "iron condor" trade for reporting

**Iron butterfly variant:** Set short delta = 0.50 for both legs (ATM). Same code path, just a config value.

**Config interface** — extend `ShortPut1DTEConfig`:
```typescript
structure?: 'credit_spread' | 'iron_condor' | 'iron_butterfly';
adxThreshold?: number;
sidewaysMode?: boolean;  // enables negation gate + ADX
```

**Exit handling:**
- Profit target: checked on combined spread cost (put leg cost + call leg cost vs total credit)
- Delta stop: exit if EITHER short strike delta exceeds threshold
- Hold-to-expiry: both legs expire together (same DTE)

**Key detail:** Position sizing uses the iron condor's max loss = MAX(put leg max loss, call leg max loss), NOT the sum. Only one side can be ITM at expiry.

---

### Task 4: WFA Wrapper for Sideways

**File:** `scripts/short-put-1dte.ts`
**Where:** New `runSidewaysWFAPortfolio()` function, modeled on `runWFAPortfolio()` (line 3484)

Same structure as existing:
- Rolling windows: 252d train / 126d test
- Equity carries forward across windows
- Each window calls `runIronCondorStrategy()` instead of `runStrategy()`
- Returns same result shape: `{ windows, finalEquity, oosSharpe, oosCagr, oosMaxDD, ... }`

**Cache-only enforcement:** The existing `runStrategy()` reads from `data/option-chains.sqlite` directly via better-sqlite3. It never calls ORATS API — API calls only happen in `chain-cache.ts` fetch path which `runStrategy()` doesn't use. So cache-only is already guaranteed by the architecture. Add a log line confirming zero API calls at the end.

---

### Task 5: Config Grid & Sweep

**File:** `scripts/short-put-1dte.ts`
**Where:** Inside `sidewaysStudy()` function

```
TICKERS (3):           QQQ, SPY, IWM
STRUCTURES (2):        iron_condor, iron_butterfly
SHORT DELTA condor (3): 0.20, 0.25, 0.30  (butterfly fixed at 0.50)
WING WIDTH (2):        $5, $10
ADX THRESHOLD (3):     18, 20, 25
PROFIT TARGET (3):     0.50, 0.80, 1.00
DELTA STOP (3):        none (Infinity), 0.50, 0.60
RISK TIERS (4):        5%, 10%, 15%, 20%
```

Condor: 3 × 2 × 3 × 3 × 3 = 162/ticker
Butterfly: 1 × 2 × 3 × 3 × 3 = 54/ticker
**Total per risk tier: 216/ticker × 3 tickers = 648**
**Total with risk tiers: 648 × 4 = 2,592** (but risk tiers only matter for portfolio phase)

**Phase A** (standalone): Run at 10% risk only → 648 configs
**Phase B** (portfolio): Best config per ticker at 4 risk tiers → small number of combos

---

### Task 6: Report Generation — Phase A (Standalone Sweep)

**File:** `scripts/short-put-1dte.ts`
**Where:** Inside `sidewaysStudy()`, after sweep loop

For each ticker, output:
- Top 5 configs by Sharpe (table: structure, delta, width, ADX, TP, deltaStop, Sharpe, CAGR, MaxDD, WR, Final$, Trades)
- ADX threshold impact (average Sharpe across configs per ADX value)
- Structure comparison (iron condor avg vs iron butterfly avg)

---

### Task 7: Report Generation — Phase B (Portfolio Combinations)

**File:** `scripts/short-put-1dte.ts`
**Where:** Inside `sidewaysStudy()`, after Phase A

Use `runCombinedWFAPortfolio()` pattern from bear study (line ~4392):
- Shared equity pool, both/all legs size from same running equity
- Test these combos:
  1. Bull only (baseline from bear report: Sharpe 0.687)
  2. Bull + bear (baseline: Sharpe 0.985)
  3. Bull + sideways (each ticker)
  4. Bull + bear + sideways (best per ticker)
  5. Bull + bear + all 3 sideways (full portfolio)

Window-by-window breakdown for best combo.

---

### Task 8: Report Generation — Phase C (Risk Tiers + Final Report)

**File:** `scripts/short-put-1dte.ts`
**Output:** `backtesting history/credit-spread/reports/sideways-strategy/README.md`

Sections:
1. Study Design
2. Standalone Results — Top 5 per ticker
3. ADX Threshold Impact
4. Structure Comparison (condor vs butterfly)
5. Portfolio Combinations
6. Window-by-Window for best combo
7. Risk Tier Comparison (5/10/15/20%)
8. Year-by-Year Breakdown
9. Caveats

Also save raw JSON to `backtesting history/credit-spread/reports/sideways-strategy/sideways-results.json`.

---

## Execution Order

```
Task 1 (ADX indicator)          ~30 min
Task 2 (regime gate)            ~15 min
Task 3 (iron condor sim)        ~1.5 hr  ← largest task
Task 4 (WFA wrapper)            ~30 min
Task 5 (config grid)            ~20 min
Task 6 (Phase A report)         ~30 min
Task 7 (Phase B portfolio)      ~45 min
Task 8 (Phase C final report)   ~30 min
```

Tasks 1-2 are prerequisites for everything. Task 3 is the core work. Tasks 4-5 wire it into WFA. Tasks 6-8 are report generation.

**Backtest runtime:** ~30-45 min for Phase A (648 configs × ~16 windows on 13 workers). Phase B portfolio combos are fast (<5 min, small number of configs).

---

## Files Modified

| File | Change |
|------|--------|
| `scripts/short-put-1dte.ts` | Add `computeADX()`, `isSidewaysRegime()`, `runIronCondorStrategy()`, `runSidewaysWFAPortfolio()`, `sidewaysStudy()` |
| `backtesting history/credit-spread/reports/sideways-strategy/README.md` | New — study results |
| `backtesting history/credit-spread/reports/sideways-strategy/sideways-results.json` | New — raw data |

## Files NOT Modified

- `src/lib/backtest/option-sim.ts` — no changes needed (paired spread approach)
- `src/lib/backtest/chain-cache.ts` — no changes (reads only)
- `src/lib/backtest/bsm-pricing.ts` — no changes
- `scripts/wfa-run-unified.ts` — not used (study runs via short-put-1dte.ts pattern)

## Risks

1. **Paired spread approach** may have subtle timing differences vs true 4-leg entry (e.g., if bull put finds DTE=5 but bear call finds DTE=6 on same date). Mitigation: both legs use identical DTE target and the engine selects nearest available — should match in >95% of cases.
2. **ADX from close-only prices** is an approximation (no true high/low). Same limitation as existing ATR proxy. Functional for regime classification.
3. **Max loss calculation** for position sizing: `MAX(put_width, call_width)` assumes only one side can be ITM. This is correct for same-expiry iron condors but verify the engine doesn't double-count margin.
