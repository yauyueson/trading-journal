---
phase: 3
slug: spread-builder-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 3 — Validation Strategy

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
| 03-01-01 | 01 | 1 | SIG-02, SIG-03, IVR-01-04, EXIT-01, EXIT-03 | unit + source | `npx vitest run tests/data-contract.test.ts && npx vitest run` | ✅ (appends) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing `tests/data-contract.test.ts` from Phase 2 will be appended with Phase 3 tests. No new test file needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Signal banner renders with full metadata when arriving from signals page | SIG-02 | Visual/navigation check | Click "Build Swing Spread" on signals page, verify banner shows above regime card |
| Signal banner absent on direct /selector navigation | SIG-03 | Visual/navigation check | Navigate directly to /selector, verify no signal banner |
| IV gate overlay greys out results section with threshold message | IVR-02 | Visual check | Analyze a ticker with IV rank below threshold, verify grey overlay and message |
| IV gate dismiss button works | IVR-02 | Interactive check | Click "I understand the risk" button, verify overlay removes |
| TP field appears and updates reactively as fill price is typed | EXIT-01 | Interactive check | Click open position, type fill price, verify TP updates |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
