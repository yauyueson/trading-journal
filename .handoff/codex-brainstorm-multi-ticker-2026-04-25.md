---
task: Codex brainstorm — strategy expansion beyond QQQ-only (gates + sector rotation)
stage: prompt-ready
owner: codex
from: user
timestamp: 2026-04-25T10:30:00Z
---

## Objective

Hand to Codex for open brainstorm. Two angles:
1. Gates / filters that could lift the existing F1 anchors (BCD QQQ wide, PMCC QQQ pt60).
2. Multi-ticker / sector-rotation strategies — user wants flexibility, not concentration on QQQ.

Output is a *parked candidate shortlist* (cannot deploy live until 2026-10-20
dsrM ceiling refresh), used to plan research between now and October.

## Context

- Two F1 sealed strategies (2026-04-23), both QQQ-only, both bull-biased.
- dsrM global attempt counter = 106; refresh 2026-10-20.
- Prior dead avenues: DTE5 generalization (mega-cap earnings gaps, IWM lag),
  PMCC small-cap (HOOD/PLTR infra-limited), iron condors / butterflies /
  calendars on QQQ (all WFA-killed).
- Single-axis sensitivity sweeps on the F1 anchors found 5 of 6 levers dead.

## The Prompt (paste verbatim into Codex)

````
# Brainstorm: Strategy Expansion Beyond QQQ-Only

## Project Context
Single-user options trading journal with a sealed-holdout research protocol.
Two F1 strategies sealed PASS 2026-04-23 (post-F0 clean-slate), both QQQ-only,
both bull-biased:

1. BCD QQQ wide ($2K tier): bull call debit spread. Long δ 0.50 / short δ 0.20,
   DTE 30-60, profit target 50%, 10-day cadence when flat.
   Sealed: oosSharpe 0.97, holdoutSharpe 1.22, holdoutSpyIR +0.40, dsrM +0.065.

2. PMCC QQQ pt60 ($10K+ tier): diagonal. Long LEAP δ 0.70-0.80 DTE 240-300,
   short monthly δ 0.20-0.30 DTE 30-45. Long PT 60% / SL 35%, short PT 50%,
   roll short when underlying within 2% of short strike. Always-in.
   Sealed: oosSharpe 1.72, holdoutSharpe 1.63, holdoutSpyIR +0.15, dsrM +0.845.

User wants flexibility — sector rotation, nimble allocation across tickers
rather than always concentrated in QQQ.

## Hard Constraint: dsrM Global Attempt Ceiling
The Bailey & López de Prado deflated Sharpe gate reads the GLOBAL attempt
counter (currently 106). Won't refresh until the 2026-10-20 holdout boundary.
- No new sealed adoption can deploy live before October 2026.
- Output is a PARKED CANDIDATE SHORTLIST, not a deployment plan.
- Effect sizes need to be ~+0.30 Sharpe over anchor to clear dsrM under N=106.

## Already Ruled Out
- DTE5 short-put credit spreads sealed FAIL on QQQ + AAPL/MSFT/NVDA/GOOG + IWM
  + SPY. Mega-cap earnings gaps blow through SL; bounded-upside structures
  lag the 2024-2026 rally.
- PMCC on HOOD + PLTR — infrastructure-limited (0 holdout trades under WFA +
  maxPositions=1). Small underlyings lack chain liquidity / DTE coverage.
- Iron condors, butterflies, calendar spreads — all killed under WFA on QQQ.
- Single-axis sensitivity sweeps on the F1 anchors: 5 of 6 levers dead. Only
  pmcc-short-pt30 survived (+0.04 Sharpe, too small for dsrM).

## Universe (30 tradable + benchmarks)
Tradable: IWM, AAPL, MSFT, GOOG, AMZN, META, JPM, GS, COST, NFLX, NVDA, TSLA,
AMD, AVGO, BA, COIN, HOOD, LULU, MSTR, PLTR, UBER, CRM, ORCL, CRWD, SHOP, PANW,
ANET, VRT, ARM, NOW.
Benchmarks (not tradable): SPY, QQQ.
Data: ORATS chain history (full Greeks + IVs), Tiingo daily candles, IV/HV
history per ticker.

