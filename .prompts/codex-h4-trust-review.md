# Codex H4 Review Prompt: Backtest Trust Audit

You are reviewing a trading/backtesting codebase where **subtle simulator bugs have repeatedly produced fake results**. Your job is to identify anything that could inflate performance metrics or hide risk, and to propose concrete fixes.

## Goals

1. **Trustworthiness first**: prioritize correctness, leakage avoidance, and data integrity over performance or feature work.
2. **Adversarial mindset**: when results look “too good”, assume it’s a bug until proven otherwise.
3. **Actionable output**: every finding must include a specific fix (code change, test, assertion, or guardrail).

## Non-goals

- UI/UX polish, styling, and general refactors that do not affect backtest correctness.
- New strategy ideas or parameter tuning.

---

## Mandatory reading (do not skip)

- `docs/backtest-trust-gotchas.md` — canonical list of past bugs/traps and their fingerprints (treat as a regression checklist)

If you reference a past gotcha in your findings, cite the exact gotcha section title and point to the current code path that prevents/regresses it.

---

## Primary code surfaces to audit

Focus here first (read fully):
- `src/lib/backtest/engine.ts`
- `src/lib/backtest/option-sim.ts`
- `src/lib/backtest/credit-spread-exit.ts`
- `src/lib/backtest/intraday-monitor.ts`
- `src/lib/backtest/analytics.ts`
- `src/lib/backtest/wfa-options.ts`
- `src/lib/backtest/types.ts`

Secondary but often implicated:
- `src/lib/backtest/slippage.ts`
- `src/lib/backtest/chain-cache.ts`
- `src/lib/services/ivRank.ts` and `src/lib/backtest/iv-rank.ts`
- Any data backfill / cron scripts under `api/` that populate inputs used by the backtest (IV, candles, etc.)
- Autoresearch harness (if it consumes backtest metrics): `scripts/autoresearch/*`

Tests to use as a “trust harness”:
- `tests/backtest-audit.test.ts`
- `tests/credit-spread-exit.test.ts`
- `tests/option-sim-fills.test.ts`
- `tests/option-sim-analytics.test.ts`
- `tests/wfa-options.test.ts`

---

## Review dimensions (what to look for)

### 1) Leakage / Look-ahead / WFA separation

Find any way information from the future (or from OOS) can influence IS optimization or OOS evaluation:
- Train/OOS boundary handling and date intersections
- Purge gaps vs max holding period / max DTE
- Shared caches or precomputed indicators spanning across windows
- “Holdout” windows that can be implicitly overfit (e.g., via leaderboard visibility)
- Any normalization, ranking, or scoring that uses full-period statistics

### 2) Fill realism & pricing correctness

Confirm fills cannot be better than the market:
- Bid/ask vs mid assumptions; slippage models and whether they are actually applied
- Credit spread close cost clamping: must respect spread width and non-negativity
- Expiration intrinsic pricing (ITM/OTM) and assignment-like behavior
- Deep ITM BSM pathologies and any clamps (verify both directions; no “fix” that breaks the opposite side)

### 3) Exit logic correctness (especially “triggered” exits)

Triggered exits are a common source of fake edge:
- Stop loss / trailing logic must book **market** close cost, not threshold values
- Exit costs must be conservative (cannot assume favorable fills during fast moves)
- Ensure LEAP/debit and credit spread logic do not cross-contaminate

### 4) Metrics & analytics correctness

Verify all reported metrics match standard definitions and are computed on the correct series:
- Sharpe / Information Ratio: annualization and excess-return definitions
- Max drawdown: must be percent-of-peak equity, computed in chronological realization order
- Correlation/covariance: confirm series alignment and acknowledge sparse series artifacts (e.g., monitoring interval produces many zeros)
- Bootstrap / confidence intervals: resample appropriate unit (daily returns, not trades, unless explicitly justified)
- Any combined metrics: verify formula, weighting, and units

### 5) Data integrity & silent failures

The most dangerous bugs are “quiet”:
- Null/undefined data paths that silently bypass filters or drop trades
- Empty caches treated as “no constraint” instead of “missing data”
- “Fallback” values that bias performance upward
- Timezone/date parsing issues (off-by-one day shifts) impacting entries/exits

### 6) Determinism & reproducibility

Backtests should be reproducible given the same inputs:
- Randomness: seeding for bootstrap and any stochastic components
- Ordering: deterministic sorting where iteration order affects results
- Worker parallelism: ensure no race conditions alter aggregates

### 7) Sanity gates & invariant checks

Look for (or propose) hard guardrails that prevent obviously fake results from being treated as “wins”:
- Caps on implausible Sharpe/IR or other “too good to be true” metrics
- Assertions like “defined-risk loss cannot exceed max loss”
- Warnings when correlation is based on a sparse series / insufficient sample size
- Validations that required data sources are non-empty and correctly tagged (e.g., IV sources)

### 8) Test coverage against the trust gotchas

Cross-check `docs/backtest-trust-gotchas.md` against the current test suite:
- Every “fixed” simulator bug should have a regression test.
- If a gotcha is prevented only by convention (not a test/assertion), propose a test.

### 9) Performance issues that affect correctness

Only include performance findings when they can distort results (e.g., timeouts leading to partial data, caching that mixes windows, or concurrency bugs).

---

## Output format (required)

Provide a prioritized table:

| # | Severity | Category | File:Line | Finding | Fix |
|---|----------|----------|-----------|---------|-----|

Severity must be one of: **Critical / High / Medium / Low**.

After the table, add:
1. **Top 3 trust risks** (what could still be making results fake)
2. **Regression checklist status** (which gotchas are strongly prevented vs weakly prevented)
3. **Recommended next tests to run** (specific test files or commands)

