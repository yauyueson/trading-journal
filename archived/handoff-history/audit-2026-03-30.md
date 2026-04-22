---
task: Adversarial audit of short-put credit spread strategy — post-correction validation
stage: pending
owner: codex
from: claude
timestamp: 2026-03-30T02:00:00-04:00
---

## Objective

**Adversarial code review** of `scripts/short-put-1dte.ts` — a systematic short put credit spread strategy on QQQ/SPY. Three critical bugs were found and fixed in prior sessions. A 4-stage re-examination, hold-out validation, correlation study, spread sweep, and capital efficiency analysis have been completed. Your job: **verify the corrected results are not still inflated, and that the claimed edge is real.**

## Why This Review Is Critical

This project has a history of phantom profits:

| Bug | Impact | Status |
|-----|--------|--------|
| Per-trade Sharpe annualization | ~2.2x inflation (sqrt(252) on ~50 annual trades) | FIXED — daily equity returns now |
| Expiry mismatch between spread legs | ~40% of trades had mismatched expirations | FIXED — sameExpiryChain filter |
| Intrinsic boundary pricing | OTM options force-closed at $0 instead of market price | FIXED — findContractDirect() market pricing |
| CAGR denominator bug | Used BASE.startingCapital ($100K) instead of actual capital | FIXED — uses configOverrides.startingCapital |

**After all fixes, reported Sharpe dropped from 2.6-3.6 to 0.8-1.2.** The question: are even these corrected numbers honest?

---

## Current Claimed Results (to validate or disprove)

### Best Configuration: QQQ bull EMA34, sp25/15, hold-to-expiry, DTE5

| Metric | WFA OOS | Hold-out (2024H2-2026) |
|--------|---------|----------------------|
| Sharpe | ~1.09 | ~1.17 |
| CAGR (at $100K, 5% risk) | 13.7% | ~10% |
| Total PnL ($100K, 5% risk) | $90K | $10K (20 months) |
| MaxDD | 16.7% | 4.0% |
| Win Rate | 84% | 84% |
| Trades | 435 | 165 |
| Positive WFA Windows | 7/10 | N/A |
| Walk-Forward Efficiency | 126% (global), 44% windows >50% | N/A |

### Supporting Evidence

1. **Not correlated to buy-and-hold QQQ** — R²=3.9%, Beta=0.033, Alpha=+3.8%/year
2. **Survives hold-out** — 0.97 Sharpe on truly unseen 2024H2-2026 data (67% IS→OOS decay)
3. **Adjacent EMA stable** — EMA29/34/39 all produce Sharpe >1.0
4. **Bear side is dead** — every bear config negative even with strict EMA alignment
5. **Stop losses help but aren't critical** — SL1.5x improves Sharpe slightly
6. **2022 bear market is the only losing year** — -$5K on $10K, -$5K on $100K

### Sanity Check Numbers (full-period $10K, sp25/15 20% risk)

| Metric | Value | Sanity |
|--------|-------|--------|
| Total trades | 488 over 6.15 years | 79/year — reasonable for DTE5 |
| Win rate | 84.4% | Consistent with 25-delta puts |
| Avg winner | $335 | ~full premium captured on OTM expiry |
| Avg loser | -$1,339 | ~spread width hit on breach |
| Payoff ratio | 0.25 (win/loss) | Expected for credit spreads |
| Expected $/trade | $74 | 84.4% × $335 - 15.6% × $1,339 |
| Total PnL | $36,333 | $74 × 488 = $36,152 ≈ $36,333 ✓ |
| CAGR | 28.3% | ($46.3K/$10K)^(1/6.15) - 1 ✓ |
| Worst 5-trade stretch | -$5,746 | 57% of capital |

---

## Audit Checklist — What Specifically to Verify

### 1. DAILY RETURNS SHARPE (was the #1 phantom bug)

**File:** `scripts/short-put-1dte.ts`, `runWFA()` function (~line 993)

