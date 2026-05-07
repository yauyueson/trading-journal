# QQQ Clean-Sheet Validation Plan — 2026-05-07

## Status

Completed. This document froze the clean-sheet validation scope before evidence was produced; the resulting cache-only report is `docs/wfa/QQQ-CLEAN-SHEET-VALIDATION-RESULTS-2026-05-07.md`.

## Objective

Re-evaluate the current QQQ-only paper-approved strategy family under the post-reset evidence rules:

- BCD QQQ wide
- PMCC QQQ pt60

The goal is not to discover a new broad-universe swing strategy. The goal is to decide whether the existing QQQ paper-approved strategies remain trustworthy enough for continued paper trading, later forward review, and eventual live-promotion consideration.

## Data Scope

- Ticker universe: QQQ only.
- Dataset manifest: `config/dataset-manifest.json`.
- Current manifest range: `2017-01-01` to `2026-02-28`.
- Holdout range: `2024-01-22` to `2026-02-28`.
- Option-chain cache: `data/option-chains.sqlite`.
- Intraday/daily candle cache: `data/intraday-candles.sqlite`.
- Vendor/API calls during WFA: forbidden.

## Current Cache Readiness

As of 2026-05-07, QQQ passes the local-cache WFA input gate without backfill:

- `npm run audit:wfa-cache-quality -- --tickers QQQ`
- Decision: PASS.
- Candle dates: 2405.
- IV proxy dates: 2075.
- IV proxy coverage: 86.28%.
- API calls required before QQQ clean-sheet validation: 0.

The IV proxy uses nearest cached option-chain DTE rows within +/-10 DTE for 30D and 60D proxies. This is intentionally cache-only and avoids unnecessary ORATS calls.

## Required Pre-Run Commands

Run these before any clean-sheet result can be cited:

```bash
npm run audit:governance
npm run audit:data-coverage
npm run audit:wfa-cache-quality -- --tickers QQQ
```

All three must pass. The data-coverage and data-quality artifact paths and SHA256 hashes must be copied into the final report metadata.

## Pre-Registration

**Hypothesis:** The existing QQQ paper-approved strategy family (BCD QQQ wide and PMCC QQQ pt60), when evaluated under the post-reset local-cache-only data policy, remains suitable for paper trading but is not live-approved unless all governance, data-quality, simulator, execution, and risk-manager gates pass.

**Config Grid:** No new parameter search. Use the existing governed anchor configurations from `config/strategy-governance.json`:

- `bcd`: long delta 0.50, short delta 0.20, DTE 30-60, profit target 50%, max position 1, capital tier $2,000.
- `pmcc`: long delta 0.70-0.80, long DTE 240-300, short delta 0.20-0.30, short DTE 30-45, long profit target 60%, short profit target 50%, max position 1, capital tier $10,000.

**Decision Rule:** Evaluate the two named anchors independently. Do not select a winner by holdout performance. Each strategy receives its own status: pass, paper-only, blocked, or retired.

**Adoption Threshold:** A strategy may remain paper-approved only if all of the following are true:

- governance audit passes,
- QQQ cache-quality gate passes,
- active-strategy option-chain DTE coverage passes,
- no vendor/API calls occur during WFA,
- result metadata includes `dataPolicy.mode = cache-first`,
- NO_CHAIN rate is reported and reviewed,
- max drawdown and capital-at-risk remain within the governed capital tier,
- model-risk note explicitly states whether the result is promotable or exploratory.

Live adoption remains blocked until execution ticket workflow, risk-manager signoff, and human broker confirmation exist.

**Holdout Window Hash:** `sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9`

**Declared Env Overrides:** none.

## Evidence Rules

- Pre-2026-05-06 WFA artifacts remain historical-only.
- Smoke runs are engineering checks, not evidence.
- Broad-universe swing WFA remains blocked for clean-sheet use unless each included ticker passes cache-quality gates.
- QQQ-only WFA can proceed with zero API calls.
- Any future backfill must be an explicit data-engineering action, not part of WFA.

## Executed Validation

Ran QQQ-only validation jobs for the governed BCD and PMCC anchors and wrote the final report under `docs/wfa/`. The report includes:

- result artifact path,
- cache-only mode and observed API-call count,
- data-quality artifact path/SHA,
- data-coverage artifact path/SHA,
- NO_CHAIN rate,
- paper/live status decision,
- model-risk signoff note.
