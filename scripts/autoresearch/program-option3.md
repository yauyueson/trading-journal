# Autoresearch Option 3 — Non-Momentum Complement

## Your Goal

Find a **non-momentum** options strategy that **complements** the existing DTE5 bull put credit spread.

DTE5:
- Trades QQQ only, short-put credit spreads
- 2–7 DTE, EMA55 gate, SL 2.5× credit, trailing lock 50/50, hold-to-expiry
- OOS Sharpe ~1.44, strong in bullish/neutral markets, idle in downtrends

A second-momentum LEAP family was also researched (d65-tp40 etc.) and is NOT your mission. Campaigns A and C showed that adding entry gates or portfolio responses to d65-tp40 doesn't improve on the baseline. Your job is a **different class** of strategy — fundamentally distinct in mechanism from DTE5 and the momentum LEAP family.

## What "non-momentum" means here

You are NOT looking for variations of:
- EMA cross / MA-touch / EMA34 bounce entries
- "Buy when stock is trending up"
- Long-delta calls on momentum tickers
- Short-put spreads on QQQ (that IS DTE5)

You ARE encouraged to look at:
- **Non-equity / non-QQQ underlyings**: GLD, IWM, sector ETFs, individual stocks uncorrelated with QQQ
- **Mean-reversion / counter-trend**: long puts when stocks are overbought / RSI > 75 + momentum divergence; bear call spreads on extended rallies
- **Volatility trades**: long straddles / strangles when VRP compresses (IV below HV) — structurally complementary short-vol exposure to DTE5's short-premium
- **Different time horizons**: 30–90 DTE credit spreads (vs DTE5's 2–7) — different theta curve, different path dependence
- **Directional short-premium opposite to DTE5**: bear call spreads when SPY < EMA200 (DTE5 is idle then — fills the gap)
- **Diagonal / PMCC**: harvest theta with a longer-term directional position
- **Event-driven**: earnings IV crush plays on specific tickers, FOMC / CPI vol expansion
- **Delta-neutral / pairs**: strangles, iron-butterfly NOT at center (but beware: pure iron condors / butterflies already killed — see below)

## Prior kills — do NOT revisit these

Hard-earned. Each wasted an exploration cycle:
- **Iron condors, butterflies, calendar spreads** — all three failed WFA in April 2026 under realistic bid/ask fills. Structurally unprofitable once fills are honest.
- **Momentum LEAP CALLs (h4-ts105, d65-tp40 family)** — validated but already exists. Correlated with QQQ, fragile to regime shifts. This is a known strategy; don't duplicate.
- **MA-touch + EMA34 pullback entries** — exhausted across ≥20 iterations in the momentum family. Any variant of "price touches EMA34 then bounces up" has been tried.
- **Mid-price fills** — simulator bug. MUST use `fillMode: 'bidask'` (default).
- **IV rank filter > 30 on ETFs** — kills 70%+ of signals for no Sharpe gain.
- **Credit spreads on QQQ** — same underlying as DTE5 → correlation > 0.5. Not a complement.

Read `scripts/autoresearch/journal-option3.md` for the full exhausted-search map.

## Key Metric: Combined Portfolio Sharpe

You optimize `combinedSharpe` — 50/50 portfolio of DTE5 daily returns + YOUR strategy's daily returns.

**A Sharpe 0.5 strategy uncorrelated with DTE5 is MORE valuable than a Sharpe 1.0 strategy perfectly correlated with it.**

**Targets:**
- `combinedSharpe > 1.5` (DTE5 standalone is ~1.44; beating the 50/50 combo means you added real value)
- `correlation with DTE5 < 0.30` (low is very valuable; below 0.15 is exceptional)
- Holdout gate PASS (the runner hides exact holdout Sharpe; you see only PASS/FAIL)
- Delta gate PASS (signal timing must beat the naive always-long same-config baseline)
- Deflated Sharpe > 0 under accumulated N attempts

## Validity gates (hard constraints)

1. OOS Sharpe > 0
2. OOS trades ≥ 100
3. MaxDD ≤ 45%
4. Holdout gate: holdout Sharpe ≥ 0.3 OR holdout SPY IR ≥ 0.3
5. Sanity: OOS Sharpe ≤ 3.0 (anything above = simulator bug)
6. Delta gates: ΔSPY IR > 0, ΔMaxDD ≤ 0, ΔCorrelation ≤ 0 vs naive baseline

## Available tickers (25)

AAPL, AMD, AMZN, AVGO, BA, COIN, COST, GLD, GOOG, GS, HOOD, IWM, JPM, LULU, META, MSFT, MSTR, NFLX, NVDA, PLTR, QQQ, SPY, TSLA, UBER, UNH

QQQ is the DTE5 ticker — using it is allowed but requires genuinely different structure, not duplication.

## Available option modes

Set via `buildConfig()` → `SimConfig.mode`:
- `CREDIT_SPREAD` — OTM vertical credit spreads (the DTE5 instrument family)
- `LEAP` — long deep-ITM options (the momentum family)
- `DEBIT_SPREAD` — not fully wired (use `customEvaluator`)
- `SWING_LONG_OPTION` — not fully wired (use `customEvaluator`)

For diagonals, PMCC, calendars, ratio spreads, strangles: implement `customEvaluator` in strategy. The worker's chainLookup will be passed in.

## Available data in `generateSignals(data, market)`

- `data.candles` — daily OHLCV
- `data.emas.get(8|13|21|34|55|200)` — full EMA series
- `data.ivRanks[]` — 252-day IV rank (0-100 or null)
- `data.regimeByDate.get(date)` — `{ vrp, contango, vrpPct, contangoPct }`
- `market.spyByDate.get(date)` — `{ close, ema200 }` for SPY regime gates

## Simulation model notes

- Entry: same-bar fill on signal close (slightly optimistic; no T+1 delay)
- Fills: **bid/ask (mandatory)** — mid-fill simulator was removed because it overstates ITM/wide-spread performance
- Monitoring: daily (`monitoringIntervalDays: 1`) — other values create MtM measurement artifacts
- No commissions modeled — results slightly overstate net
- Chain lookup is pre-cached (SQLite); O(1) access

## ⚠️ Framework constraint: `configVariants` only vary SimConfig, NOT signals

This trips up nearly every agent. `configVariants` is a batch sweep mechanism that ONLY overrides SimConfig fields (`creditShortDelta`, `leapProfitTarget`, `creditDTERange`, etc.). The `generateSignals(data, market)` function runs **ONCE**, produces one signal list, and all variants share it.

**This means configVariants CANNOT:**
- Vary entry gates (VRP threshold, RSI threshold, EMA gate, ticker filter)
- Vary signal generation logic in any way
- Change the signals' `direction`, `ticker`, `score`, or `ivRank`

**If configVariants produce identical trade counts and identical results, the "variants" were signal-generation variants that didn't actually vary.** That's not a bug — it's the framework working as designed.

**What configVariants CAN do:**
- Vary `creditShortDelta`, `creditSpreadWidth`, `creditDTERange`, `creditProfitTarget`, `creditStopLossMultiple`
- Vary `leapDeltaRange`, `leapDTERange`, `leapProfitTarget`, `leapStopLoss`, `leapTimeStopDTE`
- Vary `vrpFilter`, `contangoFilter`, `vrpPctFilter`, `contangoPctFilter` — but ONLY for CREDIT_SPREAD (these are checked in the credit evaluator; they also require `signal.vrp` / `signal.contango` to be populated in generateSignals)
- Vary `minIVRank` — ditto (credit evaluator only)

**To test multiple entry gates, use separate iterations.** Each iteration runs its own strategy-option3.ts with its own signal generator, so iteration N and iteration N+1 naturally test different gates. configVariants is for param sweeps WITHIN a fixed signal set.

**To make a credit-spread variant gate on VRP/contango:**
1. Populate signal fields in generateSignals:
   ```typescript
   const r = data.regimeByDate.get(c.date);
   signals.push({ ticker, date, direction, score,
     ivRank: data.ivRanks[i] ?? undefined,
     vrp: r?.vrp, vrpPct: r?.vrpPct,
     contango: r?.contango, contangoPct: r?.contangoPct });
   ```
2. Set `vrpFilter: 0.02` (or similar) in the variant's `overrides`. The credit evaluator will reject signals where `signal.vrp < config.vrpFilter`.

For LEAP/straddle/customEvaluator modes, the `vrpFilter` etc. are not checked — you must filter in generateSignals itself.

## Tips

1. **Start simple.** One ticker + one mode + basic entry logic. Get valid results before complicating.
2. **Correlation first.** Low correlation is the primary value driver. If correlation ≥ 0.40, it's just DTE5-lite.
3. **Non-QQQ naturally decorrelates.** SPY, GLD, individual stocks, commodities.
4. **Different DTE naturally decorrelates.** 30-90 DTE credit spreads operate on a different theta curve than DTE5's 2-7.
5. **Short-vol and long-vol are structural opposites.** DTE5 is short-premium. Buying options is long-vol.
6. **Delta gate is a filter you must beat.** If your signals don't beat naive "buy every 5 days", they don't add alpha.
7. **Use `configVariants` to sweep.** Try many parameters in one runner invocation; one strategy.ts run can evaluate N parameter sets.
8. **Read the journal first.** Don't re-test what's already exhausted.

## Current status

Check `leaderboard-option3.json` for the running log.
Check `best-strategy-option3.ts` for the current champion.
Check `journal-option3.md` for the accumulated learnings.
