# Codex Review Prompt: Autoresearch System Audit

Please review the autoresearch system in this repo for **accuracy, trustworthiness, performance, and token efficiency**. This is a live trading strategy research loop — bugs here directly affect whether backtest results can be trusted.

## System Overview

The autoresearch system is an autonomous research loop in `scripts/autoresearch/`:

1. `run-overnight.sh` — bash loop that invokes a Claude/Sonnet agent N times
2. Each iteration: agent reads leaderboard + journal → edits `strategy.ts` → runner evaluates → agent logs learnings
3. `runner.ts` — the evaluation engine: loads price/IV data from Supabase, runs WFA, computes metrics, writes to `leaderboard.json`
4. `worker.ts` — parallel worker thread that runs per-window strategy simulation
5. `strategy.ts` — the file the agent edits each iteration (current champion: `momentum-ma-touch-leap-weekly-v23`)
6. `types.ts` — shared types for runner/worker
7. `journal.md` — the agent's accumulated learning log
8. `leaderboard.json` — all attempts with full metrics

## Files to Review

Primary files (read all of these):
- `scripts/autoresearch/runner.ts` — **most critical**
- `scripts/autoresearch/worker.ts` — **most critical**
- `scripts/autoresearch/run-overnight.sh`
- `scripts/autoresearch/types.ts`
- `scripts/autoresearch/strategy.ts` (current champion config)

Context files (read for background):
- `docs/backtest-trust-gotchas.md` — catalogue of every known simulator bug, REQUIRED reading before making any accuracy claim
- `src/lib/backtest/credit-spread-exit.ts` — exit logic used by worker
- `src/lib/backtest/wfa-options.ts` — WFA engine used by runner
- `src/lib/backtest/option-sim.ts` — option simulator

## Review Dimensions

### 1. Accuracy / Trustworthiness

The project has a history of subtle bugs producing fake backtest results. Focus on:

- **Metric computation correctness**: Is `combinedSharpe` correctly computed as a weighted combination of strategy Sharpe and DTE5 Sharpe? Check the formula.
- **Information Ratio**: Is the SPY IR formula correct? (`mean(excess) / stdev(excess) * sqrt(252)`). Is the date intersection logic sound?
- **Correlation measurement artifact**: 3-day monitoring intervals (`monitoringIntervalDays=3`) produce sparse `dailyMtM` series (67% zero days), which artificially deflates correlation with DTE5. Is this artifact acknowledged in the output? Is the correlation number reported as-is or corrected?
- **WFA data leakage**: Are train and OOS windows properly separated? Does `purgeGapDays=10` correctly exclude transition data from both windows?
- **Holdout separation**: Are the last N windows (holdoutCount=2) truly held out from champion selection, or can the agent implicitly overfit to them through the leaderboard?
- **Bootstrap CI correctness**: Is the bootstrap resampling done on daily returns (correct) or on trades (incorrect)?
- **Deflated Sharpe**: Is the Bailey-López de Prado deflated Sharpe formula correctly implemented? Does it account for all 114 prior trials?
- **LEAP vs credit spread mode switching**: Does `worker.ts` correctly handle both `CREDIT_SPREAD` and `LEAP` modes without cross-contaminating exit logic?
- **TRAILING_LOCK exit**: Previously had a critical bug (exit at floor price instead of market price). Verify the fix in `credit-spread-exit.ts` is correct and that LEAP mode doesn't have an equivalent issue.
- **Known traps**: Cross-reference against `docs/backtest-trust-gotchas.md` — are any of the 22+ documented traps still present or potentially re-introduced?

### 2. Performance

The runner is the inner loop — it runs on every agent iteration. Slow = fewer iterations per hour = less research:

- **Data loading**: Are Supabase fetches parallelized across tickers? Or sequential? How many round-trips per run?
- **Worker pool sizing**: Currently `NUM_WORKERS=4` (reduced from 8 due to segfaults). What's causing the segfaults? Is there a safer way to use 8 workers?
- **SQLite chain cache**: Does `chain-cache.ts` effectively reduce ORATS API calls? Is the cache hit rate high?
- **Memory usage**: With 12 tickers × ~2200 candles × multiple WFA windows, is there anything obviously wasteful in memory allocation?
- **EMA computation**: Are EMAs recomputed per window, or cached once per ticker? Same for IV rank series.
- **Bottleneck identification**: Where is most time spent? (Data loading vs WFA computation vs chain lookups vs output)

### 3. Token Efficiency (Shell Loop)

Each iteration uses one Claude/Sonnet API call. The prompt includes the full journal which grows every iteration:

- **Journal growth**: The journal is now ~500+ lines and included verbatim in every prompt. At ~30 min/iteration, this means later iterations send 3-4x more tokens than early ones. Is there a smarter approach? (e.g., summarize old entries, keep only last N + key findings)
- **Leaderboard context**: The shell script includes the last 10 attempts + champion in the prompt. Is this optimal, or is there important context being omitted/over-included?
- **Prompt structure**: Does the agent's task description in `run-overnight.sh` give it the right amount of context without waste? Are there repeated/redundant sections?
- **Tool restrictions**: The agent is restricted to `Edit,Read,Write,Bash(npx tsx scripts/autoresearch/runner.ts)`. Is this correct and tight enough? Any missing tools it legitimately needs?
- **Response waste**: Does the agent tend to output long reasoning before acting? Is there a prompt change that would make it more concise?

### 4. Process Reliability

- **Error handling**: If the runner crashes mid-iteration, what happens? Does the shell loop continue or abort? Is partial output written to the leaderboard?
- **Idempotency**: If the same strategy name is submitted twice, does the leaderboard deduplicate or create duplicate entries?
- **ARG_MAX fix**: The current fix uses `cat file | claude -p` (stdin piping). Verify this is correct and won't break on long prompts.
- **Segfault root cause**: 8-worker config causes intermittent segfaults. Identify the likely cause (SQLite concurrency? shared memory? `better-sqlite3` + worker threads?).
- **`set -e` in shell loop**: The loop has `set -e` which will abort on any non-zero exit. Is this appropriate? Could a single runner failure kill a 50-iteration overnight run?

## Output Format

Please structure your output as:

```
## Accuracy Findings
[numbered issues with severity: CRITICAL / WARNING / INFO]

## Performance Findings
[numbered findings with estimated impact]

## Token Efficiency Findings
[numbered recommendations]

## Reliability Findings
[numbered issues]

## Summary
[top 3-5 highest-priority items to fix]
```

For each CRITICAL or WARNING finding, include:
- What the bug/issue is
- Where in the code (file:line)
- What the impact is on results
- A concrete fix suggestion