- [ ] OOS Sharpe is computed from DAILY equity returns, not per-trade returns
- [ ] Zero-return days (no trade closes) are INCLUDED in the return series
- [ ] All OOS trading dates are enumerated from `allTradingDates` filtered to test windows
- [ ] `sqrt(252)` annualization is applied to truly daily data (not N-trade data)
- [ ] `runStrategy()` also computes daily Sharpe (lines ~721-731) using the same method

**How to verify:** Count the number of returns in the OOS Sharpe calculation. For ~5 years of 10 test windows × 126 days, should be ~1,260 daily returns. If it's ~400-500 (number of trades), it's per-trade and inflated.

### 2. SAME-EXPIRY SPREAD LEGS

**File:** `scripts/short-put-1dte.ts`, ~line 587

- [ ] `sameExpiryChain = chain.filter(r => r.expir_date === shortLeg.row.expir_date)` is applied BEFORE searching for long leg
- [ ] Both `findPutByDelta()` and `findCallByDelta()` paths use the filtered chain
- [ ] If no long leg found on same expiry, trade is SKIPPED (not entered with mismatched legs)

**How to verify:** Sample 10 random trades from the output. For each, verify `shortLeg.expir_date === longLeg.expir_date`. Also verify spread width matches `abs(shortStrike - longStrike)`.

### 3. EXPIRATION P&L — THE CORE CALCULATION

**File:** `scripts/short-put-1dte.ts`, `computeExpirationPnl()` (~line 198)

