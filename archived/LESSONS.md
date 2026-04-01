# Archived Strategy Research — Consolidated Lessons

**Compiled:** 2026-04-01
**Scope:** 12 backtesting studies (2026-01 to 2026-03), covering credit spreads, directional swings, option overlays, and VRP harvesting across 2018-2026 data.

---

## Studies Conducted

| # | Study | Strategy | OOS Sharpe | Outcome |
|---|-------|----------|-----------|---------|
| 1 | Credit Spread Optimization | 15-ticker credit spreads, 45-65 DTE | 2.14 (inflated) | Abandoned — phantom expiration profits |
| 2 | 130M vs 4H Timeframe | Short-term spreads, timeframe comparison | 2.22 vs 1.13 | 130M superior but migration cost high |
| 3 | Swing Loss Analysis | Swing credit spreads, 45-65 DTE | Negative | Structurally unprofitable: avg winner $130 vs avg loser $841 |
| 4 | Stop-Loss Study | 4 SL mechanisms on credit spreads | 0.90 (no SL best) | All stops degrade defined-risk spreads |
| 5 | Full Config Sweep | 2,916 configs, 7-21 DTE | 0.74 (Grade D) | Zero Grade A configs, complete failure |
| 6 | Holdout Regime Analysis | Short-term holdout weakness | 0.07-0.28 holdout | Regime mismatch, not structural overfitting |
| 7 | Option-Native Swing | ITM long options wrapping swing signal | 0.07 | Cost drag -88% of edge, 23% fill rate |
| 8 | Directional Swing (Stock) | EMA pullback pb8/pb21, stock underlying | 0.70 | Best performer but 38% PnL from COVID window |
| 9 | Process & Strategy Review | Meta-audit of research trajectory | N/A | 15+ optimization rounds exhausted dataset |
| 10 | Loss Concentration Analysis | Ticker/regime breakdown of swing losses | N/A | TSLA/AMD = 40% of losses, mid-cycle regime weakest |
| 11 | Control Baseline | Canonical stock-only comparator | 0.70 | Reference benchmark for future research |
| 12 | VRP Harvester | Variance risk premium harvesting | Negative | Credit spread payoff asymmetry kills any signal |

---

## What Consistently Works

1. **Simple TPs beat complex exits** — 30% TP > phased exits, trailing locks, score-based exits
2. **EMA/momentum signals** are the only ones surviving IS-to-OOS transfer
3. **Higher IV environments** dramatically improve credit spread quality (IV >= 30%)
4. **TIME-based exits** (fixed hold + time stop) beat directional/adaptive exits
5. **Portfolio-level allocation** > single-position optimization (mpt1->mpt5 = +18% Sharpe)

## What Consistently Fails

1. **Stop losses on defined-risk spreads** — 2x credit multiple = Sharpe 0.04
2. **Swing credit spreads (45-65 DTE)** — Structural: need 84% WR, unachievable
3. **ITM options as overlay** — Cost drag -$72/trade unsustainable for modest edge
4. **Sequential optimization without holdout** — Inflates forward Sharpe by 50-60%
5. **Per-window adaptive routing** (pb8 vs pb21) — Fragile, sample-of-one

## Methodology Learnings

- **WFA rolling windows** protect within-sweep overfitting but NOT outer optimization loop
- **Grade rubric (A-F)** with 6 checks catches overfitting better than raw Sharpe
- **Walk-forward efficiency >0.7** = genuine generalization; <0.5 = red flag
- **Regime matters more than parameters** — same strategy 88.6% WR (trending) vs 10.8% WR (choppy)
- **Capital utilization** often overlooked: excellent Sharpe at 3-5% utilization is misleading

## Key Decisions & Why

| Decision | Rationale |
|----------|-----------|
| Credit spreads -> Stock underlying | 12+ studies confirm swing spreads structurally unprofitable |
| Stock -> NOT options overlay | ITM adds -$72/trade friction, 23% fill rate disqualifying |
| 4H -> 130M (adopted later for DTE5) | 130M = exact market session, 2x Sharpe edge |
| Platform reset to DTE5 only | Pricing audit: phantom expiration profits invalidated ALL prior results |

---

## Current Validated Strategy (Post-Cleanup)

**DTE5 Bull Put + Bear Call Portfolio** — QQQ bull (sp30/20, EMA34 gate) + SPY/IWM bear (sp40/30, EMA21<34<55 gate). Combined Sharpe 0.99, CAGR 40%. See `backtesting history/credit-spread/reports/`.

---

*Raw data, retired code, and experiment configs that backed these studies have been removed from the repo. Git history preserves them if needed.*
