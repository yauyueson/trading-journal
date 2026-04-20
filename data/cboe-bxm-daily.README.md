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
