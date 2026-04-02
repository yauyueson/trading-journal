# Tier 2 Research Plan — Structural Improvements

**Goal:** Improve portfolio risk-adjusted returns by replacing binary regime gates with continuous signal-strength weighting. Each experiment modifies the portfolio sim in `scripts/short-put-1dte.ts` and must beat the same WFA baseline.

**Baseline:** QQQ bull + QQQ/SPY/IWM bear = Sharpe 0.985, CAGR 39.9%, MaxDD 47.9%, 809 trades, $10K start

**Current architecture limitation:** All regime logic (EMA alignment, IV Rank, pullback proximity) is binary — trade or skip. Position sizing is fixed % of equity (`maxRiskPct`). No cross-ticker awareness. This leaves alpha on the table.

---

## Experiment D: Dynamic Position Sizing

**Hypothesis:** Stronger regime signals produce higher win rates and better risk/reward. Scaling position size with signal strength (instead of fixed %) should improve Sharpe without increasing MaxDD proportionally.

**What "signal strength" means (concretely):**

| Signal Component | Weak (0.5x) | Normal (1.0x) | Strong (1.5x) |
|-----------------|-------------|---------------|----------------|
| EMA separation | EMAs barely ordered (< 0.3% apart) | Moderate (0.3-1%) | Wide separation (> 1%) |
| IV Rank | 15-25 (low premium) | 25-45 | > 45 (rich premium) |
| Pullback proximity | Far from pullback EMA | Near pullback EMA | At pullback EMA (already 2x via `pullbackSizeMultiple`) |
| Price vs EMA | Just crossed (< 0.2%) | Clear trend (0.2-1%) | Deep trend (> 1%) |

**Method:**
1. Compute a composite "regime confidence" score (0.0 - 1.0) on each signal day, combining the 4 components above with equal weight
2. Map confidence to a size multiplier: `sizeMultiplier = 0.5 + confidence` (range 0.5x to 1.5x of base `maxRiskPct`)
3. Run the same 16-window WFA with dynamic sizing vs fixed sizing
4. Compare Sharpe, CAGR, MaxDD, and critically: **win rate by size bucket** (do large positions actually win more?)

**Implementation (in `short-put-1dte.ts`):**

### Step 1: Add confidence scoring function (~line 600, after existing filters)
```typescript
function computeRegimeConfidence(
  close: number, ema1: number, ema2: number, ema3: number,
  ivRank: number | null, pullbackDist: number, direction: 'bull' | 'bear'
): number {
  // EMA separation score (0-1)
  const emaSep = Math.min(1, Math.abs(ema1 - ema3) / ema3 / 0.02);
  // IV rank score (0-1), null = 0.5 (neutral)
  const ivScore = ivRank != null ? Math.min(1, ivRank / 60) : 0.5;
  // Trend depth score (0-1)
  const trendDepth = Math.min(1, Math.abs(close - ema1) / ema1 / 0.015);
  // Pullback score (0-1), closer = higher
  const pullbackScore = Math.max(0, 1 - pullbackDist / 0.02);
  
  return (emaSep + ivScore + trendDepth + pullbackScore) / 4;
}
```

### Step 2: Replace fixed `sizeMultiplier` with dynamic (~line 730)
Currently: `sizeMultiplier = 1` (or 2x at pullback).
Change to: `sizeMultiplier = 0.5 + computeRegimeConfidence(...)` when `config.dynamicSizing` is true.

### Step 3: Add `dynamicSizing?: boolean` to config interface (~line 55)

### Step 4: Run comparison
- A: Baseline (fixed 10% risk) — already have this
- B: Dynamic sizing (5-15% risk based on confidence)
- Same total capital exposure on average, but concentrated on high-confidence signals

### Step 5: Validation
- Bucket all trades into Low/Med/High confidence
- Compute win rate, avg P&L, and Sharpe per bucket
- If High-confidence trades don't outperform Low-confidence: the signal has no predictive power → reject

**Go/no-go:**
- Sharpe >= 1.05 with dynamic sizing AND MaxDD <= 50% → adopt
- Win rate in High bucket must be >= 5pp above Low bucket (proves signal is predictive)
- If sizing just adds noise (Sharpe within +/- 0.03): reject, fixed sizing is simpler

**Estimated runtime:** ~2 hours (2 full portfolio sims)

**Risk:** Overfitting the confidence weights to in-sample. Mitigation: use only the OOS windows for evaluation, and keep the weight formula simple (equal-weight average, no learned coefficients).

---

## Experiment E: Correlation-Aware Portfolio Construction

**Hypothesis:** The current portfolio allocates equal risk (10%) to each leg regardless of how correlated they are. QQQ and SPY bears are ~85% correlated — they double the drawdown without doubling the diversification. Reducing weight on correlated legs and increasing weight on uncorrelated ones should reduce MaxDD without hurting CAGR.

