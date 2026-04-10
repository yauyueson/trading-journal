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
#   scripts/autoresearch/leaderboard.json   — all attempts with metrics
#   scripts/autoresearch/best-strategy.ts   — current champion code
#   scripts/autoresearch/journal.md         — agent's learning journal (persists across iterations)

set -e
cd "$(dirname "$0")/../.."

MAX_ITERATIONS=${1:-50}
AUTORESEARCH_DIR="scripts/autoresearch"

echo "=== Autoresearch Overnight Loop ==="
echo "Working dir: $(pwd)"
echo "Max iterations: $MAX_ITERATIONS"
echo "Start time: $(date)"
echo ""

# Verify baseline exists
if [ ! -f "$AUTORESEARCH_DIR/dte5-baseline.json" ]; then
  echo "Generating DTE5 baseline first..."
  npx tsx "$AUTORESEARCH_DIR/generate-baseline.ts"
  echo ""
fi

# Initialize journal if it doesn't exist
if [ ! -f "$AUTORESEARCH_DIR/journal.md" ]; then
  cat > "$AUTORESEARCH_DIR/journal.md" << 'JOURNAL'
# Autoresearch Learning Journal

This file persists across iterations. The agent writes what it learned after each run.
This is the agent's evolving memory — patterns discovered, hypotheses tested, dead ends found.

## Key Findings So Far
- Credit spreads on 8 diversified tickers (SPY,IWM,GLD,AAPL,JPM,COST,UNH,GS) with EMA34 gate, delta 0.30, DTE 30-60, TP 50%, SL 2.5x produced combined Sharpe 0.929 with holdout ratio 1.40 (champion "broad-credit-v2")
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
    valid = [x for x in data if x.get('isValid')]
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
    valid = [x for x in data if x.get('isValid')]
    recent = data[-10:] if len(data) > 10 else data
    print(f'Total attempts: {len(data)}, Valid: {len(valid)}')
    print()
    if valid:
        best = max(valid, key=lambda x: x['combinedSharpe'])
        print(f'CHAMPION: {best[\"strategyName\"]} — combined Sharpe {best[\"combinedSharpe\"]:.3f}, correlation {best[\"correlationWithDTE5\"]:.3f}, holdout ratio {best[\"holdoutOOSRatio\"]:.2f}, trades {best[\"oosTrades\"]}')
    print()
    print('Recent attempts:')
    for r in recent:
        status = 'VALID' if r.get('isValid') else 'INVALID'
        print(f'  [{status}] {r[\"strategyName\"]}: combined={r[\"combinedSharpe\"]:.3f}, corr={r[\"correlationWithDTE5\"]:.3f}, standalone={r[\"oosSharpe\"]:.3f}, holdoutRatio={r.get(\"holdoutOOSRatio\",0):.2f}, trades={r[\"oosTrades\"]}')
" 2>/dev/null || echo "No leaderboard data.")

  JOURNAL_CONTENT=$(cat "$AUTORESEARCH_DIR/journal.md" 2>/dev/null || echo "No journal yet.")
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
    "## Your Task (ONE iteration)",
    "",
    "1. **Analyze** the leaderboard and your journal - what patterns work? what failed? what is untried?",
    "2. **Hypothesize** - what specific change will improve combined Sharpe or reduce correlation?",
    "3. **Edit** scripts/autoresearch/strategy.ts with your new strategy",
    "4. **Run** `npx tsx scripts/autoresearch/runner.ts` and carefully read ALL metrics",
    f"5. **Learn** - append what you learned to scripts/autoresearch/journal.md under a new \"## Iteration {i}\" heading. Include:",
    "   - What you tried and why",
    "   - What the result was (key numbers)",
    "   - What this teaches you for next iterations",
    "   - Updated hypotheses",
    "",
    "## Rules",
    "- strategy.ts must export `strategy` as StrategyDefinition",
    "- Import DEFAULT_CREDIT_CONFIG or DEFAULT_LEAP_CONFIG from ../../src/lib/backtest/option-sim",
    "- Available modes: CREDIT_SPREAD, LEAP",
    "- 25 tickers: AAPL,AMD,AMZN,AVGO,BA,COIN,COST,GLD,GOOG,GS,HOOD,IWM,JPM,LULU,META,MSFT,MSTR,NFLX,NVDA,PLTR,QQQ,SPY,TSLA,UBER,UNH",
    "- Validity: OOS Sharpe>0, min 100 trades, MaxDD<35%, (holdout Sharpe >= 0 OR holdout Information Ratio >= 0) — the IR gate catches strategies that beat SPY in bad regimes even when absolute Sharpe is muted",
    "- Key metric: combinedSharpe (50/50 with DTE5). Low correlation is very valuable.",
    "- Sanity bound: OOS Sharpe > 3.0 is auto-rejected (catches simulator bugs). DTE5's baseline is ~0.5 standalone; anything dramatically higher needs forensic justification.",
    "- SPY Information Ratio is now computed for both selection and holdout periods. Use it as a secondary quality signal: a strategy with Sharpe 0.3 and IR 0.8 is FAR better than Sharpe 1.5 and IR -0.2 (the latter is riding a bull regime).",
    "- Read scripts/autoresearch/program.md if you need full details on available data and modes",
    "- Read docs/backtest-trust-gotchas.md BEFORE making claims about any result — it lists every known simulator bug and validation trap that has produced fake results.",
    "",
    "Be creative. Try fundamentally different approaches, not just parameter tweaks.",
]

with open(out, 'w') as f:
    f.write('\n'.join(parts))
PYSCRIPT

  # Single iteration: analyze → edit → run → learn
  # Pipe prompt via stdin (not command-line arg) to avoid macOS ARG_MAX limit.
  # The journal grows each iteration, so by ~iter 4 the combined prompt exceeds
  # ARG_MAX (~256KB) and claude fails with "Argument list too long".
  # Using sonnet instead of opus for cost efficiency — the structured loop
  # doesn't need opus-level creativity and sonnet is ~5x cheaper.
  cat "$PROMPT_FILE" | claude --model sonnet \
    --allowedTools "Edit,Read,Write,Bash(npx tsx scripts/autoresearch/runner.ts)" \
    -p 2>&1 | tee -a "$AUTORESEARCH_DIR/run-log.txt"
  rm -f "$PROMPT_FILE"

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
valid = [x for x in data if x.get('isValid')]
print(f'Total attempts: {len(data)}, Valid: {len(valid)}')
if valid:
    best = max(valid, key=lambda x: x['combinedSharpe'])
    print(f'Best: {best[\"strategyName\"]} — combined Sharpe {best[\"combinedSharpe\"]:.3f}')
    print(f'  Correlation: {best[\"correlationWithDTE5\"]:.3f}')
    print(f'  Standalone: Sharpe {best[\"oosSharpe\"]:.3f}, MaxDD {best[\"oosMaxDD\"]:.1f}%, Trades {best[\"oosTrades\"]}')
    print(f'  Holdout ratio: {best.get(\"holdoutOOSRatio\", 0):.2f}')
print()
print('See best-strategy.ts for the champion code.')
print('See journal.md for the agent\\'s accumulated insights.')
" 2>/dev/null
