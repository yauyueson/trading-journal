# Reproduction audit: BCD QQQ wide F1 + PMCC QQQ pt60 F1 seals (2026-11-06)

Ledger-free replay of the two 2026-04-23 sealed adoptions, run on the same data they were sealed on: no forward data, no paper-fill comparison, no new trial-ledger entries, no re-seal, no governance or manifest changes. It also fixes and re-runs the 2026-05-07 cache-only clean-sheet validation.

## Verdict

1. **Reproduction: MATCH.** Replaying the runner at the seal commits reproduces every performance field in both audit rows to the last floating-point digit. That covers oosSharpe, holdoutSharpe, holdoutSpyIR, trade counts, PnL, max drawdown and exit breakdown. The trade lists are identical at the seal commits and at HEAD `5af4e32`. The data and code still produce exactly the sealed numbers.
2. **Correctness of those numbers: NOT CLEAN.** An independent recompute from raw chain rows reproduces all 123 trades mechanically: strikes, fills and exit dates match to ≤1e-6 per share, and no lookahead was found. It also exposed two simulator bugs that flatter the sealed PnL, plus end-of-window artifacts:
   - **PMCC (large):** 18 short calls that went deep ITM vanished from the cache and were booked at **$0**. Settled at intrinsic, holdout PnL falls from $18,669 to about $5,218 and OOS PnL from $34,408 to about $14,250. These are upper bounds on the bias, because the re-roll premium the sim also missed is not credited back. New gotcha #44.
   - **BCD (moderate):** 25 of 26 `FORCE_CLOSE` exits are missing-chain exits at a 3-day-old mid with no slippage. Corrected, holdout PnL is at most about $4,600 (was $5,497) and OOS at most about $5,280 (was $7,165). New gotcha #45.
   - The sealed Sharpe, IR and dsrM figures were therefore computed on inflated PnL. They were **not** recomputed here: that needs a simulator fix plus a governed re-evaluation, which is outside this audit's scope (see "Not done").
