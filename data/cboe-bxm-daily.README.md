# CBOE BXM Daily History

**Source:** `https://cdn.cboe.com/api/global/us_indices/daily_prices/BXM_History.csv`
**Downloaded:** 2026-04-19
**Coverage:** 2002-03-22 through 2026-04-17 (6054 daily closes)

## Columns

| Column | Description |
|---|---|
| `DATE` | US/Eastern calendar date, formatted `MM/DD/YYYY` |
| `BXM` | CBOE BXM Index closing level (total-return, includes dividends) |

## Methodology

CBOE BXM (S&P 500 BuyWrite Index) tracks a hypothetical portfolio:
- Long S&P 500 (cash-settled at the SPX index level)
- Short the at-the-money SPX call option, one cycle per month
- Roll monthly on the Friday morning after the 3rd-Friday expiration

BXM is a **total-return** index — the stock leg's value includes reinvested dividends from the underlying S&P 500 components.

## Use in this repo

`scripts/replicate-bxm.ts` replicates BXM on SPY (as SPX proxy) via `simulateBuyWrite` and compares monthly returns to this series. Correlation ≥ 0.85 validates the Phase 0.c.9 buy-write simulator against an industry benchmark.

SPY is used instead of SPX because our ORATS chain cache covers SPY. Small drift is expected vs the SPX-based BXM from:
- Underlying tracking error (SPY ≈ SPX but not exact)
- Dividend timing (SPY dividends aren't continuous; BXM methodology reinvests)
- Fill differences (our `simulateBuyWrite` uses mid-fill + dynamic slippage; BXM uses a formulaic "first-after-3rd-Friday" settlement).

### Methodology note on dividends (Phase 0.c.9.B)

CBOE BXM is a **total-return index** — dividends are reinvested implicitly. Our replication runs `simulateBuyWrite` without a `dividendSchedule`, which means the stock leg's P&L is the raw price-return of SPY. The ORATS `stock_price` we read IS the raw market close (not dividend-adjusted), so the short call partially offsets the ex-date price drop via its own delta-weighted decline, but the net effect is still price-return-biased by a fraction of SPY's yield.

Empirically, the 2017-2026 replication shows a small positive drift (rep > BXM by ~0.37%/yr) rather than the negative drift a missing-dividends hypothesis alone would predict. That tells us the dividend gap is partially offset by other methodology differences (SPY-vs-SPX tracking, fill model, strike selection). Adding a proper ex-date `dividendSchedule` is a valid future refinement for apples-to-apples comparison; not adding one is acceptable for Phase 0.c.9.B because correlation 0.9665 already well exceeds the 0.85 acceptance bar set for this phase.
