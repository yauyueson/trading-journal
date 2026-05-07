# WFA Clean-Sheet Reset — 2026-05-06

## Decision

Historical only.

All WFA artifacts produced before 2026-05-06 are retired as current adoption evidence. They may remain in the repository as audit history, simulator forensics, and examples of methodology evolution, but they must not be used to justify a new active strategy, capital increase, paper-to-live promotion, or parameter change.

No pre-2026-05-06 WFA artifact may be used as current adoption evidence.

## Rationale

The old WFA history mixes incompatible assumptions: simulator versions, fill models, data windows, option-chain cache states, validation gates, trial counters, and strategy status definitions. Combining those artifacts creates a false sense of continuity. The right response is to start the research evidence base cleanly while preserving the old record for auditability.

## Do Not Delete

Do not delete the previous WFA reports, leaderboards, or analysis notes. Deleting them would remove the forensic trail that explains why the platform changed its standards. The clean-sheet reset changes their evidentiary status, not their archival value.

## New Rule

From 2026-05-06 onward, any WFA claim intended to influence strategy adoption must include:

- a structured strategy spec or pre-registration,
- a governed dataset manifest,
- option-chain/DTE coverage evidence when options chains are involved,
- simulator version/provenance,
- full trade and daily-return artifacts,
- benchmark/null comparison,
- model-risk signoff,
- an explicit statement that the run is either exploratory or promotable.

Exploratory research may use historical windows to learn, but it cannot be promoted without a fresh frozen spec and a governed validation path.

## Current Strategy Status

- BCD QQQ wide: paper-approved, not live-adopted.
- PMCC QQQ pt60: paper-approved, not live-adopted.
- DTE5, swing, shortTerm: retired and historical-only.

## Next Clean Baseline

The next clean baseline should be defined by a committed manifest and strategy-governance registry before any new promotable WFA run starts.

Before starting a promotable run, check the current governance state:

```bash
npm run audit:governance
```

The audit must pass and show whether each active strategy is paper-approved, live-adopted, or blocked.

Then check cache-only data coverage:

```bash
npm run audit:data-coverage
```

This command is intentionally cache-only. It reads the committed manifest, strategy-governance registry, and local SQLite option-chain cache metadata. It must not call ORATS or Tiingo. New vendor API calls require a separate explicit prefetch/backfill step and should produce provenance artifacts before any WFA run relies on them.

The command writes a deterministic JSON artifact under `docs/data-coverage/`. Promotable WFA reports should cite the artifact path and SHA256.

Then check WFA input quality:

```bash
npm run audit:wfa-cache-quality
```

This command is also local-cache-only. It verifies candle coverage from `data/intraday-candles.sqlite` and IV30/IV60 proxy coverage from `data/option-chains.sqlite`, writes `docs/data-quality/YYYY-MM-DD-wfa-cache-quality.json`, and exits non-zero when the cache is stale or too sparse for clean-sheet WFA evidence.

`scripts/wfa-run-unified.ts` now creates the same cache-only coverage artifact before running and embeds the artifact path/SHA in result metadata. Treat WFA output without this metadata as historical-only.

Unified WFA input loading is local-cache-first:

- daily candles are aggregated from `data/intraday-candles.sqlite`,
- 130M short-profile candles come from `data/intraday-candles.sqlite`,
- IV30/IV60 and realized-vol inputs are derived from `data/option-chains.sqlite`,
- WFA pipelines must not call Supabase REST, ORATS, Tiingo, Polygon, or any other vendor API.

If any required local cache is missing, fix it with an explicit prefetch/backfill command first. The WFA run itself should fail rather than silently fetch.

As of 2026-05-06, the default swing-universe quality audit is expected to block until IV proxy coverage is refreshed or the clean-sheet universe/window is narrowed. A blocked quality audit is not a platform failure; it is the platform refusing to treat incomplete local data as evidence.
