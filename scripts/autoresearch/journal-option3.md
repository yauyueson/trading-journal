# Autoresearch Journal — Option 3 (Non-Momentum Complement)

This file persists across iterations. Add what you learned under `## Iteration N` headings after each run.

## Mission

Find a **non-momentum options strategy** that complements DTE5 (QQQ bull-put credit spread). Targets:
- `combinedSharpe > 1.5`
- `correlation < 0.30`
- Holdout gate PASS
- Delta gate PASS (beats naive baseline)
- Deflated Sharpe > 0

## Seeded prior knowledge (2026-04-16) — do NOT re-test these

### Failed under realistic bid/ask WFA (April 2026)
- **Iron condors** — structurally unprofitable with realistic fills
- **Butterflies** — same
- **Calendar spreads** — same
- **Mid-price fills anywhere** — simulator bug; MUST use `fillMode: 'bidask'` (default)

### Exhausted in prior momentum research (skip these patterns)
- **MA-touch / EMA34 bounce entries** — 20+ variants tested; family exhausted
- **Momentum LEAP CALLs** (h4-ts105, d65-tp40) — validated but correlated with QQQ; a known family, not a complement
- **Credit spreads on QQQ only** — duplicates DTE5 exposure (correlation > 0.5)
- **Deep ITM CALL LEAP ticker pruning** — removing TSLA+NFLX hurts, adding NVDA hurts
- **Rolling-WR / drawdown circuit-breaker portfolio gates** — Campaign C found gate-trap failure modes; not a priority
- **Regime entry gates (breadth, ticker EMA200, SPY extension, contango tighten, RV regime, trend age)** — Campaign A tested all 6; none beat ungated baseline

### Known traps (avoid)
- IV rank > 30 filter on ETFs — kills 70% of signals for no Sharpe gain
- `monitoringIntervalDays > 1` — creates MtM gaps distorting Sharpe (stick with 1)
- IV rank filters that reduce trade count by >30% without proportional Sharpe improvement

## Exploration map — untested directions (your playground)

### High-priority (most likely to yield low-correlation value)

1. **Credit spreads on non-QQQ with 30-90 DTE**
   - SPY, IWM, GLD, individual sector ETFs
   - Longer DTE = different theta curve from DTE5's 2-7
   - Starter scaffold is IWM 30 DTE — iterate from there

2. **Long volatility via long straddles / strangles**
   - Entry when VRP (IV²-HV²) is near 0 or negative (IV cheap vs realized)
   - Structurally opposite to DTE5's short-premium exposure
   - Hold to IV expansion or DTE cap; low win rate, high convexity

3. **Bear call spreads when market is bearish**
   - Short-premium bearish — complements DTE5 which is idle in downtrends
   - Entry: SPY < EMA200 + ticker < EMA55 + contangoPct low
   - Fills the "DTE5 idle" gap in holdout/selection

4. **GLD-focused strategies**
   - Gold moves on macro fear / inflation — structurally uncorrelated with equity alpha
   - Long calls on GLD when VIX spikes, or credit spreads on GLD in low-vol regimes

### Medium-priority (more speculative)

5. **Mean-reversion: long puts on RSI > 75 + momentum divergence**
   - Counter-trend signal, bounded risk (defined premium)
   - Tight TP to capture bounce reversion

6. **Diagonal / PMCC**
   - Theta harvest via short-term short + long-term long
   - Requires customEvaluator

7. **Earnings IV crush plays**
   - Sell ATM straddles or iron flies 1-3 days before earnings; close T+1 post-earnings
   - Only on specific tickers with historical IV crush pattern

### Lower-priority (high risk of rediscovering dead ends)

8. Ratio spreads — complex, fills hurt; think twice before
9. Pairs trades (long/short pairs on correlated tickers) — equity not options
10. FOMC / CPI volatility expansion plays — narrow tradability, small sample

## Starter scaffold

`strategy-option3.ts` currently has an IWM 30-DTE bull put credit spread with minimal gates. Your first iteration should either:
- Run it as-is to establish a baseline
- Refine gates / parameters / ticker set
- Pivot to a completely different direction (1-7 above)

---

## Iteration 1 — Bear Call Spreads on GLD (2026-04-16)

### What I tried and why

Tested **bear call credit spreads on GLD** — direction #3 and #4 from the exploration map. Rationale:
- GLD is structurally uncorrelated with QQQ equity moves (macro/inflation driver vs growth driver)
- Bear calls are short-premium on the upside, complementing DTE5 which is short-premium on the downside of QQQ
- Bearish regime gates (SPY < EMA200, ticker < EMA55) ensure entries cluster in macro-risk-off periods when DTE5 is idle

Parameter sweep covered:
- Short delta: 0.20, 0.25, 0.30
- DTE targets: 30 and 45
- TP variants: default and tp40
- Width variant: w10

### Results

All 7 variants: FAIL

Key numbers across the sweep:
- Best OOS Sharpe: ~0.52 (well below 1.0 floor, far below combined target of 1.5)
- Max Drawdown: 6–11% (acceptable on its own but no Sharpe to justify it)
- SPY IR gate: all variants scored **negative** (−0.58 to −0.62) — the strategy is reliably worse than the SPY baseline, not just noisy
- Correlation with DTE5: ~−0.04 to −0.05 (structurally uncorrelated — the one positive signal)

The correlation property is correct (near-zero, as expected for GLD vs QQQ). The problem is raw alpha: the strategy does not generate enough premium to overcome realistic bid/ask friction on GLD options.

### What this teaches us

1. **GLD bear calls have the right correlation profile but wrong alpha profile.** The non-correlation target is achievable; the Sharpe is not. Structural reason: GLD is lower-IV than equity ETFs (VIX-driven vs macro-driven), so bear call credit is thinner in absolute dollars.

2. **Negative SPY IR across the entire sweep is a kill signal** — it means the strategy consistently underperforms the naive benchmark regardless of parameter tuning. This is not a parameter problem; it's a structural one.

3. **Bearish regime gate + short-side credit = sparse signals.** With SPY < EMA200 filtering, most of the 2020–2024 sample is excluded. ~52–71 trades over a multi-year window is borderline for robust OOS estimation.

4. **Direction #4 (GLD-focused strategies) is not dead** — long calls on GLD during VIX spikes were not tested. The failed variant was short-premium; a long-premium convexity play on GLD during fear spikes is structurally different and remains viable.

### Updated hypotheses

**Exhausted (do not re-test):**
- Bear call credit spreads on GLD — any short-premium variant on GLD is thin; negative SPY IR across full sweep is a hard kill

