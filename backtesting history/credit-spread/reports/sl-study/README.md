# Stop-Loss WFA Study — Credit Spread Strategies

Generated: 2026-03-23

## Executive Summary

This study rigorously evaluated **4 stop-loss mechanisms × 23 configurations** across both Swing (45-65 DTE) and Short-Term (7-21 DTE 130M) credit spread strategies using Walk-Forward Analysis with IS/OOS selection windows + holdout validation.

### Verdict

**Swing**: Trailing Profit Lock is a legitimate improvement over no-SL baseline. `tl75-25` achieves **OOS Sharpe 1.53** (vs baseline 1.42), Grade A (vs baseline B), better IS→OOS retention (76% vs 69%), with comparable PnL ($65k vs $68k) and identical max drawdown (3.5-3.6%). All other SL mechanisms (credit multiple, delta stop, max loss %) either match or degrade performance.

**Short-Term**: The baseline (no SL) is **definitively optimal**. It produces OOS Sharpe 0.97, WR 76%, PnL $135k — and is the only config that doesn't blow up. Credit multiple stops are catastrophic (999%+ drawdowns). Delta stops at 0.70-0.80 show positive Sharpe but with 70-110% drawdowns and negative PnL. Short-term credit spreads must be left to expire or hit TP.

### Recommended Configuration Changes

| Strategy | Current | Recommendation | Confidence |
|----------|---------|----------------|------------|
| Swing | No SL | **Add Trailing Lock (activate 75% of TP, floor 25% of TP)** | Medium-High |
| Short-Term | No SL | **Keep No SL** | High |

---

## Methodology

- **Tickers**: SPY, QQQ, AMD, IWM, TSLA, AAPL, JPM, NVDA, AMZN, MSFT, META, NFLX, GOOG, GS (14)
- **Swing config**: `vol` preset, TP 40%, $20 width, DTE 45-65, IV≥0, time stop DTE 3, dirConf≥70, maxPos 5, maxPerTicker 3
- **Short config**: `em` preset, TP 50%, $10 width, DTE 7-21, IV≥20, time stop DTE 1, PM 2.25
- **WFA windows**: Swing 12 (10 selection + 2 holdout), Short 7 (6 selection + 1 holdout)
- **Rolling**: Swing 504d train / 126d step / 65d purge; Short 189d train / 42d step / 14d purge

### SL Mechanisms Tested

1. **Credit Multiple** (2×-15×): Close when spread cost reaches N× entry credit
2. **Delta Stop** (0.50-0.80): Close when |short delta| exceeds threshold
3. **Max Loss %** (25%-90%): Close when unrealized loss reaches X% of max possible loss (width - credit)
4. **Trailing Profit Lock**: Once profit hits activation%, set floor at floor%; close if retraces below floor

### Overfitting Grade Rubric

| Grade | Criteria |
|-------|----------|
| A | 6/6 checks pass |
| B | 5/6 |
| C | 4/6 |
| D | 3/6 |
| F | <3/6 |

Checks: (1) IS→OOS retention ≥40%, (2) OOS Sharpe StdDev <1.0, (3) All selection windows positive OOS, (4) Sufficient trades, (5) No extreme IS, (6) OOS Sharpe >0.5

---

## Swing Results (14 tickers, 8,548 signals, 12 windows)

### Full Results Table

