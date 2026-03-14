# Requirements: WFA-Driven Workflow Integration

**Defined:** 2026-03-14
**Core Value:** Make the WFA-validated action the easiest action — signal context visible, IV gating candidates, TP pre-filled at entry

## v1 Requirements

### Prerequisites

- [x] **PRE-01**: shortTerm ivRankMin fixed from 30 to 40 in strategyProfiles.ts to match WFA-validated threshold
- [x] **PRE-02**: API param naming standardized — scan-options.js uses `activeProfile` (not `profileStrategy`), strategy-recommend.js continues using `strategy`
- [x] **PRE-03**: Audit and redirect all `settings.creditSpread.*` reads to `getProfile(activeStrategy).*` where strategy-specific params are used

### Signal Context

- [x] **SIG-01**: Signals page CTA passes signal metadata (signalType, score, direction, streak, adxValue, rvol) as URL params when navigating to spread builder
- [x] **SIG-02**: Spread builder displays full signal context banner when arrived from signals page — shows signal type, score, direction, streak, ADX, RVOL
- [x] **SIG-03**: Signal context banner is absent when user navigates to spread builder directly (manual ticker entry) — no fake signal shown

### IV Rank Filtering

- [x] **IVR-01**: Spread builder gates recommendations using strategy-specific IV rank threshold (swing >= 30%, shortTerm >= 40%)
- [x] **IVR-02**: Sub-threshold candidates shown greyed-out with LOW_IV warning badge, not hidden entirely
- [x] **IVR-03**: IV rank threshold sourced from strategyProfiles.ts (single source of truth), not hardcoded in UI
- [x] **IVR-04**: IV rank filter operates at API response display layer, not inside scoring functions (preserves 307 parity tests)

### Exit Automation

- [x] **EXIT-01**: When opening a position from spread builder, profit target auto-filled from active strategy profile (swing 30%, shortTerm 40%)
- [x] **EXIT-02**: target_price field added to DirectAddItem type and written by useAddDirect mutation
- [x] **EXIT-03**: Auto-filled TP is editable — user can override if they choose

### Strategy Integration

- [x] **STRAT-01**: strategy-recommend.js accepts `strategy` query param and uses profile-specific dtePeak, DTE sigma, defaultWidth, and deltaRange
- [x] **STRAT-02**: scan-options.js accepts `strategy` query param and adjusts DTE/delta defaults per profile
- [x] **STRAT-03**: Global strategy toggle accessible within spread builder flow (in AppLayout header or selector page header)
- [x] **STRAT-04**: All page subtitles and DTE/width/delta defaults react to active strategy selection

### Cleanup + Signal Extension

- [x] **SCAN-01**: Scanner page (/scanner) removed — route, tab, page component, and Scanner-exclusive types cleaned up; scan-options.js API preserved (shared by Portfolio.tsx)
- [x] **MOM-01**: Signal type derived from signal_history components data (EMA or MOM) instead of hardcoded 'EMA' — flows through URL params and signal context banner

## v2 Requirements

### Position Monitoring

- **MON-01**: Position card shows % progress toward strategy-specific TP target
- **MON-02**: Visual alert/badge when position reaches TP threshold
- **MON-03**: Anti-SL warning with WFA evidence when user attempts to set stop loss

### Capital Utilization

- **CAP-01**: Portfolio page shows current capital utilization %
- **CAP-02**: Per-ticker position count tracking against mpt5 limit
- **CAP-03**: Spread width suggestion based on account size and target utilization

## Out of Scope

| Feature | Reason |
|---------|--------|
| Score-based exit automation | WFA: se50/se60 go negative OOS — scores don't predict outcomes |
| Stop-loss automation | WFA: SL 2x = Sharpe 0.04, destroys profitability |
| Debit spread improvements | No WFA validation; LEAPs Sharpe 0.22-0.37 vs credit 2.14 |
| Single-leg scoring improvements | LEAPs: 50% OOS survival vs credit 100% |
| Real-time signal push notifications | Complexity; daily cron signals are sufficient |
| Multi-broker order routing | Platform is journal/analysis, not execution |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PRE-01 | Phase 1 | Complete |
| PRE-02 | Phase 1 | Complete |
| PRE-03 | Phase 1 | Complete |
| SIG-01 | Phase 2 | Complete |
| SIG-02 | Phase 3 | Complete |
| SIG-03 | Phase 3 | Complete |
| IVR-01 | Phase 3 | Complete |
| IVR-02 | Phase 3 | Complete |
| IVR-03 | Phase 3 | Complete |
| IVR-04 | Phase 3 | Complete |
| EXIT-01 | Phase 3 | Complete |
| EXIT-02 | Phase 2 | Complete |
| EXIT-03 | Phase 3 | Complete |
| STRAT-01 | Phase 2 | Complete |
| STRAT-02 | Phase 2 | Complete |
| STRAT-03 | Phase 4 | Complete |
| STRAT-04 | Phase 4 | Complete |
| SCAN-01 | Phase 5 | Complete |
| MOM-01 | Phase 5 | Complete |

**Coverage:**
- v1 requirements: 19 total
- Mapped to phases: 19
- Unmapped: 0

---
*Requirements defined: 2026-03-14*
*Last updated: 2026-03-14 after initial definition*
