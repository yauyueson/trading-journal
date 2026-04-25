# Liquidity eligibility scorecard

Generated: 2026-04-25T15:45:50.988Z

Universe: 30 cached tickers · monthly snapshots 2018-01-02 → 2026-02-02 (98 total)

## Critical caveats

### Cache coverage gap (READ FIRST)

The chain SQLite was populated by various WFA studies that fetched **only the DTE windows their target strategy needed**. Many tickers have full data for DTE 60+ (PMCC short / mid-DTE) but are sparse or missing in DTE 30-60 (BCD) and DTE 240+ (PMCC LEAP).

"DTE coverage" columns below show, for each ticker, the % of in-cache snapshots that have **any** chain row in the relevant DTE window. A ticker with `bcd-dte-cov 12%` but `withData 100%` is **infrastructure-limited, not market-illiquid** — backfilling ORATS chains would change its tier.

Tier rankings should be read as: "what we can trade *given the current cache*". A separate chain backfill pass is implied for any ticker we want to promote later.

### Other caveats

- **Earnings calendar coverage is OUT of scope for v1.** Single-name event risk is unmodeled here. Treat single-name BCD/PMCC results as upper bounds.
- **Sector ETFs (XLK / XLF / XLV / XLY / XLE / XLI / XLP) are NOT in the cache.** Adding them requires a separate ORATS chain fetch + Supabase ingest. Tracked as a follow-up.
- Snapshot cadence is monthly (first trading day of each month). Day-to-day tradability noise is not measured — this is a *macro* eligibility scorecard, not a microstructure one.
- "BCD eligibility" requires both legs in the SAME expiry (mirrors `makeDebitSpreadEvaluator`).
- "PMCC eligibility" requires both legs found in their respective DTE windows (independent expiries).
- IPO-recent tickers (ARM, COIN, HOOD, PLTR) have shorter `withData` denominators — interpret tradability % relative to coverage.

## BCD rotation tier (long δ 0.50 + short δ 0.20, DTE 30-60)

| Tier | Ticker | DTE 30-60 cov | Tradable % | Coverage | Med Px | Long OI | Short OI | Long spread% | Short spread% | Score |
|:-:|--------|--------------:|-----------:|---------:|-------:|--------:|---------:|-------------:|--------------:|------:|
| A | AMD | 100.0% | 100.0% | 98/98 | $91 | 9416 | 8143 | 1.2% | 1.8% | 4938 |
| A | MSFT | 100.0% | 100.0% | 98/98 | $259 | 9495 | 8009 | 1.3% | 2.3% | 4933 |
| A | AAPL | 100.0% | 99.0% | 98/98 | $184 | 21684 | 23285 | 1.2% | 1.4% | 4889 |
| A | JPM | 100.0% | 100.0% | 98/98 | $137 | 6109 | 6577 | 2.2% | 3.4% | 4889 |
| A | META | 100.0% | 100.0% | 86/98 | $291 | 4752 | 3653 | 1.0% | 2.0% | 4703 |
| A | ORCL | 100.0% | 100.0% | 98/98 | $79 | 3991 | 3852 | 2.5% | 5.2% | 3892 |
| A | NVDA | 100.0% | 100.0% | 98/98 | $225 | 3557 | 2261 | 1.0% | 1.7% | 3521 |
| A | IWM | 100.0% | 100.0% | 98/98 | $187 | 3216 | 3662 | 0.7% | 1.8% | 3195 |
| B | CRM | 76.5% | 76.5% | 98/98 | $211 | 3441 | 2736 | 2.2% | 3.5% | 2577 |
| A | BA | 100.0% | 100.0% | 98/98 | $212 | 2315 | 2331 | 1.9% | 4.0% | 2269 |
| A | TSLA | 100.0% | 100.0% | 98/98 | $317 | 2260 | 2177 | 0.9% | 2.1% | 2239 |
| D | UBER | 34.6% | 34.6% | 81/98 | $44 | 9032 | 13529 | 2.1% | 3.8% | 1693 |
| A | CRWD | 100.0% | 100.0% | 79/98 | $200 | 906 | 794 | 2.4% | 4.8% | 884 |
| A | AMZN | 100.0% | 100.0% | 98/98 | $1558 | 794 | 1214 | 1.2% | 1.9% | 784 |
| A | GS | 100.0% | 100.0% | 86/98 | $343 | 716 | 474 | 2.0% | 4.3% | 702 |
| A | NFLX | 100.0% | 100.0% | 86/98 | $461 | 693 | 502 | 1.6% | 3.6% | 682 |
| A | AVGO | 100.0% | 100.0% | 98/98 | $348 | 681 | 510 | 2.4% | 5.6% | 665 |
| D | COIN | 37.9% | 37.9% | 58/98 | $197 | 1582 | 1249 | 2.4% | 4.8% | 586 |
| A | PANW | 100.0% | 100.0% | 98/98 | $234 | 558 | 561 | 3.0% | 7.2% | 541 |
| A | COST | 100.0% | 100.0% | 86/98 | $503 | 505 | 386 | 2.4% | 5.1% | 492 |
| A | LULU | 100.0% | 100.0% | 98/98 | $307 | 410 | 397 | 2.5% | 5.6% | 400 |
| A | SHOP | 100.0% | 100.0% | 98/98 | $147 | 396 | 349 | 3.4% | 5.9% | 382 |
| A | GOOG | 100.0% | 100.0% | 96/98 | $1084 | 360 | 688 | 2.0% | 4.3% | 353 |
| D | PLTR | 4.7% | 4.7% | 64/98 | $23 | 6117 | 9043 | 1.9% | 6.8% | 230 |
| A | ANET | 100.0% | 100.0% | 98/98 | $218 | 211 | 125 | 5.6% | 10.5% | 199 |
| B | NOW | 100.0% | 100.0% | 98/98 | $488 | 179 | 121 | 3.8% | 10.2% | 172 |
| C | MSTR | 100.0% | 100.0% | 98/98 | $259 | 31 | 22 | 10.0% | 19.2% | 28 |
| D | HOOD | 0.0% | 0.0% | 54/98 | $18 | — | — | — | — | 0 |
| D | VRT | 0.0% | 0.0% | 70/98 | $26 | — | — | — | — | 0 |
| D | ARM | 0.0% | 0.0% | 29/98 | $127 | — | — | — | — | 0 |

