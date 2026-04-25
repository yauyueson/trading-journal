# PMCC RV-elevated gate — frozen-spec observational test

Generated: 2026-04-25T20:36:26.997Z

## Status: observational only

The selection result here is **selection-discovered** (the gate spec was identified in the sealed-anchor regime attribution's what-if-gate table on selection trades). The holdout result is **holdout-observed** — applied as a frozen entry filter, no tuning, no iteration.

No pre-reg, no dsrM cost, no sealer. If the gate degrades holdout, PMCC stays as-is. If it improves or stays flat, it's a candidate for October dsrM-refresh adoption — that decision is for the user.

## Frozen spec

- **Gate:** skip new LEAP entries when QQQ 5d realized vol / 60d realized vol ≥ 1.5
- **RV definition:** stdev of QQQ daily log returns over N trading days, annualized × √252
- **Scope:** filters new LEAP entries/reopens only. Short-call management on existing diagonals proceeds normally (the simulator handles rolls).
- **PMCC F1 config:** long δ 0.70-0.80 DTE 240-300, short δ 0.20-0.30 DTE 30-45, longPT 60%, longSL 35%, shortPT 50%, rollMoneyness 0.02. Verbatim from sealed F1 anchor.
- **Capital:** $10,000, maxPositions=1.
- **WFA:** 252/126/10 rolling, 10 selection + 5 holdout windows, holdout boundary 2024-01-22.

## Signal stream impact

Always-in signals: 2241 trading days. After RV gate: 1982. **Skipped 259 days (11.6%)** because QQQ RV5/RV60 ≥ 1.5.

(Most always-in signals never produce a trade because the portfolio constraint maxPositions=1 blocks them when a prior LEAP is still open. The gate only matters at moments where a new LEAP would otherwise enter — i.e., on or just after the prior trade's exit date.)

## Headline comparison

| Window | Strategy | Trades | Win% | Sharpe | MaxDD | PnL | Δ Sharpe | Δ MaxDD |
|--------|----------|-------:|-----:|-------:|------:|----:|---------:|--------:|
| Selection | PMCC F1 baseline | 28 | 57.1% | 1.72 | 17.5% | $34,408 | — | — |
| Selection | PMCC F1 + RV gate | 26 | 65.4% | 2.03 | 15.5% | $38,581 | 0.30 | -2.0pp |
| Holdout | PMCC F1 baseline | 11 | 54.5% | 1.63 | 12.5% | $18,669 | — | — |
| Holdout | PMCC F1 + RV gate | 9 | 55.6% | 1.16 | 9.9% | $11,228 | -0.47 | -2.7pp |

## Per-window selection Sharpe (stability check)

| Window | Baseline | RV-gated | Δ |
|------:|---------:|---------:|---:|
| sel-1 | 2.29 | 2.29 | 0.00 |
| sel-2 | 2.44 | 2.44 | 0.00 |
| sel-3 | 2.02 | 5.57 | 3.55 |
| sel-4 | 2.70 | 2.64 | -0.07 |
| sel-5 | 1.87 | 1.75 | -0.11 |
| sel-6 | 2.06 | 1.98 | -0.08 |
| sel-7 | -0.63 | -0.70 | -0.07 |
| sel-8 | -0.04 | 0.68 | 0.72 |
| sel-9 | 3.68 | 3.38 | -0.30 |
| sel-10 | 1.60 | 1.60 | 0.01 |

## Verdict

**Selection improved, holdout degraded.** Gate is overfit to the selection window and should NOT be adopted. Keep PMCC as-is.

## Caveats

- The selection what-if-gate Sharpe (in attribution) was 2.06 vs baseline 1.72. The selection result here may differ slightly because applying the gate as an actual entry filter changes which trades carry across window boundaries — different trade set than the post-hoc what-if pruning. This is intentional honesty, not a bug.
- Holdout sample is small (5 windows). A 0.10-0.20 Sharpe delta in either direction may not be statistically distinguishable from noise.
- The gate filters NEW LEAP entries only. Existing PMCC positions continue unaffected — the simulator handles short-call rolls and exits via its own logic.
- Reminder: this is observational. Do not iterate the threshold (1.5) or lookback (5d/60d) based on this result. October adoption decision uses these exact values or none.
