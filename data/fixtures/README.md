# Test Fixtures

SQLite fixture databases committed for CI regression tests. These are small, curated slices of production data that never change (or change only when the related simulator behavior intentionally changes).

## `bxm-live-test.sqlite`

**Purpose:** Back the live BXM simulator regression test in [tests/bxm-replication.test.ts](../../tests/bxm-replication.test.ts).

**Scope:** SPY `option_chains` rows with `trade_date` ∈ [2022-12-01, 2024-01-31] and `dte` ∈ [25, 40]. Plus matching `fetch_log` rows. No PUT, no CORES. ~60K rows, ~13 MB.

**Why committed:** `data/option-chains.sqlite` is gitignored (full cache is 15 GB+), so without this fixture the live test skips on every CI run. The snapshot layer protects the committed results JSON, but the simulator itself would only be exercised on local dev machines.

**Invariants:** The `tests/bxm-replication.test.ts` live layer reads this fixture via `initDB(fixturePath, readonly=true)` and re-runs `simulateBuyWrite` for monthly cycles in 2023. Each cycle's P&L must match the corresponding row in `data/bxm-replication-results.json` within `1e-4` per-cycle tolerance and `5e-5` mean-delta tolerance.

**Regenerate** (if simulator semantics change and the fixture needs to track a new reference):

```sql
-- From an up-to-date data/option-chains.sqlite:
ATTACH DATABASE 'data/fixtures/bxm-live-test.sqlite' AS fx;

CREATE TABLE fx.option_chains AS
  SELECT * FROM option_chains
  WHERE ticker = 'SPY'
    AND trade_date BETWEEN '2022-12-01' AND '2024-01-31'
    AND dte BETWEEN 25 AND 40;

CREATE TABLE fx.fetch_log AS
  SELECT * FROM fetch_log
  WHERE ticker = 'SPY'
    AND trade_date BETWEEN '2022-12-01' AND '2024-01-31';

CREATE INDEX fx.idx_fx_chain_lookup ON option_chains(ticker, trade_date, strike, expir_date);
CREATE INDEX fx.idx_fx_fetch_log ON fetch_log(ticker, trade_date);

-- Then: sqlite3 data/fixtures/bxm-live-test.sqlite "VACUUM;"
```

After regenerating, re-run the snapshot: `npx tsx scripts/replicate-bxm.ts` and commit both the fixture and the refreshed `data/bxm-replication-results.json` together.