Tier definitions:
- **A** — Tradable ≥80% of in-cache snapshots, long-leg OI median ≥200, long-leg spread% ≤15%.
- **B** — Tradable ≥60%, OI ≥50, spread% ≤25%.
- **C** — Tradable ≥40% (anything below A/B but still investible).
- **D** — Below C; not viable.

## PMCC sleeve tier (LEAP δ 0.70-0.80 DTE 240-300, short δ 0.20-0.30 DTE 30-45)

| Tier | Ticker | LEAP DTE cov | Short DTE cov | LEAP % | Short % | Both % | Coverage | Med Px | LEAP OI | Short OI | LEAP spread% | Short spread% | Score |
|:-:|--------|-------------:|--------------:|-------:|--------:|-------:|---------:|-------:|--------:|---------:|-------------:|--------------:|------:|
| B | AAPL | 70.4% | 100.0% | 70.4% | 93.9% | 65.3% | 98/98 | $184 | 3878 | 1392 | 0.9% | 2.7% | 2510 |
| B | NVDA | 62.2% | 100.0% | 62.2% | 100.0% | 62.2% | 98/98 | $225 | 941 | 187 | 0.9% | 3.0% | 580 |
| B | MSFT | 68.4% | 100.0% | 68.4% | 99.0% | 68.4% | 98/98 | $259 | 858 | 423 | 1.3% | 4.3% | 579 |
| A | TSLA | 80.6% | 100.0% | 80.6% | 98.0% | 78.6% | 98/98 | $317 | 701 | 228 | 1.1% | 2.9% | 545 |
| B | AMD | 63.3% | 100.0% | 62.2% | 99.0% | 61.2% | 98/98 | $91 | 818 | 337 | 1.4% | 3.7% | 494 |
| A | META | 76.7% | 100.0% | 76.7% | 100.0% | 76.7% | 86/98 | $291 | 543 | 211 | 1.0% | 3.3% | 412 |
| A | AMZN | 72.4% | 100.0% | 72.4% | 95.9% | 70.4% | 98/98 | $1558 | 532 | 102 | 1.0% | 3.6% | 371 |
| B | JPM | 66.3% | 100.0% | 66.3% | 86.7% | 59.2% | 98/98 | $137 | 626 | 122 | 1.7% | 7.0% | 364 |
| B | ORCL | 57.1% | 100.0% | 57.1% | 95.9% | 56.1% | 98/98 | $79 | 365 | 58 | 1.8% | 10.4% | 201 |
| D | UBER | 58.0% | 34.6% | 58.0% | 34.6% | 22.2% | 81/98 | $44 | 883 | 69 | 1.8% | 11.1% | 193 |
| B | GOOG | 60.4% | 100.0% | 60.4% | 97.9% | 58.3% | 96/98 | $1084 | 233 | 35 | 2.4% | 6.6% | 132 |
| B | BA | 60.2% | 100.0% | 60.2% | 100.0% | 60.2% | 98/98 | $212 | 192 | 115 | 2.3% | 7.6% | 113 |
| C | PANW | 45.9% | 100.0% | 45.9% | 100.0% | 45.9% | 98/98 | $234 | 196 | 19 | 3.3% | 14.5% | 87 |
| B | NFLX | 69.8% | 100.0% | 69.8% | 100.0% | 69.8% | 86/98 | $461 | 118 | 32 | 1.7% | 5.9% | 81 |
| C | CRM | 56.1% | 76.5% | 56.1% | 75.5% | 36.7% | 98/98 | $211 | 212 | 60 | 2.1% | 9.4% | 76 |
| B | CRWD | 65.8% | 98.7% | 65.8% | 98.7% | 65.8% | 79/98 | $200 | 107 | 28 | 2.2% | 13.7% | 69 |
| B | SHOP | 54.1% | 100.0% | 54.1% | 100.0% | 54.1% | 98/98 | $147 | 113 | 12 | 2.1% | 14.0% | 60 |
| B | GS | 59.3% | 100.0% | 59.3% | 100.0% | 59.3% | 86/98 | $343 | 75 | 26 | 2.3% | 8.5% | 43 |
| B | AVGO | 59.2% | 100.0% | 59.2% | 100.0% | 59.2% | 98/98 | $348 | 71 | 17 | 2.7% | 9.3% | 41 |
| D | COIN | 62.1% | 37.9% | 62.1% | 37.9% | 20.7% | 58/98 | $197 | 169 | 59 | 2.0% | 8.9% | 34 |
| B | IWM | 99.0% | 100.0% | 99.0% | 100.0% | 99.0% | 98/98 | $187 | 35 | 217 | 1.6% | 2.0% | 34 |
| B | COST | 57.0% | 100.0% | 57.0% | 98.8% | 57.0% | 86/98 | $503 | 51 | 41 | 2.6% | 12.2% | 28 |
| D | PLTR | 67.2% | 4.7% | 60.9% | 4.7% | 1.6% | 64/98 | $23 | 1734 | 984 | 1.8% | 8.7% | 27 |
| C | ANET | 34.7% | 99.0% | 34.7% | 99.0% | 34.7% | 98/98 | $218 | 74 | 5 | 2.6% | 19.4% | 25 |
| C | LULU | 46.9% | 100.0% | 46.9% | 99.0% | 46.9% | 98/98 | $307 | 42 | 16 | 2.6% | 11.7% | 19 |
| D | MSTR | 33.7% | 64.3% | 33.7% | 62.2% | 28.6% | 98/98 | $259 | 38 | 8 | 3.8% | 17.4% | 10 |
| C | NOW | 43.9% | 100.0% | 43.9% | 99.0% | 43.9% | 98/98 | $488 | 24 | 5 | 3.8% | 14.3% | 10 |
| D | HOOD | 53.7% | 0.0% | 51.9% | 0.0% | 0.0% | 54/98 | $18 | 484 | — | 1.9% | — | 0 |
| D | VRT | 41.4% | 0.0% | 37.1% | 0.0% | 0.0% | 70/98 | $26 | 31 | — | 4.9% | — | 0 |
| D | ARM | 72.4% | 0.0% | 72.4% | 0.0% | 0.0% | 29/98 | $127 | 77 | — | 2.9% | — | 0 |