## Available Infrastructure
- WFA engine: 252d train / 126d forward / 10d purge / 5 holdout windows
- BSM-on-ORATS simulator: CREDIT_SPREAD, DEBIT_SPREAD, DIAGONAL, LEAP, BUY_WRITE
- Dynamic slippage model (per-leg, OI-aware, DTE-aware)
- Sensitivity sweep + WFA validation runners
- Portfolio-level metrics (correlated drawdown, daily MtM)

================================================================
TWO ANGLES — give me prioritized concrete proposals on each
================================================================

## Angle 1: Gates / Filters to Improve the Existing F1 Anchors
What technical, macro, calendar, or cross-asset filters could lift BCD or PMCC
Sharpe ~+0.30 without overfitting? Think:
- Trend gates (which EMA/ADX/regime classifier? why that period?)
- IV / VRP regime filters (when do these anchors actually underperform?)
- Earnings / FOMC / CPI blackouts
- Cross-asset signals (yields, dollar, breadth, credit spreads)
- Sequence / cooldown gates after losses

For each proposal state:
  - HYPOTHESIS: why this should help (cite domain reasoning, not just a hunch)
  - DATA NEEDED: what we'd have to fetch/compute
  - FAILURE MODE GUARDED AGAINST: which historical loss does this prevent?
  - EXPECTED EFFECT SIZE: rough Sharpe lift estimate
  - OVERFIT RISK: structural vs likely overfit, and why

## Angle 2: Multi-Ticker / Sector-Rotation Strategies
User wants to rotate capital across tickers, not concentrate on QQQ.
Address explicitly:

a) Which strategy STRUCTURE × which TICKER SUBSET is most likely to survive
   WFA? (BCD on mega-caps? PMCC on mid-priced names? Something new?)

b) What's a sane ROTATION RULE? (top-N relative strength? momentum sleeves?
   IV-rank tilt? equal-weight basket? sector-neutral pairs?)

c) How do we avoid the PMCC-low-price infrastructure trap?
   (sizing rules, ticker filters, DTE flexibility?)

d) SECTOR ETF angle — XLK / XLF / XLV / XLY / XLE / XLI / XLP. Deeper liquidity,
   less idiosyncratic risk, but lower vol premium and lower IV. Is this
   structurally interesting or a watered-down version of QQQ?

e) CROSS-STRATEGY CORRELATION — both anchors are bull-biased. If BCD-on-mega-cap
   and PMCC-on-mid-cap also bias bull, is there a complementary structure
   (mean-reversion, hedge, neutral) worth testing for portfolio diversification?

For each proposal state:
  - TICKER SUBSET + why those tickers specifically
  - STRATEGY MODE + key parameters (deltas, DTE, exits)
  - WFA RISK you expect (regime-sensitivity, infra limits, earnings gaps)
  - EFFECT-SIZE GUESS vs. holding QQQ-BCD or QQQ-PMCC alone

## Output Format
1. EXECUTIVE SUMMARY — top 5 picks across both angles
2. ANGLE 1 PROPOSALS — ranked, with the fields above
3. ANGLE 2 PROPOSALS — ranked, with the fields above
4. PUSHBACK — premises in this prompt you'd challenge
   (e.g. "dsrM shouldn't block X-type research because...")
5. SEQUENCING — given limited budget before 2026-10-20, what order should
   we actually investigate?

Be specific and skeptical. "Try an EMA filter" without naming period + regime
conditioning is not useful. Cite domain reasoning (vol risk premium, equity
put-skew, earnings drift, sector dispersion) where it informs the answer.
We've already burned cycles on dead avenues — challenge anything that looks
like a tribute to recency bias from the 2024-2026 rally.
````

## Work Done

### user/claude — 2026-04-25T10:30:00Z
Drafted brainstorm prompt covering (1) gates to improve F1 anchors and
(2) multi-ticker / sector-rotation strategies. Saved here for reference; not
yet routed to Codex.

