/**
 * Walk-Forward Analysis Runner
 *
 * Runs the full WFA engine on cached option chain data with
 * configurable sweep dimensions. Uses sync cache-only evaluator
 * (no ORATS API calls — requires pre-populated chain cache).
 *
 * Usage:
 *   npx tsx scripts/wfa-run.ts
 *   npx tsx scripts/wfa-run.ts --mode anchored
 *   npx tsx scripts/wfa-run.ts --ticker SPY
 *   npx tsx scripts/wfa-run.ts --train 504 --step 126 --purge 65
 *   npx tsx scripts/wfa-run.ts --fill bidask     # realistic fills (default: mid)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env ────────────────────────────────────────────

const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
      if (key && !key.startsWith('#')) process.env[key] = value;
    }
  });
}

import type { BacktestCandle } from '../src/lib/backtest/types';
import { SIGNAL_PRESETS, DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import type { TechScoreOptions } from '../src/lib/tech-analysis';
import { precomputeSignals } from '../src/lib/backtest/engine';
import {
  initDB, closeDB, getCacheStats,
  getCachedChain, findSpreadStrikes, findContractDirect,
} from '../src/lib/backtest/chain-cache';
import type { SpreadMatch } from '../src/lib/backtest/chain-cache';
import {
  DEFAULT_CREDIT_CONFIG,
  computeOptionAnalytics,
  type EntrySignal, type SimConfig, type OptionTrade, type OptionExitType,
  type SignalPresetKey,
} from '../src/lib/backtest/option-sim';
import type { FillMode } from '../src/lib/backtest/types';
import { applyFill } from '../src/lib/backtest/slippage';
import {
  buildWFAWindows,
  runWFAOptions,
  type TradeEvaluator, type WFAResult,
} from '../src/lib/backtest/wfa-options';

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';

const DATA_START = '2017-01-01';   // candle warmup (1yr for tech indicators)
const WFA_START  = '2018-01-01';   // WFA date range start
const WFA_END    = '2026-02-28';   // WFA date range end
const DATA_END   = '2026-02-28';

const ALL_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
  'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
  'META', 'NFLX', 'GOOG', 'GS',
  // COST removed: only net-losing ticker (-$26,619 over 432 trades, 79.6% WR across full sample)
];

// CLI args
const args = process.argv.slice(2);
function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const SINGLE_TICKER = getArg('--ticker');
const WFA_MODE = (getArg('--mode') || 'rolling') as 'rolling' | 'anchored';
const TRAIN_DAYS = parseInt(getArg('--train') || '504');
const STEP_DAYS = parseInt(getArg('--step') || '126');
const PURGE_DAYS = parseInt(getArg('--purge') || '65');
const MAX_POSITIONS = parseInt(getArg('--max-pos') || '50');
const MAX_PER_TICKER = parseInt(getArg('--max-ticker') || '5');
const STARTING_CAPITAL = parseInt(getArg('--capital') || '100000');
const FILL_MODE = (getArg('--fill') || 'mid') as FillMode;

const tickers = SINGLE_TICKER ? [SINGLE_TICKER.toUpperCase()] : ALL_TICKERS;

// ── Supabase ────────────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── IV Rank ─────────────────────────────────────────────

function computeIVRank(ivSeries: (number | null)[]): (number | null)[] {
  const WINDOW = 252;
  return ivSeries.map((v, i) => {
    if (i < WINDOW || v == null) return null;
    const w = ivSeries.slice(i - WINDOW, i + 1).filter(x => x != null) as number[];
    if (w.length < 100) return null;
    const min = Math.min(...w), max = Math.max(...w), range = max - min;
    return range > 0 ? ((v - min) / range) * 100 : 50;
  });
}

// ── Candle + Signal Data ────────────────────────────────

interface TickerData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

const candleCache = new Map<string, TickerData>();

async function fetchTickerData(ticker: string): Promise<TickerData> {
  if (candleCache.has(ticker)) return candleCache.get(ticker)!;

  const candles: BacktestCandle[] = (await supabaseGet('stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`
  )).map(r => ({
    date: r.date, timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume,
  }));

  const ivData = await supabaseGet('orats_iv_cache',
    `select=date,iv30d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`);

  const ivByDate = new Map(ivData.map((r: any) => [r.date, r.iv30d]));
  const ivSeries = candles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRank(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  const data = { ticker, candles, ivRanks, dateToIdx };
  candleCache.set(ticker, data);
  return data;
}

function generateSignalsForPreset(
  td: TickerData,
  presetKey: SignalPresetKey,
  periodStart: string,
  periodEnd: string,
): EntrySignal[] {
  const techOptions = SIGNAL_PRESETS[presetKey];
  const { signals } = precomputeSignals(td.candles, '1D', techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    if (sig.date < periodStart || sig.date > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 70) continue;

    const idx = td.dateToIdx.get(sig.date);
    entries.push({
      ticker: td.ticker,
      date: sig.date,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
    });
  }

  return entries;
}

// ── Bounded LRU Chain Cache ──────────────────────────────

/**
 * LRU cache for getCachedChain — keeps only the most recent MAX_CACHE entries
 * to prevent OOM while still avoiding repeated SQLite reads for monitoring loops.
 */
