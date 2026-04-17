#!/bin/bash
# Autoresearch Campaign E — d65 Alpha Expansion Loop
#
# Forked from run-overnight.sh. Isolated files so this can run alongside
# the primary momentum autoresearch without conflicts.
#
# Files it touches:
#   scripts/autoresearch/strategy-campaign-e.ts       (agent edits)
#   scripts/autoresearch/best-strategy-campaign-e.ts  (champion copy)
#   scripts/autoresearch/journal-campaign-e.md        (agent's memory)
#   scripts/autoresearch/leaderboard-campaign-e.json  (agent-visible; holdout metrics stripped)
#   data/leaderboard-full-campaign-e.json             (full metrics)
#   data/runs/autoresearch-campaign-e/run-<id>.log    (per-run log)
#
# Usage:
#   tmux new -s campaign-e
#   cd /Users/yuchenqiu/03_Projects/trading-journal
#   bash scripts/autoresearch/run-campaign-e-overnight.sh        # default 10 iterations
#   bash scripts/autoresearch/run-campaign-e-overnight.sh 50    # custom count
#   # Ctrl+B, D to detach

set -euo pipefail
cd "$(dirname "$0")/../.."

MAX_ITERATIONS=${1:-10}
AUTORESEARCH_DIR="scripts/autoresearch"
RUNS_DIR="data/runs/autoresearch-campaign-e"
RUN_ID="$(date +%Y-%m-%dT%H-%M-%S)"
RUN_LOG="$RUNS_DIR/run-$RUN_ID.log"

mkdir -p "$RUNS_DIR"

# Isolate leaderboard + strategy file via env vars (consumed by runner.ts)
export AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-e
export AUTORESEARCH_STRATEGY_FILENAME=strategy-campaign-e.ts
# Prorated minimum OOS trades for pre-2024 selection window (matches Campaign A/D).
# Without this, runner defaults to 100 and falsely flags valid 60-100 trade variants as INVALID.
export AUTORESEARCH_MIN_OOS_TRADES=60

echo "=== Autoresearch Campaign E Loop ==="
echo "Working dir: $(pwd)"
echo "Max iterations: $MAX_ITERATIONS"
echo "Start time: $(date)"
echo "Run log: $RUN_LOG"
echo "Strategy file: $AUTORESEARCH_STRATEGY_FILENAME"
echo "Leaderboard suffix: $AUTORESEARCH_LEADERBOARD_SUFFIX"
echo ""

# Verify DTE5 baseline exists (shared with primary loop)
if [ ! -f "$AUTORESEARCH_DIR/dte5-baseline.json" ]; then
  echo "ERROR: dte5-baseline.json not found. Run generate-baseline.ts first."
  exit 1
fi

# Verify starter scaffold + mission + journal exist
for f in strategy-campaign-e.ts program-campaign-e.md journal-campaign-e.md; do
  if [ ! -f "$AUTORESEARCH_DIR/$f" ]; then
    echo "ERROR: missing $AUTORESEARCH_DIR/$f — set up campaign-e artifacts first."
    exit 1
  fi
done