## Artifacts

- This file (the prompt itself)

## Next Action

User: paste the prompt block (between the ```` fences) into Codex. Capture
Codex's response back into this file under a new `### codex` log entry, or
spin a follow-up handoff that references this one.

### codex - 2026-04-25T10:45:00Z

Executed the brainstorm prompt. Result below.

## EXECUTIVE SUMMARY - top 5 parked candidates

1. QQQ anchor regime gate: 100/200-day trend plus realized-vol shock filter.
   Best first test for both BCD and PMCC because it attacks the main failure
   mode of bull-biased convex structures: staying long during de-risking
   cascades when deltas gap against you and IV marks widen slippage/MTM pain.
   Candidate: allow new BCD entries only when QQQ close > 100d EMA and SPY
   close > 200d EMA, and block entries for 5 sessions after a 2.0x 20d
   realized-vol shock. For PMCC, do not open/reopen LEAPs when the gate is off;
   optionally hold existing long LEAPs but stop selling new shorts until trend
   recovers. Expected Sharpe lift: +0.15 to +0.35 if drawdown windows dominate
   losses; lower if the sealed edge depends on fast rebound participation.

2. Multi-ticker liquid mega-cap BCD rotation: top 3 of liquid, high-price,
   high-option-depth growth/quality names by 126d relative strength, excluding
   tickers within an earnings blackout. Subset: AAPL, MSFT, GOOG, AMZN, META,
   NVDA, AVGO, COST, JPM, GS, CRM, ORCL, NFLX, PANW, NOW, AMD only if chain
   depth passes. Use QQQ-BCD-like parameters, not a fresh fitted spread. This is
   the cleanest way to answer "not always QQQ" without entering the low-price
   PMCC infrastructure trap. Expected effect: similar single-line Sharpe to
   QQQ-BCD, but better portfolio utility if correlation/drawdown improves.

3. PMCC liquid large-cap sleeve, not small-cap PMCC: only tickers with price
   high enough and LEAP chain depth enough to support 0.70-0.80 delta longs and
   30-45 DTE shorts across all WFA windows. Subset likely AAPL, MSFT, GOOG,
   AMZN, META, NVDA, AVGO, COST, JPM, GS, NFLX, CRM, ORCL, NOW. Rotation should
   be slow: quarterly top 2-4 by 12-1 momentum, with earnings-aware short-call
   management. Expected effect vs QQQ-PMCC: not likely to beat PMCC Sharpe by
   +0.30 alone, but could reduce concentration and improve capital allocation.

4. Earnings/event blackout for individual-stock expansion and maybe QQQ anchor
   entries around CPI/FOMC. This should be treated as a structural risk control,
   not an alpha optimizer. For single names, block opening new BCD/PMCC shorts
   from T-5 through T+1 around earnings; for QQQ, block new BCD entries on CPI
   day, FOMC day, and maybe the session before/after if historical loss
   attribution justifies it. Expected Sharpe lift: +0.05 to +0.20 for QQQ, up
   to +0.30 for single-name baskets if gap losses are concentrated.

5. Sector ETF BCD rotation as a diversification candidate, not a return-max
   candidate. Subset: XLK, XLF, XLY, XLI, XLE, XLP, XLV. Rule: top 2 sectors by
   126d risk-adjusted relative strength, only if sector close > 100d EMA and IV
   rank is not in the bottom quartile. This is structurally interesting because
   it removes single-name earnings gaps and lets sector dispersion drive
   allocation, but it may be a watered-down QQQ because lower IV and lower skew
   can compress option edge. Expected effect: lower standalone Sharpe than QQQ
   anchors, possible lower correlated drawdown.

## ANGLE 1 PROPOSALS - gates / filters for F1 anchors

### 1. Dual trend plus vol-shock gate for BCD entries and PMCC reopens

