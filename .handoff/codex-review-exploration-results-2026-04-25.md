---
task: Codex review — empirical exploration results from session 2026-04-25
stage: review-ready
owner: codex
from: user
timestamp: 2026-04-25T16:30:00Z
---

## Objective

Hand the session's empirical findings to Codex for adversarial review.
Three artifacts produced, all merged: regime attribution, liquidity
scorecard + ORATS backfill, BCD rotation WFA v1. Got one structural gate
that survives (RV-elevated filter on PMCC, +0.34 Sharpe) and three clean
falsifications (gates delete alpha, naive momentum rotation underperforms,
event blackouts hurt).

The 5 open questions at the end are the actual ask. Codex should pressure-
test: did we measure the right things, are conclusions overreaching, what
should be next given dsrM ceiling stays at 106 until 2026-10-20?

## Context

- PR #29: https://github.com/yauyueson/trading-journal/pull/29
- Three commits in this session: `91c9e6b` (attribution + scorecard),
  `dfbacc3` (ORATS backfill, 2,940 calls), `409a0e6` (rotation WFA v1)
- All numbers below are reproducible from the merged code

## The Brief (paste verbatim into Codex)

````
# Session Results — Strategy Expansion Beyond QQQ-Only (for Codex review)

## Context

Following your earlier brainstorm response, the user and I worked through the
sequencing you proposed. Three artifacts produced, all merged into one branch
(PR #29 on the trading-journal repo). All work is parked pre-2026-10-20 dsrM
refresh — no live deployment claim.

Setup recap (constraints unchanged):
- Two F1 sealed strategies live, both QQQ-only: BCD QQQ wide ($2K tier) and
  PMCC QQQ pt60 ($10K+ tier)
- dsrM global attempt counter at 106; refresh 2026-10-20
- Effect-size bar to clear sealed adoption: ~+0.30 Sharpe over anchor under N=106
- WFA: 252 train / 126 forward / 10 purge / rolling, 5 holdout (sealed F1
  structure, holdout boundary 2024-01-22)

================================================================
ARTIFACT 1 — Sealed-anchor regime attribution
================================================================

Replayed both F1 anchors through their sealed WFA structure, tagged every
trade entry with a pre-declared regime feature set, produced per-regime PnL
tables + what-if-gate simulations.

Pre-declared tag set (locked before tagging):
- QQQ vs 100d EMA, SPY vs 200d EMA (trend)
- 5d/60d realized vol shock buckets
- IV30/HV20 ratio (cheap/normal/crisis)
- IV30 percentile rank (252d rolling)
- Days to nearest CPI release, days to nearest FOMC decision
- Breadth (% of 28-name universe > 50d EMA)

Trade counts reconcile to sealed audit rows: BCD 59 selection / 25 holdout
matches `oosTrades: 59 / holdoutTrades: 25` exactly.

### Headline finding: gates DELETE the alpha

Both anchors are rebound-capture engines, not trend-following.

**BCD QQQ wide — selection what-if gate impact** (baseline Sharpe 0.97, MaxDD 39.8%):

| Gate | Kept/59 | Sum PnL | Sharpe | MaxDD | Verdict |
|------|--------:|--------:|-------:|------:|---------|
| no RV elevated (5d/60d < 1.5) | 54 | $7,844 | **1.11** | **31.6%** | only structural survivor |
| no RV shock (5d/60d < 2.0) | 58 | $7,833 | 1.10 | 36.6% | marginal |
| IV/HV not crisis | 55 | $7,567 | 1.03 | 43.3% | flat |
| QQQ > 100d EMA | 44 | $5,372 | 0.88 | 47.7% | hurts |
| SPY > 200d EMA | 45 | $6,303 | 0.97 | 38.0% | flat |
| QQQ > 100d EMA AND SPY > 200d EMA | 41 | $5,450 | 0.88 | 39.6% | hurts |
| CPI proximity > 1d | 51 | $6,025 | 0.94 | 53.6% | hurts |
| FOMC proximity > 1d | 51 | $5,641 | **0.82** | **63.6%** | much worse |
| CPI > 3d AND FOMC > 3d | 23 | $1,576 | 0.48 | 77.8% | kills the alpha |
| trend ON + no RV elev + event > 1d | 28 | $4,008 | 0.73 | 45.6% | combined gate hurts |

**PMCC QQQ pt60 — selection what-if gate impact** (baseline Sharpe 1.72, MaxDD 17.5%):

| Gate | Kept/28 | Sum PnL | Sharpe | MaxDD | Verdict |
|------|--------:|--------:|-------:|------:|---------|
| no RV elevated (5d/60d < 1.5) | 23 | $38,222 | **2.06** | **13.1%** | strong winner |
| no RV shock (5d/60d < 2.0) | 27 | $33,230 | 1.66 | 18.2% | marginal |
| IV/HV not crisis | 28 | $34,408 | 1.72 | 17.5% | no-op |
| FOMC proximity > 1d | 22 | $32,226 | 1.68 | 21.7% | flat |
| QQQ > 100d EMA | 15 | $19,284 | 1.34 | 15.4% | drops $15K of PnL |
| SPY > 200d EMA | 15 | $19,729 | 1.22 | 16.5% | hurts |
| trend ON + no RV elev + event > 1d | 6 | $14,802 | 1.41 | 11.0% | kills 22/28 trades for $14.8K of $34.4K |

### Per-regime cross-tabs (combined selection + holdout)

For PMCC, "below 100d EMA" entries had **higher** mean PnL ($1,433 vs $1,311
above) and **higher** win-rate (62.5% vs 52.2%). Same direction for BCD:
mean PnL $168 below vs $146 above.

For PMCC, FOMC proximity ≤ 1d entries had **negative** PnL: 7 trades, -$33
mean, 28.6% win. Only macro event with structural signal.

For PMCC, IV30/HV20 "cheap" bucket: 6 trades, $1,962 mean PnL, 83.3% win.
"Normal" bucket: 33 trades, $1,252 mean. Cheap-IV entries are the best
spots — opposite of what conventional wisdom says about debit-side structures.

### Implication

The only structural gate worth bolting onto either anchor is **RV-elevated
skip (5d/60d ≥ 1.5)**. Microstructure interpretation: don't initiate into
freshly chaotic tape where bid/ask widens. Trend / event blackouts /
breadth all fail as gates — they delete winners more than losers. This is
clean falsification of much of the conventional gating intuition for
bull-biased convex structures during the 2018-2026 sample.

================================================================
ARTIFACT 2 — Liquidity eligibility scorecard
================================================================

Swept all 30 cached tradable tickers through monthly snapshots
(2018-01 → 2026-02 = 98 dates) to score:
- BCD construction: long δ 0.50 + short δ 0.20 same expiry, DTE 30-60
- PMCC LEAP construction: δ 0.70-0.80, DTE 240-300
- PMCC short construction: δ 0.20-0.30, DTE 30-45
- Median OI per leg, median bid/ask % mid

Critical finding mid-process: 13 tickers showed 0-11% DTE 30-60 coverage
despite having full per-day cache data. Probe of ORATS confirmed it was a
**stale cache state** (legacy NULL/NULL fetch_log entries marking those
tickers as "fully covered" while DTE 30-59 rows had never actually been
fetched), not an ORATS data limitation. ORCL probe at 2024-01-02 returned
109 DTE 30-59 rows.

### Backfill executed

Within user-authorized API budget (cap 2,500 stretched to 2,940 with
explicit approval):
- 1 probe call
- 2,401 calls main backfill (2018-01 → 2024-11-20, hit safety cap)
- 538 calls tail backfill (2024-11-21 → 2026-02-28, completed)
- 12 tickers backfilled at DTE 30-60: ORCL, NOW, PANW, ANET, SHOP, CRWD,
  AVGO, BA, MSTR, LULU, UBER, COIN
- HOOD, VRT, ARM, PLTR not backfilled (low priority / short histories)

### Post-backfill BCD universe

23 tickers in Tier A+B (was 14 before backfill):

Tier A (20): AMD, MSFT, AAPL, JPM, META, ORCL*, NVDA, IWM, BA*, TSLA, CRWD*,
AMZN, GS, NFLX, AVGO*, PANW*, COST, LULU*, SHOP*, GOOG
Tier B (3): CRM, NOW*, ANET*

(*) added by backfill.

UBER + COIN remain Tier D after backfill: 28-35% DTE 30-60 coverage even
with full ORATS access — genuinely thinner option markets in their
early-IPO years (fewer listed expiries below 60 DTE).

PMCC sleeve incidentally widened 13 → 18 tickers (DTE 30-45 short range
overlaps the backfilled DTE 30-60 region).

================================================================
ARTIFACT 3 — BCD rotation WFA v1 (the falsification you asked about)
================================================================

User scoped this intentionally narrow:
- Universe: 23 BCD Tier A+B tickers
- Structure: BCD F1 verbatim, no parameter sweep
- Rotation: top-3 by (126d return − 21d return) / 63d realized vol,
  every 10 trading days
- Capital: $6K rotation (3 slots × $2K) vs $2K baseline (1 slot)
- maxPositions=3, maxPerTicker=1
- WFA: 252/126/10 rolling, 5 holdout (matches sealed F1)
- Optional variant: skip rebalances when QQQ RV5/RV60 ≥ 1.5
- No other gates

### Headline result — clean negative

| Window | Strategy | Sharpe | MaxDD | Trades | Win% | Corr to baseline |
|--------|----------|-------:|------:|-------:|-----:|-----------------:|
| Selection | Baseline (QQQ-only F1) | **0.97** | **39.8%** | 59 | 64% | — |
| Selection | Rotation top-3 | 0.90 | 70.8% | 154 | 49% | 0.36 |
| Selection | Rotation + RV filter | 0.86 | 73.1% | 149 | 49% | 0.36 |
| Holdout | Baseline (QQQ-only F1) | **1.22** | **14.3%** | 25 | 60% | — |
| Holdout | Rotation top-3 | 0.61 | 21.5% | 72 | 49% | 0.52 |
| Holdout | Rotation + RV filter | 0.53 | 22.2% | 70 | 49% | 0.52 |

Rotation underperformed baseline on Sharpe (-0.07 selection / -0.61 holdout),
MaxDD (+31pp / +7pp), and win-rate (-15pp). Diversification correlation
0.36-0.52 is real but doesn't compensate for the variance increase from
3 concurrent correlated mega-cap positions.

### Per-ticker contribution (rotation, combined)

Top contributors (multi-year uptrends): GOOG +$16K, NVDA +$6K, META +$6K,
NFLX +$6K, GS +$6K, AVGO +$5K.

Worst contributors: TSLA -$4K, SHOP -$3K, COST -$3K, BA -$2K, LULU -$2K.

Pick frequency: COST got selected 59× (most), lost money. NVDA 56×, made
money. Momentum rule rewarded recent strength but didn't filter
deterioration.

### Diagnostic interpretation

Win-rate dropped 60-64% → 49% — biggest single tell. Rotation entries are
systematically lower-quality than the simple QQQ 10-day cadence.
The momentum-rank rule appears to pick tickers AFTER their move, into
mean-reversion drag. Single-name BCD trades through earnings drift +
idiosyncratic drawdown the structure can't recover from.

The RV-elevated filter (skip 22 of 225 rebalances, 10%) made results
slightly worse — consistent with the regime-attribution finding that gates
delete alpha for these structures.

================================================================
WHERE WE STAND
================================================================

Empirically falsified this session:
- "Gates improve risk-adjusted return on F1 anchors" — false. Only RV-elev
  survives, and the lift is small (+0.14 BCD, +0.34 PMCC Sharpe) at the cost
  of trade count.
- "More tickers = more diversification" via naive momentum rotation — false.
- "Trend gates control risk" on bull-biased convex structures — false on
  this sample.
- "Event blackouts add value" on QQQ — false; deletes more winners than losers.

Still alive (not yet tested):
1. Sector ETF rotation (XLK, XLF, XLV, XLY, XLE, XLI, XLP) — requires
   separate ORATS chain fetch, not in cache. Different selection (less
   single-name idiosyncratic risk, lower IV).
2. Different rotation rule on the same 23-ticker universe (low-correlation
   pairs, dispersion-based, IV-rank tilt) — would re-test rotation with a
   non-momentum selection.
3. Complementary non-correlated structures — bearish hedge sleeve, mean
   reversion on individual names, or vol-selling on the same universe.
4. Earnings-aware single-name BCD — needs Tiingo earnings calendar fetch.
   The single-name failure modes most likely cluster around earnings; a
   T-5/T+1 blackout might rehabilitate single names.
5. Aggregate "core QQQ + satellite rotation at smaller weight" portfolio
   construction — keep QQQ as 70-80% of risk budget, satellites as
   diversification at 20-30%.

================================================================
OPEN QUESTIONS FOR YOU
================================================================

1. Given win-rate dropped 15pp (60-64% → 49%) for momentum-ranked rotation
   on BCD, is the rotation result generalizable to other selection rules,
   or is it specific to "momentum picks lower-quality entries"? Concretely:
   would inverse-momentum (low 126d return) or low-correlation pairs
   produce a different shape, or do all rules fail because BCD itself
   doesn't tolerate single-name event drift?

2. PMCC's "no RV elevated" gate gave +0.34 Sharpe — substantial. But it
   removes 5 of 28 selection trades and the regime-attribution sample is
   small. Should this gate be pre-registered as a singleton in October when
   dsrM resets, or is the effect-size confidence too low to commit a slot
   from the dsrM budget?

3. The "below 100d EMA entries are MORE profitable than above" finding is
   counterintuitive enough to be worth challenging. Is this a 2018-2026
   sample artifact (the 2020 V-shape recovery alone could distort it), or
   is there a structural reason BCD/PMCC pays more on rebound entries?

4. For sector ETF testing — given lower IV / lower convexity / no earnings,
   what's the expected effect-size envelope? Is it worth the ORATS fetch
   cost (estimated ~2-3K calls for 7 ETFs over 8 years)?

5. The valid path forward, given gates are off the table and naive rotation
   is off the table — is "core QQQ + satellite at small weight" a real
   research direction, or is the honest answer "stay QQQ-only and revisit
   in October when dsrM resets"?

Be specific and skeptical. We have ~6 months before October dsrM refresh
and the user is API-budget-conscious. Prioritize ruthlessly.
````

## Work Done

### user/claude — 2026-04-25T16:30:00Z
Compiled session findings into review brief for Codex. Three artifacts
produced this session, all merged into PR #29. Asking Codex to pressure-
test the empirical results and the 5 open questions about next steps.

## Artifacts

- This file (review brief for Codex)
- PR #29: regime attribution + liquidity scorecard + ORATS backfill + BCD rotation WFA v1
- Source files (all on `research/sealed-attribution-and-liquidity-2026-04-25` branch):
  - `scripts/attribution/sealed-anchors-attribution.ts`
  - `scripts/attribution/liquidity-eligibility.ts`
  - `scripts/attribution/probe-orats-dte-coverage.ts`
  - `scripts/attribution/event-calendar.ts`
  - `scripts/autoresearch/lean-wfa-bcd-rotation.ts`
- Reports:
  - `backtesting history/credit-spread/reports/sealed-attribution/{bcd,pmcc}-qqq-*.md`
  - `backtesting history/credit-spread/reports/liquidity-eligibility/scorecard.md`
  - `backtesting history/credit-spread/reports/bcd-rotation-mega-cap/wfa-v1.md`

## Next Action

User: paste the brief block (between the ```` fences) into Codex. Capture
Codex's response back into this file under a new `### codex` log entry.

### codex - 2026-04-25

Reviewed the empirical brief and spot-checked the referenced rotation and
attribution scripts/reports. My review stance: treat this as a research-review,
not a deployment review, because dsrM is still capped until 2026-10-20.

## Findings / cautions

1. High: the BCD rotation v1 falsifies the tested rule, not all single-name BCD
   rotation. The implementation is a top-3 signal allocator on 10-day cadence,
   not a forced rebalance that closes names when they fall out of rank. That is
   fine and probably preferable for option spreads, but the conclusion should be
   stated as: "top-3 12-1 momentum entries underperform QQQ-only." It does not
   yet prove that all single-name BCD selection rules fail.

2. High: before testing a second rotation rule, decompose the failure into
   universe edge vs selection edge vs concurrency. Run the same BCD F1 cadence
   ticker-by-ticker across the 23-name universe, with no ranking, and produce:
   per-ticker Sharpe/PnL/win-rate/drawdown, equal-weight basket results, and
   QQQ-correlation. If most tickers are weak unconditionally, selection-rule
   work is probably wasted. If a subset has edge but momentum picked bad entry
   timing, rotation is still alive.

3. Medium-high: the PMCC RV-elevated gate is promising but too thin to spend a
   future dsrM slot on yet. The headline +0.34 Sharpe comes from removing 5 of
   28 selection trades, and the current what-if gate table intentionally leaves
   holdout unconditioned. That is the right choice for attribution honesty, but
   it means the October decision needs one more frozen evaluation: apply exactly
   RV5/RV60 < 1.5 to PMCC on holdout windows and report the result separately as
   "selection-discovered, holdout-observed." Do not tune the threshold.

4. Medium: "below 100d EMA entries are more profitable" is plausible but should
   not be overclaimed as structural until block-attributed. It may be rebound
   capture, but it could also be dominated by 2020 V-shape, 2022/2023 recovery,
   or the 10-day cadence interacting with cash availability after prior exits.
   Slice by calendar year / WFA block and by "days since local drawdown low" or
   "days since prior loss" before calling it durable.

5. Medium: QQQ macro-event blackout failure does not transfer to single-name
   earnings. The CPI/FOMC result says event blackouts delete QQQ winners. It
   does not say earnings blackouts delete single-name BCD winners. Single-name
   BCD has a different jump distribution and adverse gap risk. Earnings-aware
   BCD remains alive, but only after ticker-level baseline decomposition.

6. Medium: max drawdown comparison is directionally fair because capital is
   scaled to $6K vs $2K and Sharpe is unitless, but it does not answer the
   user's realistic portfolio question. The tested standalone rotation is 3
   concurrent $2K spreads. A "core QQQ + 20-30% satellite" book could look much
   better or worse depending on overlap timing. The combined portfolio should
   be tested explicitly before rejecting the satellite framing.

7. Low: the liquidity scorecard summary has a typo/inconsistency: "Tier A (15)"
   lists 20 tickers, plus Tier B 3 = 23. Not material to the research, but fix
   the report text so future readers do not wonder whether the universe changed.

## Answers to the 5 open questions

### 1. Is the rotation result generalizable?

Not fully. It is strong evidence against naive 12-1 momentum top-3 selection
for BCD, especially because holdout degradation is large: Sharpe 1.22 baseline
vs 0.61 rotation, win-rate 60% vs 49%, and drawdown worse. But it is not enough
to reject all selection rules.

The next diagnostic should be non-API and cheap:

- Run each of the 23 tickers on the same BCD F1 10-day cadence, maxPositions=1.
- Compare each ticker to QQQ on selection and holdout.
- Build an equal-weight "one slot per ticker when flat" basket or simple
  round-robin basket.
- Tag per-ticker losses by earnings proximity once earnings data exists.

Interpretation grid:

- If most tickers have poor unconditional BCD stats, single-name BCD is the
  problem. Stop rotation research.
- If several tickers are good unconditionally but momentum picks late entries,
  selection rule is the problem. Test only one alternative.
- If equal-weight basket has lower Sharpe but much lower QQQ correlation and
  acceptable drawdown, it can still be a satellite.

I would not test inverse momentum yet. It is tempting because the anchors like
rebound entries, but "buy weak single names with call spreads" can easily become
catching broken earnings/guidance names. If tested, it should be after
per-ticker unconditional BCD and earnings attribution.

### 2. Should PMCC RV-elevated gate be pre-registered in October?

Not yet as a committed sealer slot. It should be parked as the only gate
candidate, with a frozen spec:

- Gate: skip PMCC long-leg entries when QQQ RV5/RV60 >= 1.5.
- Do not change threshold, lookback, or use per-ticker RV.
- Existing positions: define behavior explicitly. My bias: gate only new long
  LEAP entries/reopens, not short-call management on existing PMCCs.

Before October, run the frozen gate on the current holdout windows as a
non-adoption diagnostic. If it also improves holdout or at least does not
materially degrade it, it becomes a reasonable singleton candidate after dsrM
refresh. If it fails holdout, keep PMCC as-is.

### 3. Is below-100d profitability structural or sample artifact?

Both are plausible. The structural argument is real: these are convex,
defined-risk rebound-capture structures. A below-trend entry can have better
forward skew if the underlying has already repriced, IV is high enough to make
spread construction attractive, and QQQ mean reverts.

But 2018-2026 contains several unusually sharp recovery regimes. I would
challenge the conclusion with:

- Exclude March-May 2020 entries and recalc.
- Split into 2018-2019, 2020-2021, 2022, 2023, 2024-2026.
- Compare below-EMA entries by distance below EMA, not just binary below/above.
- Check whether below-EMA winners are concentrated in a few trades.

If the effect survives those slices, the practical conclusion is not "prefer
below trend"; it is "do not use trend as a veto."

### 4. Is sector ETF testing worth 2-3K ORATS calls?

Not yet. The expected effect-size envelope is probably:

- Standalone Sharpe vs QQQ BCD: -0.30 to +0.05.
- Drawdown/correlation benefit: possible but uncertain.
- Chance of +0.30 Sharpe upgrade: low.

Sector ETFs remove earnings gaps and reduce idiosyncratic drift, but they also
lower IV, reduce dispersion, and can collapse into the same risk-on/risk-off
factor during stress. That makes them a portfolio-diversification candidate,
not a likely October sealer.

Because API budget matters, defer sector ETF fetch until after the zero-API
diagnostics on the 23-name cache. If the 23-name basket cannot produce a useful
satellite even with existing data, sectors are still intellectually interesting
but not urgent.

### 5. Is core QQQ + small satellite real, or should we stay QQQ-only?

It is still real as a research direction, but the burden of proof changed. The
satellite no longer needs to beat QQQ on Sharpe, but it must clear a stricter
portfolio-utility bar:

- Combined portfolio drawdown not worse than QQQ-only.
- Correlation reduction visible in bad QQQ windows, not just average daily
  correlation.
- Satellite weight small enough that weaker standalone Sharpe does not dominate.
- No hidden earnings gap exposure that would appear only live.

Test a fixed combined book, not another open-ended search:

- 70-80% QQQ BCD/PMCC core, 20-30% satellite.
- Satellite candidates limited to top unconditional BCD tickers or equal-weight
  liquid basket from the 23-name cache.
- One optional PMCC RV gate as a separate overlay, not mixed into the satellite
  search.

If that combined book still worsens Sharpe and drawdown, the honest answer is
stay QQQ-only until October and spend research time on monitoring, reporting,
and robustness checks rather than new strategy mining.

## Recommended next sequence

1. Zero API: run per-ticker unconditional BCD F1 across the 23-name universe.
   This is the missing decomposition and should come before any new selection
   rule.

2. Zero API: run frozen PMCC RV gate on current holdout windows as an
   observational diagnostic. Do not alter the gate.

3. Zero API if possible, otherwise light data: add earnings proximity tags to
   the 23-name BCD trades. Do not test blackout windows yet; first measure loss
   concentration.

4. Zero API: build one fixed "core QQQ + small satellite" portfolio from the
   best unconditional BCD evidence. Evaluate portfolio drawdown, bad-window
   behavior, and QQQ correlation.

5. Only if steps 1-4 show a real diversification hole worth filling, spend the
   2-3K calls on sector ETFs.

Bottom line: the session produced useful falsifications. I would stop trend
gates, stop QQQ macro-event blackouts, and stop naive top-3 momentum. I would
not stop all satellite research yet. The immediate next artifact should be the
23-name unconditional BCD decomposition; it is cheap, decisive, and will prevent
another round of narrative-driven rotation rules.
