# Hand audit: BCD QQQ wide F1 + PMCC QQQ pt60 F1 trade dumps against the raw ORATS chain cache

Date: 2026-11-06. Read-only on the repo and the data. Every number here was recomputed from `data-clone/option-chains.sqlite`, opened with `mode=ro&immutable=1`. The `-wal` file is 0 bytes, so the immutable read sees the same data the simulator saw.

## 0. Method and what actually runs

- **The trades do not come from `option-sim.ts`.** The autoresearch worker dispatches `DEBIT_SPREAD` to `makeDebitSpreadEvaluator` (`scripts/autoresearch/worker.ts:728-950`) and `DIAGONAL` to `makeDiagonalEvaluator` (`worker.ts:444-707`). `simulateDiagonal` in option-sim.ts (~line 919) is not on this path. Fills go through `applyFill` (`src/lib/backtest/slippage.ts`) with `DEFAULT_DYNAMIC_SLIPPAGE`: 2 bps base, oiHalfLife 500, maxOiFactor 6, dteAccel 7d ×3. Fill mode is `bidask`.
- **Which code produced the dumps.** `trades-full-*.json` came from `wt-head` (HEAD 5af4e32 plus a one-line dump hook in runner.ts). Its worker/sim/slippage/chain-cache/wfa-options files are byte-identical to the repo. The sealed-era worker in `wt-bcd`/`wt-pmcc` differs only by the later-added `debitStopLossPct` block. BCD F1 leaves that field unset, so the block is inert.
- **Replay.** I wrote an independent Python re-implementation of both evaluators: `audit/replay.py`, `audit/run_all.py`, `audit/quantify.py`, `audit/q2.py`, `audit/detail.py`, all under the scratchpad. It covers `findStrikeByDelta` (expiry with the largest call-OI sum, then closest delta), `findContractDirect`, `applyFill`, the monitoring loops, and the portfolio horizon (`maxDate = holdoutEnd = 2026-02-27`). I ran it on **all 123 trades**, not only the 10 sampled. Raw per-trade output is in `audit/detail.out`.

## 1. Headline

| | Result |
|---|---|
| Mechanical reproduction | **10/10 sampled trades, and 123/123 overall (84 BCD + 39 PMCC), reproduce from raw rows.** Strikes, expiry, entry fill, exit fill, exit date, exit type and pnl all match to ≤1e-6 per share (pnl ≤1e-4 $). BCD dailyMtM also matches 84/84. |
| Lookahead | None found. The decision on day *t* uses day-*t* ORATS rows, and the fill uses the same day-*t* row. No next-day data is used. |
| Semantic bugs found | **Two material problems, both caused by the cache only holding contracts with 0.01 ≤ δ ≤ 0.99** (see §4). (A) PMCC short calls that go deep ITM drop out of the cache. They are never settled, then booked at **$0 buy-back** at the long exit, and never re-rolled. (B) The BCD "FORCE_CLOSE" exit is really a missing-chain exit at a **stale 3-day-old mid, with no slippage**. |
| PnL impact | **PMCC holdout pnl $18,669 → ~$5,218** (−$13,451, −72%) once the vanished ITM shorts are settled at intrinsic. **PMCC OOS pnl $34,408 → ~$14,250** (−$20,158). These corrections do not credit the re-roll premium the sim also missed, so the true number is somewhat above the corrected one. **BCD holdout pnl $5,497 → ≤ ~$4,600** (≥ −$898). **BCD OOS pnl $7,165 → ≤ ~$5,280** (≥ −$1,885). The BCD bound treats the δ<0.01 short leg as free to close. |
| Dividend-adjusted candles | **Not used by any trade decision or trade field.** Entry and exit stock prices equal the chain `stock_price` (84/84, 39/39). The pin-roll trigger uses `shortContract.row.stock_price` (`worker.ts:568`). Candles only set signal dates and the trading calendar. |

## 2. Per-trade table (10 sampled + 2 boundary extras)

