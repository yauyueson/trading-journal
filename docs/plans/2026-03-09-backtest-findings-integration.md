# Backtest Findings Integration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update all platform code to reflect credit spread backtesting findings: delta 0.35, DTE [45,65], TP 30%, no SL, IV >= 30% filter, $10 spread width.

**Architecture:** 5 files to modify — backtest defaults, strategy API credit spread builder, signal scanner cron, strategy recommender UI defaults, and types.

**Tech Stack:** TypeScript (frontend), ESM JS (API), React (UI)

---

### Task 1: Update DEFAULT_CREDIT_CONFIG in option-sim.ts

**Files:**
- Modify: `src/lib/backtest/option-sim.ts:89-111`

**Changes:**
- creditShortDelta: 0.27 → 0.35
- creditDTERange: [30, 50] → [45, 65]
- creditProfitTarget: 0.50 → 0.30
- creditStopLossMultiple: 2.0 → 100 (effectively disabled)
- creditSpreadWidth: 5 → 10

### Task 2: Update strategy-recommend.js credit spread builder

**Files:**
- Modify: `api/strategy-recommend.js`

**Changes:**
- buildCreditSpreads: delta filter 0.20-0.40 → 0.25-0.45 (centered on 0.35)
- Default dtePeak: 37 → 55 (center of [45,65])
- Default targetDte: 30 → 55
- Default widths: [5, 10] → [10] (prefer $10)
- Add IV >= 30% filter: reject short legs where IV < 0.30
- Credit profit target display: reference 30% not 50%

### Task 3: Update StrategyRecommender.tsx UI defaults

**Files:**
- Modify: `src/pages/StrategyRecommender.tsx`

**Changes:**
- Default targetDte: 30 → 55
- Default spreadWidth: 5 → 10
- DTE button labels: rename "Med" to match [45,65] sweet spot
- Add "Optimal" label for 55 DTE (backtested)

### Task 4: Update signal scanner cron

**Files:**
- Modify: `api/cron-signal-scan.js`

**Changes:**
- Add IV check: flag signals where IV < 30% as "low premium"
- Enhance Discord alert with IV level context

### Task 5: Update DEFAULT_ENTRY_PROFILE for credit spreads

**Files:**
- Modify: `api/strategy-recommend.js`

**Changes:**
- All setup dtePeak values for credit spreads: shift toward 55
- ENTRY_PROFILES credit-specific overrides
