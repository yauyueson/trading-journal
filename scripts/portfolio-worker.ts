/**
 * Portfolio Sim Worker — generates trades with per-ticker overlap avoidance
 *
 * Unlike eval-worker.ts which returns analytics, this worker returns
 * individual trade summaries so the portfolio allocator can make
 * capital-constrained decisions.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { initDB, closeDB } from '../src/lib/backtest/chain-cache.ts';
import {
  simulateCreditSpread,
  simulateCreditSpreadPhased,
  type EntrySignal, type SimConfig, type OptionTrade, type PhasedTPConfig,
} from '../src/lib/backtest/option-sim.ts';

// ── Types ────────────────────────────────────────────────

interface TickerSignals {
  ticker: string;
  entries: EntrySignal[];
  allTradingDates: string[];
}

interface TradeGenWorkItem {
  id: number;
  config: SimConfig;
  minScore: number;
  maxScore: number;
  maxPerTicker: number;
  phasedConfig?: PhasedTPConfig;
}

interface TradeSummary {
  ticker: string;
  entryDate: string;
  exitDate: string;
  pnl: number;
  pnlPct: number;
  holdDays: number;
  maxLoss: number;
  entryPrice: number;
  exitType: string;
  score: number;
  direction: string;
  entryDelta: number;
  entryDTE: number;
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

function tradeToSummary(trade: OptionTrade, score: number): TradeSummary {
  return {
    ticker: trade.ticker,
    entryDate: trade.entryDate,
    exitDate: trade.exitDate,
    pnl: trade.pnl,
    pnlPct: trade.pnlPct,
    holdDays: trade.holdDays,
    maxLoss: (trade.maxLoss ?? trade.entryPrice) * 100,
    entryPrice: trade.entryPrice,
    exitType: trade.exitType,
    score,
    direction: trade.direction,
    entryDelta: trade.entryDelta,
    entryDTE: trade.entryDTE,
  };
}

parentPort!.on('message', async (msg: TradeGenWorkItem | { type: 'exit' }) => {
  if ('type' in msg && msg.type === 'exit') {
    closeDB();
    process.exit(0);
  }

  const item = msg as TradeGenWorkItem;

  try {
    // BUY_WRITE is a benchmark-replication mode (Phase 0.c.9 BXM) and is
    // not supposed to be dispatched through the portfolio pipeline.
    // Without this guard the call below would fall through to
    // simulateCreditSpread and silently produce credit-spread trades
    // instead of covered-call trades, corrupting any backtest launched
    // via portfolio-sim.ts with mode='BUY_WRITE'.
    if (item.config.mode === 'BUY_WRITE') {
      throw new Error(
        "BUY_WRITE requires simulateBuyWrite — not dispatchable via portfolio-worker. " +
        "Call simulateBuyWrite directly from the CBOE replication script.",
      );
    }

    const trades: TradeSummary[] = [];
    const maxPerTicker = item.maxPerTicker || 1;

    for (const ts of allSignals) {
      // Filter signals by tier (score range)
      const filtered = ts.entries.filter(
        e => e.score >= item.minScore && e.score < item.maxScore,
      );

      // Simulate with per-ticker overlap avoidance (N concurrent positions)
      const openExits: string[] = [];
      for (const signal of filtered) {
        // Remove expired positions
        while (openExits.length > 0 && openExits[0] <= signal.date) openExits.shift();
        if (openExits.length >= maxPerTicker) continue;

        const trade = item.phasedConfig
          ? await simulateCreditSpreadPhased(
              token, signal, item.config, item.phasedConfig, ts.allTradingDates, maxDate)
          : await simulateCreditSpread(
              token, signal, item.config, ts.allTradingDates, maxDate);

        if (trade) {
          trades.push(tradeToSummary(trade, signal.score));
          openExits.push(trade.exitDate);
          openExits.sort();
        }
      }
    }

    parentPort!.postMessage({
      type: 'result',
      id: item.id,
      trades,
    });
  } catch (err: any) {
    parentPort!.postMessage({
      type: 'result',
      id: item.id,
      trades: [],
      error: err.message,
    });
  }
});
