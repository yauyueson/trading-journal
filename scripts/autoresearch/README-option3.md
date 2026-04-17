# Autoresearch Option 3 — Launch Guide

A standalone autoresearch loop searching for a **non-momentum complement** to DTE5. Runs alongside the primary momentum loop without conflicts — isolated strategy file, journal, leaderboard, and best-strategy champion.

## Quick launch

```bash
# Attach to a fresh tmux session (so you can detach and leave it running)
tmux new -s option3
cd /Users/yuchenqiu/03_Projects/trading-journal

# Run 50 iterations (default)
bash scripts/autoresearch/run-option3-overnight.sh

# ...or custom count
bash scripts/autoresearch/run-option3-overnight.sh 150

# Detach: Ctrl+B, then D
```

**Reattach later:** `tmux attach -t option3`

## Files

| Path | Role |
|---|---|
| `scripts/autoresearch/program-option3.md` | Mission briefing (read-only to agent) — scope, prior kills, targets |
| `scripts/autoresearch/strategy-option3.ts` | Agent edits this file each iteration |
| `scripts/autoresearch/best-strategy-option3.ts` | Copy of current champion (auto-updated when a valid strategy beats the best) |
| `scripts/autoresearch/journal-option3.md` | Agent's accumulated memory; grows across iterations |
| `scripts/autoresearch/leaderboard-option3.json` | Agent-visible (holdout numerics stripped) |
| `data/leaderboard-full-option3.json` | Full metrics (holdout numerics included) — for analysis, not for the agent |
| `data/runs/autoresearch-option3/run-<timestamp>.log` | Per-run log of the loop |

## Monitor from another terminal

```bash
# Latest run log
ls -t data/runs/autoresearch-option3/ | head -1

# Tail the live log
tail -f data/runs/autoresearch-option3/run-*.log

# Current champion
python3 -c "
import json
d = json.load(open('scripts/autoresearch/leaderboard-option3.json'))
v = [x for x in d if x.get('isValid')]
if v:
    best = max(v, key=lambda x: x['combinedSharpe'])
    print(f'Champion: {best[\"strategyName\"]}  combined={best[\"combinedSharpe\"]:.3f}  corr={best[\"correlationWithDTE5\"]:.3f}  trades={best[\"oosTrades\"]}')
    print(f'Standalone: Sharpe={best[\"oosSharpe\"]:.3f}  MaxDD={best[\"oosMaxDD\"]:.1f}%')
else:
    print(f'No valid strategy yet. {len(d)} attempts so far.')
"

# Leaderboard summary
python3 -c "
import json
d = json.load(open('scripts/autoresearch/leaderboard-option3.json'))
print(f'Total: {len(d)}  |  Valid: {sum(1 for x in d if x.get(\"isValid\"))}')
for x in sorted([x for x in d if x.get('isValid')], key=lambda x:-x['combinedSharpe'])[:5]:
    print(f'  {x[\"strategyName\"]:45s} combined={x[\"combinedSharpe\"]:.3f}  corr={x[\"correlationWithDTE5\"]:.3f}  trades={x[\"oosTrades\"]}')
"
```

## Cost estimate

- Per iteration: ~2 claude sonnet calls (edit + journal). ~10-20K tokens each. Rough cost: $0.10–$0.30/iteration.
- 50 iterations ≈ $5–$15. 150 ≈ $15–$45.
- Runtime per iteration: 1–3 minutes (claude calls + backtest runner). 50 iterations ≈ 1–2 hours.

## Stopping the loop

If the loop produces a valid champion you're happy with, or gets stuck:
```bash
tmux attach -t option3
# Ctrl+C to kill the current iteration
# Then: exit (kills the tmux session)
```

## Starting over / resetting

```bash
rm -f scripts/autoresearch/leaderboard-option3.json
rm -f data/leaderboard-full-option3.json
rm -f scripts/autoresearch/best-strategy-option3.ts
# Optional: reset the journal too (loses accumulated learnings)
# git checkout scripts/autoresearch/journal-option3.md
# git checkout scripts/autoresearch/strategy-option3.ts
```

## Reading the results

When the loop ends (or mid-run), inspect:
- `journal-option3.md` — the agent's accumulated notes on what worked, what didn't, what's untried
- `best-strategy-option3.ts` — the current champion code (if any strategy passed validity)
- `leaderboard-option3.json` — ranked attempts (holdout numerics stripped)

For a clean summary (top 10 by Sharpe, top 10 by low correlation, champion details, invalidity breakdown):
```bash
npx tsx scripts/autoresearch/analyze-option3.ts
# Writes scripts/autoresearch/option3-results.md
```

For full metrics incl. holdout Sharpe/IR/ratio, read `data/leaderboard-full-option3.json`. Holdout is write-once — don't iterate on it.

## Prior-kill discipline

The journal already lists directions that are known dead ends (iron condors, butterflies, calendars, mid-fill, momentum variants). The agent is instructed to avoid them. If you see the agent wander back into one, kill the loop and add a sharper note to `journal-option3.md`.

## What "done" looks like

The loop has found a non-momentum complement when:
- Combined Sharpe > 1.5 (beats DTE5 standalone 1.44 meaningfully)
- Correlation with DTE5 < 0.30
- Holdout gate PASS (Sharpe ≥ 0.3 OR SPY IR ≥ 0.3)
- Delta gates PASS (beats naive always-long baseline)
- Deflated Sharpe > 0 (survives multiple-testing correction)
- Validity: OOS Sharpe > 0, ≥100 trades, MaxDD < 45%

If after ~100 iterations no valid complement emerges, that's a real result too — non-momentum space is harder than the momentum space, and the conclusion "no tractable non-momentum complement exists in this universe" is actionable.