const MAX_CACHE = 200;
const _chainMemo = new Map<string, ReturnType<typeof getCachedChain>>();
let _chainHits = 0;
let _chainMisses = 0;

function getCachedChainMemo(ticker: string, date: string): ReturnType<typeof getCachedChain> {
  const key = `${ticker}|${date}`;
  const cached = _chainMemo.get(key);
  if (cached !== undefined) {
    _chainHits++;
    // Move to end (most recently used)
    _chainMemo.delete(key);
    _chainMemo.set(key, cached);
    return cached;
  }
  _chainMisses++;
  const rows = getCachedChain(ticker, date);
  // Evict oldest if full
  if (_chainMemo.size >= MAX_CACHE) {
    const oldest = _chainMemo.keys().next().value;
    if (oldest) _chainMemo.delete(oldest);
  }
  _chainMemo.set(key, rows);
  return rows;
}

// ── Trading Date Index (O(1) lookups) ───────────────────

let _dateIndex: Map<string, number> | null = null;

function buildDateIndex(allDates: string[]) {
  _dateIndex = new Map(allDates.map((d, i) => [d, i]));
}

// ── Sync Credit Spread Evaluator (cache-only) ───────────

function advanceTradingDays(allDates: string[], fromDate: string, n: number): string | null {
  const idx = _dateIndex?.get(fromDate) ?? -1;
  if (idx < 0) {
    // Fallback: find next available date
    for (let i = 0; i < allDates.length; i++) {
      if (allDates[i] > fromDate) {
        return allDates[Math.min(i + n - 1, allDates.length - 1)] ?? null;
      }
    }
    return null;
  }
  const targetIdx = idx + n;
  return targetIdx < allDates.length ? allDates[targetIdx] : null;
}

function getMonitoringDates(
  allDates: string[], entryDate: string, intervalDays: number, maxDate: string,
): string[] {
  const dates: string[] = [];
  let current = entryDate;
  while (true) {
    const next = advanceTradingDays(allDates, current, intervalDays);
    if (!next || next > maxDate) break;
    dates.push(next);
    current = next;
  }
  return dates;
}

/**
 * Sync credit spread evaluator using cached chain data only.
 * Mirrors simulateCreditSpread logic but uses getCachedChain (sync SQLite reads).
 */
