/**
 * Unified Eval Worker — LEAP + Credit Spread modes
 *
 * Runs in a worker_threads thread. Each worker opens its own read-only
 * SQLite connection. All option chain data must be pre-cached.
 *
 * Dispatches on config.mode to run the appropriate simulator.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { initDB, closeDB } from '../src/lib/backtest/chain-cache.ts';
import {
  simulateCreditSpread, simulateLeap, computeOptionAnalytics,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionSimAnalytics,
} from '../src/lib/backtest/option-sim.ts';

// ── Types (shared with unified-eval.ts) ─────────────────

interface TickerSignals {
  ticker: string;
  entries: EntrySignal[];
  allTradingDates: string[];
}

export interface EvalWorkItem {
  id: number;
  config: SimConfig;
  minScore: number;
  maxScore: number;
  tierLabel: string;
  ivLabel: string;
  tpLabel: string;
  slLabel: string;
}

export interface EvalWorkResult {
  type: 'result';
  id: number;
  analytics: OptionSimAnalytics;
  trades: OptionTrade[];
  tierLabel: string;
  ivLabel: string;
  tpLabel: string;
  slLabel: string;
}

// ── Initialization ──────────────────────────────────────

const { allSignals, maxDate, token } = workerData as {
  allSignals: TickerSignals[];
  maxDate: string;
  token: string;
};

initDB();
parentPort!.postMessage({ type: 'ready' });

// ── Work Processing ─────────────────────────────────────

parentPort!.on('message', async (msg: EvalWorkItem | { type: 'exit' }) => {
  if ('type' in msg && msg.type === 'exit') {
    closeDB();
    process.exit(0);
  }

  const item = msg as EvalWorkItem;

  try {
    // Guard BUY_WRITE up front, outside the signal loop. Dispatching it
    // here would fall through to simulateCreditSpread; if a tier happens
    // to produce zero filtered signals the loop never runs and the worker
    // would silently report a successful zero-trade result instead of the
    // intended error (Codex round-5 P3).
    if (item.config.mode === 'BUY_WRITE') {
      throw new Error(
        "BUY_WRITE requires simulateBuyWrite — not dispatchable via eval-worker. " +
        "BUY_WRITE is a benchmark-replication mode; call simulateBuyWrite directly from a replication script.",
      );
    }

    if (item.config.mode === 'DIAGONAL') {
      throw new Error(
        "DIAGONAL requires simulateDiagonal — not dispatchable via eval-worker. " +
        "DIAGONAL is a PMCC-campaign mode; call simulateDiagonal directly from the PMCC runner.",
      );
    }

    const trades: OptionTrade[] = [];

    for (const ts of allSignals) {
      // Filter signals by tier (score range)
      const filtered = ts.entries.filter(
        e => e.score >= item.minScore && e.score < item.maxScore,
      );

      // Simulate with overlap avoidance (per ticker)
      let exitDate: string | null = null;
      for (const signal of filtered) {
        if (exitDate && signal.date < exitDate) continue;
        exitDate = null;

        const trade = item.config.mode === 'LEAP'
          ? await simulateLeap(token, signal, item.config, ts.allTradingDates, maxDate)
          : await simulateCreditSpread(token, signal, item.config, ts.allTradingDates, maxDate);

        if (trade) {
          trades.push(trade);
          exitDate = trade.exitDate;
        }
      }
    }

    const analytics = computeOptionAnalytics(trades);
    const result: EvalWorkResult = {
      type: 'result',
      id: item.id,
      analytics,
      trades: [], // trades stay in worker — only analytics cross thread boundary
      tierLabel: item.tierLabel,
      ivLabel: item.ivLabel,
      tpLabel: item.tpLabel,
      slLabel: item.slLabel,
    };
    parentPort!.postMessage(result);
  } catch (err: any) {
    // Always post a result — never let a worker die silently
    parentPort!.postMessage({
      type: 'result',
      id: item.id,
      analytics: { totalTrades: 0, winners: 0, losers: 0, winRate: 0, avgPnlPct: 0, totalPnl: 0, totalCapitalDeployed: 0, returnOnCapital: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0, avgHoldDays: 0, avgEntryDelta: 0, avgEntryDTE: 0, avgCapitalPerTrade: 0, byExit: {}, mode: item.config.mode },
      trades: [],
      tierLabel: item.tierLabel,
      ivLabel: item.ivLabel,
      tpLabel: item.tpLabel,
      slLabel: item.slLabel,
      error: err.message,
    } as EvalWorkResult);
  }
});