Conventions:
- "mid" is the ORATS `callValue` stored as `call_mid`. It is a smoothed theoretical value, **not** (bid+ask)/2.
- Fill formulas: buy = ask + 0.0002·mid·min(1+500/oi, 6)·dteF; sell = bid − same.
- ORATS `dte` = calendar days + 1.

### BCD (long δ0.50 / short δ0.20, DTE 30-60, PT = spreadMid − debit ≥ 0.5·maxProfit, min exit DTE 7, max hold 45 cal days)

| # | Period | Entry → Exit | Strikes / expiry (expiry menu → chosen by OI) | Entry raw quotes (long ; short) | Debit: recomputed / sim | Exit raw quotes (long ; short) | Exit value: recomputed / sim | PnL recomputed / sim | Trigger check | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| oos#0 | OOS | 2019-01-29 → 02-05 PT | 163/171, 2019-03-15 (OI 448k vs 74k/22k/2k) | 4.39/4.4245/4.44 oi12121 δ.485 ; 1.18/1.2517/1.20 oi3944 δ.215 | 3.2612 / 3.2612 | 9.93/9.92/9.99 ; 4.16/4.12/4.18 | 9.9279−4.1809 = 5.7470 / 5.7470 | +248.58 / +248.58 | PT level 5.6306. Max mark before exit 5.2956 (02-04), exit-day mark 5.8037 → first true on exit day | ✅ |
| oos#20 | OOS | 2020-09-28 → 11-12 FORCE_CLOSE (max-hold) | 279/306, 2020-11-20 | 13.19/13.23/13.27 oi785 δ.500 ; 3.18/3.20/3.22 oi229 δ.200 | 10.0964 / 10.0964 | 10.78/10.86/10.95 ; 0.16/0.17/0.18 | 10.5974 / 10.5974 | +50.10 / +50.10 | 11-12 is 45 calendar days after entry; PT (18.548) never hit, max 16.52 on 11-06; DTE 9 > 7 | ✅ (the only true max-hold FORCE_CLOSE of 26) |
| hol#0 | Holdout | 2024-02-14 → 03-11 TIME_STOP | 436/452, 2024-03-15 (OI 944k) | 7.49/7.50/7.52 oi6525 δ.492 ; 1.94/1.95/1.96 oi33965 δ.194 | 5.5820 / 5.5820 | 5.29/5.33/5.37 ; 0.34/0.34/0.35 | 4.9381 / 4.9381 | −64.39 / −64.39 | dte on 03-08 = 8 (>7); 03-11 dte = 5 → first ≤7. PT 10.791 never hit (max 9.69) | ✅ |
| hol#2 | Holdout | 2024-04-26 → 05-20 PT | 435/459.78, 2024-06-21 (OI 835k) | 12.19/12.20/12.23 oi29486 δ.518 ; 2.99/3.00/3.01 oi7246 δ.200 | 9.2431 / 9.2431 | 23.76/23.87/23.94 ; 6.30/6.32/6.33 | 17.4238 / 17.4238 | +818.07 / +818.07 | PT level 17.0116. Max before 16.577 (05-15), exit-day 17.550 | ✅ (strike 459.78 is a real adjusted-strike row, see §5) |
| hol#5 | Holdout | 2024-07-10 → 07-26 FORCE_CLOSE (missing-chain) | 505/530, 2024-08-16 | 10.58/10.58/10.62 oi21135 δ.524 ; 2.11/2.12/2.14 oi2083 δ.188 | 8.5127 / 8.5127 | short row absent 07-24/25/26 (δ<0.01). Long on 07-26: 0.33/0.34/0.34 | stale 07-23 mid 1.6821 / 1.6821 (no fill) | −683.06 / −683.06 | Replicates. **But exit is 3-day-stale mid with no slippage.** Realistic exit ≤ 0.33 (long bid; short ≈0) → pnl ≤ −818 | ⚠️ reproduces; bias of ≥ $135 in sim's favor |
| (extra) hol#24 | Holdout | 2026-02-27 → 02-27 FORCE_CLOSE (window end) | 610/641, 2026-04-17 | 17.53/17.56/17.59 ; 3.93/3.96/3.98 | 13.6655 / 13.6655 | none | = debit | 0 / 0 | Entry on the last calendar day; zero monitoring days | ⚠️ phantom 0-pnl trade, inflates holdout count 24→25 |