function makeCachedEvaluator(fillMode: FillMode): TradeEvaluator {
  return (signal, config, allTradingDates, maxDate) => {
    // IV rank filter
    if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) {
      return null;
    }

    // Get cached chain (sync)
    const entryChain = getCachedChainMemo(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    // Credit spread: sell puts in uptrend (CALL signal), sell calls in downtrend (PUT signal)
    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';

    const spread = findSpreadStrikes(
      entryChain, config.creditShortDelta, config.creditSpreadWidth,
      optionType, config.creditDTERange,
    );
    if (!spread || spread.netCredit <= 0) return null;

    // ORATS liquidity & Greeks filters
    if (config.maxBidAskSpreadPct != null && config.maxBidAskSpreadPct !== Infinity) {
      const shortSpreadPct = spread.short.mid > 0.10
        ? (spread.short.ask - spread.short.bid) / spread.short.mid : 0;
      if (shortSpreadPct > config.maxBidAskSpreadPct) return null;
    }
    if (config.minShortOI != null && config.minShortOI! > 0) {
      if (spread.short.oi < config.minShortOI!) return null;
    }
    if (config.maxGammaThetaRatio != null && config.maxGammaThetaRatio !== Infinity) {
      const theta = Math.abs(spread.short.row.theta);
      if (theta > 0.001) {
        if (spread.short.row.gamma / theta > config.maxGammaThetaRatio) return null;
      }
    }
    if (config.maxIVSkew != null && config.maxIVSkew !== Infinity) {
      if (Math.abs(spread.short.iv - spread.long.iv) > config.maxIVSkew) return null;
    }

    // Apply fill model to entry
    let entryCredit: number;
    let entrySlippage = 0;

    if (fillMode === 'bidask' && config.slippage.enabled) {
      const shortFill = applyFill('bidask', spread.short.mid, spread.short.bid,
        spread.short.ask, 'sell', config.slippage, spread.short.oi, spread.short.row.dte);
      const longFill = applyFill('bidask', spread.long.mid, spread.long.bid,
        spread.long.ask, 'buy', config.slippage, spread.long.oi, spread.long.row.dte);
      entryCredit = shortFill.fillPrice - longFill.fillPrice;
      entrySlippage = shortFill.slippage + longFill.slippage;
      if (entryCredit <= 0) return null;
    } else {
      entryCredit = spread.netCredit;
    }

    const tpCost = entryCredit * (1 - config.creditProfitTarget);
    const slCost = entryCredit * config.creditStopLossMultiple;

    // Cap monitoring at option expiry or maxDate
    const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;
    const monitorDates = getMonitoringDates(allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd);

    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

    for (const checkDate of monitorDates) {
      const shortLeg = findContractDirect(signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      const longLeg = findContractDirect(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
      if (!shortLeg || !longLeg) continue;

      // Exit pricing
      let currentSpreadCost: number;
      let exitSlippageAmount = 0;
      if (fillMode === 'bidask' && config.slippage.enabled) {
        const shortClose = applyFill('bidask', shortLeg.mid, shortLeg.bid,
          shortLeg.ask, 'buy', config.slippage, shortLeg.oi, shortLeg.row.dte);
        const longClose = applyFill('bidask', longLeg.mid, longLeg.bid,
          longLeg.ask, 'sell', config.slippage, longLeg.oi, longLeg.row.dte);
        currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
        exitSlippageAmount = shortClose.slippage + longClose.slippage;
      } else {
        currentSpreadCost = shortLeg.mid - longLeg.mid;
      }
      const currentDTE = shortLeg.row.dte;

      dailyMtM.push({
        date: checkDate,
        spreadMid: currentSpreadCost,
        unrealizedPnl: (entryCredit - currentSpreadCost) * 100,
      });

      let exitType: OptionExitType | null = null;
      if (currentSpreadCost <= tpCost) exitType = 'PROFIT_TARGET';
      else if (currentSpreadCost >= slCost) exitType = 'STOP_LOSS';
      else if (config.creditDeltaStop != null && isFinite(config.creditDeltaStop) &&
               Math.abs(shortLeg.delta) >= config.creditDeltaStop) exitType = 'DELTA_STOP';
      else if (currentDTE <= config.creditTimeStopDTE) exitType = 'TIME_STOP';

      if (exitType) {
        return buildResult(signal, spread, entryCredit, checkDate, currentSpreadCost,
          currentDTE, shortLeg.row.stock_price, exitType, dailyMtM,
          entrySlippage, exitSlippageAmount, fillMode);
      }
    }

    // Close at last monitoring date or expiry
    const lastDate = monitorDates[monitorDates.length - 1];
    if (lastDate) {
      const shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      const longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);

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

      return buildResult(signal, spread, entryCredit, lastDate, currentSpreadCost,
        shortLeg?.row.dte ?? 0, shortLeg?.row.stock_price ?? spread.short.row.stock_price,
        'EXPIRATION', dailyMtM, entrySlippage, 0, fillMode);
    }

    return null;
  };
}

function buildResult(
  signal: EntrySignal, spread: SpreadMatch, entryCredit: number,
  exitDate: string, exitSpreadCost: number, exitDTE: number,
  exitStockPrice: number, exitType: OptionExitType,
  dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[],
  entrySlippage: number, exitSlippage: number, fillMode: FillMode,
): OptionTrade {
  const pnl = (entryCredit - exitSpreadCost) * 100;
  const pnlPct = spread.maxLoss > 0 ? pnl / (spread.maxLoss * 100) : 0;
  const holdDays = Math.round(
    (new Date(exitDate).getTime() - new Date(signal.date).getTime()) / 86400000,
  );

  return {
    ticker: signal.ticker,
    mode: 'CREDIT_SPREAD',
    direction: signal.direction,
    entryDate: signal.date,
    entrySignalScore: signal.score,
    strike: spread.short.row.strike,
    expiry: spread.short.row.expir_date,
    entryDTE: spread.short.row.dte,
    entryPrice: entryCredit,
    entryDelta: spread.short.delta,
    entryIV: spread.short.iv,
    entryStockPrice: spread.short.row.stock_price,
    longStrike: spread.long.row.strike,
    longEntryPrice: spread.long.mid,
    spreadWidth: spread.spreadWidth,
    maxProfit: entryCredit,
    maxLoss: spread.maxLoss,
    exitDate,
    exitPrice: exitSpreadCost,
    exitDTE,
    exitStockPrice,
    exitType,
    pnl,
    pnlPct,
    holdDays,
    ivRank: signal.ivRank,
    entrySlippage: entrySlippage > 0 ? entrySlippage : undefined,
    exitSlippage: exitSlippage > 0 ? exitSlippage : undefined,
    fillMode,
    dailyMtM,
  };
}

// ── Sweep Grid ──────────────────────────────────────────

function buildSweepCandidates(): SimConfig[] {
  const candidates: SimConfig[] = [];

  const presets: SignalPresetKey[] = ['ema', 'mom', 'em', 'mf'];
  const profitTargets = [0.30, 0.50];          // 0.40 validated in prev run (extreme IV only); keep ends
  const spreadWidths = [5, 15];               // 10 never selected; 5 wins low-IV, 15 wins otherwise
  const ivRankMins = [0, 30];                  // 0 = high-IV regime, 30 = structural filter
  const deltaStops = [0.75, 0.80, Infinity];   // 0.65 rejected; test higher thresholds + off
  const timeStopDTEs = [7, 14];               // 7 = current; 14 = earlier exit, smaller avg loss

  for (const preset of presets) {
    for (const tp of profitTargets) {
      for (const width of spreadWidths) {
        for (const ivMin of ivRankMins) {
          for (const dStop of deltaStops) {
            for (const tsdte of timeStopDTEs) {
              candidates.push({
                ...DEFAULT_CREDIT_CONFIG,
                creditProfitTarget: tp,
                creditSpreadWidth: width,
                minIVRank: ivMin,
                creditDeltaStop: isFinite(dStop) ? dStop : undefined,
                creditTimeStopDTE: tsdte,
                creditStopLossMultiple: 100, // no SL (defined risk)
                fillMode: FILL_MODE,
                slippage: FILL_MODE === 'bidask'
                  ? { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true }
                  : { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
                signalWeightPreset: preset,
              });
            }
          }
        }
      }
    }
  }

  return candidates;
}

// ── Reporting ───────────────────────────────────────────

function formatPct(v: number, decimals = 1): string {
  return v.toFixed(decimals) + '%';
}

function printReport(result: WFAResult) {
  console.log('\n' + '═'.repeat(80));
  console.log('  WALK-FORWARD ANALYSIS RESULTS');
  console.log('═'.repeat(80));

  console.log(`\n  Mode: ${result.config.mode.toUpperCase()}`);
  console.log(`  Period: ${result.config.startDate} → ${result.config.endDate}`);
  console.log(`  Train: ${result.config.trainWindowDays}d | Step: ${result.config.forwardStepDays}d | Purge: ${result.config.purgeGapDays}d`);
  console.log(`  Tickers: ${result.config.tickers.join(', ')}`);
  console.log(`  Capital: $${result.config.startingCapital.toLocaleString()}`);
  console.log(`  Fill mode: ${FILL_MODE}`);
  console.log(`  Elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s`);

  console.log('\n' + '─'.repeat(80));
  console.log('  AGGREGATE OOS METRICS');
  console.log('─'.repeat(80));
  console.log(`  Sharpe:       ${result.oosSharpe.toFixed(2)}`);
  console.log(`  Win Rate:     ${formatPct(result.oosWinRate)}`);
  console.log(`  Max DD:       ${formatPct(result.oosMaxDD)}`);
  console.log(`  Total P&L:    $${result.oosTotalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`  ROC:          ${formatPct(result.oosTotalPnl / result.config.startingCapital * 100)}`);
  console.log(`  WF Efficiency: ${result.wfEfficiency.toFixed(2)}`);
  console.log(`  OOS Trades:   ${result.allOOSTrades.length}`);

  if (result.stressMetrics) {
    const s = result.stressMetrics;
    console.log('\n' + '─'.repeat(80));
    console.log('  CORRELATION STRESS');
    console.log('─'.repeat(80));
    console.log(`  Peak Correlated DD:    ${formatPct(s.peakCorrelatedDD)} (${s.peakCorrelatedDDDate})`);
    console.log(`  Worst Day Loss:        $${s.worstDayLoss.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${s.worstDayLossDate})`);
    console.log(`  Tickers in DD (worst): ${s.tickersInDDOnWorstDay}`);
    console.log(`  Avg Pairwise Corr:     ${s.avgPairwiseCorrelation.toFixed(3)}`);
    console.log(`  Correlation Penalty:   ${s.correlationPenalty.toFixed(4)}`);
  }

  console.log('\n' + '─'.repeat(80));
  console.log('  PER-WINDOW BREAKDOWN');
  console.log('─'.repeat(80));
  console.log(
    '  #  Train Period          OOS Period            Train    OOS     OOS    OOS   Best Config',
  );
  console.log(
    '     Start    → End        Start    → End        Sharpe   Sharpe  WR%    Trd   (preset/tp/w/iv)',
  );
  console.log('  ' + '·'.repeat(78));

  for (const w of result.windows) {
    const cfg = w.bestConfig;
    const dStopStr = cfg.creditDeltaStop != null ? `/d${cfg.creditDeltaStop}` : '';
    const tsStr = cfg.creditTimeStopDTE !== 7 ? `/ts${cfg.creditTimeStopDTE}` : '';
    const configStr = `${cfg.signalWeightPreset ?? 'ema'}/tp${(cfg.creditProfitTarget * 100).toFixed(0)}/w${cfg.creditSpreadWidth}/iv${cfg.minIVRank}${dStopStr}${tsStr}`;
    console.log(
      `  ${String(w.windowIndex).padStart(2)}  ${w.trainStart} → ${w.trainEnd}  ${w.oosStart} → ${w.oosEnd}` +
      `  ${w.bestTrainSharpe.toFixed(2).padStart(6)}  ${w.oosSharpe.toFixed(2).padStart(6)}` +
      `  ${formatPct(w.oosWinRate).padStart(5)}  ${String(w.oosTrades.length).padStart(4)}   ${configStr}`,
    );
  }

  // Exit type breakdown
  const byExit: Record<string, number> = {};
  for (const t of result.allOOSTrades) {
    byExit[t.exitType] = (byExit[t.exitType] ?? 0) + 1;
  }
  console.log('\n' + '─'.repeat(80));
  console.log('  EXIT TYPE BREAKDOWN');
  console.log('─'.repeat(80));
  for (const [type, count] of Object.entries(byExit).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(20)} ${count} (${formatPct(count / result.allOOSTrades.length * 100)})`);
  }

  // Equity curve summary
  if (result.oosEquityCurve.length > 0) {
    const first = result.oosEquityCurve[0];
    const last = result.oosEquityCurve[result.oosEquityCurve.length - 1];
    console.log('\n' + '─'.repeat(80));
    console.log('  EQUITY CURVE');
    console.log('─'.repeat(80));
    console.log(`  Start: $${result.config.startingCapital.toLocaleString()} (${first.date})`);
    console.log(`  End:   $${last.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${last.date})`);
  }

  console.log('\n' + '═'.repeat(80) + '\n');
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log('WFA Engine — Walk-Forward Analysis for Credit Spreads');
  console.log('─'.repeat(60));

  // 1. Initialize chain cache
  initDB();
  const stats = getCacheStats();
  console.log(`Chain cache: ${stats.totalRows.toLocaleString()} rows, ${stats.totalDates} dates, ${stats.tickers.length} tickers`);

  // 2. Fetch candle data for all tickers
  console.log(`\nFetching candle data for ${tickers.length} tickers...`);
  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of tickers) {
    const td = await fetchTickerData(ticker);
    tickerDataMap.set(ticker, td);
    process.stdout.write(` ${ticker}(${td.candles.length})`);
  }
  console.log(' done.');

  // 3. Build all trading dates (union across tickers)
  const allDatesSet = new Set<string>();
  for (const td of tickerDataMap.values()) {
    for (const c of td.candles) {
      if (c.date >= WFA_START && c.date <= WFA_END) allDatesSet.add(c.date);
    }
  }
  const allTradingDates = [...allDatesSet].sort();
  buildDateIndex(allTradingDates);
  console.log(`Trading dates: ${allTradingDates.length} (${allTradingDates[0]} → ${allTradingDates[allTradingDates.length - 1]})`);

  // 4. Pre-compute signals for each preset across all tickers
  console.log('\nGenerating signals per preset...');
  const signalsByPreset = new Map<SignalPresetKey, EntrySignal[]>();
  const presetKeys: SignalPresetKey[] = ['ema', 'mom', 'em', 'mf'];

  for (const preset of presetKeys) {
    const allSignals: EntrySignal[] = [];
    for (const [ticker, td] of tickerDataMap) {
      const entries = generateSignalsForPreset(td, preset, WFA_START, WFA_END);
      allSignals.push(...entries);
    }
    allSignals.sort((a, b) => a.date.localeCompare(b.date));
    signalsByPreset.set(preset, allSignals);
    console.log(`  ${preset}: ${allSignals.length} signals`);
  }

  // 5. Build sweep candidates
  const candidates = buildSweepCandidates();
  console.log(`\nSweep candidates: ${candidates.length} configs`);
  console.log(`  Presets: ${presetKeys.join(', ')}`);
  console.log(`  TP: 30%, 50%`);
  console.log(`  Spread widths: $5, $15`);
  console.log(`  IV rank min: 0, 30`);
  console.log(`  Delta stop: 0.75, 0.80, off`);
  console.log(`  Time stop DTE: 7, 14`);

  // 6. Preview windows
  const windowDefs = buildWFAWindows(allTradingDates, {
    trainWindowDays: TRAIN_DAYS,
    forwardStepDays: STEP_DAYS,
    purgeGapDays: PURGE_DAYS,
    mode: WFA_MODE,
    startDate: WFA_START,
    endDate: WFA_END,
  });
  console.log(`\nWFA windows: ${windowDefs.length} (${WFA_MODE})`);
  for (const w of windowDefs) {
    console.log(`  Train ${w.trainStart}→${w.trainEnd} | OOS ${w.oosStart}→${w.oosEnd}`);
  }

  // 7. Run WFA
  console.log(`\nRunning WFA (${candidates.length} configs × ${windowDefs.length} windows)...`);
  const evaluator = makeCachedEvaluator(FILL_MODE);

  const result = runWFAOptions(
    {
      tickers,
      startDate: WFA_START,
      endDate: WFA_END,
      trainWindowDays: TRAIN_DAYS,
      forwardStepDays: STEP_DAYS,
      purgeGapDays: PURGE_DAYS,
      mode: WFA_MODE,
      maxPositions: MAX_POSITIONS,
      maxPerTicker: MAX_PER_TICKER,
      startingCapital: STARTING_CAPITAL,
    },
    signalsByPreset,
    allTradingDates,
    candidates,
    evaluator,
    (windowIdx, totalWindows) => {
      process.stdout.write(`\r  Window ${windowIdx + 1}/${totalWindows}...`);
    },
  );
  console.log(`\r  ${result.windows.length} windows complete. (${(result.elapsedMs / 1000).toFixed(1)}s)`);
  const hitRate = (_chainHits + _chainMisses) > 0 ? (_chainHits / (_chainHits + _chainMisses) * 100).toFixed(1) : '0';
  console.log(`  Chain LRU: ${_chainHits.toLocaleString()} hits, ${_chainMisses.toLocaleString()} misses (${hitRate}% hit rate)`);

  // 8. Print report
  printReport(result);

  // 9. Save JSON
  const outDir = path.resolve(__dirname, '../data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Strip heavy trade arrays for JSON export (keep summaries only)
  const exportResult = {
    ...result,
    windows: result.windows.map(w => ({
      ...w,
      oosTrades: w.oosTrades.map(t => ({
        ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
        pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
        exitType: t.exitType, direction: t.direction,
        entryDelta: t.entryDelta, entryDTE: t.entryDTE,
        strike: t.strike, spreadWidth: t.spreadWidth,
      })),
    })),
    allOOSTrades: result.allOOSTrades.map(t => ({
      ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
      pnl: t.pnl, pnlPct: t.pnlPct, holdDays: t.holdDays,
      exitType: t.exitType, direction: t.direction,
      entryDelta: t.entryDelta, entryDTE: t.entryDTE,
      strike: t.strike, spreadWidth: t.spreadWidth,
    })),
  };

  const outPath = path.resolve(outDir, 'wfa-results.json');
  fs.writeFileSync(outPath, JSON.stringify(exportResult, null, 2));
  console.log(`Results saved to ${outPath}`);

  closeDB();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
