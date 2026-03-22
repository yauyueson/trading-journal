# Codex Prompt: WFA Credit Spread System — Full Audit & Improvement

## Your Role

You are a quantitative finance engineer auditing a Walk-Forward Analysis (WFA) system for credit spread options trading. Your job is to:

1. **Vet the simulation engine** for mathematical correctness, statistical validity, and realistic market assumptions
2. **Identify algorithmic flaws** that could produce misleading backtest results
3. **Propose concrete improvements** grounded in quantitative finance literature

This system has two strategies:
- **Swing trades** (45–65 DTE): OOS Sharpe 1.28, WR 89.5%, Max DD 4.6%, WFE 0.885 — appears robust
- **Short-term trades** (7–14 DTE): OOS Sharpe 0.20, WR 68.7%, Max DD 21.2%, WFE 0.35 — broken

You need to figure out **why** the short-term strategy fails and whether the swing strategy's numbers are genuinely robust or have hidden biases.

---

## System Architecture Overview

```
Signal Generation → IV Rank Filter → Chain Lookup → Trade Sim → Daily MTM → Exit Logic
     ↓                                                                        ↓
  4H candles (short)                                                    OptionTrade
  Daily candles (swing)                                                      ↓
                                                                   computeOptionAnalytics()
                                                                         ↓
                                                              WFA Window Optimization
                                                              (IS: rank by Sharpe →
                                                               OOS: validate best config)
```

### Key Files to Read

| File | What to Audit |
|------|---------------|
| `src/lib/backtest/option-sim.ts` | SimConfig (L84-124), `simulateCreditSpread()`, `computeOptionAnalytics()` (L814-907), DEFAULT configs (L128-172) |
| `src/lib/backtest/wfa-options.ts` | `buildWFAWindows()` (L39-76), optimization loop (L102-136), WFE calc (L295) |
| `src/lib/backtest/analytics.ts` | Sharpe/Sortino/profitFactor calculation, edge case guards |
| `src/lib/backtest/bsm-pricing.ts` | BSM model, O-U IV evolution, `normCDF`, `bsmDelta` |
| `src/lib/backtest/slippage.ts` | Dynamic slippage model (L37-63), fill logic (L78-104) |
| `src/lib/backtest/chain-cache.ts` | `findSpreadStrikes()` (L366-422), `findContractDirect()` (L590-618) |
| `src/lib/backtest/intraday-signals.ts` | `precomputeSignals4H()` (L77-167) — 4H bar signal generation |
| `src/lib/backtest/portfolio-stress.ts` | Correlated drawdown using dailyMtM |
| `scripts/wfa-run.ts` | Swing WFA runner — sweep grid (L438-476), signal filters, window config |
| `scripts/wfa-run-short.ts` | Short-term WFA runner — sweep grid (L190-233), dedup logic, min trade gate |
| `src/lib/backtest/types.ts` | SIGNAL_PRESETS (L605-622), type definitions |

---

## Area 1: Sharpe Ratio Calculation — Audit for Validity

### Current Implementation (`option-sim.ts` L857-860)

```typescript
const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
const stdVal = Math.sqrt(
  returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / Math.max(1, returns.length - 1)
);
const avgHoldDays = trades.reduce((s, t) => s + t.holdDays, 0) / trades.length;
const tradesPerYear = 252 / Math.max(1, avgHoldDays);
const sharpe = stdVal > 1e-10 ? (avgReturn / stdVal) * Math.sqrt(tradesPerYear) : 0;
```

### Questions to Answer

1. **Annualization method**: The formula uses `√(252 / avgHoldDays)` to annualize. This assumes trades are independent and identically distributed, with constant frequency. For credit spreads with variable hold periods (2-60 days), is this valid? Would `√(N_trades_per_year)` based on actual trade count in the period be more appropriate?

2. **Return definition**: Returns are computed as `pnl / maxLoss` (percentage of defined risk). This means a $1 spread with $0.10 credit and a $5 spread with $2.00 credit have the same "30% return" if both hit TP. Is this appropriate, or should returns be dollar-normalized to starting capital?

3. **Short-DTE inflation**: With avgHoldDays = 3 (short-term), `√(252/3) = 9.2×` amplification. With avgHoldDays = 40 (swing), `√(252/40) = 2.5×`. This structural bias makes short-term Sharpe ratios ~4× higher per unit of actual performance. Is this causing the optimizer to favor short-hold configs that happen to have low variance?