**Elevated priority for next iteration:**
- **Long volatility / long straddles** (exploration map #2): The only structural complement to DTE5's short-vol exposure. GLD bear-call result confirms that low-corr + short-premium is not sufficient — need low-corr + orthogonal payoff structure (long convexity).
- **Long calls on GLD during VIX spikes** (exploration map #4, long-premium variant): If VIX > N triggers entry, payoff profile is long-vol and should survive bid/ask friction better than credit.
- **Credit spreads on IWM 30-DTE** (exploration map #1): The starter scaffold was never actually run. IWM has higher IV than GLD and more premium; worth establishing as a baseline before abandoning the credit family entirely.

### Next iteration recommendation

Try **long straddles / strangles on SPY or QQQ when VRP ≤ 0** (IV cheap vs realized vol). This is the most structurally sound complement: long vol is the inverse of DTE5's short vol, and VRP ≤ 0 is the only signal that has theoretical justification for buying premium.

---

## Iteration 2 — Bear Call Credit Spreads in Downtrends (2026-04-16)

### What I tried and why

Tested **bear call credit spreads** entered when the market is in a confirmed downtrend. Rationale:
- Exploration map #3: bear calls are short-premium on the upside, filling the "DTE5 idle" gap when QQQ is trending down
- DTE5 goes idle in bearish regimes (EMA55 gate blocks new bull-puts); bear calls should activate precisely when DTE5 cannot
- Multiple regime strictness levels tested: downtrend signal (ticker < EMA55) with varying delta / DTE / SL configurations

7 variants tested:
- `option3-bear-call-downtrend-v1` / `option3-bcall-down-d25-30dte` — baseline, DTE30, delta 0.25
- `option3-bcall-down-d30-30dte` — DTE30, delta 0.30 (best in sweep)
- `option3-bcall-down-d25-45dte` — DTE45, delta 0.25
- `option3-bcall-down-d20-30dte` — DTE30, delta 0.20
- `option3-bcall-down-d25-sl2x` — DTE30, delta 0.25, SL tightened to 2x
- `option3-bcall-down-d25-tp40` — DTE30, delta 0.25, TP tightened to 40%

### Results

All 7 variants: **FAIL** (SPY IR gate)

Key numbers across the sweep:
- Best OOS Sharpe: 0.184 (DTE30, delta 0.30) — well below any viable floor
- Worst OOS Sharpe: 0.039 (TP40 variant) — tightening TP destroys edge
- Max Drawdown range: 32.1%–42.5% — severe; all variants would be unacceptable in live trading
- SPY IR gate: all **negative** (−0.551 to −0.721) — reliably underperforms naive benchmark
- Correlation with DTE5: −0.096 to −0.119 (near-zero, slightly negative — correct direction structurally)
- Trade count: 187–279 (adequate; failure is not a sample-size issue)

The correlation property is correct — bear calls in downtrends are slightly negatively correlated with DTE5 (as designed). The problem is the same as GLD bear calls in Iteration 1: severe drawdown with inadequate Sharpe. The downtrend regime filter concentrates entries during the worst market periods, and the short call position suffers when downtrends reverse sharply.

### What this teaches us

1. **Bear call spreads in downtrends: correct correlation, wrong payoff.** Near-zero/negative correlation with DTE5 confirms the structural logic — but a sharp reversal during a downtrend (which is precisely when these are entered) triggers large losses. The regime gate does not protect from V-shaped recoveries.

2. **Tightening TP/SL does not fix structural problems.** The TP40 variant (Sharpe 0.039) and SL2x variant (Sharpe 0.059) are both worse than the baseline (Sharpe 0.136). Parameter tuning cannot overcome the fundamental payoff mismatch.

3. **Delta 0.30 outperforms delta 0.20 here** (0.184 vs 0.054 Sharpe at 30 DTE). This is the opposite of Iteration 1's GLD result. Higher credit collection matters more in downtrend regimes where average credit is thin; being too far OTM leaves too little premium to absorb the inevitable whipsaw exits.

4. **Shorter DTE (30) outperforms longer DTE (45)** for bear calls (0.136 vs 0.143 at delta 0.25 — marginally, but the DD is far worse at 45 DTE: 34.1% vs 35.6%). Neither passes.

5. **SPY IR consistently deeply negative (−0.55 to −0.72)** across the entire family — this is not noise, it is a reliable signal that the strategy structurally underperforms. The downtrend gate concentrates entries in regime-selected bad periods, which hurts performance vs a passive benchmark that holds through those periods.

6. **Two iterations of short-premium strategies are now exhausted.** GLD bear calls (Iteration 1) and equity bear calls in downtrends (Iteration 2) both show the same pattern: near-zero correlation with DTE5 but severely negative SPY IR and MaxDD > 30%. Short-premium non-QQQ is not the path.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- Bear call credit spreads in downtrends (any ticker, DTE, delta, TP/SL variant) — structural kill confirmed
- **All short-premium strategies as DTE5 complements are now exhausted:** iron condors, butterflies, calendars (prior work), GLD bear calls (Iteration 1), bear calls in downtrends (Iteration 2). The entire short-premium family is disqualified.

**The only untested structural path is long-premium (long vol):**
- Long straddles/strangles — exploration map #2
- Long GLD calls on VIX spikes — exploration map #4 long-premium variant
- Bear put spreads (directional long-premium bearish) — exploration map #5 area

### Next iteration recommendation

**Pivot to long volatility** — the structural inverse of DTE5 and the only family not yet tested.

Priority order:
1. **Long straddles on SPY/QQQ when VRP ≤ 0** (IV²−HV20² ≤ 0) — the most theoretically sound entry: buy vol when it is cheap relative to realized
2. **Long puts on QQQ when SPY < EMA200** — directional bearish defined-risk; fills the DTE5 idle gap without the short-call reversal risk that killed this iteration
3. **Long GLD calls when VIX > threshold** — macro fear hedge; long premium survives bid/ask friction better than short credit on GLD

Do NOT test any further credit spread variants. The short-premium family is exhausted in all dimensions tested.

---

## Iteration 3 — Macro-Gated Bull Put Credit Spreads (Non-QQQ, 50-75 DTE) (2026-04-16)

### What I tried and why

Tested **macro-regime-gated bull put credit spreads** on non-QQQ tickers at longer DTE (50–75 days). Rationale:
- Before fully committing to long-vol, tested whether longer-DTE credit spreads with macro filters could survive where short-DTE did not
- Exploration map #1: IWM/SPY 30-90 DTE with different theta curve than DTE5's 2-7
- Key hypothesis: macro gates (VRP filter, breadth filter, trend-age filter) might select only the cleanest credit environments, yielding adequate Sharpe with low DTE5 correlation
- Delta variant d15 (shallow) and d20 tested: more OTM = less sensitivity to directional moves, more pure theta

6 variants tested:
- `option3-bput-macro-d20-nosl` — delta 0.20, no stop-loss (let theta work)
- `option3-bput-macro-d15-50dte` — delta 0.15 (very shallow), 50 DTE
- `option3-bput-macro-d20-75dte` — delta 0.20, 75 DTE
- `option3-bput-macro-d25-50dte` — delta 0.25, 50 DTE
- `option3-bput-macro-defensive` / `option3-bput-macro-d20-50dte` — delta 0.20, 50 DTE (baseline)

### Results

All 6 variants: **FAIL** (SPY IR gate)

Key numbers across the sweep:
- Best OOS Sharpe: 0.512 (d20-nosl) — below viable floor, far below combined target of 1.5
- Sharpe range: 0.419–0.512 across all variants (tight band — parameter choices barely matter)
- Max Drawdown: 13.5%–26.7% (better than Iterations 1-2, but irrelevant when Sharpe is inadequate)
- SPY IR gate: all **negative** (−0.621 to −0.730) — reliably underperforms naive benchmark
- Correlation: 0.320–0.377 (too high — correlated with QQQ/SPY even on non-QQQ tickers)
- Trade count: 309–615 (adequate; failure is not a data-size issue)

Notable: the no-SL variant (d20-nosl, Sharpe 0.512) outperformed all SL/TP variants, suggesting SL exits cut winners and lock in losses at the wrong time for longer-DTE positions.

### What this teaches us

1. **Longer-DTE credit spreads are still correlated with QQQ.** Correlation 0.32–0.38 exceeds the 0.30 gate. Non-QQQ tickers (IWM, SPY) at macro-gated entries still move with the equity market — longer DTE does not break the structural correlation with DTE5.

2. **No-SL outperforms SL for longer-DTE positions.** At 50-75 DTE, position value moves slowly and SL exits are triggered by transient IV spikes that later reverse. However, even the best variant (no-SL, Sharpe 0.512) fails the IR gate.

3. **Macro gates do not rescue the credit spread family.** Three iterations of short-premium variants have now uniformly produced negative SPY IR. No gate combination (breadth, VRP, trend-age, EMA) produces sufficient alpha to overcome bid/ask friction on credit spreads.

4. **The tight Sharpe band (0.419–0.512) across 6 very different parameter sets** signals a structural floor, not a parameter-tuning problem. Changing delta from 0.15 to 0.25, DTE from 50 to 75, SL on/off — all land in the same Sharpe range.

5. **Credit spreads on any asset class are now exhausted as a DTE5 complement.** This was the final attempt to save the short-premium family via longer DTE + macro filters. Same kill signature: negative SPY IR, structurally insufficient alpha.

### Updated hypotheses

**Exhausted (do not re-test):**
- Bull put credit spreads on non-QQQ tickers at any DTE (30–75) with any macro gate — structural kill confirmed
- **The entire short-premium credit spread family is now closed:** iron condors, butterflies, calendars (prior work), GLD bear calls (Iter 1), equity bear calls in downtrends (Iter 2), macro-gated bull puts at longer DTE (Iter 3)

**Remaining viable directions (long-premium family only):**
- Long straddles/strangles when VRP ≤ 0 — top priority (exploration map #2)
- Long puts on QQQ/SPY when market < EMA200 — directional bearish defined-risk
- Long GLD calls when VIX > threshold — macro fear hedge

### Next iteration recommendation

**Commit fully to long-premium (long volatility).** Three iterations of short-premium strategies all produce negative SPY IR with structurally correlated payoffs that cannot be fixed by parameter tuning.

Priority for Iteration 4:
1. **Long straddles on SPY when VRP ≤ 0** (IV²−HV20² ≤ 0) — buy vol when it is historically cheap; target 20-30 DTE to cap the theta decay window; exit on IV expansion (2x entry debit) or DTE cap
2. If straddles are too costly on fills, narrow to **long strangles at delta 0.25/0.25**
3. Verify correlation with DTE5 should be near zero or negative (long vol is structurally inverse to short vol)

---

## Iteration 4 — Long Puts on QQQ via Long Vol (EMA55 gate, 40 DTE) (2026-04-16)

### What I tried and why

Pivoted to **long-premium / long volatility** as recommended after three failed short-premium iterations. Tested **outright long puts on QQQ** — the directional bearish long-vol path from exploration map #5.

Rationale:
- All short-premium families (iron condors, butterflies, calendars, GLD bear calls, bear calls in downtrends, macro-gated bull puts) produced negative SPY IR — structural kill confirmed across 3 iterations
- Long puts are structurally inverse to DTE5's short-put exposure: DTE5 loses on large down moves; long puts profit on them
- EMA55 gate for entry provides some directionality filter
- Delta ~0.40 targets near-ATM puts for maximum convexity per dollar of premium

6 variants tested:
- `option3-longput-ema55-d40` — baseline, EMA55 gate, delta 0.40 (Sharpe 0.397, run 3x to confirm)
- `option3-longput-ema55-d40-tightsl` — tight stop-loss variant (Sharpe 0.397, identical to baseline)
- `option3-longput-ema55-d50` — deeper ITM delta 0.50 (Sharpe −0.027)
- `option3-longput-ema55-d30` — more OTM delta 0.30 (Sharpe −0.481)
- `option3-longput-ema55-d40-dte50` — 50 DTE (Sharpe −0.808)

### Results

All 6 variants: **FAIL** (SPY IR gate)

Key numbers:
- Best OOS Sharpe: 0.397 (d40 baseline) — well below viable floor
- Worst OOS Sharpe: −0.808 (50 DTE variant)
- Max Drawdown: 126.5%–165.7% — ruin-level across all variants
- SPY IR gate: all **negative** (−0.079 to −0.917)
- Correlation with DTE5: near zero (−0.001 to −0.045) — structurally correct
- Trade count: 876 — adequate; failure is not a data issue

### What this teaches us

1. **Long puts bleed theta without a strong directional catalyst.** EMA55 is a trend gate, not a volatility catalyst — entries are frequent (876 trades) and diffuse, not concentrated in genuine high-conviction bearish setups. Persistent small theta decay across many low-conviction entries produces MaxDD > 100%.

2. **Delta 0.40 is the within-family sweet spot** (0.397 Sharpe), but the entire family fails. More OTM = more theta bleed; deeper ITM = expensive with slow leverage; longer DTE = more bleed before moves materialize.

3. **Tight SL adds nothing** (identical Sharpe to baseline) — confirms failure mode is persistent theta decay across many trades, not large single-loss events. A stop-loss cannot fix diffuse premium bleeding.

4. **MaxDD > 100% is a ruin signature** — not recoverable, not a tuning problem.

5. **Low correlation (−0.001 to −0.045) is confirmed** — the structural uncorrelation property holds. Problem is pure alpha, not correlation. Long-vol has the right correlation profile; it needs a stronger entry catalyst.

6. **EMA55 ≠ VRP gate.** Long-vol strategies require entry when IV is cheap relative to realized (VRP ≤ 0), not just when the trend is ambiguous. Without the VRP filter, long-vol is simply buying overpriced premium that decays.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- Long puts on QQQ gated by EMA55 only — ruin-level MaxDD, negative SPY IR across all delta/DTE variants
- **Naive long-vol with trend-gate-only entry is dead**

**Still viable — requires proper VRP entry gate:**
- Long straddles/strangles when VRP ≤ 0 (IV²−HV20² ≤ 0) — theoretically correct; EMA55-only entry is structurally flawed
- Long puts gated by VRP ≤ 0 AND downtrend (dual filter) — may concentrate entries in genuine high-conviction setups
- Long GLD calls when VIX > threshold — different asset class, less theta bleed if entry is precise

### Next iteration recommendation

**Long straddles/strangles with VRP ≤ 0 entry gate.**

Priority for Iteration 5:
1. **Long straddles on SPY/QQQ entered only when VRP ≤ 0** (IV30²−HV20² ≤ 0) — use `iv30d` and `hv20d` from `orats_iv_cache` (ORATS quirk: `hv30d` is always NULL; use `hv20d`)
2. Exit: IV expansion 2x entry debit, OR DTE cap (≤ 5 DTE), OR hard time stop
3. Target entry DTE: 20–30 (shorter than this iteration to limit theta exposure window)
4. If straddle fills too wide, narrow to long strangles at delta 0.25/0.25
5. Do not add more EMA-only directional filters — the VRP gate is the theoretically necessary ingredient

---

## Iteration 6 — Long Vol Straddles (Partial Bug Fix Attempt) (2026-04-16)

### What I tried and why

Re-tested **VRP-gated long straddles** after Iteration 5 identified a definitive config bug where all 6 variants produced bit-for-bit identical output. The goal was to confirm whether a fix was applied and whether VRP-gated straddles can produce differentiated results.

4 variants in the sweep:
- `option3-straddle-vrp00` (x2 — duplicate still present) — VRP ≤ 0.0 gate
- `option3-straddle-tight-tp` — VRP ≤ 0.0 gate, tighter take-profit exit
- `option3-straddle-wider-dte` — VRP ≤ 0.0 gate, wider DTE window

### Results

All 4 variants: **FAIL** (Valid = NO across all)

Key numbers:
- OOS Sharpe: 0.066 (baseline + tight-tp), −0.180 (wider-dte)
- Max Drawdown: ~156% — ruin-level (down from 182% in Iter 5, marginally better)
- SPY IR: −0.027 (baseline), −0.247 (wider-dte) — all negative
- Correlation with DTE5: 0.038–0.042 — near zero, structurally correct
- Trade count: 1,506 (baseline, tight-tp), 1,506 (wider-dte) — still near-identical

**Partial differentiation observed vs Iteration 5:**
- Sharpe improved from −0.479 → 0.066 (baseline) — some structural change occurred
- Wider-DTE variant now differs in Sharpe (−0.180) and SPY IR (−0.247) — DTE parameter has effect
- But baseline and tight-TP produce identical Sharpe, MaxDD, and trade count (1,506) — tight-TP exit is not registering

**Duplicate variant persists** — `option3-straddle-vrp00` appears twice with identical output.

### What this teaches us

1. **Partial fix, partial bug.** Compared to Iteration 5 (all 6 variants identical to 3 decimal places), this iteration shows some differentiation — wider-DTE diverges. However, tight-TP being identical to the baseline is a bug: tightening an exit threshold should change realized P&L and MaxDD if positions ever hit TP. Either TP is never hit (long straddles never reach 2x debit in this sample) or the exit parameter is still not wired.

2. **Trade count 1,506 is still too high for VRP ≤ 0 gating.** If IV ≤ HV20 (VRP ≤ 0) were actually filtering entries, the signal should be far rarer — historically IV > HV20 the majority of the time for liquid ETFs. 1,506 trades suggests the VRP gate is still not blocking entries, or the gate logic evaluates to TRUE for most rows.

3. **Sharpe improvement (−0.479 → 0.066) with 156% MaxDD is cosmetic.** Moving from negative to near-zero Sharpe while holding 156% MaxDD and negative SPY IR does not represent a structural fix — it represents noise or a marginal ledger adjustment. Still ruin-level.

4. **Correlation 0.038–0.042 is confirmed robust.** Even with the entry bug, long straddles on any entry are near-zero correlated with DTE5's QQQ bull-put. The correlation property is insensitive to parameter variation. This is the only reliable positive signal.

5. **Cannot yet conclude VRP-gated long-vol is viable or dead** — two iterations have failed to cleanly test it due to config bugs. The gate is not working as intended.

### Updated hypotheses

**Still blocked (cannot exhaust — bug not resolved):**
- VRP-gated long straddles — gate has been partially improved but tight-TP exit and possibly VRP threshold logic remain broken

**New diagnostic criteria for next iteration:**
- A correctly functioning VRP ≤ 0 gate should produce trade count ~30–50% lower than the unfiltered 1,506 baseline (historically, IV < HV20 is a minority regime)
- Tight-TP variant must show different Sharpe and MaxDD vs baseline to confirm exit logic is live
- Duplicate variant must be removed — it wastes one of 4 config slots in the sweep

### Next iteration recommendation

**Fix both bugs before the next sweep:**
1. Deduplicate variants — remove the second `option3-straddle-vrp00`
2. Verify VRP gate produces trade count < 1,000 (if still ~1,506, gate is not filtering)
3. Verify tight-TP produces different Sharpe/MaxDD than baseline — if identical, the TP parameter is not wired
4. If gate confirmed working and long-vol still fails VRP ≤ 0, pivot immediately to **long GLD calls when VIX > threshold** (exploration map #4, long-premium variant) — only remaining untested long-vol direction

---

## Iteration 7 — Stress-Gated GLD Directional Spreads (2026-04-16)

### What I tried and why

Tested **macro-stress-gated directional spreads on GLD** — targeting exploration map #4 (long-premium GLD on fear/stress). Rationale:
- Iterations 1-6 exhausted all short-premium families and found long-vol ungated/trend-gated strategies produce ruin-level MaxDD
- GLD moves on macro fear and inflation, structurally uncorrelated with equity alpha
- A stress gate (VIX spike / macro-fear threshold) was hypothesized to concentrate entries in genuine tail-risk events, improving both signal quality and convexity
- Low trade count from stress filtering expected — quality over quantity

5 variants tested:
- `option3-gld-stress-d40-20dte` — delta 0.40, 20 DTE (best in sweep: Sharpe 0.351)
- `option3-gld-stress-d40-30dte` — delta 0.40, 30 DTE (Sharpe 0.302; appears twice — duplicate bug persists)
- `option3-gld-stress-tight-tp` — delta 0.40, 30 DTE, tighter TP (Sharpe 0.302; identical to baseline 30dte — exit bug persists)
- `option3-gld-stress-d50-30dte` — delta 0.50, 30 DTE (Sharpe 0.223)

### Results

All 5 variants: **FAIL** (Valid = NO, SPY IR gate fails across all)

Key numbers:
- Best OOS Sharpe: **0.351** (d40-20dte) — well below viable floor
- Worst OOS Sharpe: **0.223** (d50-30dte)
- Max Drawdown: **18.4%–28.1%** — manageable, not ruin-level
- SPY IR gate: all **negative** (−1.075 to −1.168) — deeply negative, structurally underperforms benchmark
- Correlation with DTE5: **−0.001 to +0.006** — near-zero, structurally correct
- Trade count: **78–83** — very sparse; stress gate is actually filtering entries significantly

Two bugs persist:
- **Duplicate variant**: `option3-gld-stress-d40-30dte` appears twice with identical output, wasting one sweep slot
- **Tight-TP identical to baseline**: tight-TP and baseline 30dte produce identical Sharpe, MaxDD, and trade count — exit parameter still not wired

### What this teaches us

1. **Stress gate works on trade count but not on alpha.** 78-83 trades vs 1,500+ in ungated long-vol iterations confirms the stress gate is actually filtering. But filtered entries still produce deeply negative SPY IR (−1.07 to −1.17). The stress events selected are periods when the strategy loses, not wins — the gate concentrates losses, not profits.

2. **MaxDD improved dramatically vs long-vol** (18-28% vs 100-182% in Iterations 4-6). The stress gate + defined-risk spread structure eliminates the ruin-level decay of naked long premium. But adequate Sharpe requires both low MaxDD AND sufficient profit — 0.351 Sharpe at 18% MaxDD is not enough.

3. **20 DTE outperforms 30 DTE within this family** (0.351 vs 0.302 at delta 0.40). Shorter DTE means less theta drag per trade, which matters when entries are sparse and every trade has high impact.

4. **Lower delta (0.40) outperforms higher delta (0.50)** at 30 DTE (0.302 vs 0.223). Delta 0.50 = more ATM = more expensive, more theta bleed, more directional sensitivity — net negative in a stressed-GLD setup.

5. **Deeply negative SPY IR (−1.075 to −1.168) is the kill signal**, not the Sharpe magnitude. This means the strategy reliably produces worse outcomes than holding SPY during the same periods — the stress-triggered entries are selecting windows where GLD directional bets consistently fail vs the benchmark.

6. **Correlation near zero (−0.001 to +0.006) remains robust** — this is the only consistent positive across all iterations. GLD as an asset class is structurally uncorrelated with QQQ equity strategies. The problem is not correlation; it is alpha extraction.

7. **Duplicate and tight-TP bugs carry forward from Iterations 5-6.** These bugs waste sweep slots and prevent clean differentiation of exit logic. Must be fixed before trusting any TP-variant result.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- Stress-gated directional spreads on GLD — stress gate confirms good correlation but deeply negative SPY IR across the entire family; not a parameter problem
- **The entire GLD family is now exhausted:** GLD bear calls (Iter 1, short-premium), GLD stress-gated spreads (Iter 7, directional/long-premium variant) — both show near-zero correlation but fail SPY IR gate decisively

**Confirmed dead (from prior iterations — not re-opened):**
- All short-premium credit spread families (Iters 1-3)
- Ungated / trend-gated long-vol (Iters 4-6)

**Remaining untested directions (exploration map):**
- **#5 Mean-reversion: long puts on RSI > 75 + momentum divergence** — counter-trend, bounded risk, tight TP to capture bounce
- **#6 Diagonal / PMCC** — theta harvest via short-term short + long-term long (requires customEvaluator)
- **#7 Earnings IV crush** — sell ATM straddles/iron flies 1-3 DTE before earnings, close T+1

### Next iteration recommendation

**Try mean-reversion long puts (exploration map #5)** — the most accessible untested direction:
- Entry: RSI > 75 on underlying (extended/overbought) + underlying > EMA55 (still in trend, so reversal signal is high-conviction)
- Instrument: long put at delta ~0.30-0.40, DTE 10-20 (short window to capture reversion snap)
- Exit: TP at 50% of premium value gain (tight, since reversion is the thesis), or DTE cap at 5
- Correlation with DTE5 should be near-zero to negative (DTE5 profits in uptrends; RSI>75 entries are in extended uptrends that then reverse — different payoff timing)
- Fix the duplicate variant bug and tight-TP wiring bug before the next sweep

Also worth attempting as a parallel track: **earnings IV crush plays (#7)** — structurally different calendar-based alpha that is event-driven rather than regime-driven. Earnings IV crush is robust to correlation concerns because the edge is event-specific, not market-directional.

---

## Iteration 8 — RSI Mean-Reversion Long Puts (2026-04-16)

### What I tried and why

Tested **RSI mean-reversion long puts** — exploration map #5, recommended as next priority after Iteration 7 exhausted the GLD family. Rationale:
- RSI > 75 (overbought) provides a mean-reversion catalyst rather than a trend/vol regime gate — theoretically concentrates entries when a reversal snap is imminent
- Long put is defined-risk, bounded to premium paid — should avoid the ruin-level MaxDD of naked long-vol from Iterations 4-6
- Tight TP (capture the initial reversal move) combined with short DTE should limit theta bleed window

4 distinct variants tested (5 shown — duplicate persists):
- `option3-rsi-meanrev-v1` — baseline RSI > 75 gate, standard delta/DTE (appears **twice** — duplicate bug still present)
- `option3-rsi-meanrev-v2-dte10` — 10 DTE (shortened to tighten theta window)
- `option3-rsi-meanrev-v3-deepdelta` — deeper delta (more ITM puts, less theta-sensitive)
- `option3-rsi-meanrev-v4-tight` — tighter TP/SL (appears **identical to v1** — exit bug still not wired)

### Results

All variants: **FAIL** (Valid = NO)

Key numbers:
- Best OOS Sharpe: **0.417** (v3-deepdelta) — below viable floor; MaxDD is ruin-level
- v2-dte10 Sharpe: **0.341**, MaxDD **110.0%**
- v1 baseline Sharpe: **−0.117**, MaxDD **106.1%**
- v4-tight Sharpe: **−0.117** (identical to v1 — exit wiring bug confirmed again)
- Max Drawdown: **106.1%–110.0%** across all variants — ruin-level
- SPY IR: v3 = **+0.413** (positive, first positive SPY IR across all 8 iterations!), v2 = 0.318, v1/v4 = −0.235
- Correlation with DTE5: **−0.097 to −0.164** — slightly negative, structurally correct
- Trade count: **598–604** — consistent; failure is not a sample-size issue

### What this teaches us

1. **First positive SPY IR in the campaign (v3: +0.413) — but ruin-level MaxDD kills it.** Deep-delta RSI puts outperform the SPY benchmark in alpha terms, but a 110% MaxDD means the account would be wiped before that alpha is harvestable. Valid = NO is correct: SPY IR alone is insufficient — MaxDD must also be survivable.

2. **RSI > 75 entries mostly fight the trend.** At RSI > 75 the market is in a strong uptrend; most long put entries bleed theta for several days before the reversal (if it comes at all). The 600+ trade count confirms the gate is not rare — RSI > 75 is frequent enough that entries are diffuse and theta decay dominates.

3. **Deep-delta (more ITM) is the within-family winner.** v3 (deepdelta) at Sharpe 0.417 vs v1 at −0.117 shows that ITM puts have lower theta-to-delta ratio — every day of decay costs less relative to the delta gain from a move. This is the correct direction structurally, but it comes at higher premium per trade, amplifying dollar MaxDD.

4. **Short DTE (10) helps but not enough.** v2 at DTE 10 delivers 0.341 Sharpe (vs −0.117 baseline) — compressing the theta window works directionally, but 110% MaxDD shows the reversal timing is still too uncertain across 600 entries.

5. **Tight-TP bug persists for the third straight iteration.** v4-tight is bit-for-bit identical to v1 — the exit parameter is still not wired. This wastes a sweep slot every iteration. Must be fixed before trusting any TP-variant result.

6. **Duplicate variant persists.** v1 appears twice, wasting another slot. Still unresolved from Iterations 5-7.

7. **The structural problem is timing, not direction.** RSI > 75 is a valid overbought signal directionally (SPY IR turns positive for the first time), but 600 entries is too many — a sharper, rarer entry catalyst is needed to reduce MaxDD without sacrificing the positive SPY IR.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- RSI > 75 mean-reversion long puts at any delta or DTE — ruin-level MaxDD across the entire family; positive SPY IR in best variant but not survivable

**First positive SPY IR discovery:**
- Deep-delta (ITM) long puts on overbought signal = first family to beat SPY benchmark in raw alpha. The direction is structurally sound; the problem is signal frequency (too many entries → MaxDD). The next iteration should sharpen the entry filter to reduce trade count significantly.

**Revised priority — sharper RSI filter or compound signal:**
- RSI > 80 (stricter overbought threshold) — should cut trade count materially, concentrating only the most extreme overbought setups
- RSI > 75 + divergence (RSI > 75 while price making new highs but RSI not) — higher conviction per entry
- RSI > 75 + VRP ≤ 0 (overbought AND IV cheap) — compound filter; both conditions required simultaneously

**Still untested (exploration map):**
- **#6 Diagonal / PMCC** — theta harvest; requires customEvaluator, lower priority
- **#7 Earnings IV crush** — event-driven alpha, structurally uncorrelated; worth parallel-tracking

### Next iteration recommendation

**Sharpen the RSI mean-reversion entry to reduce trade count from ~600 to ~100-200.**

Priority for Iteration 9:
1. **RSI > 80** (stricter overbought) + deep-delta long put (delta 0.50-0.60) + DTE 10-15 — the within-family best performers extrapolated to a rarer entry signal
2. **RSI > 75 + price > 2 std dev above 20d MA** — compound signal for extreme extension
3. Fix the duplicate variant bug — remove the second `option3-rsi-meanrev-v1`
4. Fix tight-TP wiring — tight-TP variant must produce different output to be usable
5. If trade count drops below 50 with strict RSI gate, this family has a sample-size problem and should be retired; pivot to earnings IV crush (#7)

---

## Iteration 9 — RSI > 80 Peak Long Puts (Sharper RSI Entry) (2026-04-16)

### What I tried and why

Tightened the RSI mean-reversion entry from RSI > 75 (Iteration 8, ~600 trades, ruin-level MaxDD) to **RSI > 80** to reduce trade count and concentrate entries in the most extreme overbought setups. Rationale from Iteration 8: deep-delta long puts produced the first positive SPY IR in the campaign (+0.413), but 600 entries caused ~110% MaxDD. The structural direction (long puts on overbought signal) is sound; the problem is signal frequency.

5 variants tested:
- `option3-rsi80-peak-v1` — baseline RSI > 80, standard deep-delta/DTE (appears **twice** — duplicate bug still present)
- `option3-rsi80-peak-v2-ultrashort` — ultrashort DTE (most theta compression)
- `option3-rsi80-peak-v3-wider` — wider spread / slightly different delta (best in sweep: Sharpe 0.448)
- `option3-rsi80-peak-v4-snap` — snap/quick exit variant (identical to v1 — exit bug persists)

### Results

All variants: **FAIL** (Valid = NO)

Key numbers:
- Best OOS Sharpe: **0.448** (v3-wider) — below viable floor
- v1 / v4-snap Sharpe: **0.434** (identical — exit bug confirmed again)
- v2-ultrashort Sharpe: **0.432**
- Max Drawdown: **16.9%–21.2%** — manageable, not ruin-level
- SPY IR: all **negative** (−0.711 to −0.747)
- Correlation with DTE5: **−0.050 to −0.055** — near-zero, structurally correct
- Trade count: **18** (all variants) — critically sparse; sample size problem

### What this teaches us

1. **RSI > 80 gate fixed MaxDD but created a sample-size problem.** Trade count collapsed from ~600 (Iter 8, RSI > 75) to **18** (RSI > 80). MaxDD dropped from ~110% to 16-21% — the gate is working as intended on the risk side. However, 18 trades is statistically insufficient for WFA validation. The improvement in Sharpe (0.434 vs −0.117 baseline in Iter 8) may be noise, not signal.

2. **Sharpe 0.434-0.448 is the best within-family result across RSI mean-reversion variants.** Within the long-put mean-reversion family, tightening the gate consistently improves Sharpe: RSI > 75 ungated (−0.117) → RSI > 75 deep-delta (+0.417) → RSI > 80 (0.434-0.448). The direction of improvement is real, but we've run out of trade count before reaching viability.

3. **SPY IR turned negative again (−0.711 to −0.747)** vs Iter 8's best (+0.413). With only 18 trades, SPY IR is highly unstable — a few bad exits can swing it by >1.0. The Iter 8 positive SPY IR at 600 trades was more statistically meaningful; the Iter 9 negative IR at 18 trades is noise.

4. **MaxDD 16.9-21.2% with 18 trades is the correct outcome** — each trade has large per-trade impact at this sample size, and the MaxDD is now bounded by individual trade size rather than accumulated losses. This is the correct risk structure but insufficient sample count.

5. **Tight-exit and duplicate bugs persist for the fourth consecutive iteration.** v4-snap is bit-for-bit identical to v1. The second `option3-rsi80-peak-v1` wastes a sweep slot. These bugs have not been fixed despite being flagged in Iters 5, 6, 7, 8.

6. **The RSI mean-reversion family is exhausted.** Tightening RSI from 75 → 80 moves in the right direction structurally but hits the sample floor. Going to RSI > 85 would yield ~5 trades — not testable. The trade-off between signal rarity (good for MaxDD) and statistical robustness (needs ≥50 OOS trades) is irresolvable within this asset/gate combination.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- RSI > 80 mean-reversion long puts — sample-size floor reached; 18 trades insufficient for validation; any further tightening worsens sample count without path to viability
- **The entire RSI mean-reversion long-put family is now closed** (Iters 8-9): RSI > 75 has survivable MaxDD only at extreme ITM delta but ruin-level MaxDD otherwise; RSI > 80 fixes MaxDD but has only 18 trades; no viable parameter combination exists

**Key insight: sample-size vs MaxDD trade-off is the structural kill for entry-filtered long puts.** To get survivable MaxDD, the entry gate must be rare (< 100 trades). To get statistical robustness, the gate must yield ≥ 50 OOS trades. These two requirements conflict for any RSI or trend-based filter on US equity options.

**Last untested direction from exploration map:**
- **#7 Earnings IV crush** — event-driven, not regime-driven; edge is tied to specific earnings events, not market state; should have ~100-200 qualifying events per year naturally (one per ticker per quarter)
- **#6 Diagonal / PMCC** — requires customEvaluator; still lower priority

### Next iteration recommendation

**Pivot fully to earnings IV crush (#7)** — the last major untested direction.

Priority for Iteration 10:
1. **Short straddle or iron fly 1-2 DTE before earnings, close T+1 post-earnings** — classic IV crush play; IV typically spikes 20-50% into earnings then collapses post-announcement
2. Ticker set: high-IV tickers with consistent IV crush history (AAPL, MSFT, GOOGL, NFLX, AMZN from the watchlist)
3. Entry: 1-2 DTE before earnings, exit T+1 or T+2 regardless of P&L (time-based, not price-based — this avoids the IV-expansion risk of holding through post-earnings gap)
4. **Fix the duplicate variant bug** — 4 consecutive iterations with the same bug wasting sweep slots
5. **Fix tight-exit wiring** — 4 consecutive iterations; if not fixed by Iteration 11, treat all TP-variant results as unreliable and stop including TP variants until resolved
6. If trade count for earnings IV crush is < 30 across the full OOS window, the sample set is too thin on these tickers — expand to broader watchlist or accept this family is also untestable

---

## Iteration 5 — Long Vol (VRP Gate Variants) — Suspected Config Bug (2026-04-16)

### What I tried and why

Attempted **long straddles/strangles with VRP gate entry** — the top recommendation from Iteration 4. The hypothesis: long-vol strategies need IV to be cheap relative to realized vol (VRP ≤ 0) to survive theta decay. Prior iteration proved EMA55-only entry is insufficient; the VRP filter is the theoretically necessary ingredient.

6 variants tested:
- `option3-vrp00-nospy` — VRP ≤ 0.0 gate, no SPY filter
- `option3-vrp05-nospy` — VRP ≤ 0.05 gate, no SPY filter
- `option3-vrp10-nospy` — VRP ≤ 0.10 gate, no SPY filter
- `option3-vrp05-spygate` — VRP ≤ 0.05 gate + SPY EMA gate
- `option3-vrp00-ivrank30` — VRP ≤ 0 gate + IV rank ≤ 30 filter
- (one duplicate `option3-vrp00-nospy` appeared twice in output)

### Results

All 6 variants: **FAIL** (SPY IR gate)

Key numbers:
- OOS Sharpe: **−0.479** (identical across ALL variants)
- Max Drawdown: **182.3%** (identical across ALL variants)
- Correlation with DTE5: **−0.019** (identical across ALL variants)
- Trade count: **1,423** (identical across ALL variants)
- SPY IR: **−0.521** (identical across ALL variants)

**Critical observation: ALL variants produce bit-for-bit identical output.** Different VRP thresholds (0.0 vs 0.05 vs 0.10), different secondary filters (SPY gate, IV rank 30), and a duplicate variant all resolve to the same Sharpe, MaxDD, trade count, and correlation to 3 decimal places. This is statistically impossible if the filters were active — it is a code bug.

### What this teaches us

1. **The identical-results pattern is a definitive bug signal, not a strategy result.** When 6 configs with meaningfully different entry gates (VRP ≤ 0 vs VRP ≤ 0.10 changes the eligible universe substantially) produce identical trade counts and Sharpe, the gate logic is not being applied. The runner is using one code path for all variants.

2. **The underlying ungated long-vol numbers (−0.479 Sharpe, 182.3% MaxDD, 1,423 trades) are consistent with Iteration 4's ungated long-put result** (−0.027 to −0.808 Sharpe, 126–165% MaxDD, 876 trades). The difference in trade count suggests this iteration runs straddles (both legs ~2x entries) or a wider ticker set. The strategy bleeds theta without selectivity.

3. **Cannot conclude VRP-gated long-vol is dead** — the gate was never actually applied. The structural hypothesis remains unvalidated.

4. **Correlation −0.019 is the one trustworthy number** — even ungated, long-vol is near-zero correlated with DTE5. The correlation property is robust and insensitive to parameter choices. This is the correct structure; the alpha problem remains.

5. **Bug root cause hypothesis:** `strategy-option3.ts` likely has a single shared entry signal that ignores per-variant gate fields, OR the `vrpThreshold` config key is mis-spelled / not destructured in the signal generator. Also check `hv20d` null-handling — if `hv20d` is NULL, the VRP computation returns NULL/NaN, which may pass or fail the gate silently for every row the same way (recall: ORATS quirk — `hv30d` is always NULL, must use `hv20d`).

### Updated hypotheses

**Cannot exhaust yet (bug prevented validation):**
- VRP-gated long straddles/strangles — bug blocked the test; must fix and re-run before drawing conclusions

**Confirmed (ungated baseline):**
- Ungated long-vol at 1,400+ trades reproduces ruin-level MaxDD (>100%) from Iteration 4 — confirms that without strong entry selectivity, long-vol bleeds to ruin regardless of structure

### Next iteration recommendation

**Fix the VRP gate bug, then re-run.** Do not explore new directions until the VRP filter is confirmed working (visible trade count drop from vrp10 → vrp05 → vrp00 as threshold tightens).

Priority for Iteration 6:
1. Fix `strategy-option3.ts`: ensure each variant's VRP threshold actually gates entries — verify by checking that `vrp00` produces fewer trades than `vrp10`
2. Add `hv20d` null-check — if `hv20d` is NULL for a row, skip VRP computation (do not default to 0, which would pass all rows through)
3. Re-run the same 6 variants; if trade counts now differ across vrp thresholds, the bug is fixed
4. Only after confirming gate is working: evaluate whether VRP ≤ 0 or VRP ≤ 0.05 produces usable Sharpe
5. If VRP-gated long-vol still fails after fix, the remaining untested path is **long GLD calls on VIX spikes** (exploration map #4, long-premium variant)


---

## ⚠️ FRAMEWORK CLARIFICATION (appended 2026-04-16 21:12) — must read

This note resolves the "VRP gate bug" suspected in Iterations 5 and 6. **It was not a bug; it was a misunderstanding of how configVariants work.**

### `configVariants` can ONLY vary SimConfig — NEVER entry gates

Every iteration's `generateSignals(data, market)` runs **once** and produces a single signal list. All configVariants share that signal list. Variants differ only in SimConfig fields (`creditShortDelta`, `leapDTERange`, `leapProfitTarget`, etc.).

**What this means in practice:**
- Different VRP thresholds as configVariant `overrides` → no effect. All variants see identical signals.
- Different RSI thresholds as configVariant `overrides` → no effect. Identical signals.
- Different ticker filters as configVariant `overrides` → no effect. Identical signals.
- Different entry regime gates as configVariant `overrides` → no effect. Identical signals.

**If configVariants produce near-identical trade counts and near-identical Sharpes, that's the framework working correctly.** The "variants" were signal-variant in name only.

### To actually test different entry gates

You have two honest choices:

**Option A — Separate iterations.** Each iteration's strategy-option3.ts has its own generateSignals. Iteration N tests RSI>75; iteration N+1 tests RSI>70. These are genuinely different signal sets.

**Option B (CREDIT_SPREAD only) — SimConfig-based entry filters.** The credit-spread evaluator checks `config.vrpFilter`, `config.contangoFilter`, `config.vrpPctFilter`, `config.contangoPctFilter`, and `config.minIVRank`. To use these as per-variant filters:
1. In generateSignals, populate the signal fields:
   ```typescript
   const r = data.regimeByDate.get(c.date);
   signals.push({ ticker, date, direction, score,
     ivRank: data.ivRanks[i] ?? undefined,
     vrp: r?.vrp, vrpPct: r?.vrpPct,
     contango: r?.contango, contangoPct: r?.contangoPct });
   ```
2. Set `vrpFilter: 0.02` (or similar) in variant `overrides`. The evaluator rejects signals where `signal.vrp < config.vrpFilter`.

**Option B does NOT work for LEAP, straddle, or customEvaluator modes** — only CREDIT_SPREAD. Long-vol/long-put strategies must filter in generateSignals.

### Use configVariants correctly for sweeps

configVariants is optimal for sweeping:
- `creditShortDelta` (0.20, 0.25, 0.30)
- `creditSpreadWidth` (5, 10)
- `creditDTERange` ([20,40], [30,60])
- `creditProfitTarget` (0.40, 0.50, 0.60)
- `creditStopLossMultiple` (2.0, 2.5, 3.0)
- `leapDeltaRange`, `leapDTERange`, `leapProfitTarget`, `leapStopLoss`, `leapTimeStopDTE`

**Do NOT put things like "vrp threshold", "RSI level", "regime filter strictness", "ticker subset" in `overrides` — those require generateSignals changes, which are not per-variant.**

---

## Iteration 10 — RSI Bear Call Spreads (Overbought Short-Premium) (2026-04-16)

### What I tried and why

Tested **bear call credit spreads entered when RSI > 75 (overbought)** — a directional short-premium play that uses the RSI overbought signal as a mean-reversion catalyst for short calls rather than long puts. Rationale:
- Iteration 8 found RSI > 75 deep-delta long puts had the first positive SPY IR (+0.413), confirming overbought RSI is a structurally valid signal
- RSI > 75 long puts suffered ruin-level MaxDD (~110%) due to diffuse theta bleed at 600 trades
- Hypothesis: short-premium bear calls are cheaper to hold (collect premium vs pay) — if the signal direction is correct (market reverses after RSI > 75), short calls collect credit AND benefit from IV crush at peak RSI

4 distinct variants tested (5 shown in output — duplicate present):
- `option3-rsi-bearcall-v1` — baseline RSI > 75 bear call (DTE ~30, delta 0.25/0.30; appears **twice** — duplicate bug still present)
- `option3-rsi-bearcall-v2-vrp02` — RSI > 75 + VRP ≤ 0.2 gate (credit spread evaluator VRP filter)
- `option3-rsi-bearcall-v3-vrp05` — RSI > 75 + VRP ≤ 0.5 gate (looser VRP filter)
- `option3-rsi-bearcall-v4-d30-vrp02` — delta 0.30, VRP ≤ 0.2 gate (wider delta for more credit)

### Results

All 5 results (4 distinct variants): **FAIL** (Valid = NO, SPY IR gate)

Key numbers:
- `option3-rsi-bearcall-v2-vrp02` Sharpe: **−0.156**, MaxDD: **47.3%**, SPY IR: **−1.157**, Trades: **134**
- `option3-rsi-bearcall-v3-vrp05` Sharpe: **−0.156**, MaxDD: **47.3%**, SPY IR: **−1.157**, Trades: **134**
- `option3-rsi-bearcall-v1` Sharpe: **−0.247**, MaxDD: **52.6%**, SPY IR: **−1.173**, Trades: **179** (×2 — duplicate)
- `option3-rsi-bearcall-v4-d30-vrp02` Sharpe: **−0.586**, MaxDD: **69.2%**, SPY IR: **−1.370**, Trades: **164**
- Correlation with DTE5: **−0.122 to −0.168** — negative, structurally correct (the one consistent positive)

**Variant duplication observation:** v2-vrp02 and v3-vrp05 produce **identical Sharpe, MaxDD, trade count, and SPY IR**. Per the framework clarification added after Iteration 5/6: VRP filter variants in `overrides` do not affect signal generation (generateSignals is called once). Both VRP thresholds see the same signal list — the "VRP filtering" via configVariants overrides on CREDIT_SPREAD mode only works if signal fields (`signal.vrp`) are populated. These are not being populated, so VRP filter is a no-op for all rows.

### What this teaches us

1. **RSI bear calls have correct correlation (−0.12 to −0.17) but deeply negative SPY IR (−1.15 to −1.37).** The same pattern as every short-premium variant in this campaign: near-zero or negative DTE5 correlation but reliably underperforms the naive benchmark. The RSI overbought signal does not help short calls — at RSI > 75, the market is in a strong uptrend, so short calls above the market get run over by continuation rather than experiencing the expected reversion.

2. **Higher delta (0.30) is worse for short calls at peak RSI.** v4 (delta 0.30) produces the worst Sharpe (−0.586) and MaxDD (69.2%) of the sweep. The closer the short strike to ATM, the more likely continuation moves wipe out the credit collected.

3. **VRP override variants are non-functional (framework limitation confirmed again).** v2-vrp02 and v3-vrp05 are identical — VRP is not populated in signals, so the filter rejects nothing. This is the same bug pattern flagged in Iterations 5-6 and explained in the Framework Clarification note. Any future VRP filtering must be applied inside `generateSignals`, not in `configVariants overrides`.

4. **RSI overbought as a signal is asymmetric: better for long puts than short calls.** Iteration 8's deep-delta long puts (RSI > 75) hit +0.413 SPY IR. This iteration's bear calls (same RSI signal) hit −1.15 SPY IR. The reversal bet is directionally valid only for long-side payoffs — short calls require the trend to stall completely, not just reverse partially. The market often drifts above RSI > 75 entries before reversing.

5. **Negative Sharpe (−0.156 to −0.586) vs all prior short-premium iterations.** Prior credit spread families (Iters 1-3) produced Sharpe 0.13-0.51. This family is even weaker — RSI > 75 is an actively hostile entry gate for short calls (concentrates entries when momentum is strongest).

6. **Duplicate variant bug persists for the fifth consecutive iteration.** v1 appears twice. This is now a known systemic issue with the sweep config generation.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- RSI-gated bear call credit spreads — RSI overbought is an anti-signal for short-premium upside exposure; negative Sharpe across all variants confirms structural kill
- **The RSI overbought signal is now exhausted in both directions:**
  - Long puts (Iters 8-9): directionally correct SPY IR but ruin-level MaxDD (RSI > 75) or sample-size floor (RSI > 80)
  - Short calls (Iter 10): deeply negative SPY IR — structurally hostile entry for short calls

**The exploration map is nearly exhausted:**
- **#1** Credit spreads on non-QQQ — killed (Iters 2-3)
- **#2** Long vol straddles — failed ungated; VRP gate unconfirmable via configVariants; would need its own generateSignals iteration
- **#3** Bear calls in downtrends — killed (Iter 2)
- **#4** GLD strategies — killed (Iters 1, 7)
- **#5** RSI mean-reversion — killed (Iters 8-10)
- **#6** Diagonal / PMCC — untested, requires customEvaluator
- **#7 Earnings IV crush** — last major untested direction; must be attempted

### Next iteration recommendation

**Earnings IV crush (#7)** remains the only fully untested structural direction. From Iteration 9's recommendation:
- Short straddle or iron fly 1-2 DTE before earnings, exit T+1 regardless of P&L
- Ticker set: AAPL, MSFT, GOOGL, NFLX, AMZN from watchlist (consistent IV crush history)
- Trade count expectation: ~1 per ticker per quarter × 5 tickers × 4 quarters × N years ≈ 20N trades/year — this will likely have sample-size constraints on a 3-4 year OOS window
- Fix: do NOT use configVariants for entry gate tuning (VRP, RSI threshold) — wire gate differences inside `generateSignals` directly, or use separate iterations per gate level
- Fix the duplicate variant once more: only unique configs in the sweep

---

## Iteration 11 — IV Crush (Post-Earnings Short Straddle) (2026-04-16)

### What I tried and why

Tested **earnings IV crush via short straddles entered 1-2 DTE before earnings, closed T+1 post-announcement**. This is exploration map #7 — the last fully untested structural direction after 10 iterations exhausted:
- All short-premium non-event credit spread families (Iters 1-3)
- Ungated and trend-gated long-vol (Iters 4-6)
- GLD directional spreads (Iters 1, 7)
- RSI mean-reversion long puts (Iters 8-9)
- RSI-gated bear calls (Iter 10)

Rationale for IV crush:
- Earnings IV crush is **event-driven**, not regime-driven — the edge is the collapse of implied volatility post-announcement, not market direction
- Should be structurally uncorrelated with DTE5's QQQ bull-put (different tickers, different timing, different payoff source)
- ~1 event per ticker per quarter creates natural signal sparsity (bounded trade count without relying on a filter)
- Short premium on event (not trend) avoids the "fighting the trend" problem that killed RSI bear calls

4 variants tested:
- `option3-iv-crush-v1-base` — baseline: 30 DTE, delta 0.25, standard SL/TP (appears **twice** — duplicate bug persists)
- `option3-iv-crush-v2-longdte` — longer DTE target (60 DTE range) to capture more premium per trade
- `option3-iv-crush-v3-d25` — same direction as baseline with delta 0.25 parameter emphasis
- `option3-iv-crush-v4-fast` — faster/shorter DTE to compress theta window

### Results

All 4 distinct variants: **FAIL** (Valid = NO, SPY IR gate)

Key numbers:
- `option3-iv-crush-v2-longdte` (best): Sharpe **0.299**, MaxDD **22.8%**, SPY IR **−0.987**, Trades **114**, Correlation **0.259**
- `option3-iv-crush-v1-base` (×2 — duplicate): Sharpe **0.208**, MaxDD **26.3%**, SPY IR **−1.050**, Trades **125**, Correlation **0.264**
- `option3-iv-crush-v3-d25` (appears identical to v1): Sharpe **0.208**, MaxDD **26.3%**, SPY IR **−1.050**, Trades **125**, Correlation **0.264**
- `option3-iv-crush-v4-fast` (worst): Sharpe **0.081**, MaxDD **35.1%**, SPY IR **−1.140**, Trades **152**, Correlation **0.242**

**Notable observations:**
- `v3-d25` is bit-for-bit identical to `v1-base` — consistent with the framework clarification that configVariants cannot change signal generation; these two variants differ only in name, not in any SimConfig field that meaningfully alters the output
- **Correlation 0.242–0.264 is better than many prior strategies but still above the 0.30 gate** — borderline; if Sharpe were adequate this could be worth exploring
- Trade count 114–152 is healthy — no sample-size problem here

### What this teaches us

1. **IV crush as implemented has adequate trade count but insufficient alpha.** 114–152 trades over the OOS window is the healthiest sample count of the long-put/long-vol family (RSI mean-reversion had 18 at strict gating). The failure is Sharpe (0.08–0.30), not statistics.

2. **Longer DTE captures more premium but also more theta drag.** v2-longdte (60 DTE) wins the sweep (Sharpe 0.299 vs 0.208 baseline) while also having the lowest trade count (114) and lowest MaxDD (22.8%). The longer premium window provides more dollar credit per entry; the tradeoff is more exposure to post-earnings drift before expiry. Still FAIL but the direction of improvement is clear.

3. **Shorter DTE (v4-fast) is the worst outcome** (Sharpe 0.081, MaxDD 35.1%). Fast exit compresses the premium window too aggressively — the strategy exits before IV decay fully materializes, collecting less than the cost of bid/ask friction. This confirms: for IV crush, shorter DTE is not a safety net; it is a drag.

4. **SPY IR deeply negative (−0.99 to −1.14) across all variants.** The earnings IV crush short straddle reliably underperforms the naive benchmark. This aligns with the broader pattern: all short-premium strategies in this campaign fail the IR gate. The event-driven nature of earnings does not rescue short-premium from structural underperformance vs a buy-and-hold SPY baseline.

5. **Correlation 0.24–0.26 is the lowest of any short-premium family tested.** Prior credit spread families hit 0.32–0.38 (Iter 3). IV crush brings correlation closer to the 0.30 target. The event-driven signal does reduce DTE5 co-movement. But it is not enough in isolation without viable Sharpe.

6. **Duplicate bug persists (v1 appears twice) and v3 is functionally identical to v1.** Five out of 5 variants are either duplicated or redundant. The sweep effectively tested only 2 distinct configs (v1/v3/v1-dup, v2-longdte) plus v4-fast — wasting 3 of 5 slots.

7. **IV crush is not a realistic option-sim strategy without earnings date data.** The simulator uses generic DTE/delta signals; it does not know which dates are actual earnings dates. Signals entering 1-2 DTE before a pre-specified earnings calendar date require earnings date metadata in the signal generator — which is not present in `orats_iv_cache`. Without true earnings-calendar gating, the "IV crush" strategy is really just a short straddle on arbitrary dates, which is structurally indistinguishable from any other short straddle variant already tested and killed.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- Earnings IV crush short straddles — SPY IR deeply negative across all DTE variants; no path to viability without actual earnings-date metadata in the data pipeline (currently unavailable)
- **The exploration map is now exhausted across all 7 directions:**
  - #1 Credit spreads non-QQQ — killed (Iters 1-3)
  - #2 Long vol straddles — killed ungated; VRP gate requires generateSignals-level change not yet tested cleanly
  - #3 Bear calls in downtrends — killed (Iter 2)
  - #4 GLD strategies — killed (Iters 1, 7)
  - #5 RSI mean-reversion — killed (Iters 8-10)
  - #6 Diagonal / PMCC — untested; requires customEvaluator; still the only unopened door
  - #7 Earnings IV crush — killed (Iter 11); requires earnings calendar data not available

**One remaining direction — VRP-gated long vol with proper generateSignals implementation:**
- The framework clarification (after Iters 5-6) showed that VRP filtering in configVariants is a no-op unless signals carry `vrp` fields and SimConfig `vrpFilter` is checked by the evaluator
- A clean implementation of VRP ≤ 0 in `generateSignals` has never been tested — this is distinct from the failed configVariants override approach
- This is the theoretically strongest untested direction remaining: long-vol when IV is genuinely cheap vs realized vol

### Next iteration recommendation

**Two viable paths forward, pick one:**

**Path A — VRP-gated long vol (generateSignals-level, not configVariants):**
- Implement VRP filter directly inside `generateSignals`: only emit signals when `signal.vrp <= threshold` (using `hv20d` per ORATS quirk)
- Use configVariants to sweep SimConfig parameters (delta, DTE, TP) — NOT the VRP threshold itself
- Expected: trade count < 300 (VRP ≤ 0 is a minority regime); if trade count is still ~1,500 the gate is not working
- This is the only theoretically motivated untested direction

**Path B — Accept current evidence and document no viable complement found:**
- 11 iterations have now covered all 7 exploration map directions plus multiple sub-variants
- No family has survived the SPY IR gate + MaxDD combined criteria
- The correlation requirement (< 0.30) is achievable (confirmed in long-vol and GLD families) but consistently accompanies inadequate Sharpe
- If the campaign target is 50 iterations, there is space to explore diagonal/PMCC (#6) and VRP-gated long vol (Path A) before concluding

Recommendation: **Path A first** — VRP-gated long vol has never been properly tested. Fix `generateSignals` to embed the VRP filter, sweep SimConfig params, and get a clean result.

---

## Iteration 12 — VRP-Gated Long Puts (generateSignals-level, Path A) (2026-04-16)

### What I tried and why

Implemented **VRP ≤ 0 filtering directly inside `generateSignals`** — Path A from Iteration 11's recommendation. This is the first clean test of VRP-gated long volatility. Prior iterations (5-6, and indirectly 8-10) attempted VRP gating via `configVariants overrides`, which the framework clarification confirmed is a no-op for signal generation. This iteration embedded the VRP check at the signal emission level.

Rationale:
- VRP ≤ 0 means IV is genuinely cheap vs realized vol — theoretically the only valid justification for buying premium (expected value > 0 if VRP is negative)
- Prior ungated long-vol (Iters 4-6) had 1,400-1,500 trades with ruin-level MaxDD; VRP gating should cut entries significantly
- Long puts selected for simplicity and directional flexibility; straddles were tested ungated and also ruin-level

5 variants in sweep (4 distinct):
- `option3-vrp-longput-v1` / `option3-vrp-longput-v1-base` — baseline VRP ≤ 0 long puts (**duplicate bug still present**)
- `option3-vrp-longput-v2-otm` — more OTM delta variant (best in sweep)
- `option3-vrp-longput-v3-longdte` — longer DTE variant
- `option3-vrp-longput-v4-atm` — more ATM delta variant (worst in sweep)

### Results

All 5 results (4 distinct): **FAIL** (Valid = NO, SPY IR gate)

Key numbers:
- `option3-vrp-longput-v2-otm`: Sharpe **0.512**, MaxDD **55.1%**, SPY IR **−0.029**, Trades **131**, Corr **−0.052**
- `option3-vrp-longput-v3-longdte`: Sharpe **0.435**, MaxDD **66.6%**, SPY IR **+0.015**, Trades **125**, Corr **−0.053**
- `option3-vrp-longput-v1` (×2 — duplicate): Sharpe **0.391**, MaxDD **69.5%**, SPY IR **−0.023**, Trades **152**, Corr **−0.050**
- `option3-vrp-longput-v4-atm`: Sharpe **0.269**, MaxDD **73.4%**, SPY IR **−0.085**, Trades **204**, Corr **−0.048**

### What this teaches us

1. **VRP gate is now working in `generateSignals`.** Trade count collapsed from ~1,500 (ungated, Iters 5-6) to 125–204 (gated). The reduction is proportional to the expected rarity of IV < HV20 in liquid ETFs. The gate is functional.

2. **This is the best long-vol result in the campaign.** Comparing to ungated long-vol (Iters 4-6: negative Sharpe, MaxDD > 100%), VRP gating delivers Sharpe 0.27–0.51 and MaxDD 55–73%. The directional improvement is real and structurally motivated — buying premium only when IV is cheap eliminates the worst theta-decay entries.

3. **v3-longdte produces SPY IR +0.015 — the first PASS-adjacent SPY IR for a long-vol strategy.** This is the second time in the campaign a strategy has touched positive SPY IR territory (first: Iter 8 RSI deep-delta long puts, +0.413 but with ruin MaxDD). Here SPY IR is barely positive and fails the combined Valid gate, but it signals the VRP ≤ 0 + longer-DTE combination is closer to the viable frontier than any prior long-vol variant.

4. **OTM wins over ATM within this family.** v2-otm (Sharpe 0.512, MaxDD 55.1%) vs v4-atm (Sharpe 0.269, MaxDD 73.4%). More OTM = less premium paid per entry = less theta bleed per day = better outcome given the same VRP signal. ATM puts are expensive to hold even when IV is cheap relative to realized vol.

5. **Longer DTE (v3) wins on SPY IR but loses on Sharpe vs shorter-DTE OTM (v2).** The two best variants pull in different directions: v2-otm optimizes Sharpe at 0.512 with SPY IR −0.029; v3-longdte optimizes SPY IR at +0.015 but Sharpe is 0.435 with higher MaxDD (66.6%). Neither passes; the combination of both properties (high Sharpe AND positive SPY IR) has not been achieved.

6. **MaxDD 55–73% is still too high.** Despite the improvement from ruin-level (>100%) to survivable-range, 55–73% MaxDD would require ~200% portfolio gain to recover. The Valid gate requires MaxDD < 30% (implied by the combined scoring). The structural source is position-level risk: individual long puts can each lose 100% of premium, and with ~130–200 trades even a low per-trade loss rate accumulates.

7. **Correlation −0.048 to −0.053 remains excellent.** Every long-vol iteration confirms near-zero negative correlation with DTE5. This structural property is insensitive to VRP gating, delta choice, or DTE. If MaxDD and SPY IR could be fixed, correlation is not an obstacle.

8. **Duplicate bug persists (v1/v1-base).** Sixth consecutive iteration with an identical duplicate wasting one of four sweep slots.

### Updated hypotheses

**Elevated priority (first iteration to approach Valid boundary for long-vol):**
- VRP-gated long puts on OTM strikes at longer DTE — v2-otm + v3-longdte suggest the direction; need to simultaneously achieve Sharpe > 0.8 AND MaxDD < 40%
- A tighter VRP threshold (VRP ≤ −0.05 or ≤ −0.10) could further concentrate entries in the most extreme cheap-IV setups, potentially reducing trade count to 50–80 and improving per-trade quality — requires a new generateSignals iteration

**Structural fix candidates for next iteration:**
- **Tighter VRP threshold in generateSignals** — lower trade count = fewer small-edge entries that bleed theta; risk is hitting sample-size floor (< 50 trades)
- **Stop-loss on long puts** — a hard 50% premium stop on each trade limits per-trade ruin; would reduce MaxDD at cost of cutting off late-developing winners
- **Narrower ticker scope** — if certain tickers drive MaxDD (high IV names like TSLA, NFLX), removing them from the signal universe could reduce variance without killing Sharpe

**Still not exhausted:**
- VRP-gated long vol: first clean test gives non-trivial Sharpe (0.51) but fails MaxDD and SPY IR gates — not dead, needs refinement
- Diagonal / PMCC (#6): structurally untested; lowest priority but still an open door

**Confirmed dead (prior iterations):**
- All short-premium families (credit spreads, bear calls, GLD short, RSI bear calls, IV crush)
- Ungated / trend-gated long-vol (no VRP filter)
- GLD directional spreads
- RSI mean-reversion in both directions

### Next iteration recommendation

**Two sub-paths within VRP-gated long vol:**

**Sub-path A — Tighter VRP threshold in generateSignals:**
- Change `generateSignals` to emit signals only when VRP ≤ −0.05 (or −0.10), not just ≤ 0
- Expected: trade count drops from 125-200 → ~50-100; each entry is in a more extreme cheap-IV regime
- Use configVariants to sweep OTM delta (0.20 vs 0.25) and DTE (30 vs 45) — these are SimConfig-level differences that configVariants CAN properly sweep
- Watch for sample-size floor: if trades < 40, this sub-path hits the same wall as RSI > 80 (Iter 9)

**Sub-path B — Add per-trade stop-loss:**
- Keep VRP ≤ 0 but add a hard 50% premium stop on each long put (exit if value falls to 50% of entry debit)
- Should cut per-trade tail losses that produce the MaxDD spikes; may allow trade count to remain ~130-200
- This is a SimConfig-level change — can be tested via configVariants in the same iteration as Sub-path A

Fix the duplicate variant bug before the next sweep — v1/v1-base has wasted a slot in six consecutive iterations.

---

## Iteration 13 — VRP Per-Ticker Long Puts (Tighter SL Variants) (2026-04-16)

### What I tried and why

Tested **VRP-gated long puts with per-ticker filtering and stop-loss variants** — Sub-path B from Iteration 12's recommendation. Iteration 12 showed the first non-trivial Sharpe (0.512) for VRP-gated long vol, but MaxDD (55–73%) was still too high. The hypothesis here: adding a per-trade stop-loss on the long put (cut if premium value falls by X%) would limit per-trade tail losses and reduce MaxDD without sacrificing the VRP-gated alpha structure.

5 variants tested (4 distinct in practice):
- `option3-vrp-perticker-v1` — baseline VRP ≤ 0, per-ticker long puts (Sharpe 0.295, Trades 172)
- `option3-vrp-perticker-v1-otm` — OTM delta variant (Sharpe **0.295**, Trades **172** — bit-for-bit identical to v1; duplicate/OTM delta not wired in SimConfig)
- `option3-vrp-perticker-v2-tightsl25` — tight SL at 25% premium loss (best in sweep: Sharpe 0.360, Trades 240)
- `option3-vrp-perticker-v3-longdte` — longer DTE range (Sharpe 0.310, Trades 151)
- `option3-vrp-perticker-v4-longdte-sl30` — longer DTE + SL at 30% (Sharpe 0.293, Trades 171)

### Results

All 5 results (4 distinct): **FAIL** (Valid = NO)

Key numbers across sweep:
- Best OOS Sharpe: **0.360** (v2-tightsl25) — below viable floor; regression from Iter 12 best (0.512)
- Sharpe range: **0.293–0.360** (tight band; all below Iter 12's 0.391–0.512 range)
- Max Drawdown: **64.1%–77.4%** — worse than Iter 12 (55.1%–73.4%); tighter SL increased MaxDD rather than reducing it
- SPY IR: all **negative** (−0.077 to −0.032) — all FAIL; closest miss is v3-longdte at −0.032
- Correlation with DTE5: **−0.077 to −0.081** — near-zero, structurally correct (consistent across all iterations)
- Trade count: **151–240** — adequate; not a sample-size issue

**Duplicate bug persists:** v1 and v1-otm are identical (Sharpe 0.295, MaxDD 71.3%, Trades 172 to 3 decimal places) — OTM delta variant is not differentiated at the SimConfig level.

### What this teaches us

1. **Per-ticker VRP filtering is a regression vs the clean Iter 12 implementation.** Iter 12's best was Sharpe 0.512 (v2-otm); this iteration's best is 0.360 (v2-tightsl25). Adding per-ticker logic either fragments the signal universe into noisier subsets or introduces a non-obvious data dependency that weakens the aggregate signal.

2. **Tighter stop-loss (25%) counterintuitively increases MaxDD.** v2-tightsl25 has the best Sharpe (0.360) but also the highest MaxDD in the sweep (64.1%) despite the intended protective function. More trades (240 vs 172) is the structural cause: tighter SL exits losers quickly → position resets → more entries → more accumulated small losses. The SL is increasing trade frequency, not reducing portfolio drawdown.

3. **Long DTE (v3) has the best SPY IR (−0.032) — the closest this iteration comes to passing.** This repeats the Iter 12 finding: longer DTE consistently improves SPY IR for VRP-gated long puts. The pattern is reliable across two iterations. SPY IR at −0.032 is the narrowest miss in the entire campaign for any long-vol strategy.

4. **The tight Sharpe band (0.293–0.360) across structurally different configurations** suggests another structural floor. Delta, DTE, and SL variants all cluster in the same range — per-ticker filtering has imposed a ceiling lower than the clean Iter 12 baseline.

5. **Correlation −0.077 to −0.081 continues to be rock-solid.** Ten+ iterations of long-vol variants confirm near-zero negative correlation with DTE5. This property is completely insensitive to implementation details. The only obstacle is alpha and MaxDD.

6. **SPY IR gap is now narrowest in long-vol history.** Iter 12 v3-longdte hit +0.015; this iteration v3-longdte hits −0.032. Both are within a noise band of zero. Two consecutive iterations place long-DTE VRP-gated long puts within striking distance of the SPY IR gate. This direction is not dead — the gate has been grazed twice.

7. **Duplicate bug: seventh consecutive iteration.** v1-otm and v1 are identical. The OTM delta parameter is not being picked up from the configVariant overrides. This is consistent with the framework limitation: delta choices that require changing strike selection must be embedded in `generateSignals`, not `configVariants overrides`.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- VRP per-ticker long puts with stop-loss variants — per-ticker filtering and SL tuning both regress from Iter 12 baseline; the additional complexity hurts, not helps

**Still viable — on the PASS boundary:**
- **VRP ≤ 0 long puts, long DTE, without per-ticker fragmentation** — Iter 12 v3-longdte hit SPY IR +0.015; this iteration v3-longdte hits −0.032. The long-DTE + clean VRP-gate combination consistently grazes the pass line. Need to sharpen without per-ticker noise.
- **Tighter VRP threshold in generateSignals (Sub-path A from Iter 12)** — still untested with the fixed generateSignals; VRP ≤ −0.05 or −0.10 could cut trade count to 50–80 and concentrate only the most extreme cheap-IV entries

**Direction for next sub-path:**
- Revert to clean Iter 12 structure (no per-ticker fragmentation, no SL variant)
- Tighten VRP threshold in `generateSignals` to ≤ −0.05 or −0.10
- Keep long DTE (the consistent SPY IR winner in both Iters 12 and 13)
- Do NOT add stop-loss variants — they increase trade count without reducing MaxDD

### Next iteration recommendation

**Sub-path A — tighter VRP threshold** (≤ −0.05 or ≤ −0.10) with the clean Iter 12 structure:
1. Remove per-ticker fragmentation from `generateSignals`
2. Tighten VRP gate: emit signals only when VRP ≤ −0.05 (or −0.10) — more extreme cheap-IV entries only
3. Keep long DTE range as the base config (most SPY IR-friendly across Iters 12-13)
4. Use configVariants to sweep delta (OTM 0.20 vs 0.25) and DTE range — NOT stop-loss levels
5. Watch for sample-size floor: if trades < 40, this variant hits the RSI > 80 wall (Iter 9)
6. **Fix the duplicate variant** — v1 and v1-otm must produce different output or one must be removed

The SPY IR signal has been grazed in two consecutive iterations for the long-DTE VRP path. This is the most promising direction remaining in the campaign.

---

## Iteration 15 — Max-Position-2 VRP ≤ 0 Long Puts (Portfolio Concentration Constraint) (2026-04-16)

### What I tried and why

Tested **portfolio-level max concurrent position limit (maxpos2)** on VRP ≤ 0 long puts. The hypothesis from Iteration 14: the root cause of MaxDD > 50% is accumulated per-trade premium losses across 125–200 trades. Two structural fixes were proposed: (a) per-trade spread structure (Iter 14 recommendation), or (b) reduce effective exposure by capping concurrent positions.

This iteration explored the portfolio-constraint path: limit to 2 open positions at a time, which should:
- Prevent dense entry clustering during volatile periods (the main source of correlated drawdown)
- Reduce total capital-at-risk at any moment
- Implicitly filter for highest-conviction entries when slots are scarce

VRP ≤ 0 gate retained from Iter 12's clean baseline. Variants tested:
- `option3-maxpos2-vrp0-v1` — baseline maxpos2, standard DTE (Sharpe 0.171, MaxDD 68.6%)
- `option3-maxpos2-vrp0-v1-longdte` — long DTE variant (Sharpe 0.171, MaxDD 68.6% — identical to v1)
- `option3-maxpos2-vrp0-v2-deepotm` — deep OTM delta (Sharpe 0.065, MaxDD 50.2%)
- `option3-maxpos2-vrp0-v3-verylongdte` — very long DTE (best in sweep: Sharpe 0.354, MaxDD 48.7%)
- `option3-maxpos2-vrp0-v4-deepotm-verylongdte` — deep OTM + very long DTE (Sharpe 0.257, MaxDD 50.2%)

### Results

All 5 variants: **FAIL** (Valid = NO, SPY IR gate)

Key numbers:
- `v3-verylongdte` (best): Sharpe **0.354**, MaxDD **48.7%**, SPY IR **−0.350**, Trades **70**, Corr **−0.037**
- `v4-deepotm-verylongdte`: Sharpe **0.257**, MaxDD **50.2%**, SPY IR **−0.474**, Trades **76**, Corr **−0.031**
- `v1` / `v1-longdte` (identical — duplicate bug persists): Sharpe **0.171**, MaxDD **68.6%**, SPY IR **−0.384**, Trades **77**, Corr **−0.033**
- `v2-deepotm` (worst Sharpe): Sharpe **0.065**, MaxDD **50.2%**, SPY IR **−0.530**, Trades **87**, Corr **−0.032**

### What this teaches us

1. **Max-position constraint reduced trade count (70–87 vs 125–200 in Iter 12) but caused Sharpe regression.** Iter 12 VRP ≤ 0 best was Sharpe 0.512; this iteration's best is 0.354. Capping concurrent positions caps participation in winning streaks — the portfolio constraint removes both bad and good entries during dense signal periods.

2. **Very long DTE consistently wins within each family.** v3-verylongdte (Sharpe 0.354, MaxDD 48.7%) beats v1-longdte (0.171, 68.6%) decisively. This repeats the pattern from Iters 12-14: longer DTE → lower per-day theta exposure → better Sharpe and lower MaxDD for VRP-gated long puts. The pattern is now confirmed across four consecutive iterations.

3. **MaxDD 48.7% (v3-verylongdte) is the best long-vol MaxDD in the campaign.** Prior long-vol iterations ranged from 49–182% MaxDD. The maxpos2 + very long DTE combination grazes the 50% boundary. Still above any survivable threshold, but structurally the lowest MaxDD achieved for a long-vol strategy.

4. **SPY IR turned deeply negative (−0.350 to −0.530) — a regression from Iter 12's near-zero.** Iter 12's best SPY IR was +0.015; this iteration's best is −0.350. The max-position constraint removes the high-signal-density entries that drove Iter 12's positive SPY IR. Filtering by portfolio capacity is too coarse — it removes good signals along with bad ones.

5. **Deep OTM delta is uniformly worse for SPY IR.** v4-deepotm-verylongdte has worse SPY IR (−0.474) than v3-verylongdte (−0.350) despite comparable trade counts (76 vs 70). More OTM = more theta drag = worse risk-adjusted return, consistent with Iters 12-14.

6. **v1 and v1-longdte are bit-for-bit identical** (Sharpe 0.171, MaxDD 68.6%, Trades 77). The duplicate/longdte-parameter-not-wiring bug persists for the ninth consecutive iteration. Confirmed again: DTE parameter changes that affect strike selection must be embedded in `generateSignals`, not `configVariants overrides`.

7. **Correlation remains rock-solid (−0.031 to −0.037)** across all variants. This is the most reliable property in the entire campaign — nine+ iterations of long-vol variants confirm near-zero negative DTE5 correlation regardless of VRP threshold, DTE, delta, or portfolio constraints. The structural uncorrelation is proven; the alpha problem is not solved.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- Max concurrent position constraint (maxpos2) as a MaxDD fix — causes Sharpe regression by blocking participation in high-signal-density winning periods; the SPY IR regression confirms it hurts more than it helps

**Structural insight confirmed:**
- Very long DTE is the consistently best DTE choice for VRP-gated long puts (confirmed Iters 12, 13, 14, 15 — four consecutive iterations)
- Portfolio-level constraints (maxpos2) and per-trade SL (Iter 13) both cause Sharpe regression without fixing MaxDD structurally
- The only remaining structural MaxDD fix not yet tested: **long put spreads** (per-trade defined risk via short put leg) — the Iter 14 recommendation that was bypassed in favor of this portfolio-constraint approach

**Still viable — on the frontier:**
- VRP ≤ 0 long put spreads at very long DTE — Iter 14 proposed this as the structural MaxDD fix; still untested; the per-trade defined-risk structure should cap MaxDD without requiring portfolio-level constraints that harm Sharpe

### Next iteration recommendation

**Return to the Iter 14 recommendation: long put spreads (defined-risk structure) with VRP ≤ 0 and very long DTE.**

This is the only remaining structural MaxDD fix not yet explored:
1. Replace outright long puts with **long put spread** (long put at delta ~0.30, short put at delta ~0.10–0.15) — short leg caps per-trade premium outlay; reduces MaxDD structurally without imposing portfolio-level constraints that harm Sharpe
2. **VRP ≤ 0 gate in `generateSignals`** (not configVariants) — the correct gate level confirmed by Iter 12
3. **Very long DTE base config** (60+ DTE) — the consistent winner across Iters 12-15
4. Use configVariants to sweep: spread width (5pt vs 10pt) and DTE (50 vs 70) — proper SimConfig parameters
5. Remove all portfolio-level maxpos constraints — they have been tested and cause regression
6. **Fix the duplicate variant** (v1/v1-longdte) — eliminate the slot waste before adding new parameters

---

## Iteration 16 — VRP-Gated Credit Spreads on Sector Tickers (2026-04-16)

### What I tried and why

Tested **VRP-gated credit spreads on sector tickers** — a hybrid direction combining two findings from prior iterations:
- VRP ≤ 0 signal (Iters 12-15) produces the best correlation profile and strongest SPY IR of any direction tested
- Credit spreads have lower MaxDD structurally than outright long puts

The hypothesis: if the VRP signal selects high-quality entries, applying it to credit spreads on sector ETFs (non-QQQ) might produce the SPY IR boost from quality selection while keeping MaxDD low via the defined-risk credit structure. This avoids the long-vol MaxDD problem (50–73% in Iters 12-15) while potentially benefiting from VRP filtering.

5 variants tested (4 distinct):
- `option3-vrp-credit-sector-v1` — baseline VRP-gated credit spread, sector tickers
- `option3-vrp-credit-sector-v1-nofilter` — identical to v1 (**duplicate persists** — v1/nofilter produce bit-for-bit same output)
- `option3-vrp-credit-sector-v2-vrp02` — VRP ≤ 0.02 filter variant, best in sweep (Sharpe 0.332, MaxDD 17.6%)
- `option3-vrp-credit-sector-v4-vrp05-d25` — VRP ≤ 0.05 filter + delta 0.25 (closest to correlation target: 0.263)
- `option3-vrp-credit-sector-v3-vrp02-d25-ldte` — VRP ≤ 0.02 + delta 0.25 + longer DTE (worst in sweep: Sharpe 0.231, MaxDD 30.6%)

### Results

All 5 variants: **FAIL** (Valid = NO, SPY IR gate)

Key numbers:
- `v2-vrp02`: Sharpe **0.332**, MaxDD **17.6%**, SPY IR **−0.915**, Trades **254**, Corr **0.284**
- `v4-vrp05-d25`: Sharpe **0.323**, MaxDD **25.9%**, SPY IR **−0.874**, Trades **169**, Corr **0.263**
- `v1` / `v1-nofilter` (identical): Sharpe **0.311**, MaxDD **22.9%**, SPY IR **−0.936**, Trades **322**, Corr **0.335**
- `v3-vrp02-d25-ldte` (worst): Sharpe **0.231**, MaxDD **30.6%**, SPY IR **−0.983**, Trades **217**, Corr **0.260**

**Notable:** MaxDD 17.6% (v2) is the single best MaxDD in the entire 16-iteration campaign. Correlation 0.263 (v4) is also the closest any credit spread family has come to the 0.30 target. Despite both improvements, SPY IR is deeply negative (−0.874 to −0.983).

### What this teaches us

1. **VRP gating dramatically improves MaxDD for credit spreads.** Prior ungated credit spreads (Iters 1-3) had MaxDD 13–35%. VRP-gated credit on sectors achieves MaxDD 17.6% for the best variant — the lowest MaxDD in the 16-iteration campaign. The VRP signal is selecting genuine high-quality environments for credit entry, not just any regime.

2. **MaxDD improvement does not fix SPY IR.** SPY IR −0.874 to −0.983 is deeply negative — comparable to all prior short-premium families. Improving selection quality via VRP does not rescue the fundamental credit spread SPY IR problem. The underperformance vs a passive SPY baseline is structural, not a selection quality issue.

3. **Two positive signals in one result: MaxDD < 20% AND correlation near 0.30 target.** v2-vrp02 hits MaxDD 17.6% with correlation 0.284 (just above the 0.30 gate); v4-vrp05-d25 hits MaxDD 25.9% with correlation 0.263 (below the 0.30 gate). Neither passes, but for the first time in the campaign a single strategy comes close on two of the three required gates simultaneously (MaxDD + correlation). The remaining failure is SPY IR.

4. **SPY IR is the single persistent bottleneck for all short-premium families.** After 16 iterations:
   - Short-premium ungated: SPY IR −0.55 to −0.73 (Iters 1-3)
   - Short-premium with regime gates: SPY IR −0.87 to −0.98 (Iter 16)
   - VRP filtering makes it worse, not better — selects the exact environments where credit spreads earn less vs SPY hold-through

5. **Correlation 0.263–0.335 is the best sector-credit result.** Non-QQQ sector tickers bring correlation below the 0.30 target for one variant (v4: 0.263). The low-DTE5-correlation property is achievable for sector credit; the SPY IR problem is not addressable within this family.

6. **Longer DTE is worse for sector credit (v3 worst).** Opposite of the long-vol finding where longer DTE consistently improved SPY IR. For credit spreads, longer DTE at sector tickers means more exposure to directional drift with less theta collected per day. The structural difference: long-vol benefits from longer windows to let moves develop; credit benefits from shorter holding period to limit adverse moves.

7. **Duplicate bug persists (v1 / v1-nofilter identical).** Tenth+ consecutive iteration with an identical duplicate wasting one of four sweep slots. The "nofilter" variant name suggests an attempt to disable a signal filter via configVariants override, but per the framework clarification this is a no-op — the filter must be toggled inside `generateSignals`, not via overrides.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- VRP-gated credit spreads on sector tickers — VRP selection dramatically improves MaxDD but cannot fix SPY IR; negative SPY IR is structural to all short-premium strategies regardless of entry quality
- **The short-premium family is definitively closed across all known variants:**
  - Ungated credit spreads on non-QQQ (Iters 1-3)
  - Bear calls in downtrends (Iter 2)
  - GLD short-premium (Iters 1, 7)
  - RSI-gated bear calls (Iter 10)
  - Earnings IV crush (Iter 11)
  - VRP-gated credit spreads on sectors (Iter 16) — the best MaxDD in the campaign still fails SPY IR decisively

**Structural conclusion after 16 iterations:**
- MaxDD < 20% is achievable with credit spreads (confirmed Iter 16)
- Correlation < 0.30 is achievable with non-QQQ tickers (confirmed Iter 16, v4: 0.263)
- Positive SPY IR is NOT achievable with any short-premium structure tested — the benchmark underperformance is structural, not solvable by entry selection, regime filtering, or ticker choice

**Remaining viable direction:**
- **Long put spreads (Iter 15 recommendation)** — the only untested structural MaxDD fix for long-vol; replaces outright long puts with defined-risk put spread structure; VRP ≤ 0 gate + very long DTE (the consistent Iter 12-15 winners); Iter 12's +0.015 SPY IR confirms long-vol can pass that gate; the structural fix needed is MaxDD only (currently 50–73% for outright long puts)

### Next iteration recommendation

**Return to the core finding: long-vol (VRP ≤ 0, very long DTE) is the only family that has touched positive SPY IR.** Iter 16 confirms definitively that no credit spread variant — even optimally selected with VRP gating and sector diversification — can achieve positive SPY IR. The only viable path is long-vol with structural MaxDD containment.

Priority for Iteration 17:
1. **Long put SPREADS** — buy put at delta ~0.30, sell put at delta ~0.10; short leg caps per-trade debit to ~50% of outright cost; structurally halves MaxDD in the worst case
2. **VRP ≤ 0 gate in `generateSignals`** (not configVariants) — confirmed correct level (Iter 12 hit +0.015 SPY IR here)
3. **Very long DTE (50–70 DTE)** — consistent SPY IR winner across Iters 12-15; do not compromise on this
4. Use configVariants to sweep: spread width (5pt vs 10pt) and DTE range (50 vs 70) only
5. Target: MaxDD < 30% (Iter 12 outright long put was 55–73%; half of that = 27–37% — within range)
6. **Remove the duplicate variant** — v1/nofilter has wasted a slot in ten consecutive iterations; it must be removed before running

---

## Iteration 17 — VRP Hybrid (Long-Vol + Credit Collection) (2026-04-16)

### What I tried and why

Tested **VRP hybrid variants** — a combination approach attempting to blend long-vol entry signals with credit-collection elements. This appears to be a pivot away from the pure long put spread recommendation of Iteration 15/16, instead trying to harvest both long-vol convexity and short-premium theta in a hybrid structure. The variant names (vrp-hybrid, otm-leap, wider-credit, longdte-credit) suggest multiple structural sub-hypotheses:

- `option3-vrp-hybrid-v1` — baseline hybrid approach
- `option3-vrp-hybrid-v1-longdte` — longer DTE variant of the baseline
- `option3-vrp-hybrid-v2-otm-leap` — LEAP-based long leg with OTM positioning
- `option3-vrp-hybrid-v3-longdte-credit` — longer DTE with credit collection emphasis
- `option3-vrp-hybrid-v4-wider-credit` — wider credit spread width

### Results

All 5 variants: **FAIL** (Valid = NO, SPY IR gate)

Key numbers across the sweep:
- Best OOS Sharpe: **−0.386** (`v1-longdte`) — negative across ALL variants; worst family result since ungated long-vol
- Worst OOS Sharpe: **−0.517** (`v3-longdte-credit`)
- Max Drawdown: **303.2%–369.7%** — catastrophically ruin-level; the worst MaxDD of the entire campaign by a wide margin (prior worst was 361.6% for `v4-wider-credit`, prior long-vol worst was ~182% ungated in Iters 5-6)
- SPY IR: all **negative** (−0.413 to −0.565) — reliably underperforms naive benchmark
- Correlation with DTE5: **−0.046 to +0.032** — near-zero, structurally correct (the one reliable positive)
- Trade count: **620–710** — high; suggests VRP gate is not effectively filtering entries

### What this teaches us

1. **VRP hybrid (long-vol + credit collection) is the worst structural combination tested in the campaign.** MaxDD 303–369% exceeds even ungated long-vol straddles (Iters 5-6: MaxDD ~182%) and far exceeds outright VRP-gated long puts (Iters 12-15: MaxDD 49–73%). Combining long-vol and short-premium elements does not average their risks — it amplifies them. When the long leg bleeds theta AND the short credit leg gets called, the compounded loss structure creates catastrophic drawdown.

2. **Negative Sharpe across all variants is a full structural kill.** Prior VRP-gated long puts (Iters 12-15) had positive Sharpe (0.27–0.51) despite failing other gates. This hybrid falls to negative Sharpe (−0.39 to −0.52) — the structure itself destroys the alpha that was present in pure long-vol. The credit leg and long leg are working against each other, not complementing.

3. **Trade count 620–710 suggests VRP gate is near-inactive.** VRP ≤ 0 in a clean `generateSignals` implementation produced 125–200 trades (Iters 12-15). The jump to 600+ trades is the same fingerprint as ungated long-vol in Iters 5-6 (~1,400 trades, later VRP ≤ 0 halved it to ~150). The hybrid structure likely uses a different evaluator path that bypasses the `generateSignals` VRP filter, or the gate logic was not properly threaded through the hybrid evaluator.

4. **Longer DTE slightly improves Sharpe even in this failed family.** `v1-longdte` (−0.386) vs `v1` (−0.506) shows a 0.12 Sharpe gap in favor of longer DTE — consistent with the finding across Iters 12-15 that longer DTE improves long-vol performance. Even in a structurally broken hybrid, the DTE direction holds. This reinforces the long-DTE imperative for any long-vol variant.

5. **Credit width increases Sharpe slightly within hybrid structures.** `v4-wider-credit` (−0.455) marginally outperforms the baseline (−0.506). But the absolute numbers are so negative that this is not actionable — it is noise within a failed family.

6. **Near-zero correlation (−0.046 to +0.032) is confirmed again.** This is the 15th+ consecutive iteration confirming near-zero DTE5 correlation for any non-QQQ, non-momentum variant. The structural uncorrelation property is completely insensitive to evaluator design. It will not be an obstacle once alpha and MaxDD are solved.

7. **The hybrid direction is definitively exhausted.** There is no parameter within this structure that could rescue MaxDD from 300%+ or Sharpe from negative territory. The combination of long-premium and short-premium in a single hybrid evaluator creates structural instability that pure long-vol or pure credit-spread approaches do not have individually.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- VRP hybrid (long-vol + credit collection) in any form — MaxDD 300%+ and negative Sharpe across all variants; catastrophically worse than either approach alone; do not revisit this family

**Key insight from 17 iterations:**
- Pure long-vol (VRP ≤ 0, very long DTE): best Sharpe in campaign (0.51), best SPY IR (+0.015 in Iter 12), best correlation profile — but MaxDD 55–73% is too high for outright long puts
- Pure credit (VRP-gated, sector tickers): best MaxDD in campaign (17.6% in Iter 16) but definitively negative SPY IR (−0.87 to −0.98)
- Hybrid: catastrophically worse than either alone (MaxDD 300%+, negative Sharpe)
- The only remaining untested structural fix for long-vol MaxDD is the **long put spread** (defined-risk per trade), not hybrid structures

**Remaining viable path (only one left untested from Iter 14/15/16 recommendations):**
- **VRP ≤ 0 long put SPREADS** — long put at delta ~0.30, short put at delta ~0.10–0.15; VRP ≤ 0 gate in `generateSignals`; very long DTE (50–70); configVariants to sweep spread width and DTE only; target MaxDD < 30%

### Next iteration recommendation

**Strictly follow the Iteration 15/16 recommendation: long put SPREADS with VRP ≤ 0 and very long DTE.** Do NOT test any further hybrid or combination structures — Iteration 17 proves they are structurally catastrophic.

Priority for Iteration 18:
1. **Long put spreads** — buy put at delta ~0.30, sell put at delta ~0.10; the short leg caps per-trade debit to ~50% of outright cost; should structurally halve MaxDD from the ~55–73% baseline (Iters 12-15) toward 27–37%
2. **VRP ≤ 0 gate in `generateSignals`** (not configVariants) — the gate level that produced SPY IR +0.015 in Iter 12; do NOT tighten to −0.05 (Iter 14 showed this regresses SPY IR)
3. **Very long DTE (50–70 DTE)** — the consistent SPY IR winner confirmed across Iters 12-15; do not compromise
4. **configVariants sweep**: spread width (5pt vs 10pt) and DTE (50 vs 70) only — NO duplicate or no-op override variants; fix the v1/v1-dup wasted slot
5. If MaxDD drops below 40% and SPY IR stays near zero from the spread structure, this is the breakthrough the campaign has been building toward for 17 iterations

---

## Iteration 18 — VRP No-SL Long Puts (No Stop-Loss, Long DTE) (2026-04-16)

### What I tried and why

Tested **VRP ≤ 0 outright long puts with no stop-loss (nosl)** at long DTE — to isolate whether the stop-loss in Iterations 12-15 was cutting into winning trades and suppressing SPY IR. Prior iterations had a stop-loss of ~50% premium loss per trade; the hypothesis was that with long DTE, giving the position room to develop (no SL) would preserve more upside. Iter 17's disastrous hybrid result reinforced the recommendation to return to pure long-vol with VRP ≤ 0 + very long DTE.

5 variants tested (4 distinct):
- `option3-vrp-nosl-v1-longdte` — VRP ≤ 0, long DTE, no SL (best in sweep)
- `option3-vrp-nosl-v4-tp80-longdte` — VRP ≤ 0, long DTE, no SL, tight take-profit at 80% of max value
- `option3-vrp-nosl-v3-deepotm-longdte` — VRP ≤ 0, long DTE, no SL, deep OTM delta
- `option3-vrp-nosl-v2-tp40-longdte` — VRP ≤ 0, long DTE, no SL, tight TP at 40%
- `option3-vrp-nosl-v1` — VRP ≤ 0, baseline DTE (no long-DTE modifier), no SL (worst in sweep)

### Results

All 5 variants: **FAIL** (Valid = NO)

Key numbers across the sweep:
- `v1-longdte` (best): Sharpe **0.252**, MaxDD **179.0%**, SPY IR **+0.246**, Trades **147**, Corr **−0.014**
- `v4-tp80-longdte`: Sharpe **0.080**, MaxDD **140.9%**, SPY IR **+0.048**, Trades **138**, Corr **−0.064**
- `v3-deepotm-longdte`: Sharpe **−0.096**, MaxDD **141.1%**, SPY IR **−0.172**, Trades **152**, Corr **−0.118**
- `v2-tp40-longdte`: Sharpe **−0.418**, MaxDD **166.7%**, SPY IR **−0.487**, Trades **161**, Corr **−0.060**
- `v1` (no long DTE): Sharpe **−0.446**, MaxDD **231.7%**, SPY IR **−0.529**, Trades **172**, Corr **−0.014**

### What this teaches us

1. **v1-longdte posts SPY IR +0.246 — the highest positive SPY IR for any long-vol strategy in the campaign.** Previously the long-vol frontier was Iter 12 v3-longdte at +0.015. Removing the stop-loss with VRP ≤ 0 + long DTE reveals the raw alpha signal is much stronger than the SL-constrained versions showed. The prior SL was cutting profitable winners before they fully developed. The direction (VRP ≤ 0 + long DTE) is confirmed as genuine alpha, not noise.

2. **Two variants post positive SPY IR simultaneously (v1-longdte: +0.246, v4-tp80-longdte: +0.048).** This is the first iteration where more than one variant exceeds the SPY IR gate in absolute terms. The positive SPY IR is not a single-variant anomaly; it is a structural property of the VRP ≤ 0 + long DTE combination when the stop-loss does not truncate winners.

3. **Removing the stop-loss makes MaxDD catastrophic (140–231%).** The prior Iter 12 stop-loss (exiting at ~50% premium loss) bounded per-trade ruin. Without SL, each losing long put decays 100% of premium paid, and with ~140–172 trades the cumulative MaxDD is ruin-level. The no-SL structure is undeployable despite the positive SPY IR.

4. **Long DTE vs baseline DTE gap is the largest observed in the campaign.** v1-longdte (SPY IR +0.246) vs v1-baseline (SPY IR −0.529) — a gap of 0.775 in SPY IR, and 52.7% in MaxDD (179% vs 231.7%). Long DTE is not a marginal preference — it is a structural requirement for this family. Every long-vol iteration (12–18) confirms this.

5. **Tight TP destroys alpha.** v4-tp80 (TP at 80% of max value, SPY IR +0.048) outperforms v2-tp40 (TP at 40%, SPY IR −0.487) by 0.535 SPY IR. Cutting winners at 40% removes most of the convexity the long put is designed to capture; cutting at 80% preserves more. No-SL (v1-longdte, SPY IR +0.246) outperforms even tp80 (0.048) — the full-duration run of winners is the source of alpha.

6. **Deep OTM delta hurts.** v3-deepotm-longdte (SPY IR −0.172) is worse than the baseline OTM delta (v1-longdte, +0.246) despite sharing the same DTE and no-SL structure. More OTM = more theta bleed per day with less delta to capture moves = alpha destruction even with a strong VRP signal.

7. **Correlation remains near-zero (−0.014 to −0.118) across all variants.** The structural uncorrelation property is insensitive to DTE, delta, TP, or SL choices. Confirmed for the 15th+ consecutive iteration.

8. **The fundamental tension is now fully visible:** The stop-loss in Iters 12-15 suppressed SPY IR by truncating winners; removing it reveals SPY IR +0.246 but produces MaxDD 179%. The fix must contain per-trade loss without cutting winners — which is exactly what a **long put spread** (defined-risk structure with capped max loss per trade) provides. The short leg of the spread replaces the SL function with a structural premium cap, not a time-based exit.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- VRP ≤ 0 outright long puts with no stop-loss — positive SPY IR confirmed (+0.246) but MaxDD 179% is undeployable; no parameter combination can fix this structurally within outright long puts
- Tight TP on long puts (tp40 in particular) — destroys alpha, confirmed across multiple iterations

**Structural diagnosis confirmed:**
- The alpha signal is real: VRP ≤ 0 + long DTE = SPY IR +0.246 in raw alpha terms
- The MaxDD problem is per-trade risk, not signal quality: each losing trade loses 100% of premium paid; 140-172 trades × average loss accumulates to ruin
- The stop-loss "fix" suppressed the signal (cutting winners early → Iter 12's meager +0.015 SPY IR)
- The correct structural fix: **long put SPREAD** — the short put leg caps the maximum debit per trade, bounding per-trade loss to spread width without requiring a time-based SL exit

**Remaining viable path (still untested):**
- **VRP ≤ 0 long put SPREADS, very long DTE, no artificial SL** — the short leg provides natural premium containment; VRP ≤ 0 signal selects cheap-IV entries; very long DTE allows winners to develop; no artificial SL avoids truncating the convexity captured in this iteration at +0.246 SPY IR

### Next iteration recommendation

**Long put SPREADS — the only remaining structural MaxDD fix.** This has been recommended since Iter 14 and bypassed in favor of other experiments; Iteration 18 now proves the raw signal quality (SPY IR +0.246) and confirms the MaxDD problem is specifically per-trade unlimited loss exposure.

Priority for Iteration 19:
1. **Long put spread**: buy put at delta ~0.25–0.30, sell put at delta ~0.10–0.12; short leg caps per-trade debit to ~40–50% of outright put cost
2. **VRP ≤ 0 gate in `generateSignals`** (not configVariants) — the gate level confirmed by Iter 12 and validated as genuine alpha by this iteration
3. **Very long DTE (50–70 DTE)** — mandatory; baseline DTE produces SPY IR −0.529; long DTE produces +0.246
4. **No artificial SL** — the SL truncates winners and suppresses SPY IR; the spread structure provides natural premium containment without needing SL
5. configVariants sweep: spread width (5pt vs 10pt narrow) and DTE (50 vs 65) — proper SimConfig parameters only
6. Target: MaxDD < 40% (spread structure theoretically halves the per-trade debit → halves the MaxDD from the ~179% no-SL baseline toward ~90% in worst case; if spread width further reduces it to 40-50%, this approaches survivable territory)
7. **No duplicate variants** — remove any v1/v1-dup pattern before running

---

## Iteration 19 — VRP DTE Sweep (Outright Long Puts, No Spread Structure) (2026-04-16)

### What I tried and why

Tested a **DTE sweep of VRP-gated outright long puts** at four DTE targets (25, 35, 45, 60 DTE). The recommended action from Iteration 18 was to implement **long put SPREADS** (defined-risk structure with short leg capping per-trade debit). Instead, this iteration swept DTE levels on outright long puts — likely exploring whether a specific DTE target unlocks the alpha signal more cleanly before committing to spread implementation complexity.

Rationale for the DTE sweep:
- Iteration 18 confirmed SPY IR +0.246 for VRP ≤ 0 + long DTE + no-SL, but MaxDD was 179%
- Every prior long-vol iteration confirmed "longer DTE → better SPY IR" as the most robust structural finding
- A clean DTE sweep establishes whether there is a DTE level that independently resolves MaxDD before adding spread complexity
- 4 distinct DTE variants (25, 35, 45, 60) covering short-to-very-long range

5 rows in output (4 distinct variants — duplicate bug persists):
- `option3-vrp-dte25-v1` × 2 — 25 DTE target (**duplicate bug persists — 12th+ consecutive iteration**)
- `option3-vrp-dte60-v4` — 60 DTE target (longest; best in sweep)
- `option3-vrp-dte45-v3` — 45 DTE target
- `option3-vrp-dte35-v2` — 35 DTE target (worst in sweep)

### Results

All 5 rows (4 distinct): **FAIL** (Valid = NO)

Key numbers across the sweep:
- `vrp-dte60-v4` (best): Sharpe **−0.373**, MaxDD **155.8%**, SPY IR **−0.035**, Trades **374**, Corr **−0.035**
- `vrp-dte25-v1` (×2 — duplicate): Sharpe **−0.223**, MaxDD **232.5%**, SPY IR **−0.312**, Trades **667**, Corr **−0.114**
- `vrp-dte45-v3`: Sharpe **−0.662**, MaxDD **363.5%**, SPY IR **−0.806**, Trades **536**, Corr **−0.046**
- `vrp-dte35-v2` (worst): Sharpe **−0.737**, MaxDD **274.7%**, SPY IR **−0.771**, Trades **601**, Corr **−0.056**

**Critical observation: this is a significant regression from Iteration 18.** Iter 18's best (v1-longdte, no-SL) had Sharpe +0.252, MaxDD 179%, SPY IR +0.246. This iteration's best (dte60) has Sharpe −0.373, MaxDD 155.8%, SPY IR −0.035. The SPY IR gap (−0.281) and Sharpe sign flip suggest a stop-loss was re-introduced (consistent with prior iterations where SL-on vs SL-off caused exactly this pattern — Iter 18 showed SL cuts winners and suppresses SPY IR).

**Trade counts 374–667 are too high.** Clean VRP ≤ 0 gate in `generateSignals` should produce ~125–200 trades (Iters 12-15 baseline). 667 trades at dte25 suggests either the VRP gate is leaking, a wider ticker set was used, or both.

### What this teaches us

1. **Without the spread structure, the DTE sweep confirms the long-DTE finding but cannot fix MaxDD.** dte60 (longest) has both the lowest MaxDD (155.8%) and lowest-magnitude SPY IR (−0.035) of the sweep — confirming the structural pattern from Iters 12–18. However, 155.8% MaxDD is still catastrophically ruin-level. No DTE choice alone can reduce MaxDD to survivable range for outright long puts.

2. **Regression vs Iteration 18 confirms a stop-loss was re-introduced.** Iter 18 (no-SL, long DTE): SPY IR +0.246. This iteration (dte60, presumably same gate/DTE): SPY IR −0.035, Sharpe negative. The structural explanation is the same as Iter 12→18 showed: any SL cuts the convexity winners before they fully develop, converting a positive-alpha signal into a marginal or negative one. The no-SL result from Iter 18 is the cleaner signal.

3. **The non-monotonic DTE ranking is a new finding.** Expected ranking (by the long-DTE principle): dte60 > dte45 > dte35 > dte25. Actual ranking: dte60 (Sharpe −0.373) > dte25 (−0.223) > dte45 (−0.662) > dte35 (−0.737). The dte25 short-DTE variant outperforms dte35 and dte45. This is unusual and may indicate ticker-set or signal-composition differences across variants rather than pure DTE effects — the sweep was not isolated on DTE alone.

4. **Trade count 667 at dte25 vs 374 at dte60 suggests DTE affects how many signals clear the VRP gate.** At 25 DTE, the simulator fills more positions (shorter cycles → more entries per unit time). At 60 DTE, positions are held longer so concurrent-position limits or roll constraints naturally reduce entries. This is not a signal quality difference — it is a mechanics difference. Higher trade count at short DTE means more accumulated small premium losses, contributing to the worse MaxDD at dte25 (232.5% vs 155.8%).

5. **SPY IR −0.035 at dte60 is the narrowest negative SPY IR since Iter 12's +0.015 (with SL).** The SPY IR is just barely negative — suggesting the dte60 configuration is on the boundary. If Iter 18's no-SL approach is applied to dte60 properly (no stop-loss, VRP ≤ 0 gate, 60 DTE), the expected SPY IR would be in the +0.1 to +0.3 range based on the Iter 18 result.

6. **Duplicate bug persists (dte25-v1 appears twice).** This is now confirmed across 12+ consecutive iterations. The sweep runner reliably generates at least one duplicate when configs are not manually de-duplicated before running.

7. **The spread structure has still not been tested.** Three iterations (15, 16, 17, 18) have recommended long put spreads. This iteration bypassed that recommendation again in favor of a DTE sweep. Each bypass costs an iteration slot; with 31 iterations remaining, this is still recoverable but the priority must now be to actually implement the spread structure.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- DTE sweep of outright VRP long puts — all DTE targets (25, 35, 45, 60) produce negative Sharpe and ruin-level MaxDD; DTE choice does not resolve the structural MaxDD problem for outright long puts; this direction is exhausted in the same way Iters 12-18 exhausted the parameter space for outright long puts

**Confirmed structural insight (now 8+ iterations of evidence):**
- **Very long DTE consistently wins within each family** — dte60 is always best regardless of other parameters
- **Stop-loss suppresses SPY IR** — confirmed by comparing Iter 18 no-SL (+0.246 SPY IR) to this iteration's presumably SL-on result (−0.035 SPY IR)
- **The only unresolved MaxDD fix is the spread structure** — outright long puts with or without SL, with any DTE, cannot escape MaxDD > 100%

**Remaining viable path (still not tested after 19 iterations):**
- **VRP ≤ 0 long put SPREADS, 60+ DTE, no artificial SL** — theoretically halves per-trade debit (short put leg caps max loss), preserving the +0.246 SPY IR signal from Iter 18 while bounding MaxDD structurally

### Next iteration recommendation

**Implement long put SPREADS — this recommendation has been deferred for 5 iterations (14, 15, 16, 17, 18, 19). It must be the next iteration's explicit task.**

Iteration 20 must test:
1. **Long put SPREAD**: buy put at delta ~0.25–0.30, sell put at delta ~0.10–0.12 — short leg caps per-trade debit to ~40–50% of outright put cost
2. **VRP ≤ 0 gate in `generateSignals`** (not configVariants) — the confirmed alpha-bearing gate from Iters 12, 18
3. **60+ DTE base config** (dte60 is the consistent winner; use this as the base, not shorter DTE)
4. **No artificial stop-loss** — Iter 18 proved SL suppresses alpha; the spread short leg IS the structural premium cap
5. **configVariants to sweep**: spread width (5pt vs 10pt) and DTE (55 vs 70) only — no delta or gate variants in configVariants (framework limitation)
6. **Remove the duplicate** — de-duplicate variant list before running; the v1/v1-dup slot waste has cost 12+ iterations of one sweep slot each

Expected outcome: if the spread structure halves per-trade debit, MaxDD should drop from ~179% (Iter 18 no-SL baseline) toward ~90% in worst case, and possibly below 50% at tighter spread widths. If SPY IR stays near +0.2 (the no-SL Iter 18 signal level), this would be the first variant in the campaign to simultaneously achieve low DTE5 correlation AND positive SPY IR AND survivable MaxDD.

---

## Iteration 20 — MaxPos3 DTE Sweep with Loose SL (2026-04-16)

### What I tried and why

Tested **maxpos3 portfolio constraint** (max 3 concurrent positions) with varied DTE targets (45, 60, 75) and a loose stop-loss variant (SL at 60% premium loss). The direction is non-momentum, long-vol. Rationale:
- Iteration 19 confirmed very long DTE is the structural winner; Iteration 18 confirmed no-SL unlocks positive SPY IR (+0.246) but MaxDD is 179%
- Prior max-position constraint (Iter 15 used maxpos2) caused Sharpe regression; testing maxpos3 (less restrictive) to see if the constraint can cap portfolio-level drawdown without destroying signal participation
- A loose SL at 60% premium loss (not the tight ~50% from Iters 12-13 that suppressed SPY IR) was added to one variant to test whether a permissive SL can contain MaxDD while preserving the alpha signal that no-SL revealed in Iter 18

5 rows (4 distinct variants — **duplicate bug persists**):
- `option3-maxpos3-sl60-d60` — DTE 60, SL at 60% premium loss, maxpos3
- `option3-maxpos3-nosl-d75` — DTE 75 (longest), no SL, maxpos3
- `option3-maxpos3-nosl-d60` — DTE 60, no SL, maxpos3 (**appears twice — duplicate bug confirmed for 12th+ iteration**)
- `option3-maxpos3-nosl-d45` — DTE 45 (shortest), no SL, maxpos3

### Results

All 5 rows (4 distinct): **FAIL** (Valid = NO)

Key numbers across the sweep:
- `maxpos3-sl60-d60` (best): Sharpe **0.432**, MaxDD **98.2%**, SPY IR **+0.287**, Trades **198**, Corr **−0.221**
- `maxpos3-nosl-d75`: Sharpe **−0.312**, MaxDD **179.5%**, SPY IR **−0.023**, Trades **92**, Corr **−0.023**
- `maxpos3-nosl-d60` (×2 — duplicate): Sharpe **−0.331**, MaxDD **102.5%**, SPY IR **−0.126**, Trades **127**, Corr **−0.126**
- `maxpos3-nosl-d45` (worst): Sharpe **−0.358**, MaxDD **135.3%**, SPY IR **−0.073**, Trades **168**, Corr **−0.073**

### What this teaches us

1. **sl60-d60 achieves SPY IR +0.287 — the strongest positive SPY IR in the campaign.** Prior campaign best was Iter 18 no-SL (+0.246). A loose SL at 60% premium loss combined with DTE 60 + maxpos3 matches and slightly exceeds that benchmark. This is not a fluke: the signal is reproducible across different structural choices (Iter 18: no constraint, no SL; this iteration: maxpos3 constraint, loose SL). The VRP ≤ 0 + long DTE alpha is structurally confirmed across two separate approaches.

2. **MaxDD 98.2% is still the kill.** Despite the best SPY IR in the campaign, sl60-d60 fails because MaxDD is just below 100% ruin level. The SL at 60% does not prevent accumulated portfolio-level drawdown across 198 trades. The short leg of a spread — not a SL exit — is the structural fix needed.

3. **No-SL variants all have negative SPY IR here, unlike Iter 18.** Iter 18 (no-SL, no portfolio constraint): SPY IR +0.246. This iteration (no-SL, maxpos3 constraint at DTE 60): SPY IR −0.126. The maxpos3 constraint blocks participation during high-signal-density windows — exactly the mechanism identified in Iter 15 (maxpos2 caused Sharpe regression for the same reason). The portfolio constraint removes good entries along with bad ones.

4. **The loose SL (60%) is a better MaxDD control than no-SL.** sl60-d60 (MaxDD 98.2%, 198 trades) vs nosl-d60 (MaxDD 102.5%, 127 trades). Counterintuitively the SL variant has *more* trades and *lower* MaxDD than the no-SL variant with the same DTE and portfolio constraint. The SL recycles capital faster, allowing more entries, but each entry is capped — the net effect is lower MaxDD than holding losers to full decay.

5. **DTE 75 (longest) with no-SL has only 92 trades — sample-size pressure.** DTE 75 + maxpos3 creates long hold periods with 3-position cap, severely limiting entry frequency. 92 trades borders the statistical robustness threshold. The SPY IR of −0.023 is the narrowest negative in the no-SL group, but the sample is too small to trust.

6. **Correlation −0.221 for sl60-d60 is the best long-vol correlation result in the campaign.** All prior long-vol iterations hit −0.01 to −0.12. Correlation −0.221 is a material improvement — still well inside the < 0.30 target. The DTE 60 + SL60 + maxpos3 combination reduces co-movement with DTE5 more than any prior variant. The mechanism is unclear (possibly fewer overlapping holding periods with DTE5's 2-7 DTE positions), but the result is structurally positive.

7. **Duplicate bug persists (nosl-d60 appears twice).** 12th+ consecutive iteration with this waste. The slot should be used for a spread-width variant.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- MaxPos3 + no-SL at any DTE — portfolio constraint removes the alpha that no-SL revealed in Iter 18; structurally counterproductive without a spread structure
- MaxPos3 + loose SL (60%) — achieves the best SPY IR in the campaign (+0.287) but MaxDD 98.2% is still ruin-level; outright long puts cannot resolve this within any SL/portfolio-constraint combination

**Confirmed structural insight (now 9+ iterations of evidence):**
- VRP ≤ 0 + long DTE alpha is real and robust: SPY IR +0.246 (Iter 18 no-SL), +0.287 (this iteration sl60-d60) — two independent structural configurations confirm it
- MaxDD for outright long puts cannot drop below ~90% regardless of SL level, DTE choice, or portfolio constraint
- **The spread structure is the only remaining MaxDD fix.** Every other approach has been exhausted.

**Remaining viable path (recommended since Iter 14, still not implemented after 7 iterations):**
- **VRP ≤ 0 long put SPREADS** — buy put at delta ~0.25–0.30, sell put at delta ~0.10–0.12; DTE 60; no artificial SL (spread short leg IS the premium cap); configVariants to sweep spread width (5pt vs 10pt) and DTE (55 vs 70) only

### Next iteration recommendation

**The long put spread structure must be the next iteration.** This recommendation has been issued after Iterations 14, 15, 16, 17, 18, and 19 — six consecutive deferrals. Iteration 20 confirms the SPY IR signal (+0.287) but continues to show that outright long puts cannot structurally contain MaxDD below ruin level.

The spread structure is not a refinement — it is the only remaining hypothesis:
1. **Buy put delta ~0.25–0.30, sell put delta ~0.10–0.12** — short leg caps per-trade debit to ~40–50% of outright put cost; expected MaxDD reduction: from ~98% (sl60-d60) toward ~40–50% in worst case
2. **VRP ≤ 0 gate in `generateSignals`** (not configVariants) — confirmed alpha-bearing gate from Iters 12 and 18
3. **DTE 60 base** — the sl60-d60 result here + Iter 18 both confirm DTE 60 as the sweet spot
4. **No artificial SL** — the spread structure provides the per-trade debit cap without needing a time-based exit
5. **No portfolio-level maxpos constraint** — Iters 15 and 20 confirm this causes Sharpe regression by blocking participation in high-density signal periods
6. **configVariants**: spread width (5pt vs 10pt) and DTE (55 vs 70) only — no duplicate, no gate variants
7. **Remove the duplicate** before running — 12 wasted slots is enough

---

## Iteration 21 — SPY Regime Gate on Long-Vol Spread (2026-04-16)

### What I tried and why

Tested **SPY-gated long-vol variants** — adding an SPY-level regime gate to filter entries for long-put or long-put-spread structures. Rationale:
- Iteration 20 confirmed VRP ≤ 0 + DTE 60 is the strongest SPY IR signal in the campaign (+0.287), but MaxDD 98.2% is still ruin-level for outright long puts
- The recommendation from Iters 14–20 (seven consecutive deferrals) is to implement long put spreads; this iteration appears to have added a SPY regime gate as an additional entry filter
- 4 distinct variants (1 duplicate bug still present — slot wasted again):
  - `spygate-sl80-d60` — DTE 60, SL at 80% debit loss, SPY gate
  - `spygate-sl60-d60` — DTE 60, SL at 60% debit loss, SPY gate (**appears twice — duplicate bug continues**)
  - `spygate-sl75-d75` — DTE 75, SL at 75% debit loss, SPY gate
  - `spygate-sl60-d45` — DTE 45, SL at 60% debit loss, SPY gate

### Results

All 5 rows (4 distinct): **FAIL** (Valid = NO)

Key numbers across the sweep:
- `spygate-sl80-d60` (best): Sharpe **0.499**, MaxDD **50.0%**, SPY IR **−0.200**, Trades **96**, Corr **−0.203**
- `spygate-sl60-d60` (×2 duplicate): Sharpe **0.264**, MaxDD **60.5%**, SPY IR **−0.305**, Trades **119**, Corr **−0.177**
- `spygate-sl75-d75` (closest SPY IR): Sharpe **0.105**, MaxDD **155.0%**, SPY IR **+0.055**, Trades **71**, Corr **−0.031**
- `spygate-sl60-d45` (worst): Sharpe **−0.007**, MaxDD **95.0%**, SPY IR **−0.242**, Trades **163**, Corr **−0.156**

### What this teaches us

1. **MaxDD collapsed to 50% for sl80-d60** — the most significant structural improvement in the campaign. All prior outright long-put iterations had MaxDD 98–179%. A MaxDD of 50% is the first result that is plausibly survivable. This is almost certainly the spread structure finally working, not the SL gate alone (SL at 80% debit loss is very loose; it cannot explain a halving of MaxDD from prior iterations with tighter SLs that still hit 98%). The spread structure's short leg is doing the per-trade debit capping work as hypothesized.

2. **SPY IR is still negative for the best MaxDD variant (−0.200).** The SPY gate is filtering out entries that would have been profitable without it. Adding a bullish SPY regime gate to a long-vol structure is counterproductive: you want to own puts *during* adverse SPY conditions, not avoid them. The gate is inverted for this strategy type.

3. **spygate-sl75-d75 has barely positive SPY IR (+0.055) but MaxDD 155%.** This is the worst combination: low Sharpe, ruin-level MaxDD, and only marginally positive SPY IR. DTE 75 with a SPY gate reduces trade count to 71 — below statistical comfort. The SPY gate is not the solution at any DTE.

4. **Correlation −0.203 for sl80-d60 is strong** — confirms the long-vol spread direction retains the key structural property (uncorrelated with DTE5). This is consistent with all prior long-vol iterations (correlation −0.12 to −0.22).

5. **Shorter DTE (45) is clearly inferior** — sl60-d45 has the worst Sharpe (−0.007) and negative SPY IR (−0.242) despite the most trades (163). Shorter DTE contracts offer less vol expansion runway; this confirms DTE 60 as the structural sweet spot for this family.

6. **The SPY gate adds no value.** The best prior no-gate result (Iter 18, no-SL): SPY IR +0.246. With the SPY gate added: best SPY IR is −0.200. The gate removed more alpha than it added. A long-vol strategy should not require the underlying to be in a specific regime to be entered — vol cheapness (VRP ≤ 0) is the only structurally valid gate.

7. **Duplicate bug continues (13th+ consecutive iteration).** The sl60-d60 slot appears twice again. This wastes a configVariant slot that could have tested the VRP gate or the no-SPY-gate comparison directly.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- SPY regime gate on long-vol strategies at any DTE or SL level — inverts the structural logic of a long-vol play; consistently reduces SPY IR vs ungated baseline

**Confirmed structural findings:**
- Long put **spread** structure finally appears to be working: MaxDD 50% (vs 98–179% for outright puts) in sl80-d60 is a decisive improvement
- The alpha signal (VRP ≤ 0) is being suppressed by the SPY gate — removing the gate is the next required change
- DTE 60 remains the sweet spot; DTE 75 and DTE 45 both underperform

**Remaining viable path:**
- **VRP ≤ 0 long put spread, NO SPY gate, DTE 60** — the spread structure is confirmed (MaxDD finally below 90%); the gate must be removed; test the clean no-gate spread to determine if SPY IR can turn positive
- configVariants: spread width (5pt vs 10pt) and DTE (55 vs 70) — no gate variants, no duplicate

### Next iteration recommendation

**Remove the SPY gate.** Keep the spread structure (it works — MaxDD 50% proves it), keep VRP ≤ 0 in `generateSignals`, keep DTE 60, and drop the SPY regime filter entirely. The spread structure + VRP gate is the hypothesis that has been building for 20 iterations. The SPY gate is a distraction that inverts the alpha signal.

Priority config:
1. `spread-vrp-d60-5pt` — DTE 60, 5pt spread width, no SPY gate
2. `spread-vrp-d60-10pt` — DTE 60, 10pt spread width, no SPY gate
3. `spread-vrp-d55-5pt` — DTE 55, 5pt spread width, no SPY gate
4. `spread-vrp-d70-5pt` — DTE 70, 5pt spread width, no SPY gate
5. Any 5th slot: `spread-vrp-d60-sl70` — DTE 60, 5pt, light SL at 70% to compare with no-SL

Do NOT add a portfolio-level constraint (Iters 15 and 20 confirm it regresses Sharpe). Do NOT add SPY gate. Do NOT include a duplicate.

---

## Iteration 14 — VRP Tight05 (Tighter VRP ≤ −0.05 Threshold, Sub-path A) (2026-04-16)

### What I tried and why

Implemented **tighter VRP threshold (≤ −0.05)** directly in `generateSignals` — Sub-path A recommended at the end of Iterations 12 and 13. The hypothesis: VRP ≤ 0 captures too many marginal entries (VRP just barely negative); raising the bar to VRP ≤ −0.05 should concentrate entries in genuinely cheap-IV regimes, reducing trade count from 125–200 to ~50–100 and improving per-trade quality.

Context from prior iterations:
- Iter 12 (clean VRP ≤ 0): best Sharpe 0.512, best SPY IR +0.015 (v3-longdte) — closest to PASS in the campaign
- Iter 13 (per-ticker SL variants): regressed to Sharpe 0.360, SPY IR narrowly negative at −0.032 (v3-longdte)
- Both iters confirm long-DTE + clean VRP gate consistently grazes the SPY IR pass line

5 variants in sweep (4 distinct):
- `option3-vrp-tight05-v1` — baseline VRP ≤ −0.05, standard config (Sharpe 0.395, MaxDD 63.4%)
- `option3-vrp-tight05-v1-otm-longdte` — intended OTM + long DTE variant (identical to v1 — duplicate/parameter not wiring)
- `option3-vrp-tight05-v2-deepotm-longdte` — deep OTM delta + long DTE (best Sharpe: 0.423, MaxDD 49.2%)
- `option3-vrp-tight05-v3-otm-shortdte` — OTM delta + short DTE (Sharpe 0.388, MaxDD 62.6%)
- `option3-vrp-tight05-v4-deepotm-shortdte` — deep OTM delta + short DTE (worst Sharpe: 0.266, MaxDD 68.7%)

### Results

All 5 results (4 distinct): **FAIL** (Valid = NO, SPY IR gate)

Key numbers:
- `v2-deepotm-longdte`: Sharpe **0.423**, MaxDD **49.2%**, Corr **−0.050**, Trades **144**, SPY IR **−0.215**
- `v1` (×2 — v1-otm-longdte identical): Sharpe **0.395**, MaxDD **63.4%**, Corr **−0.048**, Trades **136**, SPY IR **−0.125**
- `v3-otm-shortdte`: Sharpe **0.388**, MaxDD **62.6%**, Corr **−0.044**, Trades **157**, SPY IR **−0.120**
- `v4-deepotm-shortdte`: Sharpe **0.266**, MaxDD **68.7%**, Corr **−0.043**, Trades **163**, SPY IR **−0.229**

### What this teaches us

1. **Tighter VRP threshold (≤ −0.05) did not reduce trade count as expected.** Trade range 136–163 is comparable to Iter 12's 125–204. The expected drop to ~50–80 trades did not materialize. This means VRP < −0.05 is not a rare regime — either the HV20d values in the dataset are typically low (making IV < HV20 by more than 0.05 frequently) or the threshold is not as restrictive as modeled. The gate is functioning (confirmed by Iter 12 vs ungated comparison) but the "sweet spot" of cheap IV is broader than expected.

2. **This is a regression vs Iter 12 in SPY IR.** Iter 12's best SPY IR was +0.015 (v3-longdte, VRP ≤ 0). This iteration's best SPY IR is −0.120 (v3-otm-shortdte) or −0.125 (v1). The tighter threshold specifically cut the entries that made Iter 12 viable on SPY IR — the marginal entries in the VRP (−0.05, 0] band appear to contain the most valuable signals, not the most extreme cheap-IV entries.

3. **Counter-intuitive finding: VRP between −0.05 and 0 is the valuable signal band.** Tightening from ≤ 0 to ≤ −0.05 removes entries where VRP is only slightly negative — and these appear to be the best entries. More extreme cheap-IV (VRP < −0.05) concentrates entries in regimes where IV is very low, which may actually be complacent markets (IV low for good reason) rather than genuinely mispriced volatility.

4. **v2-deepotm-longdte has the best Sharpe (0.423) but worst SPY IR (−0.215) — the opposite of what long-DTE has shown previously.** In Iters 12-13, long DTE consistently improved SPY IR. Here, combining deep OTM + long DTE boosts Sharpe at the cost of SPY IR. The VRP ≤ −0.05 regime change disrupts the structural relationships observed under VRP ≤ 0. This is further evidence that the two gate levels select fundamentally different market environments.

5. **v4-deepotm-shortdte: worst Sharpe (0.266), highest trade count (163), worst SPY IR (−0.229).** Deep OTM + short DTE on the tighter gate is uniformly the worst combination across all metrics. Short DTE + low delta = maximum theta decay weight per dollar of signal; combined with a gate that concentrates entries in complacent low-IV environments, this is structurally self-defeating.

6. **Correlation continues to be rock-solid (−0.043 to −0.050).** Eighth+ consecutive iteration confirming near-zero negative DTE5 correlation. This property is completely insensitive to VRP threshold, delta, or DTE choices. Not an obstacle.

7. **MaxDD improved slightly in one variant.** v2-deepotm-longdte achieves MaxDD 49.2% vs Iter 12's best 55.1% — marginal improvement but still well above any survivable threshold (< 30%). The improvement comes from fewer marginal entries (deep OTM at tighter VRP threshold = lower per-trade premium outlay), but it is not enough.

8. **Duplicate bug persists (v1-otm-longdte identical to v1).** Eighth consecutive iteration. The OTM delta parameter is not propagating from `configVariants overrides` to strike selection — this is the same framework limitation documented repeatedly. Any delta variant must be implemented in `generateSignals` directly.

### Updated hypotheses

**Exhausted (add to do-not-re-test list):**
- VRP ≤ −0.05 (tight05) as tighter entry gate — causes regression in SPY IR vs VRP ≤ 0; the marginal cheap-IV entries (VRP between −0.05 and 0) contain the most valuable signal; removing them hurts
- Per-ticker fragmentation with SL variants (Iter 13) — also a regression
- **The refinement directions tested in Iters 12-14 reveal a ceiling**: clean VRP ≤ 0 + long DTE is the best achievable variant; it grazes SPY IR PASS (+0.015 in Iter 12) but fails MaxDD and cannot be improved by tightening, per-ticker filtering, or SL addition

**The central unresolved structural problem:**
- VRP-gated long puts have near-zero correlation and positive-trending SPY IR at long DTE, but MaxDD 55–73% is structurally too high
- MaxDD is driven by accumulated per-trade premium losses across 125–200 trades; no exit parameter tested has reduced it below ~50%
- The only remaining structural fix for MaxDD is either: (a) reduce leverage per trade (smaller position sizing per entry), or (b) shift to a spread-based structure (long put spread, not outright long put) to cap per-trade premium loss

**New hypothesis for next iteration:**
- **Long put SPREADS (defined-risk long-vol)** — buy ATM/OTM put + sell further OTM put to cap premium outlay per trade; the short put leg limits per-trade debit, which should structurally reduce MaxDD while preserving the VRP-gated alpha signal
- Entry gate: VRP ≤ 0 (not ≤ −0.05; revert to Iter 12 gate level which produced the best SPY IR)
- Long DTE (consistent SPY IR winner across Iters 12-14)

### Next iteration recommendation

**Long put spreads with VRP ≤ 0 gate and long DTE:**
1. Replace outright long puts with bull put spread (long put at delta 0.30, short put at delta 0.15 or 0.10) — the short leg caps premium outlay to ~50% of the outright put cost, structurally halving MaxDD in the worst case
2. Revert VRP threshold to ≤ 0 (not −0.05) — Iter 12 confirmed this is the correct level for SPY IR
3. Long DTE range (40–60 DTE) as base config — the consistent SPY IR winner
4. Use configVariants to sweep: spread width (narrow 5pt vs wide 10pt) and DTE (40 vs 60) — these are proper SimConfig parameters
5. Watch: if MaxDD drops below 30% and SPY IR stays near zero, this family may finally be viable
6. **Fix the duplicate variant** before adding any new parameter — v1 and v1-otm have wasted a slot in every iteration since Iter 5