### PMCC (LEAP δ≈0.75, DTE 240-300; short δ≈0.25, DTE 30-45; long PT +60% / SL −35% / time-stop DTE ≤90 on ORATS mid; short PT 50% of credit; pin-roll if dte≤2 and |S/K−1|≤2%)

| # | Period | Entry → Exit | LEAP (raw entry quote → buy fill rec / sim) | Long exit (raw → sell fill rec / sim) | Short cycles (recomputed = sim for every cycle, credit / cost / reason) | PnL rec / sim | Trigger check | Verdict |
|---|---|---|---|---|---|---|---|---|
| oos#16 | OOS | 2022-02-23 → 05-09 STOP_LOSS | 285 Dec-22, 62.19/62.77/63.39 oi1213 → 63.4077 / 63.4077 | 05-09 mark 37.825 (ret −40.3%); 37.66/37.99 oi1274 → 37.6495 / 37.6495 | 7 cycles incl. **ASSIGNED** (339, exp 2022-04-14, row present at dte 1, S 339.20 → cost 0.205 = intrinsic). The last cycle was force-closed at ask+impact 2.2806 | −882.61 / −882.61 | Min long ret before exit −28.7% (05-06); 05-09 first ≤ −35% | ✅ |
| hol#0 | Holdout | 2024-03-01 → 04-19 STOP_LOSS | 415 Dec-24, 60.19/60.42/60.59 oi566 → 60.6128 / 60.6128 | mark 36.163 (ret −40.3%); 35.94/36.37 oi405 → 35.9238 / 35.9238 | 5 cycles, all PROFIT_TARGET rolls. E.g. cycle 3: 455 credit 4.2191, closed 04-17 at 1.3003 | −1383.47 / −1383.47 | Min ret before exit −29.2% (04-18) → first breach 04-19 | ✅ |
| hol#1 | Holdout | 2024-04-19 → 06-10 PROFIT_TARGET | 379.78 Dec-24, 59.09/59.85/60.58 oi4731 → 60.5932 / 60.5932 | mark 97.991 (+61.7%); 97.81/98.22 → 97.7883 / 97.7883 | **1 cycle: 434 exp 2024-05-24, credit 3.7854, cost 0.0000, "FORCE_CLOSE".** Last row 05-22 mid 20.97 (δ .977). Rows absent 05-23/05-24 (δ>0.99). At expiry S = 457.81, so the true assignment cost is 23.81 | 4098.05 / 4098.05 | Max ret before exit +0.600 on 06-06 (just under +0.60), exit day +0.617 | ❌ **Reproduces, but sim is wrong: −$2,381 omitted.** No new short for the 10 trading days after expiry |
| hol#2 | Holdout | 2024-06-10 → 12-04 PROFIT_TARGET | 433 Mar-25, 61.02/61.28/61.55 **oi17** → 61.6235 / 61.6235 | mark 98.993 (+60.6%); 98.81/99.17 → 98.7596 / 98.7596 | 6 cycles. Cycle 0 **PIN_ROLL**: 480 exp 07-19, closed 07-18 at dte 2, raw S 479.88 → |S/K−1| = 0.0002 ✓, cost 2.6213 = ask+impact. Cycles 1-4 PT. **Cycle 5: 475 exp 2024-10-18, credit 4.2691, cost 0.** Last row 10-16 mid 16.20. S at expiry 494.23 → true cost 19.23 | 5249.15 / 5249.15 | Long max before exit +50.7%. Pin roll fired on the first dte≤2 day | ❌ **Reproduces, but −$1,923 omitted.** Uncovered for 32 trading days |
| hol#10 | Holdout | 2026-02-27 → 02-27 "TIME_STOP" | 545 Dec-26, 98.34/100.10/101.44 → 101.4691 / 101.4691 | No monitoring days. Long "exit" = sell at entry-row bid with slippage → 98.2514 | 1 cycle opened and bought back the same day: 4.2882 / 4.3318 | −326.14 / −326.14 | maxDate = entry date | ⚠️ phantom round-trip trade. The label TIME_STOP is wrong (it is a window-end close, and hol#9 is the same). It counts as a new holdout trade |

