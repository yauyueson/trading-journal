# Short DTE Alpha Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run an exploratory 7-14 DTE credit-spread WFA that can test IV/VRP/contango-gated short-premium candidates without changing live strategy behavior.

**Architecture:** Extend the existing short WFA pipeline rather than adding a second simulator. Keep the new dimensions in `ShortSweepDimensions`, enrich generated signals with ORATS vol-regime fields, then run a focused experiment config saved under the research report folder.

**Tech Stack:** TypeScript, Vitest, existing WFA short pipeline, ORATS/Supabase cache, SQLite chain/intraday caches.

---

### Task 1: Research-Only Sweep Dimensions

**Files:**
- Modify: `scripts/wfa-pipeline-short.ts`
- Modify: `src/lib/backtest/intraday-monitor.ts`
- Test: `tests/wfa-short-pipeline.test.ts`

- [x] **Step 1: Add `creditDTERanges`, VRP, and contango percentile dimensions to `ShortSweepDimensions`.**
- [x] **Step 2: Carry those dimensions into `SimConfig` in `buildSweepCandidates()`.**
- [x] **Step 3: Populate `vrp`, `contango`, `vrpPct`, and `contangoPct` on generated `EntrySignal`s from `orats_iv_cache` rows.**
- [x] **Step 4: Enforce percentile filters in `evaluateCreditSpread4H()`.**
- [x] **Step 5: Add a Vitest assertion that generated configs preserve the new DTE and vol-regime fields.**

### Task 2: Focused Exploratory Run

**Files:**
- Create: `backtesting history/credit-spread/reports/short-dte-7-14-research/experiment.json`
- Create after run: `backtesting history/credit-spread/reports/short-dte-7-14-research/README.md`

- [x] **Step 1: Create a narrow QQQ/IWM 7-14 DTE experiment config.**
- [x] **Step 2: Run `npx vitest run tests/wfa-short-pipeline.test.ts`.**
- [x] **Step 3: Run the rich-premium-gated QQQ/IWM WFA to catch runtime issues and measure sample starvation.**
- [x] **Step 4: Run the focused QQQ/IWM no-vol-gate WFA and save to `data/runs/short-dte-7-14-baseline-no-vol-gates.json`.**
- [x] **Step 5: Summarize metrics, per-window stability, selected configs, exit types, and caveats in the report README.**
