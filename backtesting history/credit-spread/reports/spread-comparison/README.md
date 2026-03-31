# Spread Configuration Comparison — True Portfolio Growth Simulation

**Date:** 2026-03-30
**Engine:** Post-audit (worst-side fills, honest pricing, same-expiry legs, market close for non-expired)
**Commission:** $0 (Robinhood)
**Methodology:** Walk-Forward Analysis (252d train / 126d test, 10 windows) with TRUE portfolio growth — equity carries forward across windows, each window sizes from actual portfolio equity.

## Study Design

**Prior issue:** All previous WFA results used "aggregation" — each window ran with the same fixed `startingCapital`, so a portfolio that grew from $10K to $20K in W1 still sized W2 from $10K. This understated returns for winning configs and overstated returns for losing configs.

**This study fixes that.** Each WFA test window receives the actual running equity as `startingCapital`, so position sizing reflects real portfolio growth. This is how you'd actually trade it.

**Parameters:**
- Ticker: QQQ only
- Direction: Bull only
- EMA gate: EMA34 (close > EMA34 to enter)
- DTE: 2-7 (target 5)
- Hold-to-expiry (no TP/SL)
- Max concurrent positions: 1
- Starting capital: $10,000
- Risk sizing: % of current equity per trade (varies by tier)
- Contract cap: 50 (hardcoded in engine)

---

## Results by Risk Tier

### 5% Risk — Conservative

| Spread | Final$ | CAGR | Sharpe | MaxDD | MinEq | WR% | Trades | +Win |
|--------|--------|------|--------|-------|-------|-----|--------|------|
| sp30/20 | $23,896 | 19.0% | **1.186** | **12.1%** | $10,000 | 80% | 418 | 8/10 |
| sp25/10 | $18,336 | 12.8% | 1.175 | 13.7% | $9,977 | 85% | 435 | 7/10 |
| sp25/20 | $20,561 | 15.4% | 1.127 | 16.5% | $10,000 | 83% | 417 | 8/10 |
| sp25/15 | $18,845 | 13.5% | 1.077 | 17.4% | $10,000 | 84% | 435 | 7/10 |
| sp30/25 | $18,058 | 12.5% | 0.822 | 18.5% | $9,346 | 79% | 391 | 8/10 |
| sp30/15 | $14,772 | 8.1% | 0.601 | 22.8% | $8,929 | 81% | 419 | 7/10 |
| sp35/25 | $19,632 | 14.4% | 0.807 | 33.2% | $8,951 | 75% | 433 | 7/10 |
| sp15/05 | $11,074 | 2.1% | 0.231 | 25.2% | $8,356 | 90% | 432 | 7/10 |
| sp40/30 | $10,963 | 1.8% | 0.195 | 39.4% | $7,559 | 68% | 440 | 5/10 |
| sp40/35 | $10,353 | 0.7% | 0.130 | 37.8% | $7,409 | 67% | 400 | 6/10 |
| sp20/10 | $10,302 | 0.6% | 0.113 | 20.4% | $8,335 | 86% | 434 | 3/10 |

**Winner: sp30/20** — highest Sharpe (1.19), lowest MaxDD (12.1%), equity never dipped below start.

### 10% Risk — Moderate

| Spread | Final$ | CAGR | Sharpe | MaxDD | MinEq | WR% | Trades | +Win |
|--------|--------|------|--------|-------|-------|-----|--------|------|
| sp25/15 | $40,824 | 32.4% | **1.199** | 31.5% | $10,000 | 84% | 435 | 8/10 |
| sp30/20 | $51,881 | 38.8% | 1.179 | **25.6%** | $10,000 | 80% | 418 | 8/10 |
| sp25/20 | $37,769 | 30.3% | 1.134 | 30.1% | $9,849 | 83% | 417 | 8/10 |
| sp25/10 | $27,342 | 22.2% | 1.067 | 25.3% | $10,000 | 85% | 435 | 7/10 |
| sp30/15 | $32,978 | 26.8% | 0.953 | 30.0% | $10,000 | 81% | 419 | 8/10 |
| sp30/25 | $29,851 | 24.3% | 0.850 | 35.5% | $8,514 | 79% | 391 | 8/10 |
| sp35/25 | $28,507 | 23.2% | 0.734 | 62.8% | $6,585 | 75% | 433 | 7/10 |
| sp40/30 | $11,102 | 2.1% | 0.287 | 73.7% | $4,864 | 68% | 440 | 5/10 |
| sp20/10 | $11,941 | 3.6% | 0.274 | 31.0% | $8,481 | 86% | 434 | 4/10 |
| sp40/35 | $10,224 | 0.4% | 0.208 | 67.5% | $5,000 | 67% | 400 | 6/10 |
| sp15/05 | $10,417 | 0.8% | 0.136 | 30.8% | $8,295 | 90% | 432 | 6/10 |

