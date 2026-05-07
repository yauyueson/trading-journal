# Holdout Refresh Log

Chronological record of dataset-manifest refreshes per [docs/holdout-refresh-policy.md](holdout-refresh-policy.md).

Each entry records the trigger, the old and new windows, and what happened to active strategies. Entries are append-only — never edit a past entry.

---

## 2026-05-06 — F1 paper approval recorded and clean-sheet WFA reset

**Trigger:** Platform trust overhaul and role-based governance review.

**Current manifest** (unchanged from the committed `config/dataset-manifest.json` at this entry):
- `manifestVersion`: 2
- Dataset: `2017-01-01` → `2026-02-28`
- Holdout window: `2024-01-22` → `2026-02-28`

**Active strategies on this manifest:**
- BCD QQQ wide — `paper-approved`, not live-adopted.
- PMCC QQQ pt60 — `paper-approved`, not live-adopted.

**Governance decision:**
- The F1 seals are treated as paper-trading approval and workflow-validation evidence.
- Live adoption remains blocked until the clean-sheet WFA reset produces forward-reviewed evidence, execution tickets, risk signoff, and human-confirmation workflow.
- DTE5, swing, and shortTerm remain retired / historical-only.

**Clean-sheet WFA reset:**
- Previous WFA reports and leaderboards are historical only.
- No pre-2026-05-06 WFA artifact may be used as current adoption evidence.
- Do not delete historical WFA artifacts; they remain the audit trail for simulator and methodology evolution.
- Policy document: [docs/wfa/CLEAN-SHEET-RESET-2026-05-06.md](wfa/CLEAN-SHEET-RESET-2026-05-06.md)

---

## 2026-04-20 — policy established (initial baseline)

**Trigger:** N/A (initial baseline, not a refresh).

**Current manifest** (as committed in `config/dataset-manifest.json` at the time of this entry):
- `manifestVersion`: 2
- Dataset: `2017-01-01` → `2026-02-28`
- Holdout window: `2024-01-22` → `2026-02-28`

**Active strategies on this manifest:**
- DTE5 bull put credit spread (QQQ-only, paper trading at $1K per CLAUDE.md).

**Seal history against this manifest** (approximate, count via `docs/holdout-evaluations/` on this branch):
- Inherited from Phase 0.a.5 onwards. No formal count made at policy adoption time; future refreshes will track this precisely.

**Notes:**
- Policy adopted after Phase 2.o completed — the methodology hardening track is in place, so future refresh decisions have the full diagnostic suite (N_eff, Mertens SE, stat-consistency gate) to triage candidates on.
- First scheduled backstop refresh: **2026-10-20** (6 months from policy adoption), unless an adoption event or cumulative-attempts trigger fires earlier.

---