4. **Sample size**: No minimum sample size for Sharpe calculation. With 8 trades and 100% WR → Sharpe can exceed 100. We added a ≥30 IS trade gate, but is 30 sufficient? What's the statistical power for distinguishing Sharpe = 1.0 from Sharpe = 0.5 with N = 30?

5. **Non-normality**: Credit spread returns are highly negatively skewed (frequent small wins, rare large losses). Sharpe ratio assumes symmetric distributions. Would Sortino, Omega, or CAGR/MaxDD be better fitness functions for the WFA optimizer?

---

## Area 2: Walk-Forward Analysis Methodology

### Current Window Configuration

**Swing:**
- Train = 504 days (2yr), Step = 126 days (6mo), Purge = 65 days
- ~12 windows over 2018-2026, 240 configs per window

**Short-term:**
- Train = 189 days (9mo), Step = 42 days (2mo), Purge = 14 days
- ~19 windows over 2022-2026, 288 configs per window

### Questions to Answer

1. **Purge gap adequacy**: Swing uses 65-day purge for 45-65 DTE positions. Short-term uses 14-day purge for 7-14 DTE. Is the purge gap sufficient to prevent look-ahead bias? Specifically: if a position opens on the last day of training with 14 DTE, it expires 14 days into the purge zone, not into OOS. But does the **signal** for that trade contain information about the OOS period (e.g., IV regime that persists)?

2. **Config count vs. window count**: With 288 configs and 19 windows, we're running ~5,500 optimizations. The probability of finding a "good" config by chance in a 288-candidate pool is non-trivial. What's the multiple testing correction needed? Should we use Bonferroni or FDR-adjusted Sharpe thresholds?