- HYPOTHESIS: Bull call debit spreads and PMCCs both need directional drift.
  They tolerate chop better than naked long calls, but they still suffer when
  trend breaks and realized volatility expands. A 100d EMA on QQQ catches
  medium-term trend deterioration; SPY > 200d EMA avoids a QQQ-only false sense
  of safety during broad-market stress. A realized-vol shock block avoids
  entering immediately after volatility expansion when bid/ask and path risk are
  ugly.
- DATA NEEDED: QQQ and SPY daily closes, rolling 100d/200d EMAs, 20d realized
  volatility, and a "shock" flag such as current 5d RV > 2.0x trailing 20d RV
  or abs 1d return > 2.5x trailing 20d daily sigma.
- FAILURE MODE GUARDED AGAINST: 2022-style trend breaks, post-gap continuation
  selloffs, and entries made right after volatility expansion where the debit
  spread loses before mean reversion arrives.
- EXPECTED EFFECT SIZE: +0.15 to +0.35 Sharpe for BCD; +0.05 to +0.25 for PMCC.
  PMCC may lose rebound capture if gate forces delayed re-entry.
- OVERFIT RISK: Moderate but structural. EMA period choice is overfit-prone, so
  test only a small family: 100d, 150d, 200d, plus a fixed SPY 200d broad-risk
  overlay. Do not sweep many variants.

### 2. IV/HV regime gate: require enough implied premium, avoid panic IV

- HYPOTHESIS: BCD pays debit and needs movement; PMCC sells short calls against
  long convex exposure. Both can suffer when IV is either too cheap to monetize
  on short legs or too panicked to enter cleanly. A useful regime is "IV is
  above realized, but not in crisis." That is classic volatility risk premium:
  collect or offset option cost when implied volatility is rich relative to
  recent realized volatility, but avoid paying through wide markets during
  stress.
- DATA NEEDED: Ticker-level 30d IV, 20d/30d realized volatility, IV rank or IV
  percentile, term structure if available, and entry-time bid/ask/slippage.
- FAILURE MODE GUARDED AGAINST: Entering debit spreads when IV is too low and
  realized move does not compensate; opening PMCC shorts when short-call premium
  is too thin; entering either strategy in crisis IV when slippage dominates.
- Candidate rule: allow BCD/PMCC entries when IV30/HV20 between 0.9 and 1.6 and
  IV rank between 20 and 80. For PMCC short-call sale, require short-call credit
  above a minimum percent of LEAP debit or underlying notional.
- EXPECTED EFFECT SIZE: +0.10 to +0.30 if losses cluster in extreme IV regimes.
- OVERFIT RISK: Medium-high. IV thresholds can become curve-fitted quickly.
  Prefer broad bins: low, normal, crisis. Validate by attribution first, then
  only test one or two thresholds.

### 3. Calendar event blackout: CPI/FOMC for QQQ, earnings for single names

- HYPOTHESIS: Scheduled macro events and earnings produce jump risk that BSM
  approximations and historical daily candles can understate. BCD has bounded
  downside but a bad entry before an event can consume the whole debit. PMCC
  short calls are especially vulnerable to upside earnings gaps, while long
  LEAPs can still be impaired by post-event IV crush.
- DATA NEEDED: FOMC dates, CPI release dates, single-name earnings dates,
  ex-dividend dates for dividend-heavy names, and loss attribution by event
  proximity.
- FAILURE MODE GUARDED AGAINST: Overnight event gaps through spread strikes,
  short-call assignment/roll stress, and false signals caused by pre-event drift.
- Candidate rule: for QQQ, block new BCD entries on CPI/FOMC day and the prior
  session; for single names, block opening new BCD and short PMCC legs T-5 to
  T+1 around earnings. Long PMCC LEAP entries can be allowed after T+1 if
  liquidity and trend gates pass.
- EXPECTED EFFECT SIZE: +0.05 to +0.20 for QQQ anchors; +0.15 to +0.35 for
  single-name expansion.
- OVERFIT RISK: Low to moderate. Event avoidance is structural, but window width
  can be overfit. Use one fixed window, then attribution, not a broad sweep.

### 4. Breadth confirmation gate for QQQ entries