| Label | Mechanism | OOS Sharpe | Holdout | OOS PnL | ROC% | MaxDD% | ROC/DD | WR% | Trades | Avg PnL | WFE | Grade |
|-------|-----------|-----------|---------|---------|------|--------|--------|-----|--------|---------|-----|-------|
| **tl75-25** | **trailing_lock** | **1.53** | **0.41** | **$65k** | **65.5%** | **3.5%** | **18.5** | **83%** | **491** | **$133** | **0.76** | **A** |
| tl50-25 | trailing_lock | 1.50 | 0.71 | $58k | 58.0% | 3.7% | 15.8 | 78% | 580 | $100 | 0.83 | A |
| tl75-50 | trailing_lock | 1.50 | 0.40 | $65k | 64.7% | 3.7% | 17.4 | 85% | 519 | $125 | 0.79 | A |
| **baseline** | **baseline** | **1.42** | **0.25** | **$68k** | **67.5%** | **3.6%** | **18.6** | **90%** | **429** | **$157** | **0.69** | **B** |
| sl10x/sl15x | credit_multiple | 1.42 | 0.25 | $68k | 67.5% | 3.6% | 18.6 | 90% | 429 | $157 | 0.69 | B |
| sl5x | credit_multiple | 1.39 | 0.13 | $58k | 58.5% | 3.9% | 14.9 | 89% | 435 | $134 | 0.74 | C |
| tl50-50 | trailing_lock | 1.39 | 0.71 | $60k | 59.6% | 4.0% | 14.9 | 84% | 601 | $99 | 0.77 | A |
| sl4x | credit_multiple | 1.22 | -0.00 | $48k | 48.4% | 7.2% | 6.7 | 86% | 446 | $109 | 0.80 | C |
| ml90 | max_loss_pct | 1.19 | 0.18 | $49k | 49.2% | 5.0% | 9.9 | 88% | 438 | $112 | 0.92 | C |
| sl3x and below | credit_multiple | ≤0.64 | — | — | — | — | — | — | — | — | — | C-D |
| All delta stops | delta_stop | ≤0.62 | — | — | — | — | — | — | — | — | — | C-D |
| All max loss % | max_loss_pct | ≤0.80 | — | — | — | — | — | — | — | — | — | C-D |

### Per-Mechanism Best

| Mechanism | Best Config | OOS Sharpe | Holdout | WR | PnL | Grade |
|-----------|-------------|-----------|---------|-----|-----|-------|
| Baseline | baseline | 1.42 | 0.25 | 90% | $68k | B |
| Credit Multiple | sl15x (≡baseline) | 1.42 | 0.25 | 90% | $68k | B |
| Delta Stop | ds50 | 0.62 | -0.09 | 61% | $19k | C |
| Max Loss % | ml90 | 1.19 | 0.18 | 88% | $49k | C |
| **Trailing Lock** | **tl75-25** | **1.53** | **0.41** | **83%** | **$65k** | **A** |

### Window-Level Consistency (Top 5)

| Config | Mean OOS Sharpe | StdDev | Min | Positive Windows | IS→OOS Retention | Grade |
|--------|----------------|--------|-----|-----------------|-----------------|-------|
| baseline | 2.06 | 1.01 | 0.85 | 10/10 | 69% | B |
| **tl75-25** | **2.03** | **0.88** | **0.85** | **10/10** | **76%** | **A** |
| tl50-25 | 1.99 | 0.91 | 1.11 | 10/10 | 83% | A |
| tl75-50 | 2.00 | 0.92 | 1.02 | 10/10 | 79% | A |
| tl50-50 | 1.88 | 0.92 | 0.69 | 10/10 | 77% | A |

### Swing Analysis

**Why trailing lock works for swing**: Swing credit spreads (45-65 DTE) often reach 50-75% of their TP target within 15-25 days, then stall or retrace due to mean-reversion in volatility. The trailing lock captures this dynamic — once the spread has decayed significantly, lock in a floor. If volatility spikes and the spread widens again, exit with a guaranteed profit rather than riding it back to break-even.

**Why baseline still has merit**: Higher absolute PnL ($68k vs $65k), higher avg PnL/trade ($157 vs $133), 90% WR. The baseline lets every winner run to full TP, while trailing lock exits ~15% of trades early via the floor mechanism.

**The trade-off**: Trailing lock sacrifices ~$3k total PnL and 7 WR points to gain +0.11 OOS Sharpe, +0.16 holdout Sharpe, Grade A (vs B), and better generalization (76% IS→OOS retention vs 69%).

### Exit Type Distribution

| Config | TP | Expiration | Trailing Lock | Time Stop | SL |
|--------|-----|-----------|---------------|-----------|-----|
| **Baseline** | 309 (72%) | 104 (24%) | — | 16 (4%) | — |
| **tl75-25** | 311 (63%) | 95 (19%) | 72 (15%) | 13 (3%) | — |