- [ ] For bull (put) spreads: `shortIntrinsic = max(0, strike - stockPrice)` — positive when stock drops below strike
- [ ] `longIntrinsic = max(0, longStrike - stockPrice)` — OFFSETS the short loss
- [ ] `exitCost = shortIntrinsic - longIntrinsic` — always >= 0
- [ ] `pnlPerShare = premium - exitCost` — can be negative (loss)
- [ ] `totalPnl = (pnlPerShare × 100 - commission × legCount × 2) × contracts`
- [ ] **Verify:** No trade can have `totalPnl > premium × 100 × contracts` (can't make more than the credit)
- [ ] **Verify:** No trade can have `|totalPnl| > spreadWidth × 100 × contracts` (defined risk)

### 4. WFA BOUNDARY CLOSING (was a phantom bug)

**File:** `scripts/short-put-1dte.ts`, lines ~650-711

- [ ] Open positions at end of test window are closed at MARKET price via `findContractDirect()`
- [ ] Market close uses worst-side: short leg at ASK, long leg at BID
- [ ] Fallback to intrinsic ONLY when `findContractDirect()` returns null (no market data)
- [ ] Verify the fallback path doesn't dominate — count how many trades use fallback vs market

### 5. POSITION SIZING

**File:** `scripts/short-put-1dte.ts`, ~line 664

- [ ] `sizingBase = config.compounding ? Math.max(0, equity) : config.startingCapital`
- [ ] For fixed sizing (compounding=false/undefined): always uses `startingCapital`, never grows
- [ ] `contracts = Math.min(50, Math.max(1, Math.floor(riskBudget / maxLossPerContract)))`
- [ ] Verify the 50-contract cap — at $100K/20% risk, riskBudget=$20K, if maxLoss=$243 → 82 contracts → capped at 50. This means $100K results are SUPPRESSED by the cap.
- [ ] Verify `maxLossPerContract = max(1, (spreadWidth - premium)) × 100`

### 6. DTE FILTERING

- [ ] `minDTE = Math.max(2, ...)` — no DTE=1 (same-day) trades
- [ ] With maxDTE=5 and minDTE=2, actual DTE range is [2, 5]
- [ ] Verify sample trades: `entryDate` and `exitDate` differ by at least 1 business day

### 7. EMA ALIGNMENT FILTER (NEW — never audited)

**File:** `scripts/short-put-1dte.ts`, after ~line 538

- [ ] When `requireAlignment=true`: bull requires `close > EMA1 > EMA2 > EMA3`, bear requires reverse
- [ ] Each EMA is independently computed via `computeEMA()` with different periods
- [ ] Alignment filter is checked AFTER the basic single-EMA filter (both must pass)
- [ ] When `requireAlignment` is false/undefined, this block is skipped entirely

### 8. HOLD-OUT VALIDATION

The hold-out test trains on 2020-01-01 to 2024-06-30, tests on 2024-07-01 to 2026-02-28. Verify:

- [ ] Train and test date ranges do NOT overlap
- [ ] No parameters are selected or tuned on the test period
- [ ] The hold-out Sharpe (0.97) uses the same daily-return method as WFA
- [ ] IS→OOS decay of 67% is correctly computed: `testSharpe / trainSharpe`

### 9. CORRELATION STUDY

- [ ] Daily returns for strategy are computed from trade exit PnLs mapped to dates
- [ ] Daily returns for buy-and-hold are computed from stock price changes
- [ ] Correlation, beta, R², alpha are standard OLS regression
- [ ] The claimed R²=3.9% and Beta=0.033 — verify these are not computed on a subset of dates

### 10. WINNER EXIT COST = $0 PATTERN

**This is the most suspicious pattern in the data.** Looking at sample trades, most winners show `exitCost = $0.000`. This means the options expired worthless (OTM at expiration → intrinsic = $0 for both legs).

- [ ] Verify this is correct: for a 25-delta put spread, if stock stays above the short strike, both puts expire worthless → exit cost = $0 → full premium captured
- [ ] Check what % of winning trades exit at exactly $0 vs a small positive number
- [ ] Is it possible that the market pricing fallback is silently defaulting to $0?
- [ ] For expired trades, verify `expired: true` flag is set and the P&L is computed via `computeExpirationPnl()`, NOT via `findContractDirect()`

### 11. COMPOUNDING MODE

**File:** `scripts/short-put-1dte.ts`, ~line 664

- [ ] When `compounding=true`, `sizingBase = Math.max(0, equity)` — sizes from current equity
- [ ] When equity drops, position size decreases (de-risking)
- [ ] When equity grows, position size increases (compounding)
- [ ] Verify the skip condition: `if (config.compounding && riskBudget < maxLossPerContract) continue`

---

## Files

| File | Purpose | Key Lines |
|------|---------|-----------|
| `scripts/short-put-1dte.ts` | **PRIMARY TARGET** | All active code (lines 1-~1016 for engine, rest is study functions) |
| `src/lib/backtest/chain-cache.ts` | Data access | `findContractDirect()` (~line 672) |
| `data/runs/sanity-audit-output.txt` | Full trade-level audit | Every trade's premium, exit cost, P&L |
| `data/runs/4stage-reexam-output.txt` | Stage 1-4 results | WFA results across all configs |
| `data/runs/holdout-correlation-output.txt` | Hold-out + correlation | IS vs OOS, beta/R²/alpha |
| `data/runs/spread-sweep-output.txt` | QQQ spread sweep | All delta/wing combinations |
| `data/runs/spy-spread-sweep-output.txt` | SPY spread sweep | All delta/wing combinations |
| `data/runs/compounding-v2-output.txt` | Compounding vs fixed sizing | Equity curves |
| `data/runs/wfe-study-output.txt` | Walk-forward efficiency | Per-window IS→OOS ratios |
| `data/runs/alignment-study-output.txt` | Multi-EMA alignment | Bull/bear with EMA stacking |

---

## Specific Concerns to Investigate

### A. Is 84% Win Rate Real for 25-Delta Puts?

A 25-delta put has roughly 25% probability of finishing ITM (by definition of delta ≈ probability ITM). That means ~75% should expire OTM (win). We're seeing 84% — higher than expected.

Possible explanations (verify which):
1. EMA34 filter removes ~30% of trading days (bear regime), which are the days most likely to produce losses → WR increases
2. DTE5 puts have higher theta decay rate than longer-dated, so even slight ITM may not exceed the premium collected
3. Some "wins" are actually positions closed at the WFA boundary at $0 intrinsic (the old bug — verify it's truly fixed)

### B. Is $0 Exit Cost Correct for Winners?

Most winning trades show `exitCost = $0.000`. For expired OTM options, this is correct (intrinsic = 0). But verify:
1. Are these trades actually reaching expiration? Check `expired: true`
2. Or are they being closed early at the WFA window boundary via the market pricing path?
3. If closed at boundary, `findContractDirect()` should return a non-zero ask for the short leg (time value remaining). A $0 close would mean the fallback intrinsic path is being used.

### C. Why Does Sharpe INCREASE Out-of-Sample for Some Configs?

QQQ EMA34 shows 114% WFE (OOS > IS). This is unusual and could indicate:
1. Recent period (2023-2026) has genuinely richer VRP than training period
2. A subtle look-ahead bias we haven't identified
3. Survivorship bias in the chain data (only liquid options cached)

### D. The 50-Contract Cap

At $100K with 20% risk, the cap binds and suppresses PnL. This means:
- $10K results are more honest (below the cap)
- $100K results understate what the strategy "should" produce
- The cap creates a non-linearity: $10K × 10 ≠ $100K results

### E. Premium > Spread Width Guard

Line ~636: `if (premium > spreadWidth) premium = spreadWidth * 0.95`

This handles the ORATS data artifact where quoted bid-ask produces impossible premiums. Verify:
1. How often does this guard trigger?
2. Does the 0.95 multiplier create phantom trades that wouldn't exist in reality?

---

## Process That Led to These Results

### Session 1 (2026-03-29): Strategy Development + First Audit

1. Built `short-put-1dte.ts` with VRP harvesting on SPY/QQQ
2. Ran 3 experiments (EMA comparison, TP/SL, bear side) — reported Sharpe 2.6-3.6
3. Created adversarial audit checklist for Codex
4. Codex found 3 critical bugs (expiry mismatch, per-trade Sharpe, boundary pricing)
5. All 3 bugs fixed — Sharpe collapsed to 0.23-1.20

### Session 2 (2026-03-29 to 2026-03-30): Rigorous Re-examination

1. **4-Stage Pipeline** (518 WFA runs):
   - Stage 1: 20 baseline runs (5 EMAs × 2 directions × 2 tickers) — bear side killed, 8 bull survivors
   - Stage 2: 96 TP/SL variants — SL helps, TP hurts, delta stops moderate
   - Stage 3: Pullback entry logic — gates hurt, sizing marginal
   - Stage 4: Robustness checks — adjacent params stable, concentration acceptable

2. **Hold-out Validation**: Train 2020-2024H1, test 2024H2-2026 — QQQ EMA34 holds at 0.80-0.97 Sharpe

3. **Correlation Study**: R²=3.9%, Beta=0.033 — NOT a leveraged long proxy

4. **Spread Sweep**: sp25/15 is better than sp25/10 for QQQ, sp20/10 for SPY

5. **Capital Efficiency**: 5% utilization at baseline, scales to 20% with higher risk%

6. **Compounding Mode**: Added dynamic sizing from equity — +37% more PnL at $10K

7. **CAGR Bug Fix**: Was dividing by BASE.startingCapital ($100K) instead of actual capital

8. **EMA Alignment Study**: Multi-EMA stacking (21>34>55) — doesn't help bull, makes bear slightly positive on QQQ only but inconsistent (3/10 windows)

### Key Decisions Made

- **Fixed spread config throughout** (sp25/10 initially, then swept) — no spread optimization on top of EMA
- **$0 commissions** — all results assume Robinhood. At $0.65/leg (Schwab), Sharpe drops ~25%
- **maxPositions: 1** — multi-position configs showed correlated losses, lower Sharpe
- **Hold-to-expiry** — TP hurts (cuts premium), SL helps modestly but not critical

---

## What Codex Should Produce

1. **For each checklist item**: PASS, FAIL, or CONCERN with specific line numbers and evidence
2. **Trade-level verification**: Pick 5 random trades from the sanity audit output, manually verify the P&L math
3. **Boundary behavior audit**: How many WFA test windows end with open positions? What pricing method is used for each? If intrinsic fallback dominates, that's a problem.
4. **$0 exit cost investigation**: What fraction of winners use exit cost $0? Are they genuinely expired or is the fallback masking a problem?
5. **Overall verdict**: Are the claimed results (Sharpe 1.16, 84% WR, $34K PnL on $10K) honest?

**If you find ANY issue that could inflate Sharpe by >0.3, flag it as CRITICAL.**
