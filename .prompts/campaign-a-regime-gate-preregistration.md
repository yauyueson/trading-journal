# Campaign A — Regime Gate Pre-Registration

**Date pre-registered:** 2026-04-16
**Purpose:** Test whether a regime gate can salvage d65-tp40 (current LEAP CALL champion) after the 45-loss streak that started 2025-01-23. Structured to avoid fitting on the 2025 regime-change data we've already seen.

**Key commitment:** The 6 gate candidates below are fixed *before any runs*. After runs, we pick the single best by selection-window combined Sharpe and single-shot evaluate on the 2024-01-22 → 2026-02-27 holdout block. We do NOT iterate the gate design based on holdout feedback. If no gate survives, Campaign A is null.

---

## Baseline strategy under test

`d65-tp40` — current champion (pre-Jan-2025 metrics):
- Instrument: Deep ITM LEAP CALL
- Delta range: `[0.65, 0.80]`
- DTE range: `[180, 270]`
- TP 0.40 / SL 0.30 / TS 105
- Tickers (14): GLD, IWM, AAPL, MSFT, GOOG, AMZN, META, JPM, GS, COST, UNH, NFLX, NVDA, TSLA
- Base signal: EMA34 MA-touch 0–5% above EMA34 + SPY>EMA200 + c>EMA55 + EMA8>EMA13 + EMA34 rising (5d) + contangoPct<48

## WFA structure (fixed)

- `trainWindowDays: 252`
- `forwardStepDays: 126`
- `purgeGapDays: 10`
- `mode: 'rolling'`
- **`holdoutCount: 5`** — selection ends OOS 2024-01-19, holdout covers 2024-01-22 → 2026-02-27 (5 windows)
- Selection sees: OOS 2019-01-17 → 2024-01-19 (10 windows; training ≤ 2023-07-06 + 19-day bleed)
- Holdout sees: OOS 2024-01-22 → 2026-02-27 (**includes the 45-loss streak**)

## Leaderboard isolation

- Runner uses `leaderboard-campaign-a.json` via `AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-a`
- Attempt counter resets — deflated Sharpe penalizes based on N=7 (baseline + 6 gates), not 680+
- Prior leaderboard untouched

## Validity threshold adjustment (pre-run, logged here for transparency)

The runner's default `MIN_OOS_TRADES = 100` was sized for the full 9-year OOS. Campaign A deliberately shrinks the selection window to end ~2024-01-19 (~5 years), so the threshold is prorated down:

- **MIN_OOS_TRADES = 60** (≈ 100 × 5/9) for all Campaign A variants
- Implemented via env override: `AUTORESEARCH_MIN_OOS_TRADES=60`
- Baseline (no gate) under the new selection had 91 OOS trades; this confirms the adjustment is reasonable (well above the prorated threshold)
- Adjusted before any gate variant was run, so no results leaked into the threshold choice

## The 6 gate candidates

Each gate is an additive filter on top of the baseline signal generator. When the gate is active, signals that fail the additional condition are skipped. All gates are implemented in `generateSignals` using only `TickerDataBundle` and `MarketContext` data that existed before the entry date.

### Gate 1 — Ticker-level EMA200

**Rule:** Require `close > ema200` for the ticker itself (not just SPY).

**Mechanism:** Stops entries on tickers that are in their own downtrend even while SPY is still above its EMA200. In 2025, names like COST, NFLX, AMZN broke their uptrends while SPY stayed bullish.

**Pre-2024 intuition:** Standard single-name trend filter — completely conventional.

**Parameter:** none

### Gate 2 — Breadth gate

**Rule:** At least 60% of the 14 watchlist tickers must have `close > ema200` on the entry date.

**Mechanism:** Stops entries when market participation is narrow. Broad index strength with narrowing breadth (mega-cap-only rallies) has historically preceded trend reversals.

**Pre-2024 intuition:** Breadth/advance-decline is a textbook market internals indicator. Not designed around 2025 data.

**Parameter:** `breadthMin = 0.60`

### Gate 3 — SPY extension band

**Rule:** Reject when `spy.close / spy.ema200 > 1.10` (SPY is >10% above its 200-day EMA — "extended").