- HYPOTHESIS: QQQ can be pulled by a few mega-caps. A breadth gate avoids
  entering a bull-biased option structure when index price is positive but
  participation is weak. Weak breadth tends to precede fragile rallies and
  sharper downside rotations.
- DATA NEEDED: Nasdaq 100 constituent breadth if available, or proxy breadth:
  percentage of universe above 50d EMA, equal-weight QQQ vs QQQ relative trend,
  XLK/QQQ and RSP/SPY relative strength proxies.
- FAILURE MODE GUARDED AGAINST: Narrow leadership rallies where QQQ stays above
  trend but most growth names are deteriorating, increasing gap/downside risk.
- Candidate rule: QQQ above 100d EMA and at least 55% of liquid growth universe
  above 50d EMA; or equal-weight proxy above its own 50d EMA.
- EXPECTED EFFECT SIZE: +0.10 to +0.25. It may mostly reduce trade count rather
  than lift raw Sharpe.
- OVERFIT RISK: Moderate. Breadth construction can become bespoke. Use a simple,
  predeclared proxy from available tradable universe if full constituent data is
  not already clean.

### 5. Post-loss cooldown / sequence gate for BCD only

- HYPOTHESIS: Consecutive debit-spread losses often occur in the same adverse
  regime: trend break, volatility expansion, or failed rebound. A fixed cooldown
  after a full debit loss avoids immediately re-entering the same bad tape.
- DATA NEEDED: Trade-level exits, loss reason, days since loss, and whether
  subsequent trades within 5/10/15 sessions have negative expectancy.
- FAILURE MODE GUARDED AGAINST: Repeated entries during a drawdown cluster.
- Candidate rule: after a BCD exits at max loss or stop, require 10 trading days
  plus QQQ close back above 20d EMA before another entry.
- EXPECTED EFFECT SIZE: +0.05 to +0.20. Good if loss autocorrelation exists;
  harmful if best recoveries occur immediately after losses.
- OVERFIT RISK: Medium. Cooldown length is easy to overfit. Test only 10d
  because it matches the existing cadence, and one 20d sanity variant.

### 6. Rates/dollar/credit cross-asset risk gate

- HYPOTHESIS: Long-duration growth exposure performs poorly when real yields
  spike, the dollar rallies hard, or credit stress widens. QQQ bull structures
  can be filtered when macro liquidity is hostile.
- DATA NEEDED: 10Y yield, 2Y yield, DXY or dollar proxy, HYG/LQD or credit
  spread proxy, and perhaps TLT trend. Need synchronized daily data.
- FAILURE MODE GUARDED AGAINST: 2022-like multiple-compression regimes and
  liquidity stress where QQQ trend signals lag macro pressure.
- Candidate rule: block new entries when 10Y yield is above its 50d EMA and has
  risen more than 50 bps over 60 sessions, or when HYG/LQD is below its 100d
  EMA. Keep this as a second-stage test only.
- EXPECTED EFFECT SIZE: +0.05 to +0.20. May be redundant with price trend.
- OVERFIT RISK: High. Cross-asset filters are seductive and often data-mined.
  Only test after loss attribution shows macro windows explain failures.

## ANGLE 2 PROPOSALS - multi-ticker / sector rotation

### 1. Liquid mega-cap BCD rotation

- TICKER SUBSET + WHY: AAPL, MSFT, GOOG, AMZN, META, NVDA, AVGO, COST, JPM, GS,
  CRM, ORCL, NFLX, PANW, NOW, AMD. These have higher prices, deeper chains, and
  sustained institutional option flow. Exclude names dynamically if median OI,
  spread width, or available DTE coverage fails.
- STRATEGY MODE + PARAMETERS: Bull call debit spread, using the QQQ BCD anchor:
  long delta around 0.50, short delta around 0.20, DTE 30-60, profit target 50%,
  10-day cadence when flat. Add entry gates: ticker > 100d EMA, SPY > 200d EMA,
  no earnings T-5 to T+1, IV30/HV20 not crisis-high.
