#!/bin/bash
# Autoresearch Overnight Loop
#
# Runs N iterations of strategy exploration. Each iteration:
#   1. Feeds the agent the leaderboard + a learning journal of insights
#   2. Agent edits strategy.ts with a new hypothesis
#   3. Runner evaluates via WFA → results append to leaderboard
#   4. Agent writes what it learned to the journal
#   5. Loop continues with accumulated knowledge
#
# Usage:
#   tmux new -s autoresearch
#   cd /Users/yuchenqiu/03_Projects/trading-journal
#   bash scripts/autoresearch/run-overnight.sh        # default 50 iterations
#   bash scripts/autoresearch/run-overnight.sh 100    # custom count
#   # Ctrl+B, D to detach
#
# Results:
#   scripts/autoresearch/leaderboard.json   — attempts (agent-visible; holdout metrics stripped)
#   scripts/autoresearch/best-strategy.ts   — current champion code
#   scripts/autoresearch/journal.md         — agent-visible learning journal (persists across iterations)

set -euo pipefail
cd "$(dirname "$0")/../.."

MAX_ITERATIONS=${1:-50}
AUTORESEARCH_DIR="scripts/autoresearch"
RUNS_DIR="data/runs/autoresearch"
RUN_ID="$(date +%Y-%m-%dT%H-%M-%S)"
RUN_LOG="$RUNS_DIR/run-$RUN_ID.log"

mkdir -p "$RUNS_DIR"

echo "=== Autoresearch Overnight Loop ==="
echo "Working dir: $(pwd)"
echo "Max iterations: $MAX_ITERATIONS"
echo "Start time: $(date)"
echo "Run log: $RUN_LOG"
echo ""

# Verify baseline exists
if [ ! -f "$AUTORESEARCH_DIR/dte5-baseline.json" ]; then
  echo "Generating DTE5 baseline first..."
  node --import tsx "$AUTORESEARCH_DIR/generate-baseline.ts"
  echo ""
fi

# Initialize journal if it doesn't exist
if [ ! -f "$AUTORESEARCH_DIR/journal.md" ]; then
  cat > "$AUTORESEARCH_DIR/journal.md" << 'JOURNAL'
# Autoresearch Learning Journal

This file persists across iterations. The agent writes what it learned after each run.
This is the agent's evolving memory — patterns discovered, hypotheses tested, dead ends found.

## Key Findings So Far
- Credit spreads on 8 diversified tickers (SPY,IWM,GLD,AAPL,JPM,COST,UNH,GS) with EMA34 gate, delta 0.30, DTE 30-60, TP 50%, SL 2.5x produced combined Sharpe ~0.93 and passed the holdout gate (champion "broad-credit-v2")
- Momentum LEAPs on tech tickers had high raw Sharpe but FAILED holdout — overfit to trending period
- Correlation floor for equity credit spreads is ~0.34-0.39 with DTE5 (also equity credit spreads)
- GLD adds decorrelation but not enough to break below 0.30 correlation
- Delta 0.25 slightly underperforms delta 0.30 in this DTE range

## Hypotheses to Test
- Non-equity underlyings (GLD-heavy) for lower correlation
- Different entry logic beyond EMA (volume, RSI, mean reversion)
- Regime-switching (different strategy in high vol vs low vol)
- Bear put spreads during downtrends (opposite direction to DTE5)
- Longer DTE (60-120) for more theta but different risk profile

## Dead Ends
- IV rank > 30 filter on ETFs — too restrictive, kills signal count
- 3-day monitoring interval — creates MtM gaps, distorts Sharpe

---

JOURNAL
fi