3. **Capital mismatch matters for one gate.** At the governance tiers ($5K BCD / $20K PMCC) instead of the strategy-file capital ($2K / $10K), the trades are identical, but PMCC holdoutSpyIR falls from +0.149 to **−0.153**, which would fail the `holdoutSpyIR >= 0` gate.
4. **May-7 validation, corrected.** The intraday loader bug (gotcha #46) is fixed. The cache-only validation now holds out exactly the manifest window and reproduces the seal metrics exactly. Its SPY IR is higher only because it benchmarks against SPY without dividends.

## Inputs (main checkout, read-only; hashed before and after, unchanged)

`inputs-before.txt` and `inputs-after.txt` are byte-identical after their header lines (SHA256, mtime and size, plus combined hashes of `data/trial-ledger/` and all leaderboards).

| File | SHA256 | Size |
|---|---|---:|
| `scripts/autoresearch/data-cache.json` (generated 2026-04-18) | `5b1d792c2215350fb49573510877d754d07a594e4c26e0bcd926158b1396ae22` | 11,264,194 |
| `data/option-chains.sqlite` | `68f186069e81b21655ee0f79f925a508aa7c8a5f0398f7c6aba11a0d34c24e50` | 17,767,333,888 |
| `data/intraday-candles.sqlite` | `2ecdb5d2c374793e3f17d956ad38c43bc62d9faca8cca174d909ff4eeee2fd58` | 45,731,840 |
| `config/dataset-manifest.json` | `4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9` (= seal holdout window hash) | 959 |
| `config/adoption-gates.json` | `8b8830e7b655ee9c1f30664ae8dd1fe3d63fd2d037c4922b0ff85774e7c49f09` (= audit-row raw hash) | 1,999 |
| `data/attempts-global.json` | `4935e7c25f7b895ff7508855571ada55ff94a61ea4c6485bed55846b984d689f` (untouched) | 49,321 |
| `data/trial-ledger/` (90 files), 51 leaderboard files | combined `a163d5c1…`, `b51df0be…` (untouched) | |

The option-chains SQLite includes the uncommitted 2026-08-13 backfill (2026-03-09 → 08-11). That is outside `DATA_END = 2026-02-28`, and the replay's `tickerCoverageHash` (`df22a73b…`) equals the seals', so the backfill did not affect these results.

## Isolation and commands

- Throwaway `git worktree`s under the session scratchpad: `wt-bcd` at `e67a3a8c` (BCD seal commit), `wt-pmcc` at `eb3a3c9d` (PMCC seal commit), and `wt-head` at `5af4e32`. Ledger, leaderboard and audit-row writes landed there and were discarded.
- The SQLite inputs were APFS copy-on-write clones (`cp -c`), symlinked into each worktree, so the main checkout's files could not be written. `data-cache.json` was copied.
- Supabase was pointed at `http://127.0.0.1:9` and the ORATS/Tiingo tokens were unset, so any fallback fetch would have failed loudly. None happened: every run loaded 2,301 QQQ candles and 2,300 SPY returns from `data-cache.json`.
- Command (`run-repro.sh`):
  `AUTORESEARCH_LEADERBOARD_SUFFIX=<bcd-qqq-wide-f1|pmcc-qqq-pt60-f1> AUTORESEARCH_STRATEGY_FILENAME=<strategy-…-f1.ts> AUTORESEARCH_PREREG_BYPASS="repro 2026-11-06" npx tsx scripts/autoresearch/runner.ts`
- Runtime: Node **v24.11.1**. The system Node 26.8.1 cannot load `better-sqlite3` 12.6.2 because of a V8 API change. The native module was rebuilt only in this worktree's `node_modules`.
- Trade lists came from `SAVE_TRADES=1`. That hook does not exist at the seal commits, so it was patched into the throwaway runners as an output-only addition, run separately after the pure runs.

## Seal vs reproduction

All performance fields match exactly (|Δ| < 1e-9) at the seal commit and at HEAD:

| Field | BCD seal | BCD repro | PMCC seal | PMCC repro |
|---|---:|---:|---:|---:|
| oosSharpe | 0.97058 | 0.97058 | 1.72381 | 1.72381 |
| holdoutSharpe | 1.22300 | 1.22300 | 1.62927 | 1.62927 |
| holdoutSpyIR | +0.39479 | +0.39479 | +0.14901 | +0.14901 |
| oosTrades / holdoutTrades | 59 / 25 | 59 / 25 | 28 / 11 | 28 / 11 |
| oosTotalPnl | 7,164.65 | 7,164.65 | 34,407.66 | 34,407.66 |
| oosMaxDD % | 39.78 | 39.78 | 17.52 | 17.52 |
| exitTypeBreakdown (OOS) | PT 30 / TS 11 / FC 18 | same | PT 16 / SL 12 | same |
| Mertens SE / skew / kurt | 0.42907 / −0.132 / 7.60 | same | 0.43195 / 0.736 / 11.27 | same |
| signalsGenerated / skippedNoChain | 225 / 141 | same | 2241 / 2202 | same |
| tickerCoverageHash | df22a73b… | same | df22a73b… | same |

Expected differences:
- `attemptNumber` and `deflatedSharpeMertens`: the replays used an empty ledger by design. Recomputing dsrM from the reproduced Mertens SE with `deflatedSharpeAt` gives the sealed values exactly: BCD +0.0654 at F0-effective N=30 (−0.1712 at global N=136), and PMCC +0.8445 at N=25 (+0.5798 at N=131).
- `statConsistencyRatio`: the bootstrap CI is unseeded (`Math.random`). The seal's own three identical PMCC runs gave 1.147 / 1.017 / 1.028, and the replays gave 1.033 / 1.017 / 1.031 / 1.020. The gate limit is 5.0, so this never affects the pass/fail outcome.

## Hand-checked trades (independent recompute from raw chain rows)

The full write-up is in `hand-audit/hand-audit.md`; the scripts are in `hand-audit/*.py` and the raw output in `hand-audit/detail.out`. They were written by an independent reviewer who re-implemented both evaluators in Python (BCD: `makeDebitSpreadEvaluator`; PMCC: `makeDiagonalEvaluator`, both in `scripts/autoresearch/worker.ts`) against the read-only chain clone.

- **Mechanical reproduction:** the 10 sampled trades (5 BCD, 5 PMCC, covering every exit type, ≥2 holdout each) reproduce exactly, as do all 123 trades. Strikes, expiries, fills, exit dates and PnL match to ≤1e-6 per share. Each PT/SL trigger first became true on the exit date. Decisions and fills use the same day's row, with no lookahead.
- **Gotcha checklist:** #24 OK. #28 OK (trades crossing into the holdout are not truncated). #29 cannot be checked from trade logs. #30 OK, but the counts include zero-length artifacts (below). **#3 partly undone** by the BCD missing-chain exit (#45). **#42's sibling on the short leg** is #44. **#43 applies at the strike level:** the cache only holds contracts with 0.01 ≤ |δ| ≤ 0.99, which causes both #44 and #45.
- **Dividend-adjusted candles:** `data-cache.json` closes are dividend-adjusted (QQQ ~6.6% below raw in Jan 2017, SPY ~15.9%). No trade decision or trade field uses them. Entry/exit stock prices equal the chain `stock_price` in 84/84 BCD and 39/39 PMCC trades, and the pin-roll trigger uses chain `stock_price` (`worker.ts:568`). Candles only set signal dates and the trading calendar.

Verified in code by the author of this report:
- **#44 PMCC:** `worker.ts:557` skips marking, expiry settlement and the PT check when the short row is missing. `worker.ts:626-631` then books `buyBackCost = 0`. I confirmed the 18 zero-cost `FORCE_CLOSE` cycles directly. Example: holdout #1 sold the 434 call on 2024-04-19 (expiring 2024-05-24, where spot was 457.81, so intrinsic was 23.81) and booked it at $0 on 2024-06-10.
- **#45 BCD:** `worker.ts:816-825` books `last.spreadMid` after 3 missing days, with no fill model. Holding periods of the 26 FC exits range from 0 to 47 calendar days, and only one is a genuine max-hold exit.
- **End-of-window artifacts:** entries on 2026-02-27, the last day, create zero-length trades that count as new holdout trades (BCD holdout #24 at $0, PMCC holdout #10 at −$326). PMCC labels its window-end closes `TIME_STOP`.

## Capital: strategy file vs governance tier

Ledger-free variants in `wt-head`, changing only `startingCapital`:

| | BCD $2K (sealed) | BCD $5K | PMCC $10K (sealed) | PMCC $20K |
|---|---:|---:|---:|---:|
| trades / PnL | 59+25 / $7,164.65 OOS | identical | 28+11 / $34,407.66 OOS | identical |
| oosSharpe | 0.971 | 0.884 | 1.724 | 1.667 |
| holdoutSharpe | 1.223 | 1.198 | 1.629 | 1.624 |
| oosMaxDD % | 39.8 | 28.7 | 17.5 | 13.4 |
| holdoutSpyIR | +0.395 | **+0.060** | +0.149 | **−0.153** |

Sizing is fixed at one contract, so the capital gate (`wfa-options.ts:318`) never bound at the lower capital, and trades and PnL are unchanged. With more capital, more of it sits idle at a 0% cash yield, so excess return over SPY shrinks. **At the $20K governance tier, PMCC would fail `holdoutSpyIR >= 0`.** BCD still passes every gate at $5K. This is a Model Risk / Risk Manager question and was not acted on here.

## 2026-05-07 clean-sheet validation: old vs corrected

Bug (gotcha #46): `loadDailyCandlesFromIntradayCache` grouped 1h bars by UTC date with no session filter. Since ~2024-03 the vendor stores extended-hours bars, which produced phantom Saturdays and after-hours closes. Before 2024-03 the vendor stores **full regular-session bars on NYSE holidays** (e.g. 2017-12-25, 2018-12-05). The result was 2,405 QQQ dates instead of 2,301, which pushed the 5-window holdout start to 2023-11-02.

Fix (`scripts/wfa-local-cache.ts`; tests written first in `tests/wfa-local-cache.test.ts`): bucket bars by America/New_York date from the UTC `datetime` column, keep only bars opening in [09:00, close) ET (close 13:00 on early-close days, else 16:00), and drop weekends plus a rule-based NYSE holiday calendar with the special closures 2018-12-05 and 2025-01-09. `scripts/qqq-clean-sheet-validation.ts` now takes its data range from the manifest, throws if a holdout window falls outside the manifest holdout (the same guard as `runner.ts:1088`), and writes dated outputs, refusing to overwrite.

Loader check against the runner's reference series (`loader-vs-runner-cache-check.json`): **2,301/2,301 dates for both QQQ and SPY**, with no missing or extra dates. The reference closes are dividend-adjusted, so closes were compared as daily returns: median |Δr| is 1.9 bp for QQQ and 1.3 bp for SPY, p99 is 23 bp / 41 bp. The largest gap is a one-day vendor print on 2017-06-27 that reverts the next day. Known limit: in post-2024 data the 09:00 ET bar includes 09:00–09:30 pre-market, which can affect daily open/high/low but not the close.

| | May-7 (buggy loader) | Corrected 2026-11-06 | Runner seal |
|---|---|---|---|
| Selection / holdout OOS | 2019-01-02→2023-11-01 / **2023-11-02**→2026-02-28 | 2019-01-17→2024-01-19 / **2024-01-22**→2026-02-27 | holdout 2024-01-22→2026-02-28 |
| BCD sel trades / Sharpe | 55 / 0.80 | **59 / 0.9706** | 59 / 0.9706 |
| BCD hold trades / Sharpe | 23 / 1.14 | **25 / 1.2230** | 25 / 1.2230 |
| BCD hold SPY IR | 0.44 | 0.4766 (0.3948 with adjusted SPY) | 0.3948 |
| PMCC sel trades / Sharpe | 27 / 1.61 | **28 / 1.7238** | 28 / 1.7238 |
| PMCC hold trades / Sharpe | 11 / 1.84 | **11 / 1.6293** | 11 / 1.6293 |
| PMCC hold SPY IR | 0.20 | 0.2600 (0.1490 with adjusted SPY) | 0.1490 |

The remaining IR gap comes entirely from the benchmark. The validation script builds SPY returns from raw intraday closes, which leave out dividends, while the runner uses dividend-adjusted closes. Re-running the corrected validation with the runner's SPY series, in a throwaway worktree, gives exactly the sealed IRs. **The validation script therefore overstates holdout IR by about 0.08–0.11.** I flagged this rather than fixing it, because cache-only mode has no dividend source in the intraday cache.

Outputs: `docs/wfa/QQQ-CLEAN-SHEET-VALIDATION-RESULTS-2026-11-06.md` and `qqq-clean-sheet-validation-2026-11-06.json` (in this folder; `data/runs/` is gitignored). The 2026-05-07 artifacts were not touched.

**Why the May-7 JSON and MD cite different coverage/quality SHAs.** The gitignored `data/runs/qqq-clean-sheet-validation-2026-05-07.json` (mtime 2026-05-07 10:30 ET) cites `3abe4a82…` / `7251a565…`. The committed MD cites `a88c548f…` / `5fa5cba2…`, which match the committed `docs/data-coverage/2026-05-07-cache-only-coverage.json` and `docs/data-quality/2026-05-07-wfa-cache-quality.json`. Those two reports were regenerated after the JSON was written: their embedded `generatedAt` is 16:49 UTC (12:49 ET). Because they embed a timestamp, regenerating them changes their SHA even when the data is the same. The committed MD came from a later validation run in another checkout; the MD and both reports share the 14:21:43 ET mtime of the PR #36 merge. The main checkout's gitignored JSON was never refreshed. The metrics in the JSON and the MD are identical, and the script only cites these SHAs (`latestArtifact`); it never reads the files for computation.

## Review status

- Codex adversarial review of the loader fix: **not run.** Codex CLI 0.151.0 rejects its configured model (`gpt-6.1-sol`) and also `gpt-5.4`, `gpt-5.2` and `gpt-5` for this ChatGPT account (HTTP 400, `model_not_found`). Codex config was not modified. The review prompt is reusable once Codex works again.
- Stand-in: an independent Claude reviewer with fresh context reviewed the code, not my conclusions. **No blocking issues.** It independently confirmed:
  - The NYSE calendar is correct for 2016–2027.
  - Every bar the calendar drops as a holiday is a flat, zero-volume vendor forward-fill, across all 15 cached tickers. No non-holiday weekday is flat.
  - Every trading day has exactly 7 session bars, or 4 on early closes, including DST switch days.
  - Tests pass under `TZ=Pacific/Auckland`.
  - The new loader's holdout windows match the manifest exactly.

  Applied from its should-fix list:
  - The validation now also requires the holdout to **start** at the first trading day on or after the manifest holdout start, which is stricter than `runner.ts`. `runner.ts` itself is unchanged.
  - The loader docstring now states the post-2024 pre-market caveat for open/high/low.
  - The validation output records the dataset manifest SHA256.
  - `CLEAN_SHEET_RUN_DATE` is validated.

  Not applied (follow-ups):
  - The same UTC-date bucketing bug exists in `scripts/wfa-cache-quality.ts:85-93` (one of the three citeable audits) and in the `candles_130m` SQLite view used by `wfa-pipeline-short.ts`, which also ignores DST and holidays.
  - The runner's own one-sided holdout guard. That is adoption-gate code and needs Codex.
  - The validation report does not hash the SQLite inputs; this README records them.

## Tests

`npx tsc --noEmit` is clean. `npm run test`: 71 files, **1349 passed, 2 skipped**, on Node 24.11.1.

## Not done (out of scope; needs governance routing)

- No fix to #44 or #45, and no re-evaluation of either seal with corrected settlement. That would be a simulator change on the adoption path, which needs Codex review and human sign-off, and any re-evaluation would be a new trial.
- No change to the strategy-file capital ($2K / $10K) vs the governance tiers ($5K / $20K).
- No change to the validation script's SPY benchmark source.
