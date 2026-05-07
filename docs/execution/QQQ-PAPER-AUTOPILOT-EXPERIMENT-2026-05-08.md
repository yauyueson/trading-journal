# QQQ Paper Autopilot Experiment

> Experiment window: 2026-05-08 to 2026-06-07

This experiment lets the platform run BCD and PMCC in paper mode for one month, using the execution-ticket gate as the control layer.

## Scope

- Strategies: BCD QQQ wide F1 and PMCC QQQ PT60 F1.
- Ticker: QQQ only.
- Mode: paper only.
- Live orders: forbidden.
- Broker API: not used.
- Evidence source: `docs/wfa/QQQ-CLEAN-SHEET-VALIDATION-RESULTS-2026-05-07.md`.

## Schedule

Vercel Cron calls `/api/paper-autopilot` at `0 15 * * 1-5`, which is 15:00 UTC on weekdays.

The endpoint also checks the New York date and refuses to run outside the experiment window.

## Entry Rules

BCD:

- Enter only if no active BCD QQQ paper position exists.
- Enforce a 10-calendar-day minimum cadence since the last BCD QQQ entry.
- Candidate legs: QQQ call spread, 30-60 DTE, long delta near 0.50, short delta near 0.20.

PMCC:

- Enter only if no active PMCC QQQ paper position exists.
- Candidate legs: long QQQ LEAP call, 240-300 DTE, delta 0.70-0.80; short QQQ call, 30-45 DTE, delta 0.20-0.30.

## Risk Gate

Every attempted entry writes or reuses an `execution_tickets` row. A paper position is inserted only if the ticket is approved.

The gate blocks:

- live mode,
- non-QQQ ticker,
- duplicate active same-strategy position,
- non-positive quantity or max risk,
- ticket risk above the governed strategy tier.

Blocked decisions are part of the experiment. If current option prices are too expensive for the risk tier, the correct result is a blocked ticket, not an improvised paper trade.

## Review

After 2026-06-07, review:

- approved tickets,
- blocked tickets and block reasons,
- opened paper positions,
- PnL and drawdown,
- exit behavior,
- slippage/fill diagnostics where available,
- whether actual paper behavior still supports continued paper approval.
