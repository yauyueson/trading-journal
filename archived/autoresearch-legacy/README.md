# Autoresearch Legacy

Infrastructure from the pre-sealed-holdout autonomous research loop. Retired 2026-04-22 after Phase E campaigns completed and the global attempt-count ceiling for dsrM was established — no more blind strategy sweeps until the 2026-10-20 holdout window refresh.

## What's here

- `run-overnight.sh` — autonomous loop driver (Claude/Sonnet agent edits `strategy.ts`, runner evaluates, agent journals)
- `journal.md` — cross-iteration learning journal the agent read and wrote
- `program.md` — campaign framework / contract for the loop
- `codex-review-prompt.md`, `codex-review-prompt-v2.md` — adversarial-review prompts used during the autoresearch era

## Why archived, not deleted

The sealed-holdout protocol (`docs/sealed-holdout.md`) superseded this loop. The mechanics still work, but running it adds to the global ledger `attemptNumber`, which makes dsrM gating harder for every future sealed strategy. If the protocol changes or per-campaign deflation becomes acceptable, these files document how the loop was wired.