- ROTATION RULE: Every 10 trading days, rank eligible tickers by 126d total
  return minus 21d return, optionally divided by 63d realized vol. Take top 3
  or top 4 with max one per loose sector cluster: mega-cap tech/platform,
  semis, financials, consumer. The 12-1 style momentum rule avoids buying the
  most exhausted one-month spike.
- WFA RISK: Single-name earnings gaps, NVDA/TSLA-like high-vol regimes, and
  recency bias from mega-cap leadership in 2024-2026. Rotation churn can also
  create hidden multiple-testing if top-N and lookbacks are swept.
- EFFECT-SIZE GUESS: Versus QQQ-BCD, standalone Sharpe may be -0.10 to +0.20.
  Portfolio-level drawdown/correlation could improve enough to justify a parked
  candidate even without a +0.30 single-strategy lift.

### 2. Liquid large-cap PMCC rotation

- TICKER SUBSET + WHY: AAPL, MSFT, GOOG, AMZN, META, NVDA, AVGO, COST, JPM, GS,
  NFLX, CRM, ORCL, NOW. Avoid HOOD/PLTR-style low-price names unless chain
  coverage proves continuous across WFA windows. Require price preferably > $75,
  liquid LEAPs 240-360 DTE, and 30-60 DTE monthly/weekly short-call availability.
- STRATEGY MODE + PARAMETERS: PMCC anchor with long LEAP delta 0.70-0.80 DTE
  240-360, short call delta 0.20-0.30 DTE 30-45, long PT 60%, long SL 35%,
  short PT 50%, roll short within 2% of strike. Consider short PT 30% as a
  single predeclared variant because it was the only sensitivity survivor, but
  do not let it become a parameter search.
- ROTATION RULE: Quarterly or monthly top 2 by 252d minus 21d momentum among
  eligible names, with no new LEAP within T-5 to T+1 earnings. PMCCs should
  rotate slowly because closing LEAPs too often can turn the strategy into an
  expensive momentum-chasing long-call system.
- HOW TO AVOID INFRA TRAP: Hard pre-filter on chain coverage per WFA window,
  minimum median OI at both LEAP and short-leg target deltas, max bid/ask as
  percent of mid, and minimum underlying price. Allow DTE flexibility 240-360
  for the long leg and 28-60 for short legs to avoid "0 trades" failures.
- WFA RISK: Fewer trades, high idiosyncratic earnings exposure, and leadership
  concentration. PMCC is capital-intensive; maxPositions=1 can make WFA results
  path-dependent.
- EFFECT-SIZE GUESS: Versus QQQ-PMCC, -0.20 to +0.10 standalone. Better as a
  concentration reducer than a likely Sharpe upgrade.

### 3. Sector ETF BCD rotation

- TICKER SUBSET + WHY: XLK, XLF, XLV, XLY, XLE, XLI, XLP. Sector ETFs have
  cleaner option infrastructure than many single names and no earnings gaps.
  They provide real sector dispersion without pretending each stock-specific
  option chain is equally tradable.
- STRATEGY MODE + PARAMETERS: BCD, long delta 0.50, short delta 0.20, DTE
  30-60, PT 50%, 10-day cadence. Require sector close > 100d EMA and SPY >
  200d EMA. Use top 2 sectors by 126d risk-adjusted RS, rebalance every 20
  trading days.
- ROTATION RULE: Rank sectors by 126d return / 63d realized vol, with a penalty
  if 21d return is extreme positive. Equal weight top 2. If fewer than two pass
  trend/IV gates, hold cash rather than forcing exposure.
- WFA RISK: Lower IV and lower convex payoff than QQQ. Sector ETFs may be
  highly correlated in broad risk-on/risk-off regimes. Some sector chains are
  less liquid outside XLK/XLF/XLE.
- EFFECT-SIZE GUESS: Versus QQQ-BCD, -0.20 to +0.10 standalone; portfolio
  diversification may be the main value. Structurally interesting, but probably
  not a dsrM-clearing Sharpe upgrade.

