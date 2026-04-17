#!/usr/bin/env bash
# Campaign A — Regime Gate sweep on d65-tp40
# Pre-registered in .prompts/campaign-a-regime-gate-preregistration.md
#
# Runs baseline + 6 regime gate candidates under holdoutCount=5.
# Isolated leaderboard (leaderboard-campaign-a.json); deflated Sharpe resets.
#
# Usage:
#   bash scripts/autoresearch/run-campaign-a.sh [gate1 gate2 ...]
#
# Default: runs all 7 variants (baseline first, then the 6 gates).

set -euo pipefail
cd "$(dirname "$0")/../.."

GATES=("${@:-none ticker_ema200 breadth spy_extension contango_tight rv_regime trend_age}")

mkdir -p .handoff/history
LOG_DIR="scripts/autoresearch/campaign-a-logs"
mkdir -p "$LOG_DIR"

for gate in ${GATES[@]}; do
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "   Campaign A: GATE=$gate"
  echo "═══════════════════════════════════════════════════════════════"
  GATE="$gate" AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-a \
    npx tsx scripts/autoresearch/runner.ts \
    2>&1 | tee "$LOG_DIR/${gate}.log"
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "   Campaign A complete. Generating analysis..."
echo "═══════════════════════════════════════════════════════════════"
npx tsx scripts/autoresearch/analyze-campaign-a.ts
