# Process & Strategy Review — Directional Swing Research

Audit date: 2026-03-28

Scope: Full review of the research trajectory from swing credit spreads through stock-first directional baseline through option wrappers. Covers experimental process, conclusions, strategy design, and decision quality.

---

## 1. Findings

### 1A. Are the current conclusions supported by the numbers?

**"Stock baseline is the best current strategy"** — Conditionally yes, with caveats.

The stock control baseline (Sharpe 0.70, +$33.8k, 9/12 positive, 301 trades) is the strongest result in the repo. Every option variant tested underperformed it. The credit spread path was thoroughly killed. This conclusion is directionally correct.

However, the 0.70 Sharpe is inflated by two regime clusters:
- W0 (COVID recovery): +$12,923 alone = 38% of total PnL
- W9-W11 (2024-25 bull): +$12,150 = 36% of total PnL
- Together, trending/extreme regimes contribute 74% of profit

The mid-cycle bucket (W2, W5-W8) — the regime one would experience MOST of the time — generates only +$4,440 across 124 trades with average Sharpe 0.38. This is marginal.

Remove W0 (a once-in-a-decade event) and total PnL drops to +$20,867 with an estimated Sharpe around 0.50. Still positive, but not 0.70.

**"Option wrappers dilute the edge"** — Only partially established.

The matched wrapper test (Sharpe 0.30, +$3,983, 119 trades) compared to the stock control (Sharpe 0.70, +$33,790, 301 trades) superficially supports this claim. But the comparison has structural problems:

| Issue | Impact |
| --- | --- |
| Fill rate was 15.7% — the wrapper rejected 85% of signals | The wrapper tested a different, smaller subset of the signal, not the same strategy with an option overlay |
| Shadow comparison ($5,739 stock vs $3,983 option on the SAME 119 trades) shows only -$1,756 drag | The actual option-specific friction is ~$15/trade, not catastrophic |
| Capital deployed is not equalized — stock uses $10k notional, options use premium budget | PnL magnitudes are not comparable across the two paths |

