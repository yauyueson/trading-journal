# Campaign C — Portfolio Response Results

**Run:** 2026-04-16T23:49:37.247Z
**Pre-registration:** [.prompts/campaign-c-portfolio-response-preregistration.md](../../.prompts/campaign-c-portfolio-response-preregistration.md)
**Method:** Post-replay approximation (does not reallocate freed slots — gate value understated)
**Base trade list:** 91 OOS + 51 holdout (baseline d65-tp40)

## Selection window (2019-01-17 → 2024-01-19)

| Variant             | Combd | StandS | MaxDD | Corr  | Kept / Skipped | SPY IR | Valid |
|---------------------|-------|--------|-------|-------|----------------|--------|-------|
| baseline            | 1.079 |  1.164 | 30.6% | 0.208 |   91 / 0       |  0.639 | YES   |
| c1-drawdown-cb      | 0.749 |  0.662 | 30.6% | 0.083 |   33 / 58      | -0.010 |  NO   |
| c2-rolling-wr       | 1.049 |  1.112 | 30.6% | 0.177 |   67 / 24      |  0.543 | YES   |
| c3-ticker-cooldown  | 1.079 |  1.164 | 30.6% | 0.208 |   91 / 0       |  0.639 | YES   |

## Holdout window (2024-01-22 → 2026-02-27, includes 45-loss streak)

| Variant             | Combd | StandS | MaxDD | Corr  | Kept / Skipped | SPY IR | Excess/yr | H-pass |
|---------------------|-------|--------|-------|-------|----------------|--------|-----------|--------|
| baseline            | 0.832 |  1.344 | 27.8% | 0.221 |   51 / 0       |  0.991 |    45.0% | PASS   |
| c1-drawdown-cb      | 0.502 |  0.000 |  0.0% | 0.000 |    0 / 51      | -1.192 |   -19.3% | FAIL   |
| c2-rolling-wr       | 0.502 |  0.000 |  0.0% | 0.000 |    0 / 51      | -1.192 |   -19.3% | FAIL   |
| c3-ticker-cooldown  | 0.813 |  1.302 | 28.7% | 0.220 |   48 / 3       |  0.947 |    42.9% | PASS   |

## Decision (per pre-registered rule)

Highest selection combinedSharpe passing validity: **baseline** (1.079)

Baseline selection combinedSharpe: **1.079**
Baseline holdout Sharpe / IR: 1.344 / 0.991

### Write-once holdout

Winner's holdout: Sharpe=1.344, IR=0.991, MaxDD=27.8%, excess return 45.05%/yr

### Verdict: No portfolio response beats baseline.

The ungated baseline wins on selection combinedSharpe. Portfolio-level responses do not add value under the post-replay approximation. Keep d65-tp40 as-is.

---

## Raw metrics

```json
[
  {
    "name": "baseline",
    "selSharpe": 1.163582705526985,
    "selCombined": 1.0791723830653992,
    "selCorr": 0.20798817937366718,
    "selMaxDD": 30.625315585478376,
    "selTradesKept": 91,
    "selTradesSkipped": 0,
    "selSpyIR": 0.6391230323173823,
    "hldSharpe": 1.3441536280450583,
    "hldCombined": 0.8316659444268703,
    "hldCorr": 0.2211741816657072,
    "hldMaxDD": 27.783855892049548,
    "hldTradesKept": 51,
    "hldTradesSkipped": 0,
    "hldSpyIR": 0.9913935725764941,
    "hldExcessRet": 0.45049546942857244,
    "passesValidity": true,
    "passesHoldout": true
  },
  {
    "name": "c1-drawdown-cb",
    "selSharpe": 0.6622938534350575,
    "selCombined": 0.7492984148467522,
    "selCorr": 0.08262893500256985,
    "selMaxDD": 30.625315585478376,
    "selTradesKept": 33,
    "selTradesSkipped": 58,
    "selSpyIR": -0.009758285488737558,
    "hldSharpe": 0,
    "hldCombined": 0.5022694857852169,
    "hldCorr": 0,
    "hldMaxDD": 0,
    "hldTradesKept": 0,
    "hldTradesSkipped": 51,
    "hldSpyIR": -1.1920050779288334,
    "hldExcessRet": -0.19268534636128565,
    "passesValidity": false,
    "passesHoldout": false
  },
  {
    "name": "c2-rolling-wr",
    "selSharpe": 1.1118871337919147,
    "selCombined": 1.0492324976241436,
    "selCorr": 0.1768427299331444,
    "selMaxDD": 30.625315585478376,
    "selTradesKept": 67,
    "selTradesSkipped": 24,
    "selSpyIR": 0.5430087588183905,
    "hldSharpe": 0,
    "hldCombined": 0.5022694857852169,
    "hldCorr": 0,
    "hldMaxDD": 0,
    "hldTradesKept": 0,
    "hldTradesSkipped": 51,
    "hldSpyIR": -1.1920050779288334,
    "hldExcessRet": -0.19268534636128565,
    "passesValidity": true,
    "passesHoldout": false
  },
  {
    "name": "c3-ticker-cooldown",
    "selSharpe": 1.163582705526985,
    "selCombined": 1.0791723830653992,
    "selCorr": 0.20798817937366718,
    "selMaxDD": 30.625315585478376,
    "selTradesKept": 91,
    "selTradesSkipped": 0,
    "selSpyIR": 0.6391230323173823,
    "hldSharpe": 1.302415230270372,
    "hldCombined": 0.8127122543061185,
    "hldCorr": 0.2196276532407437,
    "hldMaxDD": 28.656566899080254,
    "hldTradesKept": 48,
    "hldTradesSkipped": 3,
    "hldSpyIR": 0.9466685702969627,
    "hldExcessRet": 0.42948158191182406,
    "passesValidity": true,
    "passesHoldout": true
  }
]
```
