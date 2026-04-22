---
task: Phase E3 — DTE5 mega-cap sweep for small-account ($2K) use
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-22T04:00:00-04:00
---

## Objective

Test whether the validated DTE5 bull put credit spread structure (currently live on QQQ only) generalizes to individual mega-cap tickers, in a configuration that fits a $2K account. Pre-registered test: single-ticker basket {AAPL, MSFT, NVDA, GOOG}, maxPositions=1, $5 spread width.

## Motivation

- DTE5 QQQ is the only validated active strategy. PMCC QQQ pt50 just sealed PASS but needs $5K+ per position (too big for $2K).
- User has a 30-ticker watchlist and wants small-account strategies. Individual mega-caps at $5 spread width fit the $2K / 25% per-trade risk budget.
- The campaign tests two things simultaneously: (a) does the DTE5 structure survive on different underlyings, and (b) does the parameter neighborhood (short-δ 0.25/0.30/0.35, width $5/$10) show robust behavior.

## Pre-Registration

**Hypothesis**: A bull put credit spread structure with the DTE5 parameter set (short put δ≈0.30, long put δ≈0.20, DTE 2-7, SL 2.5× credit, trailing lock 50/50, EMA55 trend gate + SPY>EMA200 macro gate + EMA8>EMA13 momentum gate), applied as a first-come-first-served portfolio across {AAPL, MSFT, NVDA, GOOG} with maxPositions=1, earns positive risk-adjusted alpha over SPY across the 2024-01-22 → 2026-02-28 holdout window. The ticker basket is chosen for liquidity (tight bid/ask) rather than any known edge. Width $5 is the anchor (half of QQQ's $10) to fit a $2K account; $10 is included as a robustness variant.

**Config Grid**: 4 variants, all with the same ticker basket, signal gates, and portfolio constraints:

| Variant | Short δ | Width | Role |
|---|---:|---:|---|
| dte5-megacap-anchor | 0.30 | $5 | Anchor |
| dte5-megacap-tight | 0.25 | $5 | Short-delta robustness (lower) |
| dte5-megacap-wide | 0.35 | $5 | Short-delta robustness (upper) |
| dte5-megacap-w10 | 0.30 | $10 | Width robustness |

All variants share: long δ 0.20 (implicit via spread width), DTE 2-7, trailing lock 50/50, SL 2.5×, hold-to-expiry (profitTarget=1.0, no time stop), fillMode=bidask, dynamic slippage. Defined in `scripts/autoresearch/strategy-dte5-megacap.ts`.

**Decision Rule**: Winner = variant with highest **selection-window combinedSharpe** (no holdout peek). Standard decision rule. Seal the winner via `scripts/evaluate-holdout.ts`.

**Adoption Threshold**: The sealed winner's row must satisfy ALL of the following:
- `holdoutSpyIR ≥ 0` (core structural edge over SPY)
- `holdoutSharpe ≥ 0.3` (absolute risk-adjusted floor)
- `oosSharpe ≥ 0.8` (selection-window floor; mirrors DTE5-QQQ and PMCC-pt50 sealed bars)
- `passesStability = true` (holdout/OOS Sharpe ratio ∈ [0.5, 2.0])
- `passesStatConsistency = true` (bootstrap SE vs Mertens SE ratio ≤ 5.0x)
- `deflatedSharpeMertens > 0` (Bailey-López de Prado multiple-testing correction — N=4 variants, modest denominator)

Any violation → seal FAIL, no live adoption. Next step if FAIL: either (a) pre-reg a fresh basket, or (b) accept that DTE5's edge is QQQ-specific and move to structurally different designs.

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## Implementation notes

- Pre-reg's basket of 4 tickers counts as a SINGLE candidate per variant (portfolio-level), not 4 candidates × 4 variants. The sealed metric applies to the portfolio outcome, not to each individual ticker's outcome.
- With maxPositions=1 the portfolio takes only one spread at a time; if two tickers generate signals the same day, the runner's first-come-first-served tie-break selects one. Per-ticker edge is not decomposable from this campaign alone — a follow-up campaign would be needed to test which specific ticker(s) drive the portfolio result.
- $2K notional × 25% max risk per trade = $500 max loss budget. $5-wide spreads have max loss of width×100 − credit ≈ $350-450. $10-wide variant exceeds this budget and is included as a diagnostic only (under $2K it would need to wait for a variant demonstrating enough edge to justify the bigger position size).

## References

- Design spec: `docs/superpowers/specs/2026-04-22-pmcc-qqq-campaign-design.md` (process template)
- Sealed-holdout protocol: `docs/sealed-holdout.md`
- Validated DTE5-QQQ config: `src/lib/strategyProfiles.ts` (STRATEGY_PROFILES.dte5)
- PMCC-pt50 sealed PASS: (on unmerged branch `phase-e2-pmcc-qqq-campaign` / PR #8)
- Strategy file: `scripts/autoresearch/strategy-dte5-megacap.ts`
