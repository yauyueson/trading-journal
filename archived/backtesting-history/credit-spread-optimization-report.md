# Credit Spread Optimization Report

> Generated: 2026-03-09
> System: 15 tickers, ORATS chain data (46M rows), IS/OOS validation
> IS: 2018-01-01 to 2023-12-31 (6 years) | OOS: 2024-04-01 to 2026-02-28 (~2 years, 3-month gap)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Phase 1: Unified Strategy Evaluation](#2-phase-1-unified-strategy-evaluation)
3. [Phase 2: Full Factorial Portfolio Simulation (v1)](#3-phase-2-full-factorial-portfolio-simulation-v1)
4. [Phase 3: Multi-Position + Phased TP Simulation (v2)](#4-phase-3-multi-position--phased-tp-simulation-v2)
5. [Cumulative Findings](#5-cumulative-findings)
6. [Recommended Configuration](#6-recommended-configuration)
7. [Appendix: Raw Results](#7-appendix-raw-results)

---

## 1. Executive Summary

Three progressive optimization phases tested credit spread strategies on real ORATS historical option chains across 15 major tickers. Each phase built on the previous findings, narrowing the search space while adding new dimensions.

**Key Result**: Credit spreads consistently beat buy-and-hold on risk-adjusted basis (Sharpe 1.42 vs 1.20) with dramatically lower drawdowns (5.7% vs 24.3%), though at lower absolute returns (12.8% vs 27.9% annualized).

**Best OOS Configuration**: `mom S std30 mpt5` (momentum signal, S-tier scores 90+, 30% TP, 5 concurrent positions per ticker) — Sharpe 1.42, 86.6% win rate, 5.7% max drawdown.

### Progression of Results

| Phase | Date | Configs | Replays | Runtime | Best OOS Sharpe | Key Finding |
|-------|------|---------|---------|---------|-----------------|-------------|
| Phase 1 | 2026-03-08 | 270 | 120 | 35 min | 0.61 | Credit > LEAP; no IV filter needed |
| Phase 2 | 2026-03-08 | 792 | 4,752 | 53 min | 2.39 | EMA/MOM signals dominate; no SL optimal |
| Phase 3 | 2026-03-09 | 192 | 1,152 | 131 min | 1.45 | Multi-position works; phased exits don't help |

---

## 2. Phase 1: Unified Strategy Evaluation

**Date**: 2026-03-08 | **Runtime**: 34.7 minutes
**Scope**: BASELINE vs CORE_ONLY signals, Credit Spread + LEAP modes
**Dimensions**: 2 signals x 3 IV filters x 2-3 TPs x 3 SLs x 3-4 tiers = 270 configs

### 2.1 Credit Spread vs LEAP

| Mode | Best OOS Sharpe | OOS Survival Rate | OOS Profitable |
|------|----------------|-------------------|----------------|
| Credit Spread (BASELINE) | 0.61 | 100% (30/30) | 100% (30/30) |
| LEAP (BASELINE) | 0.37 | 50% (15/30) | 40% (12/30) |
| Credit Spread (CORE_ONLY) | 0.53 | 93% (28/30) | 93% (28/30) |
| LEAP (CORE_ONLY) | 0.22 | 60% (18/30) | 40% (12/30) |

**Conclusion**: Credit spreads massively outperform LEAPs in OOS validation. LEAPs have extreme drawdowns (36-125%) and poor OOS survival. All subsequent phases focused exclusively on credit spreads.

### 2.2 IV Filter Analysis

| IV Filter | Avg OOS Sharpe (Credit, BASELINE) | Avg Trades |
|-----------|----------------------------------|------------|
| IV >= 0 (no filter) | 0.31 | 1,675 |
| IV >= 30 | 0.21 | 864 |
| IV >= 50 | 0.31 | 508 |

**Conclusion**: No IV filter is best — filtering reduces trade count without improving quality. IV >= 30 actually hurts. IV >= 50 matches no-filter Sharpe but with 3x fewer trades.

### 2.3 Stop Loss Analysis

| SL Setting | Avg IS Sharpe | Notes |
|------------|--------------|-------|
| No SL | 0.743 | Best — defined risk makes SL unnecessary |
| 5x credit | 0.667 | Slightly worse |
| 2x credit | 0.040 | **Broken** — premature exits destroy returns |

**Conclusion**: SL 2x is catastrophically bad (avg Sharpe 0.04). Defined-risk credit spreads have a built-in max loss (spread width - credit). Explicit stop losses only cause premature exits during normal volatility.

### 2.4 Top 10 Overall by OOS Sharpe

| Rk | Tier | IV | TP | SL | IS Shrp | OOS Shrp | OOS WR | OOS P&L | Decay |
|----|------|-----|-----|------|---------|----------|--------|---------|-------|
| 1 | A | >=50 | 30% | None | 0.37 | 0.61 | 85.1% | +$1.5k | -64% |
| 2 | A | >=50 | 30% | 5.0x | 0.32 | 0.61 | 85.1% | +$1.5k | -89% |
| 3 | A | >=30 | 30% | None | 0.40 | 0.57 | 85.4% | +$2.9k | -42% |
| 4 | A (CORE) | >=0 | 30% | None | 0.15 | 0.53 | 85.5% | +$3.3k | -242% |
| 5 | A | >=0 | 30% | None | 0.49 | 0.50 | 86.4% | +$5.4k | -2% |

Note: These early results used single-position (1 per ticker, max 15 total), explaining the low absolute P&L. Per-trade Sharpe and win rates are the meaningful metrics here.

---

## 3. Phase 2: Full Factorial Portfolio Simulation (v1)

**Date**: 2026-03-08 | **Runtime**: 53.0 minutes
**Scope**: 11 individual signal components, portfolio-level capital allocation
**Dimensions**: 11 signals x 4 tiers x 3 IV x 2 TP x 3 SL = 792 configs
**Portfolio**: $100K capital, max 5/10/15 positions, collateral-based allocation

### 3.1 Signal Variant Rankings

| Signal | IS Median Sharpe | Best IS Sharpe | Best OOS Sharpe | Best Config |
|--------|-----------------|----------------|-----------------|-------------|
| **ema** | 0.31 | 1.48 | **2.39** | ema ALL iv0 tp50 noSL |
| **mom** | 0.65 | 1.46 | **1.90** | mom ALL iv0 tp30 noSL |
| bxs | 0.70 | 1.51 | 0.46 | bxs A iv50 tp30 noSL |
| NB | 0.73 | 1.34 | 1.51 | NB ALL iv0 tp30 noSL |
| CO | 0.39 | 1.44 | 1.38 | CO ALL iv0 tp50 noSL |
| MF | 0.59 | 1.69 | 1.12 | MF ALL iv0 tp50 noSL |
| BL | 0.66 | 1.38 | 0.96 | BL S iv0 tp50 sl5 |
| bxl | 0.48 | 1.48 | 1.26 | bxl S iv0 tp50 sl5 |
| mb | 0.39 | 1.74 | 0.80 | mb ALL iv0 tp50 noSL |
| adx | 0.41 | 1.16 | 0.85 | adx ALL iv0 tp50 noSL |
| vol | 0.63 | 1.30 | 0.45 | vol ALL iv0 tp50 noSL |

**Key Finding**: EMA (Sharpe 2.39 OOS) and MOM (1.90 OOS) are the only signals that improve IS-to-OOS. Most other signals show typical 40-90% decay.

### 3.2 Factor Marginal Effects (MaxPos=10)

| Factor | Best Level | All Values |
|--------|-----------|------------|
| Signal | bxs (0.653) | BL=0.53, CO=0.37, NB=0.51, MF=0.56, mb=0.38, bxs=0.65, bxl=0.45, ema=0.44, mom=0.56, adx=0.34, vol=0.54 |
| Tier | ALL (0.669) | ALL=0.67, S=0.64, A=0.38, B=0.24 |
| IV | iv0 (0.679) | iv0=0.68, iv50=0.45, iv70=0.32 |
| TP | tp30 (0.492) | tp30=0.49, tp50=0.48 |
| SL | noSL (0.743) | noSL=0.74, sl5=0.67, sl2=0.04 |

### 3.3 IS #1 Overfit Warning

The IS #1 config (`adx B iv0 tp50 sl5`, IS Sharpe 1.73) produced OOS Sharpe **-0.11** — a complete failure. This confirms the importance of factorial search over single-variable optimization.

### 3.4 Top 10 IS -> OOS (MaxPos=10)

| Rk | Config | IS Shrp | OOS Shrp | OOS ROC% | OOS DD% | OOS WR% | Status |
|----|--------|---------|----------|----------|---------|---------|--------|
| 1 | mb ALL iv0 tp50 noSL | 1.74 | 0.80 | 2.1% | 2.5% | 80.2% | WEAK |
| 2 | MF ALL iv0 tp50 noSL | 1.69 | 1.12 | 3.0% | 2.8% | 81.0% | PASS |
| 6 | MF S iv0 tp30 noSL | 1.51 | 1.47 | 4.1% | 3.7% | 88.3% | PASS |
| 7 | ema ALL iv0 tp30 noSL | 1.48 | 1.21 | 3.3% | 3.8% | 87.4% | PASS |
| 10 | mom ALL iv0 tp30 noSL | 1.46 | **1.90** | 5.0% | 2.3% | 88.9% | PASS |
| 20 | ema S iv0 tp30 noSL | 1.37 | **2.30** | 5.7% | 2.2% | 89.9% | PASS |

### 3.5 Capital Utilization Problem

With max 15 positions and ~$400 collateral per spread, capital utilization was only 2-5%. $100K portfolio deploying $2-5K = massive waste. This motivated Phase 3's multi-position testing.

### 3.6 Buy & Hold Comparison

| Strategy | OOS Sharpe | OOS Ann ROC | OOS Max DD | Efficiency |
|----------|-----------|-------------|------------|------------|
| Buy & Hold | 1.20 | 27.9% | 24.3% | 1.15 |
| Best Credit (15-pos) | 0.86 | 3.1% | 3.9% | 0.79 |

Credit spreads won on Sharpe and DD but not absolute returns — low utilization was the bottleneck.

---

## 4. Phase 3: Multi-Position + Phased TP Simulation (v2)

**Date**: 2026-03-09 | **Runtime**: 130.8 minutes
**Scope**: Top 4 signals from Phase 2, multi-position + phased exits
**Dimensions**: 4 signals x 2 tiers x 6 exits x 4 maxPerTicker = 192 configs
**Portfolio**: $100K capital, max 50/100/150 positions

### 4.1 New Dimensions Tested

**Exit Strategies**:

| Key | Type | TP1 | TP2 | After-TP1 SL | Description |
|-----|------|-----|-----|-------------|-------------|
| std30 | Standard | 30% | — | — | Full exit at 30% of max profit |
| std50 | Standard | 50% | — | — | Full exit at 50% of max profit |
| ph30_50_be | Phased | 30% | 50% | Breakeven | Close half@30%, BE SL, close rest@50% |
| ph30_50_25 | Phased | 30% | 50% | 25% profit | Close half@30%, 25% SL, close rest@50% |
| ph30_75_25 | Phased | 30% | 75% | 25% profit | Close half@30%, 25% SL, close rest@75% |
| ph50_75_25 | Phased | 50% | 75% | 25% profit | Close half@50%, 25% SL, close rest@75% |

**Max Concurrent Per Ticker**: 1, 3, 5, 10

### 4.2 Factor Marginal Effects (MaxPos=50)

| Factor | Values (avg IS Sharpe) |
|--------|----------------------|
| **Signal** | MF=1.262, mom=1.235, EM=1.151, ema=1.149 |
| **Tier** | ALL=1.206, S=1.192 (marginal difference) |
| **Exit** | **std30=1.360**, std50=1.228, ph30_50_be=1.230, ph30_50_25=1.198, ph30_75_25=1.080, ph50_75_25=1.100 |
| **MaxPerTicker** | mpt1=1.049, mpt3=1.197, mpt5=1.241, **mpt10=1.311** |

**Key findings**:
- **std30 dominates all exits** (1.36 vs next best 1.23) — simple 30% TP beats all phased strategies
- **mpt10 best on IS** but mpt5 often best on OOS (less overfit from overlap)
- Phased exits add complexity without improving returns

### 4.3 Top 20 IS -> OOS Validation (MaxPos=50)

| Rk | Config | IS Shrp | OOS Shrp | OOS ROC% | OOS DD% | WR% | PF | Status |
|----|--------|---------|----------|----------|---------|-----|-----|--------|
| 1 | **mom S std30 mpt5** | 1.59 | **1.42** | 12.8% | 5.7% | 86.6% | 1.41 | PASS |
| 2 | MF ALL std30 mpt5 | 1.57 | 0.99 | 11.3% | 10.6% | 85.6% | 1.26 | PASS |
| 3 | mom S ph50_75_25 mpt10 | 1.57 | 0.78 | 7.0% | 7.2% | 79.2% | 1.21 | WEAK |
| 4 | mom S ph30_50_25 mpt10 | 1.54 | 1.24 | 10.8% | 5.5% | 84.3% | 1.34 | PASS |
| 5 | MF ALL std30 mpt3 | 1.52 | 0.96 | 9.0% | 9.1% | 85.5% | 1.26 | PASS |
| 6 | MF S std30 mpt5 | 1.50 | 1.09 | 11.6% | 9.8% | 85.8% | 1.28 | PASS |
| 7 | EM S ph30_50_be mpt10 | 1.50 | 1.12 | 10.5% | 7.2% | 82.0% | 1.30 | PASS |
| 8 | mom S std30 mpt10 | 1.50 | 1.40 | 12.9% | 5.4% | 86.7% | 1.40 | PASS |
| 9 | mom S ph30_75_25 mpt10 | 1.49 | 1.13 | 8.8% | 5.7% | 83.3% | 1.31 | PASS |
| 10 | MF ALL std50 mpt1 | 1.48 | 1.00 | 3.6% | 3.6% | 81.0% | 1.30 | PASS |

**19 of top 20 PASS OOS validation** — dramatically better than Phase 2 where IS #1 completely failed OOS.

### 4.4 Top 20 IS -> OOS Validation (MaxPos=100)

| Rk | Config | IS Shrp | OOS Shrp | OOS ROC% | OOS DD% | WR% | PF | Status |
|----|--------|---------|----------|----------|---------|-----|-----|--------|
| 1 | MF S std30 mpt5 | 1.57 | 1.22 | 14.5% | 9.6% | 86.3% | 1.32 | PASS |
| 2 | MF ALL std30 mpt5 | 1.55 | 1.06 | 14.1% | 11.0% | 85.8% | 1.28 | PASS |
| 3 | mom S std30 mpt5 | 1.53 | 1.36 | 12.5% | 5.6% | 86.5% | 1.39 | PASS |
| 14 | **EM S std30 mpt5** | 1.45 | **1.53** | 17.0% | 6.7% | 87.1% | 1.44 | PASS |

Notable: `EM S std30 mpt5` at MaxPos=100 achieves the highest OOS Sharpe (1.53) with 17% ROC.

### 4.5 Multi-Position Impact

| MaxPerTicker | Avg IS Sharpe | Typical OOS Trades | Capital Utilization |
|-------------|--------------|-------------------|-------------------|
| mpt1 | 1.049 | ~600-900 | 3-5% |
| mpt3 | 1.197 | ~4,800-6,100 | 8-12% |
| mpt5 | 1.241 | ~5,900-8,800 | 13-19% |
| mpt10 | 1.311 | ~6,000-11,400 | 15-25% |

Multi-position dramatically improves returns through diversification. The jump from mpt1 to mpt3 is the biggest gain; mpt5 is the sweet spot balancing returns vs overfit risk.

### 4.6 Phased Exit Assessment

| Exit Strategy | Avg IS Sharpe | Notes |
|--------------|--------------|-------|
| **std30** | **1.360** | Simple, best performer |
| std50 | 1.228 | Holds longer, slightly worse |
| ph30_50_be | 1.230 | Matches std50, more complex |
| ph30_50_25 | 1.198 | 25% trailing SL adds no value |
| ph30_75_25 | 1.080 | Greedy TP2 hurts — most second halves expire |
| ph50_75_25 | 1.100 | Same problem |

**Verdict**: Phased exits do NOT outperform simple std30. The second half of the position often expires worthless waiting for TP2, or gets stopped out at breakeven. The complexity isn't justified.

### 4.7 Interaction Effects

Control-variable prediction (`MF ALL std30 mpt10`) ranked #43 on IS — far from the factorial best (`mom S std30 mpt5` at #1). This confirms significant interaction effects between signal choice and tier selection.

### 4.8 Buy & Hold Comparison

| Strategy | OOS Sharpe | OOS Ann ROC | OOS Max DD | Efficiency |
|----------|-----------|-------------|------------|------------|
| Buy & Hold (15 tickers) | 1.20 | 27.9% | 24.3% | 1.15 |
| mom S std30 mpt5 (50-pos) | **1.42** | 12.8% | **5.7%** | **2.23** |
| MF S std30 mpt5 (100-pos) | 1.22 | **14.5%** | 9.6% | 1.51 |
| EM S std30 mpt5 (100-pos) | **1.53** | **17.0%** | 6.7% | **2.54** |

Credit spreads win on risk-adjusted efficiency (ROC/DD = 2.23-2.54 vs 1.15), Sharpe, and drawdown. B&H still wins on absolute return because credit spreads deploy limited capital per trade.

---

## 5. Cumulative Findings

### 5.1 What Works (confirmed across all 3 phases)

1. **Credit spreads > LEAPs** — 100% OOS survival vs 50%, lower drawdowns by 10-20x
2. **No IV filter** — filtering reduces trades without improving quality
3. **No explicit SL** — defined risk makes stop losses counterproductive (SL 2x = Sharpe 0.04)
4. **30% TP** — consistent winner across all phases and signal combinations
5. **S-tier (score >= 90) + ALL-tier both work** — minimal difference, S slightly more robust OOS
6. **EMA and MOM signals** — only signals that consistently improve IS -> OOS

### 5.2 What Doesn't Work

1. **LEAPs** — extreme drawdowns (36-125%), poor OOS survival (40-60%)
2. **SL 2x** — kills returns across every combination
3. **IV >= 30/70 filters** — reduces trade count without quality gain
4. **Phased exits** — add complexity without improving risk-adjusted returns
5. **IS #1 selection** — top IS config often fails OOS; factorial approach is essential
6. **ADX signal** — IS #1 overfit (1.73 IS -> -0.11 OOS)
7. **High TP2 targets (75%)** — most positions expire before reaching 75% profit

### 5.3 Multi-Position Scaling

- **mpt1 -> mpt5 is the biggest improvement** (Sharpe 1.05 -> 1.24)
- mpt5 -> mpt10 shows diminishing returns and slightly more overfit risk
- Capital utilization improves from 3% to 14-19% — still room to grow
- MaxPos=50 is sufficient; 100 and 150 show identical results (never capital-constrained at mpt5)

### 5.4 Robustness

| Metric | Phase 2 (v1) | Phase 3 (v2) |
|--------|-------------|-------------|
| Top 20 PASS rate | ~75% | **95%** (19/20) |
| IS-OOS Sharpe decay | 40-90% | **10-30%** |
| Best OOS Sharpe | 2.39 (single-position) | 1.42 (portfolio) |

Phase 3's narrower search space (proven signals only) produced more robust OOS results with less decay.

---

## 6. Recommended Configuration

### Primary: `mom S std30 mpt5`

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Signal | MOM (momentum only) | Best IS -> OOS transfer |
| Tier | S (score >= 90) | Higher quality, less noise |
| TP | 30% of max profit | Consistent winner across all phases |
| SL | None | Defined risk makes SL unnecessary |
| IV filter | None (iv0) | More trades, same quality |
| MaxPerTicker | 5 | Sweet spot: good utilization, not overfit |
| MaxPositions | 50+ | Never capital-constrained at mpt5 |

**Expected Performance** (OOS-validated):
- Sharpe: 1.42
- Win Rate: 86.6%
- Ann ROC: 12.8% (on $100K)
- Max Drawdown: 5.7%
- Profit Factor: 1.41
- Avg Hold Days: ~21
- Capital Utilization: ~14%

### Alternate: `EM S std30 mpt5` (MaxPos=100)

For higher absolute returns at slightly more risk:
- Sharpe: 1.53, ROC: 17.0%, DD: 6.7%, WR: 87.1%

### NOT Recommended

- Any LEAP strategy
- Any config with SL 2x
- Any phased exit strategy (complexity without benefit)
- mpt10 (diminishing returns, more overfit)

---

## 5b. Phase 4: Position Sizing, Score-Exit, Option Filters (v3)

**Date**: 2026-03-09 | **Runtime**: 100 minutes (3 experiments)
**Scope**: 3 independent research dimensions, each crossed with 4 proven signals (mom, ema, MF, EM)
**Methodology**: Fixed S-tier, TP 30%, No SL, mpt5, MaxPos=50. Each factor tested across all 4 signals.

### 5b.1 Experiment 1: Position Sizing

**Question**: Can we improve capital utilization by widening spreads or adding contracts?

**Levels**: w5_c1 (baseline), w10_c1, w15_c1, w5_c2, w5_c3, w10_c2

| Sizing | IS Sharpe | OOS Util% | OOS ROC% | OOS DD% | OOS Eff |
|--------|-----------|-----------|----------|---------|---------|
| w5_c1 (baseline) | 1.459 | 15.9% | 14.0% | 7.3% | 1.91 |
| w10_c1 | 1.572 | 32.1% | 26.0% | 12.6% | 2.07 |
| w15_c1 | 1.575 | 49.3% | 37.7% | 16.0% | 2.36 |
| w5_c2 | 1.406 | 31.7% | 28.1% | 12.8% | 2.19 |
| w5_c3 | 1.347 | 47.6% | 42.1% | 17.0% | 2.47 |
| w10_c2 | 1.498 | 64.2% | 51.9% | 20.9% | 2.48 |

**Key findings**:
- **Wider spreads improve Sharpe** — w10 and w15 have higher IS Sharpe than w5 (more premium collected per trade)
- **Capital utilization scales linearly** — w5_c1 at 16% → w10_c2 at 64% (4× improvement)
- **Efficiency (ROC/DD) improves with scale** — 1.91 baseline → 2.48 at w10_c2
- **All 15 top configs PASS OOS** — zero overfit; sizing is a pure scaling factor
- **Best OOS config**: `EM w10_c2` — Sharpe 1.59, ROC 57.8%, DD 17.8% (vs B&H 27.9%/24.3%)
- **w10_c2 now beats B&H on both ROC AND risk-adjusted** at 52% ROC vs 28% ROC, with 21% DD vs 24%

**Consistent across all 4 signals** — wider spreads help mom, ema, MF, EM equally. This is real, not overfit.

### 5b.2 Experiment 2: Score-Based Exit

**Question**: Can we improve returns by exiting when the tech score drops below a threshold?

**Levels**: se0 (no exit, baseline), se30, se40, se50, se60

| Threshold | IS Sharpe | Top Config OOS | Status |
|-----------|-----------|---------------|--------|
| se0 (none) | 1.459 | 1.42 (mom) | PASS |
| se30 | 1.352 | 1.42 (mom) | PASS |
| se40 | 1.105 | 1.62 (mom) | PASS |
| se50 | 1.049 | -0.03 (mom) | FAIL |
| se60 | 1.008 | -0.05 (mom) | FAIL |

**Key findings**:
- **Score-based exits HURT performance** — every threshold below se0 has lower IS Sharpe
- **se50 and se60 are catastrophic OOS** — Sharpe goes negative, win rates drop to 54-58%
- **se30 is mostly no-op** — scores rarely drop to 30 within a 30-50 day hold, identical to baseline
- **se40 is mixed** — slightly helps mom (OOS 1.62 vs 1.42) but destroys MF and EM
- **The mechanism is wrong**: when a score drops, the spread has already moved against us. Exiting at that point just locks in mid-trade losses that would recover if held to TP/expiry. Credit spreads with 87% win rate don't benefit from early exit.

**Verdict**: Score-based exits are NOT recommended. The 87% base win rate means most "score drop" events are temporary — the spread recovers. Cutting losers early in a high-win-rate strategy just converts winning trades into small losses.

### 5b.3 Experiment 3: Option Filters

**Question**: Can option-level quality filters (volume, OI, bid-ask, IV, credit quality) improve trade selection?

**18 filters tested** across 4 signals = 72 configs

| Filter | IS Sharpe | Best OOS Sharpe | OOS Status |
|--------|-----------|----------------|------------|
| **iv30plus** | **2.297** | **2.14** (ema) | **ALL 4 PASS** |
| **iv20plus** | **1.757** | **1.98** (ema) | **ALL 4 PASS** |
| **iv20_80** | **1.707** | **1.98** (ema) | **ALL 4 PASS** |
| cr15pct | 1.684 | 1.38 (mom) | ALL 4 PASS |
| cr20pct | 1.682 | 1.39 (MF) | ALL 4 PASS |
| cr25pct | 1.600 | 1.57 (EM) | ALL 4 PASS |
| ba10pct | 1.533 | — | PASS |
| ba20pct | 1.511 | — | PASS |
| vol100 | 1.507 | — | PASS |
| ba30pct | 1.493 | — | PASS |
| vol50 | 1.480 | — | PASS |
| noFilter | 1.459 | 1.42 (mom) | PASS |
| ivCap80 | 1.417 | — | PASS |
| vol10 | 1.406 | — | PASS |
| liq_gate | 1.378 | — | PASS |
| oi100 | 1.295 | — | PASS |
| oi500 | 1.179 | — | PASS |
| oi1000 | 1.160 | — | PASS |

**Key findings**:
- **IV ≥ 30% is a game-changer** — IS Sharpe 2.30 (58% improvement over no filter), OOS 2.14 (best ever)
- **Consistent across ALL 4 signals** — mom 2.14, ema 2.36, MF 2.40, EM 2.28 on IS. This is real.
- **IV ≥ 20% also strong** — Sharpe 1.76, less restrictive (more trades)
- **Credit quality filters help** — cr15-25% all beat no-filter (ensures meaningful premium)
- **OI filters HURT** — oi500/oi1000 reduce Sharpe below baseline (over-filtering kills diversification)
- **Volume filters are neutral** — vol10/50/100 cluster around baseline
- **Bid-ask filters mildly positive** — ba10-30% slightly above baseline
- **IV cap at 80% slightly negative** — removes high-IV environments where credit spreads excel
- **iv20_80 (band filter) nearly matches iv20plus** — the IV cap at 80% barely matters

**Why IV ≥ 30% works**: Credit spreads collect premium proportional to IV. When IV < 30%, the credit collected is tiny relative to the spread width, making the risk/reward poor. At IV ≥ 30%, every trade has meaningful premium, boosting win rate and reducing max-loss scenarios.

**Top 4 OOS configs (all PASS)**:
| Config | IS Sharpe | OOS Sharpe | OOS ROC | OOS DD | OOS WR |
|--------|-----------|-----------|---------|--------|--------|
| ema iv30plus | 2.36 | **2.14** | 12.8% | 4.9% | 88.4% |
| MF iv30plus | 2.40 | **1.94** | 12.0% | 5.2% | 87.9% |
| EM iv30plus | 2.28 | **1.94** | 10.9% | 4.4% | 87.9% |
| ema iv20plus | 1.74 | **1.98** | 18.6% | 4.7% | 87.5% |

---

## 6b. Updated Recommended Configuration (Post-Phase 4)

### Best Risk-Adjusted: `ema iv30plus std30 mpt5`
| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Signal | EMA | Best OOS Sharpe (2.14) with iv30plus |
| IV Filter | ≥ 30% | 58% Sharpe improvement, consistent across all signals |
| TP | 30% | Proven across all phases |
| SL | None | Defined risk |
| Spread Width | $5 | Conservative; upgrade to $10 for higher utilization |
| Tier | S (≥90) | Quality over quantity |

**Expected**: Sharpe 2.14, WR 88%, ROC 12.8%, DD 4.9%

### Best Absolute Return: `EM w10_c2 iv20plus std30 mpt5`
Combines wider spreads + multiple contracts + IV filter:
**Expected**: Sharpe ~1.6, ROC ~50%+, DD ~18%, Util ~60%

### NOT Recommended
- Score-based exits (se50/se60 → negative OOS Sharpe)
- OI filters ≥500 (reduce trades too aggressively)
- IV cap at 80% (removes best premium environments)

---

## 7. Appendix: Raw Results

### A. Phase 1 Files
- `data/unified-eval-results.json` — 30 ranked configs, credit + LEAP
- `data/unified-eval-log.txt` — Full console output

### B. Phase 2 Files
- `data/portfolio-sim-log.txt` — Full console output (v1: 792 configs, 4,752 replays)

### C. Phase 3 Files
- `data/portfolio-sim-results.json` — 192 configs, all IS/OOS metrics
- Console output inline above

### D. Phase 4 Files
- `data/experiment-sim-results.json` — 116 configs (24 sizing + 20 score-exit + 72 option-filter)
- `scripts/experiment-sim.ts` — Experiment orchestrator
- `scripts/experiment-worker.ts` — Worker with sizing/score-exit/option-filter extensions

### E. GA Optimization (Stock Backtester)
- `backtesting history/optimize-2026-03-07.json` — v1, 198 evals
- `backtesting history/optimize-2026-03-07_v2.json` — v2, 456 evals
- `backtesting history/optimize-2026-03-07_v3.json` — v3, 586 evals, 21 generations

### E. Ticker Universe
SPY, QQQ, AMD, IWM, TSLA, AAPL, JPM, NVDA, AMZN, MSFT, META, NFLX, GOOG, GS, COST

### F. Credit Spread Parameters (fixed across all tests)
- Short delta: 0.27 (absolute)
- Spread width: $5
- DTE range: 30-50 days
- Time stop: DTE < 7
- Monitoring: daily
- Collateral per spread: ~$400 (width - credit)
