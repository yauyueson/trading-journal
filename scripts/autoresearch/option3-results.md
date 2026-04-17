# Option 3 — Autoresearch Leaderboard Summary

**Generated:** 2026-04-17T03:09:59.364Z
**Mission:** [program-option3.md](program-option3.md)
**Total attempts:** 124  |  **Valid:** 0

## No valid strategy yet.

All 124 attempts failed at least one validity gate.

## Top 10 by combined Sharpe

| Strategy                                 | Combd  | Corr   | StandS | MaxDD | Trades | SPY IR | Hold | Valid |
|------------------------------------------|--------|--------|--------|-------|--------|--------|------|-------|
| option3-bear-call-gld-v2                 |  0.524 | -0.050 |  0.044 |   6.7% |     59 | -0.592 | FAIL |   no  |
| option3-bear-call-gld-d25-30dte          |  0.524 | -0.050 |  0.044 |   6.7% |     59 | -0.592 | FAIL |   no  |
| option3-bear-call-gld-d20-30dte          |  0.515 | -0.039 | -0.016 |   6.1% |     67 | -0.617 | FAIL |   no  |
| option3-multi-bput-45dte-d25             |  0.515 |  0.273 |  0.224 |  12.7% |    248 | -0.647 | PASS |   no  |
| option3-vrp-longput-v2-otm               |  0.512 | -0.052 |  0.363 |  55.1% |    131 | -0.029 | FAIL |   no  |
| option3-bput-macro-d20-nosl              |  0.512 |  0.320 |  0.304 |  20.3% |    615 | -0.621 | PASS |   no  |
| option3-bear-call-gld-d25-tp40           |  0.502 | -0.052 | -0.049 |   8.4% |     71 | -0.610 | FAIL |   no  |
| option3-bear-call-gld-d30-30dte          |  0.502 | -0.052 | -0.025 |   9.2% |     52 | -0.594 | FAIL |   no  |
| option3-spygate-sl80-d60                 |  0.499 | -0.203 |  0.270 |  50.0% |     96 | -0.200 | FAIL |   no  |
| option3-bear-call-gld-d25-45dte          |  0.496 | -0.033 | -0.068 |   7.0% |     52 | -0.615 | FAIL |   no  |

## Top 10 by LOW correlation with DTE5 (≥30 trades)

Useful even if standalone Sharpe is low — low correlation is the primary value driver for a complement.

| Strategy                                 | Combd  | Corr   | StandS | MaxDD | Trades | SPY IR | Hold | Valid |
|------------------------------------------|--------|--------|--------|-------|--------|--------|------|-------|
| option3-longput-ema55-d40                |  0.397 | -0.001 |  0.413 | 139.9% |    876 |  0.412 | FAIL |   no  |
| option3-longput-ema55-d40                |  0.397 | -0.001 |  0.413 | 139.9% |    876 |  0.412 | FAIL |   no  |
| option3-longput-ema55-d40-tightsl        |  0.397 | -0.001 |  0.413 | 139.9% |    876 |  0.412 | FAIL |   no  |
| option3-gld-stress-d40-20dte             |  0.351 | -0.001 | -0.783 |  18.4% |     78 | -1.075 | FAIL |   no  |
| option3-vrp-hybrid-v1-longdte            | -0.386 | -0.002 | -0.406 | 303.2% |    656 | -0.413 | FAIL |   no  |
| option3-gld-stress-d40-30dte             |  0.302 |  0.006 | -0.916 |  22.2% |     83 | -1.113 | FAIL |   no  |
| option3-gld-stress-d40-30dte             |  0.302 |  0.006 | -0.916 |  22.2% |     83 | -1.113 | FAIL |   no  |
| option3-gld-stress-tight-tp              |  0.302 |  0.006 | -0.916 |  22.2% |     83 | -1.113 | FAIL |   no  |
| option3-gld-stress-d50-30dte             |  0.223 |  0.006 | -0.973 |  28.1% |     83 | -1.168 | FAIL |   no  |
| option3-debit-spread-v1                  | -0.596 | -0.012 | -0.634 | 210.5% |    167 | -0.661 | PASS |   no  |

## Invalidity reason breakdown

124 of 124 attempts failed. Common reasons:

| Failure reason | Count |
|---|---|
| delta-gate | 97 |
| wfa-sharpe | 78 |
| max-dd | 76 |
| holdout-gate | 65 |
| min-trades | 25 |

## Raw top-10 JSON

