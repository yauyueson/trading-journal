# Campaign A — Regime Gate Results

**Run date:** 2026-04-16T23:30:12.406Z
**Pre-registration:** [.prompts/campaign-a-regime-gate-preregistration.md](../../.prompts/campaign-a-regime-gate-preregistration.md)
**Base strategy:** d65-tp40 (deep ITM LEAP CALL)
**Selection:** 2019-01-17 → 2024-01-19 (10 WFA windows)
**Holdout (write-once):** 2024-01-22 → 2026-02-27 (5 WFA windows, includes 45-loss streak)
**Attempts (for deflated Sharpe):** 7

## Results — selection-window metrics

Sorted by combinedSharpe. All metrics below are on the selection window only.

| Gate             | Combd | StandS | MaxDD | Corr   | Trades | SPY IR | Deflated | Boot CI 95%    | Hldt | H.Sh   | H.IR   | Valid |
|------------------|-------|--------|-------|--------|--------|--------|----------|----------------|------|--------|--------|-------|
| none             |  1.079 |  1.163 |  30.6% |  0.208 |     91 |  0.639 |   1.163 | [0.48, 1.88]   | PASS |  1.343 |  0.991 | VALID |
| trend_age        |  1.079 |  1.163 |  30.6% |  0.208 |     91 |  0.639 |   0.625 | [0.48, 1.93]   | PASS |  1.343 |  0.991 | VALID |
| spy_extension    |  0.848 |  0.850 |  40.4% |  0.202 |     82 |  0.357 |   0.362 | [0.03, 1.69]   | PASS |  0.444 |  0.012 |  NO   |
| ticker_ema200    |  0.738 |  0.741 |  58.4% |  0.211 |     80 |  0.465 |   0.437 | [0.00, 1.59]   | PASS |  1.280 |  0.924 |  NO   |
| breadth          |  0.723 |  0.704 |  47.3% |  0.202 |     76 |  0.351 |   0.291 | [-0.05, 1.59]  | PASS |  1.391 |  1.040 |  NO   |
| rv_regime        |  0.705 |  0.693 |  82.2% |  0.129 |     56 |  0.415 |   0.080 | [-0.13, 1.62]  | PASS |  0.963 |  0.504 |  NO   |
| contango_tight   |  0.673 |  0.666 |  64.1% |  0.210 |     76 |  0.408 |   0.123 | [-0.24, 1.42]  | PASS |  1.458 |  1.009 |  NO   |

## Decision (per pre-registered rule)

**Winner (highest combinedSharpe that also passes validity + deflated>0):** `d65-tp40-gate-none`

- Selection combinedSharpe: **1.079**
- Standalone OOS Sharpe: 1.163  |  MaxDD: 30.6%  |  Trades: 91
- Correlation with DTE5: 0.208
- Bootstrap 95% CI on Sharpe: [0.483, 1.880]
- Deflated Sharpe (N=1): 1.163 ✓ survives

### Write-once holdout verdict

- Holdout Sharpe: **1.343**  (trades: 51)
- Holdout SPY IR: **0.991**  (excess return vs SPY: 45.05%/yr)
- Holdout-or-IR gate (Sharpe≥0.3 OR SPY IR≥0.3): **PASS** (Sharpe ✓, IR ✓)

### Verdict: No regime gate beats the baseline.

The winner is the **ungated baseline** — no candidate gate improved selection-window combinedSharpe. More importantly, the baseline survives the 2024+ holdout with a HIGHER Sharpe than selection (1.343 vs 1.079). This means the 45-loss streak visible in the standalone diagnostic does NOT translate into portfolio-level failure under WFA + concurrent-position limits.

**Practical takeaway:** the d65-tp40 strategy is more robust than the diagnostic suggested. Portfolio constraints (maxPositions=4, maxPerTicker=1) absorb most of the trade-level damage. No gate is needed. Keep d65-tp40 as-is.

**What we CAN'T claim:** that the strategy will survive the *next* regime-change, or that adding monitoring wouldn't improve realized live performance. We only tested 6 candidate gates and they didn't help.

---

## Full raw metrics (for audit)