# Count existing attempts
ATTEMPTS=$(python3 -c "
import json, os
path = '$AUTORESEARCH_DIR/leaderboard.json'
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
    valid = [x for x in data if x.get('isValidForSearch')]
    best = max(valid, key=lambda x: x['combinedSharpe']) if valid else None
    print(f'Attempts: {len(data)}, Valid: {len(valid)}')
    if best:
        print(f'Champion: {best[\"strategyName\"]} (combined Sharpe {best[\"combinedSharpe\"]:.3f})')
else:
    print('Attempts: 0')
" 2>/dev/null || echo "Attempts: 0")
echo "$ATTEMPTS"
echo ""

# ── Main Loop ──────────────────────────────────────────
for ((i=1; i<=MAX_ITERATIONS; i++)); do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Iteration $i / $MAX_ITERATIONS — $(date '+%H:%M:%S')"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Build the prompt with current state
  LEADERBOARD_SUMMARY=$(python3 -c "
import json, os
path = '$AUTORESEARCH_DIR/leaderboard.json'
if not os.path.exists(path):
    print('No previous attempts.')
else:
    with open(path) as f:
        data = json.load(f)
    # Show last 10 attempts + all valid ones
    valid = [x for x in data if x.get('isValidForSearch')]
    recent = data[-10:] if len(data) > 10 else data
    print(f'Total attempts: {len(data)}, Valid: {len(valid)}')
    print()
    if valid:
        best = max(valid, key=lambda x: x['combinedSharpe'])
        print(f'CHAMPION: {best[\"strategyName\"]} — combined Sharpe {best[\"combinedSharpe\"]:.3f}, correlation {best[\"correlationWithDTE5\"]:.3f}, trades {best[\"oosTrades\"]}')
    print()
    print('Recent attempts:')
    for r in recent:
        status = 'VALID' if r.get('isValidForSearch') else 'INVALID'
        print(f'  [{status}] {r[\"strategyName\"]}: combined={r[\"combinedSharpe\"]:.3f}, corr={r[\"correlationWithDTE5\"]:.3f}, standalone={r[\"oosSharpe\"]:.3f}, trades={r[\"oosTrades\"]}')
" 2>/dev/null || echo "No leaderboard data.")

  # Journal: send only last 15 iteration entries + header to avoid token explosion.
  export AUTORESEARCH_DIR
  JOURNAL_CONTENT=$(python3 -c "
import os, re
path = os.environ['AUTORESEARCH_DIR'] + '/journal.md'
try:
    with open(path) as f:
        content = f.read()
except FileNotFoundError:
    print('No journal yet.')
    exit()
parts = re.split(r'\n(?=## (?:Iteration|Session)\b)', content)
header = parts[0]
entries = parts[1:]
KEEP = 15
kept = entries[-KEEP:] if len(entries) > KEEP else entries
pruned = len(entries) - len(kept)
out = header.strip()
if pruned > 0:
    out += f'\n\n[... {pruned} earlier iterations pruned from this prompt ...]'
for e in kept:
  out += '\n\n' + e.strip()
# Sanitize holdout metrics from journal content to prevent implicit holdout optimization.
# Lines are removed if they contain exact holdout Sharpe/IR/ratio values.
import re as _re
holdout_pattern = _re.compile(
    r'(?i)(holdout\s+(sharpe|ir|ratio|information|spy)|holdoutSharpe|holdoutRatio|holdoutOOSRatio|holdout/oos)',
    _re.IGNORECASE
)
sanitized = []
for line in out.split('\n'):
    if holdout_pattern.search(line) and any(c.isdigit() for c in line):
        sanitized.append('[holdout metric redacted]')
    else:
        sanitized.append(line)
print('\n'.join(sanitized))
" 2>/dev/null || cat "$AUTORESEARCH_DIR/journal.md" 2>/dev/null || echo "No journal yet.")
  CURRENT_STRATEGY=$(cat "$AUTORESEARCH_DIR/strategy.ts" 2>/dev/null || echo "No strategy yet.")

  # Build prompt via Python to avoid heredoc quoting issues
  # (heredoc + backticks + single quotes + curly braces = bash nightmare)
  PROMPT_FILE=$(mktemp /tmp/autoresearch-prompt.XXXXXX)
  export LEADERBOARD_SUMMARY JOURNAL_CONTENT CURRENT_STRATEGY PROMPT_FILE
  export ITER=$i MAX_ITER=$MAX_ITERATIONS
  python3 << 'PYSCRIPT'
import os

i = int(os.environ.get('ITER', '0'))
max_iter = int(os.environ.get('MAX_ITER', '50'))
lb = os.environ.get('LEADERBOARD_SUMMARY', 'No data')
jn = os.environ.get('JOURNAL_CONTENT', 'No journal yet')
st = os.environ.get('CURRENT_STRATEGY', 'No strategy yet')
out = os.environ.get('PROMPT_FILE', '/tmp/autoresearch-prompt.txt')

parts = [
    f"You are an autonomous trading strategy researcher. This is iteration {i} of {max_iter}.",
    "",
    "## Current State",
    "",
    "### Leaderboard",
    lb,
    "",
    "### Your Learning Journal (your accumulated knowledge - ADD to this)",
    jn,
    "",
    "### Current strategy.ts",
    "```typescript",
    st,
    "```",
    "",
    "## Your Task (Phase 1: edit strategy only)",
    "",
    "1. **Analyze** the leaderboard and your journal - what patterns work? what failed? what is untried?",
    "2. **Hypothesize** - what specific change will improve combined Sharpe or reduce correlation?",
    "3. **Edit** scripts/autoresearch/strategy.ts with your new strategy.",
    "",
    "STOP after editing strategy.ts.",
    "",
    "The harness will run the backtest for you (outside your tool access) and then you will get a second prompt to write the journal entry.",
    "",
    "## Rules",
    "- strategy.ts must export `strategy` as StrategyDefinition",
    "- Import DEFAULT_CREDIT_CONFIG or DEFAULT_LEAP_CONFIG from ../../src/lib/backtest/option-sim",
    "- Available modes: CREDIT_SPREAD, LEAP, or customEvaluator for novel structures",
    "- 25 tickers: AAPL,AMD,AMZN,AVGO,BA,COIN,COST,GLD,GOOG,GS,HOOD,IWM,JPM,LULU,META,MSFT,MSTR,NFLX,NVDA,PLTR,QQQ,SPY,TSLA,UBER,UNH",
    "- Validity: OOS Sharpe>0, min 100 trades, MaxDD<45%, holdout gate, delta gates (must beat naive always-long baseline)",
    "- Key metric: combinedSharpe (50/50 with DTE5). Low correlation is very valuable.",
    "- The runner evaluates a naive always-long baseline (buy every 5 days, same config). Your strategy must beat it on delta gates: ΔSPY IR > 0, ΔMaxDD ≤ 0, ΔCorrelation ≤ 0. If your signals can't beat 'buy every 5 days', they add no alpha.",
    "- BATCH SWEEP: add `configVariants` array to strategy to test multiple SimConfig overrides in one run. Each variant shares signals but has different config (delta, TP/SL, mode, etc.). Use this to sweep parameters efficiently instead of one-at-a-time iterations.",
    "- MARKET DATA: `generateSignals(data, market)` receives a `market: MarketContext` with `market.spyByDate.get(date)` → `{ close, ema200 }`. Use SPY regime gates to avoid bear markets.",
    "- EMA200 is available: `data.emas.get(200)!` for any ticker. Use for long-term trend gates.",
    "- Score-based execution priority: higher `signal.score` executes first when multiple signals compete for same date. Use for cross-sectional ranking.",
    "- IMPORTANT: monitoringIntervalDays MUST be 1 (daily). Other values create measurement artifacts.",
    "- Sanity bound: OOS Sharpe > 3.0 is auto-rejected (catches simulator bugs).",
    "- Read scripts/autoresearch/journal.md for exhausted search space, exploration map, and strategy ideas",
    "- Read docs/backtest-trust-gotchas.md BEFORE making claims about any result",
    "",
    "Be creative. Try fundamentally different approaches — different instruments, signals, regimes, ticker sets. The journal lists what's exhausted and what's untested.",
]

with open(out, 'w') as f:
    f.write('\n'.join(parts))
PYSCRIPT

  # Capture leaderboard size before iteration for integrity check
  PREV_LB_SIZE=$(python3 -c "
import json, os
p = '$AUTORESEARCH_DIR/leaderboard.json'
print(len(json.load(open(p))) if os.path.exists(p) else 0)
" 2>/dev/null || echo "0")

  # Phase 1: analyze → edit strategy.ts (no Bash tool access)
  # Pipe prompt via stdin to avoid ARG_MAX limit (journal grows each iteration).
  # Retry up to 3 times on transient failures (rate limits, timeouts, etc.).
  EDIT_OK=false
  for attempt in 1 2 3; do
    if cat "$PROMPT_FILE" | claude --model sonnet \
      --allowedTools "Edit(scripts/autoresearch/strategy.ts),Write(scripts/autoresearch/strategy.ts),Read(scripts/autoresearch/strategy.ts),Read(scripts/autoresearch/journal.md),Read(scripts/autoresearch/types.ts),Read(scripts/autoresearch/program.md),Read(docs/backtest-trust-gotchas.md),Read(src/lib/backtest/**)" \
      -p 2>&1 | tee -a "$RUN_LOG"; then
      EDIT_OK=true
      break
    else
      if [ "$attempt" -lt 3 ]; then
        echo "Attempt $attempt/3 failed (edit step) — retrying in 30s..."
        sleep 30
      fi
    fi
  done
  rm -f "$PROMPT_FILE"

  if [ "$EDIT_OK" = "false" ]; then
    echo "WARNING: All 3 attempts failed for iteration $i during the edit step. Continuing to next iteration."
    continue
  fi

  # Phase 1.5: run the backtest runner ourselves (agent has no Bash permission)
  echo ""
  echo "Running backtest runner..."
  RUNNER_OUT_FILE=$(mktemp /tmp/autoresearch-runner-out.XXXXXX)
  RUNNER_OK=false
  for attempt in 1 2 3; do
    if node --import tsx scripts/autoresearch/runner.ts 2>&1 | tee -a "$RUN_LOG" | tee "$RUNNER_OUT_FILE" >/dev/null; then
      RUNNER_OK=true
      break
    else
      if [ "$attempt" -lt 3 ]; then
        echo "Attempt $attempt/3 failed (runner step) — retrying in 30s..."
        sleep 30
      fi
    fi
  done

  if [ "$RUNNER_OK" = "false" ]; then
    echo "WARNING: All 3 attempts failed for iteration $i during the runner step. Continuing to next iteration."
    rm -f "$RUNNER_OUT_FILE"
    continue
  fi

  # Extract a compact summary of the latest RUN RESULT block for the journal step.
  RUNNER_SUMMARY=$(python3 -c "
import sys
p = '$RUNNER_OUT_FILE'
try:
    txt = open(p, 'r', encoding='utf-8', errors='replace').read().splitlines()
except FileNotFoundError:
    print('(runner output missing)')
    sys.exit(0)

# Strip __BEGIN_REVIEWER_ONLY__ ... __END_REVIEWER_ONLY__ blocks (holdout leakage guard).
cleaned = []
in_reviewer = False
for line in txt:
    if '__BEGIN_REVIEWER_ONLY__' in line:
        in_reviewer = True
        continue
    if '__END_REVIEWER_ONLY__' in line:
        in_reviewer = False
        continue
    if not in_reviewer:
        cleaned.append(line)

# Find the last run-result header and take a bounded slice.
idx = None
for i in range(len(cleaned)-1, -1, -1):
    if '=== RUN RESULT ===' in cleaned[i]:
        idx = i-1 if i > 0 else i
        break
block = cleaned[idx:] if idx is not None else cleaned[-120:]
block = block[-160:] if len(block) > 160 else block
print('\\n'.join(block))
" 2>/dev/null || echo "(runner summary unavailable)")
  rm -f "$RUNNER_OUT_FILE"

  # Phase 2: journal write (no strategy edits)
  JOURNAL_PROMPT_FILE=$(mktemp /tmp/autoresearch-journal-prompt.XXXXXX)
  export JOURNAL_PROMPT_FILE RUNNER_SUMMARY
  export ITER=$i MAX_ITER=$MAX_ITERATIONS
  python3 << 'PYSCRIPT2'
import os

i = int(os.environ.get('ITER', '0'))
max_iter = int(os.environ.get('MAX_ITER', '50'))
run_summary = os.environ.get('RUNNER_SUMMARY', '(no runner output)')
out = os.environ.get('JOURNAL_PROMPT_FILE', '/tmp/autoresearch-journal.txt')

parts = [
    f"You are an autonomous trading strategy researcher. This is iteration {i} of {max_iter}.",
    "",
    "## Backtest Output (latest run)",
    "```text",
    run_summary.strip(),
    "```",
    "",
    "## Your Task (Phase 2: journal only)",
    "",
    f"Append what you learned to scripts/autoresearch/journal.md under a new \"## Iteration {i}\" heading. Include:",
    "- What you tried and why",
    "- What the result was (key numbers — NO exact holdout metrics; use PASS/FAIL gates only)",
    "- What this teaches you for next iterations",
    "- Updated hypotheses",
    "",
    "Do NOT edit strategy.ts in this step.",
]

with open(out, 'w') as f:
    f.write('\\n'.join(parts))
PYSCRIPT2

  JOURNAL_OK=false
  for attempt in 1 2 3; do
    if cat "$JOURNAL_PROMPT_FILE" | claude --model sonnet \
      --allowedTools "Edit(scripts/autoresearch/journal.md),Write(scripts/autoresearch/journal.md),Read(scripts/autoresearch/journal.md)" \
      -p 2>&1 | tee -a "$RUN_LOG"; then
      JOURNAL_OK=true
      break
    else
      if [ "$attempt" -lt 3 ]; then
        echo "Attempt $attempt/3 failed (journal step) — retrying in 30s..."
        sleep 30
      fi
    fi
  done
  rm -f "$JOURNAL_PROMPT_FILE"

  if [ "$JOURNAL_OK" = "false" ]; then
    echo "WARNING: All 3 attempts failed for iteration $i during the journal step. Continuing to next iteration."
    continue
  fi

  # Integrity check: verify leaderboard grew by at least 1 entry
  NEW_LB_SIZE=$(python3 -c "
import json, os
p = '$AUTORESEARCH_DIR/leaderboard.json'
print(len(json.load(open(p))) if os.path.exists(p) else 0)
" 2>/dev/null || echo "0")
  if [ "$NEW_LB_SIZE" -le "$PREV_LB_SIZE" ]; then
    echo "WARNING: Leaderboard did not grow (was ${PREV_LB_SIZE}, now ${NEW_LB_SIZE}) — iteration may have failed to evaluate"
  else
    echo "OK: Leaderboard grew ${PREV_LB_SIZE} → ${NEW_LB_SIZE}"
  fi

  echo ""
  echo "Iteration $i complete at $(date '+%H:%M:%S')"
  echo ""

  # Brief pause between iterations
  sleep 2
done

echo ""
echo "=== Autoresearch Complete ==="
echo "End time: $(date)"
echo "Total iterations: $MAX_ITERATIONS"

# Final summary
python3 -c "
import json
with open('$AUTORESEARCH_DIR/leaderboard.json') as f:
    data = json.load(f)
valid = [x for x in data if x.get('isValidForSearch')]
print(f'Total attempts: {len(data)}, Valid: {len(valid)}')
	if valid:
	    best = max(valid, key=lambda x: x['combinedSharpe'])
	    print(f'Best: {best[\"strategyName\"]} — combined Sharpe {best[\"combinedSharpe\"]:.3f}')
	    print(f'  Correlation: {best[\"correlationWithDTE5\"]:.3f}')
	    print(f'  Standalone: Sharpe {best[\"oosSharpe\"]:.3f}, MaxDD {best[\"oosMaxDD\"]:.1f}%, Trades {best[\"oosTrades\"]}')
	print()
	print('See best-strategy.ts for the champion code.')
	print('See journal.md for the agent\\'s accumulated insights.')
" 2>/dev/null