```json
[
  {
    "name": "option3-bear-call-gld-v2",
    "combined": 0.5244576643234891,
    "corr": -0.050088773928564354,
    "oosSharpe": 0.044288486182904784,
    "oosMaxDD": 6.668983387621595,
    "trades": 59,
    "oosSpyIR": -0.5919511400792297,
    "holdoutSharpe": -1.1493616736434316,
    "holdoutSpyIR": -2.5923262974740853,
    "deflatedSharpe": -0.18167465471267738,
    "bootstrapCI": [
      -0.5887647285393917,
      0.5947068647392566
    ],
    "passesHoldoutOrIR": false,
    "passesDeltaGates": true,
    "isValid": false,
    "exitTypeBreakdown": {
      "STOP_LOSS": 12,
      "PROFIT_TARGET": 39,
      "TIME_STOP": 5,
      "EXPIRATION": 2,
      "FORCE_CLOSE": 1
    }
  },
  {
    "name": "option3-bear-call-gld-d25-30dte",
    "combined": 0.5244576643234891,
    "corr": -0.050088773928564354,
    "oosSharpe": 0.044288486182904784,
    "oosMaxDD": 6.668983387621595,
    "trades": 59,
    "oosSpyIR": -0.5919511400792297,
    "holdoutSharpe": -1.1493616736434316,
    "holdoutSpyIR": -2.5923262974740853,
    "deflatedSharpe": -0.24994547303594275,
    "bootstrapCI": [
      -0.5803863049220328,
      0.589118001156291
    ],
    "passesHoldoutOrIR": false,
    "passesDeltaGates": true,
    "isValid": false,
    "exitTypeBreakdown": {
      "STOP_LOSS": 12,
      "PROFIT_TARGET": 39,
      "TIME_STOP": 5,
      "EXPIRATION": 2,
      "FORCE_CLOSE": 1
    }
  },
  {
    "name": "option3-bear-call-gld-d20-30dte",
    "combined": 0.5151038564581577,
    "corr": -0.03919563389826446,
    "oosSharpe": -0.015598076656485875,
    "oosMaxDD": 6.12045490165163,
    "trades": 67,
    "oosSpyIR": -0.6167117857635651,
    "holdoutSharpe": -1.3611095545171592,
    "holdoutSpyIR": -2.581680189300224,
    "deflatedSharpe": -0.39136242241935015,
    "bootstrapCI": [
      -0.6938757159229068,
      0.5829339491764044
    ],
    "passesHoldoutOrIR": false,
    "passesDeltaGates": true,
    "isValid": false,
    "exitTypeBreakdown": {
      "STOP_LOSS": 15,
      "PROFIT_TARGET": 47,
      "TIME_STOP": 1,
      "EXPIRATION": 3,
      "FORCE_CLOSE": 1
    }
  },
  {
    "name": "option3-multi-bput-45dte-d25",
    "combined": 0.5146635676418614,
    "corr": 0.27260737687858644,
    "oosSharpe": 0.22443205203651626,
    "oosMaxDD": 12.74513416357295,
    "trades": 248,
    "oosSpyIR": -0.6470735333495317,
    "holdoutSharpe": 1.620619791760267,
    "holdoutSpyIR": -2.4006675731328277,
    "deflatedSharpe": -0.49076266116335343,
    "bootstrapCI": [
      -0.49393299101687327,
      1.1394645206093923
    ],
    "passesHoldoutOrIR": true,
    "passesDeltaGates": false,
    "isValid": false,
    "exitTypeBreakdown": {
      "PROFIT_TARGET": 181,
      "STOP_LOSS": 50,
      "EXPIRATION": 10,
      "TIME_STOP": 6,
      "FORCE_CLOSE": 1
    }
  },
  {
    "name": "option3-vrp-longput-v2-otm",
    "combined": 0.5123631383538608,
    "corr": -0.051661518073813105,
    "oosSharpe": 0.3630934057650417,
    "oosMaxDD": 55.07255027026247,
    "trades": 131,
    "oosSpyIR": -0.029333393119096572,
    "holdoutSharpe": 0,
    "holdoutSpyIR": -2.182182835487938,
    "deflatedSharpe": -0.6365472436756489,
    "bootstrapCI": [
      -0.5277354840078325,
      1.0777069729240005
    ],
    "passesHoldoutOrIR": false,
    "passesDeltaGates": false,
    "isValid": false,
    "exitTypeBreakdown": {
      "PROFIT_TARGET": 43,
      "STOP_LOSS": 87,
      "FORCE_CLOSE": 1
    }
  },
  {
    "name": "option3-bput-macro-d20-nosl",
    "combined": 0.5119484824575524,
    "corr": 0.3196425023336113,
    "oosSharpe": 0.30374206195829573,
    "oosMaxDD": 20.333376238046394,
    "trades": 615,
    "oosSpyIR": -0.6209203322694397,
    "holdoutSharpe": 1.1850380447308617,
    "holdoutSpyIR": -2.0801719741661615,
    "deflatedSharpe": -0.5206065749913045,
    "bootstrapCI": [
      -0.42687359749331305,
      1.1253616318531645
    ],
    "passesHoldoutOrIR": true,
    "passesDeltaGates": false,
    "isValid": false,
    "exitTypeBreakdown": {
      "PROFIT_TARGET": 541,
      "TIME_STOP": 58,
      "EXPIRATION": 12,
      "STOP_LOSS": 3,
      "FORCE_CLOSE": 1
    }
  },
  {
    "name": "option3-bear-call-gld-d25-tp40",
    "combined": 0.5017068367382851,
    "corr": -0.05180264059413432,
    "oosSharpe": -0.048705644182802176,
    "oosMaxDD": 8.44095942832013,
    "trades": 71,
    "oosSpyIR": -0.6103016769066926,
    "holdoutSharpe": -1.540463329246818,
    "holdoutSpyIR": -2.6061598826435777,
    "deflatedSharpe": -0.5309248160575001,
    "bootstrapCI": [
      -0.7857629225815876,
      0.5132925673621682
    ],
    "passesHoldoutOrIR": false,
    "passesDeltaGates": true,
    "isValid": false,
    "exitTypeBreakdown": {
      "STOP_LOSS": 14,
      "PROFIT_TARGET": 51,
      "EXPIRATION": 2,
      "TIME_STOP": 3,
      "FORCE_CLOSE": 1
    }
  },
  {
    "name": "option3-bear-call-gld-d30-30dte",
    "combined": 0.5015109269559055,
    "corr": -0.052143613869945,
    "oosSharpe": -0.025203682354476776,
    "oosMaxDD": 9.159001287732272,
    "trades": 52,
    "oosSpyIR": -0.5941545106507458,
    "holdoutSharpe": -1.5047595520057422,
    "holdoutSpyIR": -2.6051247854084685,
    "deflatedSharpe": -0.42518967627993715,
    "bootstrapCI": [
      -0.691713349580833,
      0.5353038713892817
    ],
    "passesHoldoutOrIR": false,
    "passesDeltaGates": true,
    "isValid": false,
    "exitTypeBreakdown": {
      "STOP_LOSS": 11,
      "PROFIT_TARGET": 33,
      "TIME_STOP": 4,
      "EXPIRATION": 3,
      "FORCE_CLOSE": 1
    }
  },
  {
    "name": "option3-spygate-sl80-d60",
    "combined": 0.4994179596051107,
    "corr": -0.2025829649457463,
    "oosSharpe": 0.27045788280155786,
    "oosMaxDD": 50.02269539275941,
    "trades": 96,
    "oosSpyIR": -0.20023593853589136,
    "holdoutSharpe": 0.24533329601233936,
    "holdoutSpyIR": -0.1702018819880784,
    "deflatedSharpe": -0.8745773783428696,
    "bootstrapCI": [
      -0.6357593285867879,
      1.0838118278686848
    ],
    "passesHoldoutOrIR": false,
    "passesDeltaGates": false,
    "isValid": false,
    "exitTypeBreakdown": {
      "STOP_LOSS": 51,
      "PROFIT_TARGET": 42,
      "EXPIRATION": 1,
      "FORCE_CLOSE": 2
    }
  },
  {
    "name": "option3-bear-call-gld-d25-45dte",
    "combined": 0.49628121779776035,
    "corr": -0.032841512241735496,
    "oosSharpe": -0.06799914507841871,
    "oosMaxDD": 7.0125820516467945,
    "trades": 52,
    "oosSpyIR": -0.6150641924665754,
    "holdoutSharpe": -0.62483923678497,
    "holdoutSpyIR": -2.521582152682706,
    "deflatedSharpe": -0.5251670422261163,
    "bootstrapCI": [
      -0.705851361974217,
      0.5971386463886038
    ],
    "passesHoldoutOrIR": false,
    "passesDeltaGates": false,
    "isValid": false,
    "exitTypeBreakdown": {
      "STOP_LOSS": 11,
      "PROFIT_TARGET": 35,
      "TIME_STOP": 3,
      "EXPIRATION": 2,
      "FORCE_CLOSE": 1
    }
  }
]
```
