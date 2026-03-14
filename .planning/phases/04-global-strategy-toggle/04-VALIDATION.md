---
phase: 4
slug: global-strategy-toggle
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3.x |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | STRAT-03, STRAT-04 | unit + source | `npx vitest run tests/data-contract.test.ts && npx vitest run` | ✅ (appends) | ⬜ pending |

---

## Wave 0 Requirements

Existing `tests/data-contract.test.ts` will be appended. No new test file needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Toggle in header visible on every page | STRAT-03 | Visual navigation check | Visit /portfolio, /signals, /selector, /backtest, /stats — verify toggle present |
| Switching strategy updates Backtest page text | STRAT-04 | Visual check | Switch to Short-Term, verify Backtest shows ST config strings |
| Stats DTE buckets change on strategy switch | STRAT-04 | Visual check | Switch strategies, verify DTE distribution chart uses correct buckets |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