**Current problem (concrete):**
- QQQ bear and SPY bear fire on the same days (both equity indices, similar EMA patterns)
- When both lose, the portfolio takes 2x the hit for ~1x the diversification benefit
- IWM has lower correlation to QQQ — it should get MORE weight, not equal

**Method:**

### Step 1: Compute rolling 60-day return correlation matrix
For each test window, compute pairwise correlations between daily returns of all active legs. Use the 60 trading days before the test window starts (look-back, not look-ahead).

```
Correlation matrix example:
           QQQ_bull  QQQ_bear  SPY_bear  IWM_bear
QQQ_bull      1.00     -0.72     -0.65     -0.45
QQQ_bear     -0.72      1.00      0.83      0.61
SPY_bear     -0.65      0.83      1.00      0.58
IWM_bear     -0.45      0.61      0.58      1.00
```

### Step 2: Inverse-correlation weighting
For each leg, compute its average absolute correlation with all other legs. Assign weight inversely proportional:
```
weight_i = (1 / avg_abs_corr_i) / sum(1 / avg_abs_corr_j)
```
This gives less correlated legs a higher share of the risk budget.

### Step 3: Map weights to `maxRiskPct` per leg
Currently all legs use `maxRiskPct: 0.10`. With correlation weighting:
- Total risk budget = 4 × 0.10 = 0.40 (40% across 4 legs)
- Redistribute: e.g., QQQ bear gets 8%, SPY bear gets 8%, IWM bear gets 12%, QQQ bull gets 12%
- Constraint: no single leg below 5% or above 20%

### Step 4: Run portfolio sim with dynamic per-leg `maxRiskPct`
Modify `runCombinedWFAPortfolio()` to accept per-leg risk weights that change each window based on trailing correlation.

### Step 5: Compare to equal-weight baseline

**Implementation (in `short-put-1dte.ts`):**