**Tally: 10/10 sampled trades reproduce exactly from raw rows.** Discrepancies with economic reality, as opposed to with the code, are flagged ⚠️/❌ above and quantified in §4.

## 3. Gotcha checklist

| Gotcha | Applies? | Evidence from these trades |
|---|---|---|
| #3 Mid fills | Mostly no, **partial regression** | Entries and triggered exits use bid/ask + impact (every sampled fill reproduces the formula). **But the BCD missing-chain FORCE_CLOSE (`worker.ts:819-825`) and the window-end FORCE_CLOSE (`worker.ts:921-925`) book `last.spreadMid`.** That is the ORATS theoretical mid, with no spread or impact, and 3 trading days stale. This hits 24 of 84 BCD trades (17 OOS, 7 holdout). |
| #24 MtM at fair value | Complies | BCD dailyMtM = long mid − short mid (84/84 match). PMCC long marks = `call_mid`, and short marks = mid. Slippage is only realized at the fills. Caveat: the PMCC combined MtM drops a vanished short's mark to 0 (`openShortMarkByDate` stops at its last row). Equity jumps up by the short's ITM value on that day, which inflates daily Sharpe as well as trade pnl. |
| #28 Carry reset at selection/holdout boundary | Fixed / does not apply | A single `evaluateOnWindows` pass. BCD oos#58 (entered 2024-01-17, exited 2024-02-02) and PMCC oos#27 (2023-12-11 → 2024-03-01) straddle the 2024-01-22 boundary, are evaluated with `maxDate = 2026-02-27`, and are not truncated. |
| #29 Holdout equity seeding | Not testable from trade logs | Trade-level pnl is independent of seeding. No evidence either way; that needs the runner's metrics, which I did not check here. |
| #30 Carry-only holdout pass | Does not apply, with a counting caveat | 25 BCD and 11 PMCC new holdout entries. However, the count includes the **same-day phantom entries** on 2026-02-27 (BCD hol#24 pnl 0; PMCC hol#10 −$326 round-trip). Each strategy also has a window-end close mislabeled as a strategy exit: BCD FORCE_CLOSE, and PMCC hol#9/#10 "TIME_STOP" from `longExitReason`'s default (`worker.ts:523`). |
| #42 Diagonal long exit used ±$0.05 synthetic spread | Fixed | Every PMCC long exit sells at the real `call_bid` from the last observed row, e.g. hol#0 35.94/36.37. The sell fill reproduces to 1e-6. **But the PMCC short "Settle open short at long exit" (`worker.ts:626-631`) uses `buyBackCost = 0` when the row is missing.** That is a sibling of #42 with a much larger impact (§4A). |
| #43 NULL/NULL fetch_log treats any range as covered | **Applies, in a strike-level form** | 1,804 of 1,913 QQQ fetch_log rows since 2019 are NULL/NULL (dte unbounded). The DTE coverage itself is fine, and every candle date 2019→2026 has chain rows. **But every QQQ trade date only holds contracts with 0.010 ≤ δ ≤ 0.990** (checked on 2019-03-01, 2020-03-03, 2024-05-23, 2025-04-10). The cache was fetched with a delta filter. So "covered" does not mean that every strike/expiry exists. Short-dated deep-ITM and deep-OTM contracts are missing, and they appear and disappear day to day as δ crosses 0.99/0.01 (e.g. 434C exp 2024-05-24: present 05-20, absent 05-21, present 05-22, absent 05-23/24). This is the root cause of §4A and §4B. |

## 4. Material findings

### A. PMCC: deep-ITM short calls vanish and are settled at $0 (favorable bias, large)