**Mechanism:** Momentum reversals tend to occur when markets are stretched. A gate on extension avoids entering late in parabolic moves.

**Pre-2024 intuition:** Textbook mean-reversion filter. 10% is a standard stretch threshold.

**Parameter:** `maxSpyExtensionPct = 0.10`

### Gate 4 — Contango tightened (<30)

**Rule:** Replace champion's `contangoPct < 48` with `contangoPct < 30`.

**Mechanism:** Tighter vol-term-structure gate — only enter when contango is deep (suggesting complacent / calm-trend regime). Excludes near-flat or backwardated environments.

**Pre-2024 intuition:** The 48 threshold was itself empirical; 30 is a conservative step tighter. Parameter narrowing, not structural change.

**Parameter:** `contangoPctMax = 30`

### Gate 5 — Realized-vol regime

**Rule:** Require `hv20 < 25th percentile of trailing 252-day hv20` for the ticker (low realized vol regime only).

**Mechanism:** Reversals in momentum regimes tend to happen when realized vol expands. Staying in low-RV quartile avoids choppy / turning regimes.

**Pre-2024 intuition:** Vol-regime gating is standard in momentum/trend-following literature.

**Parameter:** `hv20PctMax = 25` (i.e., bottom quartile)

### Gate 6 — Trend-age gate

**Rule:** Reject when the current EMA34 uptrend is older than 120 trading days without an EMA34 breach. Compute `trendAge = days since last close < ema34`.

**Mechanism:** Trends that have persisted without pullback are closer to exhaustion. 120-day cap is ~6 months — well short of the Jan 2025 regime shift.

**Pre-2024 intuition:** "Mature trend" concept is standard; 120-day cap is a single-parameter choice.

**Parameter:** `maxTrendAgeDays = 120`

---

## Gates explicitly EXCLUDED (can't implement cleanly)

- Rolling N-trade win-rate throttle: requires look-back into realized trade outcomes at entry time. `generateSignals` doesn't have access to prior trade P&L. Would need worker-level integration. Defer.
- Per-ticker N-trade WR throttle: same issue.

---

## Decision rule (pre-committed)

1. Run baseline (no gate) + 6 gate variants, all with `holdoutCount=5`.
2. Pick the single variant with highest **selection-window combined Sharpe** that also:
   - Passes baseline validity (MinTrades, MaxDD, WFA, Sanity, Delta gates)
   - Has `deflatedSharpe > 0` under N=7 attempts
3. Report that variant's **holdout** metrics as the write-once evaluation.
4. If the chosen variant fails holdout gate (Sharpe < 0.3 AND SPY IR < 0.3), **Campaign A concludes with no rescue strategy.**
5. Do NOT iterate on the gate if holdout fails. Do NOT try a 7th gate. Campaign A is a single-shot test.

## Success threshold

The replacement strategy must deliver both:
- Selection-window combined Sharpe ≥ 0.9 (comparable to current champion)
- Holdout combined Sharpe ≥ 0.3 **OR** holdout SPY IR ≥ 0.3 (survives 2024-01-22 → 2026-02-27 including the 45-loss streak)

If the best-selection variant also produces the best holdout, that's corroborating. If selection-best has poor holdout but some other gate passes holdout, we honor the pre-committed rule (selection-based selection) — picking on holdout = violation of write-once gate.

## What this DOESN'T prove

- A gate that passes doesn't prove the *specific* 2025 regime was detected. It only proves the gate filter happens to reduce damage in this particular holdout.
- The holdout is one period. Single-shot. Confidence interval on holdout Sharpe is wide.
- Sample size in holdout will be small (currently ~102 OOS trades over 2019-2024, so holdout 2024-2026 has maybe 30-50 trades). Tolerate noisy holdout verdict.

## Artifacts produced

- `.prompts/campaign-a-regime-gate-preregistration.md` (this file, frozen pre-run)
- `scripts/autoresearch/leaderboard-campaign-a.json` (agent-visible, holdout metrics stripped)
- `data/leaderboard-full-campaign-a.json` (full metrics)
- `scripts/autoresearch/campaign-a-results.md` (written after all 7 runs complete, reports decision per rule)