Tier definitions (PMCC is more demanding — adds underlying price floor for $5K LEAP sizing):
- **A** — Both-legs tradable ≥70%, LEAP OI ≥100, LEAP spread% ≤20%, **median underlying price ≥ $75**.
- **B** — Tradable ≥50%, OI ≥30, spread% ≤30%, median price ≥ $75.
- **C** — Tradable ≥30% (price floor relaxed).
- **D** — Below C.

## Recommendations

- **BCD rotation universe (Tier A + B, given current cache)** — 23 tickers: AMD, MSFT, AAPL, JPM, META, ORCL, NVDA, IWM, CRM, BA, TSLA, CRWD, AMZN, GS, NFLX, AVGO, PANW, COST, LULU, SHOP, GOOG, ANET, NOW.
  - Tier C (marginal): MSTR. Investigate why before including.
- **PMCC sleeve universe (Tier A + B, given current cache)** — 18 tickers: AAPL, NVDA, MSFT, TSLA, AMD, META, AMZN, JPM, ORCL, GOOG, BA, NFLX, CRWD, SHOP, GS, AVGO, IWM, COST.
  - Tier C (marginal): PANW, CRM, ANET, LULU, NOW. Likely fail under stricter WFA gates.

### Backfill candidates (cache-limited, not market-limited)

These tickers have full per-day cache data but their **DTE 30-60 window is sparse or missing** — likely because earlier WFA studies fetched only DTE 60+ for them. A targeted ORATS chain backfill at DTE 30-60 would meaningfully change their tier.

- **PLTR** — withData 64/98, DTE 30-60 coverage 5%
- **UBER** — withData 81/98, DTE 30-60 coverage 35%
- **VRT** — withData 70/98, DTE 30-60 coverage 0%

Score formula: `tradability% × clip(medianOI / 100, 0, 50) × (1 − clip(legSpread%, 0, 50%))`. Higher is better. Use it for ranking, not absolute interpretation.