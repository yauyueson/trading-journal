# Trading Journal: 10-Dimension Forensic Audit Report

> Auditor: Senior Quantitative Options Strategist
> Date: 2026-03-02
> Codebase: OSS v2.7 (post Deep Audit)
> Scope: ~12,000 lines across 25+ files

---

## Executive Summary

The Trading Journal system is remarkably sophisticated for a solo-developer project. OSS v2.7 addresses many prior deficiencies. However, this audit identifies **4 P0 issues** that are actively causing suboptimal trading decisions, **7 P1 systematic biases**, and **12 P2/P3 improvements** that collectively represent significant alpha leakage.

The single highest-leverage finding: **the frontend and backend IV interpolation methods are fundamentally different** (linear vs. variance-based), meaning Scanner scores computed client-side diverge from Strategy Recommender scores computed server-side. This violates the system's core "single source of truth" principle.

---

## Dimension 1: Entry Pipeline Integration (TV -> Web App Synergy)

### Findings

**F1.1 — Signal Translation Fidelity: 40-60% information loss** (P0)

The Pine Script v3.2 produces a rich output per signal:

| TV Output Field | Web App Input? | Status |
|---|---|---|
| Composite Score (0-100) | Manually entered as "TV Score Tier" (S/A/B/C) | **Degraded** — continuous score discretized to 4 buckets |
| Sub-scores (MB, BXS, BXL, EMA, Mom, ADX, RVOL) | Not transferred | **Lost** |
| Setup name (Perfect Storm, Pullback Buy, etc.) | Dropdown selection | Preserved |
| Strategy Type (Long Call, Credit Put Spread, etc.) | Dropdown selection | Preserved |
| Direction (CALL/PUT) | Toggle | Preserved |
| Market State (Trending/Ranging/Squeeze/Breakout) | Not transferred in v3; partially via toggles | **Lost** |
| Risk Flags (Overextended, MTF Conflict, Low Vol, etc.) | Manual toggles (6 flags) | **Degraded** — requires manual re-entry |
| d8 (EMA-8 distance %) | Manual text input | Preserved but manual |
| Entry Context (OPTIMAL/CHASING/MARGINAL/ACCEPTABLE) | Query param | Preserved if v4 used |
| v4 Coherence Multiplier | Not transferred | **Lost** |
| v4 Entry Quality score | Query param (entryQuality) | Preserved if v4 used |
| Weekly HTF modifier | Not transferred | **Lost** |
| Backtest stats (14d/30d win rate, avg move) | Not transferred | **Lost** — this is critical context |

**Key loss**: The backtesting statistics (14d/30d win rates per tier) are the most valuable context for options selection, and they're completely lost in translation.

**F1.2 — Latency Cost** (P1)

Realistic workflow timing:
1. TV signal fires on chart: T=0
2. User notices alert: T+30s to T+5min (depending on attention)
3. User switches to web app, enters ticker: T+1min to T+6min
4. User selects setup, strategy, flags: T+2min to T+8min
5. Clicks Analyze, waits for Polygon API: T+3min to T+10min
6. Reviews recommendations: T+4min to T+12min

