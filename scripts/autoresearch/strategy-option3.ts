/**
 * strategy-option3.ts — Iteration 22: Long Put DEBIT SPREAD via customEvaluator
 *
 * === What We Know (21 Iterations) ===
 *
 * Best results:
 *   Iter 20 (maxpos3-sl60-d60):  SPY IR +0.287, MaxDD 98.2%, Trades 198  ← ONLY gate fail: MaxDD
 *   Iter 21 (spygate-sl80-d60):  SPY IR -0.200, MaxDD 50.0%, Trades 96   ← SPY gate kills alpha
 *
 * Iter 21 proved: the SPY bull filter reduces MaxDD by cutting trade count (198→96)
 * but kills the +0.287 SPY IR signal — the same trades generate BOTH the positive
 * alpha AND the high MaxDD. We cannot separate them with entry filtering.
 *
 * === The Structural Fix: Debit Spread ===
 *
 * Outright long put (LEAP mode): max loss = full premium paid (~$4-8/share at delta 0.25)
 * Long put DEBIT SPREAD:
 *   - Buy put at delta ~0.25-0.30 (pay ask)
 *   - Sell put at same expiry, N pts lower strike (receive bid)
 *   - Net debit = longPut.ask - shortPut.bid ≈ 40-60% of outright put cost
 *   - Max loss PER TRADE = net debit (hard cap, not stop-loss-dependent)
 *
 * If net debit ≈ 50% of outright premium:
 *   Iter 20 outright MaxDD 98% × 0.50 ≈ 49% → just passes the ≤45% gate
 *   (assuming 1 contract per trade, which the simulator uses)
 *
 * SPY BULL FILTER IS REMOVED — the debit spread provides structural loss containment,
 * not regime-based entry filtering. Crash filter (SPY < EMA200×0.85) is retained
 * because crashes give misleading VRP signals (HV20 lags actual realized vol).
 *
 * === Implementation ===
 *
 * customEvaluator because mode:'DEBIT_SPREAD' is not wired in the standard engine.
 * Uses chainLookup (synchronous SQLite cache) for all contract lookups.
 *
 * Entry fill:  long put at ask,  short put at bid   (pay spread, conservative)
 * Exit fill:   long put at bid,  short put at ask   (receive spread, conservative)
 * At expiry:   intrinsic value = max(0, longStrike-S) - max(0, shortStrike-S)
 *
 * === configVariants Sweep ===
 *
 * All variants: VRP ≤ 0 + crash filter, maxpos=3, DTE/width vary via SimConfig
 *
 *   v1: DTE [50,70], 5pt  — baseline
 *   v2: DTE [60,80], 5pt  — longer DTE (consistent SPY IR winner across Iters 12-21)
 *   v3: DTE [50,70], 10pt — wider spread (higher max profit per trade)
 *   v4: DTE [60,80], 10pt — longer DTE + wider spread
 *
 * NO DUPLICATE VARIANTS.
 *
 * === VRP Convention ===
 *
 * hv30d is always NULL in ORATS data — use hv20d (CLAUDE.md quirk).
 * VRP = IV30² - HV20²  (via regimeByDate.get(date).vrp)
 * VRP ≤ 0 → IV cheap vs realized → positive EV for buying premium
 */

import type {
  StrategyDefinition,
  TickerDataBundle,
  MarketContext,
  EntrySignal,
  SimConfig,
  OptionTrade,
} from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

