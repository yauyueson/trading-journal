/**
 * Experiment Worker — Handles sizing, score-exit, and option filter experiments
 *
 * Extensions over portfolio-worker.ts:
 *  1. contractsPerSignal: multiplies trade P&L and collateral
 *  2. scoreExitThreshold: exits early if tech score drops below threshold
 *  3. optionFilter: rejects trades that fail option-level quality checks
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  initDB, closeDB, fetchHistoricalChain, findSpreadStrikes, findContract,
  type ChainRow, type SpreadMatch, type StrikeMatch,
} from '../src/lib/backtest/chain-cache.ts';
import {
  type EntrySignal, type SimConfig, type OptionTrade,
} from '../src/lib/backtest/option-sim.ts';

// ── Types ────────────────────────────────────────────────

interface TickerSignals {
  ticker: string;
  entries: EntrySignal[];
  allTradingDates: string[];
}

interface OptionFilter {
  key: string;
  minShortVolume: number;
  minShortOI: number;
  maxBidAskPct: number;
  minEntryIV: number;
  maxEntryIV: number;
  minNetCreditPct: number;
}

interface TradeGenWorkItem {
  id: number;
  config: SimConfig;
  minScore: number;
  maxScore: number;
  maxPerTicker: number;
  contractsPerSignal: number;
  scoreExitThreshold: number;
  optionFilter: OptionFilter;
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

type OptionExitType = 'PROFIT_TARGET' | 'STOP_LOSS' | 'TIME_STOP' | 'EXPIRATION' | 'NO_CHAIN' | 'SCORE_EXIT';

// ── Initialization ──────────────────────────────────────

const { allSignals, maxDate, token, scoreSeriesData } = workerData as {
  allSignals: TickerSignals[];
  maxDate: string;
  token: string;
  scoreSeriesData?: {
    signalKey: string;
    data: [string, [string, number][]][];
  };
};

// Rebuild score series map from serialized data
const scoreLookup = new Map<string, Map<string, number>>(); // ticker → date → score
if (scoreSeriesData) {
  for (const [ticker, entries] of scoreSeriesData.data) {
    scoreLookup.set(ticker, new Map(entries));
  }
}

initDB();
parentPort!.postMessage({ type: 'ready' });

// ── Helper: advance trading days ────────────────────────

function advanceTradingDays(allDates: string[], fromDate: string, n: number): string | null {
  const idx = allDates.indexOf(fromDate);
  if (idx < 0) {
    const nextIdx = allDates.findIndex(d => d > fromDate);
    if (nextIdx < 0) return null;
    return allDates[Math.min(nextIdx + n - 1, allDates.length - 1)] ?? null;
  }
  return idx + n < allDates.length ? allDates[idx + n] : null;
}

function getMonitoringDates(allDates: string[], entryDate: string, interval: number, maxDate: string): string[] {
  const dates: string[] = [];
  let current = entryDate;
  while (true) {
    const next = advanceTradingDays(allDates, current, interval);
    if (!next || next > maxDate) break;
    dates.push(next);
    current = next;
  }
  return dates;
}

// ── Option filter check ─────────────────────────────────

function passesOptionFilter(spread: SpreadMatch, filter: OptionFilter, spreadWidth: number): boolean {
  const shortLeg = spread.short;

  // Volume filter
  if (filter.minShortVolume > 0 && shortLeg.volume < filter.minShortVolume) return false;

  // OI filter
  if (filter.minShortOI > 0 && shortLeg.oi < filter.minShortOI) return false;

  // Bid-ask spread % filter (on short leg)
  if (filter.maxBidAskPct > 0 && shortLeg.mid > 0) {
    const baPct = (shortLeg.ask - shortLeg.bid) / shortLeg.mid;
    if (baPct > filter.maxBidAskPct) return false;
  }

  // IV range filter
  if (shortLeg.iv < filter.minEntryIV) return false;
  if (shortLeg.iv > filter.maxEntryIV) return false;

  // Net credit as % of spread width
  if (filter.minNetCreditPct > 0 && spreadWidth > 0) {
    const creditPct = spread.netCredit / spreadWidth;
    if (creditPct < filter.minNetCreditPct) return false;
  }

  return true;
}

// ── Credit spread simulation with experiments ───────────

async function simulateCreditSpreadExperiment(
  signal: EntrySignal,
  config: SimConfig,
  allTradingDates: string[],
  maxDateStr: string,
  contractsPerSignal: number,
  scoreExitThreshold: number,
  optionFilter: OptionFilter,
): Promise<TradeSummary | null> {
  // Fetch entry day chain
  const entryChain = await fetchHistoricalChain(token, signal.ticker, signal.date, [0.01, 0.99]);
  if (entryChain.length === 0) return null;

  const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';

  const spread = findSpreadStrikes(
    entryChain,
    config.creditShortDelta,
    config.creditSpreadWidth,
    optionType,
    config.creditDTERange,
  );
  if (!spread || spread.netCredit <= 0) return null;

  // Apply option filter
  if (!passesOptionFilter(spread, optionFilter, config.creditSpreadWidth)) return null;

  const entryCredit = spread.netCredit;
  const tpCost = entryCredit * (1 - config.creditProfitTarget);
  const slCost = entryCredit * config.creditStopLossMultiple;

  const monitorEnd = spread.short.row.expir_date < maxDateStr ? spread.short.row.expir_date : maxDateStr;
  const monitorDates = getMonitoringDates(allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd);

  // Get score lookup for this ticker (for score-based exit)
  const tickerScores = scoreExitThreshold > 0 ? scoreLookup.get(signal.ticker) : null;

  for (const checkDate of monitorDates) {
    // Score-based exit check (before fetching chain — cheap check first)
    if (scoreExitThreshold > 0 && tickerScores) {
      const currentScore = tickerScores.get(checkDate);
      // If score exists and dropped below threshold, AND signal direction reversed or score tanked
      if (currentScore != null && currentScore < scoreExitThreshold) {
        // Fetch chain to get exit price
        const chain = await fetchHistoricalChain(token, signal.ticker, checkDate, [0.01, 0.99]);
        if (chain.length > 0) {
          const shortLeg = findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType);
          const longLeg = findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType);
          if (shortLeg && longLeg) {
            const currentSpreadCost = shortLeg.mid - longLeg.mid;
            return buildTradeSummary(
              signal, spread, entryCredit, checkDate, currentSpreadCost,
              'SCORE_EXIT', contractsPerSignal,
            );
          }
        }
      }
    }

    const chain = await fetchHistoricalChain(token, signal.ticker, checkDate, [0.01, 0.99]);
    if (chain.length === 0) continue;

    const shortLeg = findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType);
    if (!shortLeg || !longLeg) continue;

    const currentSpreadCost = shortLeg.mid - longLeg.mid;
    const currentDTE = shortLeg.row.dte;

    let exitType: OptionExitType | null = null;

    if (currentSpreadCost <= tpCost) {
      exitType = 'PROFIT_TARGET';
    } else if (currentSpreadCost >= slCost) {
      exitType = 'STOP_LOSS';
    } else if (currentDTE <= config.creditTimeStopDTE) {
      exitType = 'TIME_STOP';
    }

    if (exitType) {
      return buildTradeSummary(
        signal, spread, entryCredit, checkDate, currentSpreadCost,
        exitType, contractsPerSignal,
      );
    }
  }

  // Close at last monitoring date
  const lastDate = monitorDates[monitorDates.length - 1];
  if (lastDate) {
    const chain = await fetchHistoricalChain(token, signal.ticker, lastDate, [0.01, 0.99]);
    const shortLeg = findContract(chain, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const longLeg = findContract(chain, spread.long.row.strike, spread.long.row.expir_date, optionType);

    let currentSpreadCost: number;
    if (shortLeg && longLeg) {
      currentSpreadCost = shortLeg.mid - longLeg.mid;
    } else {
      const stockPrice = (shortLeg || longLeg)?.row.stock_price ?? spread.short.row.stock_price;
      const shortIntrinsic = optionType === 'Put'
        ? Math.max(0, spread.short.row.strike - stockPrice)
        : Math.max(0, stockPrice - spread.short.row.strike);
      const longIntrinsic = optionType === 'Put'
        ? Math.max(0, spread.long.row.strike - stockPrice)
        : Math.max(0, stockPrice - spread.long.row.strike);
      currentSpreadCost = shortIntrinsic - longIntrinsic;
    }

    return buildTradeSummary(
      signal, spread, entryCredit, lastDate, currentSpreadCost,
      'EXPIRATION', contractsPerSignal,
    );
  }

  return null;
}

function buildTradeSummary(
  signal: EntrySignal,
  spread: SpreadMatch,
  entryCredit: number,
  exitDate: string,
  exitSpreadCost: number,
  exitType: string,
  contracts: number,
): TradeSummary {
  const pnlPerContract = (entryCredit - exitSpreadCost) * 100;
  const maxLossPerContract = spread.maxLoss * 100;
  const pnlPct = spread.maxLoss > 0 ? pnlPerContract / maxLossPerContract : 0;
  const holdDays = Math.round(
    (new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000
  );

  return {
    ticker: signal.ticker,
    entryDate: signal.date,
    exitDate,
    pnl: pnlPerContract * contracts,
    pnlPct,
    holdDays,
    maxLoss: maxLossPerContract * contracts,
    entryPrice: entryCredit,
    exitType,
    score: signal.score,
    direction: signal.direction,
    entryDelta: spread.short.delta,
    entryDTE: spread.short.row.dte,
  };
}

// ── Work Processing ─────────────────────────────────────

parentPort!.on('message', async (msg: TradeGenWorkItem | { type: 'exit' }) => {
  if ('type' in msg && msg.type === 'exit') {
    closeDB();
    process.exit(0);
  }

  const item = msg as TradeGenWorkItem;

  try {
    const trades: TradeSummary[] = [];

    for (const ts of allSignals) {
      const filtered = ts.entries.filter(
        e => e.score >= item.minScore && e.score < item.maxScore,
      );

      const openExits: string[] = [];
      for (const signal of filtered) {
        while (openExits.length > 0 && openExits[0] <= signal.date) openExits.shift();
        if (openExits.length >= item.maxPerTicker) continue;

        const trade = await simulateCreditSpreadExperiment(
          signal,
          item.config,
          ts.allTradingDates,
          maxDate,
          item.contractsPerSignal,
          item.scoreExitThreshold,
          item.optionFilter,
        );

        if (trade) {
          trades.push(trade);
          openExits.push(trade.exitDate);
          openExits.sort();
        }
      }
    }

    parentPort!.postMessage({ type: 'result', id: item.id, trades });
  } catch (err: any) {
    parentPort!.postMessage({ type: 'result', id: item.id, trades: [], error: err.message });
  }
});
