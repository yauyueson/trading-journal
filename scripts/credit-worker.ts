/**
 * Credit Spread Worker — runs in a worker_threads thread
 *
 * Each worker opens its own read-only SQLite connection and processes
 * simulation work items in parallel. All option chain data must be
 * pre-cached (no API calls from workers).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { initDB, closeDB } from '../src/lib/backtest/chain-cache.ts';
import {
  simulateCreditSpread, computeOptionAnalytics,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionSimAnalytics,
} from '../src/lib/backtest/option-sim.ts';

interface TickerSignals {
  ticker: string;
  entries: EntrySignal[];
  allTradingDates: string[];
}

interface WorkItem {
  id: number;
  config: SimConfig;
  minScore: number;
  maxScore: number;
  tierLabel: string;
  ivLabel: string;
  tpLabel: string;
  slLabel: string;
}

interface WorkResult {
  type: 'result';
  id: number;
  analytics: OptionSimAnalytics;
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

parentPort!.on('message', async (msg: WorkItem | { type: 'exit' }) => {
  if ('type' in msg && msg.type === 'exit') {
    closeDB();
    process.exit(0);
  }

  const item = msg as WorkItem;
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
      const trade = await simulateCreditSpread(
        token, signal, item.config, ts.allTradingDates, maxDate,
      );
      if (trade) {
        trades.push(trade);
        exitDate = trade.exitDate;
      }
    }
  }

  const analytics = computeOptionAnalytics(trades);
  const result: WorkResult = {
    type: 'result',
    id: item.id,
    analytics,
    tierLabel: item.tierLabel,
    ivLabel: item.ivLabel,
    tpLabel: item.tpLabel,
    slLabel: item.slLabel,
  };
  parentPort!.postMessage(result);
});