export const strategy: StrategyDefinition = {
  name: 'option3-debit-spread-v1',

  // 7 sector-diversified tickers — non-QQQ, confirmed corr -0.03 to -0.22 with DTE5
  tickers: ['GLD', 'IWM', 'BA', 'GS', 'COST', 'JPM', 'UNH'],

  portfolio: {
    maxPositions: 3,       // Restored to Iter 20's best (maxpos2 caused Sharpe regression)
    maxPerTicker: 1,
    startingCapital: 10000,
  },

  wfa: {
    trainWindowDays: 252,
    forwardStepDays: 126,
    purgeGapDays: 90,      // 80 DTE max + 10-day buffer
    mode: 'rolling' as const,
    holdoutCount: 2,
  },

  buildConfig(_ticker: string, _direction: 'CALL' | 'PUT'): SimConfig {
    return {
      ...DEFAULT_LEAP_CONFIG,
      mode: 'LEAP' as const,          // base mode; customEvaluator overrides execution
      leapDeltaRange: [0.25, 0.30] as [number, number],  // target long leg delta
      leapDTERange: [50, 70] as [number, number],         // default; overridden per variant
      leapProfitTarget: 0.60,         // TP when spread value = entryDebit + 60% of maxProfit
      leapStopLoss: 0.80,             // SL when spread value falls to 20% of entry debit
      leapTimeStopDTE: 5,             // time stop at 5 DTE remaining
      creditSpreadWidth: 5,           // default spread width; overridden per variant
      monitoringIntervalDays: 1,      // MUST be 1
    };
  },

  generateSignals(data: TickerDataBundle, market: MarketContext): EntrySignal[] {
    const signals: EntrySignal[] = [];
    const n = data.candles.length;

    for (let i = 200; i < n; i++) {
      const c = data.candles[i];

      // Regime data required for VRP gate
      const r = data.regimeByDate.get(c.date);
      if (!r || r.vrp == null) continue;

      // Minimum IV activity filter — skip extremely low-IV regimes
      // IV rank < 10 = bottom 10th percentile → deep in a calm bull runup → bad for long vol
      const ivRank = data.ivRanks[i];
      if (ivRank == null || ivRank < 10) continue;

      // === VRP ≤ 0 gate ===
      // IV cheap vs realized → positive EV for buying premium
      // Confirmed working at generateSignals level (Iters 12-20)
      // VRP ≤ 0 (not -0.05): marginal band contains valuable signal (Iter 14 confirmed)
      if (r.vrp > 0) continue;

      const spyData = market.spyByDate.get(c.date);

      // === Crash filter (retained from Iter 21) ===
      // During crashes, HV20 lags actual volatility spike → VRP appears negative but IV
      // is actually elevated. Skip these misleading "cheap IV" entries.
      if (spyData && spyData.close < spyData.ema200 * 0.85) continue;

      // SPY BULL FILTER REMOVED vs Iter 21.
      // The bull filter reduced MaxDD only by cutting trade count (198→96),
      // killing the +0.287 SPY IR signal in the process. The debit spread structure
      // provides per-trade loss containment without filtering good entries.

      signals.push({
        ticker: data.ticker,
        date: c.date,
        direction: 'PUT',
        score: -r.vrp,   // more negative VRP = cheaper IV = higher priority for slot allocation
        ivRank,
        vrp: r.vrp,
        vrpPct: r.vrpPct,
        contango: r.contango,
        contangoPct: r.contangoPct,
      });
    }

    return signals;
  },

  /**
   * Custom evaluator: long put DEBIT SPREAD
   *
   * Replaces the standard LEAP evaluator with a two-leg debit spread:
   *   - Long leg: buy put at delta ~0.25-0.30 (pay ask)
   *   - Short leg: sell put at same expiry, creditSpreadWidth pts below (receive bid)
   *   - Max loss = net debit (hard structural cap, unlike outright puts)
   *
   * Uses chainLookup (synchronous SQLite cache) — no async required.
   */
  customEvaluator(
    signal: EntrySignal,
    config: SimConfig,
    allTradingDates: string[],
    maxDate: string,
    chainLookup,
  ): OptionTrade | null {
    if (signal.direction !== 'PUT') return null;

    const chain = chainLookup.getCachedChain(signal.ticker, signal.date);
    if (!chain.length) return null;

    const dteRange = config.leapDTERange;
    const spreadWidth = config.creditSpreadWidth ?? 5;
    const targetDelta = (config.leapDeltaRange[0] + config.leapDeltaRange[1]) / 2;

    // findSpreadStrikes: "short" = higher-delta leg (we BUY in a debit spread)
    //                   "long"  = lower-delta wing (we SELL in a debit spread)
    const spread = chainLookup.findSpreadStrikes(chain, targetDelta, spreadWidth, 'Put', dteRange);
    if (!spread) return null;

    const buyLeg = spread.short;  // the put we BUY (higher delta, higher strike)
    const sellLeg = spread.long;  // the put we SELL (lower delta, lower strike)

    // Entry: pay ask for buy leg, receive bid for sell leg (conservative bid/ask fill)
    const entryDebit = buyLeg.ask - sellLeg.bid;
    if (entryDebit < 0.05) return null;  // near-zero or negative debit = bad fill

    const actualWidth = Math.abs(buyLeg.row.strike - sellLeg.row.strike);
    if (actualWidth < 1) return null;  // degenerate spread

    const maxProfitPerShare = actualWidth - entryDebit;
    if (maxProfitPerShare <= 0) return null;  // debit exceeds spread width — no upside

    // TP: exit when spread value = entryDebit + config.leapProfitTarget × maxProfit
    const tpValue = entryDebit + maxProfitPerShare * config.leapProfitTarget;
    // SL: exit when spread value falls to (1 - stopLoss) × entryDebit
    //     e.g. stopLoss=0.80 → exit when value = 20% of entry debit
    const slValue = entryDebit * (1 - config.leapStopLoss);
    const timeStopDTE = config.leapTimeStopDTE ?? 5;

    const expiry = buyLeg.row.expir_date;
    const longStrike = buyLeg.row.strike;
    const shortStrike = sellLeg.row.strike;
    const entryDTE = buyLeg.row.dte;
    const entryStockPrice = buyLeg.row.stock_price;

    // Monitoring: day after signal date up to min(expiry, maxDate)
    const monitorEnd = expiry < maxDate ? expiry : maxDate;
    const monitorDates = allTradingDates.filter(d => d > signal.date && d <= monitorEnd);

    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

    // Exit tracking — initialize to expiration at last monitoring date
    let exitDate = '';
    let exitValue = 0;
    let exitDTE = entryDTE;
    let exitStockPrice = entryStockPrice;
    let exitType: OptionTrade['exitType'] = 'EXPIRATION';

    for (const checkDate of monitorDates) {
      const longCurrent = chainLookup.findContractDirect(signal.ticker, checkDate, longStrike, expiry, 'Put');
      const shortCurrent = chainLookup.findContractDirect(signal.ticker, checkDate, shortStrike, expiry, 'Put');

      if (!longCurrent || !shortCurrent) continue;

      const currentDTE = longCurrent.row.dte;
      const currentStock = longCurrent.row.stock_price;

      // Exit fill: sell long at bid, buy short back at ask (conservative)
      const exitSpreadValue = Math.max(0, longCurrent.bid - shortCurrent.ask);
      // Mid for MtM display (not used for P&L computation)
      const midSpreadValue = longCurrent.mid - shortCurrent.mid;

      dailyMtM.push({
        date: checkDate,
        spreadMid: midSpreadValue,
        unrealizedPnl: (exitSpreadValue - entryDebit) * 100,
      });

      // Update rolling "last seen" exit data for EXPIRATION case
      exitDate = checkDate;
      exitValue = exitSpreadValue;
      exitDTE = currentDTE;
      exitStockPrice = currentStock;

      // Check exit conditions (evaluated after updating exitDate so EXPIRATION case is correct)
      if (exitSpreadValue >= tpValue) {
        exitType = 'PROFIT_TARGET';
        break;
      } else if (exitSpreadValue <= slValue) {
        exitType = 'STOP_LOSS';
        break;
      } else if (currentDTE <= timeStopDTE) {
        exitType = 'TIME_STOP';
        break;
      }
    }

    if (!exitDate) return null;  // no valid monitoring data — chain unavailable for all dates

    // Compute hold days from allTradingDates index
    const entryIdx = allTradingDates.indexOf(signal.date);
    const exitIdx = allTradingDates.indexOf(exitDate);
    const holdDays = Math.max(1, exitIdx - entryIdx);

    const finalPnl = (exitValue - entryDebit) * 100;          // $ per contract
    const pnlPct = finalPnl / (entryDebit * 100);             // % return on capital at risk

    return {
      ticker: signal.ticker,
      mode: 'DEBIT_SPREAD' as const,
      direction: signal.direction,
      entryDate: signal.date,
      entrySignalScore: signal.score,
      // Long leg (the put we bought)
      strike: longStrike,
      expiry,
      entryDTE,
      entryPrice: entryDebit,          // net debit paid (per share)
      entryDelta: buyLeg.delta,
      entryIV: buyLeg.iv,
      entryStockPrice,
      // Short leg (the put we sold)
      longStrike: shortStrike,          // OptionTrade.longStrike stores the other leg strike
      longEntryPrice: sellLeg.bid,      // credit received for the short leg
      requestedSpreadWidth: spreadWidth,
      spreadWidth: actualWidth,
      maxProfit: maxProfitPerShare * 100,  // $ per contract
      maxLoss: entryDebit * 100,           // $ per contract (= net debit)
      // Exit
      exitDate,
      exitPrice: exitValue,
      exitDTE,
      exitStockPrice,
      exitType,
      // P&L
      pnl: finalPnl,
      grossPnl: finalPnl,
      pnlPct,
      holdDays,
      // Metadata
      ivRank: signal.ivRank,
      fillMode: config.fillMode,
      dailyMtM,
      positionSize: 1,
    };
  },

  configVariants: [
    {
      // v1: DTE [50,70], 5pt spread — baseline
      // Mirrors prior iterations' baseline DTE range; narrowest spread = lowest per-trade max loss
      name: 'option3-debit-5pt-d50',
      overrides: {
        leapDTERange: [50, 70] as [number, number],
        creditSpreadWidth: 5,
      },
    },
    {
      // v2: DTE [60,80], 5pt spread — longer DTE (consistent SPY IR winner across Iters 12-21)
      // Every prior long-vol iteration: longer DTE → better SPY IR
      // Same spread width → same per-trade max loss structure as v1
      name: 'option3-debit-5pt-d60',
      overrides: {
        leapDTERange: [60, 80] as [number, number],
        creditSpreadWidth: 5,
      },
    },
    {
      // v3: DTE [50,70], 10pt spread — wider spread
      // 10pt width: higher max profit per trade (up to $10-debit vs $5-debit for 5pt)
      // Higher max profit → better risk/reward ratio; more room for the put to gain value
      // Net debit is similar to 5pt (short leg further OTM) → similar loss cap
      name: 'option3-debit-10pt-d50',
      overrides: {
        leapDTERange: [50, 70] as [number, number],
        creditSpreadWidth: 10,
      },
    },
    {
      // v4: DTE [60,80], 10pt spread — longer DTE + wider spread
      // Combines the two structural advantages tested separately in v2 and v3
      // Highest potential Sharpe if long DTE × wide spread synergy exists
      name: 'option3-debit-10pt-d60',
      overrides: {
        leapDTERange: [60, 80] as [number, number],
        creditSpreadWidth: 10,
      },
    },
  ],
};
