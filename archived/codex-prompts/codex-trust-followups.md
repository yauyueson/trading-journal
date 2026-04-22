# Codex Trust Findings — Outstanding Followups

Status as of 2026-04-15. Codex's adversarial review identified 11 trust issues plus a
named "next step" (phased path liquidity filters). Tier 1 fixes (benchmarks default
to bid/ask, phased path ORATS filters) shipped. Below are the remaining items grouped
by risk and effort.

## Tier 2 — Correctness fixes, test-breaking risk

These need careful review before patching because downstream consumers may depend on
current behavior.

### T2-1 — Intraday lookahead in `intraday-monitor.ts:236`

**Severity**: Critical (per Codex), but **does not affect autoresearch / h4-ts105**
because autoresearch uses daily monitoring (`monitoringIntervalDays: 1`).

**Bug**: Daily calibration runs whenever `barDate !== lastCalibratedDate`, which fires
on the *first* intraday bar of each new day, not the last. If ORATS chains are EOD
snapshots (which they are), this injects the day's settlement chain into intraday
exits — within-day lookahead.

**Files**:
- `src/lib/backtest/intraday-monitor.ts:236` — calibration trigger
- `src/lib/backtest/option-sim.ts` (and any other consumer) — verify whether
  intraday-monitor is wired anywhere production-relevant

**Fix sketch**:
```ts
// Replace: if ((config.dailyCalibration ?? true) && barDate !== lastCalibratedDate)
// With: trigger only on the LAST bar of the day
const isLastBarOfDay = candle.block === 1  // for candles_4h
  || (i + 1 >= bars.length || bars[i+1].date !== barDate);
if ((config.dailyCalibration ?? true) && isLastBarOfDay && !calibratedThisDay) {
  // ... existing calibration logic ...
  calibratedThisDay = true;  // reset on date change
}
```

**Validation**:
1. Identify all callers of intraday-monitor — any production strategies?
2. Add a regression test that asserts calibration fires at most once per day, on the
   last bar.
3. Diff backtest results before/after for any intraday-using strategy — magnitude
   tells you how much the lookahead was inflating Sharpe.

**Risk**: Could materially worsen reported Sharpe on intraday strategies. That's the
correct outcome but expect surprise.

---

### T2-2 — WFA v2/v3 OOS uses `config.endDate` (holdout leakage)

**Severity**: High (per Codex), but **does not affect autoresearch / h4-ts105**
because autoresearch uses `wfa-options.ts` directly, not the v2/v3 orchestrators.

**Bug**: `wfa-v2-orchestrator.ts:355` and `wfa-v3-orchestrator.ts:150` evaluate OOS
trades with `maxDate = config.endDate`, which includes the holdout window. Trades
opened in OOS can carry lifecycle PnL into the holdout period and bleed back into
selection metrics.

**Files**:
- `src/lib/backtest/wfa-v2-orchestrator.ts:355`
- `src/lib/backtest/wfa-v3-orchestrator.ts:150`

**Fix sketch**:
```ts
// Add a `wfaEndDate` (= holdoutStart - 1 trading day) and use it for selection-time
// evaluation. Compute lifecycle metrics separately if needed.
const wfaEndDate = computePreHoldoutEnd(config);  // last selection-window oosEnd
const oosTrades = evaluateWithConstraints(
  oosSignals, simConfig, maxPositions, maxPerTicker,
  deps.evaluator, deps.allTradingDates, wfaEndDate,  // was: config.endDate
);
```

**Validation**:
1. Find all WFA v2/v3 callers (any swing/shortTerm production code?).
2. Re-run the WFA studies in `backtesting history/` and diff metrics.
3. Add a unit test that constructs a window where a position would carry into
   holdout and asserts it's truncated at `wfaEndDate`.

**Risk**: Could change historical study results (swing/shortTerm). Those strategies
are retired, so this is mostly a code-quality fix.

---

### T2-3 — `strategy-recommend.js` HV30 dependency

**Severity**: High (per Codex), but **production API only** (not autoresearch).

**Bug**: Lines 1217–1218 use `oratsCores.orHv30d || oratsCores.clsHv30d` for RV30,
but per `docs/backtest-trust-gotchas.md` #13, ORATS cores doesn't provide HV30 —
both fields are always null. RV30 silently becomes null/NaN in production
recommendations.

**Files**:
- `api/strategy-recommend.js:1217`
- `lib/_shared/scoring.cjs` — must stay parity with `src/lib/oss-core.ts`

**Fix sketch**:
```js
// Remove HV30 path entirely. Use HV20 (which IS provided by ORATS) consistently.
// rv30 was never being computed anyway — this just makes the failure loud.
if (!oratsCores.hv20d) {
  console.warn(`[strategy-recommend] no HV20 for ${ticker} — RV proxy unavailable`);
  rv30 = null;
} else {
  rv30 = oratsCores.hv20d * 100;  // decimal → %
  // (Note: HV20 is annualized, not 30-day — rename or document mapping)
}
```

**Validation**:
1. Check if `rv30` is consumed downstream and what null/NaN does to recommendations.
2. Update `lib/_shared/scoring.cjs` symmetrically (parity tests must still pass).
3. Run `npx vitest run tests/scoring-parity.test.ts` after.