**Winner: sp25/15 by Sharpe (1.20), sp30/20 by return ($52K) and drawdown (25.6%).** Both never dipped below starting capital.

### 20% Risk — Aggressive

| Spread | Final$ | CAGR | Sharpe | MaxDD | MinEq | WR% | Trades | +Win |
|--------|--------|------|--------|-------|-------|-----|--------|------|
| sp30/20 | $150,743 | 71.7% | **1.228** | 46.8% | $10,000 | 80% | 418 | 8/10 |
| sp25/15 | $105,310 | 59.9% | 1.218 | 58.1% | $9,369 | 84% | 435 | 8/10 |
| sp25/10 | $77,145 | 50.2% | 1.187 | 45.6% | $10,000 | 85% | 435 | 7/10 |
| sp25/20 | $87,228 | 54.0% | 1.180 | 56.1% | $8,728 | 83% | 417 | 7/10 |
| sp30/15 | $73,593 | 48.8% | 0.995 | 58.5% | $8,096 | 81% | 419 | 8/10 |
| sp30/25 | $51,502 | 38.6% | 0.869 | 61.8% | $6,554 | 79% | 391 | 8/10 |
| sp35/25 | $29,962 | 24.4% | 0.734 | 92.8% | $2,436 | 75% | 433 | 7/10 |
| sp40/30 | $2,664 | -23.2% | 0.513 | 99.3% | $545 | 68% | 440 | 5/10 |
| sp15/05 | $12,496 | 4.5% | 0.326 | 54.8% | $7,541 | 90% | 432 | 7/10 |
| sp20/10 | $8,055 | -4.2% | 0.209 | 58.0% | $4,778 | 86% | 434 | 4/10 |
| sp40/35 | $3,709 | -17.9% | 0.202 | 95.1% | $1,199 | 67% | 400 | 6/10 |

**Caution: 20% risk numbers are inflated by compounding in a favorable period. See Audit section below.**

---

## Best Config Per Risk Tier (MinEq >= $7K safety filter)

| Tier | #1 | #2 | #3 |
|------|-----|-----|-----|
| **5%** | sp30/20 (Sh 1.19, CAGR 19%) | sp25/10 (Sh 1.18, CAGR 13%) | sp25/20 (Sh 1.13, CAGR 15%) |
| **10%** | sp25/15 (Sh 1.20, CAGR 32%) | sp30/20 (Sh 1.18, CAGR 39%) | sp25/20 (Sh 1.13, CAGR 30%) |
| **20%** | sp30/20 (Sh 1.23, CAGR 72%) | sp25/15 (Sh 1.22, CAGR 60%) | sp25/10 (Sh 1.19, CAGR 50%) |

---

## Equity Curves — Top Configs at 10% Risk

### sp25/15 10% (CURRENT production config)

| Win | Period | StartEq | PnL | EndEq | Return | Trades | WR |
|-----|--------|---------|-----|-------|--------|--------|----|
| W1 | 2020-12-31 → 2021-07-01 | $10,000 | $1,271 | $11,271 | 12.7% | 32 | 88% |
| W2 | 2021-07-02 → 2021-12-30 | $11,271 | $1,443 | $12,714 | 12.8% | 53 | 85% |
| W3 | 2021-12-31 → 2022-07-01 | $12,714 | $-631 | $12,083 | -5.0% | 10 | 70% |
| W4 | 2022-07-05 → 2022-12-30 | $12,083 | $-1,825 | $10,258 | -15.1% | 30 | 73% |
| W5 | 2023-01-03 → 2023-07-05 | $10,258 | $5,548 | $15,806 | 54.1% | 54 | 89% |
| W6 | 2023-07-06 → 2024-01-03 | $15,806 | $894 | $16,700 | 5.7% | 43 | 81% |
| W7 | 2024-01-04 → 2024-07-05 | $16,700 | $9,864 | $26,564 | 59.1% | 57 | 91% |
| W8 | 2024-07-08 → 2025-01-03 | $26,564 | $20 | $26,584 | 0.1% | 54 | 81% |
| W9 | 2025-01-06 → 2025-07-09 | $26,584 | $11,432 | $38,016 | 43.0% | 45 | 84% |
| W10 | 2025-07-10 → 2026-01-07 | $38,016 | $2,808 | $40,824 | 7.4% | 57 | 84% |