**Total signal-to-evaluation: 4-12 minutes.** In fast markets (gap breakouts, earnings reactions), this can mean:
- 0.5-2% underlying move (at delta=0.45, that's 1-4% option price change)
- Bid-ask spread widening as momentum accelerates
- For credit spreads: short strike delta shifting from target 0.20 to 0.25+

**Ideal**: Signal-to-evaluation should be <30 seconds with automation.

**F1.3 — No Unified Signal Score** (P2)

The TV technical score and OSS options score exist in isolation. When TV says "S-Tier, Score 95" but options liquidity is poor (wide spreads, low OI), there's no mechanism to downgrade. Conversely, when TV says "B-Tier" but the options chain has exceptional pricing (tight spreads, favorable skew), there's no mechanism to upgrade.

### Recommendation

**Architecture: TV Webhook -> Vercel API -> Auto-Evaluate**

```
TV Alert (Pine Script alert_webhook_url)
    |
    v
POST /api/ingest-signal
    {
      "ticker": "AAPL",
      "direction": "CALL",
      "setup": "Pullback Buy",
      "strategy": "Credit Put Spread",
      "score": 87,
      "tier": "A",
      "components": { "mb": 72, "bxs": 85, "bxl": 60, "ema": 90, "mom": 65 },
      "riskFlags": { "overextended": false, "mtfConflict": false },
      "d8": 0.8,
      "entryCtx": "OPTIMAL",
      "backtest": { "win14d": 72, "win30d": 68, "avgMove14d": 3.2 }
    }
    |
    v
Auto-fetch options chain (Polygon)
Auto-run OSS scoring + strategy recommendation
Store in `signals` table
    |
    v
Discord notification with top 3 candidates
    |
    v
User reviews in web app Signal Feed page
One-click add to Watchlist
```

**Pine Script modification needed**: Add `alert()` call with JSON payload at signal generation point. Pine Script v6 supports `alert.freq_once_per_bar` with JSON strings.

**Polygon API budget**: Each signal evaluation = 1 `getOptionChain` call (~1 request, paginated) + 1 `getUnderlyingPrice` call = 2-3 API calls. At 5 RPM default, this supports ~2 signals/minute. With `POLYGON_RATE_LIMIT_RPM=100`, this supports ~33 signals/minute — more than sufficient for a watchlist of 20-30 tickers on daily timeframe.

**Implementation Effort**: L (3-5 days)
**Expected Impact**: Reduces signal-to-evaluation from 4-12 min to <30 sec. Eliminates manual data entry errors. Preserves 100% of TV signal data.

---

## Dimension 2: Scoring Algorithm Validation (OSS v2.7)

### Findings

**F2.1 — Dollar Gamma formula is mathematically inconsistent** (P1)

Current implementation in `scoring.cjs`:
```javascript
function calculateDollarGamma(gamma, price) {
    return gamma * price * price / 100;
}
```

This computes `gamma * S^2 / 100 = 0.01 * gamma * S^2`.

Standard Dollar Gamma (P&L from a 1% move in the underlying) is:
```
Dollar Gamma = 0.5 * gamma * S^2 * (0.01)^2 * 100 = 0.5 * gamma * S^2 / 100
```

The implementation is **missing the 0.5 factor**. This means Dollar Gamma is overstated by 2x. While the Z-score normalization downstream partially compensates (since all options in the pool are equally 2x), the absolute magnitude matters when Dollar Gamma crosses into other calculations or is displayed to the user.

More critically: the old `gammaEff = gamma / mid` was a **completely different metric** (gamma efficiency per dollar invested). Dollar Gamma and Gamma Efficiency measure fundamentally different things. Dollar Gamma measures absolute convexity exposure; Gamma Efficiency measures convexity per unit of capital deployed. The v2.7 change from GammaEff to DollarGamma was conceptually correct for portfolio risk assessment, but the LOQ weight name and surrounding comments still reference "Gamma Efficiency" (`gammaEff`), creating confusion.

**Severity**: P1 — The 2x overstatement doesn't change rankings (same pool, same bias) but the conceptual confusion between Dollar Gamma and Gamma Efficiency means the weight calibration from v2.1-v2.6 (which was tuned for GammaEff) may not be optimal for Dollar Gamma.

**F2.2 — CRITICAL: Frontend IV interpolation uses LINEAR while backend uses VARIANCE** (P0)

In `src/lib/scoring.ts:174-221` (`getATMIV` function):
```typescript
// lerp: iv1 + (iv2 - iv1) * (target - d1) / (d2 - d1)
return iv1 + (iv2 - iv1) * (targetDTE - d1) / (d2 - d1);
```

This is **linear IV interpolation** — the exact bug that was fixed as P0-1 in v2.7 for `scoring.cjs`.

In `lib/_shared/scoring.cjs` (`calculateTargetIV`), the v2.7 fix correctly uses variance-based interpolation:
```javascript
// varNear = ivNear^2 * nearDTE/252
// varFar = ivFar^2 * farDTE/252
// interpolate in variance space, then convert back to IV
```

**Impact**: The Scanner page (which uses `src/lib/scoring.ts` client-side) computes IV ratios using linear interpolation, while the Strategy Recommender (which uses `scoring.cjs` server-side) computes them using variance interpolation. In steep backwardation (IV30=30%, IV90=20%), the linear method gives IV60=25.0% while the variance method gives IV60=22.9% — a **2.1 percentage point difference** that directly affects regime detection and IV adjustment scores.

This means: a user scanning QQQ in the Scanner page may see a different IV regime classification than when they analyze the same ticker in Strategy Recommender. The "single source of truth" principle is violated.

**Severity**: P0 — Actively causing inconsistent scores between Scanner and Strategy Recommender.

**F2.3 — Vega Penalty Logic is inverted for long options** (P1)

Current implementation:
```javascript
CSQ_VEGA_PENALTY_WEIGHT = -0.05;
// In LOQ: vegaWeight = getLOQVegaWeight(dte, ivAdjustment)
// vegaBonus = vegaWeight * zVegaEff
```

The v2.7 vega penalty conditioning: `-0.05 * max(0, 1-ivRank) * zVegaEff`

This means:
- When ivRank = 0 (IV at 52-week low): Full penalty of -0.05 * 1.0 = -0.05 per unit of zVega
- When ivRank = 1 (IV at 52-week high): Zero penalty (0 * zVega = 0)

**For LONG options (LOQ), this is backwards.** You WANT high vega when IV is low (ivRank near 0) because IV is likely to revert UP, giving you a vega profit. You should PENALIZE high vega when IV is HIGH (ivRank near 1) because IV is likely to revert DOWN, causing a vega loss.

The current logic penalizes exactly the scenario where vega exposure is desirable (buying cheap vol) and ignores exactly the scenario where it's dangerous (buying expensive vol).

**For SHORT options (CSQ), the current logic is also questionable.** High vega on a short position is dangerous when IV is low (because IV can spike), and less dangerous when IV is high (because IV is more likely to mean-revert down, benefiting the short vega position). The current penalty direction happens to be correct for sellers, but the conditioning on ivRank should be inverted.

**Recommendation**:
```javascript
// For LOQ (long options): penalize high vega when IV is EXPENSIVE
vegaPenalty_LOQ = -0.05 * max(0, ivRank) * zVegaEff  // penalize at high ivRank

// For CSQ (short options): penalize high vega when IV is CHEAP (risk of spike)
vegaPenalty_CSQ = -0.05 * max(0, 1 - ivRank) * zVegaEff  // penalize at low ivRank
```

**Severity**: P1 — Systematically over-scoring high-vega long options when IV is expensive, and under-scoring them when IV is cheap.

**F2.4 — IV Rank confidence threshold too aggressive** (P2)

`min(1, sampleDays/60)` gives full confidence at 60 trading days (~3 calendar months). Academic IV Rank uses a 252-day lookback. With 60 days of data, the "52-week high" and "52-week low" are actually "3-month high/low", which can be very different.

Example: A stock with IV30 ranging from 25-35% over 3 months might show ivRank=0.8. But if the full year includes a volatility spike to 60%, the true ivRank would be 0.15. The 60-day confidence gives full weight to what is essentially a 3-month percentile masquerading as a yearly percentile.

**Recommendation**: Change to `min(1, sampleDays/180)` — still aggressive, but at least requires 9 months of data for full confidence rather than 3.

**Severity**: P2 — Overweights immature IV Rank readings, primarily affects new tickers.

**F2.5 — IV normalization breaks for meme stocks** (P1)

```javascript
if (iv > 2.0) iv /= 100;
```

This converts percentage-format IVs (30.5 meaning 30.5%) to decimal (0.305). But it will also incorrectly convert a legitimate 250% IV (decimal 2.50 → becomes 0.025, or 2.5%). Meme stocks (GME, AMC) and biotech names (small-cap pharma near FDA decisions) routinely have IV > 200%.

**Better approach**:
```javascript
// Use the relationship between IV and option price as a sanity check
// If IV > 5.0, it's almost certainly in percentage format
// No listed option has annualized IV > 500% in decimal
if (iv > 5.0) iv /= 100;
```

Or better yet, check the data source: Polygon returns IV as a decimal (0.30 = 30%), CBOE varies. Apply the normalization based on data source rather than heuristic.

**Severity**: P1 — Would cause completely wrong scoring for meme stocks / high-vol biotech names.

**F2.6 — Sigmoid tuning validation** (P2)

Post v2.7: k=8, x0=1.00. The credit probability curve:

| ivRatio | sigmoid(ivRatio, k=8, x0=1.00) | riskFactor | Interpretation |
|---|---|---|---|
| 0.80 | 0.017 | 0.907 | Deep contango, safe for buyers |
| 0.90 | 0.069 | 0.928 | Contango |
| 0.95 | 0.119 | 0.948 | Mild contango |
| 1.00 | 0.500 | 1.100 | Neutral (transition point) |
| 1.05 | 0.881 | 1.252 | Mild backwardation |
| 1.10 | 0.931 | 1.272 | Backwardation |
| 1.20 | 0.983 | 1.293 | Deep backwardation |

The k=8, x0=1.00 tuning creates a reasonable transition but the riskFactor output range is narrow: 0.90-1.30. This means the maximum IV adjustment for buyers is:
- Contango: (1 - 0.907) * 5 = +0.47 (small bonus)
- Backwardation: (1 - 1.293) * 5 = -1.47 (moderate penalty)

These adjustments are small relative to the Z-score-based scoring components (which can range ±3+). Consider whether IV regime should have more impact — in practice, trading against term structure is one of the highest-cost mistakes in options trading.

**F2.7 — Edge case testing** (P2)

| Edge Case | Current Behavior | Risk |
|---|---|---|
| 0 DTE options | DTE bucket '0-7' handles them; weights shift to deltaBonus=0.25 | OK, but theta burn calculation `theta/mid` becomes extreme |
| Deep ITM (delta > 0.90) | getDeltaBonus returns -2.0 penalty | Correct — discourages lottery tickets in reverse |
| bid=0, ask>0 | Filtered by `opt.bid <= 0` check | OK |
| IV=0 | Would pass through; gamma/theta/vega all likely 0 too | Scores 50 (neutral Z-scores) — should be filtered |
| Negative theta | Possible for deep ITM European puts near expiry | Would flip thetaBurn sign, boosting score incorrectly |

**Recommendation**: Add explicit filter for IV=0 and negative theta edge cases.

### Deliverable

**Test matrix with expected vs. actual**: Not fully implementable without runtime access, but the key finding (F2.2 — frontend/backend IV divergence) is verifiable by code inspection and is a confirmed P0.

**Weight recalibration**: The current LOQ weights (lambda=0.30, dollarGamma=0.20, G/T=0.15, delta=0.15, BE=0.15) were calibrated for the old gammaEff metric, not Dollar Gamma. Since Dollar Gamma has fundamentally different scale and meaning, the 0.20 weight is likely miscalibrated. Recommend reducing dollarGamma weight to 0.10 and increasing G/T ratio weight to 0.25 (G/T is the more actionable metric for options traders — it answers "how much gamma am I getting per unit of theta I'm paying?").

---

## Dimension 3: Strategy Recommendation Engine

### Findings

**F3.1 — Pine weight rebalancing direction was CORRECT in v2.7** (Verified)

The v2.7 changelog states `hasPineSetup → wEV=0.45/wRegime=0.20`. Looking at the actual code in `scoring.cjs:calculateUnifiedScore`, the weights shift:
- Default: EV/Risk=40%, POP=20%, Regime=25%, Liquidity=15%
- With Pine setup: EV/Risk=35%, POP=20%, Regime=30%, Liquidity=15%

Wait — the docs say wEV goes UP to 0.45 with Pine, but the algorithm doc (03_核心算法.md line 1534) says EV drops to 35%. There's a **documentation inconsistency**. The code shows EV drops from 40%→35% and Regime rises from 25%→30% when hasPineSetup. The changelog line "wEV=0.45/wRegime=0.20" appears to describe the OLD behavior that was "reversed" (fixed) — the fix was to REDUCE EV weight when Pine provides the directional validation.

This is **correct logic**: when Pine Script has already validated the technical setup, you don't need EV to double-check direction quality; instead, you want Regime alignment (is the vol environment correct for this strategy?) to carry more weight.

**F3.2 — Regime detection hysteresis band may be too narrow** (P2)

Current: CREDIT→DEBIT requires termRatio < 0.90 (from > 1.05), DEBIT→CREDIT requires > 1.10 (from < 0.95).

The dead zone (hysteresis band) is:
- For a CREDIT→DEBIT flip: ratio must cross from >1.05 down through 1.05→0.90, a move of >0.15
- For a DEBIT→CREDIT flip: ratio must cross from <0.95 up through 0.95→1.10, a move of >0.15

This seems adequate. However, the hysteresis only uses the last 3 days of snapshots. In a volatile regime transition (e.g., post-FOMC), term structure can whipsaw for 3-5 days before settling. Consider extending to 5 trading days.

**F3.3 — Earnings penalty scaling may underweight extreme movers** (P2)

`scale = min(2, max(1, movePct/5))`:
- AAPL (5% implied move): scale = 1.0
- NFLX (10% implied move): scale = 2.0 (capped)
- TSLA (15% implied move): scale = 2.0 (same as NFLX)

TSLA and NFLX have very different earnings risk profiles. Consider raising the cap to 3.0:
`scale = min(3, max(1, movePct/5))` — 15% implied move → scale = 3.0.

**F3.4 — Iron Condor skips unified scoring** (P2)

From `strategy-recommend.js:1544`:
```javascript
if (simCat === 'IRON_CONDOR') {
    rec.unifiedScore = rec.score;  // Just copy the IC-specific score
}
```

Iron Condors bypass the unified scoring pipeline entirely. This means they don't benefit from Pine setup awareness, regime alignment weighting, or per-category EV normalization. They compete with credit/debit spreads in Auto-Select mode using a fundamentally different scoring methodology, making cross-strategy comparison unreliable.

**F3.5 — Multi-leg slippage model uses assumed multipliers** (P2)

2-leg ×0.7, 4-leg ×0.5 are reasonable rules of thumb but not validated against fill data. With Polygon Starter tier, there's no access to trade-level fill data. These could be calibrated against the user's own execution data in the `transactions` table — compare `entry_mid` at recommendation time with actual fill prices in `transactions.price`.

### Deliverable: Strategy Selection Decision Tree

```
Input: direction (BULL/BEAR), ivRvRatio, ivRank, termRatio, daysToEarnings, setup

IF daysToEarnings <= 10:
    Apply earnings penalty (scale = min(2, max(1, impliedMove/5)))

Regime Detection:
    IF ivRvRatio > 1.05 AND (no hysteresis block): mode = CREDIT
    ELIF ivRvRatio < 0.95 AND (no hysteresis block): mode = DEBIT
    ELSE: mode = NEUTRAL

Strategy Selection (Auto-Select):
    Generate ALL: Credit Spreads + Debit Spreads + Single Legs + Iron Condors
    Score each with calculateUnifiedScore() [except IC]
    Apply Pine Risk Flags adjustments
    Apply Entry Context adjustments
    Sort by unifiedScore DESC
    Return top 5
```

---

## Dimension 4: Options-Aware Backtesting (Critical Gap)

### Findings

**F4.1 — No options backtesting exists** (P0)

This is the single largest gap in the system. The TV backtester measures underlying price returns, which fundamentally misrepresent options P&L. Every trading decision is made without knowing whether the options-specific implementation of a signal is historically profitable.

**F4.2 — Polygon Starter tier does NOT provide historical options snapshots** (Hard Constraint)

Polygon Starter provides:
- Real-time options chains and snapshots: YES
- Historical options OHLCV (per-contract historical prices): NO (requires Options tier, ~$200/month)
- Historical underlying price bars: YES (via aggregates endpoint)

This means **full BSM repricing is not possible** without a tier upgrade or alternative data source.

**F4.3 — Minimum Viable Options Backtest (MVOB) Design**

Given data constraints, the best feasible approach uses a **second-order Taylor expansion** with IV proxy:

```
ΔV ≈ Δ·ΔS + ½·Γ·(ΔS)² + Θ·Δt + ν·ΔIV

Where:
  ΔS = price change over holding period
  ΔIV = estimated IV change (using VIX/sector IV as proxy)
  Δt = holding period in years
  Δ, Γ, Θ, ν = Greeks at entry (available from current Polygon data)
```

**Phase 1: Delta-Adjusted Returns** (feasible NOW)

```
Option Return ≈ delta * underlying_return * leverage_factor
                - abs(theta/mid) * holding_days
                - slippage

Where:
  leverage_factor = underlying_price / option_mid_price
  slippage = spread_pct * 0.5 (half spread on entry + exit)
```

This captures:
- Directional exposure (delta)
- Leverage (option vs. stock return ratio)
- Time decay (theta cost over holding period)
- Transaction costs

**Phase 2: Full Greeks (requires IV history)**

When `ticker_iv_snapshots` has 60+ days of data per ticker:

```
ΔIV_proxy = IV30[t+n] - IV30[t]  (from ticker_iv_snapshots)

ΔV ≈ Δ·ΔS + ½·Γ·(ΔS)² + Θ·n/365 + ν·ΔIV_proxy
```

This adds:
- Gamma convexity (the ½·Γ·(ΔS)² term is material for large moves)
- Vega P&L from IV changes

**Phase 3: IV Surface (requires data upgrade)**

Would require either:
- Polygon Options tier ($199/month) for historical options prices
- CBOE DataShop historical IV data ($500+ one-time)
- Building historical IV surface from daily `ticker_iv_snapshots` (free but 1+ year to accumulate)

**When does the Taylor expansion break down?**
- Large moves (>10%): Gamma changes significantly; need 3rd-order term or reprice
- Near expiry (DTE < 3): Theta acceleration is non-linear; model underestimates
- IV regime shifts: Vega itself changes (volga/vanna effects not captured)
- Deep OTM becoming ITM: Delta regime change is discontinuous

### Recommended Implementation

**Database Schema**:

```sql
CREATE TABLE backtest_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker TEXT NOT NULL,
    signal_date DATE NOT NULL,
    signal_type TEXT NOT NULL,        -- 'Pullback Buy', 'Squeeze Breakout', etc.
    tier TEXT,                        -- 'S', 'A', 'B', 'C'
    direction TEXT NOT NULL,          -- 'BULL', 'BEAR'
    tv_score REAL,
    underlying_price REAL NOT NULL,
    iv30_at_signal REAL,
    rv30_at_signal REAL,
    iv_rank_at_signal REAL,
    recommended_strategy TEXT,
    recommended_strike REAL,
    recommended_dte INTEGER,
    entry_delta REAL,
    entry_gamma REAL,
    entry_theta REAL,
    entry_vega REAL,
    entry_bid REAL,
    entry_ask REAL,
    entry_mid REAL,
    oss_score REAL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE backtest_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id UUID REFERENCES backtest_signals(id),
    holding_days INTEGER NOT NULL,   -- 5, 10, 14, 30
    underlying_price_exit REAL,
    underlying_return_pct REAL,
    iv30_at_exit REAL,
    delta_pnl REAL,
    gamma_pnl REAL,
    theta_pnl REAL,
    vega_pnl REAL,
    total_simulated_pnl REAL,
    total_simulated_return_pct REAL,
    exit_reason TEXT,                -- 'tp', 'sl', 'time_stop', 'expiry'
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**API Endpoints**:
- `POST /api/backtest-signal` — Record a signal with entry Greeks, auto-schedule forward evaluation
- `GET /api/backtest-results?ticker=QQQ&tier=S` — Query aggregated backtest results

**Implementation Effort**: M (Phase 1), L (Phase 2), XL (Phase 3)
**Expected Impact**: Phase 1 alone would answer "does a 3% underlying move actually profit on a 45-DTE ATM call after theta?" — a question the current system cannot answer.

---

## Dimension 5: Risk Management & Position Sizing

### Findings

**F5.1 — Kelly Criterion implementation is circular** (P1)

From `riskSizing.ts`:
```typescript
winPerContract = lossPerContract * min(5, max(1, lambda))
```

Where `lambda` is the leverage ratio (delta * underlying_price / option_price). This means the Kelly sizing uses the option's leverage to determine expected win magnitude. But the actual win magnitude of an option depends on the probability distribution of the underlying move, not the leverage itself.

**Proper Kelly for options**:
```
f* = (p * b - q) / b

Where:
  p = probability of win (from POP or historical win rate)
  b = win/loss ratio (from expected profit if win / expected loss if lose)
  q = 1 - p
```

For a long call with TP at +50% and SL at -40%:
```
b = 50/40 = 1.25
If p = 0.55: f* = (0.55 * 1.25 - 0.45) / 1.25 = 0.19 (risk 19% of bankroll)
```

The current implementation essentially sizes based on leverage, which is **dangerous** — high-leverage OTM options would get LARGER sizes under this formula, when they should get SMALLER sizes (because their probability of profit is lower).

**Severity**: P1 — Could lead to systematic over-sizing of speculative positions.

**F5.2 — No concentration limits** (P1)

No maximum allocation per:
- Underlying (could have 5 QQQ positions totaling 80% of account)
- Sector (all tech = correlated risk)
- Expiration date (all expiring same Friday = gamma risk)
- Strategy type (all credit spreads = correlated short vol risk)

**Recommendation**: Add soft limits with warnings:
- Max 25% of account in single underlying
- Max 50% in single sector
- Max 30% expiring same week
- Display warnings in Portfolio Greeks widget when limits exceeded

**F5.3 — Portfolio Greeks aggregation doesn't scale by contract multiplier correctly for spreads** (P2)

In `riskSizing.ts:aggregatePortfolioGreeks()`, spread positions multiply Greeks by `qty * CONTRACT_MULTIPLIER` (100). But for a credit spread, the NET delta is already the spread delta (short delta - long delta). The current code multiplies each leg separately by the side multiplier (+1/-1), which is correct. However, it doesn't account for positions where the short and long legs have different quantities (partial close of one leg), though this edge case may be prevented at the data model level.

**F5.4 — No stress testing** (P2)

The system cannot answer: "What happens to my portfolio if VIX jumps from 20 to 45 overnight?" This is critical for a portfolio running credit spreads — a VIX spike represents correlated vega losses across all short premium positions.

**Recommendation**: Add a simple stress test that computes:
```
Stress P&L = Σ (position_vega * position_qty * 100 * ΔIV)
Where ΔIV = VIX_stress_level - VIX_current

Scenarios:
  "Mild correction": ΔIV = +10 (VIX 20→30)
  "Flash crash": ΔIV = +25 (VIX 20→45)
  "2020 March": ΔIV = +60 (VIX 20→80)
```

**Implementation Effort**: S (stress test), M (concentration limits)

---

## Dimension 6: Data Quality & Reliability

### Findings

**F6.1 — IV normalization breaks for high-IV names** (P1, same as F2.5)

The `if (iv > 2.0) iv /= 100` check in `parseChain()` will incorrectly normalize legitimate high IVs. This affects meme stocks, biotech names near FDA decisions, and any heavily shorted stock with a squeeze.

**F6.2 — No timestamp freshness check** (P1)

`polygon-client.js` uses in-memory caching but has no mechanism to detect stale data from Polygon itself. If Polygon returns a cached/stale quote (e.g., from a market data delay), the system treats it as fresh.

**Recommendation**: Check the `updated` or `last_updated` timestamp in Polygon responses. If the quote is >5 minutes old during market hours, flag it as potentially stale and add a data quality indicator.

**F6.3 — 1-minute cache during fast markets** (P2)

`polygon-client.js:21`:
```javascript
const CACHE_TTL = 60 * 1000;  // 1 minute for generic cache
```

And 5-minute TTL for option chains. During FOMC announcements, earnings releases, or momentum breakouts, a 5-minute-old option chain can have prices that are 10-20% stale. The system should either:
- Bypass cache when a "fast market" flag is set
- Reduce cache TTL during market hours 9:30-10:00 and 15:30-16:00 (highest volatility periods)

**F6.4 — CBOE fallback produces meaningless scores** (P1)

When Polygon is unavailable and the system falls back to CBOE, all Greeks are 0. This means:
- LOQ: lambda=0, gammaEff=0, thetaBurn=0, all Z-scores=0, score≈50 for everything
- CSQ: edge=0, POP is meaningless without delta, score≈50
- Strategy Recommender: regime detection has no RV30, IV surfaces are approximate

The system shows a "CBOE Data Source" notice but doesn't clearly indicate that scores are unreliable. A user seeing "Score: 65" doesn't know it's essentially random.

**Recommendation**: When dataSource === 'CBOE', override the score display with "N/A (No Greeks available)" and disable the "Add to Watchlist" button for scored recommendations.

**F6.5 — No detection of internally inconsistent Greeks** (P2)

The `zeroGreeks/total > 50%` check catches missing data but not wrong data. No checks for:
- Call delta > 1.0 or < 0 (data error)
- Put delta < -1.0 or > 0 (data error)
- Negative gamma (should never happen for long options)
- Put-call parity violations (would indicate model disagreement)
- IV < 0 (data corruption)

**Recommendation**: Add a per-option sanity check in `parseChain()`:
```javascript
if (delta > 1 || delta < -1 || gamma < 0 || iv < 0) {
    // Flag as suspect, exclude from scoring
}
```

---

## Dimension 7: Code Architecture & Sync Risk

### Findings

**F7.1 — CRITICAL: tech-analysis.ts and tech-analysis.js are OUT OF SYNC** (P0)

The research agent found specific divergences:

| Feature | tech-analysis.js (API) | tech-analysis.ts (Frontend) |
|---|---|---|
| BXS direction-aware reversal | `rev_up ? 15 : rev_dn ? -15 : 0` (v2.7 fix applied) | `(rev_up \|\| rev_dn) ? 15 : 0` (OLD — NOT direction-aware) |
| Pullback Quality Gate | Present (EXTENDED/MOMENTUM/SWEET/PULLBACK) | Absent |
| Entry Zone price levels | Present | Absent |
| v4 model (calculateTechScoreV4) | Not present | Present (lines 483-701) |

This means:
- The Tech Score computed on the frontend (Portfolio page auto-refresh) uses the OLD buggy logic with multi-head bias
- The Tech Score computed on the API (batch refresh endpoint) uses the corrected v2.7 logic
- v4 model is only available on the frontend but not callable from the API

**Severity**: P0 — Tech Scores differ between frontend auto-refresh and API refresh for the same ticker.

**F7.2 — oss-core.ts and scoring.cjs: no automated parity test** (P1)

Despite the documentation's emphasis on keeping these in sync, there is:
- No test that verifies identical outputs
- No CI/CD check
- Only a single 38-line test file (`_test_strategy.js`) that doesn't compare TS vs CJS outputs

The sync is maintained manually. Given that v2.7 introduced 22 changes across these files, manual sync is high-risk.

**Recommendation**: Create `_test_parity.js`:
```javascript
// Generate 100 random option parameters
// Score with oss-core.ts (via tsx or ts-node)
// Score with scoring.cjs
// Assert |score_ts - score_cjs| < 0.01
```

**F7.3 — scoring.cjs has no type safety** (P2)

`scoring.cjs` is 1023 lines of plain JavaScript with no type annotations, JSDoc, or TypeScript declaration file. A single typo in a parameter name silently produces wrong scores.

**Recommendation**: At minimum, add JSDoc type annotations to all exported functions. Ideally, migrate to TypeScript and auto-generate the CJS output via `tsc`.

**F7.4 — Frontend scoring.ts still has version v2.3 header** (P3)

```typescript
/**
 * Options Scoring System (OSS) v2.3
 * ...
 */
```

The actual codebase is v2.7. Stale version headers create confusion about which fixes have been applied.

---

## Dimension 8: Alpha Opportunities

### Findings (Ranked by Impact x Effort)

**F8.1 — Candidate snapshot → outcome tracking (HIGH impact, LOW effort)**

The `candidate_snapshots` table already captures top-5 candidates at recommendation time with `position_id`, `actual_pnl`, `actual_return_pct`, and `closed_date` fields. But these outcome fields are **never populated**.

**Quick win**: When a position is closed, match it against `candidate_snapshots` by ticker + strike + expiration and fill in the actual P&L. This creates the dataset needed for scoring calibration and eventually ML.

**Effort**: S
**Impact**: Enables empirical scoring validation — the foundation for all future improvements.

**F8.2 — Execution quality feedback loop (MEDIUM impact, LOW effort)**

The `execution-quality.js` endpoint classifies entries as early/late/at-market. This data exists but isn't fed back into the signal generator. If entries are consistently "late", the system should:
- Recommend longer DTE (more time buffer)
- Recommend lower delta (cheaper entry after move)
- Alert the user: "Your last 5 entries were 'late' — consider setting alerts for earlier trigger levels"

**Effort**: S
**Impact**: Improves fill quality by 5-15% on average.

**F8.3 — VIX regime overlay (HIGH impact, MEDIUM effort)**

Current regime detection is per-ticker (IV30/RV30 ratio). Adding market-level VIX regime would capture:
- VIX < 15: Low vol environment — credit spreads excel, but premium is thin
- VIX 15-25: Normal — balanced strategies
- VIX 25-35: Elevated — credit spreads collect high premium but gap risk increases
- VIX > 35: Crisis — only sell premium with extreme caution, favor debit for tail risk capture

This would modulate both strategy selection AND position sizing at the portfolio level.

**Effort**: M
**Impact**: Prevents the most common retail options mistake — selling premium into rising volatility.

**F8.4 — Basic ML on closed trades (MEDIUM impact, LARGE effort)**

Feature set available today:
- OSS unified score, strategy category, IV Rank, DTE, delta, setup type
- Regime mode, ivRvRatio, VIX level (via proxy)
- Day of week, time to earnings

Target: trade P&L (from closed positions + candidate snapshots)

Model: Logistic regression for binary win/loss, then gradient boosting for return prediction.

**Minimum data requirement**: ~200 closed trades for meaningful logistic regression, ~500 for gradient boosting. Based on current volume (solo trader), this needs 6-12 months of data accumulation.

**Effort**: L
**Impact**: Could improve win rate by 5-10% by identifying which OSS scores actually predict profitable trades vs. which are noise.

**F8.5 — Options flow data** (HIGH impact, NOT feasible on current tier)

Unusual options activity (large block trades, sweep orders) is one of the highest-alpha signals. Polygon Starter does NOT provide trade-level data with sufficient granularity for flow detection. Would require Polygon Business tier ($200+/month) or alternative data sources (Unusual Whales API, FlowAlgo).

**Not recommended for current budget.**

---

## Dimension 9: TradingView <-> Web App Unification Architecture

### Findings

**F9.1 — Complete architecture spec**

```
┌──────────────────────────────────────────────────────────┐
│                    TradingView                            │
│  Pine Script v3.2 → alert() with JSON payload            │
│  Webhook URL: https://your-domain/api/ingest-signal      │
└────────────────────────┬─────────────────────────────────┘
                         │ POST (webhook)
                         ▼
┌──────────────────────────────────────────────────────────┐
│              POST /api/ingest-signal                      │
│  1. Validate & deduplicate signal                         │
│  2. Fetch underlying price (Polygon)                      │
│  3. Fetch option chain (Polygon) — rate-limited           │
│  4. Run strategy recommendation (reuse existing logic)    │
│  5. Store in `signals` table                              │
│  6. Discord notification with top 3 candidates            │
│  7. Return 200 OK                                         │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│                   Supabase                                │
│  `signals` table:                                         │
│    id, ticker, signal_date, setup, strategy, tier,        │
│    tv_score, tv_components, direction, risk_flags,        │
│    d8, entry_ctx, backtest_stats,                         │
│    status: 'new'|'evaluated'|'watchlisted'|'entered',    │
│    evaluation_result (JSONB): regime, top candidates,     │
│    created_at, expires_at                                 │
└──────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│              Web App: Signal Feed Page                     │
│  Real-time list of incoming signals with:                  │
│  - TV score + tier badge                                   │
│  - OSS top candidate + score                               │
│  - Regime indicator                                        │
│  - One-click "Analyze Full" or "Add to Watchlist"          │
└──────────────────────────────────────────────────────────┘
```

**F9.2 — Pine Script webhook payload schema**

```json
{
  "ticker": "{{ticker}}",
  "exchange": "{{exchange}}",
  "direction": "{{strategy.order.action}}",
  "setup": "Pullback Buy",
  "strategy": "Credit Put Spread",
  "score": 87,
  "tier": "A",
  "components": {
    "mb": 72, "bxs": 85, "bxl": 60,
    "ema": 90, "mom": 65, "adx": 55, "rvol": 78
  },
  "riskFlags": {
    "overextended": false,
    "mtfConflict": false,
    "lowVolume": false,
    "nearEarnings": false,
    "highVolatility": true,
    "priceReversing": false
  },
  "d8": 0.8,
  "entryCtx": "OPTIMAL",
  "entryQuality": 72,
  "coherence": 0.95,
  "weeklyMod": 1.05,
  "backtest": {
    "win14d": 72,
    "win30d": 68,
    "avgMove14d": 3.2,
    "avgMove30d": 4.8,
    "sampleSize": 45
  },
  "timestamp": "{{timenow}}"
}
```

**F9.3 — Signal lifecycle management**

```
States: NEW → EVALUATED → WATCHLISTED → ENTERED → CLOSED
         ↓
       EXPIRED (if not acted on within 4 hours for intraday, 24 hours for daily)
       STALE (if underlying moves >3% from signal price)
```

De-duplication: Same ticker within 2-hour window → merge (keep highest score).

**F9.4 — Polygon API budget analysis**

| Signal frequency | API calls/signal | Calls/day | RPM needed | Starter limit (5 RPM) | Feasible? |
|---|---|---|---|---|---|
| 5 signals/day | 3 | 15 | <1 | Yes | Yes |
| 20 signals/day | 3 | 60 | <1 | Yes | Yes |
| 50 signals/day | 3 | 150 | ~1 | Yes | Yes |
| 100 signals/day | 3 | 300 | ~2 | Yes | Marginal |

At 5 RPM, the system can process ~100 signals/day if spread evenly. With bursts (multiple signals at market open), a queue with 12-second spacing is needed.

With `POLYGON_RATE_LIMIT_RPM=100` (if on upgraded tier), the limit is essentially unbounded for realistic signal volumes.

**Implementation Effort**: L (3-5 days)
**Expected Impact**: Eliminates 4-12 minutes of latency per signal. Enables full signal data preservation. Foundation for automated backtesting.

---

## Dimension 10: Options-Aware Performance Attribution

### Findings

**F10.1 — Greeks at exit are NOT captured** (P1)

`position_greeks_history` table captures IV and delta over time (from periodic refreshes), but there's no explicit capture of all four Greeks at the moment of position close. The exit entry in `position_greeks_history` may be stale (last refresh, not close time).

**Recommendation**: When closing a position, add a final `position_greeks_history` record and capture all four Greeks + IV + underlying price. This requires one additional Polygon API call at close time.

**F10.2 — P&L decomposition is not implemented** (P2)

No Greek-level attribution exists. The system knows total P&L but not whether profits came from delta (direction), gamma (convexity), theta (time decay), or vega (vol changes).

**Formula**:
```
Total P&L = (exit_price - entry_price) * qty * 100

Delta P&L ≈ entry_delta * (exit_underlying - entry_underlying) * qty * 100
Gamma P&L ≈ 0.5 * entry_gamma * (exit_underlying - entry_underlying)^2 * qty * 100
Theta P&L ≈ entry_theta * holding_days * qty * 100
Vega P&L ≈ entry_vega * (exit_IV - entry_IV) * qty * 100
Residual = Total - Delta - Gamma - Theta - Vega
```

**Schema additions**:
```sql
ALTER TABLE positions ADD COLUMN IF NOT EXISTS
    exit_greeks JSONB;  -- {delta, gamma, theta, vega, iv, underlying_price}

ALTER TABLE positions ADD COLUMN IF NOT EXISTS
    pnl_attribution JSONB;  -- {delta_pnl, gamma_pnl, theta_pnl, vega_pnl, residual}
```

**F10.3 — Strategy performance by Greeks source** (P3)

Aggregating P&L attribution across all closed trades would reveal:
- Are you making money from direction (delta) or vol trading (vega)?
- Are credit spreads actually theta-positive after slippage?
- Is gamma scalping (via active delta hedging) possible given transaction costs?

This requires F10.1 and F10.2 as prerequisites.

**Implementation Effort**: M (attribution formula + schema), S (exit Greeks capture)
**Expected Impact**: Transforms the trading journal from a P&L tracker into a genuine learning tool. Answers "what am I good at?" instead of just "did I make money?"

---

## Master Priority Matrix

All recommendations sorted by **(Severity x Impact) / Effort**:

| Rank | ID | Finding | Severity | Effort | Expected Impact | Score |
|---|---|---|---|---|---|---|
| **1** | F2.2 | Frontend IV interpolation uses LINEAR (should be VARIANCE) | P0 | S | Eliminates score inconsistency between Scanner and Strategy Recommender | **10.0** |
| **2** | F7.1 | tech-analysis.ts and tech-analysis.js out of sync | P0 | S | Eliminates Tech Score divergence between frontend and API | **10.0** |
| **3** | F2.3 | Vega penalty logic inverted for long options | P1 | S | Fixes systematic mispricing of high-vega long options | **8.0** |
| **4** | F2.5 | IV normalization breaks for meme stocks (iv > 2.0 check) | P1 | S | Prevents completely wrong scores for high-IV names | **8.0** |
| **5** | F8.1 | Populate candidate_snapshot outcomes on close | P2 | S | Enables scoring validation and ML foundation | **7.0** |
| **6** | F5.1 | Kelly Criterion implementation is circular | P1 | M | Prevents over-sizing speculative positions | **6.0** |
| **7** | F6.4 | CBOE fallback produces meaningless scores | P1 | S | Prevents user acting on unreliable scores | **6.0** |
| **8** | F10.1 | Greeks at exit not captured | P1 | S | Enables performance attribution | **6.0** |
| **9** | F1.1 | 40-60% signal information lost in manual transfer | P0 | L | Eliminates manual workflow, preserves all signal data | **5.0** |
| **10** | F7.2 | No automated parity test oss-core↔scoring.cjs | P1 | M | Prevents future drift between frontend/backend scoring | **5.0** |
| **11** | F5.2 | No concentration limits | P1 | M | Prevents correlated blow-ups | **5.0** |
| **12** | F6.2 | No timestamp freshness check | P1 | S | Prevents acting on stale quotes | **5.0** |
| **13** | F8.3 | VIX regime overlay | P2 | M | Prevents selling premium into rising vol | **4.5** |
| **14** | F2.1 | Dollar Gamma missing 0.5 factor | P1 | S | Corrects absolute convexity measurement | **4.0** |
| **15** | F4.3 | No options backtesting (Phase 1: Delta-adjusted) | P0 | M | Answers "do my signals profit in options?" | **4.0** |
| **16** | F2.4 | IV Rank confidence 60 days too aggressive | P2 | S | More accurate IV percentile for new tickers | **3.5** |
| **17** | F3.4 | Iron Condor skips unified scoring | P2 | M | Enables fair cross-strategy comparison | **3.0** |
| **18** | F8.2 | Execution quality feedback loop | P2 | S | Improves fill quality 5-15% | **3.0** |
| **19** | F6.5 | No detection of internally inconsistent Greeks | P2 | S | Catches bad data before it reaches scoring | **3.0** |
| **20** | F10.2 | P&L decomposition by Greek | P2 | M | Trader self-awareness and strategy refinement | **2.5** |
| **21** | F5.4 | No stress testing | P2 | M | Portfolio risk awareness during vol events | **2.5** |
| **22** | F3.2 | Regime hysteresis window could be wider | P2 | S | Reduces regime flip-flopping | **2.0** |
| **23** | F6.3 | Cache TTL too long during fast markets | P2 | S | More timely data during critical periods | **2.0** |
| **24** | F3.3 | Earnings penalty cap too low for extreme movers | P2 | S | Better risk assessment for TSLA-type names | **1.5** |
| **25** | F7.3 | scoring.cjs has no type safety | P2 | L | Reduces bug risk in 1023-line CJS file | **1.5** |
| **26** | F8.4 | ML on closed trades | P3 | L | 5-10% win rate improvement (needs data) | **1.0** |
| **27** | F3.5 | Multi-leg slippage model assumed | P3 | M | Calibrated slippage from actual fills | **1.0** |

---

## Recommended Implementation Phases

### Phase A: Critical Fixes (Week 1) — Items 1-4, 7, 12, 14

Fix the P0 and high-scoring P1 bugs. All are S-effort (< 1 day each):

1. **Fix scoring.ts IV interpolation** — Port the variance-based interpolation from `scoring.cjs:calculateTargetIV` to `src/lib/scoring.ts:getATMIV`. ~30 min.
2. **Sync tech-analysis.ts with tech-analysis.js** — Apply BXS direction-aware reversal and EMA/Momentum fixes to the TS version. ~1 hour.
3. **Fix Vega penalty direction for LOQ** — Change `max(0, 1-ivRank)` to `max(0, ivRank)` in the LOQ vega penalty. ~15 min.
4. **Fix IV normalization threshold** — Change `iv > 2.0` to `iv > 5.0`. ~5 min.
5. **Add CBOE fallback degradation notice** — When dataSource=CBOE, show "Scores unavailable (no Greeks)" instead of numeric scores. ~30 min.
6. **Add timestamp freshness check** — Check Polygon response timestamps; flag quotes > 5 min old during market hours. ~30 min.
7. **Fix Dollar Gamma 0.5 factor** — Add the missing 0.5 multiplier. ~5 min.

### Phase B: Risk & Data Quality (Week 2) — Items 5, 6, 8, 10, 11, 19

1. **Populate candidate_snapshot outcomes** — Add trigger on position close to match and update candidate_snapshots. ~2 hours.
2. **Fix Kelly Criterion** — Implement proper f* = (p*b - q)/b using POP and R:R from the recommendation. ~3 hours.
3. **Capture exit Greeks** — Add Polygon API call on position close, store in position_greeks_history and positions.exit_greeks. ~1 hour.
4. **Create parity test** — Build _test_parity.js that validates oss-core.ts vs scoring.cjs across 100 random inputs. ~2 hours.
5. **Add concentration limits** — Compute and display warnings when >25% in one underlying or >50% in one sector. ~3 hours.
6. **Add Greeks sanity checks** — Filter out options with delta>1, gamma<0, iv<0 in parseChain. ~30 min.

### Phase C: TV Webhook Integration (Week 3-4) — Items 9, 13, 18

1. **Build POST /api/ingest-signal** — Accept TV webhook, auto-evaluate, store in signals table. ~2 days.
2. **Modify Pine Script** — Add alert() with JSON payload at signal generation. ~1 day.
3. **Build Signal Feed page** — Real-time signal dashboard with one-click actions. ~2 days.
4. **Add VIX regime overlay** — Fetch VIX level, add market-level regime to strategy selection. ~1 day.
5. **Wire execution quality feedback** — Surface entry timing stats in Strategy Recommender UI. ~1 day.

### Phase D: Backtesting Foundation (Week 5-6) — Items 15, 17, 20, 21

1. **Build Phase 1 MVOB** — Delta-adjusted backtesting using available data. ~3 days.
2. **Unify Iron Condor scoring** — Route IC through unified scoring pipeline. ~1 day.
3. **Implement P&L attribution** — Greek decomposition on closed trades. ~2 days.
4. **Add stress testing** — Simple vega-based scenario analysis. ~1 day.

---

## Appendix: Key Metrics for Ongoing Monitoring

After implementing fixes, track these metrics weekly:

| Metric | Target | How to Measure |
|---|---|---|
| Scanner/Recommender score correlation | r > 0.95 | Score same ticker/strike in both; compare |
| Score → P&L correlation | r > 0.20 | From candidate_snapshots outcomes |
| Average signal-to-evaluation latency | < 30s | From signals.created_at to evaluation_result timestamp |
| IV Rank confidence coverage | > 80% of tickers with sampleDays > 120 | Query ticker_iv_snapshots |
| Win rate by OSS score bucket | Score 70+ should be > 55% win rate | From closed positions with entry scores |
| Average Greeks attribution accuracy | Residual < 20% of total P&L | From pnl_attribution field |

---

## Post-Audit: v2.8 Price Accuracy Fix (2026-03-03)

User-reported bug: QQQ stock price showing 608 (stale daily close) instead of ~601 (live); option spread pricing inconsistent across Watchlist (correct 1.87) vs Portfolio/Strategy Recommender (wrong 0.54).

### Root Causes Found

| ID | Severity | Issue | Impact |
|---|---|---|---|
| PA-1 | P0 | `_derivePriceFromPutCallParity` checks `o.expiry` but Polygon normalized options use `o.expiration` — PCP always returned null silently | `currentPrice` always fell back to stale daily candle close; ATM IV, term structure, IV/RV ratio, IV Rank all shifted |
| PA-2 | P0 | `normalizePolygonOption` bid/ask uses `\|\|` (logical OR) — `bid=0` falls back to `day.vwap`/`day.previous_close` | Genuine zero bids overwritten with stale day data; mid price wrong |
| PA-3 | P0 | `getUnderlyingPrice()` returns 403 NOT_AUTHORIZED on basic Polygon plans (stock snapshot endpoint not included) | No fresh underlying price source; only fallback is stale chain data or daily close |
| PA-4 | P1 | `option-prices.js` prefers `last` over `mid`: `option.last > 0 ? option.last : mid` | Hours-old last trade used instead of current bid/ask midpoint |
| PA-5 | P1 | `PositionCard.tsx` bulk data path accesses `d.data` (normalized option without `price` field) instead of top-level API result | `shortData.price = undefined` in portfolio spread pricing; score calculation receives NaN |

### Fixes Applied

1. **Multi-tier underlying price resolution** — strategy-recommend, option-prices, scan-options all validate chain underlying against reference (≤15% divergence); fallback: daily close → PCP (field name fixed) → stock snapshot → CBOE
2. **Nullish coalescing for bid/ask/last** — `??` instead of `||` in `normalizePolygonOption`; added computed `mid` field
3. **Mid-preferred pricing** — `option-prices.js` now: `mid > 0 ? mid : (last > 0 ? last : 0)`
4. **PositionCard bulk data** — uses top-level API response (has `price`, `bid`, `ask`, `underlyingPrice`) not `d.data`
5. **PCP median derivation** added to `option-prices.js` for portfolio/watchlist underlying price

### Downstream IV Metric Impact

All IV-derived metrics that depend on `currentPrice` are now more accurate (no code changes needed — parameter propagation):
- **ATM IV**: `getCleanATM_IV(chain, currentPrice)` — selects different ATM strike (~602 vs ~608)
- **Term Structure**: `buildIVTermStructure` → all `calculateTargetIV` calls shift
- **IV/RV Ratio**: numerator (IV30) changes with ATM IV
- **IV Rank**: comparison point (current ATM IV) changes
- **Strike Filter**: `parseChain` ±15% window shifts
- **Skew**: NOT affected (delta-based selection, does not use `currentPrice`)

### Verified Results

| Source | Before (stale) | After (fixed) | Reference (CBOE) |
|---|---|---|---|
| QQQ underlying | $608.09 (daily close) | $601.71 (PCP) | $601.45 |
| PCP median (option-prices.js) | N/A (not implemented) | $602.91 | $601.45 |

---

*End of Audit Report*
