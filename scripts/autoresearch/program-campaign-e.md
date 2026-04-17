# Autoresearch Campaign E — d65 Alpha Expansion

## Your mission (narrow, specific)

Expand alpha around the two **verified winners** from Campaign D:
- **`d65-tp40-ts150`** — combined 1.180, TS 150 extends time stop from 105
- **`d65-sl35-ts105`** — combined 1.188, SL 0.35 loosens stop from 0.30

Both beat the baseline `d65-tp40-ts105` (combined 1.079) by ~10%. Your job is to find any additional alpha in the d65 family neighborhood that the Campaign D static sweep missed.

**You have 10 iterations maximum.** Use them deliberately.

## Scope (hard limits — do not exceed)

- **Stay in the d65 momentum family.** LEAP CALL, δ [0.60, 0.85], DTE [150, 300], 14-ticker champion set.
- **Signal logic is the champion's:** EMA34 MA-touch (0-5%) + SPY>EMA200 + ticker>EMA55 + EMA8>EMA13 + EMA34 rising (5d) + contangoPct<48.
- **Allowed tweaks to signal logic:** tighten/loosen the 0-5% band, adjust proximity scoring, minor gate adjustments (but NOT add RSI, VRP, or new indicator families).
- **Allowed parameter changes:** ts, tp, sl, delta range, DTE range, combinations thereof.
- **Allowed ticker changes:** subsets of the 14-ticker champion set.

## Forbidden

- New option modes (CREDIT_SPREAD, etc.) — different campaign
- New signal families (RSI, VRP, vol gates beyond contango) — Option 3 proved these fail
- Tickers outside the 14-ticker set
- Mid-fill mode
- `monitoringIntervalDays > 1`

## Priority untested combinations (start here)

Campaign D tested 26 variants but did NOT test these combinations of its two winners:

1. **`d65-sl35-ts150`** — BOTH alpha improvements together (sl 0.35 + ts 150). If additive, combined could exceed 1.25. If non-additive (mutually interfering), we learn something.
2. **`d65-sl35-ts135`** — sl 0.35 + intermediate ts 135
3. **`d65-sl35-ts120`** — sl 0.35 + ts 120
4. **`d65-sl33-ts120`** — milder sl loosening (0.33) + ts 120
5. **Signal band tweaks:** 0-3%, 0-4%, 0-6% vs the current 0-5% band

Run these as `configVariants` in your first iteration — 5 variants in one sweep.

## Targets

- Combined Sharpe > Campaign D incumbent (1.180) by ≥ 0.03 to adopt.
- Holdout gate must PASS.
- MaxDD < 35%.
- Deflated Sharpe > 0 under accumulated N (Campaign D left N≈26; you add more).

## Validity (unchanged from Campaign D)

- OOS Sharpe > 0
- OOS trades ≥ 60
- MaxDD ≤ 45%
- Holdout gate PASS (Sharpe ≥ 0.3 OR SPY IR ≥ 0.3)
- Delta gates PASS
- Sanity: OOS Sharpe ≤ 3.0

## Reporting

Append to `journal-campaign-e.md` after each iteration. Include:
- Specific variant(s) tested and why they weren't in Campaign D's grid
- Combined Sharpe / standalone / MaxDD / trades / holdout PASS/FAIL
- Whether the iteration extracted new alpha vs confirmed exhaustion
- Recommendation for next iteration (or "stop" if the neighborhood is clearly exhausted)

## Things you should NOT do

- Don't redo Campaign D's tests (they're already in the seed journal).
- Don't propose "add one more iteration" — the 10-iter cap is hard.
- Don't chase combined Sharpe > 1.30 unless the result is robust across holdout + bootstrap CI.
- Don't report holdout metrics numerically (they're stripped anyway); reference PASS/FAIL only.
