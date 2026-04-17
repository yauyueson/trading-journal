> **Post-implementation correction (2026-04-07):** ADX references in this spec are actually a close-only directional metric (not Wilder ADX). See `computeCloseOnlyTrend()` in `scripts/short-put-1dte.ts`.

# Calendar Spread Strategy -- Regime-Aware

**Date:** 2026-04-03
**Status:** Design approved, pending implementation
**Predecessor:** Sideways iron condor study (killed -- OOS Sharpe 0.112/-.119/.315 under true WFA)

---

## Problem

Bull+bear portfolio (Sharpe 0.985) has idle periods when neither regime gate is active. Iron condors/butterflies failed WFA validation. Calendar spreads exploit a fundamentally different edge -- theta differential across expirations -- and may succeed where neutral strategies failed.

## Structure

Sell near-term option, buy far-term option at the same strike (pure calendar spread). Net debit trade -- pay upfront, profit if the spread widens as near-term decays faster.

**Exit:** Close both legs at near-term expiry. No rolling.

## Regime Matching

| Regime | Gate | Calendar Type | Logic |
|--------|------|--------------|-------|
| Bull | close > EMA34 | Put calendar | Short near-term put + long far-term put. Profits if underlying stays above strike. |
| Bear | EMA21 < EMA34 < EMA55 | Call calendar | Short near-term call + long far-term call. Profits if underlying stays below strike. |
| Sideways | NOT bull AND NOT bear AND ADX(14) < threshold | Put or call (swept) | Profits from pinning near strike. |

## DTE Pairings (swept)

| Short Leg DTE | Long Leg DTE Options |
|---------------|---------------------|
| 5 | 14, 21, 30, 45 |
| 7 | 14, 21, 30, 45 |
| 14 | 21, 30, 45 |

15 valid pairings (short < long).

## Parameters Swept per Window

| Parameter | Values | Notes |
|-----------|--------|-------|
| DTE pairing | 15 combos | Short=[5,7,14] x Long=[14,21,30,45], short < long |
| Strike delta | 0.30, 0.40, 0.50 | 0.50 = ATM, 0.30 = OTM |
| ADX threshold | 18, 20, 25 | Sideways regime only |
| Calendar type | put, call | Sideways regime only (bull=put, bear=call fixed) |

**Config space per ticker per window:**
- Bull regime: 15 DTE x 3 deltas = 45
- Bear regime: 15 DTE x 3 deltas = 45
- Sideways regime: 15 DTE x 3 deltas x 3 ADX x 2 types = 270
- Combined: ~315 configs (all regimes active simultaneously, each config specifies which regime it operates in)

## Fixed Parameters

| Parameter | Value |
|-----------|-------|
| Risk sizing | 10% of equity per trade |
| Max concurrent | 1 per ticker |
| Commission | $0 (Robinhood) |
| Tickers | QQQ, SPY, IWM |
| Exit | Close both legs when near-term expires |
| Compounding | Yes (size from current equity) |

## WFA Methodology

True per-window train/test optimization (same as rebuilt sideways WFA):
- 252d train / 126d test, rolling windows (~16 windows)
- Train: sweep all ~315 configs, select best by Sharpe (min 5 trades)
- OOS: run ONLY selected config with real equity carried forward
- No look-ahead, no data leakage

## Entry Mechanics

1. Check regime gate for current (ticker, date)
2. Fetch chain for trade date -- already has 20-40+ expirations
3. Find near-term expiration closest to target short DTE
4. Find far-term expiration closest to target long DTE
5. Find strike at target delta in the NEAR-term chain (delta lookup)
6. Look up same strike in the far-term chain
7. Compute debit: far-term mid - near-term mid (worst-side: buy far at ask, sell near at bid)
8. If debit > 0 and within risk budget, enter

## Exit Mechanics

At near-term expiry date (or closest available monitoring date):
1. Near-term leg: expires or close at market (intrinsic for expired, market for pre-expiry)
2. Far-term leg: sell at market (bid price -- still has time value)
3. P&L = (far-term sell price - near-term close cost) - initial debit
4. Calendar profits when: underlying stayed near strike AND far-term retained more value than near-term cost

## Max Loss

Max loss = initial debit paid. Calendar is a debit spread -- you can't lose more than you paid.

## Data Constraint

Cache-only, zero ORATS API calls. Multi-expiry chains already in SQLite:
- 44.3M rows, 20-40+ expirations per trade date per ticker
- `findContractDirect()` supports arbitrary (ticker, date, strike, expiry) lookups
- No infrastructure gaps

## Engine Changes

All in `scripts/short-put-1dte.ts`:

1. **`findCalendarLegs()`** -- given chain + target delta + near/far DTE, find both legs at same strike across two expirations
2. **`runCalendarStrategy()`** -- day-by-day simulation: regime gate, entry, hold, exit at near-term expiry
3. **`runCalendarWFA()`** -- reuse `runSidewaysWFAProper` pattern with calendar config grid
4. **`calendarStudy()`** -- Phase A (per-ticker WFA) + Phase B (portfolio combos) + report

## Success Criteria

1. OOS Sharpe > 0 for at least one ticker under true WFA
2. Combined portfolio (bull + bear + calendar) improves Sharpe vs bull+bear baseline (0.985)
3. MaxDD of calendar leg < 40%
4. No API calls