**Final: $40,824 (308% total) | Sharpe 1.199 | CAGR 32.4% | MaxDD 31.5% | MinEq $10,000**

### sp30/20 10%

| Win | Period | StartEq | PnL | EndEq | Return | Trades | WR |
|-----|--------|---------|-----|-------|--------|--------|----|
| W1 | 2020-12-31 → 2021-07-01 | $10,000 | $1,533 | $11,533 | 15.3% | 29 | 83% |
| W2 | 2021-07-02 → 2021-12-30 | $11,533 | $870 | $12,403 | 7.5% | 49 | 78% |
| W3 | 2021-12-31 → 2022-07-01 | $12,403 | $-1,134 | $11,269 | -9.1% | 9 | 67% |
| W4 | 2022-07-05 → 2022-12-30 | $11,269 | $-879 | $10,390 | -7.8% | 29 | 72% |
| W5 | 2023-01-03 → 2023-07-05 | $10,390 | $5,412 | $15,802 | 52.1% | 59 | 81% |
| W6 | 2023-07-06 → 2024-01-03 | $15,802 | $2,884 | $18,686 | 18.3% | 44 | 80% |
| W7 | 2024-01-04 → 2024-07-05 | $18,686 | $11,105 | $29,791 | 59.4% | 54 | 85% |
| W8 | 2024-07-08 → 2025-01-03 | $29,791 | $4,510 | $34,301 | 15.1% | 48 | 77% |
| W9 | 2025-01-06 → 2025-07-09 | $34,301 | $7,926 | $42,227 | 23.1% | 40 | 83% |
| W10 | 2025-07-10 → 2026-01-07 | $42,227 | $9,654 | $51,881 | 22.9% | 57 | 82% |

**Final: $51,881 (419% total) | Sharpe 1.179 | CAGR 38.8% | MaxDD 25.6% | MinEq $10,000**

---

## Audit: sp30/20 at 20% Risk — Dollar Trace

To verify the $150K result, we traced every dollar through each window:

| Win | StartEq | RiskBudget | Trades | WR | AvgCts | MaxCts | AvgRisk | AvgWin | AvgLoss | BigLoss | PnL | EndEq |
|-----|---------|------------|--------|----|--------|--------|---------|--------|---------|---------|-----|-------|
| W1 | $10,000 | $2,000 | 29 | 83% | 10.7 | 20 | $1,925 | $419 | $-1,455 | $-1,992 | $2,790 | $12,790 |
| W2 | $12,790 | $2,558 | 49 | 78% | 16.1 | 25 | $2,468 | $531 | $-1,647 | $-2,436 | $2,079 | $14,869 |
| W3 | $14,869 | $2,974 | 9 | 67% | 15.7 | 29 | $2,869 | $743 | $-2,481 | $-2,916 | $-2,985 | $11,884 |
| W4 | $11,884 | $2,377 | 29 | 72% | 13.3 | 23 | $2,292 | $663 | $-1,974 | $-2,340 | $-1,872 | $10,012 |
| W5 | $10,012 | $2,002 | 59 | 81% | 12.7 | 20 | $1,917 | $504 | $-1,215 | $-1,920 | $10,813 | $20,825 |
| W6 | $20,825 | $4,165 | 44 | 80% | 27.8 | 41 | $4,090 | $1,057 | $-3,211 | $-4,158 | $8,103 | $28,928 |
| W7 | $28,928 | $5,786 | 54 | 85% | 34.2 | **50** | $5,590 | $1,491 | $-4,363 | $-5,772 | $33,664 | $62,592 |
| W8 | $62,592 | $12,518 | 48 | 77% | 47.9 | **50** | $10,790 | $2,662 | $-7,640 | $-12,350 | $14,472 | $77,064 |
| W9 | $77,064 | $15,413 | 40 | 83% | 47.6 | **50** | $12,799 | $3,249 | $-10,865 | $-15,190 | $31,147 | $108,211 |
| W10 | $108,211 | $21,642 | 57 | 82% | 49.8 | **50** | $12,768 | $2,909 | $-9,420 | $-16,000 | $42,532 | $150,743 |

### Findings

1. **50-contract hard cap kicks in at W7** — from W7 onward, contracts max at 50 regardless of growing equity. The risk budget at W10 is $21.6K but actual risk deployed is only $12.8K (59%). The cap accidentally de-risks the strategy.

2. **Without the cap**, W8-W10 would trade 80-120 contracts. A single loss at 120 contracts × $200 risk = $24K, which is 31% of W8 starting equity. The results would be more volatile.

