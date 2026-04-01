# Tier 1 Research Plan — Validate Before Committing

**Goal:** Test 3 enhancements to the DTE5 bull+bear portfolio. Each must prove it helps on the same WFA methodology (16 rolling windows, 2017-2026, shared $10K equity) before going live.

**Baseline to beat:** QQQ bull + QQQ/SPY/IWM bear = Sharpe 0.985, CAGR 39.9%, MaxDD 47.9%

**Success criteria per enhancement:**
- Combined portfolio Sharpe >= 1.0 (improvement over 0.985)
- No single enhancement increases MaxDD by more than 5pp
- At least 20 trades over the test period (statistical relevance)
- Positive contribution in at least 10/16 windows

---

## Experiment A: More Bear Tickers (GLD, TLT)

**Hypothesis:** Gold and bonds trend differently from equities. Adding GLD/TLT bear call spreads fills gaps when QQQ/SPY/IWM bears aren't firing, improving diversification.

**Why GLD + TLT (not XLF, SMH):**
- ORATS chain data already available for GLD and TLT
- XLF and SMH have no IV snapshot infrastructure — would need data pipeline work
- GLD and TLT are uncorrelated to equity indices (true diversifiers)
- Both have liquid weekly options

**Method:**
1. Run the bear call spread WFA sweep on GLD and TLT independently
   - Same 240-config grid as the original bear study:
     - 8 proximity filters × 6 spread configs × 2 rally filters = ~96 combos per ticker (reduced from 240 since some spreads won't make sense for lower-priced underlyings)
   - Adjust spread widths for price level: GLD ~$290, TLT ~$90
     - GLD: sp40/30, sp30/20, sp25/15
     - TLT: sp15/05, sp10/05, sp20/10 (narrower — lower price)
2. Find best standalone config per ticker (highest Sharpe with MinEq > $5K)
3. Add best GLD/TLT configs to the existing 4-ticker portfolio (QQQ bull + QQQ/SPY/IWM/GLD/TLT bear)
4. Run combined portfolio growth sim with shared $10K equity

**Go/no-go:** If adding GLD or TLT improves combined Sharpe AND doesn't increase MaxDD by >5pp, add it. Otherwise skip.

**Script:** Extend `scripts/wfa-full-sweep.ts` to accept GLD/TLT ticker configs.

**Estimated runtime:** ~2-4 hours (ORATS chain fetch for new tickers + WFA sweep)

---

## Experiment B: IV Regime Filter

**Hypothesis:** The strategy underperforms in low-IV environments (credit received is too small to justify risk). Filtering trades by IV Rank improves risk-adjusted returns.

**Why IV Rank (not VIX):**
- IV Rank is already computed per-ticker from ORATS data (IV30 percentile over 252 days)
- VIX would require a new data pipeline — unnecessary when per-ticker IV Rank is more precise
- The original optimization report found IV >= 30% filter improved Sharpe by 58%

**Method:**
1. Take the current best configs for all tickers (QQQ bull sp30/20, QQQ/SPY/IWM bear)
2. Run the same WFA with an IV Rank gate at 4 thresholds: [0, 15, 25, 35]
   - IV Rank 0 = no filter (current baseline)
   - IV Rank 15/25/35 = skip trade if ticker IV Rank below threshold
3. Compare portfolio-level Sharpe, CAGR, MaxDD, and trade count at each threshold
4. Check window-by-window: does the filter help consistently or just in specific regimes?

**Go/no-go:** If IV Rank >= X improves Sharpe without cutting trade count below 50% of baseline, adopt it.

**Script:** Add `minIVRank` parameter to the bear signal evaluation in `wfa-full-sweep.ts`. The bull side already has this (set to 0).

**Estimated runtime:** ~1 hour (4 runs of existing portfolio sim with different IV gates)

---

## Experiment C: Entry Timing Analysis

**Hypothesis:** Entering at market open vs close affects fill quality and P&L on DTE5 spreads.

**Why this matters:**
- DTE5 spreads are held ~5 days. Entry price at open vs close of signal day could differ by 5-15% of credit received
- Theta decay accelerates into close — entering earlier captures more theta
- But open has wider bid-ask spreads (worse fills)

**Method:**
This is an analysis task, not a WFA sweep. Two approaches:

**Approach 1 (Historical, uses existing data):**
1. For each trade in the existing WFA results, record the entry date
2. Look up the chain data at that date — compare open-proxy (first 130M bar) vs close prices
3. Calculate the credit differential: how much more/less credit would you get entering at different times?
4. Re-run P&L for each trade with adjusted entry credits

**Approach 2 (Prospective, requires live monitoring):**
1. Add logging to `cron-signal-scan.js` to record bid/ask at signal time (currently runs 21:00 UTC = near close)
2. Add a morning scan (e.g., 14:30 UTC = 30 min after open) to capture open-period pricing
3. After 30+ signal days, compare: is afternoon consistently better/worse than morning?

**Go/no-go:** If the entry timing delta is > 10% of average credit received, it's worth optimizing. If < 5%, it doesn't matter — stick with current close-of-day entry.

**Script:** New analysis script (`scripts/entry-timing-analysis.ts`) that reads chain cache + existing WFA trade dates.

**Estimated runtime:** ~30 min for historical analysis, 1-2 months for prospective data collection.

---

## Execution Order

| # | Experiment | Effort | Dependencies | Priority |
|---|-----------|--------|-------------|----------|
| 1 | **B: IV Regime Filter** | ~1 hr runtime, minimal code | None — uses existing configs | Highest (cheapest test) |
| 2 | **A: More Bear Tickers** | ~4 hrs runtime, needs ORATS data fetch | Chain data for GLD/TLT | Second (biggest potential upside) |
| 3 | **C: Entry Timing** | 30 min historical + ongoing prospective | Trade date data from WFA | Third (likely smallest impact) |

**After all 3:** Combine winning enhancements into a single portfolio sim and run the full WFA to get the final combined Sharpe/CAGR/MaxDD. Compare to baseline.

---

## What "helping" means (quantitatively)

| Metric | Baseline | Target | Reject if |
|--------|----------|--------|-----------|
| Sharpe | 0.985 | >= 1.05 | < 0.95 |
| CAGR | 39.9% | >= 42% | < 35% |
| MaxDD | 47.9% | <= 48% | > 55% |
| Trade count | 809 | >= 600 | < 400 |
| Positive windows | ~13/16 | >= 13/16 | < 11/16 |