**Risk**: Live recommendations change. Run on real ticker set and diff before/after.

---

## Tier 3 — Methodology shifts, broader rework

These touch the metric computation core. Test failures expected; intentional.

### T3-1 — Full trading-calendar metrics in `computeOptionAnalytics`

**Severity**: High (per Codex). **For autoresearch / h4-ts105**: not biting in
practice because `monitoringIntervalDays=1`, but the bug exists in code and would
affect any future strategy with sparser monitoring.

**Bug**: `option-sim.ts:1585` builds `dailyDates` from `trades.flatMap(t => [...t.dailyMtM, t.exitDate])`. Days when no trade has an MtM entry get dropped from the
Sharpe/DD calc. With `monitoringIntervalDays > 1`, real flat days disappear,
overstating annualized Sharpe.

**Files**:
- `src/lib/backtest/option-sim.ts:1530-1620` — `computeOptionAnalytics`
- `src/lib/backtest/wfa-options.ts:315` — `computePortfolioDailyMetrics` (which
  already does this correctly — model the fix on it)

**Fix sketch**:
```ts
// Accept allTradingDates parameter; pad zero-PnL days
export function computeOptionAnalytics(
  trades: OptionTrade[],
  allTradingDates?: string[],   // NEW
  range?: { start: string; end: string },  // NEW
): OptionSimAnalytics {
  // ...existing trade-level metrics...

  if (hasDailyMtM && allTradingDates) {
    const calendarDates = allTradingDates
      .filter(d => (!range || (d >= range.start && d <= range.end)))
      .map(d => d.slice(0, 10));
    // Use calendarDates for dailyPnl array; flat days = 0
  }
}
```

**Validation**:
1. All callers must pass `allTradingDates` — find them with grep.
2. Decide on backwards compatibility: optional param means existing calls keep
   sparse behavior. Either deprecate sparse path or make the new behavior a
   separate function.
3. Re-run all WFA studies; expect Sharpe to drop modestly for any strategy with
   `monitoringIntervalDays > 1`.

**Risk**: Anywhere `computeOptionAnalytics` is consumed loses some Sharpe.
Autoresearch not affected (already daily). Historical study reports become stale.

---

### T3-2 — Block bootstrap on daily returns

**Severity**: Medium (per Codex). **For autoresearch / h4-ts105**: not affected
because `runner.ts:408` already implements `bootstrapSharpeCI` on daily returns
correctly. The broken `blockBootstrap` in `wfa-v2-stats.ts:329` is only used by the
v2 orchestrator path.

**Bug**: `wfa-v2-stats.ts:329` resamples trades sorted by exit date and computes a
trade-level Sharpe. Real autocorrelation lives in *daily* returns, not exit-day
trade returns. CI widths are misstated.

**Files**:
- `src/lib/backtest/wfa-v2-stats.ts:329` — `blockBootstrap`
- `src/lib/backtest/wfa-options.ts` — has `computePortfolioDailyMetrics` which
  derives daily returns; reuse

**Fix sketch**:
```ts
export function blockBootstrap(
  dailyReturns: number[],   // CHANGED from trades: OptionTrade[]
  nResamples: number = 10_000,
  blockSize?: number,       // default = sqrt(n)
  seed: number = 42,
): BootstrapResult {
  const n = dailyReturns.length;
  const block = blockSize ?? Math.max(2, Math.round(Math.sqrt(n)));
  // ... block bootstrap on daily returns ...
}
```

Caller migrates: derive daily returns via `computePortfolioDailyMetrics()` then call
the new signature.

**Validation**:
1. v2 orchestrator callers must adapt to new signature.
2. Add a test with a known autocorrelated series; verify CI widens vs i.i.d.
3. Old method survives as `tradeBootstrap` if anyone needs it for diagnostics.

**Risk**: Any v2 study report's CI numbers change.

---

## Recommended order

1. **T2-3 (HV30)** first — production API touches live recommendations every day.
   Smallest blast radius after Tier 1.
2. **T2-1 (intraday lookahead)** — Codex flagged Critical. Even if no current
   strategy uses it, the code is wrong and a future strategy will hit it.
3. **T2-2 (WFA holdout truncation)** — Code-quality fix. v2/v3 only used by
   retired studies, so low immediate impact.
4. **T3-1 (full calendar metrics)** — Pre-req for confidently running future
   strategies with sparse monitoring. Currently routed around.
5. **T3-2 (block bootstrap on daily)** — Stat methodology cleanup. Lowest urgency.

Each item should be a separate PR with its own backtest diff so regressions
attributable to the fix are visible.

## What this leaves untouched

The h4-ts105 trust review concerns I raised earlier are **not** in Codex's findings:
- Deflated Sharpe = −1.905 (645-attempt multiple-testing burden)
- 3,400 of 3,587 signals skipped (95% chain-coverage gap selection bias)
- Identical 27.1% MaxDD across top-10 valid variants (suspicious clustering)

These remain the genuine open questions about whether 1.346 combined Sharpe is real.
Codex's findings are about *simulator* trust; my concerns are about *statistical*
trust. Both matter; both are independent.