The mechanism, in `worker.ts:556-640`:
1. Expiry settlement (`d >= curShort.expiry` → ASSIGNED/EXPIRATION) only runs if a row exists for the short on or after expiry day. ORATS has no post-expiry rows, and expiry-day rows exist only for 0.01<δ<0.99. Only **1 of 152** short cycles ever reached ASSIGNED, and **0** reached EXPIRATION.
2. The pin roll only fires for |S/K−1| ≤ 2% at dte ≤ 2. A short that is more than 2% ITM is never rolled or closed.
3. Once the row disappears, `curShort` stays set forever. No new short is sold for the rest of the LEAP's life. At the long exit, `closingContract` is null, so `buyBackCost = 0`, recorded as reason FORCE_CLOSE.

There are 18 occurrences: 13 OOS cycles and 5 holdout cycles (hol#1, #2, #5, #6, #7). Of these, 15 expired ITM and 3 were still alive but missing at the long exit (oos#13, oos#24, hol#5). Every one of them is on a PROFIT_TARGET trade, the trades where QQQ rallied through the short strike. Settling each at its own ASSIGNED rule, intrinsic = max(0, S_expiry − K) from the chain `stock_price`:

| Period | Sim pnl | Corrected (no re-roll credit) | Δ |
|---|---|---|---|
| OOS | $34,408 | $14,250 | −$20,158 |
| Holdout | $18,669 | $5,218 | **−$13,451** |

The worst single case is hol#5: short 460, still alive at the long exit 2025-05-13 with S = 516.61 and a last mid of 29.14 on 05-09. $5,661 is erased, which turns a +$5,955 trade into roughly +$294.

The correction overstates the damage somewhat: the missed re-rolls during 4-48 uncovered trading days would have collected roughly $3-5/share of premium per month. **It does not change the sign of the conclusion: the sealed PMCC holdout Sharpe/IR rest on pnl that is inflated by roughly 2-3×.** The daily equity curve is also wrong (see #24 caveat).

### B. BCD "FORCE_CLOSE" = missing-chain exit at a stale mid with no slippage (favorable bias, moderate)

- 25 of 26 BCD FORCE_CLOSEs in the dumps (17/18 OOS, 7/8 holdout), plus hol#24's window-end close, are not max-hold exits. They come from `missingChainExitAfterDays = 3`.
- Every one is a loser whose **short leg dropped below δ 0.01**, so its row disappeared. Hol#11 lost both legs.
- The sim books the spread at the last-available mid, 3 trading days earlier, with no bid/ask.
- On the actual exit day the long leg's row is present. For example hol#1: stale mark 3.912 vs a long bid of 0.11 at dte 3.
- Upper bound on a realistic exit = sell the long at bid+impact and close the short at 0. That gives OOS −$9,994 → ≤ −$11,879 (≥ $1,885 bias) and holdout −$4,230 → ≤ −$5,069 (≥ $839 bias, plus ≤ $59 on hol#11).
- The MtM loop also skips PT/TS/max-hold evaluation on the missing days, e.g. oos#7 skipped 4 non-consecutive days.

### C. Window-boundary artifacts

- Entries on the final calendar day 2026-02-27 create zero-length trades: BCD hol#24 at +$0, PMCC hol#10 at −$326 (pure round-trip slippage).
- PMCC hol#9 (exited 2026-02-27, DTE 204) and hol#10 carry exitType **TIME_STOP** even though they are horizon closes. BCD labels the same thing FORCE_CLOSE.
- The PMCC horizon long exit is filled with slippage, but the BCD horizon exit is not.

## 5. Dividend-adjusted candles (coordinator item)

- **Inside the evaluators, nothing reads candle close.** BCD uses chain `dte`, `call_*` and `row.stock_price` for exitStockPrice (`worker.ts:836`). PMCC's pin-roll moneyness uses `shortContract.row.stock_price` (`worker.ts:568`), assignment uses `shortContract.row.stock_price` (`worker.ts:581`), and entry/exit spot come from chain rows.
- Recorded entryStockPrice equals the chain `stock_price` for 84/84 BCD and 39/39 PMCC trades. The candle close sits 4.2-4.7% below raw in 2019, ~0.3% below in late 2025, and ~0 in 2026.
- Candles only drive (a) signal dates (`data.candles[i].date`) and (b) `allTradingDates`, which is dates only and has a chain row on every date from 2019 onward.
- **Counterfactual, for scale.** If the pin-roll had used candle close, **8 of the 13** dte≤2 roll checks across all PMCC cycles would have flipped:
  - 4 real pin rolls would not have fired: oos#1 2019-05-02, oos#3 2019-07-25, oos#10 2020-10-22, oos#13 2021-09-16.
  - 4 non-rolls would have fired: oos#8, #9, #16, #23.
  - Example from hol#2 cycle 0: raw S 479.88 vs K 480 → 0.02%. The candle close 475.08 would give 1.03%, which still triggers. In 2019-2021 the gap is large enough to matter.
- Since the sim uses raw prices, this is **not a live defect for these trades**. It would become one if anyone routes candle closes into moneyness logic. The naive-baseline and SPY-IR computations in runner.ts do use the adjusted candles, which is appropriate for a total-return benchmark.
- **Cosmetic:** strikes like 459.78 / 379.78 / 474.78 are post-dividend-adjusted contract strikes present as real ORATS rows. They are valid, not a bug.

## 6. Other anomalies

- **ORATS "mid" can sit outside the quote.** `call_mid` is ORATS `callValue` (theoretical; `chain-cache.ts:527`), not (bid+ask)/2. Examples:
  - BCD oos#3 long leg on 2019-05-15: bid 0.19 / "mid" 0.22 / ask 0.21.
  - PMCC hol#0 cycle-3 exit row: bid 1.29 / "mid" 1.3231 / ask 1.30.
  - In both cases the "mid" is above the ask.

  PT, SL and time-stop triggers, and all MtM, run on this theoretical value. For the sampled trades the trigger dates were not marginal: the PMCC hol#1 long PT crossed +0.600 on 06-06 by a hair below the threshold and fired on 06-10 at +0.617. Still, PT/SL decisions are made on a model price, not a tradable quote.
- **Bid > ask: none in the sampled rows.** `applyFill` clamps the spread at ≥0 anyway.
- **Thin LEAPs.** PMCC hol#2's long has OI 17, so the OI factor caps at 6×. The impact is still only ~$0.07, because base impact is 2 bps × mid. The fill is effectively ask + $0.07 on a $61 option with a 0.53 spread.
- **BCD field naming.** In `full`, `strike` is the **long** (bought) leg and `longStrike` is the **short** (sold) leg, deliberately reused (`worker.ts:934-935`). Anyone reading the dumps naïvely will invert the spread.
- **The expiry choice is "max total call OI", not nearest-monthly.** In the samples it always picked the monthly third-Friday expiry, e.g. 2024-06-21 with OI 835k over 2024-05-31 with OI 20k. Also, `findStrikeByDelta` is run separately for the long and short legs. If they choose different expiries, the short leg is retried at the exact long DTE. None of the samples needed that retry.
- **Same-day exit-and-re-enter is allowed.** `retireClosedPositions` uses `exitDate <= signalDate`, e.g. PMCC oos#5 exited 2020-02-28 and oos#6 entered 2020-02-28. Under the same-snapshot fill assumption that is consistent, not lookahead.
- **No-lookahead confirmation.** Signals come from candle index only (fixed cadence / always-in), so no data informs entry. Entry fills use the signal-date ORATS snapshot. Every exit trigger and its fill use the same day-*t* row. The PMCC re-roll uses the day-*t* chain for the new short. No field anywhere reads t+1.

## Files
- `audit/replay.py`: independent Python replay of both evaluators.
- `audit/run_all.py`: replays all 123 trades and compares them.
- `audit/quantify.py`, `audit/q2.py`: candle check, BCD missing-chain bounds, PMCC vanished-short settlement.
- `audit/detail.py` → `audit/detail.out`: raw-row detail for the sampled trades plus the pin-roll counterfactual.
