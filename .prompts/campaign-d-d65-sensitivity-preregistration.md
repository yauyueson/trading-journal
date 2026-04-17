# Campaign D — d65-tp40 Sensitivity Sweep Pre-Registration

**Date pre-registered:** 2026-04-16 (after Campaigns A, B/Option3, C all concluded)
**Purpose:** Before committing d65-tp40 as the validated secondary strategy:
1. **Consistency check** — re-validate the champion metrics under current code (post trust-gotcha fixes: TRAILING_LOCK fix 2026-04-10, bidask default, all other gotchas). Historical leaderboard mixes results from multiple code versions; we need a fresh-code baseline.
2. **Alpha extraction** — sweep parameters in a small neighborhood around d65-tp40 to make sure we haven't left easy alpha on the table. Historical leaderboard hints `d65-tp40-ts150` had combined 1.286 vs baseline's 1.166 — if real under current code, that's a 10% upgrade.

**Key commitment:** The parameter grid below is fixed BEFORE the run. No iteration, no "let me add one more variant after seeing results." Pre-registered grid + decision rule = single-shot answer.

---

## Baseline reference

The current documented champion (from CLAUDE.md and scripts/autoresearch/best-strategy.ts):
- Deep ITM LEAP CALL
- Delta range: `[0.65, 0.80]`
- DTE range: `[180, 270]`
- TP 0.40, SL 0.30, TS 105
- 14 tickers: GLD, IWM, AAPL, MSFT, GOOG, AMZN, META, JPM, GS, COST, UNH, NFLX, NVDA, TSLA
- Signal: EMA34 MA-touch (0–5%) + SPY>EMA200 + ticker>EMA55 + EMA8>EMA13 + EMA34 rising (5d) + contangoPct<48
- Reported metrics (pre-Campaign A): combined Sharpe 1.166, MaxDD 30.6%, 102 OOS trades

## WFA structure (fixed, same as Campaign A)

- `trainWindowDays: 252`, `forwardStepDays: 126`, `purgeGapDays: 10`, `mode: 'rolling'`
- `holdoutCount: 5` — selection 2019-01-17 → 2024-01-19 (10 windows), holdout 2024-01-22 → 2026-02-27 (5 windows)

## Parameter sensitivity grid (26 variants)

All variants share the same signal generator (exact d65-tp40 signal logic). Only SimConfig fields differ. All variants evaluated in one runner invocation via `configVariants`.

### Baseline (anchor)
- `d65-tp40-baseline` — DTE [180, 270], δ [0.65, 0.80], TP 0.40, SL 0.30, TS 105

### Time stop sweep (5 variants)
- `d65-tp40-ts090` — TS 90
- `d65-tp40-ts105` — TS 105 (same as baseline)
- `d65-tp40-ts120` — TS 120
- `d65-tp40-ts135` — TS 135
- `d65-tp40-ts150` — TS 150
- `d65-tp40-ts180` — TS 180

### Profit target sweep (4 variants)
- `d65-tp30-ts105` — TP 0.30
- `d65-tp35-ts105` — TP 0.35
- `d65-tp45-ts105` — TP 0.45
- `d65-tp50-ts105` — TP 0.50

### Stop loss sweep (3 variants)
- `d65-sl20-ts105` — SL 0.20
- `d65-sl25-ts105` — SL 0.25
- `d65-sl35-ts105` — SL 0.35

### Delta range sweep (3 variants)
- `d60-tp40-ts105` — δ [0.60, 0.75]
- `d70-tp40-ts105` — δ [0.70, 0.85]
- `d75-tp40-ts105` — δ [0.75, 0.90]

### DTE range sweep (3 variants)
- `d65-dte150-ts105` — DTE [150, 240]
- `d65-dte210-ts105` — DTE [210, 300]
- `d65-dte120-ts105` — DTE [120, 180] (shorter — tests whether the long-DTE defaults are necessary)

### Combinations (6 focused intersections)
- `d65-tp40-ts150-sl25` — best TS candidate + tight SL
- `d65-tp45-ts150` — wider TP + longer TS
- `d65-tp35-ts090` — tighter TP + shorter TS
- `d70-tp45-ts150` — deeper delta + wider TP + longer TS
- `d65-tp40-ts120-dte210` — intermediate TS + longer DTE
- `d60-tp35-ts090` — shallower delta + tight exits

## Decision rule (pre-committed)

1. Run all 26 variants. All use the same selection + holdout WFA.
2. Filter to variants that pass validity on selection window:
   - OOS Sharpe > 0
   - OOS trades ≥ 60 (prorated for shorter selection window — same as Campaign A)
   - MaxDD ≤ 45%
   - Deflated Sharpe > 0 under N=26
3. Rank by selection-window **combinedSharpe** (50/50 with DTE5).
4. **Adopt the top-ranked variant as the new champion** IF AND ONLY IF it beats baseline combinedSharpe by a meaningful margin (≥ 0.05, which is ~5% of baseline's 1.08 pre-registered value).
5. If no variant meaningfully beats baseline, the existing d65-tp40 remains the champion, confirmed-robust.
6. Holdout metrics are **observed**, not used for ranking. Report them alongside each variant but do not re-rank on holdout.

## Leaderboard isolation

- Runner uses `leaderboard-campaign-d.json` via `AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-d`
- Attempt counter resets to N=26
- Strategy file: `strategy-campaign-d.ts` via `AUTORESEARCH_STRATEGY_FILENAME=strategy-campaign-d.ts`
- Minimum trades: `AUTORESEARCH_MIN_OOS_TRADES=60` (prorated for pre-2024 selection)

## Consistency checks (run before adoption)

1. Baseline variant (d65-tp40-baseline in Campaign D) must produce metrics within ±5% of the historical leaderboard's d65-tp40 entry. If drift is larger, a code change invalidated historical results — note this in the final report.
2. Any variant whose selection Sharpe > 3.0 is auto-rejected (sanity bound — simulator bug catcher).
3. Any variant whose holdout trades = 0 but selection trades > 100 is flagged (possible gate pathology, like Campaign C's drawdown circuit breaker trap).

## Artifacts

- `.prompts/campaign-d-d65-sensitivity-preregistration.md` — this file, frozen before runs
- `scripts/autoresearch/strategy-campaign-d.ts` — 26-variant sensitivity strategy
- `scripts/autoresearch/leaderboard-campaign-d.json` — agent-visible (holdout stripped)
- `data/leaderboard-full-campaign-d.json` — full metrics
- `scripts/autoresearch/campaign-d-results.md` — final analysis + champion decision