3. **BiggestLoss scales with equity** — $2K at W1, $16K at W10. A streak of 3 losses at W10 = $48K loss (44% of equity). This has not happened in the backtest but is plausible.

4. **Kelly criterion estimate**: WR=80%, avg win/loss ratio ≈ 0.28 → Kelly fraction ≈ 8.6%. At 20% risk, we're betting 2.3x Kelly. This works in bull-dominated periods but is mathematically expected to underperform Kelly over longer horizons with more drawdown regimes.

---

## Key Conclusions

### Higher delta (sp35, sp40) does NOT improve capital efficiency
- sp40/30: WR drops to 68%, MaxDD 40-99%, Sharpe 0.2-0.5 across all risk tiers
- sp35/25: WR 75%, MaxDD 33-93%, Sharpe 0.7-0.8
- The extra premium from higher delta is more than offset by dramatically worse loss rates

### sp30/20 is the strongest alternative to sp25/15
- At 5% risk: sp30/20 clearly wins (Sharpe 1.19 vs 1.08, MaxDD 12% vs 17%)
- At 10% risk: sp30/20 makes more ($52K vs $41K) with lower drawdown (25.6% vs 31.5%)
- At 20% risk: sp30/20 dominates ($151K vs $105K, Sharpe 1.23 vs 1.22)
- Tradeoff: WR drops from 84% to 80% (more frequent losses, but they're offset by larger premium)

### sp25/15 remains the safest choice
- Highest WR in the 25-delta family (84%)
- At 10% risk, best Sharpe (1.20) with clean equity curve
- Already validated through 4-stage WFA + holdout + adversarial audit

### Practical recommendation for $10K account
- **Conservative:** sp30/20 at 5% risk → $24K in 5 years, 12% MaxDD, never dips below start
- **Moderate:** sp25/15 at 10% risk → $41K in 5 years, 31% MaxDD (current prod config at lower risk)
- **Growth:** sp30/20 at 10% risk → $52K in 5 years, 26% MaxDD
- **Avoid:** 20% risk (Kelly overshoot), sp35+/sp40+ (poor risk-adjusted returns)

---

---

## EMA Filter Comparison — With vs Without, Plus Period Sweep

EMA34 is the current production gate. This section tests: does the filter actually help, or are we just lucky with the period choice?

### sp25/15 at 10% risk

| EMA | Final$ | CAGR | Sharpe | MaxDD | MinEq | WR% | Trades | +Win |
|-----|--------|------|--------|-------|-------|-----|--------|------|
| **none** | **$15,711** | **9.4%** | **0.481** | **59.5%** | **$5,699** | 82% | 602 | 7/10 |
| EMA8 | $6,312 | -8.8% | -0.047 | 73.9% | $4,106 | 83% | 419 | 6/10 |
| EMA13 | $15,624 | 9.3% | 0.492 | 59.4% | $7,311 | 84% | 416 | 6/10 |
| EMA21 | $19,262 | 14.0% | 0.647 | 62.4% | $6,180 | 84% | 425 | 8/10 |
| **EMA34** | **$40,824** | **32.4%** | **1.199** | **31.5%** | **$10,000** | **84%** | **435** | **8/10** |
| EMA55 | $29,351 | 23.9% | 0.932 | 38.6% | $8,890 | 84% | 450 | 7/10 |
| EMA89 | $27,950 | 22.7% | 0.894 | 39.8% | $8,812 | 84% | 455 | 6/10 |

### sp30/20 at 10% risk

| EMA | Final$ | CAGR | Sharpe | MaxDD | MinEq | WR% | Trades | +Win |
|-----|--------|------|--------|-------|-------|-----|--------|------|
| **none** | **$13,954** | **6.9%** | **0.395** | **74.7%** | **$3,813** | 78% | 583 | 6/10 |
| EMA8 | $11,087 | 2.1% | 0.267 | 74.9% | $3,887 | 79% | 415 | 7/10 |
| EMA13 | $28,230 | 23.0% | 0.780 | 47.3% | $9,153 | 79% | 410 | 8/10 |
| EMA21 | $31,025 | 25.3% | 0.837 | 54.5% | $7,484 | 80% | 416 | 8/10 |
| **EMA34** | **$51,881** | **38.8%** | **1.179** | **25.6%** | **$10,000** | **80%** | **418** | **8/10** |
| EMA55 | $40,048 | 31.8% | 0.982 | 32.7% | $9,714 | 79% | 430 | 7/10 |
| EMA89 | $36,197 | 29.2% | 0.917 | 37.6% | $9,458 | 79% | 434 | 7/10 |

### Consistent across all risk tiers (5%, 10%, 20%)

| EMA | sp25/15 Sharpe (5%/10%/20%) | sp30/20 Sharpe (5%/10%/20%) |
|-----|----------------------------|-----------------------------|
| none | 0.51 / 0.48 / -0.20 | 0.60 / 0.40 / -0.51 |
| EMA8 | 0.37 / -0.05 / -1.06 | 0.54 / 0.27 / -0.49 |
| EMA13 | 0.51 / 0.49 / 0.75 | 0.82 / 0.78 / 0.78 |
| EMA21 | 0.68 / 0.65 / 0.43 | 1.00 / 0.84 / 0.84 |
| **EMA34** | **1.08 / 1.20 / 1.22** | **1.19 / 1.18 / 1.23** |
| EMA55 | 0.86 / 0.93 / 0.99 | 1.02 / 0.98 / 1.05 |
| EMA89 | 0.89 / 0.89 / 0.96 | 1.00 / 0.92 / 0.99 |

### The critical window: 2022 bear market (W3)

This is where the EMA filter earns its keep:

| Config | W3 Trades | W3 PnL | W3 Return |
|--------|-----------|--------|-----------|
| sp25/15 10% **no EMA** | 60 | **$-5,593** | **-48.7%** |
| sp25/15 10% **EMA34** | 10 | $-631 | -5.0% |

Without EMA: the strategy kept entering during the 2022 crash, producing 60 trades at 70% WR (normally 84%). The portfolio was cut in half. It never recovered enough to compound — ending at $15.7K.

With EMA34: only 10 trades in the bear window (EMA filtered out most entries). Small $631 loss. Equity stayed at $12K, positioned for the 2023 recovery that compounded to $41K.

### Key findings

1. **EMA filter is NOT optional** — without it, MaxDD doubles (60% vs 31%) and final equity is 2.6x worse ($16K vs $41K at 10% risk). At 20% risk, no-EMA goes **bankrupt** (equity goes negative: $-1,735 for sp25/15, $-4,938 for sp30/20).

2. **EMA34 is the clear optimal period** — it dominates every other EMA at every risk level for both spread configs. EMA55 and EMA89 are decent but consistently ~20-30% worse in final equity.

3. **Short EMAs (8, 13) are harmful** — EMA8 is actually worse than no filter at 10-20% risk because it whipsaws in and out, generating trades at the worst moments.

4. **The filter doesn't improve win rate** (84% with or without) — it improves **trade selection quality**. Fewer trades in bad regimes → smaller drawdowns → more capital for compounding in good regimes.

### Equity curve comparison: sp25/15 10%, NO EMA vs EMA34

**Without EMA:**
```
W1  $10K → $11.4K (+14%)    W6  $8.6K → $8.7K (+1.5%)
W2  $11.4K → $11.5K (+0.7%) W7  $8.7K → $13.0K (+49%)
W3  $11.5K → $5.9K (-49%)   W8  $13.0K → $14.3K (+10%)
W4  $5.9K → $5.7K (-3%)     W9  $14.3K → $13.2K (-7.5%)
W5  $5.7K → $8.6K (+50%)    W10 $13.2K → $15.7K (+19%)
```
Final: $15,711 (57% total) — never recovered from 2022 crash

**With EMA34:**
```
W1  $10K → $11.3K (+13%)    W6  $15.8K → $16.7K (+5.7%)
W2  $11.3K → $12.7K (+13%)  W7  $16.7K → $26.6K (+59%)
W3  $12.7K → $12.1K (-5%)   W8  $26.6K → $26.6K (+0.1%)
W4  $12.1K → $10.3K (-15%)  W9  $26.6K → $38.0K (+43%)
W5  $10.3K → $15.8K (+54%)  W10 $38.0K → $40.8K (+7.4%)
```
Final: $40,824 (308% total) — W3 loss was only -5%, preserved capital for compounding

---

## Caveats

1. **Backtest period (2020-2026) is predominantly bullish.** The only bear window (2022H1-H2) was brief. A prolonged bear or choppy market would stress these results.
2. **No liquidity modeling.** All fills assume bid/ask is achievable regardless of contract count. At 30-50 contracts, real slippage would reduce returns.
3. **50-contract engine cap** acts as accidental risk control for larger portfolios. Removing it would change results significantly at 20% risk.
4. **EMA34 gate effectiveness** is dependent on the trend structure of 2020-2026. In whipsaw markets, the gate generates frequent false entries.
5. **This is out-of-sample WFA, not live results.** Forward paper trading is the next validation step.