### Modify `runCombinedWFAPortfolio()` (~line 4392)
- Before each window: compute 60-day trailing correlation from stock returns (not option P&L — we don't have daily option returns pre-trade)
- Assign per-leg `maxRiskPct` based on inverse-correlation weights
- Run each leg with its assigned risk

### New function: `computeCorrelationMatrix()`
- Input: daily stock returns for QQQ, SPY, IWM over trailing 60 days
- Output: 3x3 correlation matrix (bull leg always gets base weight since it's the only bull)
- Source: stock candle data already in SQLite (`intraday-candles.sqlite` or chain cache price data)

**Go/no-go:**
- MaxDD reduction >= 3pp (from 47.9% to <= 44.9%) without Sharpe dropping below 0.95 → adopt
- If MaxDD unchanged: correlation weighting doesn't help for this portfolio → reject
- If Sharpe drops > 0.05: the reduced concentration hurts returns too much → reject

**Estimated runtime:** ~3 hours (need to compute correlations + run portfolio sims)

**Key insight to validate:** Is SPY bear actually redundant with QQQ bear? If removing SPY bear entirely doesn't hurt Sharpe, correlation weighting is moot — just drop the leg.

---

## Experiment F: Regime-Adaptive Bull/Bear Allocation

**Hypothesis:** In strong uptrends, the portfolio should lean bull-heavy (more capital to put spreads). In downtrends, lean bear-heavy (more capital to call spreads). Currently the allocation is static — each leg always gets 10% regardless of market regime.

**What this is NOT:** This is not a market-timing strategy that goes "all in" on one direction. It's a continuous tilt: 60/40 bull-heavy in uptrends, 60/40 bear-heavy in downtrends, 50/50 in choppy markets.

**Regime classification (using existing signals):**

| Regime | Definition | Allocation |
|--------|-----------|------------|
| Strong bull | SPY close > EMA21 > EMA34 > EMA55 | 65% bull / 35% bear |
| Mild bull | SPY close > EMA34 (but not full alignment) | 55% bull / 45% bear |
| Neutral | SPY between EMA34 and EMA55 | 50% bull / 50% bear |
| Mild bear | SPY close < EMA34 | 45% bull / 55% bear |
| Strong bear | SPY close < EMA21 < EMA34 < EMA55 | 35% bull / 65% bear |

**Why SPY as regime anchor (not per-ticker):** SPY represents the broad market. Using QQQ for QQQ's regime creates circular logic (QQQ EMA already gates QQQ trades). SPY as a macro overlay adds independent information.

**Method:**

### Step 1: Classify each trading day into one of 5 regimes
Use SPY daily close + 3 EMAs. This data is already computed in the WFA pipeline.

### Step 2: Compute regime-adjusted risk budgets
- Total risk budget per day = 0.40 (sum of 4 legs × 0.10)
- Bull share = regime tilt × 0.40 → distributed to bull leg(s)
- Bear share = (1 - regime tilt) × 0.40 → distributed across bear legs equally
- Constraint: individual leg risk stays within [0.05, 0.20]

### Step 3: Implement in portfolio sim
For each day within a test window:
1. Look up SPY EMA values → classify regime
2. Compute bull/bear risk split
3. Each leg's `maxRiskPct` = its share of the split
4. This changes on a daily basis (unlike Experiment E which changes per window)

### Step 4: Run comparison
- A: Static 50/50 (current) — already have this
- B: Regime-adaptive as described above
- C: More aggressive tilt (75/25 in strong regimes) — to test sensitivity

**Implementation (in `short-put-1dte.ts`):**

### Add regime classification function
```typescript
function classifyRegime(spyClose: number, spyEma21: number, spyEma34: number, spyEma55: number): 
  'strong_bull' | 'mild_bull' | 'neutral' | 'mild_bear' | 'strong_bear'
```

### Modify `runCombinedWFAPortfolio()` (~line 4392)
- Compute SPY EMAs for every date in the test range (need SPY candle data loaded)
- Before running each leg for a window, compute the daily regime schedule
- Pass per-day risk adjustments into `runStrategy()` — this requires a new mechanism since `runStrategy()` currently uses a single `maxRiskPct`

**Bigger change needed:** `runStrategy()` currently takes a fixed `maxRiskPct`. To support daily-varying risk, either:
- Option A: Pass a `Map<string, number>` of `date → maxRiskPct` (cleaner, more work)
- Option B: Run each leg day-by-day instead of window-by-window (major refactor, avoid)
- Option C: Run the window in "chunks" of same-regime days with different risk (compromise)

**Recommendation:** Option A — add `riskSchedule?: Map<string, number>` to config. In `runStrategy()`, if `riskSchedule` exists, use `riskSchedule.get(date) ?? maxRiskPct`.

**Go/no-go:**
- Sharpe >= 1.05 AND MaxDD <= 47% → adopt
- Must outperform in at least 12/16 windows (not just aggregate)
- If aggressive tilt (75/25) hurts Sharpe: regime timing is too noisy for this → reject even mild tilt
- If mild tilt helps but aggressive doesn't: adopt mild tilt only

**Estimated runtime:** ~4 hours (3 portfolio sims with daily regime computation)

**Risk:** Regime classification using SPY EMAs is look-ahead-free (uses prior close), but the tilt percentages (65/35 etc.) are arbitrary. Mitigation: test 3 tilt levels and look for monotonic improvement. If no monotonic relationship: reject.

---

## Dependencies Between Experiments

```
D (Dynamic Sizing) ──┐
                      ├──► Final combined portfolio sim
E (Correlation)  ─────┤    (adopt winning experiments together)
                      │
F (Regime Tilt)  ─────┘
```

- D, E, F are independent — can be tested in parallel
- If multiple experiments win, run a final combined sim with all winning modifications
- Combined sim must still beat baseline (individual improvements don't always stack)

---

## Execution Order

| # | Experiment | Code Effort | Runtime | Risk |
|---|-----------|-------------|---------|------|
| 1 | **D: Dynamic Sizing** | Small — add confidence scorer + multiplier | ~2 hrs | Low — modifies sizing only |
| 2 | **E: Correlation Weights** | Medium — new correlation computation + per-leg risk | ~3 hrs | Medium — requires stock return data |
| 3 | **F: Regime Tilt** | Medium — daily regime classification + risk schedule map | ~4 hrs | Higher — needs `runStrategy()` interface change |
| 4 | **Combined** | Small — merge winners | ~2 hrs | Low — if D+E+F tested |

**Total estimated:** ~11 hours of backtest runtime, ~4 hours of coding

---

## Success Criteria (same as Tier 1)

| Metric | Baseline | Target | Reject if |
|--------|----------|--------|-----------|
| Sharpe | 0.985 | >= 1.05 | < 0.95 |
| CAGR | 39.9% | >= 42% | < 35% |
| MaxDD | 47.9% | <= 45% | > 55% |
| Trade count | 809 | >= 600 | < 400 |
| Positive windows | ~13/16 | >= 13/16 | < 11/16 |

---

## What We Already Know (priors from Tier 1)

- **IV Rank filtering barely helped** (Tier 1 Exp B: ~5% Sharpe improvement). This suggests IV Rank as a binary gate isn't useful — but as a continuous sizing input (Exp D), it might add value.
- **Entry timing edge is ~8%** (Tier 1 Exp C). This is a behavioral change, not a structural one — orthogonal to Tier 2.
- **Pullback double-sizing already exists** and is baked into winning configs. Experiment D generalizes this concept.
- **QQQ/SPY bear correlation is likely high** based on both being equity index ETFs. Experiment E will quantify this — if > 0.8, SPY bear might just be dead weight.
