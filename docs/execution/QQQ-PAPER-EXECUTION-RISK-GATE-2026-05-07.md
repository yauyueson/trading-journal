# QQQ Paper Execution and Risk Gate

> Last updated: 2026-05-07

This workflow converts the two clean-sheet `paper_candidate` strategies into controlled paper-trading tickets. It does not authorize live trading.

## Scope

Strategies:

- BCD QQQ wide F1
- PMCC QQQ PT60 F1

Evidence:

- `docs/wfa/QQQ-CLEAN-SHEET-VALIDATION-RESULTS-2026-05-07.md`
- `config/strategy-governance.json`

The execution gate is implemented in `src/lib/executionTickets.ts` and enforced by `src/hooks/usePositionMutations.ts` before a BCD or PMCC direct-add request can insert a paper position. Governed entries refresh active positions from Supabase immediately before approval so duplicate-position checks do not rely only on local UI cache.

## Ticket States

- `draft`: trader has proposed a ticket, but risk has not approved it.
- `risk_approved`: governance and risk gate passed for paper trading.
- `blocked`: ticket cannot be paper-executed without changing size, mode, ticker, or active exposure.

## Required Ticket Fields

Every paper ticket must include:

- strategy type: `bcd` or `pmcc`
- requested mode: `paper`
- ticker: `QQQ`
- quantity
- max risk per contract
- account size
- candidate evidence path
- active positions snapshot

The BCD and PMCC entry modals pass their configured strategy capital tier as `execution_account_size`; the gate uses that value together with `max_risk_entry × quantity` to approve or block the request.

## Durable Audit

Execution-ticket decisions are stored in `execution_tickets` via `supabase/migrations/20260507_018_execution_tickets.sql`.

- Approved paper tickets are inserted before the position row, then linked to `position_id`.
- Blocked tickets are inserted with their block reasons and no `position_id`.
- Ticket rows include governance version, evidence path, active-position snapshot, input snapshot, blocks, warnings, and approval roles.

## Risk Gate

The gate blocks a ticket when any of the following is true:

- live mode is requested while governance has `permission.live = false`,
- paper mode is not allowed,
- ticker is not `QQQ`,
- quantity is not a positive integer,
- max risk per contract is not positive,
- total ticket risk exceeds the strategy capital-tier cap,
- account size is below the strategy capital tier,
- the same strategy already has its maximum active QQQ position count.

The gate warns, but does not automatically block, when another QQQ directional strategy is already active. BCD and PMCC are allowed to coexist as separate capital tiers, but aggregate delta and drawdown must be reviewed manually.

## Capital Tiers

| Strategy | Tier capital | Risk pct | Max ticket risk | Max active |
|---|---:|---:|---:|---:|
| BCD QQQ wide | $5,000 | 30% | $1,500 | 1 |
| PMCC QQQ pt60 | $20,000 | 75% | $15,000 | 1 |

## Approval Roles

Two approvals are required for a paper ticket:

- Trader / Execution Agent: verifies structure, strikes, expirations, bid/ask, and fill assumptions.
- Risk Manager Agent: verifies sizing, active exposure, drawdown, and paper-only status.

Human broker confirmation remains required for live trading and is intentionally outside this paper-ticket approval path.

## BCD Playbook

Entry:

- QQQ only.
- Bull call debit spread.
- Long call delta near 0.50.
- Short call delta near 0.20.
- Same expiration, 30-60 DTE.
- Max one active BCD ticket.

Exit:

- Profit target: +50% of debit paid.
- Time stop: close near 7 DTE.
- If option chain data is unavailable, stop and create a no-trade/no-action note; do not improvise a fill.

## PMCC Playbook

Entry:

- QQQ only.
- Long LEAP call delta 0.70-0.80, 240-300 DTE.
- Short call delta 0.20-0.30, 30-45 DTE.
- Max one active PMCC ticket.

Exit and roll:

- Long-leg profit target: +60%.
- Long-leg stop: -35%.
- Short-leg profit target: +50% of short premium.
- Roll review trigger: underlying within 2% of short strike.
- Assignment or ex-dividend risk requires manual risk-manager review.

## Live Status

Live trading remains blocked by governance until all of these are complete:

- fresh forward-data review,
- execution ticket workflow in production use,
- risk-manager signoff,
- human broker confirmation,
- strategy-specific roll/exit workflow for PMCC.
