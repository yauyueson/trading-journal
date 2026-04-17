# Campaign D — d65 Sensitivity Sweep Results (v2, strict pre-reg)

**Run:** 2026-04-16
**Revised:** 2026-04-17 after adversarial review (Codex) flagged prior recommendation as violating the pre-registered decision rule.
**Pre-registration:** [.prompts/campaign-d-d65-sensitivity-preregistration.md](../../.prompts/campaign-d-d65-sensitivity-preregistration.md)
**Method:** Single runner invocation, 26 pre-registered configVariants + baseline anchor, evaluated on the Campaign-A-consistent WFA split (selection 2019-01-17 → 2024-01-19, holdout 2024-01-22 → 2026-02-27, holdoutCount=5).

---

## 1. Consistency check — PASSED

`d65-tp40-baseline` reproduced the Campaign A metrics exactly (combined 1.079, standalone 1.163, MaxDD 30.6%, 91 trades, holdout Sharpe 1.343, IR 0.991). No code drift.

Historical leaderboard's "1.166 combined" for d65-tp40 came from `holdoutCount=4` (selection included first half of 2024). Under the cleaner pre-2024 split we standardized on, the true baseline is **1.079**.

## 2. Full sensitivity results (sorted by selection combinedSharpe)

| Rank | Variant                 | Combd | Stand  | MaxDD  | Corr   | Trades | SPY IR | Valid (search) |
|------|-------------------------|-------|--------|--------|--------|--------|--------|----------------|
| 1    | **d65-sl35-ts105**      | **1.188** | 1.341 | **25.4%** | +0.246 | 90     | +0.725 | YES            |
| 2    | d65-tp40-ts150          | 1.180 | 1.300 | 27.5%  | +0.195 | 103    | +0.721 | YES            |
| 3    | d65-tp40-ts135          | 1.125 | 1.227 | 31.4%  | +0.211 | 101    | +0.698 | YES            |
| 4    | d65-tp40-ts120          | 1.113 | 1.213 | 30.6%  | +0.218 | 94     | +0.693 | YES            |
| 5    | d70-tp45-ts150          | 1.111 | 1.225 | 31.4%  | +0.236 | 80     | +0.674 | NO (delta)     |
| 6    | d65-tp50-ts105          | 1.087 | 1.186 | 31.8%  | +0.237 | 84     | +0.667 | YES            |
| 7    | **d65-tp40-baseline**   | 1.079 | 1.163 | 30.6%  | +0.208 | 91     | +0.639 | YES            |
| 8    | d65-tp40-ts090          | 1.076 | 1.160 | 30.6%  | +0.208 | 91     | +0.637 | YES            |
| 9    | d65-tp40-ts150-sl25     | 1.023 | 1.121 | 30.7%  | +0.227 | 118    | +0.596 | NO (delta)     |
| 10   | d65-sl25-ts105          | 1.000 | 1.081 | 30.5%  | +0.245 | 109    | +0.567 | NO (delta)     |
| …    | (16 more variants below baseline, all dominated)                                                                        |

Full results in [data/leaderboard-full-campaign-d.json](../../data/leaderboard-full-campaign-d.json).

## 3. Decision per strict pre-registered rule

The pre-registration states (verbatim):
> *"Pick the variant with highest **selection-window combinedSharpe** that also passes validity + deflated>0. Adopt the winner IF AND ONLY IF it beats baseline combinedSharpe by a meaningful margin (≥ 0.05)."*
> *"Holdout metrics are observed, not used for ranking."*

Applying the rule:
- Highest selection combinedSharpe passing validity: **`d65-sl35-ts105`** at 1.188.
- Gap vs baseline: 1.188 − 1.079 = **+0.109** (clears the +0.05 adoption threshold).
- Deflated Sharpe > 0 under the 26-variant Campaign D grid.

**Adopted champion: `d65-sl35-ts105`** — loosen stop-loss from 0.30 to 0.35. Single-parameter change from baseline.

## 4. Post-hoc observations (non-binding, for documentation)

The runner-up `d65-tp40-ts150` (combined 1.180, +0.101 vs baseline) has different risk characteristics. These are reported for completeness, **not used to override the pre-reg rule**:

- `d65-sl35-ts105`: selection MaxDD 25.4% (lowest in sweep); the +0.109 combined gain pairs with a 5pp reduction in MaxDD.
- `d65-tp40-ts150`: selection MaxDD 27.5%; 14 additional TIME_STOP exits vs baseline's 1 — captures late-expiry theta.
- Holdout observations (write-once; this was the only permissible observation per the pre-reg):
  - `d65-sl35-ts105` holdout Sharpe 1.067 / IR 0.776 — PASSES holdout gate.
  - `d65-tp40-ts150` holdout Sharpe 1.278 / IR 0.889 — also passes.
- Both clear the holdout gate. Holdout comparison was **not** used to rank.

### Correction (2026-04-17)

The earlier version of this document recommended `d65-tp40-ts150` based on "robustness-weighted reading" (holdout stability + bootstrap CI). That recommendation **violated the pre-registered decision rule**, which explicitly says holdout is observed but not used for ranking. Codex adversarial review correctly flagged this as making Campaign D's incumbent post-hoc and contaminating downstream work that used `d65-tp40-ts150` as a baseline (Campaign E).

This document is now the authoritative Campaign D result. The strict pre-reg winner is **`d65-sl35-ts105`**. Any downstream campaign that used `d65-tp40-ts150` as its incumbent must either:
1. Be reclassified as exploratory (not preregistered), or
2. Rerun with `d65-sl35-ts105` as the carried-forward incumbent.

## 5. What Campaign D did NOT test (out of pre-reg scope)

- `d65-sl35-ts150` (combining both top-2 alpha axes) — not pre-registered; tested in Campaign E seed sweep, where it fails the delta gate.
- Multi-parameter combinations beyond the 6 pre-registered intersection probes.
- Signal-logic changes (EMA band width, EMA rising window).
- Ticker subsets.

Any of those requires a **separate pre-registration** before being evaluated.

## 6. Final state of Campaign D

- **Adopted secondary strategy: `d65-sl35-ts105`**
  - Deep ITM LEAP CALL
  - δ [0.65, 0.80], DTE [180, 270]
  - TP 0.40, **SL 0.35** (loosened from baseline's 0.30)
  - TS 105
  - 14 champion tickers (GLD, IWM, AAPL, MSFT, GOOG, AMZN, META, JPM, GS, COST, UNH, NFLX, NVDA, TSLA)
  - Signal: EMA34 MA-touch 0–5% + SPY>EMA200 + ticker>EMA55 + EMA8>EMA13 + EMA34 rising 5d + contangoPct<48

- **Primary strategy (unchanged):** DTE5 QQQ bull-put credit spread

- **Downstream work affected:** Campaign E was seeded from `d65-tp40-ts150` (the incorrectly-adopted runner-up). Campaign E results are therefore non-preregistered and classified exploratory. See [campaign-e-audit.md](campaign-e-audit.md) for remediation.
