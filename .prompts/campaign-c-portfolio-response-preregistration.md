# Campaign C — Portfolio-Level Regime Response Pre-Registration

**Date pre-registered:** 2026-04-16 (post Campaign A completion, before any Campaign C runs)
**Purpose:** After Campaign A showed that entry-level regime gates degrade rather than help d65-tp40, test whether *portfolio-level* responses (acting on realized trade outcomes, not entry signals) can further reduce 2024+ regime damage without hurting pre-2024 performance.

**Key commitment:** The 3 portfolio-response candidates below are fixed before any runs. After runs, we pick by selection-window combinedSharpe (same rule as Campaign A), then single-shot evaluate on the 2024-01-22 → 2026-02-27 holdout. No iteration.

---

## Methodology — post-replay approximation

Campaign A modified nothing in the engine. Campaign C does post-replay on the baseline trade list instead of modifying `evaluateConfiguredSignalsWithState`. Pipeline:

1. Re-run the Campaign A baseline (d65-tp40-gate-none, holdoutCount=5) with `SAVE_TRADES=1` so the runner writes selection-OOS + holdout trade lists to JSON.
2. For each candidate, replay trades in chronological order. At each trade's entry date, evaluate the gate against state-at-that-moment (prior closed trades, running equity). If the gate would have rejected entry, mark the trade as skipped.
3. Recompute combinedSharpe / holdoutSharpe / holdoutSpyIR from the filtered trade list.
4. Apply the pre-registered decision rule.

**Known limitation:** this under-represents gate value because the engine doesn't re-allocate freed slots to signals that were originally blocked by the portfolio cap. Any gate that *improves* under this understatement is conservatively real. A gate that *ties or worsens* baseline could still have small real value that the approximation misses, but we treat ties as no-go per the pre-committed rule.

## Baseline strategy under test

Same as Campaign A winner:
- d65-tp40 ungated: deep ITM LEAP CALL, δ∈[0.65, 0.80], DTE∈[180, 270], TP 0.40, SL 0.30, TS 105
- 14 tickers (GLD IWM AAPL MSFT GOOG AMZN META JPM GS COST UNH NFLX NVDA TSLA)
- Signal: EMA34 MA-touch 0–5% + SPY>EMA200 + c>EMA55 + ema8>ema13 + ema34 rising (5d) + contangoPct<48
- WFA: trainWindowDays 252 / forwardStepDays 126 / purgeGapDays 10 / rolling / holdoutCount=5
- Selection: 2019-01-17 → 2024-01-19 (10 windows)
- Holdout: 2024-01-22 → 2026-02-27 (5 windows)

## Candidate C1 — Realized drawdown circuit breaker

**Rule:**
- Track `realizedEquity = startingCapital + sum(closed trade pnl with exitDate < signalDate)`
- Track `peakRealizedEquity` (running max of realizedEquity)
- If `(peak - realizedEquity) / peak > 0.15`, skip entry
- Resume when the ratio drops below 0.05 (hysteresis)

**Mechanism:** universal portfolio discipline — "when the portfolio's behind recent peak, stop adding risk until it recovers."

**Parameters:** `pauseAt = 0.15`, `resumeAt = 0.05`

## Candidate C2 — Rolling 10-trade win-rate throttle

**Rule:**
- Count the last 10 closed trades with exitDate < signalDate
- If fewer than 10 have closed, allow entry
- If ≥10 closed and WR of those 10 < 40%, skip entry
- WR threshold and window fixed; no per-variant tuning

**Mechanism:** flag to "stop when recent outcomes look bad" — slow to fire so noise is dampened, but engages when a real regime shift is under way.

**Parameters:** `window = 10`, `minWR = 0.40`

## Candidate C3 — Per-ticker 3-strikes cooldown

**Rule:**
- For each ticker, look at its last 3 closed trades before signalDate
- If all 3 are losers (pnl ≤ 0), skip new entries on that ticker for 60 calendar days after the most recent loss
- After 60 days OR any winning trade on the ticker, reset

**Mechanism:** narrow, per-ticker drift detection. Respects the rest of the watchlist. In 2025, the failure was ticker-specific (COST, NFLX, AMZN flipped) while GOOG, NVDA kept working. This gate pulls only the damaged names offline.

**Parameters:** `lookback = 3`, `cooldownDays = 60`

## Decision rule (pre-committed, same shape as Campaign A)

1. Run baseline (no response) + 3 candidate variants.
2. Pick the single variant with highest **selection-window combinedSharpe** that also:
   - Has MaxDD ≤ 35%, OOS trades ≥ 60, OOS Sharpe > 0
   - Has deflated Sharpe > 0 under N=4 attempts (post-replay is cheaper — no 680 prior attempts to account for)
3. Report that variant's **holdout** metrics as the write-once evaluation.
4. Do NOT iterate on the response if holdout fails. Do NOT try a 4th candidate.

## Success threshold

The winning response must deliver:
- Selection combinedSharpe ≥ baseline's 1.079 (no regression)
- Holdout Sharpe ≥ baseline's 1.343 OR holdout IR ≥ baseline's 0.991 (improvement on the regime-challenged window)

**Ties with baseline = no-go.** If the winning response doesn't clearly beat the ungated baseline, conclude that portfolio-level responses don't add value either. The d65-tp40 champion stands with no gate and no portfolio response.

## Artifacts

- Pre-registration: this file (frozen before runs)
- Baseline trade dump: `scripts/autoresearch/campaign-c-baseline-trades.json`
- Per-candidate replay output: `scripts/autoresearch/campaign-c-replay.json`
- Results document: `scripts/autoresearch/campaign-c-results.md`
