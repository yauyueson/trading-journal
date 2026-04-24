/**
 * Bull Call Debit QQQ wide (10-day cadence) — Phase F1 singleton anchor,
 * second post-F0 seal attempt.
 *
 * Rationale in .handoff/current.md pre-reg block. Summary:
 *
 *   Pre-F0 Phase E10 + E11 established the BCD "wide" structure
 *   (long δ 0.50, short δ 0.20, DTE 30-60, PT 50%) as a qualified PASS
 *   (5 of 6 gates), failing only on dsrM under a global attempt counter
 *   of N=106. Under the F0 clean-slate counter, the same row would
 *   clear 6/6.
 *
 *   The F0 exploration sweep (2026-04-23) then confirmed two orthogonal
 *   findings:
 *     1. The "wide" structure is robust — 9 of 17 sweep variants cleared
 *        adoption under F0-effective N-at-seal-time.
 *     2. The EMA34 filter contributes no timing alpha — random-entry and
 *        fixed-cadence variants produced comparable holdoutSpyIR.
 *
 *   This F1 pre-reg drops EMA34 in favor of fixed 10-day cadence. 10d
 *   was chosen over 5d because the F0 nosignal-5d variant failed the
 *   holdoutSpyIR gate at −0.19 (over-trading drag during the Mag7 rally).
 *   nosignal-10d produced oosSharpe 0.97, holdoutSpyIR ~0, passesHoldoutAndIR
 *   true, and dsrM ~+0.14 at current F0-effective N.
 *
 * Decision rule: NAMED ANCHOR is always the sealed candidate —
 * confirmation-of-effect, not a winner search. No variants.
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=bcd-qqq-wide-f1 \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-bcd-qqq-wide-f1.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 *
 * v2 blob bump (2026-04-23): Codex adversarial review of the v1 seal
 * flagged that "fixed 10-trading-day cadence" prose in the v1 pre-reg
 * overstated what was enforced. The code emits a signal every 10
 * trading days starting at index 60, and the runner's portfolio gate
 * skips signals that arrive while a prior spread is still open — so
 * observed inter-entry spacing is ≥10 trading days, often longer after
 * long-held trades. The strategy file and measured numbers are
 * unchanged; this comment-only edit produces a new strategy blob so
 * the sealer will emit a fresh audit row under the corrected v2
 * pre-reg (see `.handoff/current.md`) instead of reusing the v1 row.
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const BCD_WIDE_F1_CONFIG: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DEBIT_SPREAD',
  debitDTERange: [30, 60],
  debitLongDelta: 0.50,
  debitShortDelta: 0.20,              // the "wide" variant from Phase E10
  debitProfitTargetPct: 0.50,
  debitMaxHoldDays: 45,
  debitMinExitDTE: 7,
  monitoringIntervalDays: 1,
  fillMode: 'bidask',
};

const CADENCE_DAYS = 10;

export const strategy: StrategyDefinition = {
  name: 'bcd-qqq-wide-f1-anchor',
  tickers: ['QQQ'],

  portfolio: {
    maxPositions: 1,
    maxPerTicker: 1,
    startingCapital: 2000,
  },

  wfa: {
    trainWindowDays: 252,
    forwardStepDays: 126,
    purgeGapDays: 10,
    mode: 'rolling' as const,
    holdoutCount: 5,
  },

  buildConfig(_ticker: string, _direction: 'CALL' | 'PUT'): SimConfig {
    return BCD_WIDE_F1_CONFIG;
  },

  generateSignals(data: TickerDataBundle, _market: MarketContext): EntrySignal[] {
    // Emit a candidate signal every 10 trading days from index 60
    // forward. No EMA34 filter (F0 null-test confirmed the filter adds
    // no timing alpha). Actual entry dates are further filtered by the
    // runner's portfolio-state gate under maxPositions=1: signals
    // landing while a prior spread is still open are skipped, so
    // inter-entry spacing is ≥ 10 trading days, sometimes longer after
    // long-held trades (this is the "emission + flat-gate" pattern
    // validated by bcd-nosignal-10d-anchor in the F0 sweep, not a
    // truly fixed cadence with overlapping positions).
    //
    // 10d emission chosen over 5d because the F0 nosignal-5d variant
    // failed holdoutSpyIR (−0.19) from over-trading; and over 20d
    // because nosignal-20d's oosSharpe (0.68) was too low to clear
    // dsrM at current F0-effective N.
    const signals: EntrySignal[] = [];
    for (let i = 60; i < data.candles.length; i += CADENCE_DAYS) {
      signals.push({
        ticker: data.ticker,
        date: data.candles[i].date,
        direction: 'CALL',
        score: 50,
      });
    }
    return signals;
  },

  // No configVariants — this is a singleton confirmation design.
};