3. **Walk-Forward Efficiency (WFE)**: Currently `WFE = OOS_Sharpe / avg(IS_Sharpe)`. This is a single scalar. Should we instead report per-window WFE distribution and flag windows where WFE < 0.3? Is there a better WFE formulation from the literature (e.g., Pardo's original definition)?

4. **Anchored vs. Rolling**: Swing uses rolling (fixed-width train). For a 4-year short-term dataset, rolling with 189-day windows means early data is discarded as windows advance. Would anchored (expanding) windows work better for short-term, since the regime is more recent?

5. **Config selection bias**: The optimizer picks the best IS Sharpe. With 288 candidates, the expected max of 288 draws from a null distribution is significant. Should we use a relative threshold (e.g., top-5% of configs must all agree) instead of argmax?

---

## Area 3: Option Pricing & IV Model

### Current BSM Implementation (`bsm-pricing.ts`)

```typescript
// O-U IV evolution for monitoring
σ_exit = σ_entry × e^(-κ×T) + θ × (1 - e^(-κ×T))
// κ = 4.0 (mean reversion speed)
// θ = HV60 (long-term vol target)
```

### Questions to Answer

1. **Risk-free rate**: Currently `riskFreeRate = 0` everywhere. For 45-65 DTE spreads, `e^(-r×T)` with r = 5% and T = 0.18yr gives a 0.9% discount factor. Is this material for spread pricing, or does it cancel out (both legs affected equally)?

2. **O-U mean reversion speed (κ = 4.0)**: This implies a half-life of `ln(2)/4 ≈ 63 days`. Is this calibrated from the data, or assumed? The 63-day half-life means IV reverts ~50% toward θ over the swing DTE range — is this realistic for equity index options?

3. **Theta target = HV60**: Using 60-day historical vol as the mean-reversion target assumes HV60 is a good estimate of forward realized vol. In practice, IV typically trades at a premium to HV (the Variance Risk Premium). Should θ = HV60 × VRP_multiplier?

4. **Put delta approximation**: `putDelta = callDelta - 1`. This is mathematically correct for European options. For American-style equity options with dividends, is there an early exercise premium that invalidates this?

5. **Missing Greeks**: The monitoring loop uses BSM delta to check delta stops but doesn't model gamma or vanna. For short-DTE spreads where gamma is extreme, could the daily monitoring interval miss intraday delta threshold crossings?

---

## Area 4: Fill Model & Market Microstructure

### Current Slippage Model (`slippage.ts`)

```typescript
slippage = halfSpread + baseImpact × oiFactor × dteFactor
// baseImpact = mid × 2 bps
// oiFactor = 1 + 500 / max(OI, 1)  — hyperbolic decay
// dteFactor = 1 + proximity × 2.0  — ramps up inside 7 DTE (3× at DTE=0)
```

### Questions to Answer

1. **Spread fill execution**: A credit spread requires filling two legs simultaneously. The current model applies slippage to each leg independently. In practice, spread orders get better fills than two separate legs. Is the current model overly pessimistic, or is independent-leg slippage closer to reality for 7-14 DTE options with thin OI?

2. **OI decay at short DTE**: Options near expiry often have concentrated OI at round strikes ($5 spacing on SPY) and near-zero OI at $1 strikes. The `oiFactor = 1 + 500/OI` becomes extreme (501×) when OI = 1. For $2.50 spread widths on AMD with 7 DTE, is this realistic?

3. **Bid-ask spread width**: The chain data stores bid/ask/mid. For short-DTE OTM puts, bid-ask spreads can be 50-100% of the option price. The `halfSpread` component may dominate slippage. Are we double-counting by adding `baseImpact` on top?

4. **Time-of-day effects**: The model assumes fills at a single daily snapshot. In reality, option spreads widen significantly at open/close and narrow midday. For a daily WFA, this is unavoidable, but should we add a time-of-day adjustment factor?

---

## Area 5: Signal Generation & Indicator Scaling

### 4H Signal Generation (`intraday-signals.ts`)

```typescript
// Period scaling for 4H bars
function scaleIndicatorPeriods(mult: number, opts: TechScoreOptions) {
  // EMA(8) → EMA(round(8 × mult))
  // EMA(20) → EMA(round(20 × mult))
  // etc.
}
```

### Questions to Answer

1. **Period multiplier = 1.0**: The short-term runner uses `periodMultiplier = 1.0` (no scaling). With ~2 bars per trading day (9:30-13:30, 13:30-close), EMA(8) on 4H bars = EMA(4 days). On daily bars, EMA(8) = EMA(8 days). The indicators respond twice as fast on 4H data. Should `periodMultiplier = 2.0` to match daily behavior, or is the faster response intentional for short-term signals?

2. **Signal presets**: `ema` isolates EMA stack alignment, `mom` isolates ROC momentum, `vol` isolates RVOL. For short-DTE trades where gamma dominates, is there a case for a `gamma`-aware preset that incorporates IV slope or term structure?

3. **Score threshold = 65 (short) vs 70 (swing)**: Lower threshold increases trade frequency but admits weaker signals. Has anyone validated that the score discriminates signal quality at 65? What's the empirical score distribution — is 65 the 30th percentile or the 60th?

4. **ADX filter = 8 (short) vs 10 (swing)**: ADX < 8 filters flat/directionless markets. For credit spreads that profit from theta (not direction), is filtering OUT low-ADX environments wrong? Credit spreads want non-trending (low ADX) markets.

---

## Area 6: Short-DTE Strategy — Why Does It Fail?

The short-term strategy produces OOS Sharpe 0.20, WR 68.7%, Max DD 21.2% — essentially break-even after costs. Diagnose:

### Known Issues (Already Fixed)

1. **Duplicate signals**: 4H bars produced 2 identical signals per day → 2× trade inflation. Fixed with deduplication by `{ticker, date, direction}`.
2. **$1 spreads gaming Sharpe**: Tiny absolute returns with near-zero variance → extreme Sharpe ratios. Fixed by removing $1 from sweep grid.
3. **Low-sample annualization**: 8 trades with 3-day hold → Sharpe 100+. Fixed with ≥30 IS trade gate.

### Open Questions

1. **Gamma risk**: Short-DTE options have extreme gamma. A 1% stock move can push delta from 0.30 to 0.60 intraday. Daily monitoring misses this. Is the strategy fundamentally incompatible with daily-resolution monitoring?

2. **Premium insufficiency**: With 7-14 DTE and $2.50-$7.50 widths, how much net credit is typically collected? If it's $0.20-$0.50 on a $2.50 spread, that's 8-20% max return — barely enough to overcome slippage + 30% of losing trades.

3. **Theta decay curve**: At 45 DTE, theta decay is roughly linear (2%/day). At 7 DTE, it's convex (accelerating). Does the profit target mechanism properly account for this? A 30% TP at 45 DTE takes ~15 days; at 7 DTE it should take 1-2 days. Are we seeing this in practice?

4. **Chain data completeness**: Short-DTE options expire weekly. Do all 14 tickers have weekly expirations with sufficient OI? Or are some tickers (IREN, CRWV, HOOD) missing chain data for 7-14 DTE?

5. **Regime sensitivity**: 2022-2026 includes a bear market (2022), recovery (2023), and bull run (2024-2025). The 189-day training window may overfit to one regime and fail in the next. What's the per-regime Sharpe breakdown?

---

## Area 7: Swing Strategy — Is It Really Robust?

The swing strategy reports OOS Sharpe 1.28, WR 89.5%, WFE 0.885. Stress-test these claims:

### Questions to Answer

1. **Survivorship bias**: The 14-ticker universe is curated (SPY, QQQ, AAPL, NVDA, etc.). These are some of the best-performing stocks of 2018-2025. Would the strategy work on a randomly selected universe of 14 liquid tickers?

2. **Regime concentration**: 2018-2025 was overwhelmingly bullish (except H1 2022). Put credit spreads (selling OTM puts) benefit structurally from up markets. What's the Sharpe in the 2022 bear period alone?

3. **WFE 0.885 interpretation**: This means OOS captures 88.5% of IS performance. But if IS Sharpe is inflated (240 configs, max selection), then WFE 0.885 × inflated IS still yields inflated OOS. What's the expected WFE under the null hypothesis (random configs)?

4. **Correlation risk**: Are the 14 tickers correlated enough that a broad market crash would hit all positions simultaneously? What's the portfolio-level max DD using `dailyMtM` (mark-to-market) instead of exit-date P&L?

5. **89.5% win rate sustainability**: This implies ~1 in 10 trades loses. But credit spread losses are typically 3-5× the size of wins (asymmetric payoff). Is the profit factor (gross wins / gross losses) actually healthy, or is it propped up by the high WR?

---

## Area 8: Proposed Mathematical Improvements

For each improvement, evaluate:
- **Impact** (how much could it improve results?)
- **Complexity** (how hard to implement?)
- **Risk** (could it introduce new biases?)

### 8.1 Alternative Fitness Functions

Instead of Sharpe for IS optimization, consider:

```
Sortino = avgReturn / downside_std × √(tradesPerYear)
Omega(threshold=0) = ∫P(r > 0)dr / ∫P(r < 0)dr
CAGR/MaxDD = annualized_return / max_drawdown
Calmar = CAGR / MaxDD (rolling 3yr)
Kelly = μ/σ² (optimal position sizing fraction)
```

Which would be most appropriate for credit spreads?

### 8.2 Ensemble Selection

Instead of picking the single best IS config, use an ensemble:
- Top-K configs (e.g., top 5 by Sharpe)
- Equal-weight their OOS signals
- Reduces variance of config selection

Is this standard in WFA literature? What K value balances diversification vs dilution?

### 8.3 Regime Detection

Add a regime classifier (e.g., HMM on VIX) that switches between configs:
- Low-vol regime → aggressive delta, no IV filter
- High-vol regime → conservative delta, IV ≥ 30
- Transition → reduce position size

How would you validate this without introducing a new layer of overfitting?

### 8.4 Portfolio-Level Optimization

Current: optimize per-trade Sharpe, ignore portfolio effects.
Proposed: optimize portfolio Sharpe with position sizing and correlation.

```
Portfolio Sharpe = E[Σ w_i × r_i] / std(Σ w_i × r_i)
```

This would penalize configs that produce correlated trades. Is this feasible within the WFA framework?

### 8.5 Transaction Cost Integration

Current: slippage applied to fills but not to the Sharpe calculation directly.
Proposed: net-of-cost returns in Sharpe calculation.

Are net returns already used? (Check if `pnl` in OptionTrade already includes slippage.)

---

## Deliverables

After auditing, provide:

1. **Bug Report**: Any mathematical errors, data leakage, or incorrect assumptions found in the code
2. **Validity Assessment**: For each strategy (swing and short-term), rate the reliability of reported metrics (1-5 scale) with justification
3. **Improvement Roadmap**: Ordered list of changes by impact/effort ratio, with pseudocode for the top 3
4. **Short-Term Strategy Verdict**: Can the 7-14 DTE strategy be salvaged, or is it fundamentally flawed? What would need to change?
5. **Statistical Power Analysis**: Given trade counts and window counts, what's the minimum detectable Sharpe difference between IS and OOS?