### 4. Hybrid "core QQQ plus satellite rotation" portfolio

- TICKER SUBSET + WHY: Keep sealed QQQ as core once deployment is allowed, add
  satellite candidates from mega-cap BCD or sector ETF BCD. This acknowledges
  that the strongest validated edge is already QQQ, while still giving the user
  flexibility.
- STRATEGY MODE + PARAMETERS: 50-70% risk budget to QQQ anchor, 30-50% to top
  2-3 eligible rotation names using the same structure. Use portfolio-level
  correlated drawdown caps.
- ROTATION RULE: Allocate satellite slots by relative strength, but only if
  candidate's rolling 63d correlation to QQQ is below a cap or its sector is
  distinct. Otherwise leave capital in cash rather than duplicating QQQ beta.
- WFA RISK: Can look diversified on ticker count but remain one big long-growth
  book. Needs daily MtM and correlated drawdown metrics, not only trade Sharpe.
- EFFECT-SIZE GUESS: Sharpe may be flat to +0.15, but max drawdown and capital
  concentration could improve materially. This is likely more realistic than
  finding a new +0.30 Sharpe strategy under N=106.

### 5. Buy-write / covered-call style defensive sleeve on sector ETFs or mega-caps

- TICKER SUBSET + WHY: Sector ETFs first, then high-liquidity mega-caps. This
  uses the available BUY_WRITE simulator and may diversify PMCC/BCD path risk by
  monetizing rich call skew in sideways regimes.
- STRATEGY MODE + PARAMETERS: Long underlying or synthetic equivalent with
  30-45 DTE short calls at delta 0.20-0.30, roll/close at 50-70% profit, avoid
  earnings for single names. Gate to neutral/uptrend regimes, not strong
  breakout regimes where call overwriting caps too much upside.
- ROTATION RULE: Choose tickers with positive 100d trend but 63d realized vol
  declining and IV/HV > 1.1. This is a sideways/uptrend premium-harvest sleeve.
- WFA RISK: In strong bull markets it will lag badly; in crashes it still owns
  delta. It may be less capital-efficient than PMCC.
- EFFECT-SIZE GUESS: Not likely to beat QQQ-PMCC, but may reduce reliance on
  perfectly timed call debit spreads. Worth a small exploration only if the
  simulator already supports it cleanly.

### 6. Complementary bearish/neutral hedge candidate: index or sector debit put spreads

- TICKER SUBSET + WHY: If QQQ/SPY are not tradable for expansion, use weakest
  sector ETFs or IWM as risk-off proxies. IWM can express weaker breadth and
  financing stress better than QQQ, but prior DTE5 failures warn that small-cap
  structures can lag in rallies and gap badly.
- STRATEGY MODE + PARAMETERS: Put debit spread, DTE 30-60, long delta around
  -0.40 to -0.50, short delta around -0.20, entered only when price < 100d EMA,
  SPY < 200d EMA, or HYG/LQD below 100d EMA. PT 50%, stop at 50-70% debit.
- ROTATION RULE: Rank sectors by weakest 63d return among those below 100d EMA;
  take only one hedge slot. This is not a constant-return engine; it is a
  drawdown-offset test.
- WFA RISK: Bearish option strategies often die by bleed and whipsaw. If tested
  with normal Sharpe only, it may look bad despite portfolio hedge value.
- EFFECT-SIZE GUESS: Standalone Sharpe likely poor to modest. Portfolio-level
  benefit may show up as lower correlated drawdown during anchor stress.

### 7. Do not prioritize low-price speculative PMCCs

- TICKER SUBSET + WHY: HOOD, PLTR, maybe COIN, MSTR, ARM, VRT, SHOP can be
  interesting directionally, but option chain continuity and event/gap behavior
  are the problem. Low nominal price compresses strike granularity and makes
  diagonal construction fragile.
- STRATEGY MODE + PARAMETERS: If tested at all, use BCD or defined-risk debit
  spreads rather than PMCC. Require earnings blackout and higher liquidity
  thresholds.
