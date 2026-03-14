---
phase: 2
slug: data-contract-api-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 2 — Validation Strategy

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
| 02-01-01 | 01 | 1 | EXIT-02 | unit | `npx vitest run tests/data-contract.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | STRAT-01, STRAT-02 | unit | `npx vitest run tests/data-contract.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 1 | SIG-01 | unit | `npx vitest run tests/data-contract.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/data-contract.test.ts` — tests for target_price in DirectAddItem, API strategy response, signal URL params
- Follows pattern from `tests/prerequisite-fixes.test.ts`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Signal CTA generates correct URL in browser | SIG-01 | Navigation test | Click "Build Swing Spread" on signals page, verify URL params in browser address bar |
| API returns different defaults for shortTerm | STRAT-01 | Live API test | Call /api/strategy-recommend?ticker=SPY&direction=BULL&strategy=shortTerm, verify response |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