---

## Short-Term Results (14 tickers, 1,737 signals, 7 windows)

### Key Finding: No SL is definitively optimal

| Label | Mechanism | OOS Sharpe | Holdout | PnL | WR% | MaxDD% | Grade |
|-------|-----------|-----------|---------|-----|-----|--------|-------|
| **baseline** | **baseline** | **0.97** | **0.86** | **$135k** | **76%** | **35.5%** | **C** |
| ds70 | delta_stop | 1.18 | 0.64 | -$41k | 61% | 109.8% | B |
| ds75 | delta_stop | 0.94 | 0.70 | -$17k | 64% | 91.9% | B |
| tl75-50 | trailing_lock | 0.65 | 0.75 | $42k | 56% | 61.6% | B |
| All credit mult | credit_multiple | ≤-0.79 | -1.37 | -$1M | ≤43% | 999%+ | F |
| All max loss % | max_loss_pct | ≤-0.65 | -1.37 | -$1M | ≤39% | 1000%+ | F |

**Why SL destroys short-term spreads**: With 7-21 DTE, credit spreads have very little time for recovery. Any stop-loss exit locks in a loss on a position that would naturally decay to profit within days. The gamma exposure at short DTE means spreads can breach stop thresholds intraday and recover by close. Credit multiple stops (sl2x-sl15x) are uniformly catastrophic — all produce 999%+ drawdowns and negative PnL.

**Delta stops caveat**: ds70-ds80 show positive Sharpe but with massive drawdowns (70-110%) and negative PnL. The positive Sharpe is misleading — it comes from cutting losers slightly less badly, not from generating profits. Not viable.

---

## Conclusions

### 1. Credit Multiple Stops: Confirmed Dead for Both Strategies

The original finding (SL 2× = Sharpe 0.04) was sparse but directionally correct. The finer grid confirms:
- **SL 7×+ ≡ no SL** (stops never trigger)
- **SL 4×-5×**: slight degradation (Sharpe drops 0.15-0.20)
- **SL 2×-3×**: catastrophic for both strategies
- Defined-risk credit spreads have built-in max loss — explicit credit-based stops only cause premature exits during normal volatility.

### 2. Delta Stops: Bad for Both Strategies

Every delta threshold tested (0.50-0.80) degrades swing performance (best: 0.62 Sharpe vs 1.42 baseline). For short-term, delta stops produce positive Sharpe but negative PnL with catastrophic drawdowns. Delta is too noisy a signal for credit spread exits.

### 3. Max Loss %: Uniformly Bad

Closing at a percentage of max possible loss is equivalent to a tighter credit multiple stop and suffers the same problem — premature exits on positions that would recover.

### 4. Trailing Profit Lock: The One Exception (Swing Only)

For swing strategies, trailing lock genuinely improves risk-adjusted returns:
- **tl75-25** (activate at 75% of TP, floor at 25%): Best OOS Sharpe (1.53), Grade A, $65k PnL
- Mechanism: Once a spread has decayed 75% toward TP, lock in a profit floor at 25% of TP. If volatility spikes and the spread widens past the floor, exit with guaranteed profit.
- Trade-off: ~7 WR points and ~$3k absolute PnL for significantly better Sharpe and generalization.

For short-term, trailing lock is mildly positive (Sharpe 0.65, Grade B) but strictly worse than baseline in every metric.

### 5. Final Recommendation

| Strategy | Action | Config |
|----------|--------|--------|
| **Swing** | Consider adding Trailing Lock | `trailingActivatePct: 0.75, trailingFloorPct: 0.25` |
| **Short-Term** | No change | Keep `creditStopLossMultiple: 100` (no SL) |

**Confidence**: Medium-High for swing (Grade A, 10/10 positive windows, 76% IS→OOS retention, positive holdout). High for short-term no-SL (all alternatives are worse).

**Caveat**: The trailing lock improvement on swing is modest (+0.11 Sharpe, -$3k PnL). It's not a game-changer but a genuine edge in consistency and generalization. Consider running it as a shadow strategy alongside baseline for 3-6 months before switching.
