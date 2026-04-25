# BCD per-ticker unconditional decomposition

Generated: 2026-04-25T20:12:36.509Z

## Question

Does single-name BCD have unconditional edge across the 23-name BCD Tier A+B universe? This separates universe-edge from selection-edge from concurrency, before testing another rotation rule.

## Setup

- **Universe:** 23 BCD Tier A+B tickers (post-backfill scorecard, 2026-04-25)
- **Strategy:** BCD F1 verbatim — long δ 0.50, short δ 0.20, DTE 30-60, PT 50%, max hold 45d, min exit DTE 7, bid/ask fills, 10-day cadence
- **Per-ticker capital:** $2,000, maxPositions=1, maxPerTicker=1
- **WFA:** 252/126/10 rolling, 10 selection + 5 holdout windows · holdout boundary 2024-01-22
- **Baseline:** QQQ at the same config — the sealed F1 anchor.

## Per-ticker WFA stats — ranked by holdout Sharpe

Highest holdout Sharpe at top. **Bold** rows beat the QQQ baseline holdout Sharpe.

Baseline (QQQ): selection Sharpe 0.97 / MaxDD 39.8% · holdout Sharpe 1.22 / MaxDD 14.3%.

| Rank | Ticker | sel.Trd | sel.Win% | sel.Shp | sel.DD | sel.PnL | hold.Trd | hold.Win% | hold.Shp | hold.DD | hold.PnL | corr.sel | corr.hold |
|----:|--------|--------:|---------:|--------:|-------:|--------:|---------:|----------:|---------:|--------:|---------:|---------:|----------:|
| 1 | **META** | 50 | 48.0% | 0.58 | 213.2% | $2,598 | 17 | 52.9% | 1.38 | 33.4% | $7,791 | 0.18 | 0.41 |
| 2 | NFLX | 48 | 45.8% | 0.30 | 169.0% | $8,362 | 11 | 45.5% | 1.18 | 36.6% | $4,190 | 0.06 | 0.24 |
| 3 | GS | 53 | 56.6% | 0.76 | 54.4% | $6,895 | 13 | 69.2% | 1.13 | 26.5% | $8,664 | 0.22 | 0.35 |
| 4 | COST | 50 | 66.0% | 0.98 | 48.8% | $12,139 | 17 | 58.8% | 1.02 | 24.4% | $7,203 | 0.28 | 0.21 |
| 5 | JPM | 50 | 56.0% | 0.72 | 36.1% | $3,330 | 20 | 55.0% | 0.88 | 20.7% | $2,503 | 0.13 | 0.25 |
| 6 | GOOG | 20 | 50.0% | 0.53 | 74.6% | $2,118 | 23 | 47.8% | 0.79 | 36.8% | $2,446 | 0.13 | 0.30 |
| 7 | CRWD | 59 | 50.8% | 0.32 | 176.3% | -$169 | 26 | 50.0% | 0.76 | 115.4% | $3,446 | 0.15 | 0.25 |
| 8 | AVGO | 57 | 52.6% | 0.53 | 91.8% | $1,422 | 21 | 52.4% | 0.72 | 67.6% | $2,236 | 0.30 | 0.36 |
| 9 | ORCL | 65 | 44.6% | 0.13 | 45.7% | -$41 | 30 | 46.7% | 0.70 | 63.0% | $1,292 | 0.24 | 0.30 |
| 10 | ANET | 74 | 44.6% | -0.64 | 233.6% | -$4,702 | 30 | 46.7% | 0.60 | 184.5% | $4,810 | 0.09 | 0.12 |
| 11 | TSLA | 27 | 40.7% | -0.48 | 148.3% | $3,807 | 19 | 36.8% | 0.51 | 44.5% | $2,872 | 0.09 | 0.34 |
| 12 | AAPL | 59 | 59.3% | 1.36 | 35.1% | $9,854 | 25 | 52.0% | 0.51 | 13.6% | $2,446 | 0.45 | 0.35 |
| 13 | IWM | 52 | 48.1% | 0.36 | 69.3% | $926 | 21 | 42.9% | 0.42 | 58.2% | $151 | 0.42 | 0.47 |
| 14 | AMD | 52 | 44.2% | -0.42 | 116.4% | $408 | 22 | 31.8% | 0.41 | 83.8% | -$390 | 0.07 | 0.43 |
| 15 | NVDA | 48 | 64.6% | 1.59 | 38.5% | $22,153 | 18 | 55.6% | 0.35 | 6.0% | $1,044 | 0.41 | 0.44 |
| 16 | PANW | 61 | 55.7% | 0.65 | 53.4% | $4,652 | 27 | 33.3% | 0.30 | 34.4% | -$192 | 0.24 | 0.27 |
| 17 | AMZN | 18 | 55.6% | 0.61 | 47.6% | $2,566 | 22 | 40.9% | 0.26 | 32.8% | -$280 | 0.30 | 0.51 |
| 18 | MSFT | 52 | 57.7% | 0.70 | 51.0% | $4,834 | 22 | 36.4% | 0.16 | 47.1% | -$1,054 | 0.57 | 0.46 |
| 19 | SHOP | 35 | 57.1% | 1.06 | 36.4% | $5,887 | 30 | 43.3% | 0.03 | 22.0% | -$245 | 0.09 | 0.38 |
| 20 | BA | 64 | 29.7% | 0.38 | 290.0% | -$9,483 | 29 | 37.9% | 0.00 | 324.6% | -$204 | 0.03 | 0.00 |
| 21 | LULU | 66 | 51.5% | 0.74 | 63.1% | $5,730 | 28 | 32.1% | -0.27 | 67.4% | -$3,709 | 0.32 | 0.23 |
| 22 | NOW | 56 | 51.8% | 0.60 | 76.0% | $2,370 | 6 | 16.7% | -0.34 | 64.7% | -$964 | 0.30 | 0.12 |
| 23 | CRM | 53 | 45.3% | 0.63 | 234.3% | -$2,044 | 1 | 0.0% | -0.75 | 131.0% | -$442 | 0.03 | 0.16 |