- ROTATION RULE: Only eligible when price > 75, LEAP coverage exists, and
  median OI/spread gates pass. Otherwise they can enter the BCD universe, not
  the PMCC universe.
- WFA RISK: Zero-trade windows, earnings gaps, meme-vol regime shifts, and
  survivorship bias.
- EFFECT-SIZE GUESS: High upside in recent windows, poor reliability under WFA.
  Park as "later", not first wave.

## PUSHBACK

1. The +0.30 Sharpe target may be the wrong bar for research triage. It is
   right for sealed adoption under global N=106, but before 2026-10-20 the goal
   should be to identify orthogonal candidates and loss-reducing gates. A
   strategy with flat Sharpe but materially lower QQQ correlation could still be
   valuable after the dsrM reset.

2. "Multi-ticker" should not automatically mean "more trades." With options,
   more symbols often means more earnings jumps, more liquidity cliffs, and more
   hidden multiple testing. The first expansion should be a small, boring,
   liquidity-first universe.

3. Sector ETFs are not obviously a Sharpe upgrade. They are cleaner and more
   robust, but lower single-name event risk comes with lower IV and often lower
   payoff convexity. Test them for portfolio diversification, not because they
   are expected to beat QQQ.

4. PMCC rotation may conflict with PMCC mechanics. PMCC wants slow ownership of
   high-quality trend plus recurring call sales. Fast rotation turns it into
   long-call momentum with extra slippage. If the user wants nimbleness, BCD is
   probably the better rotation vehicle.

5. Be careful with macro gates. Rates, dollar, and credit signals make strong
   narratives, but price trend and realized-vol filters may already capture the
   useful part. Macro should be a second-stage attribution-driven test.

## SEQUENCING - research order before 2026-10-20

1. Loss attribution first: for BCD QQQ and PMCC QQQ, tag every historical trade
   by trend state, IV/HV bin, RV shock, CPI/FOMC proximity, earnings proximity
   where relevant, and breadth proxy. Do not run broad sweeps yet.

2. Test one predeclared QQQ anchor gate package:
   - QQQ > 100d EMA
   - SPY > 200d EMA
   - no new entries for 5 sessions after 2.0x RV shock
   - no new BCD entries on CPI/FOMC day and prior session
   Compare to sealed anchors on WFA and holdout, but park result regardless of
   pass/fail until dsrM refresh.

3. Build liquidity eligibility tables for the 30-name universe:
   - underlying price history
   - median OI and spread width near target deltas
   - available DTE coverage for 30-60, 240-360
   - earnings calendar coverage
   This should eliminate weak PMCC candidates before simulation.

4. Run mega-cap BCD rotation with one rule only:
   - eligible if price/liquidity/trend/event gates pass
   - rank by 126d return minus 21d return, risk-adjusted by 63d vol
   - hold top 3
   Do not sweep top-N, lookback, deltas, and exits simultaneously.

5. Run sector ETF BCD rotation as a portfolio diversification study:
   - top 2 by 126d risk-adjusted RS
   - sector > 100d EMA and SPY > 200d EMA
   - compare correlated drawdown and daily MtM vs QQQ BCD, not only Sharpe.

6. Only after BCD rotation results are understood, run large-cap PMCC rotation.
   Use slow monthly/quarterly rebalance and strict chain coverage filters.
   Treat it as a concentration-reduction candidate, not the most likely Sharpe
   winner.

7. Last, test a small hedge sleeve with bearish debit spreads only as a
   portfolio overlay. Judge it by drawdown offset during anchor stress, not by
   standalone Sharpe.

Bottom line: the most credible path is not "find another QQQ but better." It is
to preserve the F1 anchors, add structural gates that reduce bad-regime entries,
and research a small liquidity-first rotation sleeve whose value is lower
concentration and better drawdown behavior. The likely first parked shortlist is:
QQQ trend/RV/event gate, mega-cap BCD rotation, sector ETF BCD rotation, large-cap
PMCC rotation, and a small bearish debit-spread hedge overlay.
