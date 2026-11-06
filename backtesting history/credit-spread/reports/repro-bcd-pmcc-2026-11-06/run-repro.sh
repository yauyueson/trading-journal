#!/bin/zsh
# usage: run-repro.sh <worktree> <suffix> <strategy-file> <logname> [extra env...]
S=$(dirname $0); W=$S/$1; shift
SUF=$1; STRAT=$2; LOG=$S/$3.log; shift 3
cd $W
env -u ORATS_API_TOKEN -u TIINGO_API_TOKEN \
  VITE_SUPABASE_URL=http://127.0.0.1:9 SUPABASE_URL=http://127.0.0.1:9 \
  VITE_SUPABASE_ANON_KEY=x SUPABASE_ANON_KEY=x \
  AUTORESEARCH_LEADERBOARD_SUFFIX=$SUF AUTORESEARCH_STRATEGY_FILENAME=$STRAT \
  AUTORESEARCH_PREREG_BYPASS="repro 2026-11-06" "$@" \
  npx tsx scripts/autoresearch/runner.ts > $LOG 2>&1
echo "exit=$?" >> $LOG