```json
[
  {
    "name": "d65-tp40-gate-none",
    "combinedSharpe": 1.0791723830654,
    "oosSharpe": 1.1631208747068371,
    "oosMaxDD": 30.625315585478376,
    "correlation": 0.20798817937366734,
    "oosTrades": 91,
    "oosSpyIR": 0.6391230323173805,
    "deflatedSharpe": 1.1631208747068371,
    "bootstrapCI": [
      0.4828107457238814,
      1.8802922885827085
    ],
    "holdoutSharpe": 1.3428801520338616,
    "holdoutSpyIR": 0.9913935725764919,
    "holdoutTrades": 51,
    "passesHoldoutOrIR": true,
    "isValid": true,
    "exitTypeBreakdown": {
      "PROFIT_TARGET": 50,
      "STOP_LOSS": 37,
      "TIME_STOP": 1,
      "FORCE_CLOSE": 3
    }
  },
  {
    "name": "d65-tp40-gate-trend_age",
    "combinedSharpe": 1.0791723830654,
    "oosSharpe": 1.1631208747068371,
    "oosMaxDD": 30.625315585478376,
    "correlation": 0.20798817937366734,
    "oosTrades": 91,
    "oosSpyIR": 0.6391230323173805,
    "deflatedSharpe": 0.6246186242998525,
    "bootstrapCI": [
      0.48185233540349737,
      1.932529424866115
    ],
    "holdoutSharpe": 1.3428801520338616,
    "holdoutSpyIR": 0.9913935725764919,
    "holdoutTrades": 51,
    "passesHoldoutOrIR": true,
    "isValid": true,
    "exitTypeBreakdown": {
      "PROFIT_TARGET": 50,
      "STOP_LOSS": 37,
      "TIME_STOP": 1,
      "FORCE_CLOSE": 3
    }
  },
  {
    "name": "d65-tp40-gate-spy_extension",
    "combinedSharpe": 0.8482692695044789,
    "oosSharpe": 0.8501796783288902,
    "oosMaxDD": 40.417044932308066,
    "correlation": 0.20159933925923892,
    "oosTrades": 82,
    "oosSpyIR": 0.35674338461048166,
    "deflatedSharpe": 0.3616177168746384,
    "bootstrapCI": [
      0.0322631177758968,
      1.6923477996215
    ],
    "holdoutSharpe": 0.4435935885025347,
    "holdoutSpyIR": 0.011928354877194217,
    "holdoutTrades": 48,
    "passesHoldoutOrIR": true,
    "isValid": false,
    "exitTypeBreakdown": {
      "PROFIT_TARGET": 42,
      "STOP_LOSS": 35,
      "TIME_STOP": 2,
      "FORCE_CLOSE": 3
    }
  },
  {
    "name": "d65-tp40-gate-ticker_ema200",
    "combinedSharpe": 0.7384707281693399,
    "oosSharpe": 0.7408344532540381,
    "oosMaxDD": 58.3644240084112,
    "correlation": 0.21122188534965725,
    "oosTrades": 80,
    "oosSpyIR": 0.46477457656475857,
    "deflatedSharpe": 0.4368493913777081,
    "bootstrapCI": [
      0.0015985961694057233,
      1.593706424401149
    ],
    "holdoutSharpe": 1.2801606099031173,
    "holdoutSpyIR": 0.9244722308560162,
    "holdoutTrades": 46,
    "passesHoldoutOrIR": true,
    "isValid": false,
    "exitTypeBreakdown": {
      "STOP_LOSS": 35,
      "PROFIT_TARGET": 41,
      "TIME_STOP": 1,
      "FORCE_CLOSE": 3
    }
  },
  {
    "name": "d65-tp40-gate-breadth",
    "combinedSharpe": 0.7228614106170113,
    "oosSharpe": 0.7043904785893441,
    "oosMaxDD": 47.303731947552826,
    "correlation": 0.2021405995223957,
    "oosTrades": 76,
    "oosSpyIR": 0.35109847108162384,
    "deflatedSharpe": 0.29082103730745296,
    "bootstrapCI": [
      -0.05321742708970325,
      1.590614725139298
    ],
    "holdoutSharpe": 1.3909130464902204,
    "holdoutSpyIR": 1.040036475650316,
    "holdoutTrades": 48,
    "passesHoldoutOrIR": true,
    "isValid": false,
    "exitTypeBreakdown": {
      "PROFIT_TARGET": 39,
      "STOP_LOSS": 33,
      "TIME_STOP": 1,
      "FORCE_CLOSE": 3
    }
  },
  {
    "name": "d65-tp40-gate-rv_regime",
    "combinedSharpe": 0.7045050201568789,
    "oosSharpe": 0.6932786762659805,
    "oosMaxDD": 82.15754579137443,
    "correlation": 0.1290128352798195,
    "oosTrades": 56,
    "oosSpyIR": 0.41499559725264,
    "deflatedSharpe": 0.07952632599269749,
    "bootstrapCI": [
      -0.12961489025673728,
      1.6196618743733961
    ],
    "holdoutSharpe": 0.962820301591419,
    "holdoutSpyIR": 0.5038438684773598,
    "holdoutTrades": 26,
    "passesHoldoutOrIR": true,
    "isValid": false,
    "exitTypeBreakdown": {
      "STOP_LOSS": 23,
      "PROFIT_TARGET": 30,
      "TIME_STOP": 1,
      "FORCE_CLOSE": 2
    }
  },
  {
    "name": "d65-tp40-gate-contango_tight",
    "combinedSharpe": 0.6729040528965398,
    "oosSharpe": 0.6661103082853468,
    "oosMaxDD": 64.10891863458514,
    "correlation": 0.2098835887513499,
    "oosTrades": 76,
    "oosSpyIR": 0.4076427017138618,
    "deflatedSharpe": 0.12339840974935123,
    "bootstrapCI": [
      -0.24328438303753636,
      1.4215660258324039
    ],
    "holdoutSharpe": 1.458048700484998,
    "holdoutSpyIR": 1.0085792058135508,
    "holdoutTrades": 38,
    "passesHoldoutOrIR": true,
    "isValid": false,
    "exitTypeBreakdown": {
      "PROFIT_TARGET": 39,
      "STOP_LOSS": 35,
      "TIME_STOP": 1,
      "FORCE_CLOSE": 1
    }
  }
]
```