The real conclusion: **the option wrapper has a tradeability problem (most signals can't find liquid options), and on the subset it can trade, it adds moderate friction.** This is a different and less damning statement than "wrappers dilute the edge."

### 1B. Exit type analysis raises a structural question

The loss analysis reveals a striking pattern:

| Exit Type | Trades | Total PnL | Win Rate |
| --- | --- | --- | --- |
| TIME_STOP | 123 | +$90,702 | 88.6% |
| UNDERLYING_EXIT | 176 | -$58,083 | 10.8% |
| END_OF_WINDOW | 2 | +$1,171 | 100% |

The EMA-based UNDERLYING_EXIT is responsible for the majority of trades (58%) and ALL of the net losses. TIME_STOP trades are overwhelmingly profitable.

This means the strategy's profit engine is: **enter on pullback, hold for N days, collect time-based gains.** The EMA exit cuts losses but also kills many positions that would have been winners. The 10.8% win rate on UNDERLYING_EXIT trades suggests the exit fires too aggressively — it catches real trend breaks, but mostly it catches normal volatility around the EMA.

This is a genuine edge vs an artifact question: is the strategy profitable because of good entries, or because the time-stop happens to hold positions through a generally upward-drifting market?

---

## 2. Methodological Concerns

### 2A. Sequential optimization without holdout — THE critical flaw

The research path from Codex ran ~15 experiments in a single session, each decision informed by looking at the prior result's OOS metrics:

1. ETF-only pb → too low Sharpe
2. Full 14-ticker universe → better Sharpe, but positive windows 6/12
3. pb8/pb21/pb34 variants → pb8 and pb21 survive
4. Entry filters (dirConf, d8, gap) → hurt Sharpe, removed
5. Routing study (pb8 vs pb21 vs blended) → blended loses, removed
6. Regime routing (contango/VRP) → hurt Sharpe, removed
7. Control baseline frozen → Sharpe 0.70

This is textbook multiple-testing bias. The WFA rolling windows protect against within-sweep overfitting (picking the best of 16 configs per window). But the OUTER optimization loop — what presets to include, what tickers to keep, what features to sweep — was optimized by looking at the aggregate OOS results across ALL 12 windows.

After 15 rounds of look→decide→re-run on the same 2018-2026 dataset, the final "control" is not a genuine out-of-sample result. It is the configuration that survived sequential optimization. The true degrees of freedom consumed are far higher than the 16 candidates in the sweep grid.

**No holdout sample was reserved.** The entire 2018-2026 period was used for both iterative research and final validation. Without a holdout, we cannot distinguish genuine edge from fitting to the 2018-2026 sample.

### 2B. Survivorship in the research path

We see only the path that "worked." The decision to keep the full 14-ticker universe was made because it improved Sharpe from 0.24 to 0.51. The decision to separate pb8/pb21 was made because the generic pb was mediocre. Each of these decisions is a degree of freedom that is not accounted for in the final Sharpe estimate.

Estimated effective degrees of freedom consumed:
- Ticker universe: 3+ variants tested (ETF-only, full 14, pruned variants)
- Signal presets: 5 tested (pb, pb8, pb21, pb34, blended)
- Filter dimensions: 3 filter axes tested and discarded (dirConf, d8, gap)
- Routing rules: 4 routing modes tested and discarded
- Regime overlays: 4 overlay modes tested and discarded

Conservative estimate: the research consumed 10-15 effective degrees of freedom beyond the 16-candidate sweep. This is enough to materially inflate the observed Sharpe.

### 2C. pb8 vs pb21 separation is data-mined

The decision to split the generic `pb` signal into `pb8` (EMA8 touch) and `pb21` (EMA21 touch) was made AFTER seeing that generic `pb` was mediocre. The two sub-signals were then tested as separate candidates.

This is not ex-ante hypothesis testing — it is splitting a variable into buckets after seeing which bucket performs better. In any 8-year sample, there will be periods where EMA8 entries outperform EMA21 and vice versa. The 9/3 window split (pb8 wins W0-W8, pb21 wins W9-W11) is suspiciously clean and could easily reverse.

### 2D. COVID window distortion

W0 (OOS: 2020-04-07 to ~2020-10-06) encompasses one of the strongest and most unusual market recoveries in history. This single window contributes:
- $12,923 of $33,790 total PnL (38%)
- OOS Sharpe 2.72 (vs 0.70 overall)
- Only 19 trades but nearly all winners

Including this window in the aggregate Sharpe calculation inflates the perceived edge. The strategy may simply be "momentum pullback works well during V-shaped recoveries" — which is true but not particularly actionable.

### 2E. Comparisons are not fully apples-to-apples

The stock-vs-option comparison has structural asymmetries:

| Dimension | Stock Control | Option Wrapper |
| --- | --- | --- |
| Trades | 301 | 119 |
| Capital per trade | $10k notional | Premium budget (varies) |
| Signal subset | All qualifying signals | Only signals with liquid options |
| Risk per trade | Unlimited downside on $10k | Premium at risk |
| Fill model | Instant at close | Bid-ask fill with slippage |

These are fundamentally different strategies being compared by aggregate PnL, which conflates signal quality with capital efficiency.

---

## 3. Strategic Judgment

### 3A. Is the stock control economically coherent?

**Yes, but it's a simple trend-following entry.** Momentum pullback to EMA is a well-documented academic and practitioner pattern. The edge — if real — comes from buying short-term dips in established trends and riding the trend continuation.

The 43% win rate with 2:1 reward-to-risk ratio ($754 avg winner / $375 avg loser) is the classic trend-following profile: many small losses, fewer but larger wins. This is economically coherent.

However, there is no stop loss. The largest single loser was -$2,329 (AMD drift). The EMA exit is the only risk control, and it has a 10.8% win rate — meaning it cuts 89% of trades for a loss. This is either a very effective loss-limiter or an overly aggressive exit that turns winners into losers.

### 3B. Is pb8 vs pb21 routing sound or fragile?

**Fragile.** The per-window selection between pb8 and pb21 produces a clean 9/3 split that maps almost perfectly to regime boundaries:
- pb8 wins during: normal/choppy markets (W0-W8)
- pb21 wins during: 2024-25 bull (W9-W11)

This is a sample of one regime transition. We have no evidence that pb21 would win in the NEXT bull market, or that pb8 would survive the NEXT choppy market.

A more robust approach would be either:
- Use pb8 only (accept the loss from not using pb21 in W9-W11)
- Use both simultaneously (blend instead of select), accepting lower Sharpe but more stability
- Use an explicit regime detector that switches — but this was tested and didn't help

### 3C. Is the move from credit spreads justified?

**Strongly justified.** The evidence is overwhelming:
- Swing credit spreads: -$18.6k total PnL, 4/12 positive windows, 95.1% of losers breach short strike
- Multiple independent sweeps (108, 64 configs) all confirm structural unprofitability
- The loss/win ratio (~5.4x) requires 84% WR to break even — unachievable in a real bid-ask environment
- NO_CHAIN fix improved results but didn't change the conclusion

This was one of the strongest decisions in the research process.

### 3D. Was the option-wrapper exploration well-designed?

**Mixed.**

Well-designed aspects:
- Starting with deep-ITM single-leg (maximum delta, simplest option structure)
- Shadow-stock comparison isolating option-specific friction
- Stage 0 → Stage 1 progression with kill gates
- Tradeability sensitivity diagnostic

Poorly designed aspects:
- Only one option structure tested (long ITM calls/puts)
- Budget sizing (0.5-1.5% risk budget) was too restrictive for ITM options, causing 85% rejection
- No ATM options, no spreads, no delta-neutral overlays tested
- The "moderate ITM" follow-up used delta 0.55-0.75 which is still high-delta, high-premium
- No test of whether the underlying edge even NEEDS an option overlay

The core issue: the option wrapper was designed to replicate the stock position using options. But the stock position's edge comes from simplicity — $10k notional, hold for N days, EMA exit. Any option overlay adds complexity, friction, and selection bias (only liquid options). The research correctly concluded this, but the option design space was explored too narrowly to make a universal claim about "all option wrappers."

---

## 4. Next-Step Recommendations

### Keep

1. **Kill credit spreads.** This is thoroughly established.
2. **WFA methodology.** The 504d/126d/65d rolling framework is sound.
3. **Pullback signal family.** The economic logic is real.
4. **Gate system and concentration analysis.** Good discipline.

### Highest-value next steps (ranked)

**1. True holdout validation** (CRITICAL)

Reserve the last 2-3 windows (2024-2025+, roughly W9-W11) as a pure holdout. Rerun the ENTIRE research path — from signal selection through config sweep — using ONLY W0-W8 data. Then validate the frozen config against the held-out windows.

If the control baseline survives holdout validation, the edge claim strengthens materially. If it doesn't, we've identified an overfitting problem before deploying capital.

This is the single highest-leverage action available right now. Without it, the 0.70 Sharpe number carries unknown inflation from sequential optimization.

**2. Simplify to pb8-only and measure the cost**

Run the control baseline sweep with ONLY pb8 (no pb21 candidate). This eliminates the per-window selection degree of freedom and tests whether the base signal carries the edge without regime-dependent switching. Expected outcome: lower Sharpe (probably 0.50-0.60), but more robust and operationally simpler.

If pb8-only survives holdout validation, that's a much more tradeable strategy than "switch between pb8 and pb21 based on periodic WFA re-runs."

**3. Add risk control and re-measure**

The current strategy has no stop loss. The top 10 losers average -$1,326 and are mostly drift patterns. Test:
- Simple ATR-based stop (2x ATR from entry)
- Volatility-scaled notional (reduce position size in high-vol regimes)
- Tighter time stop (currently 15-20 trading days; test 10-12)

These are defensive measures that test whether the edge survives basic risk management — a prerequisite for live trading.

### Stop

1. **More option wrapper experiments** until the underlying edge passes holdout validation
2. **More filter/overlay experiments on the same 2018-2026 dataset** — the dataset is exhausted from 15+ experiments; each additional run further degrades the OOS purity
3. **Using 0.70 Sharpe as the expected forward Sharpe** — after sequential optimization without holdout, the realistic expectation is 0.30-0.50 (standard post-publication Sharpe decay is 50-60%)

---

## 5. Bottom Line

The research process was energetic, well-structured, and correctly killed several bad ideas (credit spreads, debit spreads, naive entry filters, regime routing). The stock-first directional baseline is a legitimate candidate strategy with real economic logic.

But the headline numbers are almost certainly inflated. The 0.70 Sharpe emerged from ~15 rounds of sequential optimization on the same 2018-2026 sample with no holdout. The decision to split pb into pb8/pb21 was made after seeing results. COVID window (W0) alone contributes 38% of total PnL. The mid-cycle regime — where you'd spend most of your time trading — is marginal.

The strategy is not dead, but it is not validated. The next step should be holdout validation, not more optimization. If the edge survives, it's real and worth trading. If it doesn't, we've saved capital.

Expected realistic forward Sharpe if the edge is genuine: 0.35-0.50 after accounting for sequential optimization decay, transaction costs not captured in the sim, and regime sampling bias.