## Equal-weight basket (avg of 23 single-ticker BCD daily returns)

| Window | Sharpe | MaxDD | Corr to QQQ |
|--------|-------:|------:|------------:|
| Selection | 0.76 | 89.7% | 0.26 |
| Holdout | 0.76 | 43.1% | 0.48 |

vs QQQ baseline:

| Window | Sharpe | MaxDD |
|--------|-------:|------:|
| Selection | 0.97 | 39.8% |
| Holdout | 1.22 | 14.3% |

## Aggregate counts

- **16 of 23** tickers had positive Sharpe in both selection AND holdout.
- **19 of 23** tickers had positive holdout Sharpe.
- **1 of 23** tickers beat the QQQ baseline holdout Sharpe (1.22).
- Total selection PnL across all 23 tickers: $83,614 · holdout PnL: $43,617.

## PnL bookends

Selection top 5: NVDA $22,153 · COST $12,139 · AAPL $9,854 · NFLX $8,362 · GS $6,895

Selection bottom 5: BA -$9,483 · ANET -$4,702 · CRM -$2,044 · CRWD -$169 · ORCL -$41

Holdout top 5: GS $8,664 · META $7,791 · COST $7,203 · ANET $4,810 · NFLX $4,190

Holdout bottom 5: LULU -$3,709 · MSFT -$1,054 · NOW -$964 · CRM -$442 · AMD -$390

## How to read this

Codex's decomposition logic:

- **If most tickers have poor holdout Sharpe / negative PnL:** single-name BCD is the universe-level problem. Stop rotation research. The earlier rotation v1 negative result was a structural BCD-on-single-names issue, not a momentum-rule issue.
- **If many tickers have positive holdout Sharpe but the rotation rule still failed:** universe has edge, momentum-rank picks bad timing. Selection rules are still alive. Try non-momentum (low-correlation, IV-rank tilt, dispersion) before declaring rotation dead.
- **If equal-weight basket Sharpe is competitive with QQQ AND correlation to QQQ is meaningfully <1.0:** a static "core QQQ + small satellite" book is real. The satellite weight question becomes the next test, not whether to expand at all.

## Caveats

- **No earnings calendar yet.** Single-name losses likely cluster around earnings; this isn't isolated here.
- **$2K capital constraint.** High-priced underlyings (AMZN at $1500+) may not afford every BCD spread the simulator constructs; signals returning null reduce trade counts. The trade-count column shows the actual sample.
- **Daily-MtM correlation is computed over the full window grid** (mostly zeros when both strategies are flat). Interpret as a directional signal, not a precise structural correlation.
- **Equal-weight basket is a paper construct** — running 23 concurrent $2K BCD positions = $46K total capital. Sharpe is unitless so the comparison is honest, but absolute PnL is 23× scale.