# Initial champion snapshot
ATTEMPTS=$(python3 -c "
import json, os
path = '$AUTORESEARCH_DIR/leaderboard-campaign-e.json'
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
    valid = [x for x in data if x.get('isValidForSearch')]
    best = max(valid, key=lambda x: x['combinedSharpe']) if valid else None
    print(f'Attempts: {len(data)}, Valid: {len(valid)}')
    if best:
        print(f'Champion: {best[\"strategyName\"]} (combined Sharpe {best[\"combinedSharpe\"]:.3f}, corr {best[\"correlationWithDTE5\"]:.3f})')
else:
    print('Attempts: 0 (fresh start)')
" 2>/dev/null || echo "Attempts: 0")
echo "$ATTEMPTS"
echo ""

# ── Main Loop ──────────────────────────────────────────
for ((i=1; i<=MAX_ITERATIONS; i++)); do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Iteration $i / $MAX_ITERATIONS — $(date '+%H:%M:%S')"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Build leaderboard summary
  LEADERBOARD_SUMMARY=$(python3 -c "
import json, os
path = '$AUTORESEARCH_DIR/leaderboard-campaign-e.json'
if not os.path.exists(path):
    print('No previous attempts yet.')
else:
    with open(path) as f:
        data = json.load(f)
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

  # Journal content — last 15 entries
  export AUTORESEARCH_DIR
  JOURNAL_CONTENT=$(python3 -c "
import os, re
path = os.environ['AUTORESEARCH_DIR'] + '/journal-campaign-e.md'
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
# Sanitize holdout metrics
holdout_pattern = re.compile(
    r'(?i)(holdout\s+(sharpe|ir|ratio|information|spy)|holdoutSharpe|holdoutRatio|holdoutOOSRatio|holdout/oos)',
    re.IGNORECASE
)
sanitized = []
for line in out.split('\n'):
    if holdout_pattern.search(line) and any(c.isdigit() for c in line):
        sanitized.append('[holdout metric redacted]')
    else:
        sanitized.append(line)
print('\n'.join(sanitized))
" 2>/dev/null || cat "$AUTORESEARCH_DIR/journal-campaign-e.md" 2>/dev/null || echo "No journal yet.")
  CURRENT_STRATEGY=$(cat "$AUTORESEARCH_DIR/strategy-campaign-e.ts" 2>/dev/null || echo "No strategy yet.")

  # Build prompt via Python
  PROMPT_FILE=$(mktemp /tmp/autoresearch-campaign-e-prompt.XXXXXX)
  export LEADERBOARD_SUMMARY JOURNAL_CONTENT CURRENT_STRATEGY PROMPT_FILE
  export ITER=$i MAX_ITER=$MAX_ITERATIONS
  python3 << 'PYSCRIPT'
import os

i = int(os.environ.get('ITER', '0'))
max_iter = int(os.environ.get('MAX_ITER', '50'))
lb = os.environ.get('LEADERBOARD_SUMMARY', 'No data')
jn = os.environ.get('JOURNAL_CONTENT', 'No journal yet')
st = os.environ.get('CURRENT_STRATEGY', 'No strategy yet')
out = os.environ.get('PROMPT_FILE', '/tmp/autoresearch-campaign-e-prompt.txt')

parts = [
    f"You are an autonomous trading strategy researcher. This is iteration {i} of {max_iter} in the Campaign E campaign.",
    "",
    "## Your Mission — narrow and specific",
    "",
    "Expand alpha around d65-sl35-ts105 (the Campaign D winner, combined Sharpe 1.188). You have at most 10 iterations. Stay in the d65 LEAP CALL family. Find untested combinations and minor signal tweaks that yield additional combined Sharpe.",
    "",
    "**Adopt threshold: your winner must beat combined Sharpe 1.188 by ≥ 0.03 (i.e. ≥ 1.218) to be adopted.**",
    "",
    "Read scripts/autoresearch/program-campaign-e.md for the full mission briefing, scope limits, and priority untested combinations. This is mandatory on your first iteration.",
    "",
    "## Current State",
    "",
    "### Leaderboard (campaign-e only, isolated from momentum work)",
    lb,
    "",
    "### Your Learning Journal — add to this after each run",
    jn,
    "",
    "### Current strategy-campaign-e.ts",
    "```typescript",
    st,
    "```",
    "",
    "## Your Task (Phase 1: edit strategy-campaign-e.ts only)",
    "",
    "1. **Read the mission briefing** at program-campaign-e.md if you haven't yet, or if you're changing direction.",
    "2. **Analyze** the leaderboard + journal. What worked? What failed? What is untested from the exploration map?",
    "3. **Hypothesize**: pick one specific change that could improve combinedSharpe, reduce correlation, or unlock a new direction.",
    "4. **Edit** scripts/autoresearch/strategy-campaign-e.ts with the new strategy.",
    "",
    "STOP after editing. The harness will run the backtest. You'll get a second prompt to write the journal entry.",
    "",
    "## Critical rules (hard-earned)",
    "",
    "- strategy-campaign-e.ts must export `strategy` as StrategyDefinition",
    "- Import DEFAULT_CREDIT_CONFIG or DEFAULT_LEAP_CONFIG from ../../src/lib/backtest/option-sim",
    "- fillMode MUST be 'bidask' (DEFAULT — don't override to 'mid', that was a bug)",
    "- monitoringIntervalDays MUST be 1 (other values create measurement artifacts)",
    "- 25 tickers available: AAPL,AMD,AMZN,AVGO,BA,COIN,COST,GLD,GOOG,GS,HOOD,IWM,JPM,LULU,META,MSFT,MSTR,NFLX,NVDA,PLTR,QQQ,SPY,TSLA,UBER,UNH",
    "- Validity: OOS Sharpe>0, ≥100 trades, MaxDD<45%, holdout gate, delta gate (must beat naive always-long baseline with same config)",
    "- Sanity bound: OOS Sharpe > 3.0 auto-rejected (simulator bug catcher)",
    "- BATCH SWEEP: use `configVariants` array to test multiple SimConfig overrides in a single run. More efficient than iterating one at a time.",
    "- MARKET DATA: `generateSignals(data, market)` gives you `market.spyByDate.get(date)` → `{close, ema200}`. Use SPY regime gates to skip bad environments.",
    "- EMA200 is available per-ticker: `data.emas.get(200)!`. Use for long-term trend filters.",
    "- `score`-based execution priority: higher `signal.score` gets the slot first when multiple signals collide for the same date.",
    "- Direction conventions in this codebase:",
    "    direction:'CALL' → worker sells PUT spread (bull put spread, bullish view)",
    "    direction:'PUT'  → worker sells CALL spread (bear call spread, bearish view)",
    "",
    "## Scope limits — Campaign E is NOT an open exploration",
    "",
    "FORBIDDEN in Campaign E (belongs to other campaigns):",
    "- CREDIT_SPREAD or DEBIT_SPREAD mode (stay in LEAP CALL)",
    "- Tickers outside the 14-ticker champion set (GLD, IWM, AAPL, MSFT, GOOG, AMZN, META, JPM, GS, COST, UNH, NFLX, NVDA, TSLA)",
    "- New indicator families: RSI, VRP, volume, volatility gates beyond the existing contangoPct<48 — those ALL failed in Option 3 campaign (separate effort)",
    "- Iron condors, butterflies, calendar spreads — structurally dead under bidask fills",
    "- Mid-price fills (simulator bug) — fillMode MUST be 'bidask' (default)",
    "",
    "ALLOWED:",
    "- Parameter combinations of ts, tp, sl, delta range, DTE range that Campaign D's 26-variant grid did NOT test",
    "- Minor signal tweaks: band tightening (0-3%, 0-4% vs current 0-5%), proximity-score variants, EMA34 rising over 3d vs 5d",
    "- Ticker subsets of the 14-ticker set (drop 1-2, re-test)",
    "",
    "Read docs/backtest-trust-gotchas.md BEFORE making any claim about a result.",
    "",
    "HIGHEST-PRIORITY UNTESTED COMBINATION: d65-sl35-ts150 (both Campaign D winners together). If additive, combined could reach ~1.25+. The seed strategy-campaign-e.ts already includes this in its first configVariants sweep.",
]

with open(out, 'w') as f:
    f.write('\n'.join(parts))
PYSCRIPT

  # Capture leaderboard size before iteration
  PREV_LB_SIZE=$(python3 -c "
import json, os
p = '$AUTORESEARCH_DIR/leaderboard-campaign-e.json'
print(len(json.load(open(p))) if os.path.exists(p) else 0)
" 2>/dev/null || echo "0")

  # Phase 1: edit strategy-campaign-e.ts
  EDIT_OK=false
  for attempt in 1 2 3; do
    if cat "$PROMPT_FILE" | claude --model sonnet \
      --allowedTools "Edit(scripts/autoresearch/strategy-campaign-e.ts),Write(scripts/autoresearch/strategy-campaign-e.ts),Read(scripts/autoresearch/strategy-campaign-e.ts),Read(scripts/autoresearch/journal-campaign-e.md),Read(scripts/autoresearch/program-campaign-e.md),Read(scripts/autoresearch/types.ts),Read(docs/backtest-trust-gotchas.md),Read(src/lib/backtest/**)" \
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
    echo "WARNING: All 3 edit attempts failed for iteration $i. Continuing to next."
    continue
  fi

  # Phase 1.5: run the backtest runner ourselves
  echo ""
  echo "Running backtest runner..."
  RUNNER_OUT_FILE=$(mktemp /tmp/autoresearch-campaign-e-runner-out.XXXXXX)
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
    echo "WARNING: All 3 runner attempts failed for iteration $i. Continuing to next."
    rm -f "$RUNNER_OUT_FILE"
    continue
  fi

  # Compact runner summary for journal prompt
  RUNNER_SUMMARY=$(python3 -c "
import sys
p = '$RUNNER_OUT_FILE'
try:
    txt = open(p, 'r', encoding='utf-8', errors='replace').read().splitlines()
except FileNotFoundError:
    print('(runner output missing)')
    sys.exit(0)
# Strip __BEGIN_REVIEWER_ONLY__ ... __END_REVIEWER_ONLY__ blocks so the agent
# never sees holdout pass/fail, holdout stability, or true champion status.
# Adversarial review (Codex, 2026-04-17) flagged these as holdout leakage.
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
idx = None
for i in range(len(cleaned)-1, -1, -1):
    if '=== RUN RESULT ===' in cleaned[i] or '=== SWEEP RESULTS ===' in cleaned[i]:
        idx = max(0, i-2)
        break
block = cleaned[idx:] if idx is not None else cleaned[-120:]
block = block[-160:] if len(block) > 160 else block
print('\\n'.join(block))
" 2>/dev/null || echo "(runner summary unavailable)")
  rm -f "$RUNNER_OUT_FILE"

  # Phase 2: journal-only write
  JOURNAL_PROMPT_FILE=$(mktemp /tmp/autoresearch-campaign-e-journal-prompt.XXXXXX)
  export JOURNAL_PROMPT_FILE RUNNER_SUMMARY
  export ITER=$i MAX_ITER=$MAX_ITERATIONS
  python3 << 'PYSCRIPT2'
import os

i = int(os.environ.get('ITER', '0'))
max_iter = int(os.environ.get('MAX_ITER', '50'))
run_summary = os.environ.get('RUNNER_SUMMARY', '(no runner output)')
out = os.environ.get('JOURNAL_PROMPT_FILE', '/tmp/autoresearch-campaign-e-journal.txt')

parts = [
    f"You are an autonomous trading strategy researcher. This is iteration {i} of {max_iter} in the Campaign E campaign.",
    "",
    "## Backtest Output (latest run)",
    "```text",
    run_summary.strip(),
    "```",
    "",
    "## Your Task (Phase 2: journal only)",
    "",
    f"Append what you learned to scripts/autoresearch/journal-campaign-e.md under a new \"## Iteration {i}\" heading. Include:",
    "- What you tried and why (direction: non-momentum category chosen)",
    "- What the result was (key numbers — NO exact holdout metrics; use PASS/FAIL gates only)",
    "- What this teaches you for next iterations",
    "- Updated hypotheses or newly exhausted directions",
    "",
    "Do NOT edit strategy-campaign-e.ts in this step.",
]

with open(out, 'w') as f:
    f.write('\\n'.join(parts))
PYSCRIPT2

  JOURNAL_OK=false
  for attempt in 1 2 3; do
    if cat "$JOURNAL_PROMPT_FILE" | claude --model sonnet \
      --allowedTools "Edit(scripts/autoresearch/journal-campaign-e.md),Write(scripts/autoresearch/journal-campaign-e.md),Read(scripts/autoresearch/journal-campaign-e.md)" \
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
    echo "WARNING: All 3 journal attempts failed for iteration $i. Continuing to next."
    continue
  fi

  # Integrity check: leaderboard grew by at least 1
  NEW_LB_SIZE=$(python3 -c "
import json, os
p = '$AUTORESEARCH_DIR/leaderboard-campaign-e.json'
print(len(json.load(open(p))) if os.path.exists(p) else 0)
" 2>/dev/null || echo "0")
  if [ "$NEW_LB_SIZE" -le "$PREV_LB_SIZE" ]; then
    echo "WARNING: Leaderboard did not grow (${PREV_LB_SIZE} → ${NEW_LB_SIZE}) — iteration may have failed to evaluate"
  else
    echo "OK: Leaderboard grew ${PREV_LB_SIZE} → ${NEW_LB_SIZE}"
  fi

  echo ""
  echo "Iteration $i complete at $(date '+%H:%M:%S')"
  echo ""
  sleep 2
done

echo ""
echo "=== Autoresearch Campaign E Complete ==="
echo "End time: $(date)"
echo "Total iterations: $MAX_ITERATIONS"

# Final summary
python3 -c "
import json, os
p = '$AUTORESEARCH_DIR/leaderboard-campaign-e.json'
if not os.path.exists(p):
    print('No results.')
else:
    with open(p) as f:
        data = json.load(f)
    valid = [x for x in data if x.get('isValidForSearch')]
    print(f'Total attempts: {len(data)}, Valid: {len(valid)}')
    if valid:
        best = max(valid, key=lambda x: x['combinedSharpe'])
        print(f'Champion: {best[\"strategyName\"]} — combined Sharpe {best[\"combinedSharpe\"]:.3f}')
        print(f'  Correlation with DTE5: {best[\"correlationWithDTE5\"]:.3f}')
        print(f'  Standalone: Sharpe {best[\"oosSharpe\"]:.3f}, MaxDD {best[\"oosMaxDD\"]:.1f}%, Trades {best[\"oosTrades\"]}')
        print()
        print('See best-strategy-campaign-e.ts for the champion code.')
        print('See journal-campaign-e.md for accumulated insights.')
" 2>/dev/null
